import JSZip from 'jszip';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { MIGRATIONS } from './migrate.ts';
import type { FileStore } from './files.ts';
import { parseCsv, toCsv } from './csv.ts';

// Dependency order: parents before children. Sessions and schema_migrations are intentionally not part of a backup.
export const TABLES = ['users', 'companies', 'company_memberships', 'projects', 'people', 'recurring_rules', 'tasks', 'subtasks', 'comments', 'followups', 'reminders', 'calls', 'discussions',
  'attachments', 'task_relationships', 'activity_log', 'focus_sessions', 'notifications', 'user_settings', 'drafts', 'ai_summaries', 'ai_email_drafts', 'ai_usage', 'notes', 'note_versions',
  'task_participants', 'chat_rooms', 'chat_members', 'chat_messages', 'meetings', 'meeting_participants', 'announcements', 'announcement_targets', 'announcement_reads',
  'feed_posts', 'post_comments', 'reactions', 'board_lists', 'task_reviews', 'login_history',
  'notebooks', 'journal_notes', 'journal_note_versions', 'journal_files', 'task_templates', 'chase_snooze', 'vault_docs', 'vault_files', 'approvals', 'digest_prefs'] as const;
type Table = (typeof TABLES)[number];
const FK: Record<string, Record<string, string>> = {
  company_memberships: { user_id: 'users', company_id: 'companies' }, projects: { company_id: 'companies', owner_id: 'users' }, people: { company_id: 'companies', reports_to_id: 'people' },
  recurring_rules: { company_id: 'companies' }, tasks: { company_id: 'companies', project_id: 'projects', owner_id: 'users', delegated_to_id: 'people', reviewer_id: 'people', depends_on_id: 'tasks', recurring_rule_id: 'recurring_rules' },
  subtasks: { task_id: 'tasks', assignee_id: 'people' }, followups: { task_id: 'tasks', subtask_id: 'subtasks', person_id: 'people' }, reminders: { task_id: 'tasks' },
  calls: { task_id: 'tasks', subtask_id: 'subtasks', person_id: 'people' }, discussions: { task_id: 'tasks', subtask_id: 'subtasks', person_id: 'people' },
  notes: { task_id: 'tasks', subtask_id: 'subtasks', discussion_id: 'discussions' }, note_versions: { note_id: 'notes' },
  attachments: { task_id: 'tasks', subtask_id: 'subtasks' }, task_relationships: { from_task_id: 'tasks', to_task_id: 'tasks' }, focus_sessions: { user_id: 'users', task_id: 'tasks', subtask_id: 'subtasks' },
  notifications: { user_id: 'users' }, task_participants: { task_id: 'tasks', user_id: 'users' }, chat_members: { room_id: 'chat_rooms', user_id: 'users' },
  chat_messages: { room_id: 'chat_rooms' }, meeting_participants: { meeting_id: 'meetings', user_id: 'users' }, announcement_targets: { announcement_id: 'announcements', user_id: 'users' },
  announcement_reads: { announcement_id: 'announcements', user_id: 'users' }, post_comments: { post_id: 'feed_posts' }, task_reviews: { task_id: 'tasks', user_id: 'users' }, user_settings: { user_id: 'users' }, drafts: { user_id: 'users' },
  notebooks: { owner_id: 'users' }, journal_notes: { owner_id: 'users', notebook_id: 'notebooks', company_id: 'companies', task_id: 'tasks', project_id: 'projects' }, journal_note_versions: { note_id: 'journal_notes' }, journal_files: { note_id: 'journal_notes' },
  task_templates: { owner_id: 'users', company_id: 'companies' }, chase_snooze: { user_id: 'users', task_id: 'tasks', subtask_id: 'subtasks' }, vault_docs: { company_id: 'companies', project_id: 'projects', task_id: 'tasks' }, vault_files: { doc_id: 'vault_docs' },
  approvals: { company_id: 'companies', task_id: 'tasks', requester_id: 'users', approver_id: 'users' }, digest_prefs: { user_id: 'users' },
};
const UNIQUE: Record<string, string[]> = { digest_prefs: ['user_id'], users: ['email'], companies: ['code'], company_memberships: ['user_id', 'company_id'], user_settings: ['user_id'], task_relationships: ['from_task_id', 'to_task_id', 'type'] };
export const SCHEMA_VERSION = Math.max(1, ...MIGRATIONS.map((m) => m.version));

