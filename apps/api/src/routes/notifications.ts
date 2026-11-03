import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso } from '../lib/db.ts';
import { bus } from '../lib/notify.ts';

export default async function notificationRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/notifications', async (req) => {
    const q = z.object({ unread: z.enum(['true']).optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }).parse(req.query);
    const items = await db.all(`SELECT n.*, a.name AS actor_name FROM notifications n LEFT JOIN users a ON a.id = n.actor_id
      WHERE n.user_id = ? ${q.unread ? 'AND n.read_at IS NULL' : ''} ORDER BY n.created_at DESC LIMIT ?`, [req.user!.id, q.limit]);
    return { items, unread: (await db.get<any>('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user!.id]))!.n };
  });
  app.get('/notifications/count', async (req) => ({
    unread: (await db.get<any>('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user!.id]))!.n,
    chat: (await db.get<any>(`SELECT COUNT(*) n FROM chat_messages m JOIN chat_members cm ON cm.room_id = m.room_id AND cm.user_id = ?
      WHERE m.author_id <> ? AND m.archived_at IS NULL AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at) AND cm.archived_at IS NULL`, [req.user!.id, req.user!.id]))!.n,
  }));
  app.post('/notifications/:id/read', async (req) => {
    await db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', [nowIso(), (req.params as any).id, req.user!.id]); return { ok: true };
  });
  app.post('/notifications/read-all', async (req) => { await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [nowIso(), req.user!.id]); return { ok: true }; });

  // Live updates: the browser keeps this open and re-fetches when told something changed.
  app.get('/events', (req, reply) => {
    const uid = req.user!.id;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const send = (e: unknown) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ } };
    bus.on(`u:${uid}`, send);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
    req.raw.on('close', () => { clearInterval(beat); bus.off(`u:${uid}`, send); });
  });
}
