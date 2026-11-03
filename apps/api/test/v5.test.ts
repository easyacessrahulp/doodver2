import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { dueReminders, type ReminderState } from '../../web/src/reminders-logic.ts';

async function world() {
  const w = await setup(); const { call, A, project } = w;
  const person = (await call('admin', 'POST', '/people', { companyId: A.id, name: 'Ravi' })).body;
  const task = (await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'GST filing', priority: 2, status: 'TODO', dueDate: '2026-01-01', delegatedToId: person.id })).body;
  const sub = (await call('admin', 'POST', `/tasks/${task.id}/subtasks`, { title: 'Collect invoices', assigneeId: person.id, dueDate: '2026-01-02' })).body;
  return { ...w, person, task, sub };
}

test('v5: notes keep versions, become internal, export to Word, share to discussions and re-circulate', async () => {
  const { call, raw, task, sub, person, A } = await world();
  const n = (await call('admin', 'POST', '/notes', { taskId: task.id, subtaskId: sub.id, title: 'Invoice plan', body: '- collect\n- verify\n1. send' })).body;
  assert.equal(n.version, 1);
  const internal = (await call('admin', 'PATCH', `/notes/${n.id}`, { expectedUpdatedAt: n.updatedAt, kind: 'INTERNAL' })).body;
  assert.equal(internal.kind, 'INTERNAL'); assert.equal(internal.version, 1);
  const list = (await call('admin', 'GET', `/notes?companyId=${A.id}&kind=INTERNAL`)).body.items; assert.equal(list.length, 1);
  const sh = (await call('admin', 'POST', `/notes/${n.id}/share`, { personId: person.id })).body; assert.equal(sh.updated, false);
  const disc = (await call('admin', 'GET', `/discussions?taskId=${task.id}`)).body.items; assert.equal(disc.length, 1); assert.match(disc[0].agenda, /verify/);
  // revise while the discussion is pending → same discussion updated
  const fresh = (await call('admin', 'GET', `/notes/${n.id}`)).body;
  const r2 = (await call('admin', 'PATCH', `/notes/${n.id}`, { expectedUpdatedAt: fresh.updatedAt, body: '- collect\n- verify\n- file', changeNote: 'Added filing step' })).body; assert.equal(r2.version, 2);
  const sh2 = (await call('admin', 'POST', `/notes/${n.id}/share`, {})).body; assert.equal(sh2.updated, true);
  const d2 = (await call('admin', 'GET', `/discussions?taskId=${task.id}`)).body.items; assert.equal(d2.length, 1); assert.match(d2[0].agenda, /file/); assert.match(d2[0].topic, /v2/);
  // settle the discussion, revise again → a new "Revised" discussion is raised
  await call('admin', 'PATCH', `/discussions/${d2[0].id}`, { expectedUpdatedAt: d2[0].updatedAt, done: true, decisions: 'Approved' });
  const cur = (await call('admin', 'GET', `/notes/${n.id}`)).body; assert.equal(cur.versions.length, 2); assert.equal(cur.discussion.decisions, 'Approved');
  const r3 = (await call('admin', 'PATCH', `/notes/${n.id}`, { expectedUpdatedAt: cur.updatedAt, body: cur.body + '\n- after approval', changeNote: 'Post-discussion' })).body;
  const sh3 = (await call('admin', 'POST', `/notes/${n.id}/share`, {})).body; assert.equal(sh3.updated, false); assert.equal(r3.version, 3);
  assert.equal((await call('admin', 'GET', `/discussions?taskId=${task.id}`)).body.items.length, 1);
  const docx = await raw('admin', 'GET', `/notes/${n.id}/export.docx`);
  assert.equal(docx.statusCode, 200); assert.match(String(docx.headers['content-type']), /wordprocessingml/); assert.equal(docx.rawPayload.subarray(0, 2).toString(), 'PK');
  // stale write is refused, viewer cannot write
  assert.equal((await call('admin', 'PATCH', `/notes/${n.id}`, { expectedUpdatedAt: n.updatedAt, title: 'x' })).status, 409);
  assert.equal((await call('VIEWER', 'POST', '/notes', { taskId: task.id, title: 'no' })).status, 403);
  assert.equal((await call('outsider', 'GET', `/notes/${n.id}`)).status, 404);
});

