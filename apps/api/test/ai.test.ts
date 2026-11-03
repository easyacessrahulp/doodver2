import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setup } from './helpers.ts';

const KEY = 'sk-test-SECRET-KEY-98765';
const GOOD_SUMMARY = { statusLevel: 'at_risk', status: 'Waiting on the bank; due date is close.', done: ['Application submitted'], pending: ['Bank no-dues letter'], nextAction: { text: 'Call the branch', suggestedDate: '2031-02-01' }, risks: ['Deadline may slip'], keyPoints: ['Application filed on 3 Jan', 'Bank promised reply this week', 'Collateral release needs no-dues'] };
const GOOD_EMAIL = { subject: 'Release of collateral', body: 'Dear [confirm: recipient name],\n\nPlease release the collateral.\n\nRegards,\nTester', missing: ['recipient name'] };

const opened: { close: () => void }[] = []; after(() => opened.forEach((m) => m.close()));   // never leave a stand-in server running, even if a test fails
/** A stand-in for OpenAI: records every request and answers from a queue. */
async function mock(replies: (object | string | number | ((req: any) => any))[], opts: { delayMs?: number } = {}) {
  const requests: any[] = []; let i = 0;
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const body = JSON.parse(raw || '{}'); requests.push({ auth: req.headers.authorization, url: req.url, body });
      const go = () => {
        let r: any = replies[Math.min(i++, replies.length - 1)]; if (typeof r === 'function') r = r(body);
        if (typeof r === 'number') { res.writeHead(r, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }], usage: { prompt_tokens: 120, completion_tokens: 60 } }));
      };
      opts.delayMs ? setTimeout(go, opts.delayMs) : go();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port;
  const handle = { requests, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } }; opened.push(handle); return handle;
}
const cfg = (m: { baseUrl: string }, extra: object = {}) => ({ apiKey: KEY, model: 'gpt-4o-mini', baseUrl: m.baseUrl, timeoutMs: 3000, dailyLimit: 50, ...extra });

test('AI status: off without a key, on with one — and the key is never returned', async () => {
  const off = await setup(); const s1 = await off.call('admin', 'GET', '/ai/status');
  assert.equal(s1.body.enabled, false); assert.equal(s1.body.message, 'AI not set up'); await off.app.close();
  const m = await mock([GOOD_SUMMARY]); const on = await setup({ ai: cfg(m) }); const s2 = await on.call('admin', 'GET', '/ai/status');
  assert.equal(s2.body.enabled, true); assert.equal(s2.body.model, 'gpt-4o-mini'); assert.equal(s2.body.dailyLimit, 50); assert.ok(!JSON.stringify(s2.body).includes(KEY));
  assert.equal((await on.call('outsider', 'GET', '/ai/status')).status, 200);
  assert.equal((await on.app.inject({ method: 'GET', url: '/api/ai/status' })).statusCode, 401, 'the short address needs a sign-in too');
  const viaAlias = await on.raw('admin', 'GET', '/auth/me'); assert.equal(viaAlias.statusCode, 200);
  await on.app.close(); m.close();
});

