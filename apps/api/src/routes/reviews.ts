import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { analysedOpenTasks } from './dashboard.ts';
import { addDays, serverToday } from '../lib/dates.ts';
import { accessibleCompanyIds, inClause, need, taskGuard } from '../lib/permissions.ts';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PROGRESS = `COALESCE(t.progress_override, CASE WHEN t.status = 'DONE' THEN 100 ELSE (SELECT CAST(AVG(CASE WHEN s.status = 'DONE' THEN 100 ELSE s.progress END) AS INTEGER) FROM subtasks s WHERE s.task_id = t.id AND s.archived_at IS NULL) END, 0)`;

export default async function reviewRoutes(app: FastifyInstance) {
  const { db } = app;
  const base = z.object({ today: dateStr.optional(), companyId: z.string().optional() });

  async function scope(user: any, companyId?: string, col = 't.company_id') {
    if (companyId) await need(db, user, companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, user);
    const base = companyId ? { sql: ` AND ${col} = ?`, p: [companyId] } : ids ? { sql: ` AND ${col} IN (${inClause(ids)})`, p: [...ids] } : { sql: '', p: [] as any[] };
    if (user.scoped.length) {   // team members: only their own tasks / own comments / own activity
      if (col === 't.company_id') { const g = taskGuard(user, 't'); base.sql += ` AND ${g.sql}`; base.p.push(...g.params); }
      else { const a = col.split('.')[0]; base.sql += ` AND (${col} NOT IN (${inClause(user.scoped)}) OR ${a}.${a === 'c' ? 'author_id' : 'user_id'} = ?)`; base.p.push(...user.scoped, user.id); }
    }
    return base;
  }

  // End-of-day review: what got done, what slipped, what tomorrow looks like.
  app.get('/reviews/daily', async (req) => {
    const q = base.extend({ dayStart: z.string().datetime().optional() }).parse(req.query); const today = q.today ?? serverToday();
    const dayStart = q.dayStart ?? `${today}T00:00:00.000Z`; const c = await scope(req.user!, q.companyId);
    const { items } = await analysedOpenTasks(db, req.user!, { today, companyId: q.companyId });
    const completed = await db.all<any>(`SELECT t.id, t.title, t.priority, t.completed_at, t.completion_note, co.name AS company_name FROM tasks t JOIN companies co ON co.id = t.company_id
      WHERE t.archived_at IS NULL AND t.status = 'DONE' AND t.completed_at >= ?${c.sql} ORDER BY t.completed_at DESC`, [dayStart, ...c.p]);
    const focus = (await db.get<any>('SELECT COUNT(*) n, COALESCE(SUM(actual_minutes),0) m FROM focus_sessions WHERE user_id = ? AND ended_at IS NOT NULL AND archived_at IS NULL AND started_at >= ?', [req.user!.id, dayStart]))!;
    const notes = (await db.get<any>(`SELECT COUNT(*) n FROM comments c WHERE c.archived_at IS NULL AND c.created_at >= ?${(await scope(req.user!, q.companyId, 'c.company_id')).sql}`, [dayStart, ...(await scope(req.user!, q.companyId, 'c.company_id')).p]))!;
    const slim = (x: any) => ({ id: x.id, title: x.title, priority: x.priority, dueDate: x.dueDate, company: x.companyName, person: x.delegatedToName, reasons: x.a.reasons.map((r: any) => r.text) });
    const tomorrow = addDays(today, 1);
    const sorted = [...items].sort((a, b) => b.a.score - a.a.score);
    return { today, completed, focus: { sessions: focus.n, minutes: focus.m }, notesAdded: notes.n,
      stillDueToday: sorted.filter((x) => x.dueDate === today).map(slim), overdue: sorted.filter((x) => x.a.overdueDays > 0).map(slim),
      tomorrow: sorted.filter((x) => x.dueDate === tomorrow).map(slim), followUpsDue: sorted.filter((x) => x.a.followUpDue).map(slim),
      suggestedFirstFocus: sorted[0] ? { id: sorted[0].id, title: sorted[0].title, reasons: sorted[0].a.reasons.map((r: any) => r.text) } : null };
  });

  // Weekly review: throughput, slippage and where the time went.
  app.get('/reviews/weekly', async (req) => {
    const q = base.extend({ weekStart: z.string().datetime().optional(), tzOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query); const today = q.today ?? serverToday();
    const weekStart = q.weekStart ?? `${addDays(today, -6)}T00:00:00.000Z`; const c = await scope(req.user!, q.companyId);
    const { items, th } = await analysedOpenTasks(db, req.user!, { today, companyId: q.companyId });
    const completed = await db.all<any>(`SELECT t.id, t.title, t.priority, t.completed_at, t.project_id, p.name AS project_name, co.name AS company_name FROM tasks t JOIN companies co ON co.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.archived_at IS NULL AND t.status = 'DONE' AND t.completed_at >= ?${c.sql} ORDER BY t.completed_at DESC`, [weekStart, ...c.p]);
    const created = (await db.get<any>(`SELECT COUNT(*) n FROM tasks t WHERE t.archived_at IS NULL AND t.created_at >= ?${c.sql}`, [weekStart, ...c.p]))!.n;
    const postponed = (await db.get<any>(`SELECT COUNT(*) n FROM activity_log a WHERE a.action = 'POSTPONED' AND a.created_at >= ?${(await scope(req.user!, q.companyId, 'a.company_id')).sql}`, [weekStart, ...(await scope(req.user!, q.companyId, 'a.company_id')).p]))!.n;
    const sessions = await db.all<any>('SELECT started_at, actual_minutes FROM focus_sessions WHERE user_id = ? AND ended_at IS NOT NULL AND archived_at IS NULL AND started_at >= ?', [req.user!.id, weekStart]);
    const byDay: Record<string, number> = {};   // bucketed in the user's local day
    for (const s of sessions) { const d = new Date(new Date(s.startedAt).getTime() - q.tzOffsetMinutes * 60000).toISOString().slice(0, 10); byDay[d] = (byDay[d] ?? 0) + s.actualMinutes; }
    const projects = new Map<string, number>(); for (const t of completed) { const k = t.projectName ?? '(No project)'; projects.set(k, (projects.get(k) ?? 0) + 1); }
    const slim = (x: any) => ({ id: x.id, title: x.title, priority: x.priority, dueDate: x.dueDate, company: x.companyName, person: x.delegatedToName, reasons: x.a.reasons.map((r: any) => r.text) });
    return { today, weekStart, completed, completedCount: completed.length, created, postponed, focusMinutes: sessions.reduce((a, s) => a + s.actualMinutes, 0), focusByDay: byDay,
      topProjects: [...projects.entries()].map(([project, n]) => ({ project, completed: n })).sort((a, b) => b.completed - a.completed).slice(0, 5),
      overdueNow: items.filter((x) => x.a.overdueDays > 0).map(slim), delegatedNoUpdate: items.filter((x) => x.delegatedToId && x.a.staleDays >= th.stale).map(slim), atRisk: items.filter((x) => x.a.risk).map(slim) };
  });

  // Management / Review Mode table with totals.
  app.get('/reviews/management', async (req) => {
    const q = base.extend({ projectId: z.string().optional() }).parse(req.query); const today = q.today ?? serverToday(); const c = await scope(req.user!, q.companyId);
    const rows = await db.all<any>(`SELECT t.id, co.name AS company, p.name AS project, t.title AS task, COALESCE(d.name, u.name) AS person, (t.delegated_to_id IS NOT NULL) AS delegated, t.due_date, t.status, ${PROGRESS} AS progress,
        substr(t.last_activity_at, 1, 10) AS last_update, t.next_followup_date, t.priority
      FROM tasks t JOIN companies co ON co.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN people d ON d.id = t.delegated_to_id JOIN users u ON u.id = t.owner_id
      WHERE t.archived_at IS NULL AND t.status <> 'DONE'${c.sql}${q.projectId ? ' AND t.project_id = ?' : ''} ORDER BY co.name, p.name, (t.due_date IS NULL), t.due_date LIMIT 3000`, [...c.p, ...(q.projectId ? [q.projectId] : [])]);
    return { today, rows, totals: { tasks: rows.length, overdue: rows.filter((r) => r.dueDate && r.dueDate < today).length, delegated: rows.filter((r) => r.delegated).length,
      waiting: rows.filter((r) => r.status === 'WAITING').length, avgProgress: rows.length ? Math.round(rows.reduce((a, r) => a + r.progress, 0) / rows.length) : 0 } };
  });
}