interface ColInfo { name: string; notnull: number; dflt_value: string | null; pk: number }
const columnsOf = async (db: Db, t: string) => (await db.rows(`PRAGMA table_info(${t})`)) as unknown as ColInfo[];

export async function buildBackup(db: Db, files: FileStore, appVersion: string) {
  const zip = new JSZip(); const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const cols = (await columnsOf(db, t)).map((c) => c.name);
    const rows = await db.rows(`SELECT * FROM ${t} ORDER BY rowid`);
    counts[t] = rows.length; zip.file(`data/${t}.csv`, toCsv(cols, rows.map((r) => cols.map((c) => r[c]))));
  }
  let fileCount = 0, missing = 0;
  for (const a of [...await db.rows('SELECT storage_key FROM attachments'), ...await db.rows('SELECT storage_key FROM journal_files'), ...await db.rows('SELECT storage_key FROM vault_files')]) { const k = a.storage_key as string; if (files.has(k)) { zip.file(`files/${k}`, files.read(k)); fileCount++; } else missing++; }
  zip.file('manifest.json', JSON.stringify({ app: 'command-centre', appVersion, schemaVersion: SCHEMA_VERSION, createdAt: nowIso(), tables: TABLES, counts, files: fileCount, missingFiles: missing,
    note: 'Contains password hashes and all your data — keep this file private.' }, null, 2));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export interface Parsed { tables: Map<string, { columns: string[]; rows: Record<string, any>[] }>; files: Map<string, Buffer>; manifest: any }
export interface Report { ok: boolean; errors: string[]; warnings: string[]; counts: Record<string, number>; replaceErrors: string[]; mergeErrors: string[]; mergeNew: Record<string, number>; files: number }

