import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('role matrix: who can do what inside a company', async () => {
  const { app, call, A, project } = await setup();
  const task = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'T' })).body;
  assert.ok(task.id, 'USER can create a task');

  // Viewer: read yes, write no
  assert.equal((await call('VIEWER', 'GET', `/tasks/${task.id}`)).status, 200);
  assert.equal((await call('VIEWER', 'POST', '/tasks', { companyId: A.id, title: 'x' })).status, 403);
  assert.equal((await call('VIEWER', 'PATCH', `/tasks/${task.id}`, { expectedUpdatedAt: task.updatedAt, title: 'no' })).status, 403);
  assert.equal((await call('VIEWER', 'POST', '/comments', { entityType: 'TASK', entityId: task.id, body: 'hi' })).status, 403);
  assert.equal((await call('VIEWER', 'GET', `/comments?entityType=TASK&entityId=${task.id}`)).status, 200);

  // User: tasks/subtasks/comments yes; projects/people/companies no
  assert.equal((await call('USER', 'POST', `/tasks/${task.id}/subtasks`, { title: 'sub' })).status, 201);
  assert.equal((await call('USER', 'POST', '/comments', { entityType: 'TASK', entityId: task.id, body: 'hi' })).status, 201);
  assert.equal((await call('USER', 'POST', '/projects', { companyId: A.id, name: 'P2' })).status, 403);
  assert.equal((await call('USER', 'PATCH', `/projects/${project.id}`, { expectedUpdatedAt: project.updatedAt, name: 'z' })).status, 403);
  assert.equal((await call('USER', 'POST', '/people', { companyId: A.id, name: 'Pat' })).status, 403);
  assert.equal((await call('USER', 'POST', '/companies', { name: 'Gamma', code: 'GAMMA' })).status, 403);

  // Manager: projects + people yes; companies and users no
  assert.equal((await call('MANAGER', 'POST', '/projects', { companyId: A.id, name: 'P2' })).status, 201);
  assert.equal((await call('MANAGER', 'POST', '/people', { companyId: A.id, name: 'Pat' })).status, 201);
  assert.equal((await call('MANAGER', 'POST', '/people', { name: 'Shared person' })).status, 403, 'shared people are Admin-only');
  assert.equal((await call('MANAGER', 'POST', '/companies', { name: 'Gamma', code: 'GAMMA' })).status, 403);
  assert.equal((await call('MANAGER', 'GET', '/users')).status, 403);
  assert.equal((await call('MANAGER', 'POST', '/admin/demo-data/load')).status, 403);

  // Admin: everything
  assert.equal((await call('admin', 'GET', '/users')).status, 200);
  assert.equal((await call('admin', 'POST', '/companies', { name: 'Gamma', code: 'GAMMA' })).status, 201);
  await app.close();
});

test('non-members get 404 (existence is not leaked) and see nothing in lists', async () => {
  const { app, call, A, B } = await setup();
  const task = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'secret' })).body;
  for (const [m, u] of [['GET', `/tasks/${task.id}`], ['GET', `/companies/${A.id}`], ['GET', `/tasks?companyId=${A.id}`], ['GET', `/projects?companyId=${A.id}`]])
    assert.equal((await call('outsider', m, u)).status, 404, `${m} ${u}`);
  assert.equal((await call('outsider', 'POST', '/tasks', { companyId: A.id, title: 'x' })).status, 404);
  assert.equal((await call('outsider', 'GET', '/tasks')).body.items.length, 0);
  assert.equal((await call('outsider', 'GET', '/companies')).body.items.length, 0);
  // USER of company A cannot touch company B
  assert.equal((await call('USER', 'GET', `/companies/${B.id}`)).status, 404);
  assert.equal((await call('USER', 'POST', '/tasks', { companyId: B.id, title: 'x' })).status, 404);
  const mine = (await call('USER', 'GET', '/companies')).body.items;
  assert.deepEqual(mine.map((c: any) => c.id), [A.id]);
  await app.close();
});

test('only Admins manage users and memberships; the last Admin cannot be removed', async () => {
  const { app, call, A, users, adminId } = await setup();
  assert.equal((await call('USER', 'PUT', `/users/${users.USER}/memberships/${A.id}`, { role: 'MANAGER' })).status, 403);
  assert.equal((await call('USER', 'POST', '/users', { name: 'n', email: 'n@x.test', password: 'long-enough-pw' })).status, 403);
  const me = (await call('admin', 'GET', '/users')).body.items.find((u: any) => u.id === adminId);
  const r = await call('admin', 'PATCH', `/users/${adminId}`, { expectedUpdatedAt: me.updatedAt, isAdmin: false });
  assert.equal(r.status, 400);
  await app.close();
});

test('task ownership: a User can archive only own/created tasks; Manager can archive any', async () => {
  const { app, call, A } = await setup();
  const others = (await call('MANAGER', 'POST', '/tasks', { companyId: A.id, title: 'manager task' })).body;
  assert.equal((await call('USER', 'POST', `/tasks/${others.id}/archive`)).status, 403);
  const own = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'mine' })).body;
  assert.equal((await call('USER', 'POST', `/tasks/${own.id}/archive`)).status, 200);
  assert.equal((await call('MANAGER', 'POST', `/tasks/${others.id}/archive`)).status, 200);
  await app.close();
});