test('summary: cached, no AI call on a plain view, marked out of date after changes, refreshable; key only in the server-to-OpenAI header', async () => {
  const m = await mock([GOOD_SUMMARY]); const { app, call, A } = await setup({ ai: cfg(m) });
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Release collateral', dueDate: '2031-02-05' })).body;
  await call('USER', 'POST', '/comments', { entityType: 'TASK', entityId: t.id, body: 'Bank manager said reply this week' });
  const q = `/ai/summary?entityType=TASK&entityId=${t.id}`;
  assert.equal((await call('USER', 'GET', q)).body.summary, null); assert.equal(m.requests.length, 0, 'viewing never calls the AI');
  const r = await call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id, today: '2031-01-20' });
  assert.equal(r.status, 200); assert.equal(r.body.summary.statusLevel, 'at_risk'); assert.equal(r.body.summary.keyPoints.length, 3); assert.equal(r.body.summary.nextAction.suggestedDate, '2031-02-01');
  assert.equal(m.requests.length, 1); assert.equal(m.requests[0].auth, `Bearer ${KEY}`); assert.equal(m.requests[0].body.model, 'gpt-4o-mini'); assert.deepEqual(m.requests[0].body.response_format, { type: 'json_object' });
  const sent = JSON.stringify(m.requests[0].body); assert.match(sent, /Release collateral/); assert.match(sent, /Bank manager said reply this week/); assert.match(sent, /TODAY: 2031-01-20/);
  assert.ok(!JSON.stringify(r.body).includes(KEY), 'key never reaches the browser');
  let g = (await call('VIEWER', 'GET', q)).body; assert.equal(g.summary.stale, false); assert.equal(m.requests.length, 1, 'cached read, no new call');
  await call('USER', 'POST', '/comments', { entityType: 'TASK', entityId: t.id, body: 'Letter received' });
  g = (await call('USER', 'GET', q)).body; assert.equal(g.summary.stale, true, 'a new note makes it out of date'); assert.equal(m.requests.length, 1);
  await call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id }); assert.equal(m.requests.length, 2);
  assert.match(JSON.stringify(m.requests[1].body), /Letter received/); assert.equal((await call('USER', 'GET', q)).body.summary.stale, false);
  assert.equal((await call('VIEWER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id })).status, 403, 'viewers cannot spend AI calls');
  assert.equal((await call('outsider', 'GET', q)).status, 404);
  const u = (await call('admin', 'GET', '/ai/status')).body; assert.equal(u.monthly.calls, 2); assert.equal(u.monthly.totalTokens, 360); assert.equal(u.usedToday, 0, 'usage is per person');
  await app.close(); m.close();
});

test('exclude from AI: enforced on the server for tasks, tasks inside excluded projects, and project summaries', async () => {
  const m = await mock([GOOD_SUMMARY, GOOD_EMAIL]); const { app, call, A } = await setup({ ai: cfg(m) });
  const proj = (await call('MANAGER', 'POST', '/projects', { companyId: A.id, name: 'Banking' })).body;
  const open = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Visible task', projectId: proj.id })).body;
  const secret = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'TOP-SECRET-SETTLEMENT', projectId: proj.id, aiExcluded: true })).body;
  assert.equal(secret.aiExcluded, true);
  const sr = await call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: secret.id }); assert.equal(sr.status, 403); assert.equal(sr.body.error.code, 'AI_EXCLUDED'); assert.equal(m.requests.length, 0);
  assert.equal((await call('USER', 'GET', `/ai/summary?entityType=TASK&entityId=${secret.id}`)).body.excluded, true);
  await call('MANAGER', 'POST', '/ai/summary/refresh', { entityType: 'PROJECT', entityId: proj.id });
  const sent = JSON.stringify(m.requests[0].body); assert.match(sent, /Visible task/); assert.ok(!sent.includes('TOP-SECRET-SETTLEMENT'), 'excluded task never leaves the server');
  // email linked to an excluded task is refused (AI mode); key points are ignored
  const em = await call('USER', 'POST', '/ai/email/generate', { matter: 'follow up', entityType: 'TASK', entityId: secret.id, keyPoints: ['secret fact'] }); assert.equal(em.status, 403); assert.equal(m.requests.length, 1);
  // whole project excluded
  const cur = (await call('MANAGER', 'GET', `/projects/${proj.id}`)).body; const upd = await call('MANAGER', 'PATCH', `/projects/${proj.id}`, { expectedUpdatedAt: cur.updatedAt, aiExcluded: true }); assert.equal(upd.body.aiExcluded, true);
  assert.equal((await call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: open.id })).status, 403, 'tasks inherit the project switch');
  assert.equal((await call('MANAGER', 'POST', '/ai/summary/refresh', { entityType: 'PROJECT', entityId: proj.id })).status, 403);
  assert.equal((await call('USER', 'GET', `/tasks/${open.id}`)).body.projectAiExcluded, true);
  assert.equal(m.requests.length, 1, 'no further calls reached OpenAI');
  await app.close(); m.close();
});

