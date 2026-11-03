import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

const ymd = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

test('a person from another company can be assigned (no shared person needed) — only if you can access that company', async () => {
  const { app, call, A, B, users } = await setup();
  const bPerson = (await call('admin', 'POST', '/people', { companyId: B.id, name: 'Beta Staff' })).body;
  // admin can assign Beta's person to an Alpha task
  const t = await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'cross', delegatedToId: bPerson.id, status: 'DELEGATED' });
  assert.equal(t.status, 201); assert.equal(t.body.delegatedToName, 'Beta Staff');
  // USER only belongs to Alpha → cannot use a Beta person
  const denied = await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'x', delegatedToId: bPerson.id });
  assert.equal(denied.status, 400);
  // …but once they are also a member of Beta, it works
  await call('admin', 'PUT', `/users/${users.USER}/memberships/${B.id}`, { role: 'USER' });
  assert.equal((await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'x', delegatedToId: bPerson.id })).status, 201);
  // the people picker can list everyone the user can access
  const all = (await call('USER', 'GET', `/people?all=true&limit=200`)).body.items.map((p: any) => p.id);
  assert.ok(all.includes(bPerson.id));
  await app.close();
});

test('tasks can be sorted person-wise', async () => {
  const { app, call, A } = await setup();
  const zed = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Zed' })).body;
  const amy = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Amy' })).body;
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'for zed', delegatedToId: zed.id });
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'mine' });
  await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'for amy', delegatedToId: amy.id });
  const names = (await call('USER', 'GET', `/tasks?companyId=${A.id}&sort=person`)).body.items.map((t: any) => t.delegatedToName);
  assert.deepEqual(names, ['Amy', 'Zed', null], 'alphabetical by person, unassigned last');
  const byDue = await call('USER', 'GET', `/tasks?companyId=${A.id}&sort=due&limit=2`);
  assert.equal(byDue.body.items.length, 2); assert.ok(byDue.body.nextCursor);
  await app.close();
});

test('performance: completed, on-time, late, delay days, open overdue', async () => {
  const { app, call, A } = await setup();
  const p = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Dee' })).body;
  const mk = async (title: string, due: string | null, complete: boolean) => {
    const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title, dueDate: due, delegatedToId: p.id, status: 'DELEGATED' })).body;
    if (complete) await call('USER', 'POST', `/tasks/${t.id}/complete`, {});
    return t;
  };
  await mk('on time', ymd(5), true);
  await mk('late 10 days', ymd(-10), true);
  await mk('late 4 days', ymd(-4), true);
  await mk('open overdue 3', ymd(-3), false);
  await mk('open fine', ymd(7), false);
  const r = (await call('USER', 'GET', `/people/performance?companyId=${A.id}&today=${ymd(0)}`)).body.items.find((x: any) => x.personId === p.id);
  assert.equal(r.assigned, 5); assert.equal(r.completed, 3); assert.equal(r.onTime, 1); assert.equal(r.late, 2);
  assert.equal(r.totalDelayDays, 14); assert.equal(r.avgDelayDays, 7); assert.equal(r.maxDelayDays, 10);
  assert.equal(r.open, 2); assert.equal(r.overdueOpen, 1); assert.equal(r.openOverdueDays, 3);
  assert.equal(r.completionRate, 60); assert.equal(r.onTimeRate, 33);
  // other companies' people are invisible to non-members
  assert.equal((await call('outsider', 'GET', '/people/performance')).body.items.length, 0);
  await app.close();
});

