import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../lib/db.ts';
import { nowIso } from '../lib/db.ts';
import { insertRow, setArchived, updateRow } from '../lib/crud.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { need, needTask, projectGuard, taskGuard, type AuthUser } from '../lib/permissions.ts';

const DEFAULT_LISTS = [['Backlog', 'BACKLOG'], ['To do', 'TODO'], ['In progress', 'DOING'], ['Waiting', 'WAITING'], ['Delegated', 'DELEGATED'], ['Done', 'DONE']] as const;
const STATUS = ['BACKLOG', 'TODO', 'DOING', 'WAITING', 'DELEGATED', 'DONE'] as const;

/** Trello-style boards. One board per project (or per company for tasks without a project). Lists are yours to rename, add and reorder. */
export default async function boardRoutes(app: FastifyInstance) {
  const { db } = app;
  const me = (req: any) => req.user as AuthUser;

  async function scopeCheck(u: AuthUser, companyId: string, projectId: string | null, min: 'VIEWER' | 'USER') {
    await need(db, u, companyId, min);
    if (projectId) {
      const p = await db.get<any>('SELECT id, company_id FROM projects WHERE id = ? AND archived_at IS NULL', [projectId]);
      if (!p || p.companyId !== companyId) throw notFound();
      const g = projectGuard(u, 'p'); if (!(await db.get(`SELECT 1 FROM projects p WHERE p.id = ? AND ${g.sql}`, [projectId, ...g.params]))) throw notFound();
    }
  }
  /** First visit to a board creates the usual columns, so nothing is ever empty. */
  async function ensureLists(d: Db, u: AuthUser, companyId: string, projectId: string | null) {
    const have = await d.get<any>('SELECT COUNT(*) n FROM board_lists WHERE company_id = ? AND project_id IS ? AND archived_at IS NULL', [companyId, projectId]);
    if (have.n) return;
    let pos = 1;
    for (const [name, st] of DEFAULT_LISTS) await insertRow(d, 'board_lists', { companyId, projectId, name, position: pos++, mapsToStatus: st }, u.id);
  }

  /** Cards that have never been placed by hand sit in the list matching their status; make that explicit so they can be ordered. */
  async function normalise(d: Db, companyId: string, projectId: string | null) {
    const lists = await d.all<any>('SELECT id, maps_to_status FROM board_lists WHERE company_id = ? AND project_id IS ? AND archived_at IS NULL ORDER BY position', [companyId, projectId]);
    if (!lists.length) return;
    const ids = new Set(lists.map((l) => l.id)); const byStatus = new Map(lists.filter((l) => l.mapsToStatus).map((l) => [l.mapsToStatus, l.id] as const));
    const tasks = await d.all<any>('SELECT id, status, board_list_id, board_pos FROM tasks WHERE company_id = ? AND project_id IS ? AND archived_at IS NULL ORDER BY board_pos, created_at, id', [companyId, projectId]);
    const next = new Map<string, number>();
    for (const t of tasks) {
      const lid = t.boardListId && ids.has(t.boardListId) ? t.boardListId : (byStatus.get(t.status) ?? lists[0].id);
      const pos = (next.get(lid) ?? 0) + 1; next.set(lid, pos);
      if (lid !== t.boardListId || t.boardPos !== pos) await d.run('UPDATE tasks SET board_list_id = ?, board_pos = ? WHERE id = ?', [lid, pos, t.id]);
    }
  }

  app.get('/boards', async (req) => {
    const u = me(req); const q = z.object({ companyId: z.string(), projectId: z.string().optional(), mine: z.enum(['true']).optional(), showDoneDays: z.coerce.number().int().min(0).max(365).default(14) }).parse(req.query);
    const projectId = q.projectId && q.projectId !== 'none' ? q.projectId : null;
    await scopeCheck(u, q.companyId, projectId, 'VIEWER');
    await db.tx((t) => ensureLists(t, u, q.companyId, projectId));
    const lists = await db.all<any>('SELECT * FROM board_lists WHERE company_id = ? AND project_id IS ? AND archived_at IS NULL ORDER BY position, created_at', [q.companyId, projectId]);
    const g = taskGuard(u, 't'); const where = ['t.archived_at IS NULL', 't.company_id = ?', g.sql]; const params: any[] = [q.companyId, ...g.params];
    where.push(projectId ? 't.project_id = ?' : 't.project_id IS NULL'); if (projectId) params.push(projectId);
    const since = new Date(Date.now() - q.showDoneDays * 864e5).toISOString();
    where.push("(t.status <> 'DONE' OR t.completed_at >= ?)"); params.push(since);
    if (q.mine) { where.push('(t.owner_id = ? OR t.delegated_to_id = (SELECT person_id FROM users WHERE id = ?))'); params.push(u.id, u.id); }
    const cards = await db.all<any>(`SELECT t.id, t.title, t.priority, t.status, t.due_date, t.board_list_id, t.board_pos, t.updated_at, t.owner_id, ow.name AS owner_name, d.name AS delegated_to_name, t.delegated_to_id,
        (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.archived_at IS NULL) AS subtask_count,
        (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.archived_at IS NULL AND s.status = 'DONE') AS subtask_done,
        (SELECT COUNT(*) FROM calls k WHERE k.task_id = t.id AND k.archived_at IS NULL AND k.done_at IS NULL) AS pending_calls,
        (SELECT COUNT(*) FROM comments c WHERE c.entity_type = 'TASK' AND c.entity_id = t.id AND c.archived_at IS NULL) AS comment_count,
        (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id AND a.archived_at IS NULL) AS file_count
      FROM tasks t JOIN users ow ON ow.id = t.owner_id LEFT JOIN people d ON d.id = t.delegated_to_id WHERE ${where.join(' AND ')} ORDER BY t.board_pos, t.created_at LIMIT 1000`, params);
    const ids = new Set(lists.map((l) => l.id)); const byStatus = new Map(lists.filter((l) => l.mapsToStatus).map((l) => [l.mapsToStatus, l.id] as const));
    const out = lists.map((l) => ({ ...l, cards: [] as any[] }));
    for (const c of cards) {
      const lid = (c.boardListId && ids.has(c.boardListId)) ? c.boardListId : (byStatus.get(c.status) ?? lists[0]?.id);
      const target = out.find((l) => l.id === lid); if (target) target.cards.push({ ...c, boardListId: lid });
    }
    return { companyId: q.companyId, projectId, lists: out };
  });

  const listBody = z.object({ name: z.string().trim().min(1).max(80), mapsToStatus: z.enum(STATUS).nullable().optional() });
  app.post('/boards/lists', async (req, reply) => {
    const u = me(req); const b = listBody.extend({ companyId: z.string(), projectId: z.string().nullable().optional() }).parse(req.body);
    await scopeCheck(u, b.companyId, b.projectId ?? null, 'USER');
    const max = (await db.get<any>('SELECT COALESCE(MAX(position), 0) m FROM board_lists WHERE company_id = ? AND project_id IS ? AND archived_at IS NULL', [b.companyId, b.projectId ?? null]))!.m;
    const id = await insertRow(db, 'board_lists', { companyId: b.companyId, projectId: b.projectId ?? null, name: b.name, mapsToStatus: b.mapsToStatus ?? null, position: max + 1, ownerId: u.id }, u.id);
    return reply.code(201).send(await db.get('SELECT * FROM board_lists WHERE id = ?', [id]));
  });
  const loadList = async (u: AuthUser, id: string) => { const l = await db.get<any>('SELECT * FROM board_lists WHERE id = ?', [id]); if (!l) throw notFound(); await scopeCheck(u, l.companyId, l.projectId, 'USER'); return l; };
  app.patch('/boards/lists/:id', async (req) => {
    const u = me(req); const l = await loadList(u, (req.params as any).id);
    const b = listBody.partial().extend({ expectedUpdatedAt: z.string(), position: z.number().optional() }).parse(req.body); const { expectedUpdatedAt, ...patch } = b;
    return updateRow(db, 'board_lists', l.id, patch, expectedUpdatedAt, u.id);
  });
  app.post('/boards/lists/:id/archive', async (req) => {
    const u = me(req); const l = await loadList(u, (req.params as any).id);
    const left = (await db.get<any>('SELECT COUNT(*) n FROM board_lists WHERE company_id = ? AND project_id IS ? AND archived_at IS NULL', [l.companyId, l.projectId]))!.n;
    if (left <= 1) throw badRequest('A board needs at least one list');
    return setArchived(db, 'board_lists', l.id, true, u.id);   // cards fall back to the list matching their status
  });

  // Move a card: new list and place. Changing the task's status (when the list means one) is a normal task update done by the page, so every task rule still applies.
  app.post('/boards/move', async (req) => {
    const u = me(req); const b = z.object({ taskId: z.string(), listId: z.string(), beforeTaskId: z.string().nullable().optional() }).parse(req.body);
    const t = await db.get<any>('SELECT id, company_id, project_id FROM tasks WHERE id = ?', [b.taskId]); if (!t) throw notFound();
    await needTask(db, u, t, 'USER');
    const l = await db.get<any>('SELECT * FROM board_lists WHERE id = ? AND archived_at IS NULL', [b.listId]); if (!l || l.companyId !== t.companyId || (l.projectId ?? null) !== (t.projectId ?? null)) throw badRequest('That list belongs to a different board');
    await db.tx((d) => normalise(d, t.companyId, t.projectId ?? null));
    const sib = await db.all<any>('SELECT id, board_pos FROM tasks WHERE board_list_id = ? AND archived_at IS NULL AND id <> ? ORDER BY board_pos', [l.id, t.id]);
    let pos: number;
    const idx = b.beforeTaskId ? sib.findIndex((s) => s.id === b.beforeTaskId) : -1;
    if (idx < 0) pos = (sib.at(-1)?.boardPos ?? 0) + 1;
    else pos = idx === 0 ? sib[0].boardPos - 1 : (sib[idx - 1].boardPos + sib[idx].boardPos) / 2;
    await db.run('UPDATE tasks SET board_list_id = ?, board_pos = ? WHERE id = ?', [l.id, pos, t.id]);   // placement only: does not touch updated_at, so it never clashes with an edit
    return { ok: true, listId: l.id, mapsToStatus: l.mapsToStatus, boardPos: pos, now: nowIso() };
  });
}
