import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('dependency: a blocked task cannot be completed until its blocker is done', async () => {
  const { app, call, A } = await setup();
  const a = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'blocker' })).body;
  const b = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'blocked', dependsOnId: a.id })).body;
  assert.equal(b.blocked, true);
  const r = await call('USER', 'POST', `/tasks/${b.id}/complete`, {});
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'BLOCKED');
  const viaPatch = await call('USER', 'PATCH', `/tasks/${b.id}`, { expectedUpdatedAt: b.updatedAt, status: 'DONE' });
  assert.equal(viaPatch.body.error.code, 'BLOCKED', 'PATCH cannot bypass the rule');
  assert.equal((await call('USER', 'POST', `/tasks/${a.id}/complete`, { note: 'finished' })).status, 200);
  const ok = await call('USER', 'POST', `/tasks/${b.id}/complete`, {});
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'DONE'); assert.ok(ok.body.completedAt);
  await app.close();
});

test('dependencies reject self-reference, cycles and cross-company links', async () => {
  const { app, call, A, B } = await setup();
  const a = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'a' })).body;
  const b = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'b', dependsOnId: a.id })).body;
  assert.equal((await call('USER', 'PATCH', `/tasks/${a.id}`, { expectedUpdatedAt: a.updatedAt, dependsOnId: a.id })).status, 400);
  assert.equal((await call('USER', 'PATCH', `/tasks/${a.id}`, { expectedUpdatedAt: a.updatedAt, dependsOnId: b.id })).status, 400, 'cycle');
  const other = (await call('admin', 'POST', '/tasks', { companyId: B.id, title: 'other co' })).body;
  assert.equal((await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'x', dependsOnId: other.id })).status, 400);
  await app.close();
});

test('completion leaves active lists, stays retrievable, and can be reopened', async () => {
  const { app, call, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'finish me' })).body;
  await call('USER', 'POST', `/tasks/${t.id}/complete`, { note: 'all done' });
  assert.ok(!(await call('USER', 'GET', `/tasks?companyId=${A.id}`)).body.items.some((x: any) => x.id === t.id), 'gone from active');
  const done = (await call('USER', 'GET', `/tasks?companyId=${A.id}&completed=true`)).body.items.find((x: any) => x.id === t.id);
  assert.equal(done.completionNote, 'all done'); assert.equal(done.progress, 100);
  const re = await call('USER', 'POST', `/tasks/${t.id}/reopen`);
  assert.equal(re.body.status, 'TODO'); assert.equal(re.body.completedAt, null);
  const hist = (await call('USER', 'GET', `/tasks/${t.id}/history`)).body.items.map((h: any) => h.action);
  assert.ok(hist.includes('COMPLETED') && hist.includes('REOPENED'));
  await app.close();
});

test('every write appends to the activity log; comments are append-only', async () => {
  const { app, call, A } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'audit me' })).body;
  const u = await call('USER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: t.updatedAt, priority: 1, title: 'audited' });
  await call('USER', 'POST', '/comments', { entityType: 'TASK', entityId: t.id, body: 'first' });
  const hist = (await call('USER', 'GET', `/tasks/${t.id}/history`)).body.items;
  assert.deepEqual(hist.map((h: any) => h.action).sort(), ['COMMENT_ADDED', 'CREATED', 'UPDATED']);
  const upd = hist.find((h: any) => h.action === 'UPDATED'); assert.equal(JSON.parse(upd.detail).priority[1], 1);
  assert.equal(u.status, 200);
  for (const m of ['PATCH', 'PUT', 'DELETE']) assert.ok([404, 405].includes((await call('USER', m, '/comments/whatever', {})).status));
  await app.close();
});

test('postponing a due date increments postponeCount; delegation stamps delegatedAt', async () => {
  const { app, call, A } = await setup();
  const person = (await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Dee' })).body;
  let t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'p', dueDate: '2030-01-10' })).body;
  t = (await call('USER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: t.updatedAt, dueDate: '2030-01-20' })).body;
  assert.equal(t.postponeCount, 1);
  t = (await call('USER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: t.updatedAt, dueDate: '2030-01-05' })).body;
  assert.equal(t.postponeCount, 1, 'pulling a date earlier is not a postponement');
  t = (await call('USER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: t.updatedAt, delegatedToId: person.id, status: 'DELEGATED' })).body;
  assert.ok(t.delegatedAt); assert.equal(t.delegatedToName, 'Dee');
  await app.close();
});

test('validation, derived progress, filters and pagination', async () => {
  const { app, call, A, project } = await setup();
  assert.equal((await call('USER', 'POST', '/tasks', { companyId: A.id, title: '' })).status, 400);
  assert.equal((await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'x', dueDate: '10/01/2030' })).status, 400);
  assert.equal((await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'x', priority: 9 })).status, 400);
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'parent', projectId: project.id, dueDate: '2000-01-01' })).body;
  const s1 = (await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 's1' })).body;
  await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 's2' });
  await call('USER', 'PATCH', `/subtasks/${s1.id}`, { expectedUpdatedAt: s1.updatedAt, status: 'DONE' });
  assert.equal((await call('USER', 'GET', `/tasks/${t.id}`)).body.progress, 50, 'derived from subtasks');
  assert.ok((await call('USER', 'GET', `/tasks?companyId=${A.id}&overdue=true`)).body.items.some((x: any) => x.id === t.id));
  for (let i = 0; i < 4; i++) await call('USER', 'POST', '/tasks', { companyId: A.id, title: `bulk ${i}` });
  const p1 = (await call('USER', 'GET', `/tasks?companyId=${A.id}&limit=2`)).body;
  assert.equal(p1.items.length, 2); assert.ok(p1.nextCursor);
  const p2 = (await call('USER', 'GET', `/tasks?companyId=${A.id}&limit=2&cursor=${p1.nextCursor}`)).body;
  assert.ok(!p2.items.some((x: any) => p1.items.some((y: any) => y.id === x.id)), 'no overlap between pages');
  assert.equal((await call('USER', 'GET', `/tasks?companyId=${A.id}&q=bulk`)).body.items.length, 4);
  await app.close();
});

test('references must belong to the same company; duplicate project names rejected', async () => {
  const { app, call, A, B, project } = await setup();
  const foreign = (await call('admin', 'POST', '/projects', { companyId: B.id, name: 'Other' })).body;
  assert.equal((await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'x', projectId: foreign.id })).status, 400);
  assert.equal((await call('MANAGER', 'POST', '/projects', { companyId: A.id, name: project.name.toUpperCase() })).status, 409);
  await app.close();
});
