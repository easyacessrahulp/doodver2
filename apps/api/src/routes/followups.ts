import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso } from '../lib/db.ts';
import { insertRow, optDate, optText, setArchived, updateRow } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { addFeedbackComment } from '../lib/feedback.ts';
import { serverToday } from '../lib/dates.ts';
import { syncFollowupCache } from '../lib/followups.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { accessibleCompanyIds, inClause, need, needRow, needTask, rowGuard, taskGuard, roleFor } from '../lib/permissions.ts';

const TYPES = ['PHONE', 'WHATSAPP', 'EMAIL', 'MEETING', 'PERSONAL', 'DOCUMENT_PENDING', 'PAYMENT_PENDING', 'APPROVAL_PENDING', 'OTHER'] as const;
const LABEL: Record<string, string> = { PHONE: 'Phone', WHATSAPP: 'WhatsApp', EMAIL: 'Email', MEETING: 'Meeting', PERSONAL: 'In person', DOCUMENT_PENDING: 'Document pending', PAYMENT_PENDING: 'Payment pending', APPROVAL_PENDING: 'Approval pending', OTHER: 'Other' };
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SELECT = `f.*, substr(f.due_at, 1, 10) AS due_date, t.title AS task_title, t.priority AS task_priority, c.name AS company_name, s.title AS subtask_title, pe.name AS person_name, pe.phone AS person_phone, u.name AS user_name`;
const FROM = `followups f JOIN tasks t ON t.id = f.task_id JOIN companies c ON c.id = f.company_id LEFT JOIN subtasks s ON s.id = f.subtask_id LEFT JOIN people pe ON pe.id = f.person_id LEFT JOIN users u ON u.id = f.created_by_id`;

