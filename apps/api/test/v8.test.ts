import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup } from './helpers.ts';
import { digestTick, vaultTick } from '../src/lib/scheduler.ts';
import { localDay } from '../src/lib/ai.ts';

const opened: { close: () => void }[] = []; after(() => opened.forEach((m) => m.close()));
async function mock(replies: object[]) {
  const requests: any[] = []; let i = 0;
  const srv = createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { requests.push(JSON.parse(raw || '{}')); const r = replies[Math.min(i++, replies.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(r) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port;
  const h = { requests, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } }; opened.push(h); return h;
}
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('templates: save, share, use-fields round trip; only the author may change one', async () => {
  const { call, A } = await setup();
  const t = (await call('USER', 'POST', '/templates', { name: 'Monthly GST', title: 'File GSTR-3B', companyId: A.id, repeatFrequency: 'MONTHLY', dueInDays: 20, subtasks: [{ title: 'Download 2B', dueInDays: 5 }, { title: 'Pay tax' }], shared: false })).body;
  assert.equal(t.subtasks.length, 2); assert.equal(t.repeatFrequency, 'MONTHLY');
  assert.equal((await call('MANAGER', 'GET', '/templates')).body.items.length, 0, 'private to the author until shared');
  assert.equal((await call('USER', 'PATCH', `/templates/${t.id}`, { expectedUpdatedAt: t.updatedAt, shared: true })).status, 200);
  assert.equal((await call('MANAGER', 'GET', '/templates')).body.items.length, 1, 'shared with the company');
  assert.equal((await call('outsider', 'GET', '/templates')).body.items.length, 0, 'not shared outside the company');
  const cur = (await call('USER', 'GET', '/templates')).body.items[0];
  assert.equal((await call('MANAGER', 'PATCH', `/templates/${t.id}`, { expectedUpdatedAt: cur.updatedAt, name: 'hack' })).status, 403);
  assert.equal((await call('USER', 'POST', `/templates/${t.id}/archive`)).status, 200);
  assert.equal((await call('USER', 'GET', '/templates')).body.items.length, 0);
});

test('chase queue: finds who owes you, suggests a tone, hides what was just chased, snooze works, private flag kept', async () => {
  const { call, A } = await setup();
  const p = (await call('admin', 'POST', '/people', { companyId: A.id, name: 'Anil Kumar', phone: '9800011111' })).body;
  const boss = (await call('admin', 'POST', '/people', { companyId: A.id, name: 'Boss Man' })).body;
  await call('admin', 'PATCH', `/people/${p.id}`, { expectedUpdatedAt: p.updatedAt, reportsToId: boss.id });
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'File GSTR-3B', dueDate: day(-3), delegatedToId: p.id, status: 'DELEGATED' })).body;
  const sub = (await call('admin', 'POST', `/tasks/${t.id}/subtasks`, { title: 'Send challan', assigneeId: p.id, dueDate: day(5) })).body;
  await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Own work, not delegated', dueDate: day(-9) });
  const q = (await call('admin', 'GET', `/chase?today=${day(0)}`)).body;
  assert.equal(q.total, 1, 'only the overdue delegated task (the sub-task is not due yet; own work is not chased)');
  assert.equal(q.items[0].title, 'File GSTR-3B'); assert.equal(q.items[0].tone, 'gentle'); assert.equal(q.items[0].overdueDays, 3); assert.match(q.items[0].message, /Hi Anil/);
  assert.equal(q.items[0].person.phone, '9800011111');
  // log a reminder through the existing follow-up logger -> hidden for 2 days, then firmer
  const log = await call('admin', 'POST', `/tasks/${t.id}/followups`, { type: 'WHATSAPP', personId: p.id, notes: 'Reminder sent', today: day(0), reminder: { tone: 'gentle', via: 'whatsapp', message: 'hi' } });
  assert.equal(log.status, 201);
  assert.equal((await call('admin', 'GET', `/chase?today=${day(0)}`)).body.total, 0, 'just chased');
  const later = (await call('admin', 'GET', `/chase?today=${day(3)}`)).body; assert.equal(later.total, 1); assert.equal(later.items[0].tone, 'firm'); assert.equal(later.items[0].priorReminders, 1);
  await call('admin', 'POST', `/tasks/${t.id}/followups`, { type: 'WHATSAPP', personId: p.id, notes: 'Reminder 2', today: day(3), reminder: { tone: 'firm', via: 'whatsapp', message: 'hi' } });
  const third = (await call('admin', 'GET', `/chase?today=${day(6)}`)).body.items[0]; assert.equal(third.tone, 'escalate'); assert.match(third.message, /copying Boss Man/);
  const sn = await call('admin', 'POST', '/chase/snooze', { taskId: t.id, days: 5, today: day(6) }); assert.equal(sn.status, 200);
  assert.equal((await call('admin', 'GET', `/chase?today=${day(6)}`)).body.items.filter((i: any) => !i.subtaskId).length, 0, 'task snoozed (its sub-task is now due and still shows)');
  assert.equal((await call('admin', 'GET', `/chase?today=${day(12)}`)).body.items.filter((i: any) => !i.subtaskId).length, 1, 'snooze ends');
  void sub;
});

