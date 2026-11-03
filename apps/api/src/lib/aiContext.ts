// Builds what the AI is allowed to see about a task or project, and a "fingerprint" that changes whenever that information changes
// (so a saved summary can be marked out of date without calling the AI). Excluded tasks/projects are never read here.
import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { diffDays } from './dates.ts';

const PRIORITY: Record<number, string> = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };
const clip = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const day = (iso?: string | null) => (iso ? String(iso).slice(0, 10) : '');
const MAX = 14_000;

export async function taskAccess(db: Db, taskId: string) {
  return db.get<{ id: string; companyId: string; title: string; excluded: boolean; projectId: string | null }>(
    `SELECT t.id, t.company_id, t.title, t.project_id, (t.ai_excluded = 1 OR COALESCE(p.ai_excluded, 0) = 1) AS excluded FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`, [taskId])
    .then((r: any) => (r ? { ...r, excluded: !!r.excluded } : undefined));
}
export async function projectAccess(db: Db, projectId: string) {
  return db.get<any>('SELECT id, company_id, name AS title, ai_excluded AS excluded FROM projects WHERE id = ?', [projectId]).then((r: any) => (r ? { ...r, excluded: !!r.excluded } : undefined));
}

const agg = (table: string, where: string) => `(SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM ${table} WHERE ${where})`;

export async function fingerprint(db: Db, type: 'TASK' | 'PROJECT', id: string): Promise<string> {
  let parts: any;
  if (type === 'TASK') {
    parts = await db.rows(`SELECT t.updated_at a, t.last_activity_at b,
      ${agg('comments', "archived_at IS NULL AND ((entity_type = 'TASK' AND entity_id = t.id) OR (entity_type = 'SUBTASK' AND entity_id IN (SELECT id FROM subtasks WHERE task_id = t.id)))")} c,
      ${agg('subtasks', 'task_id = t.id AND archived_at IS NULL')} d, ${agg('followups', 'task_id = t.id AND archived_at IS NULL')} e, ${agg('calls', 'task_id = t.id AND archived_at IS NULL')} f,
      ${agg('discussions', 'task_id = t.id AND archived_at IS NULL')} g, ${agg('focus_sessions', 'task_id = t.id AND archived_at IS NULL AND ended_at IS NOT NULL')} h
      FROM tasks t WHERE t.id = ?`, [id]);
  } else {
    parts = await db.rows(`SELECT p.updated_at a,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') || ':' || COALESCE(MAX(last_activity_at), '') FROM tasks WHERE project_id = p.id AND archived_at IS NULL AND ai_excluded = 0) b
      FROM projects p WHERE p.id = ?`, [id]);
  }
  return createHash('sha256').update(JSON.stringify(parts[0] ?? {})).digest('hex').slice(0, 24);
}

const cap = (s: string) => (s.length > MAX ? s.slice(0, MAX) + '\n[…trimmed]' : s);

