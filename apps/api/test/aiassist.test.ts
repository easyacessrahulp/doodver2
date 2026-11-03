import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup } from './helpers.ts';

const KEY = 'sk-test-SECRET-KEY-98765';
const opened: { close: () => void }[] = []; after(() => opened.forEach((m) => m.close()));
async function mock(replies: (object | ((b: any) => object))[]) {
  const requests: any[] = []; let i = 0;
  const srv = createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    const body = JSON.parse(raw || '{}'); requests.push(body); let r: any = replies[Math.min(i++, replies.length - 1)]; if (typeof r === 'function') r = r(body);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(r) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port;
  const h = { requests, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } }; opened.push(h); return h;
}
const cfg = (m: { baseUrl: string }) => ({ apiKey: KEY, model: 'gpt-4o-mini', baseUrl: m.baseUrl, timeoutMs: 3000, dailyLimit: 50 });

async function world(replies: any[]) {
  const m = await mock(replies); const w = await setup({ ai: cfg(m) });
  const { call, A, project } = w;
  const boss = (await call('admin', 'POST', '/people', { name: 'Joseph Thomas', companyId: A.id })).body;
  const anil = (await call('admin', 'POST', '/people', { name: 'Anil Kumar', companyId: A.id, phone: '9847000210', reportsToId: boss.id })).body;
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'Vetix customs clearance', priority: 2, status: 'TODO', dueDate: '2026-10-20', delegatedToId: anil.id })).body;
  const s = (await call('admin', 'POST', `/tasks/${t.id}/subtasks`, { title: 'End-use letter', assigneeId: anil.id, dueDate: '2026-10-20' })).body;
  const secret = (await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Secret salary plan', priority: 3, status: 'TODO', aiExcluded: true })).body;
  return { ...w, m, anil, boss, t, s, secret };
}

test('quick add: AI fills the form, names become ids, private tasks are never sent', async () => {
  const w = await world([{ kind: 'subtask', title: 'Collect scan', company: 'Alpha Ltd', project: null, parentTask: 'Vetix customs clearance', person: 'Anil', dueDate: '2026-10-23', followUpDate: '2026-10-24', priority: 2, notes: null }]);
  const r = await w.call('admin', 'POST', '/ai/quickadd', { text: 'Ask Anil for the scan by Friday', today: '2026-10-22' });
  assert.equal(r.status, 200);
  assert.equal(r.body.draft.kind, 'subtask'); assert.equal(r.body.draft.parentTaskId, w.t.id); assert.equal(r.body.draft.personId, w.anil.id); assert.equal(r.body.draft.companyId, w.A.id);
  assert.equal(r.body.draft.dueDate, '2026-10-23'); assert.equal(r.body.skippedPrivate, 1);
  assert.ok(!JSON.stringify(w.m.requests).includes('Secret salary plan'), 'private task title never reaches OpenAI');
  assert.equal((await w.call('admin', 'GET', '/tasks?companyId=' + w.A.id)).body.items.length, 2, 'nothing was created by the AI');
  const off = await setup(); assert.equal((await off.call('admin', 'POST', '/ai/quickadd', { text: 'hello there' })).status, 503);
});

test('letter reader: PDF goes as a file, matches a task, private tasks are not offered', async () => {
  const w = await world([{ from: 'Customs', subject: 'Notice', summary: 'Clarify end use.', asks: ['Send end-use letter'], replyDeadline: '2026-10-30', matchedTask: 'T1', suggestions: [{ title: 'Get signed letter', person: 'Anil Kumar', dueDate: '2026-10-25' }] }]);
  const r = await w.call('admin', 'POST', '/ai/letter', { fileName: 'n.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 test').toString('base64') });
  assert.equal(r.status, 200); assert.equal(r.body.matchedTaskId, w.t.id); assert.equal(r.body.suggestions[0].personId, w.anil.id); assert.equal(r.body.skippedPrivate, 1);
  const content = w.m.requests[0].messages[1].content; assert.equal(content[1].type, 'file');
  assert.ok(!JSON.stringify(w.m.requests).includes('Secret salary'));
  assert.equal((await w.call('admin', 'POST', '/ai/letter', { fileName: 'x.exe', mimeType: 'application/x-msdownload', dataBase64: 'AAAAAAAAAAAA' })).status, 400);
});

