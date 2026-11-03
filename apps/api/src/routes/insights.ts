import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../lib/db.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { accessibleCompanyIds, inClause, need, taskGuard, type AuthUser } from '../lib/permissions.ts';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
import { addDays, diffDays, serverToday } from '../lib/dates.ts';
export { addDays, diffDays };

export interface AgendaItem {
  kind: 'task' | 'subtask' | 'call' | 'followup' | 'waiting' | 'discussion' | 'meeting'; channel?: string | null; time?: string | null; id: string; taskId: string; title: string; parentTitle?: string | null;
  date: string; priority: number; status: string; companyId: string; companyName: string; projectName?: string | null;
  person?: string | null; note?: string | null; phone?: string | null;
}
const KIND_ORDER: Record<string, number> = { meeting: -1, task: 0, subtask: 1, discussion: 2, call: 3, followup: 4, waiting: 5 };

/** Pending work with a date, for the calendar and the message centre. Done / archived items never appear. */
export async function agenda(db: Db, user: AuthUser, o: { companyId?: string; from?: string; to: string; limit?: number }): Promise<AgendaItem[]> {
  if (o.companyId) await need(db, user, o.companyId, 'VIEWER');
  const ids = await accessibleCompanyIds(db, user);
  const scope = (col: string) => o.companyId ? { sql: ` AND ${col} = ?`, params: [o.companyId] } : ids ? { sql: ` AND ${col} IN (${inClause(ids)})`, params: [...ids] } : { sql: '', params: [] as any[] };
  const range = (col: string) => ({ sql: ` AND ${col} IS NOT NULL AND ${col} <= ?${o.from ? ` AND ${col} >= ?` : ''}`, params: o.from ? [o.to, o.from] : [o.to] });
  const lim = ` LIMIT ${Math.min(o.limit ?? 800, 1500)}`;
  const out: AgendaItem[] = [];
  const run = async (kind: AgendaItem['kind'], select: string, from: string, base: string, dateCol: string, scopeCol: string) => {
    const s = scope(scopeCol), r = range(dateCol), g = taskGuard(user, 't');
    const rows = await db.all<any>(`SELECT ${select} FROM ${from} WHERE ${base}${s.sql}${r.sql} AND ${g.sql} ORDER BY ${dateCol}${lim}`, [...s.params, ...r.params, ...g.params]);
    for (const x of rows) out.push({ kind, ...x });
  };
  const TJ = 'tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN people d ON d.id = t.delegated_to_id';
  const OPEN = "t.archived_at IS NULL AND t.status <> 'DONE'";
  const T = 't.id AS id, t.id AS task_id, t.title AS title, t.priority AS priority, t.status AS status, t.company_id AS company_id, c.name AS company_name, p.name AS project_name, d.name AS person';
  await run('task', `${T}, t.due_date AS date`, TJ, OPEN, 't.due_date', 't.company_id');
  await run('followup', `${T}, t.next_followup_date AS date, t.next_action AS note`, TJ, OPEN, 't.next_followup_date', 't.company_id');
  await run('waiting', `${T}, t.waiting_expected_date AS date, t.waiting_for AS note`, TJ, `${OPEN} AND t.waiting_for IS NOT NULL`, 't.waiting_expected_date', 't.company_id');
  await run('subtask', `s.id AS id, t.id AS task_id, s.title AS title, t.title AS parent_title, s.priority AS priority, s.status AS status, t.company_id AS company_id, c.name AS company_name, p.name AS project_name, a.name AS person, s.due_date AS date`,
    `subtasks s JOIN tasks t ON t.id = s.task_id JOIN companies c ON c.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN people a ON a.id = s.assignee_id`,
    `s.archived_at IS NULL AND s.status <> 'DONE' AND ${OPEN}`, 's.due_date', 't.company_id');
  await run('discussion', `d.id AS id, t.id AS task_id, d.topic AS title, t.title AS parent_title, t.priority AS priority, 'DISCUSSION' AS status, t.company_id AS company_id, c.name AS company_name, p.name AS project_name, COALESCE(pe.name, d.contact_name) AS person, d.agenda AS note, d.kind AS channel, d.meeting_time AS time, d.due_date AS date`,
    `discussions d JOIN tasks t ON t.id = d.task_id JOIN companies c ON c.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN people pe ON pe.id = d.person_id`,
    `d.archived_at IS NULL AND d.done_at IS NULL AND ${OPEN}`, 'd.due_date', 't.company_id');
  await run('call', `k.id AS id, t.id AS task_id, COALESCE(k.contact_name, pe.name, 'Call') AS title, k.channel AS channel, t.title AS parent_title, t.priority AS priority, 'CALL' AS status, t.company_id AS company_id, c.name AS company_name, p.name AS project_name, COALESCE(pe.name, k.contact_name) AS person, k.note AS note, k.phone AS phone, k.due_date AS date`,
    `calls k JOIN tasks t ON t.id = k.task_id JOIN companies c ON c.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN people pe ON pe.id = k.person_id`,
    `k.archived_at IS NULL AND k.done_at IS NULL AND t.archived_at IS NULL`, 'k.due_date', 't.company_id');
  // Chat meetings you are invited to appear in the same calendar.
  const ms = await db.all<any>(`SELECT m.id, m.title, m.start_at, m.status, o.name AS organizer, m.agenda FROM meetings m JOIN users o ON o.id = m.organizer_id
    WHERE m.archived_at IS NULL AND m.status IN ('SCHEDULED','LIVE') AND (m.organizer_id = ? OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = ? AND p.archived_at IS NULL)) LIMIT 300`, [user.id, user.id]);
  for (const m of ms) {
    const dt = new Date(m.startAt); const date = dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); const time = dt.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    if (date > o.to || (o.from ? date < o.from : date < serverToday())) continue;
    if (o.companyId) continue;
    out.push({ kind: 'meeting', id: m.id, taskId: '', title: m.title, date, time, priority: 3, status: m.status, companyId: '', companyName: 'Chat meeting', person: `by ${m.organizer}`, note: m.agenda });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title));
}