test('AI service: one retry on bad JSON; two bad replies give a friendly error; timeouts and upstream errors never leak the key', async () => {
  let m = await mock(['this is not json', GOOD_SUMMARY]); let ctx = await setup({ ai: cfg(m) });
  let t = (await ctx.call('USER', 'POST', '/tasks', { companyId: ctx.A.id, title: 'T' })).body;
  assert.equal((await ctx.call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id })).status, 200); assert.equal(m.requests.length, 2, 'retried once');
  assert.match(JSON.stringify(m.requests[1].body.messages), /not valid JSON/); await ctx.app.close(); m.close();

  m = await mock(['nope', { statusLevel: 'unknown' }]); ctx = await setup({ ai: cfg(m) }); t = (await ctx.call('USER', 'POST', '/tasks', { companyId: ctx.A.id, title: 'T' })).body;
  let r = await ctx.call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id }); assert.equal(r.status, 502); assert.equal(r.body.error.code, 'AI_BAD_REPLY'); assert.equal(m.requests.length, 2);
  const u = (await ctx.call('admin', 'GET', '/ai/status')).body; assert.equal(u.monthly.failed, 1, 'the failed attempt is still logged'); await ctx.app.close(); m.close();

  for (const [status, code] of [[401, 'AI_KEY_REJECTED'], [429, 'AI_BUSY'], [500, 'AI_UPSTREAM'], [404, 'AI_MODEL_NOT_FOUND']] as const) {
    m = await mock([status]); ctx = await setup({ ai: cfg(m) }); t = (await ctx.call('USER', 'POST', '/tasks', { companyId: ctx.A.id, title: 'T' })).body;
    r = await ctx.call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id }); assert.equal(r.body.error.code, code, String(status));
    assert.ok(!JSON.stringify(r.body).includes(KEY) && !JSON.stringify(r.body).includes('sk-'), 'upstream text (which echoes the key) is never forwarded'); await ctx.app.close(); m.close();
  }
  m = await mock([GOOD_SUMMARY], { delayMs: 700 }); ctx = await setup({ ai: cfg(m, { timeoutMs: 150 }) }); t = (await ctx.call('USER', 'POST', '/tasks', { companyId: ctx.A.id, title: 'T' })).body;
  r = await ctx.call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id }); assert.equal(r.body.error.code, 'AI_TIMEOUT'); await ctx.app.close(); m.close();
  ctx = await setup({ ai: cfg({ baseUrl: 'http://127.0.0.1:1/v1' }) }); t = (await ctx.call('USER', 'POST', '/tasks', { companyId: ctx.A.id, title: 'T' })).body;
  r = await ctx.call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id }); assert.equal(r.body.error.code, 'AI_NETWORK'); await ctx.app.close();
});

