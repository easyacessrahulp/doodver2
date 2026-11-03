import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('stale expectedUpdatedAt → 409 with the current record; fresh → 200', async () => {
  const { app, call, A, project } = await setup();
  const t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'v1' })).body;
  const a = await call('USER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: t.updatedAt, title: 'v2' });
  assert.equal(a.status, 200); assert.equal(a.body.title, 'v2');
  const b = await call('MANAGER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: t.updatedAt, title: 'v3' });
  assert.equal(b.status, 409); assert.equal(b.body.error.code, 'STALE');
  assert.equal(b.body.error.current.title, 'v2', 'returns what is stored now');
  const c = await call('MANAGER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: a.body.updatedAt, title: 'v3' });
  assert.equal(c.status, 200);
  // same rule on masters
  const p1 = await call('MANAGER', 'PATCH', `/projects/${project.id}`, { expectedUpdatedAt: project.updatedAt, name: 'renamed' });
  assert.equal(p1.status, 200);
  assert.equal((await call('MANAGER', 'PATCH', `/projects/${project.id}`, { expectedUpdatedAt: project.updatedAt, name: 'again' })).status, 409);
  await app.close();
});

test('rapid back-to-back updates never share an updatedAt (no silent lost updates)', async () => {
  const { app, call, A } = await setup();
  let t = (await call('USER', 'POST', '/tasks', { companyId: A.id, title: 'n0' })).body;
  const seen = new Set([t.updatedAt]);
  for (let i = 1; i <= 15; i++) {
    const r = await call('USER', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: t.updatedAt, title: `n${i}` });
    assert.equal(r.status, 200); assert.ok(!seen.has(r.body.updatedAt)); seen.add(r.body.updatedAt); t = r.body;
  }
  await app.close();
});
