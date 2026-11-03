import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { HttpError, badRequest, forbidden } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { applyBackup, autoBackup, buildBackup, validateBackup, type Parsed, type Report } from '../lib/backup.ts';

// Full backup / restore. Admin only. Restore = auto-backup current → validate → report → explicit confirmation → Replace or Merge.
export default async function backupRoutes(app: FastifyInstance) {
  const { db } = app;
  const admin = (req: any) => { if (!req.user!.isAdmin) throw forbidden('Only Admins can back up or restore'); };
  const pending = new Map<string, { parsed: Parsed; report: Report; expires: number }>();

  app.get('/backup', async (req, reply) => {
    admin(req);
    const buf = await buildBackup(db, app.files, '2.0');
    await audit(db, { entityType: 'BACKUP', entityId: 'backup', action: 'BACKUP_DOWNLOADED', userId: req.user!.id });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="dood-backup-${stamp}.zip"`).send(buf);
  });

  app.post('/restore/validate', { bodyLimit: 150 * 1024 * 1024 }, async (req) => {
    admin(req);
    const { dataBase64 } = z.object({ dataBase64: z.string().min(10) }).parse(req.body);
    const { parsed, report } = await validateBackup(db, app.files, Buffer.from(dataBase64.replace(/^data:[^,]*,/, ''), 'base64'));
    for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
    let token: string | null = null;
    if (parsed && report.ok) { token = randomBytes(16).toString('hex'); pending.set(token, { parsed, report, expires: Date.now() + 15 * 60_000 }); }
    return { token, ...report };
  });

  app.post('/restore/apply', async (req) => {
    admin(req);
    const b = z.object({ token: z.string(), mode: z.enum(['REPLACE', 'MERGE']), confirm: z.literal('RESTORE') }).parse(req.body);
    const p = pending.get(b.token); if (!p || p.expires < Date.now()) throw badRequest('This check has expired. Choose the file again.');
    const blocking = b.mode === 'REPLACE' ? p.report.replaceErrors : p.report.mergeErrors;
    if (blocking.length) throw new HttpError(409, 'RESTORE_BLOCKED', `${b.mode === 'REPLACE' ? 'Replace' : 'Merge'} would break references or collide with existing records.`, { problems: blocking });
    const safety = await autoBackup(db, app.config.dbPath, 'before-restore');       // always keep what is there now
    const out = await applyBackup(db, app.files, p.parsed, b.mode);
    pending.delete(b.token);
    await audit(db, { entityType: 'BACKUP', entityId: 'restore', action: `RESTORE_${b.mode}`, detail: { counts: out.result }, userId: req.user!.id }).catch(() => undefined);
    return { ok: true, mode: b.mode, safetyCopy: safety, signedOut: b.mode === 'REPLACE', ...out };
  });
}
