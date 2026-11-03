// Load test: 10,000 tasks + 50,000 subtasks + comments, then time the heavy endpoints.   Run: npm run perf -w apps/api
import { buildApp, CSRF_HEADER } from '../src/app.ts';
import { newId } from '../src/lib/db.ts';

const app = await buildApp({ dbPath: ':memory:' }); const db = (app as any).db; const H = { 'x-requested-with': CSRF_HEADER };
const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'Perf', email: 'p@x.test', password: 'long-enough-pw' } });
const ck = String(reg.headers['set-cookie']).split(';')[0]; const uid = reg.json().user.id; const now = new Date().toISOString();
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
await db.tx(async (t: any) => {
  const cos: string[] = [], projs: string[] = [], ppl: string[] = [];
  for (let c = 0; c < 4; c++) { const id = newId(); cos.push(id); await t.run('INSERT INTO companies (id,name,code,active,is_demo,created_at,updated_at) VALUES (?,?,?,?,0,?,?)', [id, `Company ${c}`, `C${c}X`, 1, now, now]);
    for (let p = 0; p < 6; p++) { const pid = newId(); projs.push(pid + '|' + id); await t.run('INSERT INTO projects (id,company_id,name,priority,status,is_demo,created_at,updated_at) VALUES (?,?,?,3,?,0,?,?)', [pid, id, `Project ${c}-${p}`, 'ACTIVE', now, now]); } }
  for (let p = 0; p < 40; p++) { const id = newId(); ppl.push(id); await t.run('INSERT INTO people (id,name,active,is_demo,created_at,updated_at) VALUES (?,?,1,0,?,?)', [id, `Person ${p}`, now, now]); }
  for (let i = 0; i < 10000; i++) {
    const [pid, cid] = projs[i % projs.length].split('|'); const id = newId(); const del = i % 3 === 0 ? ppl[i % 40] : null; const done = i % 5 === 0;
    await t.run(`INSERT INTO tasks (id,company_id,project_id,title,owner_id,delegated_to_id,priority,status,due_date,last_activity_at,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, cid, pid, `Task number ${i} about GST filing`, uid, del, (i % 4) + 1, done ? 'DONE' : del ? 'DELEGATED' : 'TODO', day((i % 60) - 20), new Date(Date.now() - (i % 10) * 864e5).toISOString(), now, now, done ? now : null]);
    for (let s = 0; s < 5; s++) await t.run('INSERT INTO subtasks (id,task_id,company_id,title,status,position,assignee_id,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [newId(), id, cid, `Sub ${s}`, s % 2 ? 'DONE' : 'TODO', s, ppl[(i + s) % 40], day((i % 30) - 10), now, now]);
    if (i % 2 === 0) await t.run('INSERT INTO comments (id,company_id,entity_type,entity_id,body,author_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [newId(), cid, 'TASK', id, `note ${i} about the notice`, uid, now, now]);
  }
});
console.log('rows:', JSON.stringify({ tasks: (await db.get('SELECT COUNT(*) n FROM tasks')).n, subtasks: (await db.get('SELECT COUNT(*) n FROM subtasks')).n, comments: (await db.get('SELECT COUNT(*) n FROM comments')).n }));
const time = async (label: string, url: string) => { const t0 = performance.now(); const r = await app.inject({ method: 'GET', url: '/api/v1' + url, headers: { ...H, cookie: ck } }); const ms = Math.round(performance.now() - t0); console.log(`${String(ms).padStart(5)} ms  ${r.statusCode}  ${label}`); return ms; };
const today = day(0); const slow: string[] = [];
for (const [l, u] of [['tasks list (first page)', '/tasks?limit=50'], ['tasks sorted by person', '/tasks?sort=person&limit=50'], ['tasks, deep page', '/tasks?sort=due&limit=50&cursor=5000'], ['task search "GST"', '/tasks?q=GST&limit=50'],
  ['Command Centre dashboard', `/dashboard?today=${today}`], ['My Attention', `/attention?today=${today}`], ['Message Center', `/messages?today=${today}`], ['Calendar (6 weeks)', `/calendar?from=${day(-10)}&to=${day(30)}`],
  ['Performance (40 people)', `/people/performance?today=${today}`], ['Global search', '/search?q=notice'], ['Review table', `/reviews/management?today=${today}`], ['Weekly review', `/reviews/weekly?today=${today}`]] as const) {
  const ms = await time(l, u); if (ms > 1500) slow.push(l);
}
console.log(slow.length ? `SLOW (>1.5s): ${slow.join(', ')}` : 'All endpoints under 1.5 s with 10,000 tasks / 50,000 subtasks.');
await app.close();
