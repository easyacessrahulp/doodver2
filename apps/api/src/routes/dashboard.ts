import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../lib/db.ts';
import { newId, nowIso } from '../lib/db.ts';
import { analyse, type Thresholds } from '../lib/attention.ts';
import { addDays, diffDays, serverToday } from '../lib/dates.ts';
import { accessibleCompanyIds, inClause, need, taskGuard, type AuthUser } from '../lib/permissions.ts';
import { badRequest } from '../lib/errors.ts';
import { updateRow } from '../lib/crud.ts';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function settingsOf(db: Db, userId: string) {
  let s = await db.get<any>('SELECT * FROM user_settings WHERE user_id = ?', [userId]);
  if (!s) { const now = nowIso(); await db.run('INSERT INTO user_settings (id,user_id,created_at,updated_at) VALUES (?,?,?,?)', [newId(), userId, now, now]); s = await db.get<any>('SELECT * FROM user_settings WHERE user_id = ?', [userId]); }
  return s;
}

/** Open tasks the user can see, each with its attention analysis. */
export async function analysedOpenTasks(db: Db, user: AuthUser, o: { today: string; companyId?: string; projectId?: string }) {
  if (o.companyId) await need(db, user, o.companyId, 'VIEWER');
  const st = await settingsOf(db, user.id); const th: Thresholds = { soon: st.dueSoonDays, stale: st.staleDays, esc: st.escalateDays };
  const ids = await accessibleCompanyIds(db, user);
  const where = ["t.archived_at IS NULL", "t.status <> 'DONE'"]; const params: any[] = [];
  if (o.companyId) { where.push('t.company_id = ?'); params.push(o.companyId); } else if (ids) { where.push(`t.company_id IN (${inClause(ids)})`); params.push(...ids); }
  if (o.projectId) { where.push('t.project_id = ?'); params.push(o.projectId); }
  { const g = taskGuard(user, 't'); where.push(g.sql); params.push(...g.params); }
  const rows = await db.all<any>(`
    SELECT t.id, t.title, t.priority, t.status, t.due_date, t.last_activity_at, t.next_followup_date, t.next_action, t.waiting_for, t.waiting_expected_date,
           t.delegated_to_id, d.name AS delegated_to_name, t.postpone_count, t.company_id, c.name AS company_name, t.project_id, p.name AS project_name, u.name AS owner_name,
           (SELECT b.title FROM tasks b WHERE b.id = t.depends_on_id AND b.status <> 'DONE' AND b.archived_at IS NULL) AS blocked_by_title,
           EXISTS (SELECT 1 FROM tasks x WHERE x.depends_on_id = t.id AND x.status <> 'DONE' AND x.archived_at IS NULL) AS blocking,
           (SELECT COUNT(*) FROM subtasks sx WHERE sx.task_id = t.id AND sx.archived_at IS NULL) AS sub_total, (SELECT COUNT(*) FROM subtasks sx WHERE sx.task_id = t.id AND sx.archived_at IS NULL AND sx.status = 'DONE') AS sub_done, t.ai_excluded AS is_private
    FROM tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN people d ON d.id = t.delegated_to_id JOIN users u ON u.id = t.owner_id
    WHERE ${where.join(' AND ')}`, params);
  return { th, st, ids, items: rows.map((r) => ({ ...r, blocking: !!r.blocking, a: analyse({ priority: r.priority, dueDate: r.dueDate, lastActivityAt: r.lastActivityAt, nextFollowupDate: r.nextFollowupDate, waitingFor: r.waitingFor,
    status: r.status, delegatedToId: r.delegatedToId, delegatedToName: r.delegatedToName, postponeCount: r.postponeCount, blockedByTitle: r.blockedByTitle, blocking: !!r.blocking }, o.today, th) })) };
}

