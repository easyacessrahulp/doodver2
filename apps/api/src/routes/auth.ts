import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId, nowIso } from '../lib/db.ts';
import { insertRow, updateRow } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { COOKIE, sessionOf, createSession, destroySession, destroyUserSessions, hashPassword, verifyPassword } from '../lib/auth.ts';
import { HttpError, badRequest, notFound, unauthorized } from '../lib/errors.ts';
import { RANK, type Role } from '../lib/permissions.ts';

const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
const loginIdSchema = z.string().trim().toLowerCase().min(3, 'User ID must be at least 3 characters').max(60).regex(/^[a-z0-9][a-z0-9._@-]*$/, 'User ID may use letters, numbers, dot, dash, underscore');
const email = z.string().trim().toLowerCase().email();

export default async function authRoutes(app: FastifyInstance) {
  const { db } = app;
  const setCookie = (reply: any, token: string) =>
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: app.config.secureCookies, path: '/', maxAge: 30 * 86400 });

  async function me(userId: string, real?: string | null, readOnly?: boolean) {
    const u = await db.get<any>('SELECT id,email,name,is_admin,login_id,person_id,must_change_password FROM users WHERE id = ?', [userId]);
    const memberships = u.isAdmin
      ? (await db.all<any>('SELECT id companyId, name companyName, code, color FROM companies WHERE archived_at IS NULL ORDER BY name')).map((c) => ({ ...c, role: 'ADMIN' as Role }))
      : await db.all<any>(`SELECT c.id companyId, c.name companyName, c.code, c.color, m.role FROM company_memberships m JOIN companies c ON c.id = m.company_id
                           WHERE m.user_id = ? AND m.archived_at IS NULL AND c.archived_at IS NULL ORDER BY c.name`, [userId]);
    const viewAs = real ? { realUserId: real, readOnly: !!readOnly, realName: (await db.get<any>('SELECT name FROM users WHERE id = ?', [real]))?.name } : null;
    return { user: { id: u.id, email: u.email, name: u.name, isAdmin: !!u.isAdmin, loginId: u.loginId, personId: u.personId, mustChangePassword: !!u.mustChangePassword }, memberships, viewAs };
  }
  const logHistory = (userId: string | null, loginId: string | null, kind: string, ok: boolean, req: any, actorId?: string) =>
    db.run('INSERT INTO login_history (id,user_id,login_id,kind,ok,actor_id,ip,user_agent,at) VALUES (?,?,?,?,?,?,?,?,?)',
      [newId(), userId, loginId, kind, ok ? 1 : 0, actorId ?? null, req.ip ?? null, String(req.headers['user-agent'] ?? '').slice(0, 200), nowIso()]);

  app.get('/auth/status', async () => ({ needsSetup: (await db.get<any>('SELECT COUNT(*) n FROM users'))!.n === 0 }));

  // Only works while there are zero users; that user becomes Admin.
  app.post('/auth/register', async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(100), email, password }).parse(req.body);
    const hash = await hashPassword(body.password);
    const id = await db.tx(async (t) => {
      if ((await t.get<any>('SELECT COUNT(*) n FROM users'))!.n > 0) throw new HttpError(403, 'REGISTRATION_CLOSED', 'Registration is closed. Ask an Admin to create your account.');
      const uid = await insertRow(t, 'users', { email: body.email, name: body.name, passwordHash: hash, isAdmin: true, active: true, lastLoginAt: nowIso() }, null);
      await insertRow(t, 'user_settings', { userId: uid }, uid);
      await audit(t, { entityType: 'USER', entityId: uid, action: 'REGISTERED_AS_ADMIN', userId: uid });
      return uid;
    });
    setCookie(reply, await createSession(db, id, req.headers['user-agent'], req.ip));
    return reply.code(201).send(await me(id));
  });

  app.post('/auth/login', async (req, reply) => {
    const raw = z.object({ loginId: z.string().optional(), email: z.string().optional(), password: z.string().min(1) }).parse(req.body);
    const who = (raw.loginId ?? raw.email ?? '').trim().toLowerCase();
    if (!who) throw badRequest('Enter your user ID');
    const key = `${req.ip}|${who}`;
    if (app.throttle.throttled(key)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again in 15 minutes.');
    const u = await db.get<any>('SELECT * FROM users WHERE (lower(login_id) = ? OR lower(email) = ?) AND archived_at IS NULL', [who, who]);
    const ok = u && u.active && (await verifyPassword(u.passwordHash, raw.password));
    if (!ok) { app.throttle.recordFail(key); await logHistory(u?.id ?? null, who, 'LOGIN', false, req); throw unauthorized('Incorrect user ID or password'); }
    app.throttle.clear(key);
    await db.run('UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?', [nowIso(), u.id]);
    await logHistory(u.id, who, 'LOGIN', true, req);
    setCookie(reply, await createSession(db, u.id, req.headers['user-agent'], req.ip));
    return me(u.id);
  });

  app.post('/auth/logout', async (req, reply) => {
    const t = req.cookies[COOKIE]; if (t) { const si = await sessionOf(db, t); if (si) await logHistory(si.userId, null, 'LOGOUT', true, req); await destroySession(db, t); }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => me(req.user!.id, req.user!.realUserId, req.user!.readOnly));

  app.post('/auth/change-password', async (req, reply) => {
    const body = z.object({ currentPassword: z.string(), newPassword: password }).parse(req.body);
    const u = (await db.get<any>('SELECT * FROM users WHERE id = ?', [req.user!.id]))!;
    if (!(await verifyPassword(u.passwordHash, body.currentPassword))) throw badRequest('Current password is incorrect');
    if (body.currentPassword === body.newPassword) throw badRequest('Choose a password different from the current one');
    await updateRow(db, 'users', u.id, { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false }, u.updatedAt, u.id);
    await destroyUserSessions(db, u.id, req.cookies[COOKIE]); // sign out everywhere else
    await audit(db, { entityType: 'USER', entityId: u.id, action: 'PASSWORD_CHANGED', userId: u.id });
    return { ok: true };
  });

  // ───── User administration (Admin only) ─────
  const adminOnly = (req: any) => { if (!req.user!.isAdmin) throw new HttpError(403, 'FORBIDDEN', 'Admin only'); };
  const publicUser = 'id,email,name,is_admin,active,last_login_at,login_id,person_id,must_change_password,login_count,created_at,updated_at,archived_at';

  app.get('/users', async (req) => {
    adminOnly(req);
    const users = await db.all<any>(`SELECT ${publicUser} FROM users ORDER BY name`);
    const ms = await db.all<any>(`SELECT m.user_id, m.company_id, m.role, c.name company_name FROM company_memberships m JOIN companies c ON c.id = m.company_id WHERE m.archived_at IS NULL`);
    return { items: users.map((u) => ({ ...u, memberships: ms.filter((m) => m.userId === u.id).map(({ userId, ...m }) => m) })) };
  });

  app.post('/users', async (req, reply) => {
    adminOnly(req);
    const b0 = z.object({ name: z.string().trim().min(1).max(100), loginId: loginIdSchema.optional(), email: loginIdSchema.optional(), password, isAdmin: z.boolean().default(false), mustChangePassword: z.boolean().default(true),
      designation: z.string().trim().max(100).optional(), companies: z.array(z.object({ companyId: z.string(), role: z.enum(['MEMBER', 'MANAGER', 'USER', 'VIEWER']) })).default([]) }).parse(req.body);
    if (!b0.loginId && !b0.email) throw badRequest('Enter a user ID');
    const b = { ...b0, loginId: (b0.loginId ?? b0.email)! };
    if (await db.get('SELECT 1 FROM users WHERE lower(login_id) = ? OR lower(email) = ?', [b.loginId, b.loginId])) throw new HttpError(409, 'DUPLICATE', 'That user ID is already taken');
    const hash = await hashPassword(b.password);
    const id = await db.tx(async (t) => {
      const pid = await insertRow(t, 'people', { companyId: null, name: b.name, designation: b.designation ?? null, active: true }, req.user!.id);   // shared person: can be given work in every company
      const uid = await insertRow(t, 'users', { email: b.loginId.includes('@') ? b.loginId : `${b.loginId}@dood.local`, loginId: b.loginId, name: b.name, passwordHash: hash,
        isAdmin: b.isAdmin, active: true, personId: pid, mustChangePassword: b.mustChangePassword }, req.user!.id);
      await insertRow(t, 'user_settings', { userId: uid }, req.user!.id);
      for (const c of b.companies) {
        if (!(await t.get('SELECT 1 FROM companies WHERE id = ?', [c.companyId]))) throw notFound();
        await insertRow(t, 'company_memberships', { userId: uid, companyId: c.companyId, role: c.role }, req.user!.id);
      }
      await audit(t, { entityType: 'USER', entityId: uid, action: 'CREATED', userId: req.user!.id });
      return uid;
    });
    return reply.code(201).send(await db.get(`SELECT ${publicUser} FROM users WHERE id = ?`, [id]));
  });

  app.patch('/users/:id', async (req) => {
    adminOnly(req);
    const { id } = req.params as { id: string };
    const b = z.object({ expectedUpdatedAt: z.string(), name: z.string().trim().min(1).max(100).optional(), isAdmin: z.boolean().optional(),
      active: z.boolean().optional(), password: password.optional(), loginId: loginIdSchema.optional(), mustChangePassword: z.boolean().optional() }).parse(req.body);
    const { expectedUpdatedAt, password: pw, ...patch } = b as any;
    if (pw) { patch.passwordHash = await hashPassword(pw); if (patch.mustChangePassword === undefined) patch.mustChangePassword = true; }
    if (patch.loginId && (await db.get('SELECT 1 FROM users WHERE lower(login_id) = ? AND id <> ?', [patch.loginId, id]))) throw new HttpError(409, 'DUPLICATE', 'That user ID is already taken');
    if (patch.isAdmin === false || patch.active === false) {
      const admins = (await db.get<any>('SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND active = 1 AND id <> ?', [id]))!.n;
      const target = await db.get<any>('SELECT is_admin FROM users WHERE id = ?', [id]);
      if (target?.isAdmin && admins === 0) throw badRequest('At least one active Admin must remain');
    }
    const row = await updateRow(db, 'users', id, patch, expectedUpdatedAt, req.user!.id);
    if (pw || patch.active === false) await destroyUserSessions(db, id);
    await audit(db, { entityType: 'USER', entityId: id, action: 'UPDATED', detail: Object.keys(patch).filter((k) => k !== 'passwordHash'), userId: req.user!.id });
    const { passwordHash, ...safe } = row; return safe;
  });

  app.put('/users/:id/memberships/:companyId', async (req) => {
    adminOnly(req);
    const { id, companyId } = req.params as any;
    const { role } = z.object({ role: z.enum(['MEMBER', 'MANAGER', 'USER', 'VIEWER']) }).parse(req.body);
    if (!(await db.get('SELECT 1 FROM users WHERE id = ?', [id])) || !(await db.get('SELECT 1 FROM companies WHERE id = ?', [companyId]))) throw notFound();
    const ex = await db.get<any>('SELECT * FROM company_memberships WHERE user_id = ? AND company_id = ?', [id, companyId]);
    if (ex) await updateRow(db, 'company_memberships', ex.id, { role, archivedAt: null }, ex.updatedAt, req.user!.id);
    else await insertRow(db, 'company_memberships', { userId: id, companyId, role }, req.user!.id);
    await audit(db, { companyId, entityType: 'USER', entityId: id, action: 'MEMBERSHIP_SET', detail: { role }, userId: req.user!.id });
    return { ok: true, role };
  });

  app.delete('/users/:id/memberships/:companyId', async (req) => {
    adminOnly(req);
    const { id, companyId } = req.params as any;
    const ex = await db.get<any>('SELECT * FROM company_memberships WHERE user_id = ? AND company_id = ? AND archived_at IS NULL', [id, companyId]);
    if (!ex) throw notFound();
    await updateRow(db, 'company_memberships', ex.id, { archivedAt: nowIso() }, ex.updatedAt, req.user!.id); // soft: history kept
    await audit(db, { companyId, entityType: 'USER', entityId: id, action: 'MEMBERSHIP_REMOVED', userId: req.user!.id });
    return { ok: true };
  });

  app.post('/users/:id/sign-out', async (req) => {
    adminOnly(req); const { id } = req.params as any;
    if (!(await db.get('SELECT 1 FROM users WHERE id = ?', [id]))) throw notFound();
    await destroyUserSessions(db, id); await logHistory(id, null, 'SIGNED_OUT_BY_ADMIN', true, req, req.user!.id);
    return { ok: true };
  });
  app.get('/users/:id/logins', async (req) => {
    adminOnly(req); const { id } = req.params as any;
    return { items: await db.all('SELECT * FROM login_history WHERE user_id = ? ORDER BY at DESC LIMIT 100', [id]) };
  });

  // ───── View-as / Act-as (owner only). The session of the real Admin carries the target; every start is logged. ─────
  app.post('/auth/view-as', async (req) => {
    const si = await sessionOf(db, req.cookies[COOKIE]); if (!si?.isAdmin) throw new HttpError(403, 'FORBIDDEN', 'Admin only');
    const b = z.object({ userId: z.string(), actAs: z.boolean().default(false) }).parse(req.body);
    const t = await db.get<any>('SELECT id, name, is_admin FROM users WHERE id = ? AND active = 1', [b.userId]);
    if (!t || t.id === si.userId) throw badRequest('Choose another active user');
    await db.run('UPDATE sessions SET view_as_user_id = ?, act_as = ? WHERE id = ?', [t.id, b.actAs ? 1 : 0, si.sid]);
    await logHistory(t.id, null, b.actAs ? 'ACT_AS' : 'VIEW_AS', true, req, si.userId);
    return me(t.id, si.userId, !b.actAs);
  });
  app.delete('/auth/view-as', async (req) => {
    const si = await sessionOf(db, req.cookies[COOKIE]); if (!si?.isAdmin) throw new HttpError(403, 'FORBIDDEN', 'Admin only');
    await db.run('UPDATE sessions SET view_as_user_id = NULL, act_as = 0 WHERE id = ?', [si.sid]);
    return me(si.userId);
  });
}
void RANK; void newId;
