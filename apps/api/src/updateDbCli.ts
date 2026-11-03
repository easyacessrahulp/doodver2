// "One command to update the database": npm run update-db
// 1) makes a full backup copy, 2) counts what is there, 3) applies only the NEW additive changes, 4) counts again.
// It never deletes, resets or re-seeds anything.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite } from './lib/db.ts';

const dbPath = process.env.DB_PATH ?? fileURLToPath(new URL('../data/command-centre.db', import.meta.url));
const COUNTS: [string, string][] = [['Companies', 'companies'], ['Projects', 'projects'], ['Tasks', 'tasks'], ['Subtasks', 'subtasks']];

function counts(raw: DatabaseSync) {
  const out: Record<string, { active: number; total: number }> = {};
  for (const [label, t] of COUNTS) {
    try {
      const r = raw.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) active FROM ${t}`).get() as any;
      out[label] = { active: Number(r.active ?? 0), total: Number(r.total ?? 0) };
    } catch { out[label] = { active: 0, total: 0 }; }
  }
  return out;
}

if (!existsSync(dbPath)) {
  console.log(`\n  No database found at ${dbPath}\n  Nothing to update - DOOD will create a fresh one the first time it starts.\n`);
  process.exit(0);
}

const before = new DatabaseSync(dbPath);
before.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const dir = join(dirname(dbPath), 'backups'); mkdirSync(dir, { recursive: true });
const backup = join(dir, `manual-before-update-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
before.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
const b = counts(before);
before.close();
console.log(`\n  Step 1: full backup saved to\n          ${backup}\n`);

const db = openSqlite(dbPath);     // applies pending additive changes only
const raw = new DatabaseSync(dbPath);
const a = counts(raw);
const ver = (raw.prepare('SELECT MAX(version) v FROM schema_migrations').get() as any).v;
raw.close(); db.close();

console.log('  Step 2: your data, before and after (active / including archived)\n');
console.log('          ' + 'Item'.padEnd(11) + 'Before'.padEnd(14) + 'After'.padEnd(14) + 'Same?');
let ok = true;
for (const [label] of COUNTS) {
  const same = b[label].total === a[label].total && b[label].active === a[label].active; if (!same) ok = false;
  console.log('          ' + label.padEnd(11) + `${b[label].active} / ${b[label].total}`.padEnd(14) + `${a[label].active} / ${a[label].total}`.padEnd(14) + (same ? 'Yes' : 'NO - check!'));
}
console.log(`\n  Database is now at version ${ver}. ${ok ? 'All your data is intact.' : 'COUNTS DIFFER - do not continue; restore the backup above and tell me.'}\n`);
process.exit(ok ? 0 : 1);