test('follow-up message: tone follows reminders sent; escalate copies manager; private and no-key use a plain template', async () => {
  const w = await world([{ message: 'Hi Anil, reminder.' }, { message: 'Hi Anil, firm.' }, { message: 'Hi Anil, escalate.' }]);
  const q = { taskId: w.t.id, subtaskId: w.s.id, today: '2026-10-22' };
  const a = (await w.call('admin', 'POST', '/ai/followup-message', q)).body;
  assert.equal(a.suggestedTone, 'gentle'); assert.equal(a.priorReminders, 0); assert.equal(a.to.name, 'Anil Kumar'); assert.equal(a.message, 'Hi Anil, reminder.'); assert.equal(a.manager, null);
  const log = await w.call('admin', 'POST', `/tasks/${w.t.id}/followups`, { type: 'WHATSAPP', subtaskId: w.s.id, personId: w.anil.id, notes: 'Reminder sent on WhatsApp', nextDate: '2026-10-24', reminder: { tone: 'gentle', via: 'whatsapp', message: 'Hi Anil, reminder.' } });
  assert.equal(log.status, 201); assert.equal(log.body.subtaskId, w.s.id); assert.equal(log.body.reminderCount, 1);
  const b = (await w.call('admin', 'POST', '/ai/followup-message', q)).body; assert.equal(b.suggestedTone, 'firm'); assert.equal(b.priorReminders, 1);
  await w.call('admin', 'POST', `/tasks/${w.t.id}/followups`, { type: 'WHATSAPP', subtaskId: w.s.id, personId: w.anil.id, notes: 'second', reminder: { tone: 'firm', via: 'whatsapp', message: 'x' } });
  const c = (await w.call('admin', 'POST', '/ai/followup-message', q)).body; assert.equal(c.suggestedTone, 'escalate'); assert.equal(c.manager.name, 'Joseph Thomas');
  const before = w.m.requests.length;
  const p = (await w.call('admin', 'POST', '/ai/followup-message', { taskId: w.secret.id })).body; assert.equal(p.written, 'template'); assert.match(p.note, /Private/);
  assert.equal(w.m.requests.length, before, 'private task: no OpenAI call');
  const off = await setup(); const t2 = (await off.call('admin', 'POST', '/tasks', { companyId: off.A.id, title: 'Plain', priority: 3, status: 'TODO' })).body;
  const o = await off.call('admin', 'POST', '/ai/followup-message', { taskId: t2.id }); assert.equal(o.status, 200); assert.equal(o.body.written, 'template');
});

test('reply reader suggests updates (nothing applied) and refuses private tasks', async () => {
  const w = await world([{ status: 'partly_done', summary: 'Signed; scan tomorrow.', promisedDate: '2026-10-23', nextFollowUpDate: '2026-10-23', historyNote: 'Letter signed; scan Fri' }]);
  const r = await w.call('admin', 'POST', '/ai/reply-read', { taskId: w.t.id, subtaskId: w.s.id, replyText: 'Sir signed, scan tomorrow 11am', today: '2026-10-22' });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'partly_done'); assert.deepEqual(r.body.updates.map((u: any) => u.kind), ['SUBTASK_DOING', 'NEXT_FOLLOWUP', 'HISTORY_NOTE']);
  assert.equal((await w.call('admin', 'GET', `/tasks/${w.t.id}/subtasks`)).body.items[0].status, 'TODO', 'not applied');
  const p = await w.call('admin', 'POST', '/ai/reply-read', { taskId: w.secret.id, replyText: 'done' }); assert.equal(p.status, 409);
});

test('Ask Dood answers with sources, never reads private tasks, exports to Word', async () => {
  const w = await world([{ headline: 'One thing pending.', answer: [{ text: 'Anil owes the end-use letter.', sources: [1, 99] }] }]);
  const r = await w.call('admin', 'POST', '/ai/ask', { question: 'What is pending with Anil?', today: '2026-10-22' });
  assert.equal(r.status, 200); assert.ok(r.body.sources.length >= 1); assert.ok(r.body.sources.every((s: any) => s.link.startsWith('#task/'))); assert.deepEqual(r.body.answer[0].sources.includes(99), false);
  assert.equal(r.body.skippedPrivate, 1); assert.ok(!JSON.stringify(w.m.requests).includes('Secret salary'));
  const x = await w.raw('admin', 'POST', '/ai/ask/export', { question: 'q', headline: r.body.headline, answer: r.body.answer, sources: r.body.sources });
  assert.equal(x.statusCode, 200); assert.match(String(x.headers['content-type']), /wordprocessingml/);
});

test('"Ask all for status" builds messages without AI, including private work', async () => {
  const w = await world([{}]);
  const r = await w.call('admin', 'POST', '/workload/status-messages', { personIds: [w.anil.id] });
  assert.equal(r.status, 200); assert.equal(r.body.items[0].count, 2); assert.match(r.body.items[0].message, /Vetix customs clearance/); assert.equal(w.m.requests.length, 0);
});
