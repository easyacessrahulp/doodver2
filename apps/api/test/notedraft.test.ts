import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup } from './helpers.ts';

const opened: any[] = []; after(() => opened.forEach((m) => m.close()));
async function mock(reply: object) {
  const requests: any[] = [];
  const srv = createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { requests.push(JSON.parse(raw || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const h = { requests, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } }; opened.push(h); return h;
}
const GOOD = { subject: 'Trademark for Siva Medical Services', salutation: 'Dear Sir,', points: [{ text: 'As discussed on 03.04.2026, we need a trademark for two items.', sub: ['Word mark for “SIVA MEDICAL SERVICES”', 'Device mark for the “SMS” logo'] }, { text: 'Estimated cost is Rs. 14767/-.', sub: [] }], closing: 'For approval', signerTitle: 'Finance Manager', date: '3.4.2026' };

test('proper note: AI drafts in the formal format, nothing saved until asked, Word export uses the saved draft', async () => {
  const m = await mock(GOOD); const { call, raw, A, project } = await setup({ ai: { apiKey: 'sk-test', model: 'gpt-4o-mini', baseUrl: m.baseUrl, timeoutMs: 3000, dailyLimit: 50 } });
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'Trademark', priority: 3, status: 'TODO' })).body;
  const n = (await call('admin', 'POST', '/notes', { taskId: t.id, title: 'Trademark note', body: '- discussed 03.04.2026\n- word mark SIVA MEDICAL SERVICES\n- device mark SMS logo\n- cost Rs 14767' })).body;
  assert.equal((await raw('admin', 'GET', `/notes/${n.id}/export.docx?format=proper`)).statusCode, 400, 'no draft yet');
  const g = (await call('admin', 'POST', `/notes/${n.id}/draft/generate`, { signerTitle: 'Finance Manager', today: '2026-04-03' })).body;
  assert.equal(g.aiUsed, true); assert.equal(g.draft.points.length, 2); assert.equal(g.draft.points[0].sub.length, 2);
  assert.match(JSON.stringify(m.requests[0].messages), /word mark SIVA MEDICAL SERVICES/); assert.match(JSON.stringify(m.requests[0].messages), /Finance Manager/);
  assert.equal((await call('admin', 'GET', `/notes/${n.id}`)).body.draft, null, 'generate does not save');
  const saved = (await call('admin', 'PUT', `/notes/${n.id}/draft`, { draft: g.draft })).body; assert.equal(saved.version, 1);
  assert.equal((await call('admin', 'GET', `/notes/${n.id}`)).body.draft.signerTitle, 'Finance Manager');
  const doc = await raw('admin', 'GET', `/notes/${n.id}/export.docx`); assert.equal(doc.statusCode, 200); assert.equal(doc.rawPayload.subarray(0, 2).toString(), 'PK');
  const JSZip = (await import('jszip')).default; const xml = await (await JSZip.loadAsync(doc.rawPayload)).file('word/document.xml')!.async('string');
  assert.match(xml, /SUB: TRADEMARK FOR SIVA MEDICAL SERVICES/); assert.match(xml, /Dear Sir,/); assert.match(xml, /For approval/); assert.match(xml, /Finance Manager/); assert.match(xml, /w:ilvl w:val="1"/);
  // task switched off for AI → refused, nothing sent
  await call('admin', 'PATCH', `/tasks/${t.id}`, { expectedUpdatedAt: (await call('admin', 'GET', `/tasks/${t.id}`)).body.updatedAt, aiExcluded: true });
  const before = m.requests.length; const ex = await call('admin', 'POST', `/notes/${n.id}/draft/generate`, {}); assert.equal(ex.status, 403); assert.equal(m.requests.length, before);
  assert.equal((await call('VIEWER', 'POST', `/notes/${n.id}/draft/generate`, {})).status, 403);
});

test('proper note: without AI the points are laid out in the same format (plain)', async () => {
  const { call, A, project } = await setup();
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'T', priority: 3, status: 'TODO' })).body;
  const n = (await call('admin', 'POST', '/notes', { taskId: t.id, title: 'Plain note', body: 'first point\n  - detail a\n  - detail b\nsecond point' })).body;
  const g = (await call('admin', 'POST', `/notes/${n.id}/draft/generate`, { today: '2026-04-03' })).body;
  assert.equal(g.aiUsed, false); assert.deepEqual(g.draft.points, [{ text: 'first point', sub: ['detail a', 'detail b'] }, { text: 'second point', sub: [] }]); assert.equal(g.draft.date, '3.4.2026'); assert.match(g.notice, /AI is not set up/);
});
