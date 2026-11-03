// v8: task templates, auto-chase queue, approvals, daily digest, weekly owner review.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { insertRow, updateRow, optText, dateOnly } from '../lib/crud.ts';
import { nowIso } from '../lib/db.ts';
import { accessibleCompanyIds, inClause, need, needTask, taskGuard } from '../lib/permissions.ts';
import { addDays, diffDays } from '../lib/dates.ts';
import { localDay } from '../lib/ai.ts';
import { chaseQueue } from '../lib/chase.ts';
import { buildDigest } from '../lib/digest.ts';
import { notify } from '../lib/notify.ts';
import { z as zz } from 'zod';

const today0 = () => localDay();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 08:30');

export default async function work8Routes(app: FastifyInstance) {
  const { db, ai } = app;

  // ───────── Templates ─────────
  const TplBody = z.object({
    name: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(300), description: optText(4000), priority: z.number().int().min(1).max(4).default(3), companyId: z.string().nullable().optional(),
    repeatFrequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']).nullable().optional(), repeatInterval: z.number().int().min(1).max(60).default(1),
    dueInDays: z.number().int().min(0).max(1000).nullable().optional(), remindDaysBefore: z.number().int().min(0).max(60).nullable().optional(),
    subtasks: z.array(z.object({ title: z.string().trim().min(1).max(300), dueInDays: z.number().int().min(0).max(1000).nullable().optional() })).max(60).default([]), shared: z.boolean().default(false) });
  const shape = (r: any) => ({ ...r, shared: !!r.shared, subtasks: (() => { try { return JSON.parse(r.subtasks); } catch { return []; } })() });
  app.get('/templates', async (req) => {
    const u = req.user!; const ids = await accessibleCompanyIds(db, u);
    const rows = await db.all<any>(`SELECT tp.*, c.name company_name, us.name owner_name FROM task_templates tp LEFT JOIN companies c ON c.id = tp.company_id JOIN users us ON us.id = tp.owner_id
      WHERE tp.archived_at IS NULL AND (tp.owner_id = ? OR (tp.shared = 1 AND (tp.company_id IS NULL ${ids ? `OR tp.company_id IN (${inClause(ids)})` : ''}))) ORDER BY tp.name COLLATE NOCASE`, [u.id, ...(ids ?? [])]);
    return { items: rows.map(shape) };
  });
  const tpl = async (req: any, id: string) => { const r = await db.get<any>('SELECT * FROM task_templates WHERE id = ? AND archived_at IS NULL', [id]); if (!r) throw notFound();
    if (r.ownerId !== req.user!.id && !req.user!.isAdmin) throw forbidden('Only the person who made a template can change it'); return r; };
  app.post('/templates', async (req, reply) => {
    const b = TplBody.parse(req.body); if (b.companyId) await need(db, req.user!, b.companyId, 'USER');
    const id = await insertRow(db, 'task_templates', { ownerId: req.user!.id, companyId: b.companyId ?? null, name: b.name, title: b.title, description: b.description ?? null, priority: b.priority, repeatFrequency: b.repeatFrequency ?? null,
      repeatInterval: b.repeatInterval, dueInDays: b.dueInDays ?? null, remindDaysBefore: b.remindDaysBefore ?? null, subtasks: JSON.stringify(b.subtasks), shared: b.shared }, req.user!.id);
    return reply.code(201).send(shape((await db.get<any>('SELECT * FROM task_templates WHERE id = ?', [id]))!));
  });
  app.patch('/templates/:id', async (req) => {
    const cur = await tpl(req, (req.params as any).id); const b = TplBody.partial().extend({ expectedUpdatedAt: z.string() }).parse(req.body);
    if (b.companyId) await need(db, req.user!, b.companyId, 'USER');
    const { expectedUpdatedAt, subtasks, ...rest } = b; const patch: any = { ...rest }; if (subtasks) patch.subtasks = JSON.stringify(subtasks);
    await updateRow(db, 'task_templates', cur.id, patch, expectedUpdatedAt, req.user!.id); return shape((await db.get<any>('SELECT * FROM task_templates WHERE id = ?', [cur.id]))!);
  });
  app.post('/templates/:id/archive', async (req) => { const cur = await tpl(req, (req.params as any).id); await updateRow(db, 'task_templates', cur.id, { archivedAt: nowIso() }, cur.updatedAt, req.user!.id); return { ok: true }; });

  // ───────── Auto-chase ─────────
  app.get('/chase', async (req) => {
    const q = z.object({ today: dateOnly.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    return chaseQueue(db, req.user!, q.today ?? today0(), q.limit);
  });
  app.post('/chase/snooze', async (req) => {
    const b = z.object({ taskId: z.string(), subtaskId: z.string().nullable().optional(), days: z.number().int().min(1).max(30).default(3), today: dateOnly.optional() }).parse(req.body);
    const t = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [b.taskId]); if (!t) throw notFound(); await needTask(db, req.user!, t, 'VIEWER');
    if (b.subtaskId && !(await db.get('SELECT 1 FROM subtasks WHERE id = ? AND task_id = ?', [b.subtaskId, b.taskId]))) throw badRequest('That subtask does not belong to this task');
    const until = addDays(b.today ?? today0(), b.days);
    await insertRow(db, 'chase_snooze', { userId: req.user!.id, taskId: b.taskId, subtaskId: b.subtaskId ?? null, untilDate: until }, req.user!.id); return { ok: true, until };
  });

  // ───────── Approvals ─────────
  const APPROVAL_SQL = `SELECT a.*, c.name company_name, c.color company_color, r.name requester_name, ap.name approver_name, t.title task_title FROM approvals a JOIN companies c ON c.id = a.company_id
    JOIN users r ON r.id = a.requester_id JOIN users ap ON ap.id = a.approver_id LEFT JOIN tasks t ON t.id = a.task_id`;
  app.get('/approvals', async (req) => {
    const q = z.object({ box: z.enum(['inbox', 'sent', 'all']).default('all'), status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional() }).parse(req.query); const u = req.user!;
    const where = ['a.archived_at IS NULL']; const p: any[] = [];
    if (q.box === 'inbox') { where.push('a.approver_id = ?'); p.push(u.id); } else if (q.box === 'sent') { where.push('a.requester_id = ?'); p.push(u.id); } else { where.push('(a.approver_id = ? OR a.requester_id = ?)'); p.push(u.id, u.id); }
    if (q.status) { where.push('a.status = ?'); p.push(q.status); }
    const items = await db.all<any>(`${APPROVAL_SQL} WHERE ${where.join(' AND ')} ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC LIMIT 200`, p);
    return { items: items.map((x) => ({ ...x, mine: x.approverId === u.id, canDecide: x.approverId === u.id && x.status === 'PENDING', canCancel: x.requesterId === u.id && x.status === 'PENDING' })) };
  });
  app.get('/approvals/count', async (req) => ({ inbox: (await db.get<any>("SELECT COUNT(*) n FROM approvals WHERE approver_id = ? AND status = 'PENDING' AND archived_at IS NULL", [req.user!.id]))!.n }));
  app.get('/approvals/approvers', async (req) => {     // who can be asked: active users who can see the company
    const q = z.object({ companyId: z.string() }).parse(req.query); await need(db, req.user!, q.companyId, 'USER');
    const rows = await db.all<any>(`SELECT id, name FROM users WHERE active = 1 AND archived_at IS NULL AND id <> ? AND (is_admin = 1 OR id IN (SELECT user_id FROM company_memberships WHERE company_id = ? AND archived_at IS NULL AND role IN ('MANAGER','USER','MEMBER'))) ORDER BY name`, [req.user!.id, q.companyId]);
    return { items: rows };
  });
  app.post('/approvals', async (req, reply) => {
    const b = z.object({ companyId: z.string(), approverId: z.string(), title: z.string().trim().min(1).max(200), details: optText(4000), amount: z.string().trim().max(60).nullable().optional(), taskId: z.string().nullable().optional() }).parse(req.body); const u = req.user!;
    await need(db, u, b.companyId, 'USER'); if (b.approverId === u.id) throw badRequest('Choose someone else to approve it');
    const ap = await db.get<any>('SELECT id, name, is_admin FROM users WHERE id = ? AND active = 1', [b.approverId]); if (!ap) throw badRequest('Choose who should approve it');
    if (!ap.isAdmin && !(await db.get('SELECT 1 FROM company_memberships WHERE user_id = ? AND company_id = ? AND archived_at IS NULL', [b.approverId, b.companyId]))) throw badRequest(`${ap.name} cannot see this company, so cannot approve it`);
    if (b.taskId) { const t = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [b.taskId]); if (!t || t.companyId !== b.companyId) throw badRequest('That task is not in this company'); await needTask(db, u, t, 'USER'); }
    const id = await insertRow(db, 'approvals', { companyId: b.companyId, taskId: b.taskId ?? null, requesterId: u.id, approverId: b.approverId, title: b.title, details: b.details ?? null, amount: b.amount ?? null, status: 'PENDING' }, u.id);
    await notify(db, { userId: b.approverId, kind: 'APPROVAL_REQUEST', title: `Approval needed: ${b.title}`, body: `${u.name} asks for your approval${b.amount ? ` (${b.amount})` : ''}.`, companyId: b.companyId, taskId: b.taskId ?? null, link: 'approvals', actorId: u.id, groupKey: `appr:${id}` });
    return reply.code(201).send((await db.get<any>(`${APPROVAL_SQL} WHERE a.id = ?`, [id]))!);
  });
  const decideBody = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().max(1000).nullable().optional() });
  app.post('/approvals/:id/decide', async (req) => {
    const a = await db.get<any>('SELECT * FROM approvals WHERE id = ? AND archived_at IS NULL', [(req.params as any).id]); if (!a) throw notFound();
    if (a.approverId !== req.user!.id) throw forbidden('Only the person asked can approve or reject this'); if (a.status !== 'PENDING') throw badRequest('This has already been decided');
    const b = decideBody.parse(req.body); if (b.decision === 'REJECTED' && !b.note) throw badRequest('Please say why it is rejected');
    await updateRow(db, 'approvals', a.id, { status: b.decision, decidedAt: nowIso(), decisionNote: b.note ?? null }, a.updatedAt, req.user!.id);
    await notify(db, { userId: a.requesterId, kind: 'APPROVAL_DECIDED', title: `${b.decision === 'APPROVED' ? 'Approved' : 'Rejected'}: ${a.title}`, body: b.note ?? null, companyId: a.companyId, taskId: a.taskId, link: 'approvals', actorId: req.user!.id, groupKey: `appr-d:${a.id}` });
    return (await db.get<any>(`${APPROVAL_SQL} WHERE a.id = ?`, [a.id]))!;
  });
  app.post('/approvals/:id/cancel', async (req) => {
    const a = await db.get<any>('SELECT * FROM approvals WHERE id = ? AND archived_at IS NULL', [(req.params as any).id]); if (!a) throw notFound();
    if (a.requesterId !== req.user!.id) throw forbidden('Only the person who asked can cancel it'); if (a.status !== 'PENDING') throw badRequest('This has already been decided');
    await updateRow(db, 'approvals', a.id, { status: 'CANCELLED', decidedAt: nowIso() }, a.updatedAt, req.user!.id); return { ok: true };
  });

  // ───────── Daily digest ─────────
  const prefsOf = async (userId: string) => {
    let p = await db.get<any>('SELECT * FROM digest_prefs WHERE user_id = ?', [userId]);
    if (!p) { await insertRow(db, 'digest_prefs', { userId, enabled: true, morning: '08:30', evening: '18:30' }, userId); p = await db.get<any>('SELECT * FROM digest_prefs WHERE user_id = ?', [userId]); }
    return p;
  };
  const prefShape = (p: any) => ({ enabled: !!p.enabled, morning: p.morning, evening: p.evening, phone: p.phone ?? null });
  app.get('/digest/prefs', async (req) => prefShape(await prefsOf(req.user!.id)));
  app.put('/digest/prefs', async (req) => {
    const b = z.object({ enabled: z.boolean(), morning: hhmm, evening: hhmm, phone: z.string().trim().max(30).nullable().optional() }).parse(req.body);
    const p = await prefsOf(req.user!.id); await updateRow(db, 'digest_prefs', p.id, { enabled: b.enabled, morning: b.morning, evening: b.evening, phone: b.phone || null }, p.updatedAt, req.user!.id);
    return prefShape((await db.get<any>('SELECT * FROM digest_prefs WHERE id = ?', [p.id]))!);
  });
  app.get('/digest', async (req) => {
    const q = z.object({ kind: z.enum(['morning', 'evening']).default('morning'), today: dateOnly.optional() }).parse(req.query);
    const p = await prefsOf(req.user!.id); return { ...(await buildDigest(db, req.user!, q.today ?? today0(), q.kind)), phone: p.phone ?? null };
  });

  // ───────── Weekly owner review ─────────
  async function weekly(req: any, end: string) {
    const u = req.user!; const ids = await accessibleCompanyIds(db, u); const g = taskGuard(u, 't'); const start = addDays(end, -6); const prevStart = addDays(start, -7); const prevEnd = addDays(start, -1);
    const where = ['t.archived_at IS NULL', g.sql]; const p: any[] = [...g.params]; if (ids) { where.push(`t.company_id IN (${inClause(ids)})`); p.push(...ids); }
    const rows = await db.all<any>(`SELECT t.id, t.title, t.status, t.priority, t.due_date, t.created_at, t.completed_at, t.last_activity_at, t.postpone_count, t.waiting_for, t.delegated_to_id, t.ai_excluded, COALESCE(pj.ai_excluded,0) pj_private,
      t.company_id, c.name company_name, c.short_name company_short, c.color company_color, pe.name delegated_name FROM tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN projects pj ON pj.id = t.project_id LEFT JOIN people pe ON pe.id = t.delegated_to_id WHERE ${where.join(' AND ')}`, p);
    const day = (s: string | null) => (s ? String(s).slice(0, 10) : '');
    const inR = (s: string | null, a: string, b: string) => !!s && day(s) >= a && day(s) <= b;
    const doneNow = rows.filter((r) => r.status === 'DONE' && inR(r.completedAt, start, end)); const donePrev = rows.filter((r) => r.status === 'DONE' && inR(r.completedAt, prevStart, prevEnd));
    const created = rows.filter((r) => inR(r.createdAt, start, end)); const open = rows.filter((r) => r.status !== 'DONE');
    const overdue = open.filter((r) => r.dueDate && r.dueDate < end);
    const onTime = doneNow.filter((r) => !r.dueDate || day(r.completedAt) <= r.dueDate);
    const stalled = open.filter((r) => diffDays(day(r.lastActivityAt), end) >= 7).sort((a, b) => String(a.lastActivityAt).localeCompare(String(b.lastActivityAt)));
    const slipping = open.filter((r) => r.postponeCount >= 2).sort((a, b) => b.postponeCount - a.postponeCount);
    const pick = (r: any) => ({ id: r.id, title: r.title, company: r.companyShort ?? r.companyName, companyColor: r.companyColor, dueDate: r.dueDate, person: r.delegatedName ?? null, isPrivate: !!(r.aiExcluded || r.pjPrivate),
      overdueDays: r.dueDate && r.dueDate < end ? diffDays(r.dueDate, end) : 0, quietDays: diffDays(day(r.lastActivityAt), end), postponed: r.postponeCount });
    const co = new Map<string, any>(); for (const r of rows) { const c = co.get(r.companyId) ?? { companyId: r.companyId, name: r.companyShort ?? r.companyName, color: r.companyColor, created: 0, done: 0, open: 0, overdue: 0 }; co.set(r.companyId, c);
      if (inR(r.createdAt, start, end)) c.created++; if (r.status === 'DONE' && inR(r.completedAt, start, end)) c.done++; if (r.status !== 'DONE') { c.open++; if (r.dueDate && r.dueDate < end) c.overdue++; } }
    const pp = new Map<string, any>(); const bump = (name: string, k: 'open' | 'overdue' | 'done') => { const x = pp.get(name) ?? { name, open: 0, overdue: 0, done: 0 }; x[k]++; pp.set(name, x); };
    for (const r of rows) { const nm = r.delegatedName; if (!nm) continue; if (r.status === 'DONE') { if (inR(r.completedAt, start, end)) bump(nm, 'done'); } else { bump(nm, 'open'); if (r.dueDate && r.dueDate < end) bump(nm, 'overdue'); } }
    const tids = rows.map((r) => r.id);
    if (tids.length) { const subs = await db.all<any>(`SELECT s.status, s.due_date, s.completed_at, pe.name FROM subtasks s JOIN people pe ON pe.id = s.assignee_id WHERE s.archived_at IS NULL AND s.task_id IN (${inClause(tids)})`, tids);
      for (const s of subs) { if (s.status === 'DONE') { if (inR(s.completedAt, start, end)) bump(s.name, 'done'); } else { bump(s.name, 'open'); if (s.dueDate && s.dueDate < end) bump(s.name, 'overdue'); } } }
    const people = [...pp.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open);
    const wins: string[] = []; const concerns: string[] = [];
    if (doneNow.length) wins.push(`${doneNow.length} task${doneNow.length === 1 ? '' : 's'} completed${donePrev.length ? ` (last week ${donePrev.length})` : ''}.`);
    if (doneNow.length >= 3 && onTime.length === doneNow.length) wins.push('Everything finished this week was on time.');
    if (overdue.length) concerns.push(`${overdue.length} task${overdue.length === 1 ? ' is' : 's are'} overdue.`);
    if (stalled.length) concerns.push(`${stalled.length} task${stalled.length === 1 ? ' has' : 's have'} had no update for a week or more.`);
    if (slipping.length) concerns.push(`${slipping.length} task${slipping.length === 1 ? ' has' : 's have'} been postponed twice or more.`);
    const worst = people.find((x) => x.overdue >= 2); if (worst) concerns.push(`${worst.name} has ${worst.overdue} overdue items.`);
    return { start, end, totals: { created: created.length, done: doneNow.length, donePrev: donePrev.length, open: open.length, overdue: overdue.length, onTimePct: doneNow.length ? Math.round((onTime.length / doneNow.length) * 100) : null, stalled: stalled.length, slipping: slipping.length },
      companies: [...co.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open), people, stalled: stalled.slice(0, 10).map(pick), slipping: slipping.slice(0, 8).map(pick), overdue: overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 10).map(pick), wins, concerns };
  }
  const weekQ = z.object({ end: dateOnly.optional() });
  app.get('/owner/weekly', async (req) => weekly(req, weekQ.parse(req.query).end ?? today0()));
  app.post('/owner/weekly/ai', async (req) => {
    const end = weekQ.parse(req.body ?? {}).end ?? today0(); ai.assertEnabled(); const w = await weekly(req, end);
    const safe = (l: any[]) => l.map((x) => (x.isPrivate ? `(private task) ${x.company}` : `${x.title} [${x.company}${x.person ? ', ' + x.person : ''}${x.overdueDays ? ', ' + x.overdueDays + 'd overdue' : ''}${x.quietDays >= 7 ? ', quiet ' + x.quietDays + 'd' : ''}]`));
    const data = [`Week ${w.start} to ${w.end}`, `Totals: ${JSON.stringify(w.totals)}`, `Companies: ${JSON.stringify(w.companies.map((c: any) => ({ n: c.name, created: c.created, done: c.done, open: c.open, overdue: c.overdue })))}`,
      `People: ${JSON.stringify(w.people)}`, `Overdue: ${safe(w.overdue).join('; ')}`, `Quiet 7+ days: ${safe(w.stalled).join('; ')}`, `Postponed often: ${safe(w.slipping).join('; ')}`].join('\n');
    const system = `You write a weekly review for a business owner in India who runs several companies. Use ONLY the numbers and items in DATA. Never invent names, figures or dates. Be brief, plain and practical.
Reply with ONE JSON object: {"headline": one sentence, "wins": array of up to 4 short strings, "concerns": array of up to 5 short strings, "suggestions": array of up to 4 short, specific actions for next week}.`;
    const r = await ai.chatJson({ userId: req.user!.id, kind: 'weekly', system, user: `DATA:\n${data}`, schema: zz.object({ headline: zz.string().trim().min(1).max(300), wins: zz.array(zz.string().max(300)).max(6).catch([]), concerns: zz.array(zz.string().max(300)).max(8).catch([]), suggestions: zz.array(zz.string().max(300)).max(6).catch([]) }), maxTokens: 700, temperature: 0.3 });
    return r.data;
  });
}