test('calls: for a listed person or a free-typed contact, against a task or subtask; done / reopen; viewers cannot add', async () => {
  const { app, call, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'with calls' })).body;
  const s = (await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 'sub' })).body;
  assert.equal((await call('USER', 'POST', '/calls', { taskId: t.id, note: 'nobody named' })).status, 400, 'needs a person or a name');
  const free = await call('USER', 'POST', '/calls', { taskId: t.id, contactName: 'Mr. Nair (vendor)', phone: '98950 00000', note: 'ask about quote', dueDate: ymd(1) });
  assert.equal(free.status, 201); assert.equal(free.body.contactName, 'Mr. Nair (vendor)');
  const person = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Known' })).body;
  const sub = await call('USER', 'POST', '/calls', { taskId: t.id, subtaskId: s.id, personId: person.id, note: 'confirm date' });
  assert.equal(sub.status, 201); assert.equal(sub.body.personName, 'Known'); assert.equal(sub.body.subtaskTitle, 'sub');
  assert.equal((await call('VIEWER', 'POST', '/calls', { taskId: t.id, contactName: 'x' })).status, 403);
  assert.equal((await call('outsider', 'GET', '/calls')).body.items.length, 0);
  const pending = (await call('USER', 'GET', `/calls?taskId=${t.id}`)).body.items; assert.equal(pending.length, 2);
  assert.equal(pending[0].contactName, 'Mr. Nair (vendor)', 'dated calls first');
  const done = await call('USER', 'PATCH', `/calls/${free.body.id}`, { expectedUpdatedAt: free.body.updatedAt, done: true, result: 'Quote is 12k' });
  assert.equal(done.status, 200); assert.ok(done.body.doneAt);
  assert.equal((await call('USER', 'GET', `/calls?taskId=${t.id}`)).body.items.length, 1);
  assert.equal((await call('USER', 'GET', `/calls?taskId=${t.id}&status=done`)).body.items.length, 1);
  const hist = (await call('USER', 'GET', `/tasks/${t.id}/history`)).body.items.map((h: any) => h.action);
  assert.ok(hist.includes('CALL_ADDED') && hist.includes('CALL_DONE'));
  await app.close();
});

test('pomodoro: start on a task/subtask, one at a time, finish adds minutes, notes reach history', async () => {
  const { app, call, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'focus me' })).body;
  const s = (await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 'part' })).body;
  assert.equal((await call('VIEWER', 'POST', '/focus/sessions', { taskId: t.id, plannedMinutes: 25 })).status, 403);
  const a = await call('USER', 'POST', '/focus/sessions', { taskId: t.id, subtaskId: s.id, plannedMinutes: 25 });
  assert.equal(a.status, 201); assert.equal(a.body.subtaskTitle, 'part');
  assert.equal((await call('USER', 'POST', '/focus/sessions', { taskId: t.id, plannedMinutes: 25 })).body.error.code, 'ACTIVE_SESSION');
  assert.equal((await call('USER', 'GET', '/focus/active')).body.session.id, a.body.id);
  // cannot claim more minutes than really passed
  const fin = await call('USER', 'POST', `/focus/sessions/${a.body.id}/finish`, { actualMinutes: 25, completed: true, note: 'drafted the letter' });
  assert.equal(fin.status, 200); assert.ok(fin.body.actualMinutes <= 2, 'clamped to elapsed time');
  assert.equal((await call('USER', 'POST', `/focus/sessions/${a.body.id}/finish`, { actualMinutes: 1, completed: true })).status, 409);
  assert.equal((await call('USER', 'GET', '/focus/active')).body.session, null);
  const f = (await call('USER', 'GET', `/tasks/${t.id}/focus`)).body; assert.equal(f.sessionCount, 1); assert.equal(f.sessions[0].note, 'drafted the letter');
  const hist = (await call('USER', 'GET', `/tasks/${t.id}/history`)).body.items; assert.ok(hist.some((h: any) => h.action === 'FOCUS_SESSION' && h.detail.includes('drafted the letter')));
  const b = await call('USER', 'POST', '/focus/sessions', { taskId: t.id, plannedMinutes: 50 });
  assert.equal((await call('USER', 'POST', `/focus/sessions/${b.body.id}/cancel`)).status, 200, 'cancel discards');
  assert.equal((await call('USER', 'GET', `/tasks/${t.id}/focus`)).body.sessionCount, 1);
  const st = (await call('USER', 'GET', `/focus/stats?dayStart=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&weekStart=${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}`)).body;
  assert.equal(st.todaySessions, 1);
  await app.close();
});

