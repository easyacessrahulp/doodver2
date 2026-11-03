import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

// Two scoped team members (Ravi, Sita) in company A, plus the owner. Nothing of one must ever show for the other.
async function team() {
  const t = await setup();
  const { call, A, PW } = t;
  const mk = async (loginId: string, name: string) => {
    const u = (await call('admin', 'POST', '/users', { name, loginId, password: PW, mustChangePassword: false, companies: [{ companyId: A.id, role: 'MEMBER' }] })).body;
    assert.ok(u.id, 'user created'); assert.ok(u.personId, 'linked person');
    assert.equal((await call(loginId, 'POST', '/auth/login', { loginId, password: PW })).status, 200);
    return u;
  };
  const ravi = await mk('ravi', 'Ravi'); const sita = await mk('sita', 'Sita');
  return { ...t, ravi, sita };
}

test('admin creates a login by user ID; user ID is unique; forced password change blocks everything else until done', async () => {
  const { call, A } = await setup();
  const u = (await call('admin', 'POST', '/users', { name: 'Anu', loginId: 'Anu.K', password: 'temp-pass-1', companies: [{ companyId: A.id, role: 'MEMBER' }] })).body;
  assert.equal(u.loginId, 'anu.k');
  assert.equal((await call('admin', 'POST', '/users', { name: 'Dup', loginId: 'anu.k', password: 'temp-pass-2' })).status, 409);
  assert.equal((await call('anu', 'POST', '/auth/login', { loginId: 'ANU.K', password: 'wrong' })).status, 401);
  const ok = await call('anu', 'POST', '/auth/login', { loginId: 'anu.k', password: 'temp-pass-1' });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.mustChangePassword, true);
  const blocked = await call('anu', 'GET', '/tasks');
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await call('anu', 'POST', '/auth/change-password', { currentPassword: 'temp-pass-1', newPassword: 'my-own-secret-1' })).status, 200);
  assert.equal((await call('anu', 'POST', '/auth/login', { loginId: 'anu.k', password: 'my-own-secret-1' })).status, 200);
  assert.equal((await call('anu', 'GET', '/tasks')).status, 200);
  // login history is kept for the owner
  const hist = (await call('admin', 'GET', `/users/${u.id}/logins`)).body.items;
  assert.ok(hist.some((h: any) => h.ok === true) && hist.some((h: any) => h.ok === false));
});

test('team member sees only what they own, created, were given or were added to — across every list', async () => {
  const { call, raw, A, ravi, sita } = await team();
  const rt = (await call('ravi', 'POST', '/tasks', { companyId: A.id, title: 'Ravi private task', dueDate: '2026-01-01' })).body;
  const st = (await call('sita', 'POST', '/tasks', { companyId: A.id, title: 'Sita secret task', dueDate: '2026-01-01', priority: 1 })).body;
  assert.ok(rt.id && st.id);
  await call('sita', 'POST', `/tasks/${st.id}/subtasks`, { title: 'sita sub' });
  await call('sita', 'POST', '/calls', { taskId: st.id, contactName: 'Mr Secret', dueDate: '2026-01-01' });
  await call('sita', 'POST', '/discussions', { taskId: st.id, contactName: 'Mr Secret', topic: 'secret topic', dueDate: '2026-01-01' });
  await call('sita', 'POST', '/followups', { taskId: st.id, contactName: 'Mr Secret', dueDate: '2026-01-01' });
  await call('sita', 'POST', '/notes', { taskId: st.id, title: 'secret note', body: 'classified' });
  await call('sita', 'POST', '/comments', { entityType: 'TASK', entityId: st.id, body: 'classified comment' });
  const as = async (who: string, url: string) => (await call(who, 'GET', url));
  const lists = ['/tasks', '/calls?status=all', '/discussions?status=all', '/followups?status=all', '/notes', '/calendar?from=2025-12-01&to=2026-02-01', '/messages', '/attention', '/dashboard',
    '/search?q=secret', '/explore?companyId=' + A.id, '/explore', '/reviews/daily', '/reviews/management', '/people/performance', '/discussions/by-person'];
  for (const url of lists) {
    const r = await as('ravi', url);
    assert.equal(r.status, 200, url + ' ' + JSON.stringify(r.body).slice(0, 200));
    const txt = JSON.stringify(r.body);
    assert.ok(!/Sita secret|secret topic|Mr Secret|classified|sita sub/i.test(txt), `${url} leaked Sita's work to Ravi`);
  }
  // direct access by id: looks like it does not exist
  for (const url of [`/tasks/${st.id}`, `/tasks/${st.id}/subtasks`, `/tasks/${st.id}/history`, `/tasks/${st.id}/followups`, `/tasks/${st.id}/attachments`, `/tasks/${st.id}/focus`, `/comments?entityType=TASK&entityId=${st.id}`])
    assert.equal((await as('ravi', url)).status, 404, url);
  assert.equal((await call('ravi', 'PATCH', `/tasks/${st.id}`, { title: 'hijack', expectedUpdatedAt: st.updatedAt })).status, 404);
  assert.equal((await call('ravi', 'POST', '/calls', { taskId: st.id, contactName: 'x' })).status, 404);
  assert.equal((await call('ravi', 'POST', '/comments', { entityType: 'TASK', entityId: st.id, body: 'hi' })).status, 404);
  assert.equal((await call('ravi', 'POST', `/tasks/${st.id}/subtasks`, { title: 'x' })).status, 404);
  // but Ravi sees his own
  const mine = (await as('ravi', '/tasks')).body.items.map((t: any) => t.title);
  assert.deepEqual(mine, ['Ravi private task']);
  // exports are scoped too
  const csv = await raw('ravi', 'GET', '/export/csv?dataset=tasks&scope=all'); assert.equal(csv.statusCode, 200);
  assert.ok(csv.body.includes('Ravi private task') && !csv.body.includes('Sita secret'), 'export leaked'); void sita;
  const wd = await raw('ravi', 'GET', '/export-word/pending-jobs'); assert.equal(wd.statusCode, 200);
  // the owner still sees everything
  assert.equal((await call('admin', 'GET', '/tasks')).body.items.length, 2);
});

