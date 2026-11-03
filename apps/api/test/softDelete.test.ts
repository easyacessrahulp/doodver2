import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('archive hides rows from lists but never removes them; restore brings them back', async () => {
  const { app, call, A, project } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'to archive', projectId: project.id })).body;
  await call('USER', 'POST', `/tasks/${t.id}/subtasks`, { title: 's' });
  await call('USER', 'POST', '/comments', { entityType: 'TASK', entityId: t.id, body: 'note' });

  assert.equal((await call('USER', 'POST', `/tasks/${t.id}/archive`)).status, 200);
  const active = (await call('USER', 'GET', `/tasks?companyId=${A.id}`)).body.items;
  assert.ok(!active.some((x: any) => x.id === t.id), 'hidden from active list');
  const archived = (await call('USER', 'GET', `/tasks?companyId=${A.id}&archived=true`)).body.items;
  assert.ok(archived.some((x: any) => x.id === t.id), 'present in archived list');
  assert.equal((await call('USER', 'GET', `/tasks/${t.id}`)).status, 200, 'still retrievable by id');
  const row = (app as any).db;
  assert.equal((await row.get('SELECT COUNT(*) n FROM tasks WHERE id = ?', [t.id])).n, 1, 'row physically exists');
  assert.equal((await row.get('SELECT COUNT(*) n FROM subtasks WHERE task_id = ?', [t.id])).n, 1);
  assert.equal((await row.get('SELECT COUNT(*) n FROM comments WHERE entity_id = ?', [t.id])).n, 1);

  assert.equal((await call('USER', 'POST', `/tasks/${t.id}/restore`)).status, 200);
  assert.ok((await call('USER', 'GET', `/tasks?companyId=${A.id}`)).body.items.some((x: any) => x.id === t.id), 'restored');
  const hist = (await call('USER', 'GET', `/tasks/${t.id}/history`)).body.items.map((h: any) => h.action);
  assert.ok(hist.includes('ARCHIVED') && hist.includes('RESTORED'), 'both events audited');
  await app.close();
});

test('there is no hard-delete route for any entity', async () => {
  const { app, call, A, project } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'x' })).body;
  for (const u of [`/tasks/${t.id}`, `/companies/${A.id}`, `/projects/${project.id}`])
    assert.ok([404, 405].includes((await call('admin', 'DELETE', u)).status), `DELETE ${u}`);
  await app.close();
});

test('companies and projects archive/restore; demo data clear archives instead of deleting', async () => {
  const { app, call, A } = await setup();
  assert.equal((await call('admin', 'POST', '/admin/demo-data/load')).body.active, true);
  const n = (await (app as any).db.get('SELECT COUNT(*) n FROM tasks WHERE is_demo = 1')).n;
  assert.ok(n >= 15, 'demo tasks exist');
  const r = await call('admin', 'POST', '/admin/demo-data/clear');
  assert.equal(r.body.active, false);
  assert.equal((await (app as any).db.get('SELECT COUNT(*) n FROM tasks WHERE is_demo = 1')).n, n, 'rows still exist');
  assert.equal((await (app as any).db.get('SELECT COUNT(*) n FROM tasks WHERE is_demo = 1 AND archived_at IS NULL')).n, 0);
  assert.equal((await call('admin', 'POST', '/admin/demo-data/load')).body.active, true, 'restorable');
  assert.equal((await call('admin', 'POST', `/companies/${A.id}/archive`)).status, 200);
  assert.ok(!(await call('admin', 'GET', '/companies')).body.items.some((c: any) => c.id === A.id));
  await app.close();
});
