import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso } from '../lib/db.ts';
import { insertRow, optText, setArchived, updateRow } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { HttpError, badRequest, notFound } from '../lib/errors.ts';
import { need, needRow, needTask, rowGuard, taskGuard } from '../lib/permissions.ts';

const SESSION = `f.*, t.title AS task_title, s.title AS subtask_title, u.name AS user_name`;
const FROM = `focus_sessions f JOIN tasks t ON t.id = f.task_id LEFT JOIN subtasks s ON s.id = f.subtask_id JOIN users u ON u.id = f.user_id`;

export default async function focusRoutes(app: FastifyInstance) {
  const { db } = app;
  const one = async (id: string) => (await db.get<any>(`SELECT ${SESSION} FROM ${FROM} WHERE f.id = ?`, [id]))!;
  const openOf = (userId: string) => db.get<any>(`SELECT ${SESSION} FROM ${FROM} WHERE f.user_id = ? AND f.ended_at IS NULL AND f.archived_at IS NULL ORDER BY f.started_at DESC LIMIT 1`, [userId]);

  // Start a Pomodoro on a task or one of its subtasks. One running session per user.
  app.post('/focus/sessions', async (req, reply) => {
    const b = z.object({ taskId: z.string(), subtaskId: z.string().nullable().optional(), plannedMinutes: z.number().int().min(1).max(180) }).parse(req.body);
    const task = await db.get<any>('SELECT id, company_id, status, archived_at FROM tasks WHERE id = ?', [b.taskId]); if (!task) throw notFound();
    await needTask(db, req.user!, task, 'USER');
    if (task.archivedAt) throw badRequest('Restore this task before focusing on it');
    if (b.subtaskId && !(await db.get('SELECT 1 FROM subtasks WHERE id = ? AND task_id = ? AND archived_at IS NULL', [b.subtaskId, b.taskId]))) throw badRequest('That subtask does not belong to this task');
    const active = await openOf(req.user!.id);
    if (active) throw new HttpError(409, 'ACTIVE_SESSION', 'You already have a focus session running', { session: active });
    const n = (await db.get<any>('SELECT COUNT(*) n FROM focus_sessions WHERE user_id = ? AND task_id = ? AND archived_at IS NULL', [req.user!.id, b.taskId]))!.n + 1;
    const id = await insertRow(db, 'focus_sessions', { userId: req.user!.id, taskId: b.taskId, subtaskId: b.subtaskId ?? null, companyId: task.companyId, startedAt: nowIso(), plannedMinutes: b.plannedMinutes, actualMinutes: 0, completed: false, sessionNumber: n }, req.user!.id);
    return reply.code(201).send(await one(id));
  });

  app.get('/focus/active', async (req) => ({ session: (await openOf(req.user!.id)) ?? null }));

  // Finish: completed=true when the timer ran out, false when stopped early (interrupted). Minutes feed the task/subtask totals.
  app.post('/focus/sessions/:id/finish', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ actualMinutes: z.number().int().min(0).max(600), completed: z.boolean(), note: optText(2000) }).parse(req.body);
    const cur = await db.get<any>('SELECT * FROM focus_sessions WHERE id = ? AND user_id = ? AND archived_at IS NULL', [id, req.user!.id]); if (!cur) throw notFound();
    if (cur.endedAt) throw new HttpError(409, 'ALREADY_FINISHED', 'This session is already finished');
    const wall = Math.ceil((Date.now() - new Date(cur.startedAt).getTime()) / 60000);
    const minutes = Math.min(b.actualMinutes, wall + 1); // cannot claim more time than actually passed
    await db.tx(async (t) => {
      await updateRow(t, 'focus_sessions', id, { endedAt: nowIso(), actualMinutes: minutes, completed: b.completed, note: b.note ?? null }, cur.updatedAt, req.user!.id);
      await t.run('UPDATE tasks SET focus_minutes = focus_minutes + ?, last_activity_at = ? WHERE id = ?', [minutes, nowIso(), cur.taskId]);
      if (cur.subtaskId) await t.run('UPDATE subtasks SET focus_minutes = focus_minutes + ? WHERE id = ?', [minutes, cur.subtaskId]);
      await audit(t, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.taskId, action: 'FOCUS_SESSION', detail: { minutes, completed: b.completed, note: b.note ?? null, subtaskId: cur.subtaskId }, userId: req.user!.id });
    });
    return one(id);
  });

  app.post('/focus/sessions/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const cur = await db.get<any>('SELECT * FROM focus_sessions WHERE id = ? AND user_id = ? AND ended_at IS NULL AND archived_at IS NULL', [id, req.user!.id]); if (!cur) throw notFound();
    await db.tx(async (t) => { await updateRow(t, 'focus_sessions', id, { endedAt: nowIso() }, cur.updatedAt, req.user!.id); await setArchived(t, 'focus_sessions', id, true, req.user!.id); });
    return { ok: true };
  });

  app.get('/tasks/:id/focus', async (req) => {
    const { id } = req.params as { id: string };
    const t = await db.get<any>('SELECT id, company_id, focus_minutes FROM tasks WHERE id = ?', [id]); if (!t) throw notFound();
    await needTask(db, req.user!, t, 'VIEWER');
    const sessions = await db.all(`SELECT ${SESSION} FROM ${FROM} WHERE f.task_id = ? AND f.ended_at IS NOT NULL AND f.archived_at IS NULL ORDER BY f.started_at DESC LIMIT 30`, [id]);
    const count = (await db.get<any>('SELECT COUNT(*) n FROM focus_sessions WHERE task_id = ? AND ended_at IS NOT NULL AND archived_at IS NULL', [id]))!.n;
    return { totalMinutes: t.focusMinutes, sessionCount: count, sessions };
  });

  // dayStart / weekStart are ISO instants computed in the browser, so "today" follows the user's own time zone.
  app.get('/focus/stats', async (req) => {
    const q = z.object({ dayStart: z.string().datetime(), weekStart: z.string().datetime() }).parse(req.query);
    const sum = (since: string) => db.get<any>('SELECT COUNT(*) n, COALESCE(SUM(actual_minutes), 0) m FROM focus_sessions WHERE user_id = ? AND ended_at IS NOT NULL AND archived_at IS NULL AND started_at >= ?', [req.user!.id, since]);
    const d = (await sum(q.dayStart))!, w = (await sum(q.weekStart))!;
    return { todaySessions: d.n, todayMinutes: d.m, weekSessions: w.n, weekMinutes: w.m };
  });

  // Focus statistics and history (personal, not competitive): totals, per day, most-focused tasks, recent sessions.
  app.get('/focus/history', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), tzOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query);
    const since = new Date(Date.now() - q.days * 864e5).toISOString();
    const rows = await db.all<any>(`SELECT f.id, f.started_at, f.actual_minutes, f.planned_minutes, f.completed, f.note, f.task_id, t.title AS task_title, s.title AS subtask_title, p.name AS project_name, c.name AS company_name
      FROM focus_sessions f JOIN tasks t ON t.id = f.task_id LEFT JOIN subtasks s ON s.id = f.subtask_id LEFT JOIN projects p ON p.id = t.project_id JOIN companies c ON c.id = f.company_id
      WHERE f.user_id = ? AND f.ended_at IS NOT NULL AND f.archived_at IS NULL AND f.started_at >= ? ORDER BY f.started_at DESC LIMIT 5000`, [req.user!.id, since]);
    const localDay = (iso: string) => new Date(new Date(iso).getTime() - q.tzOffsetMinutes * 60000).toISOString().slice(0, 10);
    const byDay: Record<string, number> = {}; const byTask = new Map<string, any>(); const byProject = new Map<string, number>();
    for (const r of rows) {
      byDay[localDay(r.startedAt)] = (byDay[localDay(r.startedAt)] ?? 0) + r.actualMinutes;
      const t = byTask.get(r.taskId) ?? { taskId: r.taskId, title: r.taskTitle, minutes: 0, sessions: 0 }; t.minutes += r.actualMinutes; t.sessions++; byTask.set(r.taskId, t);
      if (r.projectName) byProject.set(r.projectName, (byProject.get(r.projectName) ?? 0) + r.actualMinutes);
    }
    const total = rows.reduce((a, r) => a + r.actualMinutes, 0); const finished = rows.filter((r) => r.completed).length;
    return { days: q.days, sessions: rows.length, minutes: total, averageMinutes: rows.length ? Math.round(total / rows.length) : 0, completedPomodoros: finished, byDay,
      topTasks: [...byTask.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 8), topProjects: [...byProject.entries()].map(([project, minutes]) => ({ project, minutes })).sort((a, b) => b.minutes - a.minutes).slice(0, 5),
      recent: rows.slice(0, 40) };
  });
}
