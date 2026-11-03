import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { insertRow, listPage, optDate, optText, pageQuery, prio, setArchived, updateRow } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.ts';
import { accessibleCompanyIds, inClause, need, projectGuard, roleFor } from '../lib/permissions.ts';

const exp = { expectedUpdatedAt: z.string() };
const idParam = (req: any) => (req.params as { id: string }).id;

export default async function masters(app: FastifyInstance) {
  const { db } = app;

  // ───────── Companies (Admin writes; members read) ─────────
  const companyFields = {
    name: z.string().trim().min(1).max(200), shortName: optText(50), color: optText(20),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/, '2-12 letters/digits'),
    description: optText(), active: z.boolean(), contact: optText(500), notes: optText(),
  };
  const companyCreate = z.object({ ...companyFields, active: companyFields.active.default(true) });
  const companyUpdate = z.object({ ...exp, ...companyFields }).partial().required({ expectedUpdatedAt: true });

  app.get('/companies', async (req) => {
    const q = pageQuery.parse(req.query);
    const ids = await accessibleCompanyIds(db, req.user!);
    const where = [q.archived === 'true' ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL']; const params: any[] = [];
    if (ids) { where.push(`c.id IN (${inClause(ids)})`); params.push(...ids); }
    if (q.q) { where.push('(c.name LIKE ? OR c.code LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    return listPage(db, { select: 'c.*', from: 'companies c', alias: 'c', where, params, limit: q.limit, cursor: q.cursor });
  });
  app.get('/companies/:id', async (req) => {
    await need(db, req.user!, idParam(req), 'VIEWER');
    const c = await db.get('SELECT * FROM companies WHERE id = ?', [idParam(req)]); if (!c) throw notFound(); return c;
  });
  app.post('/companies', async (req, reply) => {
    if (!req.user!.isAdmin) throw forbidden('Only Admins can create companies');
    const b = companyCreate.parse(req.body);
    const id = await insertRow(db, 'companies', b, req.user!.id);
    await audit(db, { companyId: id, entityType: 'COMPANY', entityId: id, action: 'CREATED', userId: req.user!.id });
    return reply.code(201).send(await db.get('SELECT * FROM companies WHERE id = ?', [id]));
  });
  app.patch('/companies/:id', async (req) => {
    if (!req.user!.isAdmin) throw forbidden('Only Admins can edit companies');
    const { expectedUpdatedAt, ...patch } = companyUpdate.parse(req.body);
    const row = await updateRow(db, 'companies', idParam(req), patch, expectedUpdatedAt, req.user!.id);
    await audit(db, { companyId: row.id, entityType: 'COMPANY', entityId: row.id, action: 'UPDATED', detail: Object.keys(patch), userId: req.user!.id });
    return row;
  });
  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/companies/:id/${verb}`, async (req) => {
      if (!req.user!.isAdmin) throw forbidden('Only Admins can archive or restore companies');
      const row = await setArchived(db, 'companies', idParam(req), on, req.user!.id);
      await audit(db, { companyId: row.id, entityType: 'COMPANY', entityId: row.id, action: on ? 'ARCHIVED' : 'RESTORED', userId: req.user!.id });
      return row;
    });

  // ───────── Projects (Manager+ writes) ─────────
  const projectFields = {
    companyId: z.string(), name: z.string().trim().min(1).max(200), description: optText(), ownerId: z.string().nullable().optional(),
    startDate: optDate, targetDate: optDate, priority: prio,
    status: z.enum(['NOT_STARTED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']), aiExcluded: z.boolean(),
  };
  const projectCreate = z.object({ ...projectFields, priority: projectFields.priority.default(3), status: projectFields.status.default('ACTIVE'), aiExcluded: projectFields.aiExcluded.default(false) });
  const projectUpdate = z.object({ ...exp, ...projectFields }).partial().required({ expectedUpdatedAt: true });
  const projectDup = async (companyId: string, name: string, exceptId?: string) => {
    const d = await db.get('SELECT 1 FROM projects WHERE company_id = ? AND LOWER(name) = LOWER(?) AND archived_at IS NULL AND id <> ?', [companyId, name, exceptId ?? '']);
    if (d) throw new HttpError(409, 'DUPLICATE', 'This company already has a project with that name');
  };

  app.get('/projects', async (req) => {
    const q = pageQuery.extend({ companyId: z.string().optional(), status: z.string().optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, req.user!);
    const where = [q.archived === 'true' ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL']; const params: any[] = [];
    if (q.companyId) { where.push('p.company_id = ?'); params.push(q.companyId); }
    else if (ids) { where.push(`p.company_id IN (${inClause(ids)})`); params.push(...ids); }
    { const g = projectGuard(req.user!, 'p'); where.push(g.sql); params.push(...g.params); }
    if (q.status) { where.push('p.status = ?'); params.push(q.status); }
    if (q.q) { where.push('p.name LIKE ?'); params.push(`%${q.q}%`); }
    return listPage(db, { select: 'p.*, c.name AS company_name', from: 'projects p JOIN companies c ON c.id = p.company_id', alias: 'p', where, params, limit: q.limit, cursor: q.cursor });
  });
  app.get('/projects/:id', async (req) => {
    const p = await db.get<any>('SELECT * FROM projects WHERE id = ?', [idParam(req)]); if (!p) throw notFound();
    await need(db, req.user!, p.companyId, 'VIEWER');
    { const g = projectGuard(req.user!, 'p'); if (!(await db.get(`SELECT 1 FROM projects p WHERE p.id = ? AND ${g.sql}`, [p.id, ...g.params]))) throw notFound(); }
    return p;
  });
  app.post('/projects', async (req, reply) => {
    const b = projectCreate.parse(req.body);
    if ((await roleFor(db, req.user!, b.companyId)) === 'MEMBER') await need(db, req.user!, b.companyId, 'MEMBER'); else await need(db, req.user!, b.companyId, 'MANAGER');
    await projectDup(b.companyId, b.name);
    const id = await insertRow(db, 'projects', b, req.user!.id);
    await audit(db, { companyId: b.companyId, entityType: 'PROJECT', entityId: id, action: 'CREATED', userId: req.user!.id });
    return reply.code(201).send(await db.get('SELECT * FROM projects WHERE id = ?', [id]));
  });
  app.patch('/projects/:id', async (req) => {
    const cur = await db.get<any>('SELECT * FROM projects WHERE id = ?', [idParam(req)]); if (!cur) throw notFound();
    await need(db, req.user!, cur.companyId, 'MANAGER');
    const { expectedUpdatedAt, ...patch } = projectUpdate.parse(req.body);
    if (patch.companyId && patch.companyId !== cur.companyId) throw badRequest('A project cannot be moved to another company');
    if (patch.name) await projectDup(cur.companyId, patch.name, cur.id);
    const row = await updateRow(db, 'projects', cur.id, patch, expectedUpdatedAt, req.user!.id);
    await audit(db, { companyId: cur.companyId, entityType: 'PROJECT', entityId: cur.id, action: 'UPDATED', detail: Object.keys(patch), userId: req.user!.id });
    return row;
  });
  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/projects/:id/${verb}`, async (req) => {
      const cur = await db.get<any>('SELECT * FROM projects WHERE id = ?', [idParam(req)]); if (!cur) throw notFound();
      await need(db, req.user!, cur.companyId, 'MANAGER');
      const row = await setArchived(db, 'projects', cur.id, on, req.user!.id);
      await audit(db, { companyId: cur.companyId, entityType: 'PROJECT', entityId: cur.id, action: on ? 'ARCHIVED' : 'RESTORED', userId: req.user!.id });
      return row;
    });

  // ───────── People (Manager+ writes; companyId null = shared, Admin only) ─────────
  const personFields = {
    companyId: z.string().nullable().optional(), name: z.string().trim().min(1).max(200), designation: optText(200), department: optText(200),
    email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)), phone: optText(50),
    reportsToId: z.string().nullable().optional(), active: z.boolean(), notes: optText(),
  };
  const personCreate = z.object({ ...personFields, active: personFields.active.default(true) });
  const personUpdate = z.object({ ...exp, ...personFields }).partial().required({ expectedUpdatedAt: true });
  const canWritePerson = async (req: any, companyId: string | null) => {
    if (companyId) await need(db, req.user!, companyId, 'MANAGER');
    else if (!req.user!.isAdmin) throw forbidden('Only Admins can manage shared people');
  };

  app.get('/people', async (req) => {
    const q = pageQuery.extend({ companyId: z.string().optional(), all: z.enum(['true']).optional() }).parse(req.query);
    if (q.companyId && !q.all) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, req.user!);
    const where = [q.archived === 'true' ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL']; const params: any[] = [];
    if (q.companyId && !q.all) { where.push('(p.company_id = ? OR p.company_id IS NULL)'); params.push(q.companyId); }
    else if (ids) { where.push(`(p.company_id IS NULL OR p.company_id IN (${inClause(ids)}))`); params.push(...ids); }
    if (q.q) { where.push('(p.name LIKE ? OR p.email LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    return listPage(db, { select: 'p.*, c.name AS company_name', from: 'people p LEFT JOIN companies c ON c.id = p.company_id', alias: 'p', where, params, limit: q.limit, cursor: q.cursor });
  });
  app.get('/people/:id', async (req) => {
    const p = await db.get<any>('SELECT * FROM people WHERE id = ?', [idParam(req)]); if (!p) throw notFound();
    if (p.companyId) await need(db, req.user!, p.companyId, 'VIEWER'); return p;
  });
  app.post('/people', async (req, reply) => {
    const b = personCreate.parse(req.body);
    await canWritePerson(req, b.companyId ?? null);
    const id = await insertRow(db, 'people', { ...b, companyId: b.companyId ?? null }, req.user!.id);
    await audit(db, { companyId: b.companyId ?? null, entityType: 'PERSON', entityId: id, action: 'CREATED', userId: req.user!.id });
    return reply.code(201).send(await db.get('SELECT * FROM people WHERE id = ?', [id]));
  });
  app.patch('/people/:id', async (req) => {
    const cur = await db.get<any>('SELECT * FROM people WHERE id = ?', [idParam(req)]); if (!cur) throw notFound();
    if (cur.companyId) await need(db, req.user!, cur.companyId, 'VIEWER'); // existence check first
    await canWritePerson(req, cur.companyId);
    const { expectedUpdatedAt, ...patch } = personUpdate.parse(req.body);
    if ('companyId' in patch && (patch.companyId ?? null) !== cur.companyId) throw badRequest('A person cannot be moved to another company');
    const row = await updateRow(db, 'people', cur.id, patch, expectedUpdatedAt, req.user!.id);
    await audit(db, { companyId: cur.companyId, entityType: 'PERSON', entityId: cur.id, action: 'UPDATED', detail: Object.keys(patch), userId: req.user!.id });
    return row;
  });
  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/people/:id/${verb}`, async (req) => {
      const cur = await db.get<any>('SELECT * FROM people WHERE id = ?', [idParam(req)]); if (!cur) throw notFound();
      if (cur.companyId) await need(db, req.user!, cur.companyId, 'VIEWER');
      await canWritePerson(req, cur.companyId);
      const row = await setArchived(db, 'people', cur.id, on, req.user!.id);
      await audit(db, { companyId: cur.companyId, entityType: 'PERSON', entityId: cur.id, action: on ? 'ARCHIVED' : 'RESTORED', userId: req.user!.id });
      return row;
    });
}
