import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleCompanyIds, inClause, projectGuard, taskGuard } from '../lib/permissions.ts';

const like = (q: string) => '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
function snippet(text: string | null, q: string) {
  if (!text) return null; const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 120); const a = Math.max(0, i - 40);
  return (a > 0 ? '…' : '') + text.slice(a, i + q.length + 80).replace(/\s+/g, ' ') + (i + q.length + 80 < text.length ? '…' : '');
}

// Global search across everything you can access — tasks, subtasks, notes, calls/mails, discussions, people, projects, companies, files, history.
export default async function searchRoutes(app: FastifyInstance) {
  const { db } = app;
  app.get('/search', async (req) => {
    const { q, companyId } = z.object({ q: z.string().trim().min(2).max(100), companyId: z.string().optional() }).parse(req.query);
    const ids = companyId ? [companyId] : await accessibleCompanyIds(db, req.user!);
    const sc = (col: string) => ids ? { sql: ` AND ${col} IN (${inClause(ids)})`, p: [...ids] } : { sql: '', p: [] as any[] };
    const L = like(q); const out: any[] = []; const E = " ESCAPE '\\'";
    const add = async (type: string, sql: string, params: any[], map: (r: any) => any) => { for (const r of await db.all<any>(sql + ' LIMIT 20', params)) out.push({ type, ...map(r) }); };
    const U = req.user!;
    const inTasks = (expr: string) => { if (!U.scoped.length) return { sql: '', p: [] as any[] }; const g = taskGuard(U, 'sg'); return { sql: ` AND (${expr}) IN (SELECT sg.id FROM tasks sg WHERE ${g.sql})`, p: g.params }; };
    const withG = (c: { sql: string; p: any[] }, x: { sql: string; p: any[] }) => ({ sql: c.sql + x.sql, p: [...c.p, ...x.p] });
    let c = sc('t.company_id'); { const g = taskGuard(U, 't'); c = { sql: c.sql + ` AND ${g.sql}`, p: [...c.p, ...g.params] }; }
    await add('task', `SELECT t.id, t.title, t.description, t.next_action, t.waiting_for, t.completion_note, t.status, t.due_date, co.name AS company_name FROM tasks t JOIN companies co ON co.id = t.company_id
      WHERE t.archived_at IS NULL AND (t.title LIKE ?${E} OR t.description LIKE ?${E} OR t.next_action LIKE ?${E} OR t.waiting_for LIKE ?${E} OR t.completion_note LIKE ?${E} OR t.additional_details LIKE ?${E})${c.sql} ORDER BY t.updated_at DESC`,
      [L, L, L, L, L, L, ...c.p], (r) => ({ id: r.id, taskId: r.id, title: r.title, snippet: snippet(r.description ?? r.nextAction ?? r.waitingFor ?? r.completionNote, q), company: r.companyName, status: r.status, date: r.dueDate }));
    await add('subtask', `SELECT s.id, s.title, s.description, t.id AS task_id, t.title AS task_title, co.name AS company_name FROM subtasks s JOIN tasks t ON t.id = s.task_id JOIN companies co ON co.id = t.company_id
      WHERE s.archived_at IS NULL AND t.archived_at IS NULL AND (s.title LIKE ?${E} OR s.description LIKE ?${E})${c.sql}`, [L, L, ...c.p],
      (r) => ({ id: r.id, taskId: r.taskId, title: r.title, snippet: `in ${r.taskTitle}`, company: r.companyName }));
    c = withG(sc('c.company_id'), inTasks("CASE c.entity_type WHEN 'TASK' THEN c.entity_id ELSE (SELECT task_id FROM subtasks WHERE id = c.entity_id) END"));
    await add('note', `SELECT c.id, c.body, c.entity_type, c.entity_id, c.created_at, co.name AS company_name,
        CASE c.entity_type WHEN 'TASK' THEN c.entity_id WHEN 'SUBTASK' THEN (SELECT task_id FROM subtasks WHERE id = c.entity_id) ELSE NULL END AS task_id
      FROM comments c JOIN companies co ON co.id = c.company_id WHERE c.archived_at IS NULL AND c.entity_type IN ('TASK','SUBTASK') AND c.body LIKE ?${E}${c.sql} ORDER BY c.created_at DESC`, [L, ...c.p],
      (r) => ({ id: r.id, taskId: r.taskId, title: 'Note', snippet: snippet(r.body, q), company: r.companyName, date: r.createdAt.slice(0, 10) }));
    c = withG(sc('k.company_id'), inTasks('k.task_id'));
    await add('communication', `SELECT k.id, k.task_id, k.channel, k.contact_name, k.note, k.result, k.phone, k.email, pe.name AS person_name, co.name AS company_name FROM calls k JOIN companies co ON co.id = k.company_id LEFT JOIN people pe ON pe.id = k.person_id
      WHERE k.archived_at IS NULL AND (k.contact_name LIKE ?${E} OR k.note LIKE ?${E} OR k.result LIKE ?${E} OR k.phone LIKE ?${E} OR k.email LIKE ?${E} OR pe.name LIKE ?${E})${c.sql}`, [L, L, L, L, L, L, ...c.p],
      (r) => ({ id: r.id, taskId: r.taskId, title: `${r.channel === 'EMAIL' ? 'Email' : r.channel === 'WHATSAPP' ? 'WhatsApp' : 'Call'}: ${r.personName ?? r.contactName}`, snippet: snippet(r.result ?? r.note, q), company: r.companyName }));
    c = withG(sc('d.company_id'), inTasks('d.task_id'));
    await add('discussion', `SELECT d.id, d.task_id, d.topic, d.agenda, d.discussion_notes, d.decisions, d.contact_name, pe.name AS person_name, co.name AS company_name FROM discussions d JOIN companies co ON co.id = d.company_id LEFT JOIN people pe ON pe.id = d.person_id
      WHERE d.archived_at IS NULL AND (d.topic LIKE ?${E} OR d.agenda LIKE ?${E} OR d.discussion_notes LIKE ?${E} OR d.decisions LIKE ?${E} OR d.contact_name LIKE ?${E} OR pe.name LIKE ?${E})${c.sql}`, [L, L, L, L, L, L, ...c.p],
      (r) => ({ id: r.id, taskId: r.taskId, title: `Discussion: ${r.topic}`, snippet: snippet(r.decisions ?? r.discussionNotes ?? r.agenda, q) ?? `with ${r.personName ?? r.contactName}`, company: r.companyName }));
    c = withG(sc('a.company_id'), inTasks('a.task_id'));
    await add('file', `SELECT a.id, a.task_id, a.file_name, co.name AS company_name FROM attachments a JOIN companies co ON co.id = a.company_id WHERE a.archived_at IS NULL AND a.file_name LIKE ?${E}${c.sql}`, [L, ...c.p],
      (r) => ({ id: r.id, taskId: r.taskId, title: r.fileName, snippet: 'Attachment', company: r.companyName }));
    c = sc('p.company_id'); { const g = projectGuard(U, 'p'); c = { sql: c.sql + ` AND ${g.sql}`, p: [...c.p, ...g.params] }; }
    await add('project', `SELECT p.id, p.name, p.description, co.name AS company_name FROM projects p JOIN companies co ON co.id = p.company_id WHERE p.archived_at IS NULL AND (p.name LIKE ?${E} OR p.description LIKE ?${E})${c.sql}`, [L, L, ...c.p],
      (r) => ({ id: r.id, title: r.name, snippet: snippet(r.description, q), company: r.companyName, page: 'projects' }));
    const pc = ids ? { sql: ` AND (p.company_id IS NULL OR p.company_id IN (${inClause(ids)}))`, p: [...ids] } : { sql: '', p: [] as any[] };
    await add('person', `SELECT p.id, p.name, p.designation, p.email, p.phone FROM people p WHERE p.archived_at IS NULL AND (p.name LIKE ?${E} OR p.email LIKE ?${E} OR p.phone LIKE ?${E} OR p.designation LIKE ?${E})${pc.sql}`, [L, L, L, L, ...pc.p],
      (r) => ({ id: r.id, title: r.name, snippet: [r.designation, r.email, r.phone].filter(Boolean).join(' · '), page: 'performance', personId: r.id }));
    if (!companyId) {
      const cs = ids ? { sql: ` AND c.id IN (${inClause(ids)})`, p: [...ids] } : { sql: '', p: [] as any[] };
      await add('company', `SELECT c.id, c.name, c.code FROM companies c WHERE c.archived_at IS NULL AND (c.name LIKE ?${E} OR c.code LIKE ?${E} OR c.short_name LIKE ?${E})${cs.sql}`, [L, L, L, ...cs.p], (r) => ({ id: r.id, title: r.name, snippet: r.code, page: 'companies' }));
    }
    c = withG(sc('a.company_id'), inTasks('a.entity_id'));
    await add('history', `SELECT a.id, a.entity_id AS task_id, a.action, a.detail, a.created_at FROM activity_log a WHERE a.entity_type = 'TASK' AND a.detail LIKE ?${E}${c.sql} ORDER BY a.created_at DESC`, [L, ...c.p],
      (r) => ({ id: r.id, taskId: r.taskId, title: r.action.replaceAll('_', ' ').toLowerCase(), snippet: snippet(r.detail, q), date: r.createdAt.slice(0, 10) }));
    const counts: Record<string, number> = {}; for (const r of out) counts[r.type] = (counts[r.type] ?? 0) + 1;
    return { q, counts, results: out };
  });
}
