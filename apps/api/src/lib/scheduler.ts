// Small background jobs that run inside the server: meeting reminders, timed announcements, a daily safety copy of the database.
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { nowIso } from './db.ts';
import { notify, ping } from './notify.ts';
import { publishDueAnnouncements } from '../routes/community.ts';
import { insertRow } from './crud.ts';
import { localDay } from './ai.ts';

export async function tick(app: FastifyInstance, now = new Date()) {
  const db = app.db; const iso = now.toISOString(); const soon = new Date(now.getTime() + 10 * 60e3).toISOString();
  const ms = await db.all<any>("SELECT * FROM meetings WHERE archived_at IS NULL AND status = 'SCHEDULED' AND reminded_at IS NULL AND start_at <= ? AND start_at > ?", [soon, new Date(now.getTime() - 30 * 60e3).toISOString()]);
  for (const m of ms) {
    const people = await db.all<any>("SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND archived_at IS NULL AND rsvp <> 'NO'", [m.id]);
    for (const p of people) await notify(db, { userId: p.userId, kind: 'MEETING_SOON', title: `Starting soon: “${m.title}”`, body: 'Open the Chat Meetings tab to join.', link: `meetings/${m.id}`, groupKey: `soon:${m.id}` });
    await db.run('UPDATE meetings SET reminded_at = ? WHERE id = ?', [iso, m.id]); ping(people.map((p) => p.userId), 'meeting', { id: m.id });
  }
  const anns = await publishDueAnnouncements(db, iso);
  return { reminded: ms.length, announced: anns };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Morning / evening digest alerts (in-app; the person opens it and copies or sends it on WhatsApp). Server local time. */
export async function digestTick(app: FastifyInstance, now = new Date()) {
  const db = app.db; const day = localDay(now); const hm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`; let made = 0;
  for (const u of await db.all<any>('SELECT id FROM users WHERE active = 1 AND archived_at IS NULL AND id NOT IN (SELECT user_id FROM digest_prefs)')) await insertRow(db, 'digest_prefs', { userId: u.id, enabled: true, morning: '08:30', evening: '18:30' }, u.id);
  const prefs = await db.all<any>('SELECT p.* FROM digest_prefs p JOIN users u ON u.id = p.user_id WHERE p.enabled = 1 AND p.archived_at IS NULL AND u.active = 1 AND u.archived_at IS NULL');
  for (const p of prefs) {
    for (const kind of ['morning', 'evening'] as const) {
      const col = kind === 'morning' ? 'last_morning' : 'last_evening'; const last = kind === 'morning' ? p.lastMorning : p.lastEvening;
      if (last === day || hm < p[kind]) continue;
      if (hm > addMinutes(p[kind], 360)) { await db.run(`UPDATE digest_prefs SET ${col} = ? WHERE id = ?`, [day, p.id]); continue; }   // missed by hours (server was off): skip today
      await db.run(`UPDATE digest_prefs SET ${col} = ? WHERE id = ?`, [day, p.id]);
      await notify(db, { userId: p.userId, kind: 'DIGEST', title: kind === 'morning' ? 'Your morning digest is ready' : 'Your evening digest is ready', body: 'Open it to copy it or send it on WhatsApp.', link: `digest/${kind}`, groupKey: `digest:${kind}:${day}` }); made++;
    }
  }
  return made;
}
const addMinutes = (hm: string, min: number) => { const [h, m] = hm.split(':').map(Number); const t = Math.min(23 * 60 + 59, h * 60 + m + min); return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`; };

/** Tell people when a document is about to expire (at the reminder day, then 7 days, 1 day, and when it has expired). Once per step. */
export async function vaultTick(app: FastifyInstance, now = new Date()) {
  const db = app.db; const day = localDay(now); let made = 0;
  const docs = await db.all<any>("SELECT d.*, c.name company_name FROM vault_docs d JOIN companies c ON c.id = d.company_id WHERE d.archived_at IS NULL AND d.expires_on IS NOT NULL AND d.expires_on <= date(?, '+' || d.remind_days || ' days')", [day]);
  for (const d of docs) {
    const left = Math.round((Date.parse(d.expiresOn) - Date.parse(day)) / 864e5);
    const step = left < 0 ? 'expired' : left <= 1 ? 'd1' : left <= 7 ? 'd7' : 'start';
    const who = new Set<string>(); if (d.createdById) who.add(d.createdById);
    for (const a of await db.all<any>('SELECT id FROM users WHERE is_admin = 1 AND active = 1 AND archived_at IS NULL')) who.add(a.id);
    for (const m of await db.all<any>("SELECT user_id FROM company_memberships WHERE company_id = ? AND role = 'MANAGER' AND archived_at IS NULL", [d.companyId])) who.add(m.userId);
    const title = left < 0 ? `Expired: ${d.title}` : left === 0 ? `Expires today: ${d.title}` : `Expires in ${left} day${left === 1 ? '' : 's'}: ${d.title}`;
    for (const uid of who) if (await notify(db, { userId: uid, kind: 'DOC_EXPIRY', title, body: `${d.companyName} · ${d.category} · ${d.expiresOn}`, companyId: d.companyId, link: `vault/${d.id}`, groupKey: `vault:${d.id}:${d.expiresOn}:${step}` })) made++;
  }
  return made;
}

/** One dated copy per day in data/backups (the 14 newest are kept). */
export async function dailyBackup(app: FastifyInstance, now = new Date()) {
  const path = app.config.dbPath; if (path === ':memory:') return null;
  const dir = join(dirname(path), 'backups'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `daily-${now.toISOString().slice(0, 10)}.db`);
  if (existsSync(file)) return null;
  await app.db.snapshot(file);
  const old = readdirSync(dir).filter((f) => /^daily-.*\.db$/.test(f)).sort().slice(0, -14);
  for (const f of old) { try { unlinkSync(join(dir, f)); } catch { /* ignore */ } }
  return file;
}

export function startScheduler(app: FastifyInstance) {
  const run = () => { tick(app).catch((e) => app.log.warn({ err: String(e) }, 'scheduler tick failed')); digestTick(app).catch((e) => app.log.warn({ err: String(e) }, 'digest tick failed')); };
  const vt = () => { vaultTick(app).catch((e) => app.log.warn({ err: String(e) }, 'vault tick failed')); };
  const t3 = setInterval(vt, 3600_000); setTimeout(vt, 8000);
  const t1 = setInterval(run, 30_000);
  const backup = () => { dailyBackup(app).catch((e) => app.log.warn({ err: String(e) }, 'daily backup failed')); };
  const t2 = setInterval(backup, 3600_000); setTimeout(backup, 5000);
  app.addHook('onClose', async () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); });
  void nowIso;
}
