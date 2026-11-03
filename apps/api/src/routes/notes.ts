import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId, nowIso } from '../lib/db.ts';
import { insertRow, optDate, optText, setArchived, updateRow } from '../lib/crud.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { accessibleCompanyIds, inClause, need, needRow, needTask, rowGuard, taskGuard, roleFor } from '../lib/permissions.ts';
import { DRAFT_SYSTEM, DraftSchema, formatDate, plainDraft } from '../lib/noteDraft.ts';
import { taskAccess } from '../lib/aiContext.ts';
import { HttpError } from '../lib/errors.ts';
import { localDay } from '../lib/ai.ts';
import { DOCX_MIME, PALETTE, brandColor, buildDocx, formalNoteDocx, heading, muted, para, safeName, table, textToBlocks } from '../lib/word.ts';

const SELECT = `n.*, t.title AS task_title, s.title AS subtask_title, c.name AS company_name, u.name AS author_name`;
const FROM = `notes n JOIN tasks t ON t.id = n.task_id JOIN companies c ON c.id = n.company_id LEFT JOIN subtasks s ON s.id = n.subtask_id LEFT JOIN users u ON u.id = n.created_by_id`;
const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Calcutta' }) : '');

/**
 * Notes: a free-text / bullet-point editor attached to a task or a subtask. A note can be made an INTERNAL NOTE of its company,
 * exported to Word, shared to Discussions, and revised later — every save keeps a numbered version.
 */
