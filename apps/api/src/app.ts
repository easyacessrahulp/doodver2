import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ZodError } from 'zod';
import { openSqlite, type Db } from './lib/db.ts';
import { LocalDiskStore, type FileStore } from './lib/files.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COOKIE, createThrottle, userForToken, type Throttle } from './lib/auth.ts';
import { HttpError } from './lib/errors.ts';
import type { AuthUser } from './lib/permissions.ts';
import authRoutes from './routes/auth.ts';
import masters from './routes/masters.ts';
import taskRoutes from './routes/tasks.ts';
import admin from './routes/admin.ts';
import insights from './routes/insights.ts';
import noteRoutes from './routes/notes.ts';
import callRoutes from './routes/calls.ts';
import exploreRoutes from './routes/explore.ts';
import focusRoutes from './routes/focus.ts';
import draftRoutes from './routes/drafts.ts';
import discussionRoutes from './routes/discussions.ts';
import fileRoutes from './routes/files.ts';
import dashboardRoutes from './routes/dashboard.ts';
import followupRoutes from './routes/followups.ts';
import searchRoutes from './routes/search.ts';
import reviewRoutes from './routes/reviews.ts';
import exportRoutes from './routes/exports.ts';
import backupRoutes from './routes/backup.ts';
import importerRoutes from './routes/importer.ts';
import aiRoutes from './routes/ai.ts';
import notificationRoutes from './routes/notifications.ts';
import chatRoutes from './routes/chat.ts';
import meetingRoutes from './routes/meetings.ts';
import communityRoutes from './routes/community.ts';
import boardRoutes from './routes/boards.ts';
import taskReviewRoutes from './routes/taskreviews.ts';
import adoptionRoutes from './routes/adoption.ts';
import workloadRoutes from './routes/workload.ts';
import aiAssistRoutes from './routes/aiassist.ts';
import journalRoutes from './routes/journal.ts';
import work8Routes from './routes/work8.ts';
import vaultRoutes from './routes/vault.ts';
import { startScheduler } from './lib/scheduler.ts';
import { AiService, aiConfigFromEnv, type AiConfig } from './lib/ai.ts';

declare module 'fastify' {
  interface FastifyInstance { ai: AiService; db: Db; config: { secureCookies: boolean; dbPath: string }; throttle: Throttle; files: FileStore }
  interface FastifyRequest { user: AuthUser | null }
}

export interface AppOptions { scheduler?: boolean; ai?: Partial<AiConfig>; dbPath: string; filesDir?: string; secureCookies?: boolean; webDir?: string; logger?: boolean }
const PUBLIC = new Set(['/api/v1/health', '/api/v1/auth/status', '/api/v1/auth/register', '/api/v1/auth/login']);
export const CSRF_HEADER = 'command-centre';

export async function buildApp(opts: AppOptions) {
  if (opts.dbPath !== ':memory:') mkdirSync(dirname(opts.dbPath), { recursive: true });
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000 });
  app.decorate('db', openSqlite(opts.dbPath));
  app.decorate('config', { secureCookies: !!opts.secureCookies, dbPath: opts.dbPath });
  app.decorate('files', new LocalDiskStore(opts.filesDir ?? (opts.dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'cc-files-')) : join(dirname(opts.dbPath), 'files'))));
  app.decorate('throttle', createThrottle());
  app.decorate('ai', new AiService(app.db, { ...aiConfigFromEnv(), ...(opts.ai ?? {}) }, app.log));
  app.decorateRequest('user', null);
  app.addHook('onClose', async () => app.db.close());
  await app.register(cookie);

  // Tolerate empty JSON bodies (e.g. POST .../archive).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : undefined); } catch (e: any) { e.statusCode = 400; done(e); }
  });

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      // CSRF defence in depth: SameSite=Lax cookie + custom header + Origin check
      if (req.headers['x-requested-with'] !== CSRF_HEADER) throw new HttpError(403, 'CSRF', 'Missing request header');
      const origin = req.headers.origin;
      if (origin) { let host = ''; try { host = new URL(origin).host; } catch { /* invalid */ } if (host !== req.headers.host) throw new HttpError(403, 'CSRF', 'Cross-origin request blocked'); }
    }
    if (PUBLIC.has(path)) return;
    req.user = await userForToken(app.db, req.cookies[COOKIE]);
    if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in required');
    if (req.user.mustChangePassword && !['/api/v1/auth/me', '/api/v1/auth/change-password', '/api/v1/auth/logout'].includes(path))
      throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please choose a new password first');
    if (req.user.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && path !== '/api/v1/auth/view-as' && path !== '/api/v1/auth/logout')
      throw new HttpError(403, 'READ_ONLY', `You are only viewing as ${req.user.name} — nothing can be changed. Exit "View as" first.`);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), issues: err.issues } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  await app.register(async (api) => {
    api.get('/health', async () => ({ ok: true }));
    await api.register(authRoutes);
    await api.register(insights); // before masters so /people/performance wins over /people/:id
    await api.register(masters);
    await api.register(taskRoutes);
    await api.register(callRoutes);
    await api.register(focusRoutes);
    await api.register(draftRoutes);
    await api.register(discussionRoutes);
    await api.register(noteRoutes);
    await api.register(exploreRoutes);
    await api.register(fileRoutes);
    await api.register(dashboardRoutes);
    await api.register(followupRoutes);
    await api.register(searchRoutes);
    await api.register(reviewRoutes);
    await api.register(exportRoutes);
    await api.register(backupRoutes);
    await api.register(importerRoutes);
    await api.register(aiRoutes);
    await api.register(notificationRoutes);
    await api.register(chatRoutes);
    await api.register(meetingRoutes);
    await api.register(communityRoutes);
    await api.register(boardRoutes);
    await api.register(taskReviewRoutes);
    await api.register(adoptionRoutes);
    await api.register(workloadRoutes);
    await api.register(aiAssistRoutes);
    await api.register(journalRoutes);
    await api.register(work8Routes);
    await api.register(vaultRoutes);
    await api.register(admin);
  }, { prefix: '/api/v1' });

  // Short address for the AI status check: GET /api/ai/status (same answer as /api/v1/ai/status).
  app.get('/api/ai/status', (_req, reply) => reply.redirect('/api/v1/ai/status', 307));

  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fstatic, { root: opts.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } }) : reply.sendFile('index.html'));
  }
  if (opts.scheduler) startScheduler(app);
  await app.ready();
  return app;
}
