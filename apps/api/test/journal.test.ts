import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup } from './helpers.ts';

const opened: { close: () => void }[] = []; after(() => opened.forEach((m) => m.close()));
async function mock(replies: object[]) {
  const requests: any[] = []; let i = 0;
  const srv = createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { const rb = JSON.parse(raw || '{}'); requests.push(rb);
    if (!/json/i.test(JSON.stringify(rb.messages))) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: "'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'." } })); return; } const r = replies[Math.min(i++, replies.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(r) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port;
  const h = { requests, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } }; opened.push(h); return h;
}

test('notebooks: default books, standalone note with company tag, versions, private AI switch', async () => {
  const m = await mock([{ title: 'Call with CA', body: 'The CA confirmed the ITC mismatch.' }, { title: 'Handwritten note', text: '- call CA\n- send letter' }]);
  const w = await setup({ ai: { apiKey: 'sk-test-KEY-1', model: 'gpt-4o-mini', baseUrl: m.baseUrl, timeoutMs: 3000, dailyLimit: 50 } });
  const { call, A } = w;
  const nb = (await call('admin', 'GET', '/notebooks')).body;
  assert.deepEqual(nb.items.map((b: any) => b.name), ['Daily journal', 'Meetings', 'Ideas', 'Loose notes']);
  const n = (await call('admin', 'POST', '/journal', { title: 'GST review', body: 'call CA\n- [ ] ask reconciliation', notebookId: nb.items[0].id, companyId: A.id })).body;
  assert.equal(n.companyName, A.name); assert.equal(n.taskId, null);
  const list = (await call('admin', 'GET', '/journal?companyId=' + A.id)).body.items; assert.equal(list.length, 1); assert.match(list[0].snippet, /call CA/);
  const p = await call('admin', 'PATCH', `/journal/${n.id}`, { expectedUpdatedAt: n.updatedAt, body: 'call CA\n- [x] ask reconciliation' });
  assert.equal(p.status, 200);
  const g = (await call('admin', 'GET', `/journal/${n.id}`)).body; assert.equal(g.versions.length, 1, 'quick edits within 10 minutes share a version');
  const stale = await call('admin', 'PATCH', `/journal/${n.id}`, { expectedUpdatedAt: n.updatedAt, title: 'x' }); assert.equal(stale.status, 409);
  const w1 = await call('admin', 'POST', '/journal/ai/writeup', { points: 'call CA itc mismatch', kind: 'Meeting note', language: 'en', companyId: A.id, noteId: n.id });
  assert.equal(w1.status, 200); assert.equal(w1.body.title, 'Call with CA');
  const n0 = (await call('admin', 'GET', `/journal/${n.id}`)).body; assert.match(n0.body, /x\] ask/, 'AI never changes the note by itself');
  await call('admin', 'PATCH', `/journal/${n.id}`, { expectedUpdatedAt: n0.updatedAt, aiExcluded: true });
  const before = m.requests.length;
  assert.equal((await call('admin', 'POST', '/journal/ai/writeup', { points: 'secret', noteId: n.id })).status, 403);
  assert.equal((await call('admin', 'POST', '/journal/ai/writeup', { points: 'secret', private: true })).status, 403);
  assert.equal(m.requests.length, before, 'private notes never reach OpenAI');
  const h = await call('admin', 'POST', '/journal/ai/handwriting', { mimeType: 'image/jpeg', dataBase64: Buffer.from('fakejpegbytes-fakejpegbytes').toString('base64') });
  assert.equal(h.status, 200); assert.match(h.body.text, /call CA/);
  assert.equal(m.requests.at(-1).messages[1].content[1].type, 'image_url');
  assert.equal((await call('USER', 'GET', `/journal/${n.id}`)).status, 404, 'notes are private to their author');
  assert.equal((await call('USER', 'GET', '/journal')).body.items.length, 0);
  const off = await setup(); assert.equal((await off.call('admin', 'POST', '/journal/ai/writeup', { points: 'hello there' })).status, 503);
  assert.equal((await call('admin', 'POST', '/journal', { title: 'x', companyId: 'nope' })).status >= 400, true);
});

test('notes: attach files, AI reads them (PDF, Word, text) on request, private notes and private tasks are blocked', async () => {
  const m = await mock([{ title: 'From the letter', body: 'The notice asks for the end-use letter [notice.pdf].' }]);
  const w = await setup({ ai: { apiKey: 'sk-test-KEY-2', model: 'gpt-4o-mini', baseUrl: m.baseUrl, timeoutMs: 3000, dailyLimit: 50 } });
  const { call, A, project } = w;
  const n = (await call('admin', 'POST', '/journal', { title: 'Customs', body: 'points' })).body;
  const pdf = (await call('admin', 'POST', `/journal/${n.id}/files`, { fileName: 'notice.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 test').toString('base64') })).body;
  assert.equal((await call('admin', 'GET', `/journal/${n.id}`)).body.files.length, 1);
  const JSZip = (await import('jszip')).default; const z = new JSZip(); z.file('word/document.xml', '<w:document><w:p><w:r><w:t>Penalty of Rs 5000 applies</w:t></w:r></w:p></w:document>');
  const docx = (await z.generateAsync({ type: 'nodebuffer' })).toString('base64');
  const r = await call('admin', 'POST', '/journal/ai/writeup', { points: '', instruction: 'Summarise what the notice asks', noteId: n.id, fileIds: [pdf.id], files: [{ fileName: 'terms.docx', mimeType: 'application/octet-stream', dataBase64: docx }, { fileName: 'a.csv', mimeType: 'text/csv', dataBase64: Buffer.from('item,qty\nreagent,4').toString('base64') }] });
  assert.equal(r.status, 200); assert.deepEqual(r.body.filesRead, ['notice.pdf', 'terms.docx', 'a.csv']);
  const content = m.requests[0].messages[1].content; assert.equal(content[1].type, 'file');
  assert.match(content[0].text, /Penalty of Rs 5000/); assert.match(content[0].text, /reagent \| ?|reagent,4/); assert.match(content[0].text, /Summarise what the notice asks/);
  assert.equal((await call('admin', 'POST', '/journal/ai/writeup', { points: 'x y z', files: [{ fileName: 'a.exe', mimeType: 'application/x-msdownload', dataBase64: 'AAAAAAAA' }] })).status, 400);
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'Secret task', priority: 3, status: 'TODO', aiExcluded: true })).body;
  const before = m.requests.length;
  assert.equal((await call('admin', 'POST', '/journal/ai/writeup', { points: 'some points', taskId: t.id })).status, 403);
  await call('admin', 'PATCH', `/journal/${n.id}`, { expectedUpdatedAt: (await call('admin', 'GET', `/journal/${n.id}`)).body.updatedAt, aiExcluded: true });
  assert.equal((await call('admin', 'POST', '/journal/ai/writeup', { points: '', noteId: n.id, fileIds: [pdf.id] })).status, 403);
  assert.equal(m.requests.length, before, 'nothing private reaches OpenAI');
  assert.equal((await call('USER', 'POST', `/journal/${n.id}/files`, { fileName: 'x.txt', dataBase64: 'aGk=' })).status, 404);
});
