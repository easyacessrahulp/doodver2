import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../lib/db.ts';
import { newId, nowIso } from '../lib/db.ts';
import { insertRow, optDate, optText } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { HttpError, badRequest, notFound } from '../lib/errors.ts';
import { addParticipants, canSeeTask, need, roleFor, type AuthUser } from '../lib/permissions.ts';
import { notify, ping } from '../lib/notify.ts';

/** Messaging between team members: one-to-one, groups, a thread on every task, and the room of every meeting. */
export default async function chatRoutes(app: FastifyInstance) {
  const { db } = app;
  const me = (req: any) => req.user as AuthUser;

  // ───── Who is on the team (names only; used to pick people for chats, meetings, announcements) ─────
  app.get('/team', async (req) => {
    const rows = await db.all<any>(`SELECT u.id, u.name, u.person_id, p.designation, u.last_login_at,
        (SELECT MAX(s.last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
      FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.active = 1 AND u.archived_at IS NULL ORDER BY u.name`);
    const cutoff = new Date(Date.now() - 5 * 60e3).toISOString();
    return { items: rows.map((r) => ({ id: r.id, name: r.name, personId: r.personId, designation: r.designation, online: !!r.lastSeen && r.lastSeen > cutoff, me: r.id === me(req).id })) };
  });

  // ───── Rooms ─────
  const directKey = (a: string, b: string) => [a, b].sort().join(':');
  async function addMembers(d: Db, roomId: string, userIds: string[], by: string) {
    for (const uid of new Set(userIds))
      await d.run(`INSERT INTO chat_members (id,room_id,user_id,created_at,updated_at,created_by_id,updated_by_id) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(room_id,user_id) DO UPDATE SET archived_at = NULL`, [newId(), roomId, uid, nowIso(), nowIso(), by, by]);
  }
  /** Who may open this room: its members; for a task thread, anyone who can see the task. */
  async function openRoom(user: AuthUser, roomId: string) {
    const room = await db.get<any>('SELECT * FROM chat_rooms WHERE id = ? AND archived_at IS NULL', [roomId]); if (!room) throw notFound();
    if (room.kind === 'TASK') {
      const t = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [room.taskId]); if (!t) throw notFound();
      await need(db, user, t.companyId, 'VIEWER', t.id);
      await addMembers(db, room.id, [user.id], user.id);
    } else if (!(await db.get('SELECT 1 FROM chat_members WHERE room_id = ? AND user_id = ? AND archived_at IS NULL', [room.id, user.id]))) throw notFound();
    return room;
  }
  const membersOf = (roomId: string) => db.all<any>('SELECT u.id, u.name FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND m.archived_at IS NULL ORDER BY u.name', [roomId]);

  app.get('/chat/rooms', async (req) => {
    const u = me(req);
    const rooms = await db.all<any>(`SELECT r.*, cm.last_read_at,
        (SELECT body FROM chat_messages x WHERE x.room_id = r.id AND x.archived_at IS NULL ORDER BY x.created_at DESC LIMIT 1) AS last_body,
        (SELECT created_at FROM chat_messages x WHERE x.room_id = r.id AND x.archived_at IS NULL ORDER BY x.created_at DESC LIMIT 1) AS last_at,
        (SELECT COUNT(*) FROM chat_messages x WHERE x.room_id = r.id AND x.archived_at IS NULL AND x.author_id <> ? AND (cm.last_read_at IS NULL OR x.created_at > cm.last_read_at)) AS unread
      FROM chat_rooms r JOIN chat_members cm ON cm.room_id = r.id AND cm.user_id = ? AND cm.archived_at IS NULL
      WHERE r.archived_at IS NULL AND r.kind IN ('DIRECT','GROUP','TASK') ORDER BY COALESCE(last_at, r.created_at) DESC LIMIT 100`, [u.id, u.id]);
    const out = [];
    for (const r of rooms) {
      const members = await membersOf(r.id);
      let title = r.name;
      if (r.kind === 'DIRECT') title = members.find((m: any) => m.id !== u.id)?.name ?? 'Chat';
      if (r.kind === 'TASK') title = `Task: ${(await db.get<any>('SELECT title FROM tasks WHERE id = ?', [r.taskId]))?.title ?? ''}`;
      out.push({ ...r, title, members });
    }
    return { items: out, unread: out.reduce((a, r) => a + r.unread, 0) };
  });

  app.post('/chat/direct', async (req) => {
    const u = me(req); const { userId } = z.object({ userId: z.string() }).parse(req.body);
    if (userId === u.id) throw badRequest('Choose another person');
    if (!(await db.get('SELECT 1 FROM users WHERE id = ? AND active = 1', [userId]))) throw notFound();
    const key = directKey(u.id, userId);
    let room = await db.get<any>('SELECT * FROM chat_rooms WHERE direct_key = ?', [key]);
    if (!room) { const id = await insertRow(db, 'chat_rooms', { kind: 'DIRECT', directKey: key }, u.id); await addMembers(db, id, [u.id, userId], u.id); room = await db.get<any>('SELECT * FROM chat_rooms WHERE id = ?', [id]); }
    else await addMembers(db, room.id, [u.id], u.id);
    return room;
  });
  app.post('/chat/groups', async (req, reply) => {
    const u = me(req); const b = z.object({ name: z.string().trim().min(1).max(100), memberIds: z.array(z.string()).min(1).max(100) }).parse(req.body);
    const id = await db.tx(async (t) => { const rid = await insertRow(t, 'chat_rooms', { kind: 'GROUP', name: b.name }, u.id); await addMembers(t, rid, [u.id, ...b.memberIds], u.id); return rid; });
    ping(b.memberIds, 'chat', { roomId: id });
    return reply.code(201).send(await db.get('SELECT * FROM chat_rooms WHERE id = ?', [id]));
  });
  app.post('/chat/rooms/:id/members', async (req) => {
    const u = me(req); const room = await openRoom(u, (req.params as any).id);
    if (room.kind !== 'GROUP') throw badRequest('Only group chats can have people added');
    const { memberIds } = z.object({ memberIds: z.array(z.string()).min(1) }).parse(req.body);
    await addMembers(db, room.id, memberIds, u.id); ping(memberIds, 'chat', { roomId: room.id }); return { members: await membersOf(room.id) };
  });
  app.post('/chat/task/:taskId', async (req) => {
    const u = me(req); const t = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [(req.params as any).taskId]); if (!t) throw notFound();
    await need(db, u, t.companyId, 'VIEWER', t.id);
    let room = await db.get<any>("SELECT * FROM chat_rooms WHERE kind = 'TASK' AND task_id = ?", [t.id]);
    if (!room) { const id = await insertRow(db, 'chat_rooms', { kind: 'TASK', taskId: t.id, companyId: t.companyId }, u.id); room = await db.get<any>('SELECT * FROM chat_rooms WHERE id = ?', [id]); }
    await addMembers(db, room.id, [u.id], u.id);
    return room;
  });

  // ───── Messages ─────
  app.get('/chat/rooms/:id/messages', async (req) => {
    const u = me(req); const room = await openRoom(u, (req.params as any).id);
    const q = z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }).parse(req.query);
    const rows = await db.all<any>(`SELECT m.id, m.room_id, m.author_id, a.name AS author_name, m.body, m.kind, m.ref_task_id, m.created_at, t.title AS ref_task_title
      FROM chat_messages m JOIN users a ON a.id = m.author_id LEFT JOIN tasks t ON t.id = m.ref_task_id
      WHERE m.room_id = ? AND m.archived_at IS NULL ${q.before ? 'AND m.created_at < ?' : ''} ORDER BY m.created_at DESC LIMIT ?`, q.before ? [room.id, q.before, q.limit] : [room.id, q.limit]);
    const mem = await db.get<any>('SELECT last_read_at FROM chat_members WHERE room_id = ? AND user_id = ?', [room.id, u.id]);
    return { room: { ...room, members: await membersOf(room.id) }, items: rows.reverse(), lastReadAt: mem?.lastReadAt ?? null };
  });

  const msgBody = z.object({ body: z.string().trim().min(1).max(4000), kind: z.enum(['TEXT', 'DECISION', 'ACTION']).default('TEXT'),
    // An ACTION can become a real task straight away (owned by the sender, optionally handed to someone).
    task: z.object({ companyId: z.string(), personId: z.string().nullable().optional(), dueDate: optDate }).optional() });
  app.post('/chat/rooms/:id/messages', async (req, reply) => {
    const u = me(req); const room = await openRoom(u, (req.params as any).id); const b = msgBody.parse(req.body);
    const out = await db.tx(async (t) => {
      let refTaskId: string | null = null;
      if (b.kind === 'ACTION' && b.task) {
        await need(t, u, b.task.companyId, 'USER');
        if (b.task.personId) { const p = await t.get<any>('SELECT company_id, archived_at FROM people WHERE id = ?', [b.task.personId]); if (!p || p.archivedAt || (p.companyId && !(await roleFor(t, u, p.companyId)))) throw badRequest('Choose an active person you have access to'); }
        const now = nowIso();
        refTaskId = await insertRow(t, 'tasks', { companyId: b.task.companyId, title: b.body.slice(0, 300), description: room.kind === 'MEETING' ? `Action from meeting “${room.name ?? ''}”` : 'Action from a chat', ownerId: u.id, priority: 3,
          status: b.task.personId ? 'DELEGATED' : 'TODO', dueDate: b.task.dueDate ?? null, delegatedToId: b.task.personId ?? null, delegatedAt: b.task.personId ? now : null, lastActivityAt: now }, u.id);
        await audit(t, { companyId: b.task.companyId, entityType: 'TASK', entityId: refTaskId, action: 'CREATED', detail: { title: b.body.slice(0, 80), fromChat: room.id }, userId: u.id });
        const toUser = b.task.personId ? (await t.get<any>('SELECT id FROM users WHERE person_id = ? AND active = 1', [b.task.personId]))?.id : null;
        if (toUser) { await addParticipants(t, refTaskId, [u.id, toUser], 'chat action', u.id); await notify(t, { userId: toUser, companyId: b.task.companyId, taskId: refTaskId, kind: 'ASSIGNED', title: `${u.name} gave you a task from a chat`, body: b.body.slice(0, 200), link: `tasks/${refTaskId}`, actorId: u.id }); }
      }
      const id = await insertRow(t, 'chat_messages', { roomId: room.id, authorId: u.id, body: b.body, kind: b.kind, refTaskId }, u.id);
      await t.run('UPDATE chat_members SET last_read_at = ? WHERE room_id = ? AND user_id = ?', [nowIso(), room.id, u.id]);
      return id;
    });
    const members = (await membersOf(room.id)).map((m: any) => m.id);
    let recipients = members;
    if (room.kind === 'TASK') { const t = await db.get<any>('SELECT owner_id, created_by_id, delegated_to_id FROM tasks WHERE id = ?', [room.taskId]);
      const dl = t?.delegatedToId ? (await db.get<any>('SELECT id FROM users WHERE person_id = ?', [t.delegatedToId]))?.id : null;
      const part = (await db.all<any>('SELECT user_id FROM task_participants WHERE task_id = ? AND archived_at IS NULL', [room.taskId])).map((r) => r.userId);
      recipients = [...new Set([...members, t?.ownerId, t?.createdById, dl, ...part].filter(Boolean))] as string[]; }
    ping(recipients, 'chat', { roomId: room.id });
    return reply.code(201).send(await db.get('SELECT m.*, a.name AS author_name FROM chat_messages m JOIN users a ON a.id = m.author_id WHERE m.id = ?', [out]));
  });
  app.post('/chat/rooms/:id/read', async (req) => {
    const u = me(req); const room = await openRoom(u, (req.params as any).id);
    await db.run('UPDATE chat_members SET last_read_at = ? WHERE room_id = ? AND user_id = ?', [nowIso(), room.id, u.id]); return { ok: true };
  });
  void HttpError; void optText; void canSeeTask;
}
