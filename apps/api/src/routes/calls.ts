import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso } from '../lib/db.ts';
import { insertRow, optDate, optText, setArchived, updateRow } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { accessibleCompanyIds, inClause, need, needRow, needTask, rowGuard, taskGuard, roleFor } from '../lib/permissions.ts';
import { CHANNELS, addFeedbackComment } from '../lib/feedback.ts';

const SELECT = `k.*, t.title AS task_title, s.title AS subtask_title, pe.name AS person_name, pe.phone AS person_phone, pe.email AS person_email, c.name AS company_name, t.priority AS task_priority`;
const FROM = `calls k JOIN tasks t ON t.id = k.task_id JOIN companies c ON c.id = k.company_id LEFT JOIN subtasks s ON s.id = k.subtask_id LEFT JOIN people pe ON pe.id = k.person_id`;
const CH = z.enum(['CALL', 'EMAIL', 'WHATSAPP']);

// "Communications": things to say to someone — a call, an email or a WhatsApp — against a task or one of its subtasks.
// The person may be in People or just a typed name. Finishing one needs feedback, which is copied into the task's / subtask's notes.
export default async function callRoutes(app: FastifyInstance) {
  const { db } = app;
  const one = async (id: string) => (await db.get<any>(`SELECT ${SELECT} FROM ${FROM} WHERE k.id = ?`, [id]))!;
  const fields = { channel: CH, personId: z.string().nullable().optional(), contactName: optText(200), phone: optText(50), email: optText(200), note: optText(1000), dueDate: optDate };

  app.get('/calls', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'done', 'all']).default('pending'), companyId: z.string().optional(), taskId: z.string().optional(), channel: CH.optional(), archived: z.enum(['true']).optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, req.user!);
    const where = [q.archived ? 'k.archived_at IS NOT NULL' : 'k.archived_at IS NULL']; const params: any[] = [];
    if (q.companyId) { where.push('k.company_id = ?'); params.push(q.companyId); } else if (ids) { where.push(`k.company_id IN (${inClause(ids)})`); params.push(...ids); }
    { const g = rowGuard(req.user!, 'k'); where.push(g.sql); params.push(...g.params); }
    if (q.taskId) { where.push('k.task_id = ?'); params.push(q.taskId); }
    if (q.channel) { where.push('k.channel = ?'); params.push(q.channel); }
    if (q.status === 'pending') where.push('k.done_at IS NULL'); else if (q.status === 'done') where.push('k.done_at IS NOT NULL');
    const order = q.status === 'done' ? 'k.done_at DESC' : '(k.due_date IS NULL), k.due_date, k.created_at DESC';
    return { items: await db.all(`SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, params) };
  });

  app.post('/calls', async (req, reply) => {
    const b = z.object({ taskId: z.string(), subtaskId: z.string().nullable().optional(), ...fields, channel: CH.default('CALL') }).parse(req.body);
    const task = await db.get<any>('SELECT id, company_id, archived_at FROM tasks WHERE id = ?', [b.taskId]); if (!task) throw notFound();
    await needTask(db, req.user!, task, 'USER');
    if (!b.personId && !b.contactName) throw badRequest('Choose a person or type who this is for');
    if (b.subtaskId && !(await db.get('SELECT 1 FROM subtasks WHERE id = ? AND task_id = ?', [b.subtaskId, b.taskId]))) throw badRequest('That subtask does not belong to this task');
    if (b.personId) {
      const p = await db.get<any>('SELECT company_id, archived_at FROM people WHERE id = ?', [b.personId]);
      if (!p || p.archivedAt || (p.companyId && !(await roleFor(db, req.user!, p.companyId)))) throw badRequest('Choose an active person you have access to');
    }
    const who = b.contactName ?? (b.personId ? (await db.get<any>('SELECT name FROM people WHERE id = ?', [b.personId]))?.name : null);
    const id = await db.tx(async (t) => {
      const cid = await insertRow(t, 'calls', { ...b, subtaskId: b.subtaskId ?? null, companyId: task.companyId }, req.user!.id);
      await t.run('UPDATE tasks SET last_activity_at = ? WHERE id = ?', [nowIso(), b.taskId]);
      await audit(t, { companyId: task.companyId, entityType: 'TASK', entityId: b.taskId, action: 'CALL_ADDED', detail: { channel: b.channel, who, note: b.note }, userId: req.user!.id });
      return cid;
    });
    return reply.code(201).send(await one(id));
  });

  app.patch('/calls/:id', async (req) => {
    const { id } = req.params as { id: string };
    const cur = await db.get<any>('SELECT * FROM calls WHERE id = ?', [id]); if (!cur) throw notFound();
    await needRow(db, req.user!, cur, 'USER');
    const b = z.object({ expectedUpdatedAt: z.string(), done: z.boolean().optional(), sent: z.boolean().optional(), emailSubject: optText(300), emailBody: optText(8000), result: optText(2000), ...fields }).partial().required({ expectedUpdatedAt: true }).parse(req.body);
    const { expectedUpdatedAt, done, sent, ...patch } = b as any;
    const finishing = done === true && !cur.doneAt;
    if (finishing && sent) {
      // An email written in the Email window and marked Done there counts as sent: no separate feedback needed.
      const subject = String(patch.emailSubject ?? cur.emailSubject ?? '').trim();
      if (!subject || !String(patch.emailBody ?? cur.emailBody ?? '').trim()) throw badRequest('Write the email (subject and body) before marking it sent');
      patch.sentAt = nowIso(); patch.channel = 'EMAIL';
      if (!String(patch.result ?? '').trim()) patch.result = `Email sent — “${subject}”`;
    }
    if (finishing) {
      if (!String(patch.result ?? cur.result ?? '').trim()) throw badRequest('Write the feedback — what happened — before marking this done');
      patch.doneAt = nowIso();
    }
    if (done === false) patch.doneAt = null;
    if (('personId' in patch || 'contactName' in patch) && !(('personId' in patch ? patch.personId : cur.personId) || ('contactName' in patch ? patch.contactName : cur.contactName))) throw badRequest('This needs a person or a name');
    await db.tx(async (t) => {
      await updateRow(t, 'calls', id, patch, expectedUpdatedAt, req.user!.id);
      if (done !== undefined) {
        const who = cur.contactName ?? (cur.personId ? (await t.get<any>('SELECT name FROM people WHERE id = ?', [cur.personId]))?.name : null);
        const ch = CHANNELS[(patch.channel ?? cur.channel) as keyof typeof CHANNELS] ?? CHANNELS.CALL;
        await audit(t, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.taskId, action: done ? 'CALL_DONE' : 'CALL_REOPENED', detail: { channel: cur.channel, who, result: patch.result ?? cur.result ?? null }, userId: req.user!.id });
        if (finishing) await addFeedbackComment(t, { companyId: cur.companyId, taskId: cur.taskId, subtaskId: cur.subtaskId, userId: req.user!.id, body: `${ch.icon} ${ch.label} ${ch.to} ${who ?? ''}: ${String(patch.result ?? cur.result).trim()}` });
      }
    });
    return one(id);
  });

  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/calls/:id/${verb}`, async (req) => {
      const { id } = req.params as { id: string };
      const cur = await db.get<any>('SELECT * FROM calls WHERE id = ?', [id]); if (!cur) throw notFound();
      await needRow(db, req.user!, cur, 'USER');
      await setArchived(db, 'calls', id, on, req.user!.id); return one(id);
    });
}
