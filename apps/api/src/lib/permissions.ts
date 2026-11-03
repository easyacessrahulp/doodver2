import type { Db } from './db.ts';
import { forbidden, notFound } from './errors.ts';

// MEMBER = team member: same rights as USER, but only sees tasks they own, created, are delegated, review, have a subtask in, or were added to.
export type Role = 'VIEWER' | 'MEMBER' | 'USER' | 'MANAGER' | 'ADMIN';
export const RANK: Record<Role, number> = { VIEWER: 1, MEMBER: 2, USER: 2, MANAGER: 3, ADMIN: 4 };
export interface AuthUser {
  id: string; email: string; name: string; isAdmin: boolean; loginId?: string | null; personId?: string | null;
  /** Companies where this user is a scoped team member (sees only their own items). */
  scoped: string[];
  /** Set while the Admin is looking through someone else's eyes (View-as). */
  realUserId?: string | null; readOnly?: boolean; mustChangePassword?: boolean;
}

export async function roleFor(db: Db, user: AuthUser, companyId: string): Promise<Role | null> {
  if (user.isAdmin) return 'ADMIN';
  const m = await db.get<{ role: Role }>(
    `SELECT m.role FROM company_memberships m JOIN companies c ON c.id = m.company_id
     WHERE m.user_id = ? AND m.company_id = ? AND m.archived_at IS NULL`, [user.id, companyId]);
  return m?.role ?? null;
}

/** No membership -> 404 (do not leak existence). Insufficient role -> 403. */
export async function need(db: Db, user: AuthUser, companyId: string, min: Role, taskId?: string | null): Promise<Role> {
  const role = await roleFor(db, user, companyId);
  if (!role) throw notFound();
  if (role === 'MEMBER' && taskId !== undefined && !(await canSeeTask(db, user, taskId))) throw notFound(); // not yours -> looks like it does not exist
  if (RANK[role] < RANK[min]) throw forbidden();
  return role;
}

/** Same as need(), for a row that belongs to a task (call, follow-up, discussion, note, file, subtask ...). */
export const needRow = (db: Db, user: AuthUser, row: { companyId: string; taskId?: string | null }, min: Role) =>
  need(db, user, row.companyId, min, row.taskId ?? null);
export const needTask = (db: Db, user: AuthUser, task: { id: string; companyId: string }, min: Role) => need(db, user, task.companyId, min, task.id);

/** SQL: which tasks (alias a) a scoped member may see. Returns '1=1' when the user is not scoped anywhere. */
export function taskGuard(user: AuthUser, a = 't'): { sql: string; params: any[] } {
  if (!user.scoped.length) return { sql: '1=1', params: [] };
  const pid = user.personId ?? '';
  return {
    sql: `(${a}.company_id NOT IN (${inClause(user.scoped)}) OR ${a}.owner_id = ? OR ${a}.created_by_id = ? OR ${a}.delegated_to_id = ? OR ${a}.reviewer_id = ?
      OR EXISTS (SELECT 1 FROM subtasks gs WHERE gs.task_id = ${a}.id AND gs.assignee_id = ? AND gs.archived_at IS NULL)
      OR EXISTS (SELECT 1 FROM task_participants gp WHERE gp.task_id = ${a}.id AND gp.user_id = ? AND gp.archived_at IS NULL))`,
    params: [...user.scoped, user.id, user.id, pid, pid, pid, user.id],
  };
}
/** SQL: which projects (alias a) a scoped member may see: ones they made/own, or that hold a task they can see. */
export function projectGuard(user: AuthUser, a = 'p'): { sql: string; params: any[] } {
  if (!user.scoped.length) return { sql: '1=1', params: [] };
  const g = taskGuard(user, 'pgt');
  return { sql: `(${a}.company_id NOT IN (${inClause(user.scoped)}) OR ${a}.created_by_id = ? OR ${a}.owner_id = ?
    OR EXISTS (SELECT 1 FROM tasks pgt WHERE pgt.project_id = ${a}.id AND pgt.archived_at IS NULL AND ${g.sql}))`, params: [...user.scoped, user.id, user.id, ...g.params] };
}
/** SQL for rows that carry task_id + company_id (calls, follow-ups, discussions, notes ...). */
export function rowGuard(user: AuthUser, a: string): { sql: string; params: any[] } {
  if (!user.scoped.length) return { sql: '1=1', params: [] };
  const g = taskGuard(user, 'gt');
  return { sql: `(${a}.company_id NOT IN (${inClause(user.scoped)}) OR ${a}.task_id IN (SELECT gt.id FROM tasks gt WHERE ${g.sql}))`, params: [...user.scoped, ...g.params] };
}
export async function canSeeTask(db: Db, user: AuthUser, taskId: string | null): Promise<boolean> {
  if (!user.scoped.length) return true;
  if (!taskId) return false;
  const g = taskGuard(user, 't');
  return !!(await db.get(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${g.sql}`, [taskId, ...g.params]));
}
/** Remember that these users have been brought into a task (delegation, assignment) so they keep seeing it. */
export async function addParticipants(db: Db, taskId: string, userIds: (string | null | undefined)[], why: string, by: string) {
  const now = new Date().toISOString();
  for (const uid of new Set(userIds.filter(Boolean) as string[]))
    await db.run(`INSERT INTO task_participants (id,task_id,user_id,why,created_at,updated_at,created_by_id,updated_by_id) VALUES (lower(hex(randomblob(16))),?,?,?,?,?,?,?)
      ON CONFLICT(task_id,user_id) DO UPDATE SET archived_at = NULL`, [taskId, uid, why, now, now, by, by]);
}
export async function userIdOfPerson(db: Db, personId: string | null | undefined): Promise<string | null> {
  if (!personId) return null;
  return (await db.get<any>('SELECT id FROM users WHERE person_id = ? AND active = 1 AND archived_at IS NULL', [personId]))?.id ?? null;
}

/** Company ids the user may read; null = all (admin). */
export async function accessibleCompanyIds(db: Db, user: AuthUser): Promise<string[] | null> {
  if (user.isAdmin) return null;
  const rows = await db.all<{ companyId: string }>(
    'SELECT company_id FROM company_memberships WHERE user_id = ? AND archived_at IS NULL', [user.id]);
  return rows.map((r) => r.companyId);
}

export const inClause = (ids: string[]) => (ids.length ? ids.map(() => '?').join(',') : "''");
