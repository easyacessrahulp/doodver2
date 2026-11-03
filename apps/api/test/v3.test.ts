import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { buildApp, CSRF_HEADER } from '../src/app.ts';

const ymd = (o: number) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

test('communications: email/call/whatsapp; feedback is required to finish and is written into the task / subtask notes', async () => {
  const { app, call, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Get the quote' })).body;
  const s = (await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 'Vendor pricing' })).body;
  const mail = await call('USER', 'POST', '/calls', { taskId: t.id, subtaskId: s.id, channel: 'EMAIL', contactName: 'sales@vendor.example', email: 'sales@vendor.example', note: 'ask for revised quote', dueDate: ymd(1) });
  assert.equal(mail.status, 201); assert.equal(mail.body.channel, 'EMAIL');
  const noFeedback = await call('USER', 'PATCH', `/calls/${mail.body.id}`, { expectedUpdatedAt: mail.body.updatedAt, done: true });
  assert.equal(noFeedback.status, 400, 'cannot finish without writing feedback');
  const ok = await call('USER', 'PATCH', `/calls/${mail.body.id}`, { expectedUpdatedAt: mail.body.updatedAt, done: true, result: 'Replied: 11,500 incl. GST, valid 10 days' });
  assert.equal(ok.status, 200);
  const sub = (await call('USER', 'GET', `/comments?entityType=SUBTASK&entityId=${s.id}`)).body.items;
  assert.equal(sub.length, 1); assert.match(sub[0].body, /Email to sales@vendor\.example: Replied: 11,500/);
  const task = (await call('USER', 'GET', `/comments?entityType=TASK&entityId=${t.id}&includeSubtasks=true`)).body.items;
  assert.ok(task.some((c: any) => c.subtaskTitle === 'Vendor pricing'), 'task notes include subtask notes');
  const call1 = await call('USER', 'POST', '/calls', { taskId: t.id, contactName: 'Mr Nair', note: 'x' });   // default channel = CALL
  assert.equal(call1.body.channel, 'CALL');
  await call('USER', 'PATCH', `/calls/${call1.body.id}`, { expectedUpdatedAt: call1.body.updatedAt, done: true, result: 'No answer, try tomorrow' });
  assert.match((await call('USER', 'GET', `/comments?entityType=TASK&entityId=${t.id}`)).body.items.at(-1).body, /^📞 Call with Mr Nair: No answer/);
  assert.equal((await call('USER', 'GET', `/calls?channel=EMAIL&status=all`)).body.items.length, 1);
  assert.equal((await call('USER', 'POST', '/calls', { taskId: t.id, channel: 'FAX', contactName: 'x' })).status, 400);
  await app.close();
});

test('discussions & meetings: with a listed or outside person; finishing needs notes/decision and writes them to the notes; consolidated per person', async () => {
  const { app, call, A } = await setup();
  const person = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'CA Suresh' })).body;
  const t1 = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'GST reply' })).body;
  const t2 = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Audit queries' })).body;
  const s2 = (await call('USER', 'POST', `/tasks/${t2.id}/subtasks`, { title: 'Fixed assets' })).body;
  const d1 = (await call('USER', 'POST', '/discussions', { taskId: t1.id, personId: person.id, topic: 'Which ITC to claim?', agenda: 'bring the 2B', kind: 'MEETING', dueDate: ymd(2), meetingTime: '15:30' })).body;
  const d2 = (await call('USER', 'POST', '/discussions', { taskId: t2.id, subtaskId: s2.id, personId: person.id, topic: 'Depreciation method' })).body;
  await call('USER', 'POST', '/discussions', { taskId: t2.id, contactName: 'Outside Auditor', topic: 'Sign-off date' });
  assert.equal((await call('USER', 'POST', '/discussions', { taskId: t1.id, topic: 'nobody' })).status, 400, 'needs a person or a name');
  assert.equal((await call('VIEWER', 'POST', '/discussions', { taskId: t1.id, personId: person.id, topic: 'x' })).status, 403);
  assert.equal((await call('USER', 'PATCH', `/discussions/${d1.id}`, { expectedUpdatedAt: d1.updatedAt, done: true })).status, 400, 'cannot finish with no notes or decision');

  const groups = (await call('USER', 'GET', '/discussions/by-person')).body.items;
  const suresh = groups.find((g: any) => g.personId === person.id);
  assert.equal(suresh.discussions.length, 2, 'both pending items with CA Suresh are in one list');
  assert.deepEqual(suresh.discussions.map((x: any) => x.taskTitle).sort(), ['Audit queries', 'GST reply']);
  assert.ok(groups.some((g: any) => g.name === 'Outside Auditor' && g.discussions.length === 1), 'outside contacts are grouped too');

  // settle both in one sitting; one left blank stays pending
  const r = await call('USER', 'POST', '/discussions/batch-finish', { items: [{ id: d1.id, discussionNotes: 'Reviewed 2B vs books', decisions: 'Claim only matched ITC' }, { id: d2.id }] });
  assert.deepEqual([r.body.finished.length, r.body.skipped.length], [1, 1]);
  assert.match((await call('USER', 'GET', `/comments?entityType=TASK&entityId=${t1.id}`)).body.items.at(-1).body, /Meeting with CA Suresh — Which ITC to claim\?\nDiscussed: Reviewed 2B vs books\nDecision: Claim only matched ITC/);
  const done = await call('USER', 'PATCH', `/discussions/${d2.id}`, { expectedUpdatedAt: d2.updatedAt, done: true, decisions: 'Straight-line' });
  assert.equal(done.status, 200);
  assert.match((await call('USER', 'GET', `/comments?entityType=SUBTASK&entityId=${s2.id}`)).body.items[0].body, /Decision: Straight-line/);
  assert.equal((await call('USER', 'GET', '/discussions/by-person')).body.items.find((g: any) => g.personId === person.id), undefined, 'nothing left pending with that person');
  assert.equal((await call('outsider', 'GET', '/discussions')).body.items.length, 0);
  await app.close();
});

