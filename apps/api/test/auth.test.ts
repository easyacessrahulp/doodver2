import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, CSRF_HEADER } from '../src/app.ts';
import { setup } from './helpers.ts';

test('registration works only while no users exist; first user is Admin', async () => {
  const app = await buildApp({ dbPath: ':memory:' });
  const h = { 'x-requested-with': CSRF_HEADER };
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json().needsSetup, true);
  const short = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: h, payload: { name: 'A', email: 'a@x.test', password: 'short' } });
  assert.equal(short.statusCode, 400, 'password min length');
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: h, payload: { name: 'A', email: 'a@x.test', password: 'long-enough-pw' } });
  assert.equal(r.statusCode, 201); assert.equal(r.json().user.isAdmin, true);
  const r2 = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: h, payload: { name: 'B', email: 'b@x.test', password: 'long-enough-pw' } });
  assert.equal(r2.statusCode, 403); assert.equal(r2.json().error.code, 'REGISTRATION_CLOSED');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json().needsSetup, false);
  await app.close();
});

test('passwords are argon2id-hashed; session tokens are stored only as hashes; cookie is httpOnly', async () => {
  const { app, call, PW } = await setup();
  const db = (app as any).db;
  const u = await db.get("SELECT password_hash FROM users WHERE email = 'admin@x.test'");
  assert.match(u.passwordHash, /^\$argon2id\$/); assert.ok(!u.passwordHash.includes(PW));
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-requested-with': CSRF_HEADER }, payload: { email: 'admin@x.test', password: PW } });
  const cookie = String(res.headers['set-cookie']); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
  const token = cookie.split(';')[0].split('=')[1];
  const rows = await db.all('SELECT token_hash FROM sessions'); assert.ok(rows.length > 0 && rows.every((r: any) => r.tokenHash !== token && r.tokenHash.length === 64));
  await app.close();
});

test('wrong password rejected; repeated failures are throttled', async () => {
  const { app, call } = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await call('x', 'POST', '/auth/login', { email: 'user@x.test', password: 'nope-nope-nope' })).status, 401);
  const r = await call('x', 'POST', '/auth/login', { email: 'user@x.test', password: 'nope-nope-nope' });
  assert.equal(r.status, 429);
  await app.close();
});

test('unauthenticated requests are rejected; logout and password change revoke sessions', async () => {
  const { app, call, PW } = await setup();
  assert.equal((await call('nobody', 'GET', '/tasks')).status, 401);
  assert.equal((await call('USER', 'GET', '/auth/me')).status, 200);
  await call('USER', 'POST', '/auth/logout');
  assert.equal((await call('USER', 'GET', '/auth/me')).status, 401, 'session destroyed server-side');
  // password change signs out other sessions
  await call('USER', 'POST', '/auth/login', { email: 'user@x.test', password: PW });
  await call('USER2', 'POST', '/auth/login', { email: 'user@x.test', password: PW });
  assert.equal((await call('USER2', 'POST', '/auth/change-password', { currentPassword: PW, newPassword: 'another-long-password' })).status, 200);
  assert.equal((await call('USER', 'GET', '/auth/me')).status, 401, 'other session revoked');
  assert.equal((await call('USER2', 'GET', '/auth/me')).status, 200, 'current session kept');
  await app.close();
});

test('CSRF: mutating requests need the custom header and a same-origin Origin', async () => {
  const { app, call, PW } = await setup();
  const noHeader = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'user@x.test', password: PW } });
  assert.equal(noHeader.statusCode, 403);
  const evil = await call('USER', 'POST', '/tasks', { companyId: 'x', title: 't' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  await app.close();
});

test('deactivated users lose access immediately', async () => {
  const { app, call, users } = await setup();
  const u = (await call('admin', 'GET', '/users')).body.items.find((x: any) => x.id === users.USER);
  assert.equal((await call('admin', 'PATCH', `/users/${users.USER}`, { expectedUpdatedAt: u.updatedAt, active: false })).status, 200);
  assert.equal((await call('USER', 'GET', '/auth/me')).status, 401);
  await app.close();
});