test('approvals: ask, approve/reject with reason, only the approver decides, requester can cancel, notifications', async () => {
  const { call, A, users } = await setup();
  assert.equal((await call('USER', 'POST', '/approvals', { companyId: A.id, approverId: users.USER, title: 'x' })).status, 400, 'cannot ask yourself');
  const ap = (await call('USER', 'GET', `/approvals/approvers?companyId=${A.id}`)).body.items.map((x: any) => x.name); assert.ok(ap.includes('MANAGER'));
  const a = (await call('USER', 'POST', '/approvals', { companyId: A.id, approverId: users.MANAGER, title: 'Buy a printer', amount: 'Rs 18,000', details: 'Old one is dead' })).body; assert.equal(a.status, 'PENDING');
  assert.equal((await call('MANAGER', 'GET', '/approvals/count')).body.inbox, 1);
  assert.ok((await call('MANAGER', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'APPROVAL_REQUEST'));
  assert.equal((await call('USER', 'POST', `/approvals/${a.id}/decide`, { decision: 'APPROVED' })).status, 403, 'requester cannot approve own request');
  assert.equal((await call('MANAGER', 'POST', `/approvals/${a.id}/decide`, { decision: 'REJECTED' })).status, 400, 'a reason is needed to reject');
  const d = await call('MANAGER', 'POST', `/approvals/${a.id}/decide`, { decision: 'APPROVED', note: 'Go ahead' }); assert.equal(d.status, 200); assert.equal(d.body.status, 'APPROVED');
  assert.ok((await call('USER', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'APPROVAL_DECIDED'));
  assert.equal((await call('MANAGER', 'POST', `/approvals/${a.id}/decide`, { decision: 'REJECTED', note: 'no' })).status, 400, 'already decided');
  const b = (await call('USER', 'POST', '/approvals', { companyId: A.id, approverId: users.MANAGER, title: 'Second' })).body;
  assert.equal((await call('USER', 'POST', `/approvals/${b.id}/cancel`)).status, 200);
  assert.equal((await call('outsider', 'GET', '/approvals')).body.items.length, 0, 'strangers see nothing');
  assert.equal((await call('VIEWER', 'POST', '/approvals', { companyId: A.id, approverId: users.MANAGER, title: 'v' })).status, 403);
  const out = (await call('USER', 'POST', '/approvals', { companyId: A.id, approverId: (await call('admin', 'GET', '/users')).body.items.find((u: any) => u.name === 'Outsider').id, title: 'bad' })); assert.equal(out.status, 400, 'approver must belong to the company');
});

test('digest: preview text, preferences, and the scheduler makes one alert per slot', async () => {
  const { app, call, A } = await setup();
  const p = (await call('admin', 'POST', '/people', { companyId: A.id, name: 'Priya' })).body;
  await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Overdue thing', dueDate: day(-2), delegatedToId: p.id });
  await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Today thing', dueDate: day(0) });
  const d = (await call('admin', 'GET', `/digest?kind=morning&today=${day(0)}`)).body;
  assert.match(d.text, /Good morning, Admin/); assert.match(d.text, /\*Overdue \(1\)\*/); assert.match(d.text, /Overdue thing/); assert.match(d.text, /Due today/); assert.ok(d.total >= 2);
  const e = (await call('admin', 'GET', `/digest?kind=evening&today=${day(0)}`)).body; assert.match(e.text, /Good evening/); assert.match(e.text, /Today thing/);
  const pr = (await call('admin', 'PUT', '/digest/prefs', { enabled: true, morning: '07:00', evening: '19:00', phone: '98000 11111' })).body; assert.equal(pr.morning, '07:00');
  assert.equal((await call('admin', 'PUT', '/digest/prefs', { enabled: true, morning: '7am', evening: '19:00' })).status, 400);
  const noon = new Date(); noon.setHours(8, 0, 0, 0);
  const made1 = await digestTick(app, noon); assert.ok(made1 >= 1, 'morning digest alert');
  assert.equal(await digestTick(app, noon), 0, 'not repeated the same day');
  const n = (await call('admin', 'GET', '/notifications')).body.items.filter((x: any) => x.kind === 'DIGEST'); assert.equal(n.length, 1); assert.equal(n[0].link, 'digest/morning');
  const late = new Date(); late.setHours(19, 5, 0, 0); assert.ok((await digestTick(app, late)) >= 1, 'evening alert');
  await call('admin', 'PUT', '/digest/prefs', { enabled: false, morning: '07:00', evening: '19:00' });
});

test('vault: documents with files, expiry status, alerts once per step, scoped members, private AI switch', async () => {
  const m = await mock([{ answer: 'The lease ends on 31 March 2027.', found: true }]);
  const w = await setup({ ai: { apiKey: 'sk-test-KEY-1', model: 'gpt-4o-mini', baseUrl: m.baseUrl, timeoutMs: 3000, dailyLimit: 50 } });
  const { app, call, raw, A, B } = w;
  const d = (await call('USER', 'POST', '/vault', { companyId: A.id, title: 'Shop lease', category: 'Agreement', party: 'Mr Nair', expiresOn: day(20), remindDays: 30 })).body;
  assert.equal(d.status, 'soon'); assert.equal(d.daysLeft, 20);
  const old = (await call('USER', 'POST', '/vault', { companyId: A.id, title: 'Fire NOC', category: 'Licence / Permit', expiresOn: day(-3) })).body; assert.equal(old.status, 'expired');
  await call('USER', 'POST', '/vault', { companyId: A.id, title: 'Memorandum', category: 'Other' });
  const f = await call('USER', 'POST', `/vault/${d.id}/files`, { fileName: 'lease.txt', mimeType: 'text/plain', dataBase64: Buffer.from('Lease ends 31 March 2027.').toString('base64') }); assert.equal(f.status, 201);
  const dl = await raw('USER', 'GET', `/vault/files/${f.body.id}/download`); assert.equal(dl.statusCode, 200); assert.match(dl.body, /Lease ends/);
  const list = (await call('USER', 'GET', `/vault?companyId=${A.id}`)).body; assert.equal(list.items.length, 3); assert.equal(list.counts.expired, 1); assert.equal(list.counts.soon, 1); assert.equal(list.items[0].title === 'Fire NOC' || list.items[0].title === 'Shop lease', true);
  assert.equal((await call('USER', 'GET', `/vault?companyId=${A.id}&q=lease`)).body.items.length, 1, 'search finds the title and file names');
  assert.equal((await call('USER', 'GET', `/vault?companyId=${A.id}&expiring=1`)).body.items.length, 2);
  assert.equal((await call('USER', 'GET', '/vault/expiring')).body.items.length, 2);
  assert.equal((await call('outsider', 'GET', `/vault/${d.id}`)).status, 404, 'other companies cannot see it');
  assert.equal((await call('VIEWER', 'GET', `/vault/${d.id}`)).status, 200); assert.equal((await call('VIEWER', 'POST', '/vault', { companyId: A.id, title: 'nope' })).status, 403);
  assert.equal((await call('USER', 'POST', '/vault', { companyId: B.id, title: 'x' })).status, 404);
  const n1 = await vaultTick(app, new Date()); assert.ok(n1 >= 2, 'alerts for the soon and expired documents'); assert.equal(await vaultTick(app, new Date()), 0, 'once per step');
  const notes = (await call('USER', 'GET', '/notifications')).body.items.filter((n: any) => n.kind === 'DOC_EXPIRY'); assert.equal(notes.length, 2);
  const ask = await call('USER', 'POST', `/vault/${d.id}/ask`, { question: 'When does the lease end?' }); assert.equal(ask.status, 200); assert.match(ask.body.answer, /31 March/);
  assert.match(JSON.stringify(m.requests.at(-1).messages), /Lease ends 31 March 2027/, 'file text reaches the AI only on request');
  const cur = (await call('USER', 'GET', `/vault/${d.id}`)).body; await call('USER', 'PATCH', `/vault/${d.id}`, { expectedUpdatedAt: cur.updatedAt, aiExcluded: true });
  const before = m.requests.length; assert.equal((await call('USER', 'POST', `/vault/${d.id}/ask`, { question: 'When does the lease end?' })).status, 403); assert.equal(m.requests.length, before);
  const cur2 = (await call('USER', 'GET', `/vault/${d.id}`)).body; assert.equal((await call('USER', 'PATCH', `/vault/${d.id}`, { expectedUpdatedAt: cur.updatedAt, title: 'stale' })).status, 409);
  assert.equal((await call('USER', 'PATCH', `/vault/${d.id}`, { expectedUpdatedAt: cur2.updatedAt, archived: true })).status, 200);
  assert.equal((await call('USER', 'GET', `/vault?companyId=${A.id}`)).body.items.length, 2);
  void localDay;
});

test('weekly review: totals, per-company and per-person, stalled and AI narrative that hides private titles', async () => {
  const m = await mock([{ headline: 'A steady week.', wins: ['Two done'], concerns: ['One overdue'], suggestions: ['Chase Priya'] }]);
  const w = await setup({ ai: { apiKey: 'sk-test-KEY-1', model: 'gpt-4o-mini', baseUrl: m.baseUrl, timeoutMs: 3000, dailyLimit: 50 } });
  const { call, A } = w;
  const p = (await call('admin', 'POST', '/people', { companyId: A.id, name: 'Priya Nair' })).body;
  const t1 = (await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Finish audit', dueDate: day(-1) })).body;
  await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Secret deal', dueDate: day(-4), delegatedToId: p.id, aiExcluded: true });
  await call('admin', 'PATCH', `/tasks/${t1.id}`, { expectedUpdatedAt: t1.updatedAt, status: 'DONE' });
  const r = (await call('admin', 'GET', `/owner/weekly?end=${day(0)}`)).body;
  assert.equal(r.totals.done, 1); assert.equal(r.totals.overdue, 1); assert.equal(r.totals.created, 2); assert.equal(r.companies[0].overdue, 1); assert.equal(r.people[0].name, 'Priya Nair'); assert.ok(r.concerns.length >= 1);
  const a = await call('admin', 'POST', '/owner/weekly/ai', { end: day(0) }); assert.equal(a.status, 200); assert.equal(a.body.headline, 'A steady week.');
  assert.doesNotMatch(JSON.stringify(m.requests.at(-1).messages), /Secret deal/, 'private task titles never reach the AI');
  const off = await setup(); assert.equal((await off.call('admin', 'POST', '/owner/weekly/ai', {})).status, 503);
});

test('backup & restore now carry Notebook notes/files, vault documents/files, templates, approvals', async () => {
  const w = await setup(); const { call, raw, A } = w;
  const nb = (await call('admin', 'GET', '/notebooks')).body.items[0];
  const n = (await call('admin', 'POST', '/journal', { title: 'Meeting', body: 'hello', notebookId: nb.id, companyId: A.id })).body;
  await call('admin', 'POST', `/journal/${n.id}/files`, { fileName: 'a.txt', mimeType: 'text/plain', dataBase64: Buffer.from('note file').toString('base64') });
  const d = (await call('admin', 'POST', '/vault', { companyId: A.id, title: 'Licence', expiresOn: day(100) })).body;
  await call('admin', 'POST', `/vault/${d.id}/files`, { fileName: 'l.txt', mimeType: 'text/plain', dataBase64: Buffer.from('licence file').toString('base64') });
  await call('admin', 'POST', '/templates', { name: 'T', title: 'T1', subtasks: [] });
  const zip = (await raw('admin', 'GET', '/backup')).rawPayload; const JSZip = (await import('jszip')).default; const z = await JSZip.loadAsync(zip);
  for (const t of ['journal_notes', 'journal_files', 'vault_docs', 'vault_files', 'task_templates', 'approvals', 'notebooks']) assert.ok(z.file(`data/${t}.csv`), `${t}.csv is in the backup`);
  assert.equal(Object.keys(z.files).filter((f) => f.startsWith('files/') && !f.endsWith('/')).length, 2, 'both uploaded files are in the backup');
  const v = (await call('admin', 'POST', '/restore/validate', { dataBase64: zip.toString('base64') })).body; assert.equal(v.ok, true, JSON.stringify(v.errors)); assert.equal(v.counts.vault_docs, 1); assert.equal(v.counts.journal_notes, 1); assert.equal(v.files, 2);
  const ap = await call('admin', 'POST', '/restore/apply', { token: v.token, mode: 'REPLACE', confirm: 'RESTORE' }); assert.equal(ap.status, 200, JSON.stringify(ap.body));
});

test('export any AI text to Word: returns a .docx, needs company access for branding, rejects empty', async () => {
  const { raw, call, A } = await setup();
  const r = await raw('USER', 'POST', '/export-word/text', { title: 'Weekly note', subtitle: 'AI draft', body: 'Line one\n\n- point a\n- point b', companyId: A.id });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-disposition']), /\.docx/);
  assert.equal(r.rawPayload.subarray(0, 2).toString(), 'PK', 'a docx is a zip file');
  assert.equal((await raw('USER', 'POST', '/export-word/text', { title: 'x', body: '' })).statusCode, 400);
  assert.ok([403, 404].includes((await raw('outsider', 'POST', '/export-word/text', { title: 'x', body: 'hi', companyId: A.id })).statusCode));
  void call;
});
