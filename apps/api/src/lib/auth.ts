import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { newId, nowIso } from './db.ts';
import type { AuthUser } from './permissions.ts';

export const COOKIE = 'cc_session';
const DAYS = 30;
export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });
export const verifyPassword = (hash: string, p: string) => argon2.verify(hash, p).catch(() => false);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(db: Db, userId: string, ua?: string, ip?: string) {
  const token = randomBytes(32).toString('base64url');
  const now = nowIso();
  await db.run('INSERT INTO sessions (id,user_id,token_hash,expires_at,last_used_at,user_agent,ip,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [newId(), userId, sha(token), new Date(Date.now() + DAYS * 864e5).toISOString(), now, ua ?? null, ip ?? null, now]);
  return token;
}

const USER_COLS = 'u.id, u.email, u.name, u.is_admin, u.login_id, u.person_id, u.must_change_password';
export async function scopedCompanies(db: Db, userId: string, isAdmin: boolean): Promise<string[]> {
  if (isAdmin) return [];
  return (await db.all<any>("SELECT company_id FROM company_memberships WHERE user_id = ? AND role = 'MEMBER' AND archived_at IS NULL", [userId])).map((r) => r.companyId);
}
export async function userForToken(db: Db, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const row = await db.get<any>(
    `SELECT s.id sid, s.expires_at, s.view_as_user_id, s.act_as, ${USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND u.active = 1 AND u.archived_at IS NULL`, [sha(token)]);
  if (!row || row.expiresAt < nowIso()) return null;
  // sliding expiry
  await db.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?',
    [nowIso(), new Date(Date.now() + DAYS * 864e5).toISOString(), row.sid]);
  const real: AuthUser = { id: row.id, email: row.email, name: row.name, isAdmin: !!row.isAdmin, loginId: row.loginId, personId: row.personId, scoped: [], mustChangePassword: !!row.mustChangePassword };
  if (row.isAdmin && row.viewAsUserId) {   // View-as: the owner sees exactly what that person sees
    const t = await db.get<any>(`SELECT ${USER_COLS} FROM users u WHERE u.id = ? AND u.active = 1 AND u.archived_at IS NULL`, [row.viewAsUserId]);
    if (t) return { id: t.id, email: t.email, name: t.name, isAdmin: !!t.isAdmin, loginId: t.loginId, personId: t.personId, scoped: await scopedCompanies(db, t.id, !!t.isAdmin), realUserId: row.id, readOnly: !row.actAs };
  }
  real.scoped = await scopedCompanies(db, real.id, real.isAdmin);
  return real;
}

export const destroySession = (db: Db, token: string) => db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
export const destroyUserSessions = (db: Db, userId: string, exceptToken?: string) =>
  exceptToken
    ? db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, sha(exceptToken)])
    : db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);

// Login throttle: 5 failures / 15 min per (ip,email). In-memory, one per app instance (single-process deployment).
export function createThrottle() {
  const fails = new Map<string, number[]>();
  return {
    throttled(key: string) {
      const now = Date.now(); const list = (fails.get(key) ?? []).filter((t) => now - t < 15 * 60e3); fails.set(key, list);
      return list.length >= 5;
    },
    recordFail(key: string) { fails.set(key, [...(fails.get(key) ?? []), Date.now()]); },
    clear(key: string) { fails.delete(key); },
  };
}
export type Throttle = ReturnType<typeof createThrottle>;

/** The real session owner, ignoring View-as. */
export async function sessionOf(db: Db, token: string | undefined) {
  if (!token) return null;
  const r = await db.get<any>('SELECT s.id sid, s.user_id, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', [sha(token)]);
  return r ? { sid: r.sid as string, userId: r.userId as string, isAdmin: !!r.isAdmin } : null;
}
