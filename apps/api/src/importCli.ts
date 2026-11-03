// Usage: npm run import -w apps/api -- path/to/prototype-backup.json [YourNameInOldFile]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from './lib/db.ts';
import { LocalDiskStore } from './lib/files.ts';
import { importPrototype } from './lib/importProto.ts';

const dbPath = process.env.DB_PATH ?? fileURLToPath(new URL('../data/command-centre.db', import.meta.url));
const file = process.argv[2]; if (!file) { console.error('Give the path of the prototype JSON backup.'); process.exit(1); }
const db = openSqlite(dbPath); const admin = await db.get<any>('SELECT id FROM users WHERE is_admin = 1 AND active = 1 ORDER BY created_at LIMIT 1');
if (!admin) { console.error('Register the first (Admin) user in the app before importing.'); process.exit(1); }
console.log(JSON.stringify(await importPrototype(db, new LocalDiskStore(join(dirname(dbPath), 'files')), admin.id, JSON.parse(readFileSync(file, 'utf8')), process.argv[3] ?? 'Rahul'), null, 2));
