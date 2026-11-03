// The one place the server talks to OpenAI. The key stays on the server: it is never returned to the browser, never logged,
// and OpenAI's own error text is never passed on (it can echo part of the key) — only plain-language messages are.
import { z } from 'zod';
import type { Db } from './db.ts';
import { newId, nowIso } from './db.ts';
import { HttpError } from './errors.ts';

export interface AiConfig { apiKey: string; model: string; baseUrl: string; timeoutMs: number; dailyLimit: number; disabled?: boolean }
export const aiConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AiConfig => ({
  apiKey: (env.OPENAI_API_KEY ?? '').trim(), model: (env.OPENAI_MODEL ?? '').trim() || 'gpt-4o-mini',
  baseUrl: (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').trim().replace(/\/+$/, ''),
  timeoutMs: Number(env.AI_TIMEOUT_MS) || 45_000, dailyLimit: Number(env.AI_DAILY_LIMIT) || 50, disabled: String(env.AI_ENABLED ?? '').toLowerCase() === 'false',
});

const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOT_SET_UP = 'AI is not set up. Add OPENAI_API_KEY to apps\\api\\.env and restart DOOD.';

function upstreamError(status: number, detail = ''): HttpError {
  if (status === 401 || status === 403) return new HttpError(502, 'AI_KEY_REJECTED', 'OpenAI did not accept the AI key. Check OPENAI_API_KEY in apps\\api\\.env (and that the account is active).');
  if (status === 404) return new HttpError(502, 'AI_MODEL_NOT_FOUND', 'OpenAI could not find the model name. Check OPENAI_MODEL in apps\\api\\.env.');
  if (status === 429) return new HttpError(429, 'AI_BUSY', 'OpenAI is busy, or the account has no credit left. Please try again in a little while.');
  if (status >= 500) return new HttpError(502, 'AI_UPSTREAM', 'OpenAI is having trouble right now. Please try again shortly.');
  return new HttpError(502, 'AI_REQUEST_FAILED', `OpenAI could not process this request.${detail ? ` (${detail})` : ''} Please try again.`);
}

export interface ChatOptions<T> { userId: string; kind: 'summary' | 'email' | 'briefing' | 'note' | 'test' | 'minutes' | 'review' | 'announce' | 'quickadd' | 'letter' | 'followup' | 'reply' | 'ask' | 'speech' | 'journal' | 'vault' | 'weekly'; system: string; user: string; attachment?: { mimeType: string; dataBase64: string; fileName?: string }; attachments?: { mimeType: string; dataBase64: string; fileName?: string }[]; schema: z.ZodType<T>; maxTokens?: number; temperature?: number }
type Logger = { info: (o: object, m?: string) => void };

export class AiService {
  cfg: AiConfig; db: Db; log?: Logger;
  constructor(db: Db, cfg: AiConfig, log?: Logger) { this.db = db; this.cfg = cfg; this.log = log; }
  get enabled() { return !!this.cfg.apiKey && !this.cfg.disabled; }
  get model() { return this.cfg.model; }
  assertEnabled() { if (!this.enabled) throw new HttpError(503, 'AI_NOT_SET_UP', NOT_SET_UP); }

  async usageFor(userId: string, now = new Date()) {
    const day = localDay(now), month = day.slice(0, 7);
    const today = (await this.db.get<any>("SELECT COUNT(*) n FROM ai_usage WHERE user_id = ? AND day = ? AND kind <> 'test'", [userId, day]))!.n as number;
    const m = (await this.db.get<any>('SELECT COUNT(*) calls, COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) failed FROM ai_usage WHERE month = ?', [month]))!;
    const byKind = await this.db.all<any>('SELECT kind, COUNT(*) calls FROM ai_usage WHERE month = ? GROUP BY kind', [month]);
    return { day, month, usedToday: today, dailyLimit: this.cfg.dailyLimit, monthly: { calls: m.calls, failed: m.failed, promptTokens: m.p, completionTokens: m.c, totalTokens: m.p + m.c, byKind } };
  }

  private async post(messages: { role: string; content: any }[], o: { maxTokens: number; temperature: number }) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({ model: this.cfg.model, messages, response_format: { type: 'json_object' }, temperature: o.temperature, max_tokens: o.maxTokens }) });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new HttpError(504, 'AI_TIMEOUT', 'The AI took too long to answer. Please try again.');
      throw new HttpError(502, 'AI_NETWORK', 'Could not reach OpenAI. Check the internet connection and try again.');
    } finally { clearTimeout(timer); }
    if (!res.ok) {                                              // the body is only read for a plain 400, and only OpenAI's short reason (key-like text removed) is shown
      let detail = ''; if (res.status === 400) { try { detail = String((await res.json())?.error?.message ?? '').replace(/sk-[A-Za-z0-9_-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 180); } catch { /* none */ } }
      throw upstreamError(res.status, detail);
    }
    let json: any; try { json = await res.json(); } catch { throw new HttpError(502, 'AI_BAD_REPLY', 'The AI gave an unreadable answer. Please try again.'); }
    return { content: String(json?.choices?.[0]?.message?.content ?? ''), prompt: Number(json?.usage?.prompt_tokens) || 0, completion: Number(json?.usage?.completion_tokens) || 0 };
  }

  /** JSON in, validated JSON out. One automatic retry if the reply is not valid JSON of the expected shape. */
  async chatJson<T>(o: ChatOptions<T>): Promise<{ data: T; prompt: number; completion: number }> {
    this.assertEnabled();
    if (o.kind !== 'test' && (await this.usageFor(o.userId)).usedToday >= this.cfg.dailyLimit)
      throw new HttpError(429, 'AI_DAILY_LIMIT', `You have reached today’s AI limit (${this.cfg.dailyLimit} requests). It resets tomorrow.`);
    let prompt = 0, completion = 0, ok = false;
    const atts = [...(o.attachment ? [o.attachment] : []), ...(o.attachments ?? [])];
    const userContent: any = !atts.length ? o.user : [{ type: 'text', text: o.user }, ...atts.map((att) => att.mimeType === 'application/pdf'
        ? { type: 'file', file: { filename: att.fileName || 'document.pdf', file_data: `data:application/pdf;base64,${att.dataBase64}` } }
        : { type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${att.dataBase64}` } })];
    // OpenAI refuses response_format=json_object unless the word “JSON” appears in the messages — make sure it always does.
    const system = /json/i.test(o.system + o.user) ? o.system : `${o.system}\nReply with a single JSON object.`;
    const messages: { role: string; content: any }[] = [{ role: 'system', content: system }, { role: 'user', content: userContent }];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await this.post(messages, { maxTokens: o.maxTokens ?? 1200, temperature: o.temperature ?? 0.2 }); prompt += r.prompt; completion += r.completion;
        let parsed: unknown = undefined;
        try { parsed = JSON.parse(r.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { /* retry below */ }
        const v = parsed === undefined ? null : o.schema.safeParse(parsed);
        if (v?.success) { ok = true; return { data: v.data, prompt, completion }; }
        messages.push({ role: 'assistant', content: r.content.slice(0, 3000) }, { role: 'user', content: 'That reply was not valid JSON in the required format. Reply again with ONLY the JSON object, using exactly the keys described.' });
      }
      throw new HttpError(502, 'AI_BAD_REPLY', 'The AI answered in an unexpected format twice. Please try again.');
    } finally {
      await this.db.run('INSERT INTO ai_usage (id,user_id,day,month,kind,model,prompt_tokens,completion_tokens,ok,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [newId(), o.userId, localDay(), localDay().slice(0, 7), o.kind, this.cfg.model, prompt, completion, ok ? 1 : 0, nowIso()]).catch(() => undefined);
      this.log?.info({ ai: o.kind, ok, promptTokens: prompt, completionTokens: completion }, 'ai call');       // never the key, never the prompt
    }
  }

  /** Speech to text (English / Malayalam). The audio is sent to OpenAI only when the person presses the microphone. */
  async transcribe(userId: string, audio: Buffer, mimeType: string, language?: string): Promise<string> {
    this.assertEnabled();
    if ((await this.usageFor(userId)).usedToday >= this.cfg.dailyLimit) throw new HttpError(429, 'AI_DAILY_LIMIT', `You have reached today’s AI limit (${this.cfg.dailyLimit} requests). It resets tomorrow.`);
    const ext = /mp4|m4a/.test(mimeType) ? 'mp4' : /ogg/.test(mimeType) ? 'ogg' : /wav/.test(mimeType) ? 'wav' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${ext}`);
    form.append('model', (process.env.OPENAI_STT_MODEL ?? '').trim() || 'whisper-1');
    if (language) form.append('language', language);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs); let ok = false;
    try {
      let res: Response;
      try { res = await fetch(`${this.cfg.baseUrl}/audio/transcriptions`, { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${this.cfg.apiKey}` }, body: form }); }
      catch (e: any) { throw e?.name === 'AbortError' ? new HttpError(504, 'AI_TIMEOUT', 'The voice took too long to convert. Please try again.') : new HttpError(502, 'AI_NETWORK', 'Could not reach OpenAI. Check the internet connection and try again.'); }
      if (!res.ok) throw upstreamError(res.status);
      const j: any = await res.json().catch(() => ({})); ok = true;
      return String(j?.text ?? '').trim();
    } finally {
      clearTimeout(timer);
      await this.db.run('INSERT INTO ai_usage (id,user_id,day,month,kind,model,prompt_tokens,completion_tokens,ok,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [newId(), userId, localDay(), localDay().slice(0, 7), 'speech', 'speech-to-text', 0, 0, ok ? 1 : 0, nowIso()]).catch(() => undefined);
    }
  }
}