test('attachments on tasks and subtasks: upload, list, download, soft-remove; permissions enforced', async () => {
  const { app, call, raw, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'with files' })).body;
  const s = (await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 'sub with file' })).body;
  const up = await call('USER', 'POST', `/tasks/${t.id}/attachments`, { fileName: 'notice.pdf', mimeType: 'application/pdf', dataBase64: b64('%PDF-fake-content') });
  assert.equal(up.status, 201); assert.equal(up.body.sizeBytes, 17);
  const up2 = await call('USER', 'POST', `/tasks/${t.id}/attachments`, { fileName: '../../evil name?.txt', dataBase64: b64('hello'), subtaskId: s.id });
  assert.equal(up2.status, 201); assert.ok(!/[\\/]/.test(up2.body.fileName), 'file name is sanitised'); assert.equal(up2.body.subtaskTitle, 'sub with file');
  assert.equal((await call('VIEWER', 'POST', `/tasks/${t.id}/attachments`, { fileName: 'x', dataBase64: b64('x') })).status, 403);
  assert.equal((await call('outsider', 'GET', `/tasks/${t.id}/attachments`)).status, 404);
  assert.equal((await call('USER', 'GET', `/tasks/${t.id}/attachments`)).body.items.length, 2);
  const dl = await raw('VIEWER', 'GET', `/attachments/${up.body.id}/download`);
  assert.equal(dl.statusCode, 200); assert.equal(dl.body, '%PDF-fake-content'); assert.match(String(dl.headers['content-disposition']), /attachment/); assert.equal(dl.headers['x-content-type-options'], 'nosniff');
  assert.equal((await raw('outsider', 'GET', `/attachments/${up.body.id}/download`)).statusCode, 404);
  assert.equal((await call('USER', 'POST', `/attachments/${up.body.id}/archive`)).status, 200);
  assert.equal((await call('USER', 'GET', `/tasks/${t.id}/attachments`)).body.items.length, 1);
  assert.equal((await call('USER', 'POST', `/tasks/${t.id}/attachments`, { fileName: 'big', dataBase64: b64(Buffer.alloc(16 * 1024 * 1024, 1)) })).status, 400, 'over 15 MB rejected');
  await app.close();
});

test('subtasks can have their own due date and person, independent of the task — and count in that person’s performance', async () => {
  const { app, call, A } = await setup();
  const anil = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Anil' })).body;
  const biju = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Biju' })).body;
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Year-end', delegatedToId: anil.id, status: 'DELEGATED', dueDate: ymd(10) })).body;
  const s1 = (await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 'Stock count', assigneeId: biju.id, dueDate: ymd(-3) })).body;
  const s2 = (await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 'Bank recon', assigneeId: biju.id, dueDate: ymd(-10) })).body;
  assert.equal(s1.assigneeId, biju.id); assert.equal(s1.dueDate, ymd(-3));
  await call('USER', 'PATCH', `/subtasks/${s2.id}`, { expectedUpdatedAt: s2.updatedAt, status: 'DONE' });
  const perf = (await call('USER', 'GET', `/people/performance?companyId=${A.id}&today=${ymd(0)}`)).body.items;
  const b = perf.find((p: any) => p.personId === biju.id); const a = perf.find((p: any) => p.personId === anil.id);
  assert.ok(b, 'Biju appears although no task is delegated to him');
  assert.deepEqual([b.subAssigned, b.subDone, b.subLate, b.subOverdueNow, b.assigned], [2, 1, 1, 1, 0]);
  assert.equal(a.assigned, 1); assert.equal(a.subAssigned, 0);
  const w = (await call('USER', 'GET', `/people/${biju.id}/workload`)).body; assert.equal(w.subtasks.length, 1); assert.equal(w.subtasks[0].title, 'Stock count');
  assert.equal((await call('USER', 'GET', `/tasks?companyId=${A.id}&involvedId=${biju.id}`)).body.items.length, 1, 'task shows up for the person doing a subtask');
  assert.equal((await call('USER', 'GET', `/tasks?companyId=${A.id}&personId=${biju.id}`)).body.items.length, 0);
  await app.close();
});

