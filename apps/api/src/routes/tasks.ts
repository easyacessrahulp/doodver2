import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../lib/db.ts';
import { nowIso } from '../lib/db.ts';
import { insertRow, listPage, optDate, optText, pageQuery, prio, setArchived, todayStr, updateRow } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.ts';
import { reconcileFollowupDate } from '../lib/followups.ts';
import { nextDue, addDays, diffDays, serverToday, type Frequency } from '../lib/dates.ts';
import { RANK, accessibleCompanyIds, addParticipants, inClause, need, needRow, needTask, roleFor, taskGuard, userIdOfPerson, type AuthUser } from '../lib/permissions.ts';
import { notify } from '../lib/notify.ts';

const exp = { expectedUpdatedAt: z.string() };
const idParam = (req: any) => (req.params as { id: string }).id;
const STATUS = ['BACKLOG', 'TODO', 'DOING', 'WAITING', 'DELEGATED', 'DONE'] as const;
const intOrNull = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();

const taskFields = {
  companyId: z.string(), projectId: z.string().nullable().optional(), title: z.string().trim().min(1).max(300),
  description: optText(), additionalDetails: optText(), ownerId: z.string().optional(),
  delegatedToId: z.string().nullable().optional(), delegationInstructions: optText(), reviewerId: z.string().nullable().optional(),
  priority: prio, status: z.enum(STATUS), progressOverride: intOrNull(0, 100), dueDate: optDate,
  waitingFor: optText(300), waitingExpectedDate: optDate, nextAction: optText(500), nextFollowupDate: optDate,
  remindDaysBefore: intOrNull(0, 60), dependsOnId: z.string().nullable().optional(), completionNote: optText(),
  aiExcluded: z.boolean().optional(),
  repeat: z.enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']).optional(), repeatEvery: z.number().int().min(1).max(365).optional(),
};
const taskCreate = z.object({ ...taskFields, priority: taskFields.priority.default(3), status: taskFields.status.default('TODO') });
const taskUpdate = z.object({ ...exp, ...taskFields }).partial().required({ expectedUpdatedAt: true });

const TASK_SELECT = `t.*, COALESCE(p.ai_excluded, 0) AS project_ai_excluded, rr.frequency AS repeat, rr.interval_count AS repeat_every, c.name AS company_name, p.name AS project_name, d.name AS delegated_to_name, u.name AS owner_name,
  COALESCE(t.progress_override, CASE WHEN t.status = 'DONE' THEN 100 ELSE
    (SELECT CAST(AVG(CASE WHEN s.status = 'DONE' THEN 100 ELSE s.progress END) AS INTEGER) FROM subtasks s WHERE s.task_id = t.id AND s.archived_at IS NULL) END, 0) AS progress,
  (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.archived_at IS NULL) AS subtask_count,
  (SELECT COUNT(*) FROM subtasks s2 WHERE s2.task_id = t.id AND s2.archived_at IS NULL AND s2.status = 'DONE') AS subtask_done_count,
  (SELECT COUNT(*) FROM calls k WHERE k.task_id = t.id AND k.archived_at IS NULL AND k.done_at IS NULL) AS pending_calls,
  (SELECT COUNT(*) FROM followups fu WHERE fu.task_id = t.id AND fu.archived_at IS NULL AND fu.done_at IS NULL) AS pending_followups,
  (SELECT COUNT(*) FROM discussions di WHERE di.task_id = t.id AND di.archived_at IS NULL AND di.done_at IS NULL) AS pending_discussions,
  CASE WHEN t.depends_on_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks b WHERE b.id = t.depends_on_id AND b.status <> 'DONE' AND b.archived_at IS NULL) THEN 1 ELSE 0 END AS blocked`;
const TASK_FROM = `tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN recurring_rules rr ON rr.id = t.recurring_rule_id LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN people d ON d.id = t.delegated_to_id JOIN users u ON u.id = t.owner_id`;

