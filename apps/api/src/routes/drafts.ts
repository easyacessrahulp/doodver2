import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId, nowIso } from '../lib/db.ts';
import { badRequest, notFound } from '../lib/errors.ts';

const KINDS = ['task', 'project', 'person', 'company', 'call', 'discussion', 'followup'] as const;
const body = z.object({ title: z.string().trim().max(200).nullable().optional(), data: z.record(z.string(), z.unknown()) });

// Drafts are private scratch space: only their owner can see them. Discarding archives (soft delete) like everything else.
export default async function draftRoutes(app: FastifyInstance) {
  const { db } = app;
  const shape = (r: any) => ({ ...r, data: JSON.parse(r.data) });
  const mine = async (id: string, userId: string) => { const r = await db.get<any>('SELECT * FROM drafts WHERE id = ? AND user_id = ? AND archived_at IS NULL', [id, userId]); if (!r) throw notFound(); return r; };
  const pack = (b: z.infer<typeof body>) => { const data = JSON.stringify(b.data); if (data.length > 60_000) throw badRequest('Draft is too large'); return data; };

  app.get('/drafts', async (req) => ({ items: (await db.all<any>('SELECT * FROM drafts WHERE user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200', [req.user!.id])).map(shape) }));

  app.post('/drafts', async (req, reply) => {
    const b = body.extend({ kind: z.enum(KINDS) }).parse(req.body);
    const id = newId(), now = nowIso();
    await db.run('INSERT INTO drafts (id,user_id,kind,title,data,created_at,updated_at,created_by_id,updated_by_id) VALUES (?,?,?,?,?,?,?,?,?)', [id, req.user!.id, b.kind, b.title ?? null, pack(b), now, now, req.user!.id, req.user!.id]);
    return reply.code(201).send(shape((await db.get<any>('SELECT * FROM drafts WHERE id = ?', [id]))!));
  });

  app.patch('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string }; await mine(id, req.user!.id);
    const b = body.parse(req.body);
    await db.run('UPDATE drafts SET title = ?, data = ?, updated_at = ?, updated_by_id = ? WHERE id = ?', [b.title ?? null, pack(b), nowIso(), req.user!.id, id]);
    return shape((await db.get<any>('SELECT * FROM drafts WHERE id = ?', [id]))!);
  });

  app.delete('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string }; await mine(id, req.user!.id);
    await db.run('UPDATE drafts SET archived_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), id]);
    return { ok: true };
  });
}