test('follow-up log: records what happened, sets the next follow-up date, writes a note', async () => {
  const { app, call, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Chase approval' })).body;
  assert.equal((await call('USER', 'POST', `/tasks/${t.id}/followups`, { type: 'PHONE', notes: '' })).status, 400);
  const f = await call('USER', 'POST', `/tasks/${t.id}/followups`, { type: 'PHONE', contactName: 'Branch manager', notes: 'Says file is with the regional office', nextDate: ymd(2), nextAction: 'Call regional office' });
  assert.equal(f.status, 201);
  const after = (await call('USER', 'GET', `/tasks/${t.id}`)).body; assert.equal(after.nextFollowupDate, ymd(2)); assert.equal(after.nextAction, 'Call regional office');
  const fl = (await call('USER', 'GET', `/tasks/${t.id}/followups`)).body.items; assert.equal(fl.length, 2, 'the logged one plus the planned next one'); assert.equal(fl.filter((x: any) => !x.doneAt).length, 1);
  assert.match((await call('USER', 'GET', `/comments?entityType=TASK&entityId=${t.id}`)).body.items[0].body, /Follow-up \(Phone · Branch manager\): Says file/);
  const dash = (await call('USER', 'GET', `/dashboard?today=${ymd(2)}`)).body; assert.ok(dash.followUpNow.some((x: any) => x.id === t.id), 'appears in Follow Up Now on the day');
  await app.close();
});

test('recurring tasks: completing creates the next occurrence once (subtasks copied and reset, dates shifted, month ends clamped)', async () => {
  const { app, call, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Monthly GST', dueDate: '2030-01-31', repeat: 'MONTHLY' })).body;
  assert.equal(t.repeat, 'MONTHLY');
  await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 'Collect data', dueDate: '2030-01-25' });
  const done = await call('USER', 'POST', `/tasks/${t.id}/complete`, { today: '2030-01-30' });
  assert.equal(done.status, 200);
  const all = (await call('USER', 'GET', `/tasks?companyId=${A.id}&completed=all&limit=50`)).body.items.filter((x: any) => x.title === 'Monthly GST');
  assert.equal(all.length, 2); const next = all.find((x: any) => x.status !== 'DONE');
  assert.equal(next.dueDate, '2030-02-28', '31 Jan + 1 month clamps to 28 Feb'); assert.equal(next.repeat, 'MONTHLY');
  const subs = (await call('USER', 'GET', `/tasks/${next.id}/subtasks`)).body.items; assert.equal(subs.length, 1); assert.equal(subs[0].status, 'TODO'); assert.equal(subs[0].dueDate, '2030-02-22', 'shifted by the same 28 days');
  await call('USER', 'POST', `/tasks/${t.id}/reopen`); await call('USER', 'POST', `/tasks/${t.id}/complete`, { today: '2030-01-30' });
  assert.equal((await call('USER', 'GET', `/tasks?companyId=${A.id}&completed=all&limit=50`)).body.items.filter((x: any) => x.title === 'Monthly GST').length, 2, 'no second spawn');
  // stop repeating
  const n = (await call('USER', 'PATCH', `/tasks/${next.id}`, { expectedUpdatedAt: next.updatedAt, repeat: 'NONE' })).body; assert.equal(n.repeat, null);
  await call('USER', 'POST', `/tasks/${next.id}/complete`, { today: '2030-02-28' });
  assert.equal((await call('USER', 'GET', `/tasks?companyId=${A.id}&completed=all&limit=50`)).body.items.filter((x: any) => x.title === 'Monthly GST').length, 2);
  const d = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Daily', dueDate: ymd(-3), repeat: 'DAILY' })).body;
  await call('USER', 'POST', `/tasks/${d.id}/complete`, { today: ymd(0) });
  assert.ok((await call('USER', 'GET', `/tasks?companyId=${A.id}&q=Daily`)).body.items.some((x: any) => x.dueDate === ymd(1)), 'next daily is after today, not in the past');
  await app.close();
});

test('My Attention: faithful scoring from the prototype, max 5, every item explains why', async () => {
  const { app, call, A } = await setup();
  const db = (app as any).db; const today = ymd(0);
  const person = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Dee' })).body;
  const crit = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'critical overdue', priority: 1, dueDate: ymd(-2) })).body;
  // 56 (50 + 2*3) + 25 critical = 81
  let att = (await call('USER', 'GET', `/attention?today=${today}`)).body.items; assert.equal(att[0].id, crit.id); assert.equal(att[0].score, 81);
  assert.deepEqual(att[0].reasons.map((r: any) => r.text), ['2 days overdue', 'Critical priority']);
  const del = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'delegated, stale, postponed', priority: 2, dueDate: today, delegatedToId: person.id, status: 'DELEGATED' })).body;
  await db.run('UPDATE tasks SET postpone_count = 1, last_activity_at = ? WHERE id = ?', [new Date(Date.now() - 4 * 864e5).toISOString(), del.id]);
  // 30 due today + 15 high + 12 delegated-no-update(4d) + 4 postponed = 61
  att = (await call('USER', 'GET', `/attention?today=${today}`)).body.items; const d = att.find((x: any) => x.id === del.id);
  assert.equal(d.score, 61); assert.equal(d.tone, 'a'); assert.ok(d.reasons.some((r: any) => /Delegated to Dee, no update for 4 days/.test(r.text)));
  const a = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'blocker', dueDate: ymd(30) })).body;
  const b = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'blocked', dueDate: ymd(30), dependsOnId: a.id })).body;
  const all = (await call('USER', 'GET', `/dashboard?today=${today}`)).body;
  const ra = all.atRisk.find((x: any) => x.id === b.id); assert.ok(ra && ra.reasons.some((r: any) => /Blocked by: blocker/.test(r.text)), 'unresolved dependency = at risk');
  for (let i = 0; i < 8; i++) await call('USER', 'POST', '/tasks', { companyId: A.id, title: `t${i}`, dueDate: ymd(-i - 1) });
  att = (await call('USER', 'GET', `/attention?today=${today}`)).body.items; assert.equal(att.length, 5);
  assert.ok(att.every((x: any) => x.reasons.length > 0));
  assert.deepEqual(att.map((x: any) => x.score), [...att.map((x: any) => x.score)].sort((p, q) => q - p));
  // thresholds are per-user settings
  const s = (await call('USER', 'PATCH', '/settings', { staleDays: 10 })).body; assert.equal(s.staleDays, 10);
  assert.equal((await call('USER', 'GET', `/attention?today=${today}`)).body.items.find((x: any) => x.id === del.id)?.reasons.some((r: any) => /no update/.test(r.text)) ?? false, false);
  assert.equal((await call('USER', 'PATCH', '/settings', { staleDays: 0 })).status, 400);
  await app.close();
});

