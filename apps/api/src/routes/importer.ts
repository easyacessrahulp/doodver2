import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidden, badRequest } from '../lib/errors.ts';
import { importPrototype } from '../lib/importProto.ts';

export default async function importerRoutes(app: FastifyInstance) {
  app.post('/import/prototype', { bodyLimit: 60 * 1024 * 1024 }, async (req) => {
    if (!req.user!.isAdmin) throw forbidden('Only Admins can import');
    const b = z.object({ data: z.any(), ownerName: z.string().max(100).optional() }).parse(req.body);
    try { return await importPrototype(app.db, app.files, req.user!.id, b.data, b.ownerName); } catch (e) { throw badRequest((e as Error).message); }
  });
}
