import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { insertRow, setArchived } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { nowIso } from '../lib/db.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { need, needRow, needTask, rowGuard, taskGuard } from '../lib/permissions.ts';

const MAX = 15 * 1024 * 1024;
const SELECT = 'a.*, s.title AS subtask_title, u.name AS uploaded_by';
const FROM = 'attachments a LEFT JOIN subtasks s ON s.id = a.subtask_id LEFT JOIN users u ON u.id = a.created_by_id';
const safeName = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'file';

export default async function fileRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/tasks/:id/attachments', async (req) => {
    const { id } = req.params as { id: string };
    const t = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [id]); if (!t) throw notFound();
    await needTask(db, req.user!, t, 'VIEWER');
    return { items: await db.all(`SELECT ${SELECT} FROM ${FROM} WHERE a.task_id = ? AND a.archived_at IS NULL ORDER BY a.created_at DESC`, [id]) };
  });

  // Files travel as base64 JSON (no multipart dependency). Attach to a task, or to one of its subtasks.
  app.post('/tasks/:id/attachments', { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await db.get<any>('SELECT company_id, archived_at FROM tasks WHERE id = ?', [id]); if (!t) throw notFound();
    await needTask(db, req.user!, t, 'USER');
    const b = z.object({ fileName: z.string().min(1).max(300), mimeType: z.string().max(200).default('application/octet-stream'), dataBase64: z.string().min(1), subtaskId: z.string().nullable().optional() }).parse(req.body);
    if (b.subtaskId && !(await db.get('SELECT 1 FROM subtasks WHERE id = ? AND task_id = ?', [b.subtaskId, id]))) throw badRequest('That subtask does not belong to this task');
    const bytes = Buffer.from(b.dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
    if (!bytes.length) throw badRequest('The file is empty');
    if (bytes.length > MAX) throw badRequest('Files can be up to 15 MB');
    const key = app.files.put(bytes);
    const aid = await db.tx(async (d) => {
      const x = await insertRow(d, 'attachments', { taskId: id, subtaskId: b.subtaskId ?? null, companyId: t.companyId, fileName: safeName(b.fileName), mimeType: b.mimeType, sizeBytes: bytes.length, storageKey: key }, req.user!.id);
      await d.run('UPDATE tasks SET last_activity_at = ? WHERE id = ?', [nowIso(), id]);
      await audit(d, { companyId: t.companyId, entityType: 'TASK', entityId: id, action: 'ATTACHMENT_ADDED', detail: { file: safeName(b.fileName), size: bytes.length, subtaskId: b.subtaskId ?? null }, userId: req.user!.id });
      return x;
    });
    return reply.code(201).send(await db.get(`SELECT ${SELECT} FROM ${FROM} WHERE a.id = ?`, [aid]));
  });

  app.get('/attachments/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await db.get<any>('SELECT * FROM attachments WHERE id = ?', [id]); if (!a) throw notFound();
    await needRow(db, req.user!, a, 'VIEWER');
    if (!app.files.has(a.storageKey)) throw notFound('The file is missing from storage');
    // Always a download, never rendered in the app's origin — uploaded HTML/SVG cannot run scripts here.
    return reply.header('Content-Type', a.mimeType).header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.fileName)}`).header('Content-Security-Policy', "default-src 'none'; sandbox").send(app.files.stream(a.storageKey));
  });

  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/attachments/:id/${verb}`, async (req) => {
      const { id } = req.params as { id: string };
      const a = await db.get<any>('SELECT * FROM attachments WHERE id = ?', [id]); if (!a) throw notFound();
      await needRow(db, req.user!, a, 'USER');
      return setArchived(db, 'attachments', id, on, req.user!.id);   // file stays on disk
    });
}