test('Command Centre dashboard: counters and every section', async () => {
  const { app, call, A } = await setup();
  const today = ymd(0); const person = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Dee' })).body;
  const proj = (await call('MANAGER', 'POST', '/projects', { companyId: A.id, name: 'Banking' })).body;
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'od', dueDate: ymd(-1), projectId: proj.id });
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'today', dueDate: today, projectId: proj.id });
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'soon', dueDate: ymd(3) });
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'waiting', status: 'WAITING', waitingFor: 'Bank', waitingExpectedDate: ymd(-2) });
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'deleg', status: 'DELEGATED', delegatedToId: person.id, dueDate: ymd(-1) });
  const fin = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'finished' })).body; await call('USER', 'POST', `/tasks/${fin.id}/complete`, {});
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'with comms' })).body;
  await call('USER', 'POST', '/calls', { taskId: t.id, contactName: 'X' }); await call('USER', 'POST', '/discussions', { taskId: t.id, contactName: 'Y', topic: 'z' });
  const d = (await call('USER', 'GET', `/dashboard?today=${today}&dayStart=${new Date(Date.now() - 3600e3).toISOString()}`)).body;
  assert.equal(d.counters.overdue, 2); assert.equal(d.counters.dueToday, 1); assert.equal(d.counters.delegated, 1); assert.equal(d.counters.waiting, 1);
  assert.equal(d.counters.pendingCommunications, 1); assert.equal(d.counters.pendingDiscussions, 1);
  assert.ok(d.doNow.some((x: any) => x.title === 'od') && !d.doNow.some((x: any) => x.title === 'deleg' || x.title === 'waiting'), 'delegated/waiting are not "my action"');
  assert.equal(d.doNow[0].title, 'od', 'overdue before due-today'); assert.equal(d.waitingFor[0].expectedPassed, true);
  assert.deepEqual(d.dueSoon.groups.today.map((x: any) => x.title), ['today']); assert.deepEqual(d.dueSoon.groups.next3.map((x: any) => x.title), ['soon']);
  assert.ok(d.delegated.some((x: any) => x.title === 'deleg')); assert.deepEqual(d.completedToday.map((x: any) => x.title), ['finished']);
  const ph = d.projectHealth.find((p: any) => p.project === 'Banking'); assert.deepEqual([ph.open, ph.overdue], [2, 1]);
  assert.ok(d.briefing.recommended && d.focusSuggestion);
  assert.equal((await call('USER', 'GET', `/dashboard?today=${today}&dueDays=5`)).status, 400);
  assert.equal((await call('USER', 'GET', `/dashboard?today=${today}&companyId=nope`)).status, 404);
  await app.close();
});

test('global search finds tasks, notes, calls, discussions, people and files — only within your companies', async () => {
  const { app, call, A, B } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Zebra licence renewal' })).body;
  await call('USER', 'POST', '/comments', { entityType: 'TASK', entityId: t.id, body: 'spoke about the zebra fees' });
  await call('USER', 'POST', '/calls', { taskId: t.id, contactName: 'Zebra Office', phone: '999' });
  await call('USER', 'POST', '/discussions', { taskId: t.id, contactName: 'Mr Z', topic: 'Zebra penalty' });
  await call('USER', 'POST', `/tasks/${t.id}/attachments`, { fileName: 'zebra-notice.pdf', dataBase64: b64('x') });
  await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Zebra Agent' });
  const secret = (await call('admin', 'POST', '/tasks', { companyId: B.id, title: 'Zebra in the other company' })).body;
  const r = (await call('USER', 'GET', '/search?q=zebra')).body;
  for (const k of ['task', 'note', 'communication', 'discussion', 'file', 'person']) assert.ok(r.counts[k] >= 1, `finds ${k}`);
  assert.ok(!r.results.some((x: any) => x.taskId === secret.id), 'other company is invisible');
  assert.ok((await call('admin', 'GET', '/search?q=zebra')).body.results.some((x: any) => x.taskId === secret.id));
  assert.equal((await call('USER', 'GET', '/search?q=z')).status, 400);
  assert.equal((await call('USER', 'GET', '/search?q=100%25')).body.results.length, 0, 'wildcards are escaped');
  await app.close();
});

test('daily, weekly and management reviews', async () => {
  const { app, call, A } = await setup();
  const today = ymd(0); const ds = new Date(Date.now() - 3600e3).toISOString();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'done today' })).body; await call('USER', 'POST', `/tasks/${t.id}/complete`, { note: 'ok' });
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'overdue', dueDate: ymd(-2) }); await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'tomorrow', dueDate: ymd(1) });
  const d = (await call('USER', 'GET', `/reviews/daily?today=${today}&dayStart=${encodeURIComponent(ds)}`)).body;
  assert.deepEqual(d.completed.map((x: any) => x.title), ['done today']); assert.equal(d.overdue.length, 1); assert.equal(d.tomorrow.length, 1); assert.ok(d.suggestedFirstFocus);
  const w = (await call('USER', 'GET', `/reviews/weekly?today=${today}`)).body; assert.equal(w.completedCount, 1); assert.ok(w.created >= 3); assert.equal(w.overdueNow.length, 1);
  const m = (await call('USER', 'GET', `/reviews/management?today=${today}&companyId=${A.id}`)).body; assert.equal(m.totals.tasks, 2); assert.equal(m.totals.overdue, 1); assert.ok(m.rows[0].company);
  assert.equal((await call('outsider', 'GET', `/reviews/management?companyId=${A.id}`)).status, 404);
  await app.close();
});