test('daily per-user limit; connection test is admin-only and shows no key', async () => {
  const m = await mock([(b: any) => (b.messages[1].content === 'ping' ? { ok: true } : GOOD_SUMMARY)]); const { app, call, A } = await setup({ ai: cfg(m, { dailyLimit: 2 }) });
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'T' })).body; const go = () => call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id });
  assert.equal((await go()).status, 200); assert.equal((await go()).status, 200); const third = await go();
  assert.equal(third.status, 429); assert.equal(third.body.error.code, 'AI_DAILY_LIMIT'); assert.match(third.body.error.message, /limit \(2/); assert.equal(m.requests.length, 2);
  assert.equal((await call('MANAGER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id })).status, 200, 'the limit is per person');
  const s = (await call('USER', 'GET', '/ai/status')).body; assert.deepEqual([s.usedToday, s.dailyLimit], [2, 2]);
  assert.equal((await call('USER', 'POST', '/ai/test')).status, 403);
  const ok = await call('admin', 'POST', '/ai/test'); assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.ok(!JSON.stringify(ok.body).includes(KEY));
  await app.close(); m.close();
});

test('email drafting: facts + chips go in, placeholders are reported, refine, plain-template fallback, saved drafts', async () => {
  const m = await mock([GOOD_EMAIL, { subject: 'Release of collateral', body: 'Dear [confirm: recipient name],\nPlease release it.\nRegards,\nTester', missing: [] }]);
  const { app, call, A } = await setup({ ai: cfg(m) });
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Release collateral' })).body;
  const g = await call('USER', 'POST', '/ai/email/generate', { matter: 'Ask the bank to release the collateral', recipient: 'Mr Nair', company: 'SMS Biosystems', tone: 'firm', length: 'short', extra: 'mention urgency', entityType: 'TASK', entityId: t.id, keyPoints: ['Application filed on 3 Jan', 'Bank promised reply this week'] });
  assert.equal(g.status, 200); assert.equal(g.body.aiUsed, true); assert.deepEqual(g.body.placeholders, ['[confirm: recipient name]']);
  const req = m.requests[0].body; const sys = req.messages[0].content, usr = req.messages[1].content;
  assert.match(sys, /Do NOT invent/); assert.match(sys, /\[confirm: what is needed\]/); assert.match(sys, /firm and direct/); assert.match(sys, /at most about 80 words/);
  for (const x of ['Mr Nair', 'SMS Biosystems', 'Ask the bank to release', 'mention urgency', 'Application filed on 3 Jan', 'Bank promised reply this week', 'Release collateral']) assert.ok(usr.includes(x), x);
  const rf = await call('USER', 'POST', '/ai/email/refine', { action: 'softer', subject: g.body.subject, body: g.body.body, tone: 'polite', length: 'short', recipient: 'Mr Nair', company: 'SMS Biosystems' });
  assert.equal(rf.status, 200); assert.match(m.requests[1].body.messages[0].content, /softer, warmer/); assert.match(m.requests[1].body.messages[1].content, /CURRENT BODY/);
  // plain template: forced, and automatically when AI is off
  const tp = await call('USER', 'POST', '/ai/email/generate', { matter: 'Request statement', recipient: '', mode: 'template', entityType: 'TASK', entityId: t.id }); assert.equal(tp.body.aiUsed, false); assert.ok(tp.body.placeholders.includes('[confirm: recipient name]')); assert.match(tp.body.body, /Request statement/); assert.equal(m.requests.length, 2);
  const off = await setup(); const t2 = (await off.call('USER', 'POST', '/tasks', { companyId: off.A.id, title: 'No AI' })).body;
  const fb = await off.call('USER', 'POST', '/ai/email/generate', { matter: 'Need the invoice', recipient: 'Accounts', tone: 'friendly', entityType: 'TASK', entityId: t2.id }); assert.equal(fb.status, 200); assert.equal(fb.body.aiUsed, false); assert.match(fb.body.notice, /AI is not set up/); assert.match(fb.body.body, /^Hi Accounts,/);
  assert.equal((await off.call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t2.id })).body.error.code, 'AI_NOT_SET_UP'); await off.app.close();
  assert.equal((await call('USER', 'POST', '/ai/email/generate', { matter: '' })).status, 400); assert.equal((await call('VIEWER', 'POST', '/ai/email/generate', { matter: 'x' })).status, 403);
  // saved drafts
  const sv = await call('USER', 'POST', '/ai/email/drafts', { entityType: 'TASK', entityId: t.id, subject: g.body.subject, body: g.body.body, params: { tone: 'firm', recipient: 'Mr Nair' } });
  assert.equal(sv.status, 201); assert.deepEqual(sv.body.placeholders, ['[confirm: recipient name]']); assert.equal(sv.body.params.tone, 'firm'); assert.equal(sv.body.linkedTitle, 'Release collateral');
  const up = await call('USER', 'POST', '/ai/email/drafts', { id: sv.body.id, entityType: 'TASK', entityId: t.id, subject: 'Edited subject', body: 'Edited body', params: {} }); assert.equal(up.body.subject, 'Edited subject');
  assert.equal((await call('USER', 'GET', `/ai/email/drafts?entityType=TASK&entityId=${t.id}`)).body.items.length, 1);
  assert.equal((await call('VIEWER', 'GET', `/ai/email/drafts/${sv.body.id}`)).status, 200, 'company members can reopen a linked draft');
  assert.equal((await call('outsider', 'GET', `/ai/email/drafts/${sv.body.id}`)).status, 404); assert.equal((await call('outsider', 'GET', '/ai/email/drafts')).body.items.length, 0);
  const loose = (await call('USER', 'POST', '/ai/email/drafts', { subject: 'Loose', body: 'Not linked', params: {} })).body; assert.equal((await call('MANAGER', 'GET', `/ai/email/drafts/${loose.id}`)).status, 404, 'unlinked drafts are private');
  assert.equal((await call('USER', 'POST', '/ai/email/drafts', { subject: '', body: 'x' })).status, 400);
  assert.equal((await call('USER', 'DELETE', `/ai/email/drafts/${sv.body.id}`)).status, 200); assert.equal((await call('USER', 'GET', `/ai/email/drafts?entityType=TASK&entityId=${t.id}`)).body.items.length, 0);
  assert.equal((await (app as any).db.get('SELECT COUNT(*) n FROM ai_email_drafts')).n, 2, 'removed drafts are archived, not erased');
  await app.close(); m.close();
});

test('AI data is part of backup & restore, and the database upgrade is non-destructive', async () => {
  const m = await mock([GOOD_SUMMARY]); const { app, call, raw, A } = await setup({ ai: cfg(m) });
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Backed up', aiExcluded: false })).body; await call('USER', 'POST', '/ai/summary/refresh', { entityType: 'TASK', entityId: t.id });
  await call('USER', 'POST', '/ai/email/drafts', { entityType: 'TASK', entityId: t.id, subject: 'S', body: 'B', params: {} });
  const zip = (await raw('admin', 'GET', '/backup')).rawPayload; const JSZip = (await import('jszip')).default; const z = await JSZip.loadAsync(zip);
  for (const f of ['ai_summaries', 'ai_email_drafts', 'ai_usage']) assert.ok(z.file(`data/${f}.csv`), `${f}.csv is in the backup`);
  const v = (await call('admin', 'POST', '/restore/validate', { dataBase64: zip.toString('base64') })).body; assert.equal(v.ok, true); assert.equal(v.counts.ai_summaries, 1); assert.equal(v.counts.ai_email_drafts, 1);
  const cols = (await (app as any).db.rows("PRAGMA table_info(tasks)")).map((c: any) => c.name); assert.ok(cols.includes('ai_excluded'));
  await app.close(); m.close();
});
