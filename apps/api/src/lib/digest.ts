// Plain-text daily digest (morning / evening). Built from the person's own data; never sent anywhere by the server — they copy it or open WhatsApp.
import type { Db } from './db.ts';
import type { AuthUser } from './permissions.ts';
import { accessibleCompanyIds, inClause, taskGuard, rowGuard } from './permissions.ts';
import { addDays } from './dates.ts';
import { chaseQueue } from './chase.ts';

const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const list = (rows: { title: string; company?: string; who?: string | null; due?: string | null }[], max = 6) => {
  const out = rows.slice(0, max).map((r) => `• ${r.title}${r.company ? ` (${r.company})` : ''}${r.who ? ` – ${r.who}` : ''}`);
  if (rows.length > max) out.push(`…and ${rows.length - max} more`);
  return out;
};

export async function vaultExpiring(db: Db, user: AuthUser, today: string, withinDays = 60) {
  const ids = await accessibleCompanyIds(db, user); const where = ['d.archived_at IS NULL', 'd.expires_on IS NOT NULL', 'd.expires_on <= ?']; const params: any[] = [addDays(today, withinDays)];
  if (ids) { where.push(`d.company_id IN (${inClause(ids)})`); params.push(...ids); }
  if (user.scoped.length) { where.push(`(d.company_id NOT IN (${inClause(user.scoped)}) OR d.created_by_id = ?)`); params.push(...user.scoped, user.id); }
  const rows = await db.all<any>(`SELECT d.id, d.title, d.category, d.expires_on, d.remind_days, d.company_id, c.name company_name, c.color company_color FROM vault_docs d JOIN companies c ON c.id = d.company_id WHERE ${where.join(' AND ')} ORDER BY d.expires_on LIMIT 100`, params);
  return rows.filter((r) => r.expiresOn < today || r.expiresOn <= addDays(today, r.remindDays)).map((r) => ({ ...r, daysLeft: Math.round((Date.parse(r.expiresOn) - Date.parse(today)) / 864e5) }));
}

export async function buildDigest(db: Db, user: AuthUser, today: string, kind: 'morning' | 'evening') {
  const ids = await accessibleCompanyIds(db, user); const g = taskGuard(user, 't');
  const base = ['t.archived_at IS NULL', g.sql]; const bp: any[] = [...g.params];
  if (ids) { base.push(`t.company_id IN (${inClause(ids)})`); bp.push(...ids); }
  const q = (extra: string, p: any[] = [], order = 't.due_date, t.priority', limit = 40) => db.all<any>(`SELECT t.id, t.title, t.due_date, t.status, c.short_name co, c.name co_name, pe.name who FROM tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN people pe ON pe.id = t.delegated_to_id
    WHERE ${base.join(' AND ')} AND ${extra} ORDER BY ${order} LIMIT ${limit}`, [...bp, ...p]);
  const name = user.name.split(' ')[0]; const sections: { title: string; lines: string[]; count: number }[] = [];
  const add = (title: string, rows: any[], mapper = (r: any) => ({ title: r.title, company: r.co ?? r.coName, who: r.who })) => { if (rows.length) sections.push({ title, count: rows.length, lines: list(rows.map(mapper)) }); };
  if (kind === 'morning') {
    add('Overdue', await q("t.status <> 'DONE' AND t.due_date < ?", [today]));
    add('Due today', await q("t.status <> 'DONE' AND t.due_date = ?", [today]));
    const rg = rowGuard(user, 'f'); const fu = await db.all<any>(`SELECT f.notes, t.title, c.short_name co, pe.name who FROM followups f JOIN tasks t ON t.id = f.task_id JOIN companies c ON c.id = f.company_id LEFT JOIN people pe ON pe.id = f.person_id
      WHERE f.archived_at IS NULL AND f.done_at IS NULL AND substr(f.due_at,1,10) <= ? AND t.archived_at IS NULL AND ${rg.sql} ${ids ? `AND f.company_id IN (${inClause(ids)})` : ''} ORDER BY f.due_at LIMIT 40`, [today, ...rg.params, ...(ids ?? [])]);
    add('Follow-ups due', fu, (r) => ({ title: r.title, company: r.co, who: r.who }));
    const rk = rowGuard(user, 'k'); const calls = await db.all<any>(`SELECT k.channel, k.contact_name, t.title, c.short_name co FROM calls k JOIN tasks t ON t.id = k.task_id JOIN companies c ON c.id = k.company_id
      WHERE k.archived_at IS NULL AND k.done_at IS NULL AND (k.due_date IS NULL OR k.due_date <= ?) AND ${rk.sql} ${ids ? `AND k.company_id IN (${inClause(ids)})` : ''} ORDER BY k.due_date LIMIT 40`, [today, ...rk.params, ...(ids ?? [])]);
    add('Calls to make', calls, (r) => ({ title: `${r.channel === 'CALL' ? 'Call' : r.channel === 'WHATSAPP' ? 'WhatsApp' : 'Mail'} ${r.contactName ?? ''} – ${r.title}`.trim(), company: r.co }));
    const meet = await db.all<any>(`SELECT m.title, m.start_at FROM meetings m JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = ? AND p.archived_at IS NULL WHERE m.archived_at IS NULL AND m.status = 'SCHEDULED' AND substr(m.start_at,1,10) = ? ORDER BY m.start_at`, [user.id, today]);
    add('Meetings today', meet, (r) => ({ title: r.title }));
    const ch = await chaseQueue(db, user, today, 8);
    if (ch.total) sections.push({ title: 'People to chase', count: ch.total, lines: list(ch.items.map((i) => ({ title: i.title, who: i.person?.name ?? i.waitingFor, company: i.company })), 5) });
    const ap = await db.all<any>('SELECT title FROM approvals WHERE approver_id = ? AND status = ? AND archived_at IS NULL', [user.id, 'PENDING']);
    add('Waiting for your approval', ap, (r) => ({ title: r.title }));
    const vx = await vaultExpiring(db, user, today, 30); add('Documents expiring', vx, (r) => ({ title: `${r.title} – ${r.daysLeft < 0 ? 'expired ' + -r.daysLeft + 'd ago' : r.daysLeft === 0 ? 'expires today' : r.daysLeft + ' days left'}`, company: r.companyName }));
  } else {
    const done = await q("t.status = 'DONE' AND substr(t.completed_at,1,10) = ?", [today], 't.completed_at DESC');
    add('Done today', done);
    add('Still open from today', await q("t.status <> 'DONE' AND t.due_date <= ?", [today]));
    add('Tomorrow', await q("t.status <> 'DONE' AND t.due_date = ?", [addDays(today, 1)]));
  }
  const total = sections.reduce((n, s) => n + s.count, 0);
  const head = kind === 'morning' ? `*Good morning, ${name}* – ${fmt(today)}` : `*Good evening, ${name}* – ${fmt(today)}`;
  const body = sections.length ? sections.map((s) => `*${s.title} (${s.count})*\n${s.lines.join('\n')}`).join('\n\n') : (kind === 'morning' ? 'Nothing is due or overdue. A clear day!' : 'Nothing pending for tomorrow.');
  return { kind, today, title: kind === 'morning' ? 'Morning digest' : 'Evening digest', total, sections, text: `${head}\n\n${body}\n\n_DOOD_` };
}