test('v5: an email written from Calls and marked Done counts as sent and moves to completed', async () => {
  const { call, task } = await world();
  const c = (await call('admin', 'POST', '/calls', { taskId: task.id, channel: 'EMAIL', contactName: 'Bank manager', note: 'Ask for statement' })).body;
  assert.equal((await call('admin', 'PATCH', `/calls/${c.id}`, { expectedUpdatedAt: c.updatedAt, done: true, sent: true })).status, 400);   // nothing written yet
  const r = await call('admin', 'PATCH', `/calls/${c.id}`, { expectedUpdatedAt: c.updatedAt, done: true, sent: true, emailSubject: 'Statement request', emailBody: 'Dear Sir…' });
  assert.equal(r.status, 200); assert.ok(r.body.doneAt); assert.ok(r.body.sentAt); assert.match(r.body.result, /Email sent/);
  assert.equal((await call('admin', 'GET', '/calls?status=pending')).body.items.length, 0);
  assert.equal((await call('admin', 'GET', '/calls?status=done')).body.items.length, 1);
  const notes = (await call('admin', 'GET', `/comments?entityType=TASK&entityId=${task.id}`)).body.items; assert.ok(notes.some((x: any) => /Email sent/.test(x.body)));
});

test('v5: pending jobs export is a Word file, per person, and respects access', async () => {
  const { call, raw, A, person } = await world();
  const res = await raw('admin', 'GET', `/export-word/pending-jobs?companyId=${A.id}&personId=${person.id}&today=2026-02-01`);
  assert.equal(res.statusCode, 200); assert.match(String(res.headers['content-disposition']), /pending-jobs-Ravi/); assert.equal(res.rawPayload.subarray(0, 2).toString(), 'PK');
  assert.ok(res.rawPayload.length > 2000);
  assert.equal((await raw('outsider', 'GET', `/export-word/pending-jobs?companyId=${A.id}`)).statusCode, 404);
  void call;
});

test('v5: the briefing lists what is pending today (plain when AI is off) and never fails', async () => {
  const { call, task } = await world();
  await call('admin', 'POST', '/calls', { taskId: task.id, channel: 'CALL', contactName: 'CA', dueDate: '2026-02-01' });
  const r = (await call('admin', 'POST', '/ai/briefing', { today: '2026-02-01' })).body;
  assert.equal(r.aiUsed, false); assert.ok(r.counts.total >= 2); assert.ok(r.counts.overdue >= 1); assert.match(r.message, /pending/); assert.ok(r.items.some((i: any) => i.kind === 'call'));
});

test('v5: reminders — walk every 45 min from first open, water hourly, briefing every 3 hours, snooze respected', () => {
  const open = Date.parse('2026-10-17T09:00:00+05:30'); const m = (min: number) => open + min * 60_000;
  const base: ReminderState = { dayStart: open, lastWalk: 0, lastWater: 0, lastBriefing: -1 };
  const kinds = (now: number, st: ReminderState, snooze = 0) => dueReminders(now, st, { water: true, walk: true, briefing: true, snoozeUntil: snooze }).due;
  assert.deepEqual(kinds(m(1), base), ['briefing']);                       // first open of the day: the briefing, no health pop-ups yet
  assert.deepEqual(kinds(m(44), { ...base, lastBriefing: 0 }), []);
  assert.deepEqual(kinds(m(45), { ...base, lastBriefing: 0 }), ['walk']);
  assert.deepEqual(kinds(m(60), { ...base, lastBriefing: 0, lastWalk: 1 }), ['water']);
  assert.deepEqual(kinds(m(180), { ...base, lastBriefing: 0, lastWalk: 3, lastWater: 2 }).sort(), ['briefing', 'walk', 'water']);   // 180 = 4×45 = 3×60 = 3h
  assert.deepEqual(kinds(m(45), { ...base, lastBriefing: 0 }, m(60)), []);   // snoozed
  const after = dueReminders(m(45), { ...base, lastBriefing: 0 }, { water: true, walk: true, briefing: true, snoozeUntil: 0 }).state; assert.equal(after.lastWalk, 1);
  assert.deepEqual(dueReminders(m(46), after, { water: true, walk: true, briefing: true, snoozeUntil: 0 }).due, []);     // no repeat
  assert.deepEqual(dueReminders(m(45), { ...base, lastBriefing: 0 }, { water: false, walk: false, briefing: false, snoozeUntil: 0 }).due, []);
});