export default async function insights(app: FastifyInstance) {
  const { db } = app;

  // ───── Calendar: pending items between two dates (max ~3 months) ─────
  app.get('/calendar', async (req) => {
    const q = z.object({ from: dateStr, to: dateStr, companyId: z.string().optional() }).parse(req.query);
    if (diffDays(q.from, q.to) > 100 || q.to < q.from) throw badRequest('Choose a range of up to 100 days');
    return { items: await agenda(db, req.user!, { companyId: q.companyId, from: q.from, to: q.to }) };
  });

  // ───── Message centre: overdue + today + tomorrow + day after tomorrow, plus critical tasks and undated calls ─────
  app.get('/messages', async (req) => {
    const q = z.object({ today: dateStr.optional(), companyId: z.string().optional() }).parse(req.query);
    const today = q.today ?? serverToday(); const tomorrow = addDays(today, 1); const dayAfter = addDays(today, 2);
    const items = await agenda(db, req.user!, { companyId: q.companyId, to: dayAfter });
    const overdue = items.filter((i) => i.date < today);
    const pick = (d: string) => items.filter((i) => i.date === d);
    const ids = await accessibleCompanyIds(db, req.user!);
    const cs: { sql: string; params: any[] } = q.companyId ? { sql: ' AND t.company_id = ?', params: [q.companyId] } : ids ? { sql: ` AND t.company_id IN (${inClause(ids)})`, params: [...ids] } : { sql: '', params: [] as any[] };
    { const g = taskGuard(req.user!, 't'); cs.sql += ` AND ${g.sql}`; cs.params.push(...g.params); }
    // Critical = priority 1, still open, due today or already overdue.
    const critical = await db.all<any>(
      `SELECT t.id, t.id AS task_id, t.title, t.priority, t.status, t.due_date AS date, t.company_id, c.name AS company_name, d.name AS person
       FROM tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN people d ON d.id = t.delegated_to_id
       WHERE t.archived_at IS NULL AND t.status <> 'DONE' AND t.priority = 1 AND t.due_date IS NOT NULL AND t.due_date <= ?${cs.sql} ORDER BY t.due_date, t.title LIMIT 50`, [today, ...cs.params]);
    const undatedCalls = await db.all<any>(
      `SELECT k.id, t.id AS task_id, COALESCE(k.contact_name, pe.name) AS title, k.phone, k.note, t.title AS parent_title, c.name AS company_name
       FROM calls k JOIN tasks t ON t.id = k.task_id JOIN companies c ON c.id = t.company_id LEFT JOIN people pe ON pe.id = k.person_id
       WHERE k.archived_at IS NULL AND k.done_at IS NULL AND k.due_date IS NULL AND t.archived_at IS NULL${cs.sql} ORDER BY k.created_at DESC LIMIT 50`, cs.params);
    const counts = { overdue: overdue.length, today: pick(today).length, tomorrow: pick(tomorrow).length, dayAfter: pick(dayAfter).length, critical: critical.length, undatedCalls: undatedCalls.length };
    return { today, overdue, days: [{ key: 'today', date: today, items: pick(today) }, { key: 'tomorrow', date: tomorrow, items: pick(tomorrow) }, { key: 'dayAfter', date: dayAfter, items: pick(dayAfter) }],
      critical, undatedCalls, counts, badge: counts.overdue + counts.today };
  });

  // ───── Performance of the people you delegate to ─────
  app.get('/people/performance', async (req) => {
    const q = z.object({ companyId: z.string().optional(), days: z.coerce.number().int().min(0).max(3650).default(0), today: dateStr.optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const today = q.today ?? serverToday();
    const ids = await accessibleCompanyIds(db, req.user!);
    const where = ['t.archived_at IS NULL', 't.delegated_to_id IS NOT NULL']; const params: any[] = [];
    if (q.companyId) { where.push('t.company_id = ?'); params.push(q.companyId); } else if (ids) { where.push(`t.company_id IN (${inClause(ids)})`); params.push(...ids); }
    { const g = taskGuard(req.user!, 't'); where.push(g.sql); params.push(...g.params); }
    if (q.days > 0) { where.push('COALESCE(t.delegated_at, t.created_at) >= ?'); params.push(new Date(Date.now() - q.days * 864e5).toISOString()); }
    const rows = await db.all<any>(
      `SELECT t.delegated_to_id AS pid, p.name, p.designation, pc.name AS person_company, t.status, t.due_date, t.completed_at, t.postpone_count,
              COALESCE(t.delegated_at, t.created_at) AS assigned_at
       FROM tasks t JOIN people p ON p.id = t.delegated_to_id LEFT JOIN companies pc ON pc.id = p.company_id WHERE ${where.join(' AND ')}`, params);
    const by = new Map<string, any>();
    for (const r of rows) {
      const m = by.get(r.pid) ?? { personId: r.pid, name: r.name, designation: r.designation, company: r.personCompany ?? 'Shared', assigned: 0, completed: 0, onTime: 0, late: 0, open: 0, overdueOpen: 0,
        delayDays: 0, maxDelayDays: 0, overdueDays: 0, postponements: 0, turnaround: 0, subAssigned: 0, subDone: 0, subLate: 0, subOverdue: 0 };
      m.assigned++; m.postponements += r.postponeCount;
      if (r.status === 'DONE' && r.completedAt) {
        m.completed++;
        const delay = r.dueDate ? Math.max(0, diffDays(r.dueDate, r.completedAt.slice(0, 10))) : 0;
        if (delay > 0) { m.late++; m.delayDays += delay; m.maxDelayDays = Math.max(m.maxDelayDays, delay); } else m.onTime++;
        m.turnaround += Math.max(0, diffDays(r.assignedAt.slice(0, 10), r.completedAt.slice(0, 10)));
      } else if (r.status !== 'DONE') {
        m.open++;
        if (r.dueDate && r.dueDate < today) { m.overdueOpen++; m.overdueDays += diffDays(r.dueDate, today); }
      }
      by.set(r.pid, m);
    }
    // Subtasks can be assigned to someone independently of the parent task's delegate — they count towards that person too.
    const sw = ['s.archived_at IS NULL', 't.archived_at IS NULL', 's.assignee_id IS NOT NULL']; const sp: any[] = [];
    if (q.companyId) { sw.push('t.company_id = ?'); sp.push(q.companyId); } else if (ids) { sw.push(`t.company_id IN (${inClause(ids)})`); sp.push(...ids); }
    { const g = taskGuard(req.user!, 't'); sw.push(g.sql); sp.push(...g.params); }
    if (q.days > 0) { sw.push('s.created_at >= ?'); sp.push(new Date(Date.now() - q.days * 864e5).toISOString()); }
    const subRows = await db.all<any>(`SELECT s.assignee_id AS pid, p.name, p.designation, pc.name AS person_company, s.status, s.due_date, s.completed_at
      FROM subtasks s JOIN tasks t ON t.id = s.task_id JOIN people p ON p.id = s.assignee_id LEFT JOIN companies pc ON pc.id = p.company_id WHERE ${sw.join(' AND ')}`, sp);
    for (const r of subRows) {
      const m = by.get(r.pid) ?? { personId: r.pid, name: r.name, designation: r.designation, company: r.personCompany ?? 'Shared', assigned: 0, completed: 0, onTime: 0, late: 0, open: 0, overdueOpen: 0,
        delayDays: 0, maxDelayDays: 0, overdueDays: 0, postponements: 0, turnaround: 0, subAssigned: 0, subDone: 0, subLate: 0, subOverdue: 0 };
      m.subAssigned++;
      if (r.status === 'DONE') { m.subDone++; if (r.dueDate && r.completedAt && diffDays(r.dueDate, r.completedAt.slice(0, 10)) > 0) m.subLate++; }
      else if (r.dueDate && r.dueDate < today) m.subOverdue++;
      by.set(r.pid, m);
    }
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const items = [...by.values()].map((m) => ({
      personId: m.personId, name: m.name, designation: m.designation, company: m.company,
      assigned: m.assigned, completed: m.completed, open: m.open, onTime: m.onTime, late: m.late, overdueOpen: m.overdueOpen,
      totalDelayDays: m.delayDays, avgDelayDays: m.late ? r1(m.delayDays / m.late) : 0, maxDelayDays: m.maxDelayDays, openOverdueDays: m.overdueDays,
      postponements: m.postponements, avgTurnaroundDays: m.completed ? r1(m.turnaround / m.completed) : null,
      subAssigned: m.subAssigned, subDone: m.subDone, subLate: m.subLate, subOverdueNow: m.subOverdue,
      completionRate: m.assigned ? Math.round((m.completed / m.assigned) * 100) : 0, onTimeRate: m.completed ? Math.round((m.onTime / m.completed) * 100) : null,
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { today, items };
  });

  // ───── Everything involving one person: tasks delegated, subtasks assigned, pending discussions & calls/mails ─────
  app.get('/people/:id/workload', async (req) => {
    const { id } = req.params as { id: string };
    const person = await db.get<any>('SELECT * FROM people WHERE id = ?', [id]);
    if (!person) throw notFound();
    if (person.companyId) await need(db, req.user!, person.companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, req.user!);
    const sc = (col: string) => ids ? { sql: ` AND ${col} IN (${inClause(ids)})`, p: [...ids] } : { sql: '', p: [] as any[] };
    const a = sc('t.company_id'); { const g = taskGuard(req.user!, 't'); a.sql += ` AND ${g.sql}`; a.p.push(...g.params); }
    const tasks = await db.all(`SELECT t.id, t.title, t.priority, t.status, t.due_date, c.name AS company_name FROM tasks t JOIN companies c ON c.id = t.company_id
      WHERE t.delegated_to_id = ? AND t.archived_at IS NULL AND t.status <> 'DONE'${a.sql} ORDER BY (t.due_date IS NULL), t.due_date`, [id, ...a.p]);
    const subtasks = await db.all(`SELECT s.id, s.title, s.due_date, s.priority, s.status, t.id AS task_id, t.title AS task_title, c.name AS company_name FROM subtasks s JOIN tasks t ON t.id = s.task_id JOIN companies c ON c.id = t.company_id
      WHERE s.assignee_id = ? AND s.archived_at IS NULL AND s.status <> 'DONE' AND t.archived_at IS NULL AND t.status <> 'DONE'${a.sql} ORDER BY (s.due_date IS NULL), s.due_date`, [id, ...a.p]);
    const discussions = await db.all(`SELECT d.id, d.topic, d.kind, d.due_date, t.id AS task_id, t.title AS task_title FROM discussions d JOIN tasks t ON t.id = d.task_id
      WHERE d.person_id = ? AND d.archived_at IS NULL AND d.done_at IS NULL AND t.archived_at IS NULL${a.sql}`, [id, ...a.p]);
    const communications = await db.all(`SELECT k.id, k.channel, k.note, k.due_date, t.id AS task_id, t.title AS task_title FROM calls k JOIN tasks t ON t.id = k.task_id
      WHERE k.person_id = ? AND k.archived_at IS NULL AND k.done_at IS NULL AND t.archived_at IS NULL${a.sql}`, [id, ...a.p]);
    return { person, tasks, subtasks, discussions, communications };
  });
}