test('exports: CSV, Excel and PDF for every dataset, scoped to what you may see', async () => {
  const { app, call, raw, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Export me, "quoted"', dueDate: ymd(-1) })).body;
  await call('USER', 'POST', '/calls', { taskId: t.id, contactName: 'X' }); await call('USER', 'POST', '/discussions', { taskId: t.id, contactName: 'Y', topic: 'T' });
  const csv = await raw('USER', 'GET', `/export/csv?dataset=tasks&scope=overdue&today=${ymd(0)}`);
  assert.equal(csv.statusCode, 200); assert.match(String(csv.headers['content-type']), /text\/csv/); assert.match(csv.body, /Company,Project,Task/); assert.match(csv.body, /"Export me, ""quoted"""/);
  assert.ok(!(await raw('USER', 'GET', '/export/csv?dataset=tasks&scope=completed')).body.includes('Export me'));
  const x = await raw('USER', 'GET', '/export/xlsx?dataset=tasks'); assert.equal(x.rawPayload.subarray(0, 2).toString(), 'PK');
  const p = await raw('USER', 'GET', '/export/pdf?dataset=tasks'); assert.equal(p.rawPayload.subarray(0, 4).toString(), '%PDF');
  for (const ds of ['subtasks', 'focus', 'communications', 'discussions', 'people']) assert.equal((await raw('USER', 'GET', `/export/csv?dataset=${ds}`)).statusCode, 200, ds);
  assert.equal((await raw('outsider', 'GET', '/export/csv?dataset=tasks')).body.split('\r\n').filter(Boolean).length, 1, 'outsider gets only a header');
  assert.equal((await raw('USER', 'GET', '/export/doc')).statusCode, 400);
  await app.close();
});

test('backup → restore: a full round trip keeps everything (incl. files, sign-ins); validation blocks bad files; merge never overwrites', async () => {
  const src = await setup(); const { call: sc, raw: sr, A } = src;
  await sc('admin', 'POST', '/admin/demo-data/load');
  const t = (await sc('USER', 'POST', '/tasks', { companyId: A.id, title: 'Has file, call & discussion', dueDate: '2031-05-05' })).body;
  const s = (await sc('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 'sub', dueDate: '2031-05-01' })).body;
  await sc('USER', 'POST', `/tasks/${t.id}/attachments`, { fileName: 'proof.txt', dataBase64: b64('important proof'), subtaskId: s.id });
  await sc('USER', 'POST', '/calls', { taskId: t.id, contactName: 'Z', channel: 'EMAIL' }); await sc('USER', 'POST', '/discussions', { taskId: t.id, contactName: 'Q', topic: 'topic' });
  const counts = async (app: any) => { const o: any = {}; for (const tb of ['users', 'companies', 'projects', 'people', 'tasks', 'subtasks', 'comments', 'calls', 'discussions', 'attachments', 'activity_log', 'user_settings']) o[tb] = (await app.db.get(`SELECT COUNT(*) n FROM ${tb}`)).n; return o; };
  const before = await counts(src.app);
  assert.equal((await sr('USER', 'GET', '/backup')).statusCode, 403, 'admin only');
  const zip = (await sr('admin', 'GET', '/backup')).rawPayload; assert.equal(zip.subarray(0, 2).toString(), 'PK');

  // restore into a brand-new installation with a different admin
  const dst = await buildApp({ dbPath: ':memory:' }); const H = { 'x-requested-with': CSRF_HEADER };
  const reg = await dst.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'New', email: 'new@x.test', password: 'long-enough-pw' } });
  const ck = String(reg.headers['set-cookie']).split(';')[0]; const dcall = (m: string, u: string, b?: any) => dst.inject({ method: m as any, url: '/api/v1' + u, headers: { ...H, cookie: ck }, payload: b });
  const v = (await dcall('POST', '/restore/validate', { dataBase64: zip.toString('base64') })).json();
  assert.equal(v.ok, true); assert.ok(v.token); assert.equal(v.replaceErrors.length, 0); assert.ok(v.mergeNew.tasks > 0); assert.equal(v.files, 1);
  assert.equal((await dcall('POST', '/restore/apply', { token: v.token, mode: 'REPLACE' })).statusCode, 400, 'needs the typed confirmation');
  const ap = await dcall('POST', '/restore/apply', { token: v.token, mode: 'REPLACE', confirm: 'RESTORE' }); assert.equal(ap.statusCode, 200); assert.equal(ap.json().signedOut, true);
  const after = await counts(dst); assert.equal(after.activity_log, before.activity_log + 1, 'restore logs itself in the audit trail');
  assert.deepEqual({ ...after, activity_log: 0 }, { ...before, activity_log: 0 }, 'every other table has exactly the same number of rows');
  assert.equal((await dcall('GET', '/auth/me')).statusCode, 401, 'old sessions are gone');
  const login = await dst.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'admin@x.test', password: src.PW } }); assert.equal(login.statusCode, 200, 'original admin can sign in with the original password');
  const ck2 = String(login.headers['set-cookie']).split(';')[0];
  const atts = (await dst.inject({ method: 'GET', url: `/api/v1/tasks/${t.id}/attachments`, headers: { ...H, cookie: ck2 } })).json().items;
  const file = await dst.inject({ method: 'GET', url: `/api/v1/attachments/${atts[0].id}/download`, headers: { ...H, cookie: ck2 } }); assert.equal(file.body, 'important proof', 'attachment bytes restored');
  const tt = (await dst.inject({ method: 'GET', url: `/api/v1/tasks/${t.id}`, headers: { ...H, cookie: ck2 } })).json(); assert.equal(tt.dueDate, '2031-05-05'); assert.equal(tt.title, 'Has file, call & discussion');

  // validation
  const bad = (await dst.inject({ method: 'POST', url: '/api/v1/restore/validate', headers: { ...H, cookie: ck2 }, payload: { dataBase64: Buffer.from('not a zip at all').toString('base64') } })).json(); assert.equal(bad.ok, false);
  const JSZip = (await import('jszip')).default; const z = await JSZip.loadAsync(zip); const tasks = await z.file('data/tasks.csv')!.async('string');
  z.file('data/tasks.csv', tasks.replace(t.id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'));   // subtasks/calls/files still point at the old id
  const broken = await z.generateAsync({ type: 'nodebuffer' });
  const bv = (await dst.inject({ method: 'POST', url: '/api/v1/restore/validate', headers: { ...H, cookie: ck2 }, payload: { dataBase64: broken.toString('base64') } })).json();
  assert.ok(bv.ok === false || bv.replaceErrors.length > 0, 'tampered ids are caught');
  if (bv.token) assert.equal((await dst.inject({ method: 'POST', url: '/api/v1/restore/apply', headers: { ...H, cookie: ck2 }, payload: { token: bv.token, mode: 'REPLACE', confirm: 'RESTORE' } })).statusCode, 409, 'blocked, nothing changed');
  assert.deepEqual(await counts(dst), after, 'a blocked restore changes nothing');

  // merge into the source itself: everything already exists → nothing inserted, nothing overwritten
  await sc('USER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: t.updatedAt, title: 'edited after backup' });
  const mv = (await sc('admin', 'POST', '/restore/validate', { dataBase64: zip.toString('base64') })).body; assert.equal(mv.mergeErrors.length, 0);
  const mr = (await sc('admin', 'POST', '/restore/apply', { token: mv.token, mode: 'MERGE', confirm: 'RESTORE' })).body;
  assert.equal(Object.values(mr.result as Record<string, any>).reduce((a: number, r: any) => a + r.inserted, 0), 0);
  assert.equal((await sc('admin', 'GET', `/tasks/${t.id}`)).body.title, 'edited after backup', 'merge does not overwrite newer data');
  await dst.close(); await src.app.close();
});

test('restore (replace) makes a safety copy of the current database first', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cc-rest-')); const app = await buildApp({ dbPath: join(dir, 'a.db') }); const H = { 'x-requested-with': CSRF_HEADER };
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', email: 'a@x.test', password: 'long-enough-pw' } }); const ck = String(reg.headers['set-cookie']).split(';')[0];
  const zip = (await app.inject({ method: 'GET', url: '/api/v1/backup', headers: { ...H, cookie: ck } })).rawPayload;
  const v = (await app.inject({ method: 'POST', url: '/api/v1/restore/validate', headers: { ...H, cookie: ck }, payload: { dataBase64: zip.toString('base64') } })).json();
  const r = (await app.inject({ method: 'POST', url: '/api/v1/restore/apply', headers: { ...H, cookie: ck }, payload: { token: v.token, mode: 'REPLACE', confirm: 'RESTORE' } })).json();
  assert.ok(r.safetyCopy && /before-restore/.test(r.safetyCopy)); assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('before-restore')));
  await app.close();
});

