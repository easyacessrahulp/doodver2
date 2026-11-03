import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';

// Settings (including the OpenAI key) are read from apps/api/.env. The key is only ever used on this server.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) { try { process.loadEnvFile(envFile); } catch { console.warn('Could not read apps/api/.env — check it is plain KEY=value lines.'); } }
const dbPath = process.env.DB_PATH ?? fileURLToPath(new URL('../data/command-centre.db', import.meta.url));
const webDir = process.env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const app = await buildApp({ dbPath, webDir, secureCookies: process.env.SECURE_COOKIES === 'true', logger: true, scheduler: true });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`\n  DOOD running → http://localhost:${port}\n  Database: ${dbPath}\n  AI: ${app.ai.enabled ? `on (model ${app.ai.model})` : 'not set up'}\n`);
