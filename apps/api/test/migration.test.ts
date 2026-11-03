import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../src/lib/db.ts';

test('upgrading an existing (first-version) database keeps every row and makes a backup first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mig-'));
  const path = join(dir, 'old.db');
  // 1) build a database exactly as the first version did: base schema only, with real-looking data
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  const t = '2026-10-01T00:00:00.000Z';
  old.prepare("INSERT INTO users (id,email,name,password_hash,is_admin,active,created_at,updated_at) VALUES ('u1','me@x.test','Me','h',1,1,?,?)").run(t, t);
  old.prepare("INSERT INTO companies (id,name,code,active,is_demo,created_at,updated_at) VALUES ('c1','My Co','MYCO',1,0,?,?)").run(t, t);
  old.prepare("INSERT INTO tasks (id,company_id,title,owner_id,priority,status,last_activity_at,created_at,updated_at) VALUES ('t1','c1','Existing task','u1',2,'TODO',?,?,?)").run(t, t, t);
  old.prepare("INSERT INTO focus_sessions (id,user_id,task_id,company_id,started_at,planned_minutes,actual_minutes,completed,session_number,created_at,updated_at) VALUES ('f1','u1','t1','c1',?,25,25,1,1,?,?)").run(t, t, t);
  old.close();

  // 2) open it with the new code
  const db = openSqlite(path);
  assert.equal((await db.get<any>("SELECT title FROM tasks WHERE id = 't1'"))!.title, 'Existing task', 'task survived');
  assert.equal((await db.get<any>("SELECT COUNT(*) n FROM focus_sessions"))!.n, 1, 'old focus session survived');
  assert.equal((await db.get<any>("SELECT subtask_id FROM focus_sessions WHERE id = 'f1'"))!.subtaskId, null, 'new column added');
  for (const tbl of ['calls', 'drafts', 'discussions']) assert.ok(await db.get(`SELECT 1 FROM ${tbl} LIMIT 1`).then(() => true), `${tbl} exists`);
  assert.deepEqual((await db.all<any>('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const backups = readdirSync(join(dir, 'backups')); assert.equal(backups.length, 1); assert.match(backups[0], /^before-v2-/);
  const bk = new DatabaseSync(join(dir, 'backups', backups[0]));
  assert.equal((bk.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n, 1); assert.throws(() => bk.prepare('SELECT 1 FROM calls').get(), 'backup is the pre-upgrade file');
  bk.close(); db.close();

  // 3) opening again is a no-op: no second backup, nothing re-applied
  const again = openSqlite(path); assert.equal((await again.get<any>('SELECT COUNT(*) n FROM tasks'))!.n, 1); again.close();
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
});

test('a brand-new database needs no backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-new-')); const db = openSqlite(join(dir, 'new.db')); db.close();
  assert.ok(!existsSync(join(dir, 'backups')));
});