test('prototype importer: companies, projects, people, tasks, subtasks, notes, dependencies, files, sessions; safe to re-run', async () => {
  const { app, call } = await setup();
  const proto = {
    cos: ['SMS Biosystems Pvt Ltd', 'GRMS'], prs: ['GST Compliance', 'Unused project'], people: ['Biju', 'Anil'], pinfo: { Biju: { phone: '98950 11111', desig: 'Developer' } }, arch: [],
    tasks: [
      { id: 'a1', title: 'Submit GST reply', co: 'SMS Biosystems Pvt Ltd', proj: 'GST Compliance', due: '2030-03-01', pri: 1, who: 'Rahul', dl: 0, wait: 'CA confirmation', fu: '2030-02-20', upd: '2030-02-10', pp: 1, done: 0,
        notes: [['2030-02-10 10:00', 'CA will confirm']], focus: 50, log: [['2030-02-01 09:00', 'Created']], subs: [{ n: 'Gather data', d: 1 }, { n: 'Draft', d: 0 }], rec: 'monthly',
        att: [{ n: 'reply.txt', d: 'data:text/plain;base64,' + b64('draft reply') }] },
      { id: 'a2', title: 'Test software', co: 'GRMS', proj: 'Company Formation', due: '', pri: 2, who: 'Biju', dl: 1, wait: '', fu: '', upd: '2030-02-09', pp: 0, done: 1, doneAt: '2030-02-11 12:00', note: 'passed', dep: 'a1', stg: 'done' },
    ],
    sess: [{ id: 's1', task: 'a1', start: '2030-02-09T10:00:00.000Z', end: '2030-02-09T10:25:00.000Z', planned: 25, min: 25, ok: true, note: 'worked' }, { id: 's2', task: 'missing', start: 'x', min: 5 }],
    set: { f: 30, s: 5, l: 20, n: 4, stale: 5, soon: 4, esc: 6, nt: 'daily' },
  };
  assert.equal((await call('USER', 'POST', '/import/prototype', { data: proto })).status, 403);
  assert.equal((await call('admin', 'POST', '/import/prototype', { data: { nope: 1 } })).status, 400);
  const r = (await call('admin', 'POST', '/import/prototype', { data: proto })).body;
  assert.deepEqual(r.created, { companies: 2, projects: 2, people: 2, tasks: 2, subtasks: 2, notes: 1, focusSessions: 1, attachments: 1 });
  assert.equal(r.warnings.length, 1, 'orphan session reported');
  const tasks = (await call('admin', 'GET', '/tasks?completed=all&limit=20')).body.items; const a = tasks.find((t: any) => t.title === 'Submit GST reply'); const b = tasks.find((t: any) => t.title === 'Test software');
  assert.equal(a.status, 'WAITING'); assert.equal(a.waitingFor, 'CA confirmation'); assert.equal(a.priority, 1); assert.equal(a.postponeCount, 1); assert.equal(a.focusMinutes, 50); assert.equal(a.repeat, 'MONTHLY'); assert.equal(a.subtaskCount, 2);
  assert.equal(b.status, 'DONE'); assert.equal(b.delegatedToName, 'Biju'); assert.equal(b.dependsOnId, a.id); assert.equal(b.completionNote, 'passed');
  assert.equal((await call('admin', 'GET', `/tasks/${a.id}/attachments`)).body.items[0].fileName, 'reply.txt');
  assert.equal((await call('admin', 'GET', '/settings')).body.focusMinutes, 30);
  const again = (await call('admin', 'POST', '/import/prototype', { data: proto })).body; assert.equal(again.skippedTasks, 2); assert.equal(again.created.tasks, 0); assert.equal(again.created.companies, 0);
  await app.close();
});

