// Auto-chase: works out WHO should be reminded about WHAT today, and writes a ready message. Nothing is sent from here — the person presses send.
import type { Db } from './db.ts';
import type { AuthUser } from './permissions.ts';
import { accessibleCompanyIds, inClause, taskGuard } from './permissions.ts';
import { addDays, diffDays } from './dates.ts';

export const TONES = ['gentle', 'firm', 'escalate'] as const;
export type Tone = typeof TONES[number];
export const suggestTone = (n: number): Tone => (n <= 0 ? 'gentle' : n === 1 ? 'firm' : 'escalate');
export function reminderText(tone: Tone, o: { first: string; item: string; due: string | null; overdue: number; n: number; manager?: string }) {
  const when = o.overdue > 0 ? `now ${o.overdue} day${o.overdue === 1 ? '' : 's'} overdue` : o.due ? `due on ${o.due}` : 'pending';
  if (tone === 'gentle') return `Hi ${o.first}, a quick reminder about "${o.item}" (${when}). Could you please share an update when you get a moment? Thank you.`;
  if (tone === 'firm') return `Hi ${o.first}, "${o.item}" is ${when}. Please send it by tomorrow 11 AM and confirm here.`;
  return `Hi ${o.first}, "${o.item}" is still pending after ${Math.max(o.n, 2)} reminders${o.manager ? `, so I am copying ${o.manager}` : ''}. Please send it today, or tell us what is blocking it.`;
}

export const CHASE_GAP_DAYS = 2;       // do not nag the same person about the same item more often than this
export interface ChaseItem {
  key: string; taskId: string; subtaskId: string | null; title: string; taskTitle: string; companyId: string; company: string; companyColor: string | null;
  person: { id: string; name: string; phone: string | null; email: string | null } | null; waitingFor: string | null; manager: { name: string } | null;
  dueDate: string | null; overdueDays: number; priorReminders: number; lastReminded: string | null; daysSinceReminder: number | null; tone: Tone; message: string; reason: string[]; score: number; isPrivate: boolean;
}