// Follow-ups are items to do: "chase X about this task on this date". Finishing one needs a note of what happened (copied into the task's notes)
// and may schedule the next one. The earliest pending date is mirrored on the task (next follow-up) for the attention scoring.
export default async function followupRoutes(app: FastifyInstance) {
  const { db } = app;
  const one = async (id: string) => (await db.get<any>(`SELECT ${SELECT} FROM ${FROM} WHERE f.id = ?`, [id]))!;
  const whoOf = async (f: any, t = db) => f.contactName ?? (f.personId ? (await t.get<any>('SELECT name FROM people WHERE id = ?', [f.personId]))?.name : null);

  app.get('/followups', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'done', 'all']).default('pending'), bucket: z.enum(['overdue', 'today', 'upcoming']).optional(), companyId: z.string().optional(), taskId: z.string().optional(), subtaskId: z.string().optional(), today: dateStr.optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const today = q.today ?? serverToday(); const ids = await accessibleCompanyIds(db, req.user!);
    const where = ['f.archived_at IS NULL', 't.archived_at IS NULL']; const params: any[] = [];
    if (q.companyId) { where.push('f.company_id = ?'); params.push(q.companyId); } else if (ids) { where.push(`f.company_id IN (${inClause(ids)})`); params.push(...ids); }
    { const g = taskGuard(req.user!, 't'); where.push(g.sql); params.push(...g.params); }
    if (q.taskId) { where.push('f.task_id = ?'); params.push(q.taskId); }
    if (q.subtaskId) { where.push('f.subtask_id = ?'); params.push(q.subtaskId); }
    if (q.status === 'pending') where.push('f.done_at IS NULL'); else if (q.status === 'done') where.push('f.done_at IS NOT NULL');
    if (q.bucket === 'overdue') { where.push('substr(f.due_at,1,10) < ?'); params.push(today); } else if (q.bucket === 'today') { where.push('substr(f.due_at,1,10) = ?'); params.push(today); } else if (q.bucket === 'upcoming') { where.push('substr(f.due_at,1,10) > ?'); params.push(today); }
    const order = q.status === 'done' ? 'f.done_at DESC' : 'substr(f.due_at,1,10), t.priority';
    return { items: await db.all(`SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, params) };
  });

  // Plan a follow-up.
  app.post('/followups', async (req, reply) => {
    const b = z.object({ taskId: z.string(), subtaskId: z.string().nullable().optional(), type: z.enum(TYPES).default('PHONE'), personId: z.string().nullable().optional(), contactName: optText(200), dueDate: dateStr, note: optText(1000) }).parse(req.body);
    const task = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [b.taskId]); if (!task) throw notFound();
    await needTask(db, req.user!, task, 'USER');
    if (b.subtaskId && !(await db.get('SELECT 1 FROM subtasks WHERE id = ? AND task_id = ? AND archived_at IS NULL', [b.subtaskId, b.taskId]))) throw badRequest('That subtask does not belong to this task');
    if (b.personId) { const p = await db.get<any>('SELECT company_id, archived_at FROM people WHERE id = ?', [b.personId]); if (!p || p.archivedAt || (p.companyId && !(await roleFor(db, req.user!, p.companyId)))) throw badRequest('Choose an active person you have access to'); }
    const id = await db.tx(async (t) => {
      const fid = await insertRow(t, 'followups', { taskId: b.taskId, subtaskId: b.subtaskId ?? null, companyId: task.companyId, personId: b.personId ?? null, contactName: b.contactName ?? null, type: b.type, dueAt: b.dueDate, notes: b.note ?? null }, req.user!.id);
      await syncFollowupCache(t, b.taskId);
      await t.run('UPDATE tasks SET last_activity_at = ? WHERE id = ?', [nowIso(), b.taskId]);
      await audit(t, { companyId: task.companyId, entityType: 'TASK', entityId: b.taskId, action: 'FOLLOWUP_PLANNED', detail: { type: b.type, due: b.dueDate, who: b.contactName ?? null }, userId: req.user!.id });
      return fid;
    });
    return reply.code(201).send(await one(id));
  });

  app.patch('/followups/:id', async (req) => {
    const { id } = req.params as { id: string };
    const cur = await db.get<any>('SELECT * FROM followups WHERE id = ?', [id]); if (!cur) throw notFound();
    await needRow(db, req.user!, cur, 'USER');
    const b = z.object({ expectedUpdatedAt: z.string(), done: z.boolean().optional(), result: optText(4000), nextDate: optDate, dueDate: dateStr.optional(), note: optText(1000),
      type: z.enum(TYPES).optional(), personId: z.string().nullable().optional(), contactName: optText(200) }).partial().required({ expectedUpdatedAt: true }).parse(req.body);
    const { expectedUpdatedAt, done, result, nextDate, dueDate, note, ...rest } = b as any;
    const patch: any = { ...rest }; if (dueDate) patch.dueAt = dueDate; if (note !== undefined) patch.notes = note;
    const finishing = done === true && !cur.doneAt;
    if (finishing) {
      if (!String(result ?? '').trim()) throw badRequest('Write what happened before marking this follow-up done');
      patch.doneAt = nowIso(); patch.result = String(result).trim(); patch.nextDate = nextDate ?? null;
    }
    if (done === false) { patch.doneAt = null; patch.result = null; }
    await db.tx(async (t) => {
      await updateRow(t, 'followups', id, patch, expectedUpdatedAt, req.user!.id);
      if (finishing) {
        const who = await whoOf({ ...cur, ...patch }, t);
        await addFeedbackComment(t, { companyId: cur.companyId, taskId: cur.taskId, subtaskId: cur.subtaskId, userId: req.user!.id, body: `↩ Follow-up (${LABEL[patch.type ?? cur.type]}${who ? ` · ${who}` : ''}): ${patch.result}${nextDate ? `\nNext follow-up: ${nextDate}` : ''}` });
        if (nextDate) await insertRow(t, 'followups', { taskId: cur.taskId, subtaskId: cur.subtaskId, companyId: cur.companyId, personId: patch.personId ?? cur.personId, contactName: patch.contactName ?? cur.contactName, type: patch.type ?? cur.type, dueAt: nextDate, notes: cur.notes }, req.user!.id);
        await audit(t, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.taskId, action: 'FOLLOWUP_DONE', detail: { who, next: nextDate ?? null, result: patch.result }, userId: req.user!.id });
      }
      await syncFollowupCache(t, cur.taskId);
    });
    return one(id);
  });

  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/followups/:id/${verb}`, async (req) => {
      const { id } = req.params as { id: string };
      const cur = await db.get<any>('SELECT * FROM followups WHERE id = ?', [id]); if (!cur) throw notFound();
      await needRow(db, req.user!, cur, 'USER');
      await db.tx(async (t) => { await setArchived(t, 'followups', id, on, req.user!.id); await syncFollowupCache(t, cur.taskId); });
      return one(id);
    });

  app.get('/tasks/:id/followups', async (req) => {
    const { id } = req.params as { id: string };
    const t = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [id]); if (!t) throw notFound();
    await needTask(db, req.user!, t, 'VIEWER');
    return { items: await db.all(`SELECT ${SELECT} FROM ${FROM} WHERE f.task_id = ? AND f.archived_at IS NULL ORDER BY (f.done_at IS NOT NULL), substr(f.due_at,1,10), f.created_at DESC LIMIT 100`, [id]) };
  });

  // Log a follow-up that already happened (and optionally plan the next). Pending follow-ups that were due are counted as done by it.
  app.post('/tasks/:id/followups', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await db.get<any>('SELECT * FROM tasks WHERE id = ?', [id]); if (!task) throw notFound();
    await needTask(db, req.user!, task, 'USER');
    const b = z.object({ type: z.enum(TYPES), personId: z.string().nullable().optional(), subtaskId: z.string().nullable().optional(), contactName: optText(200), notes: z.string().trim().min(1, 'Say what happened').max(4000),
      nextDate: optDate, nextAction: optText(500), today: dateStr.optional(), reminder: z.object({ tone: z.enum(['gentle', 'firm', 'escalate']), via: z.enum(['whatsapp', 'email', 'copy']), message: z.string().max(2000) }).optional() }).parse(req.body);
    if (b.subtaskId && !(await db.get('SELECT 1 FROM subtasks WHERE id = ? AND task_id = ? AND archived_at IS NULL', [b.subtaskId, id]))) throw badRequest('That subtask does not belong to this task');
    const who = b.contactName ?? (b.personId ? (await db.get<any>('SELECT name FROM people WHERE id = ?', [b.personId]))?.name : null);
    const fid = await db.tx(async (t) => {
      const now = nowIso(); const today = b.today ?? serverToday();
      await t.run(`UPDATE followups SET done_at = ?, result = COALESCE(result, ?), updated_at = ?, updated_by_id = ? WHERE task_id = ? AND done_at IS NULL AND archived_at IS NULL AND substr(due_at,1,10) <= ? AND COALESCE(subtask_id,'') = ?`, [now, 'Followed up (logged)', now, req.user!.id, id, today, b.subtaskId ?? '']);
      const priorN = b.reminder ? ((await t.get<any>(`SELECT COUNT(*) n FROM followups WHERE task_id = ? AND COALESCE(subtask_id,'') = ? AND COALESCE(person_id,'') = ? AND last_reminded_at IS NOT NULL AND archived_at IS NULL`, [id, b.subtaskId ?? '', b.personId ?? '']))?.n ?? 0) : 0;
      const f = await insertRow(t, 'followups', { taskId: id, subtaskId: b.subtaskId ?? null, companyId: task.companyId, personId: b.personId ?? null, contactName: b.contactName ?? null, type: b.type, dueAt: now, doneAt: now, notes: b.notes, nextDate: b.nextDate ?? null,
        ...(b.reminder ? { reminderCount: priorN + 1, lastRemindedAt: now, lastTone: b.reminder.tone, lastMessage: b.reminder.message, lastSentVia: b.reminder.via } : {}) }, req.user!.id);
      if (b.nextDate) await insertRow(t, 'followups', { taskId: id, subtaskId: b.subtaskId ?? null, companyId: task.companyId, personId: b.personId ?? null, contactName: b.contactName ?? null, type: b.type, dueAt: b.nextDate, notes: b.nextAction ?? null }, req.user!.id);
      await syncFollowupCache(t, id);
      if (b.nextAction) await t.run('UPDATE tasks SET next_action = ? WHERE id = ?', [b.nextAction, id]);
      await addFeedbackComment(t, { companyId: task.companyId, taskId: id, subtaskId: b.subtaskId ?? null, userId: req.user!.id, body: `↩ Follow-up (${LABEL[b.type]}${who ? ` · ${who}` : ''}): ${b.notes}${b.nextDate ? `\nNext follow-up: ${b.nextDate}` : ''}` });
      await audit(t, { companyId: task.companyId, entityType: 'TASK', entityId: id, action: 'FOLLOWUP_LOGGED', detail: { type: b.type, who, next: b.nextDate ?? null }, userId: req.user!.id });
      return f;
    });
    return reply.code(201).send(await one(fid));
  });
}
