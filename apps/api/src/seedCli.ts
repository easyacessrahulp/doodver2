import { fileURLToPath } from 'node:url';
import { openSqlite } from './lib/db.ts';
import { loadDemo } from './lib/demo.ts';

const dbPath = process.env.DB_PATH ?? fileURLToPath(new URL('../data/command-centre.db', import.meta.url));
const db = openSqlite(dbPath);
const admin = await db.get<any>('SELECT id FROM users WHERE is_admin = 1 AND active = 1 ORDER BY created_at LIMIT 1');
if (!admin) { console.error('No Admin exists yet. Open the app, register the first user, then run this again (or use Settings → Load demo data).'); process.exit(1); }
console.log('Demo data:', await loadDemo(db, admin.id));
