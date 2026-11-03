import { z } from 'zod';
import type { Db } from './db.ts';
import { newId, nowIso } from './db.ts';
import { HttpError, notFound } from './errors.ts';

export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const toDb = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : (v as any));

export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const optText = (max = 4000) => z.string().trim().max(max).nullable().optional();
export const optDate = dateOnly.nullable().optional();
export const prio = z.number().int().min(1).max(4);
export const todayStr = () => new Date().toISOString().slice(0, 10);

// updated_at must strictly increase so optimistic-concurrency checks can never collide within one millisecond.
const bump = (prev: string) => { const n = nowIso(); return n > prev ? n : new Date(new Date(prev).getTime() + 1).toISOString(); };

export async function insertRow(db: Db, table: string, data: Record<string, any>, userId: string | null) {
  const now = nowIso(); const id = newId();
  const row: Record<string, any> = { id, ...data, createdAt: now, updatedAt: now, createdById: userId, updatedById: userId };
  const keys = Object.keys(row);
  try {
    await db.run(`INSERT INTO ${table} (${keys.map(snake).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => toDb(row[k])));
  } catch (e: any) {
    if (/UNIQUE|duplicate key/i.test(String(e?.message))) throw new HttpError(409, 'DUPLICATE', 'A record with the same unique value already exists');
    throw e;
  }
  return id;
}

/** Optimistic update: succeeds only if the caller saw the latest updatedAt. */
export async function updateRow(db: Db, table: string, id: string, patch: Record<string, any>, expected: string, userId: string | null) {
  const cur = await db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!cur) throw notFound();
  if (cur.updatedAt !== expected) throw new HttpError(409, 'STALE', 'This record was changed by someone else', { current: cur });
  const data: Record<string, any> = { ...patch, updatedAt: bump(cur.updatedAt), updatedById: userId };
  const keys = Object.keys(data);
  try {
    const r = await db.run(`UPDATE ${table} SET ${keys.map((k) => snake(k) + ' = ?').join(', ')} WHERE id = ? AND updated_at = ?`,
      [...keys.map((k) => toDb(data[k])), id, cur.updatedAt]);
    if (r.changes === 0) throw new HttpError(409, 'STALE', 'This record was changed by someone else', { current: await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]) });
  } catch (e: any) {
    if (/UNIQUE|duplicate key/i.test(String(e?.message))) throw new HttpError(409, 'DUPLICATE', 'A record with the same unique value already exists');
    throw e;
  }
  return (await db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, [id]))!;
}

/** Soft delete / restore. Rows are never removed. */
export async function setArchived(db: Db, table: string, id: string, archive: boolean, userId: string | null) {
  const cur = await db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!cur) throw notFound();
  if (!!cur.archivedAt === archive) return cur;
  return updateRow(db, table, id, { archivedAt: archive ? nowIso() : null }, cur.updatedAt, userId);
}

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  archived: z.enum(['true', 'false']).default('false'),
  q: z.string().trim().max(100).optional(),
});

/** Keyset pagination on (created_at DESC, id DESC). */
export async function listPage(db: Db, opts: { select: string; from: string; alias: string; where: string[]; params: any[]; limit: number; cursor?: string; order?: string }) {
  if (opts.order) {
    const offset = opts.cursor ? Math.max(0, Number(opts.cursor) || 0) : 0;
    const where = opts.where.length ? 'WHERE ' + opts.where.join(' AND ') : '';
    const rows = await db.all<any>(`SELECT ${opts.select} FROM ${opts.from} ${where} ORDER BY ${opts.order} LIMIT ? OFFSET ?`, [...opts.params, opts.limit + 1, offset]);
    const more = rows.length > opts.limit;
    return { items: more ? rows.slice(0, opts.limit) : rows, nextCursor: more ? String(offset + opts.limit) : null };
  }
  const where = [...opts.where]; const params = [...opts.params];
  if (opts.cursor) {
    const [c, i] = Buffer.from(opts.cursor, 'base64url').toString().split('|');
    where.push(`(${opts.alias}.created_at < ? OR (${opts.alias}.created_at = ? AND ${opts.alias}.id < ?))`); params.push(c, c, i);
  }
  const rows = await db.all<any>(
    `SELECT ${opts.select} FROM ${opts.from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${opts.alias}.created_at DESC, ${opts.alias}.id DESC LIMIT ?`, [...params, opts.limit + 1]);
  const more = rows.length > opts.limit; const items = more ? rows.slice(0, opts.limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: more && last ? Buffer.from(`${last.createdAt}|${last.id}`).toString('base64url') : null };
}