export default async function noteRoutes(app: FastifyInstance) {
  const { db } = app;
  const one = async (id: string) => (await db.get<any>(`SELECT ${SELECT}, d.done_at AS discussion_done_at FROM ${FROM} LEFT JOIN discussions d ON d.id = n.discussion_id WHERE n.id = ?`, [id]))!;
  /** Name + colour for the page header: the company the author chose, else the note's own company. Must be one the reader may see. */
  const brandOf = async (user: any, fallbackCompanyId: string, chosenId?: string | null, colorKey?: string | null, label?: string) => {
    const cid = chosenId || fallbackCompanyId; await need(db, user, cid, 'VIEWER');
    const co = await db.get<any>('SELECT name, code FROM companies WHERE id = ?', [cid]); if (!co) throw notFound();
    return { name: co.name as string, color: brandColor(colorKey, co.code ?? co.name), label };
  };
  const load = async (id: string, user: any, min: 'VIEWER' | 'USER') => { const n = await db.get<any>('SELECT * FROM notes WHERE id = ?', [id]); if (!n) throw notFound(); await needRow(db, user, n, min); return n; };

  app.get('/notes', async (req) => {
    const q = z.object({ companyId: z.string().optional(), taskId: z.string().optional(), subtaskId: z.string().optional(), kind: z.enum(['DRAFT', 'INTERNAL']).optional(), q: z.string().optional(), archived: z.enum(['true']).optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = await accessibleCompanyIds(db, req.user!);
    const where = [q.archived ? 'n.archived_at IS NOT NULL' : 'n.archived_at IS NULL']; const params: any[] = [];
    if (q.companyId) { where.push('n.company_id = ?'); params.push(q.companyId); } else if (ids) { where.push(`n.company_id IN (${inClause(ids)})`); params.push(...ids); }
    { const g = rowGuard(req.user!, 'n'); where.push(g.sql); params.push(...g.params); }
    if (q.taskId) { where.push('n.task_id = ?'); params.push(q.taskId); }
    if (q.subtaskId) { where.push('n.subtask_id = ?'); params.push(q.subtaskId); }
    if (q.kind) { where.push('n.kind = ?'); params.push(q.kind); }
    if (q.q) { where.push('(n.title LIKE ? OR n.body LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    return { items: await db.all(`SELECT ${SELECT}, d.done_at AS discussion_done_at FROM ${FROM} LEFT JOIN discussions d ON d.id = n.discussion_id WHERE ${where.join(' AND ')} ORDER BY n.updated_at DESC LIMIT 500`, params) };
  });

  app.get('/notes/:id', async (req) => {
    const n = await load((req.params as any).id, req.user!, 'VIEWER');
    const versions = await db.all(`SELECT v.id, v.version, v.title, v.body, v.change_note, v.created_at, u.name AS author_name FROM note_versions v LEFT JOIN users u ON u.id = v.created_by_id WHERE v.note_id = ? ORDER BY v.version DESC`, [n.id]);
    const discussion = n.discussionId ? await db.get<any>('SELECT id, topic, done_at, discussion_notes, decisions, due_date FROM discussions WHERE id = ?', [n.discussionId]) : null;
    return { ...(await one(n.id)), versions, discussion, draft: n.draftJson ? JSON.parse(n.draftJson) : null };
  });

  app.post('/notes', async (req, reply) => {
    const b = z.object({ taskId: z.string(), subtaskId: z.string().nullable().optional(), title: z.string().trim().min(1).max(200), body: z.string().max(50000).default(''), kind: z.enum(['DRAFT', 'INTERNAL']).default('DRAFT') }).parse(req.body);
    const task = await db.get<any>('SELECT id, company_id FROM tasks WHERE id = ?', [b.taskId]); if (!task) throw notFound();
    await needTask(db, req.user!, task, 'USER');
    if (b.subtaskId && !(await db.get('SELECT 1 FROM subtasks WHERE id = ? AND task_id = ?', [b.subtaskId, b.taskId]))) throw badRequest('That subtask does not belong to this task');
    const id = await db.tx(async (t) => {
      const nid = await insertRow(t, 'notes', { ...b, subtaskId: b.subtaskId ?? null, companyId: task.companyId, version: 1 }, req.user!.id);
      await insertRow(t, 'note_versions', { noteId: nid, companyId: task.companyId, version: 1, title: b.title, body: b.body, changeNote: 'First version' }, req.user!.id);
      await audit(t, { companyId: task.companyId, entityType: 'TASK', entityId: b.taskId, action: 'NOTE_ADDED', detail: { title: b.title, subtaskId: b.subtaskId ?? null }, userId: req.user!.id });
      return nid;
    });
    return reply.code(201).send(await one(id));
  });

  app.patch('/notes/:id', async (req) => {
    const cur = await load((req.params as any).id, req.user!, 'USER');
    const b = z.object({ expectedUpdatedAt: z.string(), title: z.string().trim().min(1).max(200).optional(), body: z.string().max(50000).optional(), kind: z.enum(['DRAFT', 'INTERNAL']).optional(), changeNote: optText(500) }).parse(req.body);
    const { expectedUpdatedAt, changeNote, ...patch } = b;
    const textChanged = (patch.title !== undefined && patch.title !== cur.title) || (patch.body !== undefined && patch.body !== cur.body);
    await db.tx(async (t) => {
      if (textChanged) {
        const version = cur.version + 1;
        await updateRow(t, 'notes', cur.id, { ...patch, version }, expectedUpdatedAt, req.user!.id);
        await insertRow(t, 'note_versions', { noteId: cur.id, companyId: cur.companyId, version, title: patch.title ?? cur.title, body: patch.body ?? cur.body, changeNote: changeNote ?? null }, req.user!.id);
        await audit(t, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.taskId, action: 'NOTE_REVISED', detail: { title: patch.title ?? cur.title, version, changeNote: changeNote ?? null }, userId: req.user!.id });
      } else {
        await updateRow(t, 'notes', cur.id, patch, expectedUpdatedAt, req.user!.id);
        if (patch.kind && patch.kind !== cur.kind) await audit(t, { companyId: cur.companyId, entityType: 'TASK', entityId: cur.taskId, action: patch.kind === 'INTERNAL' ? 'NOTE_MADE_INTERNAL' : 'NOTE_UNMARKED_INTERNAL', detail: { title: cur.title }, userId: req.user!.id });
      }
    });
    return one(cur.id);
  });

  // Share to Discussions. First time: a new discussion item. Later (after edits): the pending discussion is updated with the newer text,
  // or — if that discussion was already settled — a fresh "Revised" discussion is raised so the changes can be circulated again.
  app.post('/notes/:id/share', async (req) => {
    const n = await load((req.params as any).id, req.user!, 'USER');
    const b = z.object({ personId: z.string().nullable().optional(), contactName: optText(200), dueDate: optDate }).parse(req.body ?? {});
    if (b.personId) {
      const p = await db.get<any>('SELECT company_id, archived_at FROM people WHERE id = ?', [b.personId]);
      if (!p || p.archivedAt || (p.companyId && !(await roleFor(db, req.user!, p.companyId)))) throw badRequest('Choose an active person you have access to');
    }
    const agenda = (n.body.length > 2900 ? n.body.slice(0, 2900) + '\n… (full text in the note)' : n.body);
    const cur = n.discussionId ? await db.get<any>('SELECT * FROM discussions WHERE id = ?', [n.discussionId]) : null;
    const reuse = cur && !cur.doneAt && !cur.archivedAt;
    const topic = `${cur ? 'Revised note' : 'Note'}: ${n.title} (v${n.version})`.slice(0, 300);
    let did = cur?.id as string;
    await db.tx(async (t) => {
      if (reuse) await updateRow(t, 'discussions', cur.id, { topic, agenda, ...(b.dueDate ? { dueDate: b.dueDate } : {}) }, cur.updatedAt, req.user!.id);
      else did = await insertRow(t, 'discussions', { companyId: n.companyId, taskId: n.taskId, subtaskId: n.subtaskId, kind: 'DISCUSSION', personId: b.personId ?? cur?.personId ?? null,
        contactName: b.personId ? null : (b.contactName?.trim() || cur?.contactName || 'Internal review'), topic, agenda, dueDate: b.dueDate ?? null }, req.user!.id);
      const nn = await t.get<any>('SELECT updated_at FROM notes WHERE id = ?', [n.id]);
      await updateRow(t, 'notes', n.id, { discussionId: did, sharedVersion: n.version, sharedAt: nowIso() }, nn.updatedAt, req.user!.id);
      await audit(t, { companyId: n.companyId, entityType: 'TASK', entityId: n.taskId, action: 'NOTE_SHARED', detail: { title: n.title, version: n.version, discussionId: did, updated: !!reuse }, userId: req.user!.id });
    });
    return { note: await one(n.id), discussionId: did, updated: !!reuse };
  });

  for (const [verb, on] of [['archive', true], ['restore', false]] as const)
    app.post(`/notes/:id/${verb}`, async (req) => { const n = await load((req.params as any).id, req.user!, 'USER'); await setArchived(db, 'notes', n.id, on, req.user!.id); return one(n.id); });


  // ── "Proper note": AI (or plain) formatting of the rough points. Generating only returns a draft for the window; nothing is saved until the user saves it.
  app.post('/notes/:id/draft/generate', async (req) => {
    const n = await load((req.params as any).id, req.user!, 'USER');
    const b = z.object({ instruction: optText(1000), salutation: optText(80), signerTitle: optText(200), headerCompanyId: z.string().nullable().optional(), headerColor: z.string().nullable().optional(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), mode: z.enum(['ai', 'plain']).default('ai') }).parse(req.body ?? {});
    if (!n.body.trim()) throw badRequest('Write your points first — there is nothing to format yet.');
    const today = b.today ?? localDay(); const signer = b.signerTitle?.trim() || req.user!.name;
    const plain = () => { const d = plainDraft(n.title, n.body, signer, today); if (b.salutation?.trim()) d.salutation = b.salutation.trim(); d.headerCompanyId = b.headerCompanyId ?? null; d.headerColor = b.headerColor ?? null; return d; };
    if (b.mode === 'plain' || !app.ai.enabled) return { draft: plain(), aiUsed: false, basedOnVersion: n.version, notice: b.mode === 'plain' ? 'Formatted without AI.' : 'AI is not set up, so the points were only laid out in the note format. Add your OpenAI key in Settings → AI for a properly written note.' };
    const acc = await taskAccess(db, n.taskId);
    if (acc?.excluded) throw new HttpError(403, 'AI_EXCLUDED', 'This task is switched off for AI (“Exclude from AI”), so its notes are not sent to the AI.');
    if (b.headerCompanyId) await need(db, req.user!, b.headerCompanyId, 'VIEWER');
    const co = await db.get<any>('SELECT name FROM companies WHERE id = ?', [b.headerCompanyId || n.companyId]);
    const data = [`Company: ${co?.name ?? ''}`, `Note title: ${n.title}`, `Signer (designation or name): ${signer}`, `Date: ${formatDate(today)}`, `Salutation: ${b.salutation?.trim() || 'Dear Sir,'}`,
      b.instruction?.trim() ? `Extra instructions from the author: ${b.instruction.trim()}` : '', 'POINTS:', n.body.slice(0, 12000)].filter(Boolean).join('\n');
    const r = await app.ai.chatJson({ userId: req.user!.id, kind: 'note', system: DRAFT_SYSTEM, user: `<<<POINTS\n${data}\nPOINTS>>>`, schema: DraftSchema, maxTokens: 2200, temperature: 0.3 });
    const d = r.data; d.headerCompanyId = b.headerCompanyId ?? null; d.headerColor = b.headerColor ?? null; if (!d.signerTitle) d.signerTitle = signer; if (!d.date) d.date = formatDate(today);
    return { draft: d, aiUsed: true, basedOnVersion: n.version, notice: null };
  });

  app.put('/notes/:id/draft', async (req) => {
    const n = await load((req.params as any).id, req.user!, 'USER');
    const b = z.object({ draft: DraftSchema.nullable() }).parse(req.body);
    if (b.draft?.headerCompanyId) await need(db, req.user!, b.draft.headerCompanyId, 'VIEWER');
    await updateRow(db, 'notes', n.id, { draftJson: b.draft ? JSON.stringify(b.draft) : null, draftFromVersion: b.draft ? n.version : null }, n.updatedAt, req.user!.id);
    await audit(db, { companyId: n.companyId, entityType: 'TASK', entityId: n.taskId, action: b.draft ? 'NOTE_DRAFT_SAVED' : 'NOTE_DRAFT_REMOVED', detail: { title: n.title, version: n.version }, userId: req.user!.id });
    return one(n.id);
  });

  app.get('/notes/:id/export.docx', async (req, reply) => {
    const n = await load((req.params as any).id, req.user!, 'VIEWER'); const row = await one(n.id);
    const q = z.object({ format: z.enum(['proper', 'raw']).optional(), companyId: z.string().optional(), color: z.string().optional() }).parse(req.query);
    const fmtq = q.format ?? (n.draftJson ? 'proper' : 'raw');
    if (fmtq === 'proper') {
      if (!n.draftJson) throw badRequest('There is no proper-note draft yet — press “Make proper note” first.');
      const dj = JSON.parse(n.draftJson); const brand = await brandOf(req.user!, n.companyId, q.companyId ?? dj.headerCompanyId, q.color ?? dj.headerColor, 'Internal note');
      const buf = await formalNoteDocx(dj, n.title, brand);
      return reply.header('Content-Type', DOCX_MIME).header('Content-Disposition', `attachment; filename="${safeName(n.title)}.docx"`).send(buf);
    }
    const versions = await db.all<any>('SELECT v.version, v.change_note, v.created_at, u.name AS author_name FROM note_versions v LEFT JOIN users u ON u.id = v.created_by_id WHERE v.note_id = ? ORDER BY v.version', [n.id]);
    const disc = n.discussionId ? await db.get<any>('SELECT topic, done_at, discussion_notes, decisions FROM discussions WHERE id = ?', [n.discussionId]) : null;
    const brand = await brandOf(req.user!, n.companyId, q.companyId, q.color, n.kind === 'INTERNAL' ? 'Internal note' : 'Note');
    const kids = [
      heading(n.title, 1),
      muted(`${row.companyName}  ›  ${row.taskTitle}${row.subtaskTitle ? `  ›  ${row.subtaskTitle}` : ''}`),
      muted(`Version ${n.version}  ·  last updated ${fmt(n.updatedAt)}  ·  prepared by ${row.authorName ?? ''}`),
      para(''), ...textToBlocks(n.body),
    ];
    if (disc?.doneAt && (disc.decisions || disc.discussionNotes)) {
      kids.push(heading('Outcome of the discussion', 2));
      if (disc.discussionNotes) kids.push(para('Discussed:', { bold: true }), ...textToBlocks(disc.discussionNotes));
      if (disc.decisions) kids.push(para('Decisions:', { bold: true }), ...textToBlocks(disc.decisions));
    }
    if (versions.length > 1) { kids.push(heading('Revision history', 2), table(['Version', 'Date', 'By', 'What changed'], versions.map((v) => [`v${v.version}`, fmt(v.createdAt), v.authorName ?? '', v.changeNote ?? '']), [900, 2300, 2000, 4700])); }
    kids.push(para(''), muted(n.kind === 'INTERNAL' ? 'Internal — not for circulation outside the company.' : 'Draft note.'));
    const buf = await buildDocx(kids, { title: n.title, brand });
    return reply.header('Content-Type', DOCX_MIME).header('Content-Disposition', `attachment; filename="${safeName(n.title)}-v${n.version}.docx"`).send(buf);
  });
}
void newId;