test('DOOD: planned follow-ups are items (several per task), finishing needs feedback, next date chains, cache feeds Follow Up Now', async () => {
  const { app, call, A } = await setup(); const today = ymd(0);
  const person = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Officer' })).body;
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'Licence renewal' })).body;
  assert.equal((await call('VIEWER', 'POST', '/followups', { taskId: t.id, dueDate: today })).status, 403);
  const f1 = (await call('USER', 'POST', '/followups', { taskId: t.id, type: 'PHONE', personId: person.id, dueDate: ymd(-1), note: 'ask about file status' })).body;
  const f2 = (await call('USER', 'POST', '/followups', { taskId: t.id, type: 'EMAIL', contactName: 'Registrar', dueDate: ymd(3) })).body;
  assert.equal((await call('USER', 'GET', `/tasks/${t.id}`)).body.nextFollowupDate, ymd(-1), 'task mirrors the earliest pending follow-up');
  const lists = async (b: string) => (await call('USER', 'GET', `/followups?bucket=${b}&today=${today}`)).body.items.map((x: any) => x.id);
  assert.deepEqual(await lists('overdue'), [f1.id]); assert.deepEqual(await lists('upcoming'), [f2.id]); assert.deepEqual(await lists('today'), []);
  assert.equal((await call('USER', 'PATCH', `/followups/${f1.id}`, { expectedUpdatedAt: f1.updatedAt, done: true })).status, 400, 'feedback required');
  const done = await call('USER', 'PATCH', `/followups/${f1.id}`, { expectedUpdatedAt: f1.updatedAt, done: true, result: 'File is with the director', nextDate: ymd(2) });
  assert.equal(done.status, 200); assert.ok(done.body.doneAt);
  assert.deepEqual((await call('USER', 'GET', `/followups?status=pending&today=${today}`)).body.items.map((x: any) => x.dueDate), [ymd(2), ymd(3)], 'finished one leaves the list; next one chained');
  assert.equal((await call('USER', 'GET', `/followups?status=done`)).body.items.length, 1);
  assert.equal((await call('USER', 'GET', `/tasks/${t.id}`)).body.nextFollowupDate, ymd(2));
  assert.match((await call('USER', 'GET', `/comments?entityType=TASK&entityId=${t.id}`)).body.items.at(-1).body, /Follow-up \(Phone · Officer\): File is with the director/);
  // changing the date on the task keeps the items in step (old data / task form / snooze)
  const cur = (await call('USER', 'GET', `/tasks/${t.id}`)).body; await call('USER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: cur.updatedAt, nextFollowupDate: ymd(9) });
  assert.deepEqual((await call('USER', 'GET', `/followups?status=pending`)).body.items.map((x: any) => x.dueDate).sort(), [ymd(3), ymd(9)]);
  const t2 = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'with date from form', nextFollowupDate: ymd(1) })).body;
  assert.equal((await call('USER', 'GET', `/followups?taskId=${t2.id}`)).body.items.length, 1);
  await call('USER', 'POST', `/followups/${f2.id}/archive`);
  assert.equal((await call('outsider', 'GET', '/followups')).body.items.length, 0);
  await app.close();
});