test('message centre: overdue, today, tomorrow, day after; critical tasks; undated calls; calendar range', async () => {
  const { app, call, A } = await setup();
  const mk = (title: string, due: string | null, priority = 3) => call('USER', 'POST', '/tasks', { companyId: A.id, title, dueDate: due, priority }).then((r) => r.body);
  await mk('overdue', ymd(-2)); const crit = await mk('critical today', ymd(0), 1); await mk('critical tomorrow', ymd(1), 1);
  await mk('tomorrow', ymd(1)); await mk('day after', ymd(2)); await mk('too far', ymd(3)); await mk('no date', null);
  const done = await mk('already done', ymd(0)); await call('USER', 'POST', `/tasks/${done.id}/complete`, {});
  await call('USER', 'POST', `/tasks/${crit.id}/subtasks`, { title: 'sub due tomorrow', dueDate: ymd(1) });
  await call('USER', 'POST', '/calls', { taskId: crit.id, contactName: 'Vendor', dueDate: ymd(0), note: 'ring' });
  await call('USER', 'POST', '/calls', { taskId: crit.id, contactName: 'Someday', note: 'no date' });
  const m = (await call('USER', 'GET', `/messages?today=${ymd(0)}`)).body;
  const titles = (g: any[]) => g.map((i) => i.title).sort();
  assert.deepEqual(titles(m.overdue), ['overdue']);
  assert.deepEqual(titles(m.days[0].items), ['Vendor', 'critical today']);
  assert.deepEqual(titles(m.days[1].items), ['critical tomorrow', 'sub due tomorrow', 'tomorrow']);
  assert.deepEqual(titles(m.days[2].items), ['day after']);
  assert.deepEqual(m.critical.map((c: any) => c.title), ['critical today']);
  assert.equal(m.undatedCalls.length, 1); assert.equal(m.badge, 3);
  assert.equal((await call('outsider', 'GET', `/messages?today=${ymd(0)}`)).body.badge, 0);
  const cal = (await call('USER', 'GET', `/calendar?from=${ymd(0)}&to=${ymd(3)}`)).body.items;
  assert.ok(cal.some((i: any) => i.title === 'too far') && !cal.some((i: any) => i.title === 'overdue') && !cal.some((i: any) => i.title === 'already done'));
  assert.equal((await call('USER', 'GET', `/calendar?from=${ymd(0)}&to=${ymd(400)}`)).status, 400);
  await app.close();
});

test('drafts: private to their owner, savable, updatable, discardable', async () => {
  const { app, call } = await setup();
  const d = await call('USER', 'POST', '/drafts', { kind: 'task', title: 'half written', data: { title: 'half written', priority: 2 } });
  assert.equal(d.status, 201);
  assert.equal((await call('USER', 'PATCH', `/drafts/${d.body.id}`, { title: 'more', data: { title: 'more', priority: 2, description: 'x' } })).body.data.description, 'x');
  assert.equal((await call('USER', 'GET', '/drafts')).body.items.length, 1);
  assert.equal((await call('MANAGER', 'GET', '/drafts')).body.items.length, 0, 'other users cannot see it');
  assert.equal((await call('MANAGER', 'PATCH', `/drafts/${d.body.id}`, { data: {} })).status, 404);
  assert.equal((await call('USER', 'POST', '/drafts', { kind: 'nonsense', data: {} })).status, 400);
  assert.equal((await call('USER', 'DELETE', `/drafts/${d.body.id}`)).status, 200);
  assert.equal((await call('USER', 'GET', '/drafts')).body.items.length, 0);
  assert.equal((await (app as any).db.get('SELECT COUNT(*) n FROM drafts')).n, 1, 'soft-deleted, row kept');
  await app.close();
});