export async function validateBackup(db: Db, files: FileStore, buf: Buffer): Promise<{ parsed: Parsed | null; report: Report }> {
  const report: Report = { ok: false, errors: [], warnings: [], counts: {}, replaceErrors: [], mergeErrors: [], mergeNew: {}, files: 0 };
  let zip: JSZip; try { zip = await JSZip.loadAsync(buf); } catch { report.errors.push('This is not a valid backup ZIP file.'); return { parsed: null, report }; }
  const mf = zip.file('manifest.json'); let manifest: any = null;
  try { manifest = mf ? JSON.parse(await mf.async('string')) : null; } catch { /* handled below */ }
  if (!manifest || manifest.app !== 'command-centre') { report.errors.push('manifest.json is missing or this backup was not made by Command Centre.'); return { parsed: null, report }; }
  if (manifest.schemaVersion > SCHEMA_VERSION) report.errors.push(`This backup was made by a newer version (schema ${manifest.schemaVersion}); update the app first.`);
  const tables = new Map<string, { columns: string[]; rows: Record<string, any>[] }>(); const ids = new Map<string, Set<string>>();
  for (const t of TABLES) {
    const f = zip.file(`data/${t}.csv`);
    if (!f) { if (['users', 'companies', 'tasks'].includes(t)) report.errors.push(`data/${t}.csv is missing.`); else report.warnings.push(`data/${t}.csv not in this backup (older version?) — treated as empty.`); tables.set(t, { columns: [], rows: [] }); ids.set(t, new Set()); continue; }
    let grid: (string | null)[][]; try { grid = parseCsv(await f.async('string')); } catch (e) { report.errors.push(`${t}.csv could not be read: ${(e as Error).message}`); continue; }
    if (!grid.length) { tables.set(t, { columns: [], rows: [] }); ids.set(t, new Set()); continue; }
    const header = grid[0] as string[]; const info = await columnsOf(db, t); const known = new Set(info.map((c) => c.name));
    const unknown = header.filter((h) => !known.has(h)); if (unknown.length) report.errors.push(`${t}.csv has unknown columns: ${unknown.join(', ')}.`);
    const required = info.filter((c) => c.notnull && c.dflt_value === null).map((c) => c.name).filter((c) => !header.includes(c));
    if (required.length) report.errors.push(`${t}.csv is missing required columns: ${required.join(', ')}.`);
    const rows: Record<string, any>[] = []; const seen = new Set<string>();
    for (let i = 1; i < grid.length; i++) {
      const g = grid[i]; if (g.length !== header.length) { report.errors.push(`${t}.csv row ${i + 1}: expected ${header.length} columns, found ${g.length}.`); continue; }
      const r: Record<string, any> = {}; header.forEach((h, k) => (r[h] = g[k]));
      if (!r.id) { report.errors.push(`${t}.csv row ${i + 1}: missing id.`); continue; }
      if (seen.has(r.id)) { report.errors.push(`${t}.csv: duplicate id ${r.id}.`); continue; } seen.add(r.id);
      for (const c of info) if (c.notnull && c.dflt_value === null && header.includes(c.name) && (r[c.name] === null)) { report.errors.push(`${t}.csv row ${i + 1}: ${c.name} must not be empty.`); break; }
      rows.push(r);
    }
    tables.set(t, { columns: header.filter((h) => known.has(h)), rows }); ids.set(t, seen); report.counts[t] = rows.length;
  }
  // References: every foreign key must point at a row that will exist after the restore.
  const dbIds = new Map<string, Set<string>>();
  for (const t of new Set(Object.values(FK).flatMap((m) => Object.values(m)))) dbIds.set(t, new Set((await db.rows(`SELECT id FROM ${t}`)).map((r) => r.id as string)));
  for (const [t, map] of Object.entries(FK)) for (const r of tables.get(t)?.rows ?? []) for (const [col, ref] of Object.entries(map)) {
    const v = r[col]; if (!v) continue;
    if (!ids.get(ref)?.has(v)) { report.replaceErrors.push(`${t} ${r.id}: ${col} → missing ${ref} ${v}`); if (!dbIds.get(ref)?.has(v)) report.mergeErrors.push(`${t} ${r.id}: ${col} → missing ${ref} ${v}`); }
  }
  // Merge can only add rows; it must not collide with different rows that hold the same unique value.
  for (const [t, cols] of Object.entries(UNIQUE)) {
    const existing = await db.rows(`SELECT id, ${cols.join(', ')} FROM ${t}`); const key = (r: any) => cols.map((c) => String(r[c]).toLowerCase()).join('|');
    const map = new Map(existing.map((r) => [key(r), r.id as string]));
    for (const r of tables.get(t)?.rows ?? []) { const other = map.get(key(r)); if (other && other !== r.id) report.mergeErrors.push(`${t} ${r.id}: same ${cols.join('+')} already exists as a different record`); }
  }
  for (const t of TABLES) { const have = new Set((await db.rows(`SELECT id FROM ${t}`)).map((r) => r.id as string)); report.mergeNew[t] = (tables.get(t)?.rows ?? []).filter((r) => !have.has(r.id)).length; }
  const fileMap = new Map<string, Buffer>();
  for (const a of [...(tables.get('attachments')?.rows ?? []), ...(tables.get('journal_files')?.rows ?? []), ...(tables.get('vault_files')?.rows ?? [])]) {
    const k = a.storage_key as string; const e = zip.file(`files/${k}`);
    if (e) { fileMap.set(k, await e.async('nodebuffer')); report.files++; } else if (!files.has(k)) report.warnings.push(`Attachment “${a.file_name}” has no file in the backup.`);
  }
  report.replaceErrors = report.replaceErrors.slice(0, 50); report.mergeErrors = report.mergeErrors.slice(0, 50);
  report.ok = report.errors.length === 0;
  return { parsed: { tables, files: fileMap, manifest }, report };
}

export async function autoBackup(db: Db, dbPath: string, label: string) {
  if (dbPath === ':memory:') return null;
  const dir = join(dirname(dbPath), 'backups'); mkdirSync(dir, { recursive: true });
  const p = join(dir, `${label}-${nowIso().replace(/[:.]/g, '-')}.db`); await db.snapshot(p); return p;
}

export async function applyBackup(db: Db, files: FileStore, parsed: Parsed, mode: 'REPLACE' | 'MERGE') {
  const result: Record<string, { inserted: number; skipped: number }> = {};
  await db.tx(async (t) => {
    await t.run('PRAGMA defer_foreign_keys = ON');
    if (mode === 'REPLACE') {
      await t.run('DELETE FROM sessions');
      for (const tb of [...TABLES].reverse()) await t.run(`DELETE FROM ${tb}`);
    }
    for (const tb of TABLES) {
      const data = parsed.tables.get(tb); let inserted = 0, skipped = 0;
      for (const r of data?.rows ?? []) {
        const cols = data!.columns; const res = await t.run(`INSERT OR IGNORE INTO ${tb} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => r[c]));
        if (res.changes) inserted++; else skipped++;
      }
      result[tb] = { inserted, skipped };
    }
  });
  let restoredFiles = 0;
  for (const [k, bytes] of parsed.files) if (!files.has(k)) { files.putAt(k, bytes); restoredFiles++; }
  return { result, restoredFiles };
}