export async function taskContext(db: Db, taskId: string, today: string): Promise<string> {
  const t = (await db.get<any>(`SELECT t.*, c.name company_name, p.name project_name, u.name owner_name, d.name delegated_name, r.name reviewer_name
    FROM tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = t.owner_id LEFT JOIN people d ON d.id = t.delegated_to_id LEFT JOIN people r ON r.id = t.reviewer_id WHERE t.id = ?`, [taskId]))!;
  const L: string[] = [];
  const over = t.dueDate && t.status !== 'DONE' ? diffDays(t.dueDate, today) : 0;
  L.push(`TASK: ${clip(t.title, 300)}`, `Company: ${t.companyName}${t.projectName ? ` | Project: ${t.projectName}` : ''}`,
    `Status: ${t.status} | Priority: ${PRIORITY[t.priority] ?? t.priority} | Due: ${t.dueDate ?? 'none'}${over > 0 ? ` (${over} day(s) overdue)` : ''} | Postponed: ${t.postponeCount} time(s)`,
    `Owner: ${t.ownerName}${t.delegatedName ? ` | Delegated to: ${t.delegatedName}${t.delegatedAt ? ` on ${day(t.delegatedAt)}` : ''}` : ''}${t.reviewerName ? ` | Reviewer: ${t.reviewerName}` : ''}`);
  if (t.delegationInstructions) L.push(`Delegation instructions: ${clip(t.delegationInstructions, 400)}`);
  if (t.waitingFor) L.push(`Waiting for: ${clip(t.waitingFor, 200)}${t.waitingExpectedDate ? ` (expected ${t.waitingExpectedDate})` : ''}`);
  if (t.nextAction || t.nextFollowupDate) L.push(`Recorded next action: ${clip(t.nextAction, 300)}${t.nextFollowupDate ? ` | next follow-up ${t.nextFollowupDate}` : ''}`);
  if (t.completedAt) L.push(`Completed on ${day(t.completedAt)}${t.completionNote ? `: ${clip(t.completionNote, 400)}` : ''}`);
  if (t.description) L.push(`Description: ${clip(t.description, 1500)}`);
  if (t.additionalDetails) L.push(`Additional details: ${clip(t.additionalDetails, 800)}`);

  const subs = await db.all<any>(`SELECT s.title, s.status, s.due_date, s.completed_at, p.name who FROM subtasks s LEFT JOIN people p ON p.id = s.assignee_id WHERE s.task_id = ? AND s.archived_at IS NULL ORDER BY s.position LIMIT 40`, [taskId]);
  if (subs.length) L.push('', `SUBTASKS (${subs.length}):`, ...subs.map((s) => `- [${s.status === 'DONE' ? 'done' : 'open'}] ${clip(s.title, 200)}${s.dueDate ? ` (due ${s.dueDate})` : ''}${s.who ? ` — ${s.who}` : ''}${s.completedAt ? ` — done ${day(s.completedAt)}` : ''}`));
  const notes = await db.all<any>(`SELECT c.body, c.created_at, u.name author, st.title sub FROM comments c JOIN users u ON u.id = c.author_id LEFT JOIN subtasks st ON c.entity_type = 'SUBTASK' AND st.id = c.entity_id
    WHERE c.archived_at IS NULL AND ((c.entity_type = 'TASK' AND c.entity_id = ?) OR (c.entity_type = 'SUBTASK' AND c.entity_id IN (SELECT id FROM subtasks WHERE task_id = ?))) ORDER BY c.created_at DESC LIMIT 25`, [taskId, taskId]);
  if (notes.length) L.push('', 'NOTES (oldest first):', ...notes.reverse().map((n) => `[${day(n.createdAt)} ${n.author}${n.sub ? ` on subtask "${clip(n.sub, 80)}"` : ''}] ${clip(n.body, 600)}`));
  const focus = await db.all<any>(`SELECT started_at, actual_minutes, note FROM focus_sessions WHERE task_id = ? AND archived_at IS NULL AND ended_at IS NOT NULL AND note IS NOT NULL AND note <> '' ORDER BY started_at DESC LIMIT 15`, [taskId]);
  if (focus.length) L.push('', 'FOCUS-SESSION ACCOMPLISHMENTS:', ...focus.reverse().map((f) => `[${day(f.startedAt)}, ${f.actualMinutes} min] ${clip(f.note, 400)}`));
  const fu = await db.all<any>(`SELECT f.type, substr(f.due_at,1,10) due, f.done_at, f.notes, f.result, COALESCE(p.name, f.contact_name) who FROM followups f LEFT JOIN people p ON p.id = f.person_id WHERE f.task_id = ? AND f.archived_at IS NULL ORDER BY (f.done_at IS NOT NULL), f.due_at LIMIT 15`, [taskId]);
  if (fu.length) L.push('', 'FOLLOW-UPS:', ...fu.map((f) => f.doneAt ? `- done ${day(f.doneAt)} (${f.type}${f.who ? `, ${f.who}` : ''}): ${clip(f.result ?? f.notes, 400)}` : `- pending, due ${f.due} (${f.type}${f.who ? `, ${f.who}` : ''})${f.notes ? `: ${clip(f.notes, 200)}` : ''}`));
  const calls = await db.all<any>(`SELECT k.channel, k.due_date, k.done_at, k.note, k.result, COALESCE(p.name, k.contact_name) who FROM calls k LEFT JOIN people p ON p.id = k.person_id WHERE k.task_id = ? AND k.archived_at IS NULL ORDER BY (k.done_at IS NOT NULL), k.due_date LIMIT 15`, [taskId]);
  if (calls.length) L.push('', 'CALLS / MAILS:', ...calls.map((k) => k.doneAt ? `- done ${day(k.doneAt)} ${k.channel} with ${k.who}: ${clip(k.result, 400)}` : `- to do ${k.channel} ${k.who}${k.dueDate ? ` by ${k.dueDate}` : ''}${k.note ? `: ${clip(k.note, 200)}` : ''}`));
  const disc = await db.all<any>(`SELECT d.kind, d.topic, d.due_date, d.done_at, d.discussion_notes, d.decisions, COALESCE(p.name, d.contact_name) who FROM discussions d LEFT JOIN people p ON p.id = d.person_id WHERE d.task_id = ? AND d.archived_at IS NULL ORDER BY (d.done_at IS NOT NULL), d.due_date LIMIT 12`, [taskId]);
  if (disc.length) L.push('', 'DISCUSSIONS / MEETINGS:', ...disc.map((d) => d.doneAt ? `- done ${day(d.doneAt)} with ${d.who}: ${clip(d.topic, 150)} → decision: ${clip(d.decisions ?? d.discussionNotes, 400)}` : `- pending with ${d.who}: ${clip(d.topic, 200)}${d.dueDate ? ` (by ${d.dueDate})` : ''}`));
  return cap(L.join('\n'));
}