const slim = (x: any) => ({ subTotal: x.subTotal ?? 0, subDone: x.subDone ?? 0, isPrivate: !!x.isPrivate, id: x.id, title: x.title, priority: x.priority, status: x.status, dueDate: x.dueDate, companyId: x.companyId, company: x.companyName, projectId: x.projectId, project: x.projectName,
  person: x.delegatedToName, owner: x.ownerName, score: x.a.score, reasons: x.a.reasons, overdueDays: x.a.overdueDays, staleDays: x.a.staleDays, tone: x.a.status, nextAction: x.nextAction,
  nextFollowupDate: x.nextFollowupDate, waitingFor: x.waitingFor, waitingExpectedDate: x.waitingExpectedDate, daysToDue: x.a.daysToDue === 999 ? null : x.a.daysToDue });

export default async function dashboardRoutes(app: FastifyInstance) {
  const { db } = app;
  const q0 = z.object({ today: dateStr.optional(), companyId: z.string().optional(), projectId: z.string().optional(), dayStart: z.string().datetime().optional(), dueDays: z.coerce.number().int().refine((n) => [7, 14, 30].includes(n)).default(7) });

  // My Attention only — max 5, never "newest": highest score first, every item says why.
  const flagsOf = (x: any, today: string, soon: number) => ({ overdue: x.a.overdueDays > 0, critical: x.priority === 1, high: x.priority === 2, dueToday: x.dueDate === today,
    waiting: !!x.waitingFor || x.status === 'WAITING', upcoming: x.a.daysToDue > 0 && x.a.daysToDue <= soon });
  const countsOf = (items: any[], today: string, soon: number) => { const c = { all: 0, overdue: 0, critical: 0, high: 0, dueToday: 0, upcoming: 0, waiting: 0 };
    for (const x of items) { const f = flagsOf(x, today, soon); for (const k of ['overdue', 'critical', 'high', 'dueToday', 'upcoming', 'waiting'] as const) if (f[k]) c[k]++; if (f.overdue || f.critical || f.high || f.dueToday || f.upcoming || f.waiting || x.a.risk) c.all++; } return c; };

  app.get('/attention', async (req) => {
    const q = q0.extend({ limit: z.coerce.number().int().min(1).max(200).default(5) }).parse(req.query); const today = q.today ?? serverToday();
    const { items, th } = await analysedOpenTasks(db, req.user!, { today, companyId: q.companyId, projectId: q.projectId });
    const sorted = items.sort((a, b) => b.a.score - a.a.score || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
    return { today, counts: countsOf(items, today, th.soon), items: sorted.slice(0, q.limit).map((x) => ({ ...slim(x), flags: flagsOf(x, today, th.soon) })) };
  });

  app.get('/dashboard', async (req) => {
    const q = q0.parse(req.query); const today = q.today ?? serverToday();
    const dayStart = q.dayStart ?? new Date(`${today}T00:00:00.000Z`).toISOString();
    const { items, ids, th } = await analysedOpenTasks(db, req.user!, { today, companyId: q.companyId, projectId: q.projectId });
    const byScore = (a: any, b: any) => b.a.score - a.a.score || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9');
    const attention = [...items].sort(byScore).slice(0, 5);

    const dl = (x: any) => !!x.delegatedToId, waiting = (x: any) => !!x.waitingFor || x.status === 'WAITING';
    const rank = (x: any) => { const crit = x.priority === 1, od = x.a.overdueDays > 0, td = x.dueDate === today;
      return crit && od ? 0 : crit && td ? 1 : od ? 2 : td ? 3 : x.a.followUpDue ? 4 : x.a.status === 'r' || x.a.risk ? 5 : 6; };
    const doNow = items.filter((x) => !dl(x) && !waiting(x) && (x.priority <= 2 || x.a.overdueDays > 0 || x.dueDate === today || x.a.status === 'r' || x.a.followUpDue))
      .sort((a, b) => rank(a) - rank(b) || byScore(a, b)).slice(0, 15);
    const followUpNow = items.filter((x) => x.a.followUpDue).sort((a, b) => a.nextFollowupDate.localeCompare(b.nextFollowupDate) || byScore(a, b));
    const waitingFor = items.filter(waiting).map((x) => ({ ...slim(x), expectedPassed: !!x.waitingExpectedDate && x.waitingExpectedDate < today,
      daysPastExpected: x.waitingExpectedDate && x.waitingExpectedDate < today ? diffDays(x.waitingExpectedDate, today) : 0 })).sort((a, b) => b.daysPastExpected - a.daysPastExpected);
    const delegatedNeeding = items.filter((x) => dl(x) && (x.a.overdueDays > 0 || x.a.followUpDue || x.a.risk)).sort(byScore);
    const soon = items.filter((x) => x.dueDate && x.dueDate >= today && x.dueDate <= addDays(today, q.dueDays)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byScore(a, b));
    const group = (x: any) => { const n = diffDays(today, x.dueDate); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n <= 4 ? 'next3' : 'later'; };
    const dueSoon = { days: q.dueDays, groups: { today: [] as any[], tomorrow: [] as any[], next3: [] as any[], later: [] as any[] } };
    for (const x of soon) dueSoon.groups[group(x) as 'today'].push(slim(x));
    const atRisk = items.filter((x) => x.a.risk || x.a.status === 'a').sort(byScore);

    // Project health
    const where = ["t.archived_at IS NULL", "t.status = 'DONE'"]; const params: any[] = [];
    if (q.companyId) { where.push('t.company_id = ?'); params.push(q.companyId); } else if (ids) { where.push(`t.company_id IN (${inClause(ids)})`); params.push(...ids); }
    if (q.projectId) { where.push('t.project_id = ?'); params.push(q.projectId); }
    { const g = taskGuard(req.user!, 't'); where.push(g.sql); params.push(...g.params); }
    const doneRows = await db.all<any>(`SELECT t.project_id, COUNT(*) n FROM tasks t WHERE ${where.join(' AND ')} GROUP BY t.project_id`, params);
    const done = new Map(doneRows.map((r) => [r.projectId ?? '', r.n]));
    const ph = new Map<string, any>();
    for (const x of items) {
      const k = x.projectId ?? ''; const h = ph.get(k) ?? { projectId: x.projectId, project: x.projectName ?? '(No project)', company: x.companyName, open: 0, overdue: 0, atRisk: 0, done: done.get(k) ?? 0 };
      h.open++; if (x.a.overdueDays > 0) h.overdue++; if (x.a.risk) h.atRisk++; ph.set(k, h);
    }
    const projectHealth = [...ph.values()].map((h) => ({ ...h, progress: h.open + h.done ? Math.round((h.done / (h.open + h.done)) * 100) : 0 })).sort((a, b) => b.overdue - a.overdue || b.atRisk - a.atRisk || b.open - a.open);

    const cw: { sql: string; p: any[] } = { sql: q.companyId ? ' AND t.company_id = ?' : ids ? ` AND t.company_id IN (${inClause(ids)})` : '', p: q.companyId ? [q.companyId] : ids ?? [] };
    { const g = taskGuard(req.user!, 't'); cw.sql += ` AND ${g.sql}`; cw.p.push(...g.params); }
    const completedToday = await db.all<any>(`SELECT t.id, t.title, t.priority, t.completed_at, t.completion_note, c.name AS company_name FROM tasks t JOIN companies c ON c.id = t.company_id
      WHERE t.archived_at IS NULL AND t.status = 'DONE' AND t.completed_at >= ?${cw.sql} ORDER BY t.completed_at DESC LIMIT 10`, [dayStart, ...cw.p]);
    const focus = await db.get<any>('SELECT COALESCE(SUM(actual_minutes),0) m FROM focus_sessions WHERE user_id = ? AND ended_at IS NOT NULL AND archived_at IS NULL AND started_at >= ?', [req.user!.id, dayStart]);
    const pc = await db.get<any>(`SELECT COUNT(*) n FROM calls k JOIN tasks t ON t.id = k.task_id WHERE k.archived_at IS NULL AND k.done_at IS NULL AND t.archived_at IS NULL AND t.status <> 'DONE'${cw.sql}`, cw.p);
    const pd = await db.get<any>(`SELECT COUNT(*) n FROM discussions d JOIN tasks t ON t.id = d.task_id WHERE d.archived_at IS NULL AND d.done_at IS NULL AND t.archived_at IS NULL AND t.status <> 'DONE'${cw.sql}`, cw.p);

    const counters = { overdue: items.filter((x) => x.a.overdueDays > 0).length, atRisk: atRisk.length, followUps: followUpNow.length, dueToday: items.filter((x) => x.dueDate === today).length,
      delegated: items.filter(dl).length, waiting: waitingFor.length, focusMinutesToday: focus!.m, pendingCommunications: pc!.n, pendingDiscussions: pd!.n };
    // ── Action Centre numbers: calls, follow-ups, discussions, tasks ──
    const open = "k.archived_at IS NULL AND k.done_at IS NULL AND t.archived_at IS NULL AND t.status <> 'DONE'";
    const callAgg = (await db.get<any>(`SELECT COALESCE(SUM(k.due_date < ?),0) overdue, COALESCE(SUM(k.due_date = ?),0) today, COALESCE(SUM(k.due_date > ?),0) upcoming, COALESCE(SUM(k.due_date IS NULL),0) undated
      FROM calls k JOIN tasks t ON t.id = k.task_id WHERE ${open}${cw.sql}`, [today, today, today, ...cw.p]))!;
    const callItems = await db.all<any>(`SELECT k.id, k.updated_at, k.company_id, k.task_id, k.channel, COALESCE(pe.name, k.contact_name) who, COALESCE(k.phone, pe.phone) phone, k.note, k.due_date, t.title task_title, c.name company_name
      FROM calls k JOIN tasks t ON t.id = k.task_id JOIN companies c ON c.id = t.company_id LEFT JOIN people pe ON pe.id = k.person_id WHERE ${open}${cw.sql} ORDER BY (k.due_date IS NULL), k.due_date, t.priority LIMIT 8`, cw.p);
    const fopen = "f.archived_at IS NULL AND f.done_at IS NULL AND t.archived_at IS NULL AND t.status <> 'DONE'";
    const fAgg = (await db.get<any>(`SELECT COALESCE(SUM(substr(f.due_at,1,10) < ?),0) overdue, COALESCE(SUM(substr(f.due_at,1,10) = ?),0) today, COALESCE(SUM(substr(f.due_at,1,10) > ?),0) upcoming
      FROM followups f JOIN tasks t ON t.id = f.task_id WHERE ${fopen}${cw.sql}`, [today, today, today, ...cw.p]))!;
    const fItems = await db.all<any>(`SELECT f.id, f.updated_at, f.company_id, f.person_id, f.subtask_id, f.task_id, f.type, substr(f.due_at,1,10) due_date, f.notes, COALESCE(pe.name, f.contact_name) who, t.title task_title, c.name company_name
      FROM followups f JOIN tasks t ON t.id = f.task_id JOIN companies c ON c.id = t.company_id LEFT JOIN people pe ON pe.id = f.person_id WHERE ${fopen}${cw.sql} ORDER BY substr(f.due_at,1,10), t.priority LIMIT 8`, cw.p);
    const dopen = "d.archived_at IS NULL AND d.done_at IS NULL AND t.archived_at IS NULL AND t.status <> 'DONE'";
    const dAgg = (await db.get<any>(`SELECT COUNT(*) pending, COALESCE(SUM(d.due_date = ?),0) today, COALESCE(SUM(d.due_date < ?),0) overdue FROM discussions d JOIN tasks t ON t.id = d.task_id WHERE ${dopen}${cw.sql}`, [today, today, ...cw.p]))!;
    const dItems = await db.all<any>(`SELECT d.id, d.task_id, d.kind, d.topic, d.due_date, d.meeting_time, COALESCE(pe.name, d.contact_name) who, t.title task_title, c.name company_name
      FROM discussions d JOIN tasks t ON t.id = d.task_id JOIN companies c ON c.id = t.company_id LEFT JOIN people pe ON pe.id = d.person_id WHERE ${dopen}${cw.sql} ORDER BY (d.due_date IS NULL), d.due_date, t.priority LIMIT 8`, cw.p);
    const ac = countsOf(items, today, th.soon);
    const action = { calls: { ...callAgg, items: callItems }, followups: { ...fAgg, items: fItems }, discussions: { ...dAgg, items: dItems },
      tasks: { overdue: counters.overdue, dueToday: counters.dueToday, highPriority: ac.high + ac.critical, critical: ac.critical } };
    const attentionPool = [...items].sort(byScore).slice(0, 40).map((x) => ({ ...slim(x), flags: flagsOf(x, today, th.soon) }));
    const top = attention[0];
    const briefing = { recommended: top ? { id: top.id, title: top.title, reasons: top.a.reasons.map((r: any) => r.text) } : null,
      lines: [`${counters.overdue} overdue · ${counters.dueToday} due today · ${counters.followUps} follow-ups due`, `${counters.delegated} delegated · ${counters.waiting} waiting on others · ${counters.atRisk} at risk`,
        `${counters.pendingCommunications} calls/mails and ${counters.pendingDiscussions} discussions pending`] };
    return { today, counters, action, attentionPool, attentionCounts: ac, attention: attention.map(slim), doNow: doNow.map(slim), followUpNow: followUpNow.map(slim), waitingFor, delegated: delegatedNeeding.map(slim), dueSoon, atRisk: atRisk.map(slim), projectHealth,
      completedToday, briefing,
      focusSuggestion: top ? { taskId: top.id, title: top.title, minutes: top.priority <= 2 || top.a.overdueDays > 0 ? 50 : 25, why: top.a.reasons[0]?.text ?? 'Highest attention score' } : null };
  });

  // ───── Per-user settings (thresholds + Pomodoro defaults) ─────
  const settingsBody = z.object({ staleDays: z.number().int().min(1).max(60), dueSoonDays: z.number().int().min(1).max(30), escalateDays: z.number().int().min(1).max(60),
    focusMinutes: z.number().int().min(1).max(180), shortBreakMinutes: z.number().int().min(1).max(60), longBreakMinutes: z.number().int().min(1).max(120), sessionsBeforeLong: z.number().int().min(1).max(12),
    notifyMode: z.enum(['IMMEDIATE', 'DAILY', 'WEEKLY', 'OFF']) }).partial();
  app.get('/settings', async (req) => { const { id, userId, createdAt, createdById, updatedById, archivedAt, ...s } = await settingsOf(db, req.user!.id); void id; void userId; void createdAt; void createdById; void updatedById; void archivedAt; return s; });
  app.patch('/settings', async (req) => {
    const b = settingsBody.extend({ expectedUpdatedAt: z.string().optional() }).parse(req.body); const { expectedUpdatedAt, ...patch } = b;
    if (!Object.keys(patch).length) throw badRequest('Nothing to change');
    const cur = await settingsOf(db, req.user!.id);
    const row = await updateRow(db, 'user_settings', cur.id, patch, expectedUpdatedAt ?? cur.updatedAt, req.user!.id);
    const { id, userId, createdAt, createdById, updatedById, archivedAt, ...s } = row; void id; void userId; void createdAt; void createdById; void updatedById; void archivedAt; return s;
  });
}
