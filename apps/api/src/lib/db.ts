// Thin async DB layer. SQLite (node:sqlite, zero native deps) is the dev/test/default engine.
// A PostgreSQL adapter would implement the same interface (see README).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runMigrations } from './migrate.ts';

export type Params = (string | number | null)[];
export interface Db {
  all<T = any>(sql: string, params?: Params): Promise<T[]>;
  get<T = any>(sql: string, params?: Params): Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<{ changes: number }>;
  /** Unshaped rows (snake_case columns, 0/1 booleans) — used by backup/restore. */
  rows(sql: string, params?: Params): Promise<Record<string, any>[]>;
  /** Consistent copy of the whole database into a new file. */
  snapshot(path: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): void;
}

const BOOL_COLS = new Set(['is_admin', 'active', 'is_demo', 'auto', 'completed', 'next_occurrence_created', 'blocked', 'ai_excluded', 'project_ai_excluded', 'ok', 'must_change_password', 'act_as', 'pinned', 'requires_ack', 'muted']);
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function shape(row: any) {
  if (!row) return undefined;
  const out: any = {};
  for (const k of Object.keys(row)) out[camel(k)] = BOOL_COLS.has(k) ? !!row[k] : row[k];
  return out;
}

export const nowIso = () => new Date().toISOString();
export const newId = () => randomUUID();

export function openSqlite(path: string): Db {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  runMigrations(raw, path);
  let lock: Promise<void> = Promise.resolve(); // serialises transactions on the single connection
  const ops = (inTx: boolean): Db => ({
    async all(sql, p = []) { if (!inTx) await lock; return raw.prepare(sql).all(...p).map(shape) as any; },
    async get(sql, p = []) { if (!inTx) await lock; return shape(raw.prepare(sql).get(...p)); },
    async run(sql, p = []) { if (!inTx) await lock; const r = raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    async rows(sql, p = []) { if (!inTx) await lock; return raw.prepare(sql).all(...p) as any; },
    async snapshot(path) { if (!inTx) await lock; raw.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`); },
    async tx(fn) {
      if (inTx) return fn(this as Db);
      const prev = lock; let release!: () => void;
      lock = new Promise<void>((r) => (release = r));
      await prev;
      raw.exec('BEGIN IMMEDIATE');
      try { const v = await fn(ops(true)); raw.exec('COMMIT'); return v; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
      finally { release(); }
    },
    close() { raw.close(); },
  });
  return ops(false);
}
