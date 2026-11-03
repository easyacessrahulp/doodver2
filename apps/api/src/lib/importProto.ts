// Imports the single-file prototype's JSON backup (keys: cos, prs, people, pinfo, tasks, sess, cc, arch, set).
// Additive only: existing rows are never overwritten, and re-running skips tasks that were already imported.
import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { insertRow } from './crud.ts';
import { audit } from './audit.ts';
import { reconcileFollowupDate } from './followups.ts';
import type { FileStore } from './files.ts';

const ts = (v: unknown) => { if (typeof v !== 'string' || !v) return null; const d = new Date(v); return isNaN(+d) ? null : d.toISOString(); };
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const FREQ: Record<string, string> = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', quarterly: 'QUARTERLY', yearly: 'YEARLY' };
const code = (name: string, taken: Set<string>) => { const base = (name.replace(/\b(pvt|ltd|private|limited|technologies)\b/gi, '').match(/[A-Za-z0-9]/g) ?? ['C']).join('').toUpperCase().slice(0, 6) || 'CO'; let c = base, n = 2; while (taken.has(c)) c = base.slice(0, 5) + n++; taken.add(c); return c; };

export async function importPrototype(db: Db, files: FileStore, adminId: string, data: any, ownerName = 'Rahul') {
  const rep = { created: { companies: 0, projects: 0, people: 0, tasks: 0, subtasks: 0, notes: 0, focusSessions: 0, attachments: 0 }, skippedTasks: 0, warnings: [] as string[] };
  if (!data || !Array.isArray(data.tasks)) throw new Error('This does not look like a prototype backup (no tasks list).');
  await db.tx(async (t) => {
    const companies = new Map<string, string>(); const taken = new Set((await t.all<any>('SELECT code FROM companies')).map((r) => r.code));
    for (const c of await t.all<any>('SELECT id, name FROM companies')) companies.set(c.name.toLowerCase(), c.id);
    const archived = new Set<string>(Array.isArray(data.arch) ? data.arch : []);
    const company = async (name: string) => {
      const k = String(name).toLowerCase(); if (companies.has(k)) return companies.get(k)!;
      const id = await insertRow(t, 'companies', { name, code: code(name, taken), active: true, ...(archived.has(name) ? { archivedAt: nowIso() } : {}) }, adminId); companies.set(k, id); rep.created.companies++; return id;
    };
    for (const n of data.cos ?? []) await company(n);
    const projects = new Map<string, string>();
    for (const p of await t.all<any>('SELECT id, company_id, name FROM projects')) projects.set(`${p.companyId}|${p.name.toLowerCase()}`, p.id);
    const project = async (cid: string, name: string) => {
      const k = `${cid}|${name.toLowerCase()}`; if (projects.has(k)) return projects.get(k)!;
      const id = await insertRow(t, 'projects', { companyId: cid, name, status: 'ACTIVE', priority: 3, ownerId: adminId, ...(archived.has(name) ? { archivedAt: nowIso() } : {}) }, adminId); projects.set(k, id); rep.created.projects++; return id;
    };
    const people = new Map<string, string>(); for (const p of await t.all<any>('SELECT id, name FROM people WHERE company_id IS NULL')) people.set(p.name.toLowerCase(), p.id);
    const pinfo = data.pinfo ?? {};
    const person = async (name: string) => {
      const k = name.toLowerCase(); if (people.has(k)) return people.get(k)!;
      const i = typeof pinfo[name] === 'object' && pinfo[name] ? pinfo[name] : {};
      const id = await insertRow(t, 'people', { name, active: true, designation: i.desig ?? i.designation ?? i.role ?? null, phone: i.phone ?? i.ph ?? i.mobile ?? null, email: i.email ?? i.mail ?? null,
        notes: typeof pinfo[name] === 'string' ? pinfo[name] : (i.notes ?? null), ...(archived.has(name) ? { archivedAt: nowIso() } : {}) }, adminId); people.set(k, id); rep.created.people++; return id;
    };
    for (const n of data.people ?? []) if (String(n).toLowerCase() !== ownerName.toLowerCase()) await person(n);

    const done = new Set((await t.all<any>("SELECT detail FROM activity_log WHERE action = 'IMPORTED'")).map((r) => { try { return JSON.parse(r.detail).protoId; } catch { return null; } }));
    const idMap = new Map<string, string>(); const deps: [string, string][] = [];
    for (const x of data.tasks) {
      if (!x?.title || !x.co) { rep.warnings.push(`Skipped a task without a title/company${x?.title ? `: ${x.title}` : ''}.`); continue; }
      if (done.has(x.id)) { rep.skippedTasks++; continue; }
      const cid = await company(x.co); const pid = x.proj ? await project(cid, x.proj) : null;
      const who = x.who && String(x.who).toLowerCase() !== ownerName.toLowerCase() ? await person(x.who) : null;
      const status = x.done ? 'DONE' : x.stg === 'wait' || x.wait ? 'WAITING' : who && (x.dl || x.stg === 'dl') ? 'DELEGATED' : x.stg === 'doing' ? 'DOING' : 'TODO';
      let ruleId: string | null = null; if (x.rec && FREQ[x.rec]) ruleId = await insertRow(t, 'recurring_rules', { companyId: cid, frequency: FREQ[x.rec], intervalCount: 1, active: true }, adminId);
      const last = ts(x.upd) ?? ts(x.log?.[x.log.length - 1]?.[0]) ?? nowIso();
      const tid = await insertRow(t, 'tasks', { companyId: cid, projectId: pid, title: String(x.title), ownerId: adminId, delegatedToId: who, delegatedAt: who ? last : null, priority: [1, 2, 3, 4].includes(x.pri) ? x.pri : 3, status,
        dueDate: day(x.due), waitingFor: x.wait || null, nextFollowupDate: day(x.fu), postponeCount: Number(x.pp) || 0, lastActivityAt: day(x.upd) ? `${day(x.upd)}T12:00:00.000Z` : last,
        focusMinutes: Math.round(Number(x.focus) || 0), recurringRuleId: ruleId, nextOccurrenceCreated: !!x.spawned, completedAt: x.done ? (ts(x.doneAt) ?? last) : null, completedById: x.done ? adminId : null,
        completionNote: x.note || null, isDemo: false }, adminId);
      idMap.set(x.id, tid); rep.created.tasks++;
      if (day(x.fu) && !x.done) await reconcileFollowupDate(t, adminId, { id: tid, companyId: cid }, day(x.fu));
      if (x.dep) deps.push([tid, x.dep]);
      for (const [i, s] of (x.subs ?? []).entries()) { await insertRow(t, 'subtasks', { taskId: tid, companyId: cid, title: String(s.n ?? s.title ?? 'Subtask'), position: i, status: s.d ? 'DONE' : 'TODO', progress: s.d ? 100 : 0, completedAt: s.d ? last : null }, adminId); rep.created.subtasks++; }
      for (const n of x.notes ?? []) { const [when, text] = Array.isArray(n) ? n : [null, n]; if (!text) continue;
        const id = await insertRow(t, 'comments', { companyId: cid, entityType: 'TASK', entityId: tid, body: String(text), authorId: adminId }, adminId);
        const w = ts(when); if (w) await t.run('UPDATE comments SET created_at = ? WHERE id = ?', [w, id]); rep.created.notes++; }
      for (const l of x.log ?? []) { const [when, text] = Array.isArray(l) ? l : [null, l]; if (!text) continue;
        await audit(t, { companyId: cid, entityType: 'TASK', entityId: tid, action: 'PROTOTYPE_LOG', detail: String(text), userId: adminId });
        const w = ts(when); if (w) await t.run("UPDATE activity_log SET created_at = ? WHERE id = (SELECT id FROM activity_log WHERE entity_id = ? AND action = 'PROTOTYPE_LOG' ORDER BY rowid DESC LIMIT 1)", [w, tid]); }
      for (const a of x.att ?? []) {
        const url = [a?.d, a?.data, a?.url, typeof a === 'string' ? a : null].find((v) => typeof v === 'string' && v.startsWith('data:')) as string | undefined;
        if (!url) { rep.warnings.push(`An attachment on “${x.title}” had no embedded data and was skipped.`); continue; }
        const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url); if (!m) continue;
        const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
        await insertRow(t, 'attachments', { taskId: tid, companyId: cid, fileName: String(a.n ?? a.name ?? 'attachment'), mimeType: m[1] || 'application/octet-stream', sizeBytes: bytes.length, storageKey: files.put(bytes) }, adminId); rep.created.attachments++;
      }
      await audit(t, { companyId: cid, entityType: 'TASK', entityId: tid, action: 'IMPORTED', detail: { protoId: x.id }, userId: adminId });
    }
    for (const [tid, protoDep] of deps) { const target = idMap.get(protoDep); if (target) await t.run('UPDATE tasks SET depends_on_id = ? WHERE id = ?', [target, tid]); else rep.warnings.push('A dependency pointed to a task that was not imported; it was left unlinked.'); }
    for (const s of data.sess ?? []) {
      const tid = idMap.get(s.task); if (!tid) { rep.warnings.push('A focus session referred to a task that was not imported; skipped.'); continue; }
      const task = (await t.get<any>('SELECT company_id FROM tasks WHERE id = ?', [tid]))!;
      await insertRow(t, 'focus_sessions', { userId: adminId, taskId: tid, companyId: task.companyId, startedAt: ts(s.start) ?? nowIso(), endedAt: ts(s.end) ?? ts(s.start) ?? nowIso(), plannedMinutes: Math.max(1, Math.round(Number(s.planned) || 25)),
        actualMinutes: Math.round(Number(s.min) || 0), completed: !!s.ok, note: s.note || null }, adminId); rep.created.focusSessions++;
    }
    const set = data.set; if (set && typeof set === 'object') {
      const cur = await t.get<any>('SELECT * FROM user_settings WHERE user_id = ?', [adminId]);
      const map: Record<string, string> = { f: 'focus_minutes', s: 'short_break_minutes', l: 'long_break_minutes', n: 'sessions_before_long', stale: 'stale_days', soon: 'due_soon_days', esc: 'escalate_days' };
      const sets = Object.entries(map).filter(([k]) => Number.isInteger(set[k]) && set[k] > 0).map(([k, col]) => [col, set[k]] as const);
      if (cur && sets.length) await t.run(`UPDATE user_settings SET ${sets.map(([c]) => c + ' = ?').join(', ')}, updated_at = ? WHERE user_id = ?`, [...sets.map(([, v]) => v), nowIso(), adminId]);
    }
  });
  return rep;
}