/** Items someone else owes you (delegated tasks, waiting tasks, sub-tasks given to a person) that are due/overdue/quiet and have not been chased recently. */
export async function chaseQueue(db: Db, user: AuthUser, today: string, limit = 50): Promise<{ items: ChaseItem[]; total: number }> {
  const ids = await accessibleCompanyIds(db, user); const g = taskGuard(user, 't');
  const where = ['t.archived_at IS NULL', "t.status <> 'DONE'", g.sql]; const params: any[] = [...g.params];
  if (ids) { where.push(`t.company_id IN (${inClause(ids)})`); params.push(...ids); }
  const tasks = await db.all<any>(`SELECT t.id, t.title, t.status, t.due_date, t.company_id, t.priority, t.delegated_to_id, t.waiting_for, t.waiting_expected_date, t.next_followup_date, t.last_activity_at, t.ai_excluded, c.name company_name, c.color company_color,
      COALESCE(pj.ai_excluded, 0) pj_private FROM tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN projects pj ON pj.id = t.project_id WHERE ${where.join(' AND ')} LIMIT 600`, params);
  if (!tasks.length) return { items: [], total: 0 };
  const tids = tasks.map((t) => t.id); const ph = inClause(tids);
  const subs = await db.all<any>(`SELECT * FROM subtasks WHERE task_id IN (${ph}) AND archived_at IS NULL AND status <> 'DONE' AND assignee_id IS NOT NULL`, tids);
  const people = new Map((await db.all<any>('SELECT id, name, phone, email, reports_to_id FROM people WHERE archived_at IS NULL')).map((p) => [p.id, p]));
  const rem = await db.all<any>(`SELECT task_id, COALESCE(subtask_id,'') sid, COALESCE(person_id,'') pid, COUNT(*) n, MAX(last_reminded_at) last FROM followups WHERE task_id IN (${ph}) AND last_reminded_at IS NOT NULL AND archived_at IS NULL GROUP BY 1,2,3`, tids);
  const remMap = new Map(rem.map((r) => [`${r.taskId}|${r.sid}|${r.pid}`, r]));
  const snz = await db.all<any>(`SELECT task_id, COALESCE(subtask_id,'') sid FROM chase_snooze WHERE user_id = ? AND archived_at IS NULL AND until_date >= ?`, [user.id, today]);
  const snoozed = new Set(snz.map((s) => `${s.taskId}|${s.sid}`));
  const items: ChaseItem[] = [];
  const add = (t: any, sub: any | null) => {
    const sid = sub?.id ?? ''; if (snoozed.has(`${t.id}|${sid}`)) return;
    const pid = sub ? sub.assigneeId : t.delegatedToId; const person = pid ? people.get(pid) : null;
    if (!person && !(t.status === 'WAITING' && t.waitingFor && !sub)) return;       // nobody to chase
    const due: string | null = sub ? sub.dueDate : (t.status === 'WAITING' ? (t.waitingExpectedDate ?? t.dueDate) : t.dueDate);
    const overdue = due ? Math.max(0, diffDays(due, today)) : 0;
    const quiet = diffDays(String(t.lastActivityAt).slice(0, 10), today);
    const dueSoon = !!due && diffDays(today, due) <= 1;
    const fuDue = !!t.nextFollowupDate && t.nextFollowupDate <= today;
    const r = remMap.get(`${t.id}|${sid}|${pid ?? ''}`); const prior = r?.n ?? 0; const since = r?.last ? diffDays(String(r.last).slice(0, 10), today) : null;
    if (since !== null && since < CHASE_GAP_DAYS) return;                           // reminded very recently
    const reason: string[] = [];
    if (overdue) reason.push(`Overdue ${overdue} day${overdue === 1 ? '' : 's'}`); else if (dueSoon) reason.push(due === today ? 'Due today' : 'Due tomorrow');
    if (fuDue) reason.push('Follow-up date reached');
    if (!reason.length && quiet >= 5 && !sub) reason.push(`No update for ${quiet} days`);
    if (!reason.length) return;
    reason.push(prior ? `Reminded ${prior} time${prior === 1 ? '' : 's'}${since !== null ? `, last ${since === 0 ? 'today' : since + ' day' + (since === 1 ? '' : 's') + ' ago'}` : ''}` : 'Not reminded yet');
    const tone = suggestTone(prior); const mgr = person?.reportsToId ? people.get(person.reportsToId) : null;
    const item = sub ? sub.title : t.title; const first = (person?.name ?? t.waitingFor ?? 'there').split(' ')[0];
    const priv = !!(t.aiExcluded || t.pjPrivate);
    items.push({ key: `${t.id}|${sid}`, taskId: t.id, subtaskId: sub?.id ?? null, title: item, taskTitle: t.title, companyId: t.companyId, company: t.companyName, companyColor: t.companyColor ?? null,
      person: person ? { id: person.id, name: person.name, phone: person.phone ?? null, email: person.email ?? null } : null, waitingFor: sub ? null : (t.waitingFor ?? null), manager: mgr ? { name: mgr.name } : null,
      dueDate: due, overdueDays: overdue, priorReminders: prior, lastReminded: r?.last ?? null, daysSinceReminder: since, tone, reason, isPrivate: priv,
      message: reminderText(tone, { first, item, due, overdue, n: prior, manager: mgr?.name }), score: overdue * 3 + prior * 2 + (fuDue ? 4 : 0) + (dueSoon ? 2 : 0) + (5 - Math.min(5, tasksPriority(t))) });
  };
  for (const t of tasks) { if (t.delegatedToId || t.status === 'WAITING' || t.status === 'DELEGATED') add(t, null); }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const s of subs) { const t = byId.get(s.taskId); if (t) add(t, s); }
  items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { items: items.slice(0, limit), total: items.length };
}
const tasksPriority = (t: any) => Number(t.priority ?? 3);
