import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso } from '../lib/db.ts';
import { insertRow, optDate, optText, setArchived, updateRow } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { accessibleCompanyIds, inClause, need, needRow, needTask, rowGuard, taskGuard, roleFor } from '../lib/permissions.ts';
import { addFeedbackComment } from '../lib/feedback.ts';

const SELECT = `d.*, t.title AS task_title, s.title AS subtask_title, pe.name AS person_name, pe.phone AS person_phone, c.name AS company_name, t.priority AS task_priority`;
const FROM = `discussions d JOIN tasks t ON t.id = d.task_id JOIN companies c ON c.id = d.company_id LEFT JOIN subtasks s ON s.id = d.subtask_id LEFT JOIN people pe ON pe.id = d.person_id`;
const KIND = z.enum(['DISCUSSION', 'MEETING']);

/** Discussion / meeting items: something to talk through (or schedule a meeting about) to get a decision, against a task or subtask. */
export default async function discussionRoutes(app: FastifyInstance) {
  const { db } = app;
  const one = async (id: string) => (await db.get<any>(`SELECT ${SELECT} FROM ${FROM} WHERE d.id = ?`, [id]))!;
  const fields = {
    kind: KIND, personId: z.string().nullable().optional(), contactName: optText(200), topic: z.string().trim().min(1).max(300), agenda: optText(3000),
    dueDate: optDate, meetingTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM').nullable().optional().or(z.literal('').transform(() => null)),
    discussionNotes: optText(8000), decisions: optText(8000),
  };
  const whoOf = async (d: any, t = db) => d.contactName ?? (d.personId ? (await t.get<any>('SELECT name FROM people WHERE id = ?', [d.personId]))?.name : null) ?? 'someone';
  const body = (d: any, who: string, topic: string, notes?: string | null, decisions?: string | null) =>
    `🗣 ${d.kind === 'MEETING' ? 'Meeting' : 'Discussion'} with ${who} — ${topic}${notes?.trim() ? `\nDiscussed: ${notes.trim()}` : ''}${decisions?.trim() ? `\nDecision: ${decisions.trim()}` : ''}`;

  app.get('/discussions', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'done', 'all']).default('pending'), companyId: z.string().optional(), taskId: z.string().optional(), archived: z.enum(['true']).optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, req.user!);
    const where = [q.archived ? 'd.archived_at IS NOT NULL' : 'd.archived_at IS NULL', 't.archived_at IS NULL']; const params: any[] = [];
    if (q.companyId) { where.push('d.company_id = ?'); params.push(q.companyId); } else if (ids) { where.push(`d.company_id IN (${inClause(ids)})`); params.push(...ids); }
    { const g = taskGuard(req.user!, 't'); where.push(g.sql); params.push(...g.params); }
    if (q.taskId) { where.push('d.task_id = ?'); params.push(q.taskId); }
    if (q.status === 'pending') where.push('d.done_at IS NULL'); else if (q.status === 'done') where.push('d.done_at IS NOT NULL');
    const order = q.status === 'done' ? 'd.done_at DESC' : '(d.due_date IS NULL), d.due_date, d.created_at DESC';
    return { items: await db.all(`SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, params) };
  });

  // One list per person (or outside contact) of everything still to be discussed with them — so it can all be settled in one sitting.
  app.get('/discussions/by-person', async (req) => {
    const q = z.object({ companyId: z.string().optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, req.user!);
    const scope = (col: string) => q.companyId ? { sql: ` AND ${col} = ?`, p: [q.companyId] } : ids ? { sql: ` AND ${col} IN (${inClause(ids)})`, p: [...ids] } : { sql: '', p: [] as any[] };
    const sd = scope('d.company_id'), sk = scope('k.company_id');
    const tg = taskGuard(req.user!, 't'); sd.sql += ` AND ${tg.sql}`; sd.p.push(...tg.params); sk.sql += ` AND ${tg.sql}`; sk.p.push(...tg.params);
    const disc = await db.all<any>(`SELECT ${SELECT} FROM ${FROM} WHERE d.archived_at IS NULL AND d.done_at IS NULL AND t.archived_at IS NULL AND t.status <> 'DONE'${sd.sql} ORDER BY (d.due_date IS NULL), d.due_date, t.priority`, sd.p);
    const comms = await db.all<any>(`SELECT k.id, k.channel, k.note, k.due_date, k.person_id, k.contact_name, pe.name AS person_name, t.title AS task_title, s.title AS subtask_title
      FROM calls k JOIN tasks t ON t.id = k.task_id LEFT JOIN subtasks s ON s.id = k.subtask_id LEFT JOIN people pe ON pe.id = k.person_id
      WHERE k.archived_at IS NULL AND k.done_at IS NULL AND t.archived_at IS NULL AND t.status <> 'DONE'${sk.sql}`, sk.p);
    const key = (r: any) => (r.personId ? `p:${r.personId}` : `n:${String(r.contactName ?? '').trim().toLowerCase()}`);
    const groups = new Map<string, any>();
    const g = (r: any) => { const k = key(r); if (!groups.has(k)) groups.set(k, { key: k, personId: r.personId ?? null, name: r.personName ?? r.contactName, phone: r.personPhone ?? null, discussions: [], communications: [] }); return groups.get(k); };
    for (const r of disc) g(r).discussions.push(r);
    for (const r of comms) { if (groups.has(key(r))) g(r).communications.push(r); }   // only people we also need to talk to
    const items = [...groups.values()].filter((x) => x.discussions.length).sort((a, b) => b.discussions.length - a.discussions.length || a.name.localeCompare(b.name));
    return { items };
  });

  app.post('/discussions', async (req, reply) => {
    const b = z.object({ taskId: z.string(), subtaskId: z.string().nullable().optional(), ...fields, kind: KIND.default('DISCUSSION') }).parse(req.body);
    const task = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [b.taskId]); if (!task) throw notFound();
    await needTask(db, req.user!, task, 'USER');
    if (!b.personId && !b.contactName) throw badRequest('Choose a person or type who to discuss with');
    if (b.subtaskId && !(await db.get('SELECT 1 FROM subtasks WHERE id = ? AND task_id = ?', [b.subtaskId, b.taskId]))) throw badRequest('That subtask does not belong to this task');
    if (b.personId) {
      const p = await db.get<any>('SELECT company_id, archived_at FROM people WHERE id = ?', [b.personId]);
      if (!p || p.archivedAt || (p.companyId && !(await roleFor(db, req.user!, p.companyId)))) throw badRequest('Choose an active person you have access to');
    }
    const id = await db.tx(async (t) => {
      const did = await insertRow(t, 'discussions', { ...b, subtaskId: b.subtaskId ?? null, companyId: task.companyId }, req.user!.id);
      await t.run('UPDATE tasks SET last_activity_at = ? WHERE id = ?', [nowIso(), b.taskId]);
      await audit(t, { companyId: task.companyId, entityType: 'TASK', entityId: b.taskId, action: 'DISCUSSION_ADDED', detail: { kind: b.kind, who: await whoOf(b, t), topic: b.topic }, userId: req.user!.id });
      return did;
    });
    return reply.code(201).send(await one(id));
  });

  // Completing needs the discussion notes and/or the decision; both are written into the task's (or subtask's) notes.
  const finish = async (t: typeof db, userId: string, cur: any, patch: any) => {
    const notes = patch.discussionNotes ?? cur.discussionNotes, decisions = patch.decisions ?? cur.decisions;
    if (!String(notes ?? '').trim() && !String(decisions ?? '').trim()) throw badRequest(`Write what was discussed or decided for “${cur.topic}” before marking it done`);
    patch.doneAt = nowIso();
    await audit(t, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.taskId, action: 'DISCUSSION_DONE', detail: { topic: patch.topic ?? cur.topic, who: await whoOf(cur, t), decisions: decisions ?? null }, userId });
    await addFeedbackComment(t, { companyId: cur.companyId, taskId: cur.taskId, subtaskId: cur.subtaskId, userId, body: body(cur, await whoOf(cur, t), patch.topic ?? cur.topic, notes, decisions) });
  };

  app.patch('/discussions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const cur = await db.get<any>('SELECT * FROM discussions WHERE id = ?', [id]); if (!cur) throw notFound();
    await needRow(db, req.user!, cur, 'USER');
    const b = z.object({ expectedUpdatedAt: z.string(), done: z.boolean().optional(), ...fields }).partial().required({ expectedUpdatedAt: true }).parse(req.body);
    const { expectedUpdatedAt, done, ...patch } = b as any;
    await db.tx(async (t) => {
      if (done === true && !cur.doneAt) await finish(t, req.user!.id, cur, patch);
      if (done === false) patch.doneAt = null;
      await updateRow(t, 'discussions', id, patch, expectedUpdatedAt, req.user!.id);
    });
    return one(id);
  });

  // Settle several items with one person in one go (the "meeting sheet"). Items left blank stay pending.
  app.post('/discussions/batch-finish', async (req) => {
    const b = z.object({ items: z.array(z.object({ id: z.string(), discussionNotes: optText(8000), decisions: optText(8000) })).min(1).max(100) }).parse(req.body);
    const finished: string[] = []; const skipped: string[] = [];
    await db.tx(async (t) => {
      for (const it of b.items) {
        const cur = await t.get<any>('SELECT * FROM discussions WHERE id = ?', [it.id]); if (!cur) throw notFound();
        await needRow(t, req.user!, cur, 'USER');
        if (cur.doneAt || (!String(it.discussionNotes ?? '').trim() && !String(it.decisions ?? '').trim())) { skipped.push(it.id); continue; }
        const patch: any = { discussionNotes: it.discussionNotes ?? null, decisions: it.decisions ?? null };
        await finish(t, req.user!.id, cur, patch);
        await updateRow(t, 'discussions', it.id, patch, cur.updatedAt, req.user!.id);
        finished.push(it.id);
      }
    });
    return { finished, skipped };
  });

  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/discussions/:id/${verb}`, async (req) => {
      const { id } = req.params as { id: string };
      const cur = await db.get<any>('SELECT * FROM discussions WHERE id = ?', [id]); if (!cur) throw notFound();
      await needRow(db, req.user!, cur, 'USER');
      await setArchived(db, 'discussions', id, on, req.user!.id); return one(id);
    });
}