test('DOOD: Backlog status, bulk subtasks (atomic, ordered), card counts and the new task filters', async () => {
  const { app, call, A } = await setup();
  const b = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'later', status: 'BACKLOG' })).body; assert.equal(b.status, 'BACKLOG');
  assert.ok((await call('USER', 'GET', `/tasks?companyId=${A.id}`)).body.items.some((x: any) => x.id === b.id), 'backlog is active work');
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'big task', priority: 2, dueDate: ymd(0) })).body;
  const r = await call('USER', 'POST', `/tasks/${t.id}/subtasks/bulk`, { items: ['Call HDFC Bank', '1. Send KSIDC confirmation', 'Check bank statement'].map((title) => ({ title })) });
  assert.equal(r.status, 201); assert.equal(r.body.created, 3);
  const subs = (await call('USER', 'GET', `/tasks/${t.id}/subtasks`)).body.items; assert.deepEqual(subs.map((s: any) => s.title), ['Call HDFC Bank', '1. Send KSIDC confirmation', 'Check bank statement']);
  assert.equal((await call('USER', 'POST', `/tasks/${t.id}/subtasks/bulk`, { items: [{ title: 'ok' }, { title: '' }] })).status, 400);
  assert.equal((await call('USER', 'GET', `/tasks/${t.id}/subtasks`)).body.items.length, 3, 'a bad item rejects the whole batch');
  assert.equal((await call('VIEWER', 'POST', `/tasks/${t.id}/subtasks/bulk`, { items: [{ title: 'x' }] })).status, 403);
  await call('USER', 'POST', '/calls', { taskId: t.id, contactName: 'X' }); await call('USER', 'POST', '/discussions', { taskId: t.id, contactName: 'Y', topic: 'z' }); await call('USER', 'POST', '/followups', { taskId: t.id, dueDate: ymd(1) });
  await call('USER', 'PATCH', `/subtasks/${subs[0].id}`, { expectedUpdatedAt: subs[0].updatedAt, status: 'DONE' });
  const card = (await call('USER', 'GET', `/tasks/${t.id}`)).body; assert.deepEqual([card.subtaskCount, card.subtaskDoneCount, card.pendingCalls, card.pendingFollowups, card.pendingDiscussions], [3, 1, 1, 1, 1]);
  assert.deepEqual((await call('USER', 'GET', `/tasks?companyId=${A.id}&maxPriority=2&dueOn=${ymd(0)}`)).body.items.map((x: any) => x.id), [t.id]);
  const done = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'recent done' })).body; await call('USER', 'POST', `/tasks/${done.id}/complete`, {});
  assert.equal((await call('USER', 'GET', `/tasks?companyId=${A.id}&completed=true&doneSince=${ymd(-1)}`)).body.items.length, 1);
  assert.equal((await call('USER', 'GET', `/tasks?companyId=${A.id}&completed=true&doneSince=${ymd(1)}`)).body.items.length, 0);
  await app.close();
});

test('DOOD: Home action block (calls / follow-ups / discussions / tasks) and My Attention pool with filters', async () => {
  const { app, call, A } = await setup(); const today = ymd(0);
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'T', priority: 1, dueDate: ymd(-2) })).body;
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'High today', priority: 2, dueDate: today }); await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'plain', priority: 4 });
  for (const [d, n] of [[-1, 'overdue call'], [0, 'today call'], [4, 'later call']] as const) await call('USER', 'POST', '/calls', { taskId: t.id, contactName: n, dueDate: ymd(d) });
  await call('USER', 'POST', '/calls', { taskId: t.id, contactName: 'undated' });
  await call('USER', 'POST', '/followups', { taskId: t.id, dueDate: ymd(-3) }); await call('USER', 'POST', '/followups', { taskId: t.id, dueDate: today }); await call('USER', 'POST', '/followups', { taskId: t.id, dueDate: ymd(5) });
  await call('USER', 'POST', '/discussions', { taskId: t.id, contactName: 'A', topic: 'one', dueDate: today }); await call('USER', 'POST', '/discussions', { taskId: t.id, contactName: 'B', topic: 'two' });
  const d = (await call('USER', 'GET', `/dashboard?today=${today}`)).body;
  assert.deepEqual([d.action.calls.overdue, d.action.calls.today, d.action.calls.upcoming, d.action.calls.undated], [1, 1, 1, 1]);
  assert.deepEqual([d.action.followups.overdue, d.action.followups.today, d.action.followups.upcoming], [1, 1, 1]);
  assert.deepEqual([d.action.discussions.pending, d.action.discussions.today], [2, 1]);
  assert.deepEqual([d.action.tasks.overdue, d.action.tasks.dueToday, d.action.tasks.highPriority, d.action.tasks.critical], [1, 1, 2, 1]);
  assert.equal(d.action.calls.items[0].who, 'overdue call', 'overdue first'); assert.equal(d.action.calls.items.at(-1).who, 'undated', 'undated last');
  assert.ok(d.attentionPool.length <= 40 && d.attentionPool.every((x: any) => x.flags && x.reasons.length >= 0));
  assert.equal(d.attentionCounts.critical, 1); assert.equal(d.attentionCounts.overdue, 1); assert.equal(d.attentionCounts.dueToday, 1);
  const a = (await call('USER', 'GET', `/attention?today=${today}&limit=50`)).body; assert.equal(a.items.length, 3); assert.equal(a.counts.high, 1);
  assert.equal((await call('USER', 'GET', `/attention?limit=500`)).status, 400);
  await app.close();
});

test('DOOD: focus history — totals, per day, most-focused tasks', async () => {
  const { app, call, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'deep work' })).body; const db = (app as any).db;
  for (const m of [25, 50]) { const s = (await call('USER', 'POST', '/focus/sessions', { taskId: t.id, plannedMinutes: m })).body;
    await db.run('UPDATE focus_sessions SET started_at = ? WHERE id = ?', [new Date(Date.now() - 3 * 3600e3).toISOString(), s.id]); await call('USER', 'POST', `/focus/sessions/${s.id}/finish`, { actualMinutes: m, completed: true }); }
  const h = (await call('USER', 'GET', '/focus/history?days=7')).body;
  assert.equal(h.sessions, 2); assert.ok(h.minutes >= 75 - 2); assert.equal(h.topTasks[0].title, 'deep work'); assert.equal(h.recent.length, 2); assert.equal(h.completedPomodoros, 2);
  await app.close();
});
