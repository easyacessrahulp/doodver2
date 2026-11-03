import type { FastifyInstance } from 'fastify';
import { HttpError } from '../lib/errors.ts';
import { clearDemo, demoStatus, loadDemo } from '../lib/demo.ts';

export default async function admin(app: FastifyInstance) {
  const guard = (req: any) => { if (!req.user!.isAdmin) throw new HttpError(403, 'FORBIDDEN', 'Admin only'); };
  app.get('/admin/demo-data', async (req) => { guard(req); return demoStatus(app.db); });
  app.post('/admin/demo-data/load', async (req) => { guard(req); const r = await loadDemo(app.db, req.user!.id); return { ...r, ...(await demoStatus(app.db)) }; });
  app.post('/admin/demo-data/clear', async (req) => { guard(req); await clearDemo(app.db, req.user!.id); return demoStatus(app.db); });
}
