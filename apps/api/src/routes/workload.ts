import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serverToday } from '../lib/dates.ts';
import { accessibleCompanyIds, inClause, taskGuard } from '../lib/permissions.ts';

/** People tab: for each person, everything still pending with them — tasks they own or were given, and subtasks assigned to them. Only what the viewer is allowed to see. */
export default async function workloadRoutes(app: FastifyInstance) {
  const { db } = app;
  app.get('/workload', async (req) => {
    const u = req.user!; const q = z.object({ companyId: z.string().optional(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    const today = q.today ?? serverToday(); const ids = await accessibleCompanyIds(db, u);
    const g = taskGuard(u, 't'); const where = ["t.archived_at IS NULL", "t.status <> 'DONE'", g.sql]; const params: any[] = [...g.params];
    if (q.companyId) { where.push('t.company_id = ?'); params.push(q.companyId); } else if (ids) { where.push(`t.company_id IN (${inClause(ids)})`); params.push(...ids); }
    // tasks → the person responsible: the delegate, else the owner's linked person
    const tasks = await db.all<any>(`SELECT t.id, t.title, t.priority, t.status, t.due_date, t.company_id, c.name AS company_name, COALESCE(t.delegated_to_id, ow.person_id) AS pid, ow.name AS owner_name
      FROM tasks t JOIN companies c ON c.id = t.company_id JOIN users ow ON ow.id = t.owner_id WHERE ${where.join(' AND ')} ORDER BY t.due_date IS NULL, t.due_date, t.priority LIMIT 3000`, params);
    const subs = await db.all<any>(`SELECT s.id, s.title, s.due_date, s.assignee_id AS pid, t.id AS task_id, t.title AS task_title, t.company_id, c.name AS company_name
      FROM subtasks s JOIN tasks t ON t.id = s.task_id JOIN companies c ON c.id = t.company_id WHERE s.archived_at IS NULL AND s.status <> 'DONE' AND s.assignee_id IS NOT NULL AND ${where.join(' AND ')} ORDER BY s.due_date IS NULL, s.due_date LIMIT 3000`, params);
    const fus = await db.all<any>(`SELECT f.id, f.task_id, f.subtask_id, substr(f.due_at,1,10) AS due_date, f.person_id AS pid, f.type, t.title AS task_title, t.company_id, c.name AS company_name FROM followups f JOIN tasks t ON t.id = f.task_id JOIN companies c ON c.id = t.company_id WHERE f.archived_at IS NULL AND f.done_at IS NULL AND f.person_id IS NOT NULL AND ${where.join(' AND ')}`, params);
    const people = await db.all<any>(`SELECT p.id, p.name, p.designation, p.email, p.phone, p.company_id, c.name AS company_name, (SELECT u.name FROM users u WHERE u.person_id = p.id) AS user_name
      FROM people p LEFT JOIN companies c ON c.id = p.company_id WHERE p.archived_at IS NULL`);
    const by = new Map<string, any>();
    const get = (pid: string) => { let r = by.get(pid); if (!r) { const p = people.find((x) => x.id === pid); if (!p) return null; r = { personId: pid, name: p.name, designation: p.designation, companyName: p.companyName, isTeam: !!p.userName, phone: p.phone ?? null, email: p.email ?? null, tasks: [], subtasks: [], followups: 0, followupItems: [] }; by.set(pid, r); } return r; };
    for (const t of tasks) { if (!t.pid) continue; get(t.pid)?.tasks.push({ id: t.id, title: t.title, priority: t.priority, status: t.status, dueDate: t.dueDate, companyName: t.companyName, companyId: t.companyId, overdue: !!t.dueDate && t.dueDate < today }); }
    for (const s of subs) get(s.pid)?.subtasks.push({ id: s.id, title: s.title, taskId: s.taskId, taskTitle: s.taskTitle, dueDate: s.dueDate, companyName: s.companyName, companyId: s.companyId, overdue: !!s.dueDate && s.dueDate < today });
    for (const f of fus) { const r = get(f.pid); if (r) { r.followups++; r.followupItems.push({ id: f.id, taskId: f.taskId, subtaskId: f.subtaskId, taskTitle: f.taskTitle, type: f.type, dueDate: f.dueDate, companyId: f.companyId, companyName: f.companyName, overdue: !!f.dueDate && f.dueDate < today }); } }
    const items = [...by.values()].map((r) => ({ ...r, openTasks: r.tasks.length, openSubtasks: r.subtasks.length, overdue: r.tasks.filter((x: any) => x.overdue).length + r.subtasks.filter((x: any) => x.overdue).length,
      tasks: r.tasks.slice(0, 100), subtasks: r.subtasks.slice(0, 100) })).sort((a, b) => b.overdue - a.overdue || (b.openTasks + b.openSubtasks) - (a.openTasks + a.openSubtasks) || a.name.localeCompare(b.name));
    return { today, items };
  });
}
