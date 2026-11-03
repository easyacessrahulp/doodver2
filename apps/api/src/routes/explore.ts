import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleCompanyIds, inClause, need, projectGuard, taskGuard } from '../lib/permissions.ts';
import { serverToday } from '../lib/dates.ts';

/** Counts for the drill-down screen: Company → Project (→ Task → Subtask, which use the ordinary task endpoints). */
export default async function exploreRoutes(app: FastifyInstance) {
  const { db } = app;
  app.get('/explore', async (req) => {
    const q = z.object({ companyId: z.string().optional(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    const today = q.today ?? serverToday();
    if (!q.companyId) {
      const ids = await accessibleCompanyIds(db, req.user!);
      const w = ids ? ` AND c.id IN (${inClause(ids)})` : '';
      const g = taskGuard(req.user!, 't'), pg = projectGuard(req.user!, 'p');
      const items = await db.all(`SELECT c.id, c.name, c.code,
          (SELECT COUNT(*) FROM projects p WHERE p.company_id = c.id AND p.archived_at IS NULL AND ${pg.sql}) AS projects,
          (SELECT COUNT(*) FROM tasks t WHERE t.company_id = c.id AND t.archived_at IS NULL AND t.status <> 'DONE' AND ${g.sql}) AS open_tasks,
          (SELECT COUNT(*) FROM tasks t WHERE t.company_id = c.id AND t.archived_at IS NULL AND t.status <> 'DONE' AND t.due_date < ? AND ${g.sql}) AS overdue
        FROM companies c WHERE c.archived_at IS NULL${w} ORDER BY c.name`, [...pg.params, ...g.params, today, ...g.params, ...(ids ?? [])]);
      return { level: 'companies', items };
    }
    await need(db, req.user!, q.companyId, 'VIEWER');
    const g = taskGuard(req.user!, 't'), pg = projectGuard(req.user!, 'p'); const T = `t.archived_at IS NULL AND ${g.sql}`;
    const items = await db.all(`SELECT p.id, p.name, p.status, p.priority, p.target_date,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${T} AND t.status <> 'DONE') AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${T} AND t.status <> 'DONE' AND t.due_date < ?) AS overdue,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${T} AND t.status = 'DONE') AS done_tasks
      FROM projects p WHERE p.company_id = ? AND p.archived_at IS NULL AND ${pg.sql} ORDER BY p.name`, [...g.params, today, ...g.params, ...g.params, q.companyId, ...pg.params]);
    const none = await db.get<any>(`SELECT COUNT(*) AS open_tasks, COALESCE(SUM(CASE WHEN t.due_date < ? THEN 1 ELSE 0 END), 0) AS overdue FROM tasks t WHERE t.company_id = ? AND t.project_id IS NULL AND ${T} AND t.status <> 'DONE'`, [today, q.companyId, ...g.params]);
    return { level: 'projects', items, noProject: none };
  });
}
