import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { toCsv } from '../lib/csv.ts';
import { serverToday } from '../lib/dates.ts';
import { accessibleCompanyIds, inClause, need, taskGuard } from '../lib/permissions.ts';
import { PRIORITY_NAMES } from '../lib/labels.ts';
import { DOCX_MIME, buildDocx, heading, muted, para, safeName, table } from '../lib/word.ts';
import { Paragraph } from 'docx';

type Cell = string | number | null;
interface Sheet { title: string; columns: string[]; rows: Cell[][] }

export default async function exportRoutes(app: FastifyInstance) {
  const { db } = app;
  const PROGRESS = `COALESCE(t.progress_override, CASE WHEN t.status = 'DONE' THEN 100 ELSE (SELECT CAST(AVG(CASE WHEN s.status = 'DONE' THEN 100 ELSE s.progress END) AS INTEGER) FROM subtasks s WHERE s.task_id = t.id AND s.archived_at IS NULL) END, 0)`;

  // Pending jobs per person, as a Word file that can be forwarded to them so they can fill in an update. One section per person.
  app.get('/export-word/pending-jobs', async (req, reply) => {
    const q = z.object({ companyId: z.string().optional(), personId: z.string().optional(), personIds: z.string().optional(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = q.companyId ? [q.companyId] : await accessibleCompanyIds(db, req.user!); const today = q.today ?? serverToday();
    const co = (col: string) => { const g = taskGuard(req.user!, 't'); return ids ? { sql: ` AND ${col} IN (${inClause(ids)}) AND ${g.sql}`, p: [...ids, ...g.params] } : { sql: ` AND ${g.sql}`, p: g.params }; };   // every export joins tasks as t, so team members only get their own
    const ct = co('t.company_id');
    const pids = q.personIds ? q.personIds.split(',').filter(Boolean).slice(0, 60) : q.personId ? [q.personId] : [];
    const tasks = await db.rows(`SELECT t.delegated_to_id pid, pe.name person, co.name company, p.name project, t.title, t.priority, t.status, t.due_date, t.waiting_for, t.next_action
      FROM tasks t JOIN companies co ON co.id = t.company_id JOIN people pe ON pe.id = t.delegated_to_id LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.archived_at IS NULL AND t.status <> 'DONE' ${pids.length ? `AND t.delegated_to_id IN (${inClause(pids)})` : ''}${ct.sql} ORDER BY (t.due_date IS NULL), t.due_date, t.priority LIMIT 5000`, [...pids, ...ct.p]);
    const subs = await db.rows(`SELECT s.assignee_id pid, pe.name person, co.name company, p.name project, t.title task, s.title, s.priority, s.status, s.due_date
      FROM subtasks s JOIN tasks t ON t.id = s.task_id JOIN companies co ON co.id = t.company_id JOIN people pe ON pe.id = s.assignee_id LEFT JOIN projects p ON p.id = t.project_id
      WHERE s.archived_at IS NULL AND s.status <> 'DONE' AND t.archived_at IS NULL AND t.status <> 'DONE' ${pids.length ? `AND s.assignee_id IN (${inClause(pids)})` : ''}${ct.sql} ORDER BY (s.due_date IS NULL), s.due_date, s.priority LIMIT 20000`, [...pids, ...ct.p]);
    const groups = new Map<string, { name: string; rows: any[] }>();
    const g = (pid: string, name: string) => { if (!groups.has(pid)) groups.set(pid, { name, rows: [] }); return groups.get(pid)!; };
    const dueText = (d: string | null) => (d ? `${d}${d < today ? '\n(OVERDUE)' : d === today ? '\n(today)' : ''}` : '—');
    for (const r of tasks) g(r.pid, r.person).rows.push({ due: r.due_date, cells: [`${r.company}${r.project ? '\n' + r.project : ''}`, `${r.title}${r.next_action ? '\nNext: ' + r.next_action : ''}`, dueText(r.due_date), PRIORITY_NAMES[r.priority], `${r.status}${r.waiting_for ? '\nWaiting for: ' + r.waiting_for : ''}`] });
    for (const r of subs) g(r.pid, r.person).rows.push({ due: r.due_date, cells: [`${r.company}${r.project ? '\n' + r.project : ''}`, `${r.title}\n(subtask of: ${r.task})`, dueText(r.due_date), PRIORITY_NAMES[r.priority], r.status] });
    const kids: (Paragraph | ReturnType<typeof table>)[] = [];
    const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((grp, i) => {
      grp.rows.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
      kids.push(new Paragraph({ pageBreakBefore: i > 0, spacing: { after: 60 }, children: [] }));
      kids.push(heading(`Pending jobs — ${grp.name}`, 1), muted(`As on ${today}  ·  ${grp.rows.length} open item${grp.rows.length > 1 ? 's' : ''}  ·  sent by ${req.user!.name}`),
        para('Please update the last column against each item (status, expected date, any help needed) and send this back.', { after: 120 }),
        table(['#', 'Company / Project', 'Job', 'Due', 'Priority', 'Status', 'Your update'], grp.rows.map((r, n) => [String(n + 1), ...r.cells, '']), [450, 2200, 4200, 1300, 1100, 1700, 3800]));
    });
    if (!list.length) kids.push(heading('Pending jobs', 1), para('Nothing is pending for the selection.'));
    const buf = await buildDocx(kids, { landscape: true, title: 'Pending jobs' });
    const name = list.length === 1 ? safeName(list[0].name) : 'all-people';
    return reply.header('Content-Type', DOCX_MIME).header('Content-Disposition', `attachment; filename="dood-pending-jobs-${name}-${today}.docx"`).send(buf);
  });

  app.get('/export/:format', async (req, reply) => {
    const { format } = z.object({ format: z.enum(['csv', 'xlsx', 'pdf']) }).parse(req.params);
    const q = z.object({ dataset: z.enum(['tasks', 'subtasks', 'focus', 'communications', 'discussions', 'people']).default('tasks'),
      scope: z.enum(['active', 'completed', 'overdue', 'delegated', 'followups', 'waiting', 'all']).default('active'),
      companyId: z.string().optional(), projectId: z.string().optional(), personId: z.string().optional(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    if (q.companyId) await need(db, req.user!, q.companyId, 'VIEWER');
    const ids = q.companyId ? [q.companyId] : await accessibleCompanyIds(db, req.user!); const today = q.today ?? serverToday();
    const co = (col: string) => { const g = taskGuard(req.user!, 't'); return ids ? { sql: ` AND ${col} IN (${inClause(ids)}) AND ${g.sql}`, p: [...ids, ...g.params] } : { sql: ` AND ${g.sql}`, p: g.params }; };   // every export joins tasks as t, so team members only get their own
    let sheet: Sheet;

    if (q.dataset === 'tasks') {
      const c = co('t.company_id'); const where = ['t.archived_at IS NULL']; const params: any[] = [];
      if (q.scope === 'active') where.push("t.status <> 'DONE'"); else if (q.scope === 'completed') where.push("t.status = 'DONE'");
      else if (q.scope === 'overdue') { where.push("t.status <> 'DONE' AND t.due_date < ?"); params.push(today); }
      else if (q.scope === 'delegated') where.push("t.status <> 'DONE' AND t.delegated_to_id IS NOT NULL");
      else if (q.scope === 'followups') { where.push("t.status <> 'DONE' AND t.next_followup_date IS NOT NULL"); }
      else if (q.scope === 'waiting') where.push("t.status <> 'DONE' AND (t.status = 'WAITING' OR t.waiting_for IS NOT NULL)");
      if (q.projectId) { where.push('t.project_id = ?'); params.push(q.projectId); }
      if (q.personId) { where.push('t.delegated_to_id = ?'); params.push(q.personId); }
      const rows = await db.rows(`SELECT co.name company, p.name project, t.title, t.priority, t.status, t.due_date, ${PROGRESS} progress, u.name owner, d.name delegated_to, t.waiting_for, t.next_action, t.next_followup_date,
          t.postpone_count, t.focus_minutes, substr(t.created_at,1,10) created, t.completed_at, t.completion_note
        FROM tasks t JOIN companies co ON co.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN people d ON d.id = t.delegated_to_id JOIN users u ON u.id = t.owner_id
        WHERE ${where.join(' AND ')}${c.sql} ORDER BY co.name, p.name, (t.due_date IS NULL), t.due_date LIMIT 20000`, [...params, ...c.p]);
      sheet = { title: `Tasks (${q.scope})`, columns: ['Company', 'Project', 'Task', 'Priority', 'Status', 'Due', 'Progress %', 'Owner', 'Delegated to', 'Waiting for', 'Next action', 'Next follow-up', 'Postponed', 'Focus min', 'Created', 'Completed', 'Completion note'],
        rows: rows.map((r) => [r.company, r.project, r.title, PRIORITY_NAMES[r.priority], r.status, r.due_date, r.progress, r.owner, r.delegated_to, r.waiting_for, r.next_action, r.next_followup_date, r.postpone_count, r.focus_minutes, r.created, r.completed_at?.slice(0, 10) ?? null, r.completion_note]) };
    } else if (q.dataset === 'subtasks') {
      const c = co('t.company_id');
      const rows = await db.rows(`SELECT co.name company, t.title task, s.title, s.status, s.due_date, p.name person, s.focus_minutes, s.completed_at FROM subtasks s JOIN tasks t ON t.id = s.task_id JOIN companies co ON co.id = t.company_id LEFT JOIN people p ON p.id = s.assignee_id
        WHERE s.archived_at IS NULL AND t.archived_at IS NULL${c.sql} ORDER BY co.name, t.title, s.position LIMIT 50000`, c.p);
      sheet = { title: 'Subtasks', columns: ['Company', 'Task', 'Subtask', 'Status', 'Due', 'Assigned to', 'Focus min', 'Completed'], rows: rows.map((r) => [r.company, r.task, r.title, r.status, r.due_date, r.person, r.focus_minutes, r.completed_at?.slice(0, 10) ?? null]) };
    } else if (q.dataset === 'focus') {
      const c = co('f.company_id');
      const rows = await db.rows(`SELECT f.started_at, t.title task, s.title subtask, f.planned_minutes, f.actual_minutes, f.completed, f.note, co.name company FROM focus_sessions f JOIN tasks t ON t.id = f.task_id JOIN companies co ON co.id = f.company_id LEFT JOIN subtasks s ON s.id = f.subtask_id
        WHERE f.archived_at IS NULL AND f.ended_at IS NOT NULL AND f.user_id = ?${c.sql} ORDER BY f.started_at DESC LIMIT 50000`, [req.user!.id, ...c.p]);
      sheet = { title: 'Focus history', columns: ['Started', 'Company', 'Task', 'Subtask', 'Planned min', 'Actual min', 'Finished?', 'Note'], rows: rows.map((r) => [r.started_at, r.company, r.task, r.subtask, r.planned_minutes, r.actual_minutes, r.completed ? 'Yes' : 'Stopped early', r.note]) };
    } else if (q.dataset === 'communications') {
      const c = co('k.company_id');
      const rows = await db.rows(`SELECT k.channel, COALESCE(pe.name, k.contact_name) who, COALESCE(k.phone, pe.phone) phone, COALESCE(k.email, pe.email) email, t.title task, s.title subtask, k.due_date, k.note, k.done_at, k.result, co.name company
        FROM calls k JOIN tasks t ON t.id = k.task_id JOIN companies co ON co.id = k.company_id LEFT JOIN subtasks s ON s.id = k.subtask_id LEFT JOIN people pe ON pe.id = k.person_id WHERE k.archived_at IS NULL${c.sql} ORDER BY (k.done_at IS NOT NULL), k.due_date LIMIT 20000`, c.p);
      sheet = { title: 'Calls and mails', columns: ['Type', 'Who', 'Phone', 'Email', 'Company', 'Task', 'Subtask', 'Due', 'Note', 'Done', 'Feedback'], rows: rows.map((r) => [r.channel, r.who, r.phone, r.email, r.company, r.task, r.subtask, r.due_date, r.note, r.done_at?.slice(0, 10) ?? null, r.result]) };
    } else if (q.dataset === 'discussions') {
      const c = co('d.company_id');
      const rows = await db.rows(`SELECT d.kind, COALESCE(pe.name, d.contact_name) who, d.topic, t.title task, s.title subtask, d.due_date, d.meeting_time, d.agenda, d.done_at, d.discussion_notes, d.decisions, co.name company
        FROM discussions d JOIN tasks t ON t.id = d.task_id JOIN companies co ON co.id = d.company_id LEFT JOIN subtasks s ON s.id = d.subtask_id LEFT JOIN people pe ON pe.id = d.person_id WHERE d.archived_at IS NULL${c.sql} ORDER BY (d.done_at IS NOT NULL), who, d.due_date LIMIT 20000`, c.p);
      sheet = { title: 'Discussions and meetings', columns: ['Type', 'With', 'Topic', 'Company', 'Task', 'Subtask', 'Date', 'Time', 'Agenda', 'Done', 'Discussed', 'Decisions'], rows: rows.map((r) => [r.kind, r.who, r.topic, r.company, r.task, r.subtask, r.due_date, r.meeting_time, r.agenda, r.done_at?.slice(0, 10) ?? null, r.discussion_notes, r.decisions]) };
    } else {
      const pc = ids ? { sql: ` AND (p.company_id IS NULL OR p.company_id IN (${inClause(ids)}))`, p: [...ids] } : { sql: '', p: [] as any[] };
      const rows = await db.rows(`SELECT p.name, p.designation, p.department, c.name company, p.email, p.phone, p.active FROM people p LEFT JOIN companies c ON c.id = p.company_id WHERE p.archived_at IS NULL${pc.sql} ORDER BY p.name`, pc.p);
      sheet = { title: 'People', columns: ['Name', 'Designation', 'Department', 'Company', 'Email', 'Phone', 'Active'], rows: rows.map((r) => [r.name, r.designation, r.department, r.company ?? 'Shared', r.email, r.phone, r.active ? 'Yes' : 'No']) };
    }

    const base = `dood-${q.dataset}${q.dataset === 'tasks' ? '-' + q.scope : ''}-${today}`;
    if (format === 'csv') return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${base}.csv"`).send(toCsv(sheet.columns, sheet.rows));
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(sheet.title.slice(0, 31));
      ws.addRow(sheet.columns).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }];
      for (const r of sheet.rows) ws.addRow(r);
      ws.columns.forEach((col, i) => { const w = Math.max(sheet.columns[i].length, ...sheet.rows.slice(0, 200).map((r) => String(r[i] ?? '').length)); col.width = Math.min(48, w + 2); });
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${base}.xlsx"`).send(buf);
    }
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 }); const chunks: Buffer[] = []; doc.on('data', (c) => chunks.push(c));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    // PDF: keep the most useful columns so the table stays readable.
    const keep = sheet.columns.map((_, i) => i).slice(0, 9); const w = (doc.page.width - 56) / keep.length;
    doc.fontSize(14).text(`DOOD · ${sheet.title} — ${today}`, { align: 'left' }).moveDown(0.5);
    const row = (cells: string[], bold = false) => { const y = doc.y; doc.fontSize(7.5).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: w - 4 })));
      if (y + h > doc.page.height - 40) { doc.addPage(); return row(cells, bold); }
      cells.forEach((c, i) => doc.text(c, 28 + i * w, y, { width: w - 4 })); doc.y = y + h + 4; doc.moveTo(28, doc.y - 2).lineTo(doc.page.width - 28, doc.y - 2).strokeColor('#dddddd').stroke(); };
    row(keep.map((i) => sheet.columns[i]), true);
    for (const r of sheet.rows.slice(0, 3000)) row(keep.map((i) => String(r[i] ?? '').slice(0, 90)));
    doc.end(); const pdf = await done;
    return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${base}.pdf"`).send(pdf);
  });
}
