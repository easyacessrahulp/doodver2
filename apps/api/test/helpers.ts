import { buildApp, CSRF_HEADER } from '../src/app.ts';

export async function setup(o: { ai?: any } = {}) {
  const app = await buildApp({ dbPath: ':memory:', ai: o.ai ?? { apiKey: '' } });   // tests never talk to the real OpenAI
  const cookies = new Map<string, string>();
  async function call(who: string, method: string, url: string, body?: any, extraHeaders: Record<string, string> = {}) {
    const res = await app.inject({
      method: method as any, url: '/api/v1' + url, payload: body,
      headers: { 'x-requested-with': CSRF_HEADER, ...(cookies.has(who) ? { cookie: cookies.get(who)! } : {}), ...extraHeaders },
    });
    const sc = res.headers['set-cookie']; if (sc) cookies.set(who, String(Array.isArray(sc) ? sc[0] : sc).split(';')[0]);
    let json: any = null; try { json = res.json(); } catch { /* empty */ }
    return { status: res.statusCode, body: json };
  }
  const raw = (who: string, method: string, url: string, body?: any) => app.inject({ method: method as any, url: '/api/v1' + url, payload: body, headers: { 'x-requested-with': CSRF_HEADER, ...(cookies.has(who) ? { cookie: cookies.get(who)! } : {}) } });
  const PW = 'correct-horse-battery';
  // Admin + one user per role, each member of company A only; company B visible only to admin.
  const reg = await call('admin', 'POST', '/auth/register', { name: 'Admin', email: 'admin@x.test', password: PW });
  const A = (await call('admin', 'POST', '/companies', { name: 'Alpha Ltd', code: 'ALPHA' })).body;
  const B = (await call('admin', 'POST', '/companies', { name: 'Beta Ltd', code: 'BETA' })).body;
  const users: Record<string, string> = {};
  for (const role of ['MANAGER', 'USER', 'VIEWER']) {
    const u = (await call('admin', 'POST', '/users', { name: role, email: `${role.toLowerCase()}@x.test`, password: PW, mustChangePassword: false })).body;
    users[role] = u.id;
    await call('admin', 'PUT', `/users/${u.id}/memberships/${A.id}`, { role });
    await call(role, 'POST', '/auth/login', { email: `${role.toLowerCase()}@x.test`, password: PW });
  }
  const outsider = (await call('admin', 'POST', '/users', { name: 'Outsider', email: 'out@x.test', password: PW, mustChangePassword: false })).body;
  await call('outsider', 'POST', '/auth/login', { email: 'out@x.test', password: PW });
  const project = (await call('admin', 'POST', '/projects', { companyId: A.id, name: 'Proj' })).body;
  return { app, call, raw, A, B, users, outsider, project, adminId: reg.body.user.id, PW };
}