export async function projectContext(db: Db, projectId: string, today: string): Promise<string> {
  const p = (await db.get<any>('SELECT p.*, c.name company_name, u.name owner_name FROM projects p JOIN companies c ON c.id = p.company_id LEFT JOIN users u ON u.id = p.owner_id WHERE p.id = ?', [projectId]))!;
  const L: string[] = [`PROJECT: ${clip(p.name, 200)}`, `Company: ${p.companyName} | Status: ${p.status} | Priority: ${PRIORITY[p.priority] ?? p.priority}${p.ownerName ? ` | Owner: ${p.ownerName}` : ''}`,
    `Start: ${p.startDate ?? 'not set'} | Target date: ${p.targetDate ?? 'not set'}${p.targetDate && p.status !== 'COMPLETED' && p.targetDate < today ? ` (${diffDays(p.targetDate, today)} day(s) past target)` : ''}`];
  if (p.description) L.push(`Description: ${clip(p.description, 1200)}`);
  const base = `t.project_id = ? AND t.archived_at IS NULL AND t.ai_excluded = 0`;
  const counts = (await db.get<any>(`SELECT COUNT(*) total, SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) done, SUM(CASE WHEN t.status <> 'DONE' AND t.due_date < ? THEN 1 ELSE 0 END) overdue FROM tasks t WHERE ${base}`, [today, projectId]))!;
  L.push(`Tasks: ${counts.total} (done ${counts.done ?? 0}, open ${counts.total - (counts.done ?? 0)}, overdue ${counts.overdue ?? 0})`);
  const open = await db.all<any>(`SELECT t.id, t.title, t.status, t.priority, t.due_date, substr(t.last_activity_at,1,10) last, t.waiting_for, t.next_action, t.postpone_count, d.name who FROM tasks t LEFT JOIN people d ON d.id = t.delegated_to_id
    WHERE ${base} AND t.status <> 'DONE' ORDER BY t.priority, (t.due_date IS NULL), t.due_date LIMIT 60`, [projectId]);
  if (open.length) L.push('', 'OPEN TASKS:', ...open.map((t) => `- [${t.status}] ${clip(t.title, 160)} | ${PRIORITY[t.priority]} | due ${t.dueDate ?? 'none'}${t.dueDate && t.dueDate < today ? ' (OVERDUE)' : ''} | last activity ${t.last}${t.who ? ` | with ${t.who}` : ''}${t.waitingFor ? ` | waiting for ${clip(t.waitingFor, 80)}` : ''}${t.nextAction ? ` | next: ${clip(t.nextAction, 100)}` : ''}${t.postponeCount ? ` | postponed ${t.postponeCount}x` : ''}`));
  const done = await db.all<any>(`SELECT t.title, substr(t.completed_at,1,10) d, t.completion_note FROM tasks t WHERE ${base} AND t.status = 'DONE' ORDER BY t.completed_at DESC LIMIT 12`, [projectId]);
  if (done.length) L.push('', 'RECENTLY COMPLETED:', ...done.map((t) => `- ${clip(t.title, 160)} (${t.d})${t.completionNote ? `: ${clip(t.completionNote, 200)}` : ''}`));
  const notes = await db.all<any>(`SELECT c.body, c.created_at, t.title FROM comments c JOIN tasks t ON t.id = c.entity_id WHERE c.entity_type = 'TASK' AND c.archived_at IS NULL AND ${base} ORDER BY c.created_at DESC LIMIT 12`, [projectId]);
  if (notes.length) L.push('', 'RECENT NOTES ACROSS TASKS:', ...notes.reverse().map((n) => `[${day(n.createdAt)} · ${clip(n.title, 60)}] ${clip(n.body, 300)}`));
  return cap(L.join('\n'));
}