export default async function taskRoutes(app: FastifyInstance) {
  const { db } = app;
  const loadTask = async (id: string, d: Db = db) => { const t = await d.get<any>('SELECT * FROM tasks WHERE id = ?', [id]); if (!t) throw notFound(); return t; };
  const fullTask = async (id: string, d: Db = db) => (await d.get<any>(`SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ?`, [id]))!;

  async function checkRefs(d: Db, user: AuthUser, companyId: string, data: any, selfId?: string) {
    if (data.projectId) {
      const p = await d.get<any>('SELECT company_id, archived_at FROM projects WHERE id = ?', [data.projectId]);
      if (!p || p.companyId !== companyId || p.archivedAt) throw badRequest('Project must be an active project of the same company');
    }
    // A person from ANY company the signed-in user can access (or a shared person) may be assigned to this task.
    for (const k of ['delegatedToId', 'reviewerId'] as const) if (data[k]) {
      const p = await d.get<any>('SELECT company_id, archived_at FROM people WHERE id = ?', [data[k]]);
      if (!p || p.archivedAt) throw badRequest(`${k === 'delegatedToId' ? 'Delegate' : 'Reviewer'} must be an active person`);
      if (p.companyId && !(await roleFor(d, user, p.companyId))) throw badRequest('You do not have access to that person');
    }
    if (data.ownerId && data.ownerId !== user.id) {
      const o = await d.get<any>('SELECT id, is_admin, active FROM users WHERE id = ?', [data.ownerId]);
      if (!o || !o.active) throw badRequest('Owner must be an active user');
      if (!o.isAdmin && !(await d.get('SELECT 1 FROM company_memberships WHERE user_id = ? AND company_id = ? AND archived_at IS NULL', [data.ownerId, companyId]))) throw badRequest('Owner has no access to this company');
    }
    if (data.dependsOnId) {
      if (data.dependsOnId === selfId) throw badRequest('A task cannot depend on itself');
      let cursor: string | null = data.dependsOnId; let first = true;
      while (cursor) {
        const t: any = await d.get('SELECT company_id, depends_on_id FROM tasks WHERE id = ?', [cursor]);
        if (!t || (first && t.companyId !== companyId)) throw badRequest('Dependency must be a task in the same company');
        first = false;
        if (selfId && t.dependsOnId === selfId) throw badRequest('This dependency would create a cycle');
        cursor = t.dependsOnId;
      }
    }
  }

  async function isBlocked(d: Db, task: any) {
    if (!task.dependsOnId) return null;
    return (await d.get<any>("SELECT id, title FROM tasks WHERE id = ? AND status <> 'DONE' AND archived_at IS NULL", [task.dependsOnId])) ?? null;
  }

  /** Create/update/clear the recurrence rule for a task. Returns the value for tasks.recurring_rule_id (undefined = leave as is). */
  async function ruleFor(d: Db, userId: string, companyId: string, curRuleId: string | null, repeat?: string, every?: number) {
    if (repeat === undefined && every === undefined) return undefined;
    if (repeat === 'NONE') return null;
    if (curRuleId) {
      const r = await d.get<any>('SELECT * FROM recurring_rules WHERE id = ?', [curRuleId]);
      if (r && (repeat || every)) await updateRow(d, 'recurring_rules', curRuleId, { ...(repeat ? { frequency: repeat } : {}), ...(every ? { intervalCount: every } : {}) }, r.updatedAt, userId);
      return curRuleId;
    }
    if (!repeat) return undefined;
    return insertRow(d, 'recurring_rules', { companyId, frequency: repeat, intervalCount: every ?? 1, active: true }, userId);
  }

  /** When a recurring task is completed, the next one is created automatically (subtasks copied, reset and date-shifted). */
  async function spawnNext(d: Db, user: AuthUser, cur: any, completedOn: string) {
    const rule = await d.get<any>('SELECT * FROM recurring_rules WHERE id = ? AND active = 1 AND archived_at IS NULL', [cur.recurringRuleId]);
    if (!rule) return null;
    const due = nextDue(cur.dueDate, rule.frequency as Frequency, rule.intervalCount, completedOn);
    const now = nowIso();
    const nid = await insertRow(d, 'tasks', {
      companyId: cur.companyId, projectId: cur.projectId, title: cur.title, description: cur.description, additionalDetails: cur.additionalDetails, ownerId: cur.ownerId,
      delegatedToId: cur.delegatedToId, delegatedAt: cur.delegatedToId ? now : null, delegationInstructions: cur.delegationInstructions, reviewerId: cur.reviewerId,
      priority: cur.priority, status: cur.delegatedToId ? 'DELEGATED' : 'TODO', dueDate: due, remindDaysBefore: cur.remindDaysBefore, recurringRuleId: cur.recurringRuleId, lastActivityAt: now,
    }, user.id);
    const shift = cur.dueDate ? diffDays(cur.dueDate, due) : 0;
    const subs = await d.all<any>('SELECT * FROM subtasks WHERE task_id = ? AND archived_at IS NULL ORDER BY position', [cur.id]);
    for (const s of subs) await insertRow(d, 'subtasks', { taskId: nid, companyId: cur.companyId, title: s.title, description: s.description, assigneeId: s.assigneeId, priority: s.priority, position: s.position,
      dueDate: s.dueDate && shift ? addDays(s.dueDate, shift) : s.dueDate, status: 'TODO', progress: 0 }, user.id);
    await audit(d, { companyId: cur.companyId, entityType: 'TASK', entityId: nid, action: 'CREATED', detail: { title: cur.title, recurringFrom: cur.id }, auto: true, userId: user.id });
    await audit(d, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.id, action: 'RECURRED', detail: { nextTaskId: nid, due }, auto: true, userId: user.id });
    return nid;
  }

  /** Handing work to someone: they (and the person handing over) keep seeing it, and they get a notification. */
  async function onDelegated(d: Db, user: AuthUser, task: any, toPersonId: string) {
    const toUser = await userIdOfPerson(d, toPersonId);
    await addParticipants(d, task.id, [user.id, task.delegatedToId ? await userIdOfPerson(d, task.delegatedToId) : null, toUser], 'delegation', user.id);
    if (toUser && toUser !== user.id) await notify(d, { userId: toUser, companyId: task.companyId, taskId: task.id, kind: 'ASSIGNED', title: `${user.name} gave you a task`, body: task.title, link: `tasks/${task.id}`, actorId: user.id });
  }

  /** Single place where task changes are applied: dependency rule, completion bookkeeping, postponement counting, audit. */
  async function applyTaskPatch(d: Db, user: AuthUser, cur: any, patchIn: Record<string, any>, expected: string, today = serverToday()) {
    const { repeat, repeatEvery, ...patch } = patchIn;
    const ruleId = await ruleFor(d, user.id, cur.companyId, cur.recurringRuleId, repeat, repeatEvery);
    if (ruleId !== undefined) patch.recurringRuleId = ruleId;
    await checkRefs(d, user, cur.companyId, patch, cur.id);
    const diff: Record<string, [unknown, unknown]> = {};
    for (const [k, v] of Object.entries(patch)) if ((v ?? null) !== (cur[k] ?? null)) diff[k] = [cur[k] ?? null, v ?? null];
    if (!Object.keys(diff).length) return fullTask(cur.id, d);
    const data: Record<string, any> = { ...patch, lastActivityAt: nowIso() };
    const now = nowIso(); const events: [string, unknown][] = [];
    if (patch.status === 'DONE' && cur.status !== 'DONE') {
      const blocker = await isBlocked(d, { dependsOnId: patch.dependsOnId === undefined ? cur.dependsOnId : patch.dependsOnId });
      if (blocker) throw new HttpError(409, 'BLOCKED', `Blocked: finish "${blocker.title}" first`, { blockedBy: blocker });
      data.completedAt = now; data.completedById = user.id; events.push(['COMPLETED', patch.completionNote ?? null]);
      if ((patch.recurringRuleId === undefined ? cur.recurringRuleId : patch.recurringRuleId) && !cur.nextOccurrenceCreated) { cur.__spawn = true; data.nextOccurrenceCreated = true; }
    } else if (patch.status && patch.status !== 'DONE' && cur.status === 'DONE') {
      data.completedAt = null; data.completedById = null; events.push(['REOPENED', null]);
    }
    if (patch.dueDate && cur.dueDate && patch.dueDate > cur.dueDate) {
      data.postponeCount = cur.postponeCount + 1; events.push(['POSTPONED', { from: cur.dueDate, to: patch.dueDate }]);
    }
    if ('delegatedToId' in patch && patch.delegatedToId && patch.delegatedToId !== cur.delegatedToId) { data.delegatedAt = now; events.push(['DELEGATED', { to: patch.delegatedToId }]); }
    await updateRow(d, 'tasks', cur.id, data, expected, user.id);
    if ('delegatedToId' in patch && patch.delegatedToId && patch.delegatedToId !== cur.delegatedToId) await onDelegated(d, user, cur, patch.delegatedToId);
    if ('reviewerId' in patch && patch.reviewerId && patch.reviewerId !== cur.reviewerId) await addParticipants(d, cur.id, [await userIdOfPerson(d, patch.reviewerId)], 'reviewer', user.id);
    if ('nextFollowupDate' in patch && (patch.nextFollowupDate ?? null) !== (cur.nextFollowupDate ?? null)) await reconcileFollowupDate(d, user.id, { id: cur.id, companyId: cur.companyId, nextAction: patch.nextAction ?? cur.nextAction }, patch.nextFollowupDate ?? null);
    if (cur.__spawn) { const fresh = await d.get<any>('SELECT * FROM tasks WHERE id = ?', [cur.id]); await spawnNext(d, user, fresh, today); }
    await audit(d, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.id, action: 'UPDATED', detail: diff, userId: user.id });
    for (const [action, detail] of events) await audit(d, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.id, action, detail, userId: user.id });
    if (events.some((e) => e[0] === 'COMPLETED'))
      for (const uid of new Set([cur.ownerId, cur.createdById].filter((x) => x && x !== user.id) as string[]))
        await notify(d, { userId: uid, companyId: cur.companyId, taskId: cur.id, kind: 'COMPLETED', title: `${user.name} completed “${cur.title}”`, body: patch.completionNote ?? undefined, link: `tasks/${cur.id}`, actorId: user.id, groupKey: `done:${cur.id}:${uid}` });
    return fullTask(cur.id, d);
  }

  const listQuery = pageQuery.extend({
    companyId: z.string().optional(), projectId: z.string().optional(), personId: z.string().optional(), involvedId: z.string().optional(),
    priority: z.coerce.number().int().min(1).max(4).optional(), status: z.enum(STATUS).optional(),
    dueFrom: z.string().optional(), dueTo: z.string().optional(),
    overdue: z.enum(['true']).optional(), delegated: z.enum(['true']).optional(), waiting: z.enum(['true']).optional(),
    completed: z.enum(['true', 'false', 'all']).default('false'),
    sort: z.enum(['created', 'due', 'priority', 'person', 'title']).default('created'),
    maxPriority: z.coerce.number().int().min(1).max(4).optional(), doneSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });
  const ORDER: Record<string, string | undefined> = {
    created: undefined,
    due: '(t.due_date IS NULL), t.due_date, t.priority, t.id',
    priority: 't.priority, (t.due_date IS NULL), t.due_date, t.id',
    person: '(d.name IS NULL), LOWER(d.name), (t.due_date IS NULL), t.due_date, t.id',
    title: 'LOWER(t.title), t.id',
  };

  app.get('/tasks', async (req) => {
    const q = listQuery.parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, req.user!);
    const where = [q.archived === 'true' ? 't.archived_at IS NOT NULL' : 't.archived_at IS NULL']; const params: any[] = [];
    if (q.companyId) { where.push('t.company_id = ?'); params.push(q.companyId); }
    else if (ids) { where.push(`t.company_id IN (${inClause(ids)})`); params.push(...ids); }
    { const g = taskGuard(req.user!, 't'); where.push(g.sql); params.push(...g.params); }
    if (q.projectId === 'none') where.push('t.project_id IS NULL');
    else if (q.projectId) { where.push('t.project_id = ?'); params.push(q.projectId); }
    if (q.personId) { where.push('t.delegated_to_id = ?'); params.push(q.personId); }
    if (q.involvedId) { where.push("(t.delegated_to_id = ? OR EXISTS (SELECT 1 FROM subtasks sx WHERE sx.task_id = t.id AND sx.assignee_id = ? AND sx.archived_at IS NULL AND sx.status <> 'DONE'))"); params.push(q.involvedId, q.involvedId); }
    if (q.priority) { where.push('t.priority = ?'); params.push(q.priority); }
    if (q.maxPriority) { where.push('t.priority <= ?'); params.push(q.maxPriority); }
    if (q.doneSince) { where.push('t.completed_at >= ?'); params.push(q.doneSince); }
    if (q.dueOn) { where.push('t.due_date = ?'); params.push(q.dueOn); }
    if (q.status) { where.push('t.status = ?'); params.push(q.status); }
    else if (q.completed === 'false') where.push("t.status <> 'DONE'");
    else if (q.completed === 'true') where.push("t.status = 'DONE'");
    if (q.dueFrom) { where.push('t.due_date >= ?'); params.push(q.dueFrom); }
    if (q.dueTo) { where.push('t.due_date <= ?'); params.push(q.dueTo); }
    if (q.overdue) { where.push("t.due_date < ? AND t.status <> 'DONE'"); params.push(todayStr()); }
    if (q.delegated) where.push("t.delegated_to_id IS NOT NULL AND t.status <> 'DONE'");
    if (q.waiting) where.push("(t.status = 'WAITING' OR t.waiting_for IS NOT NULL) AND t.status <> 'DONE'");
    if (q.q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    return listPage(db, { select: TASK_SELECT, from: TASK_FROM, alias: 't', where, params, limit: q.limit, cursor: q.cursor, order: ORDER[q.sort] });
  });

  app.get('/tasks/:id', async (req) => {
    const t = await loadTask(idParam(req)); await needTask(db, req.user!, t, 'VIEWER'); return fullTask(t.id);
  });

  app.post('/tasks', async (req, reply) => {
    const b = taskCreate.parse(req.body);
    await need(db, req.user!, b.companyId, 'USER');
    const id = await db.tx(async (t) => {
      await checkRefs(t, req.user!, b.companyId, b);
      if (b.status === 'DONE' && b.dependsOnId && (await isBlocked(t, b))) throw new HttpError(409, 'BLOCKED', 'Blocked by an unfinished task');
      const now = nowIso();
      const { repeat, repeatEvery, ...fields } = b;
      const rid = repeat && repeat !== 'NONE' ? await insertRow(t, 'recurring_rules', { companyId: b.companyId, frequency: repeat, intervalCount: repeatEvery ?? 1, active: true }, req.user!.id) : null;
      const tid = await insertRow(t, 'tasks', {
        ...fields, recurringRuleId: rid, ownerId: b.ownerId ?? req.user!.id, lastActivityAt: now,
        ...(b.status === 'DONE' ? { completedAt: now, completedById: req.user!.id } : {}),
        ...(b.delegatedToId ? { delegatedAt: now } : {}),
      }, req.user!.id);
      if (b.nextFollowupDate) await reconcileFollowupDate(t, req.user!.id, { id: tid, companyId: b.companyId, nextAction: b.nextAction }, b.nextFollowupDate);
      if (b.delegatedToId) await onDelegated(t, req.user!, { id: tid, companyId: b.companyId, title: b.title, delegatedToId: null }, b.delegatedToId);
      if (b.reviewerId) await addParticipants(t, tid, [await userIdOfPerson(t, b.reviewerId)], 'reviewer', req.user!.id);
      if (b.ownerId && b.ownerId !== req.user!.id) { await addParticipants(t, tid, [req.user!.id], 'creator', req.user!.id); await notify(t, { userId: b.ownerId, companyId: b.companyId, taskId: tid, kind: 'ASSIGNED', title: `${req.user!.name} made you owner of a task`, body: b.title, link: `tasks/${tid}`, actorId: req.user!.id }); }
      await audit(t, { companyId: b.companyId, entityType: 'TASK', entityId: tid, action: 'CREATED', detail: { title: b.title }, userId: req.user!.id });
      return tid;
    });
    return reply.code(201).send(await fullTask(id));
  });

  app.patch('/tasks/:id', async (req) => {
    const cur = await loadTask(idParam(req)); await needTask(db, req.user!, cur, 'USER');
    const { expectedUpdatedAt, today, ...patch } = taskUpdate.extend({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body);
    if (patch.companyId && patch.companyId !== cur.companyId) throw badRequest('A task cannot be moved to another company');
    return db.tx((t) => applyTaskPatch(t, req.user!, cur, patch, expectedUpdatedAt, today));
  });

  app.post('/tasks/:id/complete', async (req) => {
    const cur = await loadTask(idParam(req)); await needTask(db, req.user!, cur, 'USER');
    const b = z.object({ note: optText(), expectedUpdatedAt: z.string().optional(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
    return db.tx((t) => applyTaskPatch(t, req.user!, cur, { status: 'DONE', completionNote: b.note ?? null }, b.expectedUpdatedAt ?? cur.updatedAt, b.today));
  });
  app.post('/tasks/:id/reopen', async (req) => {
    const cur = await loadTask(idParam(req)); await needTask(db, req.user!, cur, 'USER');
    return db.tx((t) => applyTaskPatch(t, req.user!, cur, { status: 'TODO' }, cur.updatedAt));
  });

  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/tasks/:id/${verb}`, async (req) => {
      const cur = await loadTask(idParam(req));
      const role = await needTask(db, req.user!, cur, 'USER');
      if (RANK[role] < RANK.MANAGER && cur.ownerId !== req.user!.id && cur.createdById !== req.user!.id)
        throw forbidden('You can only archive tasks you own or created');
      const row = await db.tx(async (t) => {
        const r = await setArchived(t, 'tasks', cur.id, on, req.user!.id);
        await audit(t, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.id, action: on ? 'ARCHIVED' : 'RESTORED', userId: req.user!.id });
        return r;
      });
      return fullTask(row.id);
    });

  app.get('/tasks/:id/history', async (req) => {
    const t = await loadTask(idParam(req)); await needTask(db, req.user!, t, 'VIEWER');
    const items = await db.all(
      `SELECT a.*, u.name AS user_name FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE (a.entity_type = 'TASK' AND a.entity_id = ?) OR (a.entity_type = 'SUBTASK' AND a.entity_id IN (SELECT id FROM subtasks WHERE task_id = ?))
       ORDER BY a.created_at DESC, a.id DESC LIMIT 200`, [t.id, t.id]);
    return { items };
  });

  // ───────── Subtasks ─────────
  const subFields = {
    title: z.string().trim().min(1).max(300), description: optText(), assigneeId: z.string().nullable().optional(), dueDate: optDate,
    priority: prio, progress: z.number().int().min(0).max(100), status: z.enum(['TODO', 'DOING', 'DONE']),
    reminderAt: z.string().datetime().nullable().optional(), position: z.number().int().min(0),
  };
  const subCreate = z.object({ ...subFields, priority: subFields.priority.default(3), progress: subFields.progress.default(0), status: subFields.status.default('TODO') }).partial({ position: true });
  const subUpdate = z.object({ ...exp, ...subFields }).partial().required({ expectedUpdatedAt: true });
  const touchTask = (d: Db, taskId: string) => d.run('UPDATE tasks SET last_activity_at = ? WHERE id = ?', [nowIso(), taskId]);

  app.get('/tasks/:id/subtasks', async (req) => {
    const t = await loadTask(idParam(req)); await needTask(db, req.user!, t, 'VIEWER');
    const archived = (req.query as any)?.archived === 'true';
    return { items: await db.all(`SELECT s.*, p.name AS assignee_name FROM subtasks s LEFT JOIN people p ON p.id = s.assignee_id
      WHERE s.task_id = ? AND s.archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY s.position, s.created_at`, [t.id]) };
  });
  app.post('/tasks/:id/subtasks', async (req, reply) => {
    const t = await loadTask(idParam(req)); await needTask(db, req.user!, t, 'USER');
    const b = subCreate.parse(req.body);
    if (b.assigneeId) await checkRefs(db, req.user!, t.companyId, { delegatedToId: b.assigneeId });
    const id = await db.tx(async (d) => {
      const pos = b.position ?? ((await d.get<any>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM subtasks WHERE task_id = ?', [t.id]))!.n);
      const sid = await insertRow(d, 'subtasks', { ...b, position: pos, taskId: t.id, companyId: t.companyId,
        ...(b.status === 'DONE' ? { progress: 100, completedAt: nowIso() } : {}) }, req.user!.id);
      await touchTask(d, t.id);
      await audit(d, { companyId: t.companyId, entityType: 'SUBTASK', entityId: sid, action: 'CREATED', detail: { taskId: t.id, title: b.title }, userId: req.user!.id });
      return sid;
    });
    return reply.code(201).send(await db.get('SELECT * FROM subtasks WHERE id = ?', [id]));
  });
  // Several subtasks at once (e.g. a list pasted from Word). One transaction: all or nothing, original order kept.
  app.post('/tasks/:id/subtasks/bulk', async (req, reply) => {
    const t = await loadTask(idParam(req)); await needTask(db, req.user!, t, 'USER');
    const b = z.object({ items: z.array(z.object({ title: z.string().trim().min(1).max(300), description: optText(), assigneeId: z.string().nullable().optional(), dueDate: optDate, priority: prio.default(3) })).min(1).max(200) }).parse(req.body);
    for (const it of b.items) if (it.assigneeId) await checkRefs(db, req.user!, t.companyId, { delegatedToId: it.assigneeId });
    const ids = await db.tx(async (d) => {
      let pos = (await d.get<any>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM subtasks WHERE task_id = ?', [t.id]))!.n as number; const out: string[] = [];
      for (const it of b.items) out.push(await insertRow(d, 'subtasks', { ...it, taskId: t.id, companyId: t.companyId, position: pos++, status: 'TODO', progress: 0 }, req.user!.id));
      await touchTask(d, t.id);
      await audit(d, { companyId: t.companyId, entityType: 'TASK', entityId: t.id, action: 'SUBTASKS_ADDED', detail: { count: out.length }, userId: req.user!.id });
      return out;
    });
    return reply.code(201).send({ created: ids.length, ids });
  });
  app.patch('/subtasks/:id', async (req) => {
    const s = await db.get<any>('SELECT * FROM subtasks WHERE id = ?', [idParam(req)]); if (!s) throw notFound();
    await needRow(db, req.user!, s, 'USER');
    const { expectedUpdatedAt, ...patch } = subUpdate.parse(req.body) as any;
    if (patch.assigneeId) await checkRefs(db, req.user!, s.companyId, { delegatedToId: patch.assigneeId });
    if (patch.status === 'DONE' && s.status !== 'DONE') { patch.completedAt = nowIso(); patch.progress = 100; }
    if (patch.status && patch.status !== 'DONE' && s.status === 'DONE') patch.completedAt = null;
    return db.tx(async (d) => {
      const row = await updateRow(d, 'subtasks', s.id, patch, expectedUpdatedAt, req.user!.id);
      await touchTask(d, s.taskId);
      await audit(d, { companyId: s.companyId, entityType: 'SUBTASK', entityId: s.id, action: 'UPDATED', detail: { taskId: s.taskId, fields: Object.keys(patch) }, userId: req.user!.id });
      return row;
    });
  });
  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/subtasks/:id/${verb}`, async (req) => {
      const s = await db.get<any>('SELECT * FROM subtasks WHERE id = ?', [idParam(req)]); if (!s) throw notFound();
      await needRow(db, req.user!, s, 'USER');
      return db.tx(async (d) => {
        const row = await setArchived(d, 'subtasks', s.id, on, req.user!.id);
        await audit(d, { companyId: s.companyId, entityType: 'SUBTASK', entityId: s.id, action: on ? 'ARCHIVED' : 'RESTORED', detail: { taskId: s.taskId }, userId: req.user!.id });
        return row;
      });
    });

  // ───────── Comments (append-only: no edit, no delete) ─────────
  const ENTITY = { COMPANY: 'companies', PROJECT: 'projects', TASK: 'tasks', SUBTASK: 'subtasks' } as const;
  const target = z.object({ entityType: z.enum(['COMPANY', 'PROJECT', 'TASK', 'SUBTASK']), entityId: z.string() });
  async function companyOfEntity(type: keyof typeof ENTITY, id: string) {
    const r = await db.get<any>(`SELECT ${type === 'COMPANY' ? 'id' : 'company_id'} AS cid${type === 'SUBTASK' ? ', task_id' : ''} FROM ${ENTITY[type]} WHERE id = ?`, [id]);
    if (!r) throw notFound(); return r.cid as string;
  }
  /** Company + permission check for a comment target. Team members only reach comments of tasks/subtasks they can see. */
  async function needEntity(user: AuthUser, type: keyof typeof ENTITY, id: string, min: 'VIEWER' | 'USER') {
    const companyId = await companyOfEntity(type, id);
    const role = await roleFor(db, user, companyId);
    if (role === 'MEMBER') {
      if (type === 'COMPANY' || type === 'PROJECT') throw notFound();
      const taskId = type === 'TASK' ? id : (await db.get<any>('SELECT task_id FROM subtasks WHERE id = ?', [id]))?.taskId;
      await need(db, user, companyId, min, taskId);
    } else await need(db, user, companyId, min);
    return companyId;
  }
  app.get('/comments', async (req) => {
    const q = target.extend({ includeSubtasks: z.enum(['true']).optional() }).parse(req.query);
    await needEntity(req.user!, q.entityType, q.entityId, 'VIEWER');
    // For a task, optionally include the notes written against its subtasks (labelled with the subtask name).
    const wide = q.entityType === 'TASK' && q.includeSubtasks;
    return { items: await db.all(`SELECT c.*, u.name AS author_name, st.title AS subtask_title FROM comments c JOIN users u ON u.id = c.author_id
      LEFT JOIN subtasks st ON c.entity_type = 'SUBTASK' AND st.id = c.entity_id
      WHERE ${wide ? "((c.entity_type = 'TASK' AND c.entity_id = ?) OR (c.entity_type = 'SUBTASK' AND c.entity_id IN (SELECT id FROM subtasks WHERE task_id = ?)))" : 'c.entity_type = ? AND c.entity_id = ?'} AND c.archived_at IS NULL ORDER BY c.created_at, c.id`,
      wide ? [q.entityId, q.entityId] : [q.entityType, q.entityId]) };
  });
  app.post('/comments', async (req, reply) => {
    const b = target.extend({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
    const companyId = await needEntity(req.user!, b.entityType, b.entityId, 'USER');
    const id = await db.tx(async (d) => {
      const cid = await insertRow(d, 'comments', { ...b, companyId, authorId: req.user!.id }, req.user!.id);
      if (b.entityType === 'TASK') await touchTask(d, b.entityId);
      if (b.entityType === 'SUBTASK') { const s = await d.get<any>('SELECT task_id FROM subtasks WHERE id = ?', [b.entityId]); if (s) await touchTask(d, s.taskId); }
      await audit(d, { companyId, entityType: b.entityType, entityId: b.entityId, action: 'COMMENT_ADDED', detail: b.body.slice(0, 200), userId: req.user!.id });
      return cid;
    });
    return reply.code(201).send(await db.get('SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?', [id]));
  });
}