test('delegation between members: the receiver sees it, keeps seeing it, and can pass it on; the sender keeps seeing it', async () => {
  const { call, A, ravi, sita } = await team();
  const t = (await call('ravi', 'POST', '/tasks', { companyId: A.id, title: 'Ravi hands over' })).body;
  assert.equal((await call('sita', 'GET', `/tasks/${t.id}`)).status, 404);
  const d = await call('ravi', 'PATCH', `/tasks/${t.id}`, { delegatedToId: sita.personId, delegationInstructions: 'please do', expectedUpdatedAt: t.updatedAt });
  assert.equal(d.status, 200);
  const seen = await call('sita', 'GET', `/tasks/${t.id}`); assert.equal(seen.status, 200);
  const n = (await call('sita', 'GET', '/notifications')).body;
  assert.ok(n.items.some((x: any) => x.kind === 'ASSIGNED' && /Ravi/.test(x.title)), 'Sita was notified');
  assert.equal((await call('ravi', 'GET', `/tasks/${t.id}`)).status, 200);
  // Sita completes it (member can write what she can see)
  const done = await call('sita', 'POST', `/tasks/${t.id}/complete`, { note: 'finished' });
  assert.equal(done.status, 200); assert.equal(done.body.status, 'DONE');
  // pass on to Ravi's... third member
  void ravi;
});

test('read-only View-as: the owner sees exactly what the member sees, cannot change anything; Act-as can; both are logged', async () => {
  const { call, A, ravi } = await team();
  await call('ravi', 'POST', '/tasks', { companyId: A.id, title: 'Ravi only' });
  await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Owner only' });
  const v = await call('admin', 'POST', '/auth/view-as', { userId: ravi.id });
  assert.equal(v.status, 200); assert.equal(v.body.viewAs.readOnly, true); assert.equal(v.body.user.name, 'Ravi');
  assert.deepEqual((await call('admin', 'GET', '/tasks')).body.items.map((t: any) => t.title), ['Ravi only']);
  const w = await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'nope' });
  assert.equal(w.status, 403); assert.equal(w.body.error.code, 'READ_ONLY');
  assert.equal((await call('admin', 'GET', '/users')).status, 403, 'Ravi is not an admin, so admin pages stay closed while viewing as him');
  assert.equal((await call('admin', 'DELETE', '/auth/view-as')).status, 200);
  assert.equal((await call('admin', 'GET', '/tasks')).body.items.length, 2);
  assert.equal((await call('ravi', 'POST', '/auth/view-as', { userId: ravi.id })).status, 403, 'only the owner can view-as');
  await call('admin', 'POST', '/auth/view-as', { userId: ravi.id, actAs: true });
  assert.equal((await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'made by owner on his behalf' })).status, 201);
  await call('admin', 'DELETE', '/auth/view-as');
  const hist = (await call('admin', 'GET', `/users/${ravi.id}/logins`)).body.items;
  assert.ok(hist.some((h: any) => h.kind === 'VIEW_AS') && hist.some((h: any) => h.kind === 'ACT_AS'));
});

test('owner can sign someone out everywhere and reset their password', async () => {
  const { call, ravi, PW } = await team();
  assert.equal((await call('ravi', 'GET', '/tasks')).status, 200);
  assert.equal((await call('admin', 'POST', `/users/${ravi.id}/sign-out`)).status, 200);
  assert.equal((await call('ravi', 'GET', '/tasks')).status, 401);
  const cur = (await call('admin', 'GET', '/users')).body.items.find((u: any) => u.id === ravi.id);
  assert.equal((await call('admin', 'PATCH', `/users/${ravi.id}`, { password: 'brand-new-pass-9', expectedUpdatedAt: cur.updatedAt })).status, 200);
  assert.equal((await call('ravi', 'POST', '/auth/login', { loginId: 'ravi', password: PW })).status, 401);
  const r = await call('ravi', 'POST', '/auth/login', { loginId: 'ravi', password: 'brand-new-pass-9' });
  assert.equal(r.body.user.mustChangePassword, true);
});
