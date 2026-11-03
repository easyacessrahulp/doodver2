import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './helpers.ts';

const xmlOf = (buf: Buffer) => { const d = mkdtempSync(join(tmpdir(), 'nb-')); const f = join(d, 'a.docx'); writeFileSync(f, buf); return execFileSync('unzip', ['-p', f, 'word/document.xml', 'word/footer1.xml']).toString(); };

test('notes: the Word file carries a coloured company banner; the company and colour can be chosen; only companies you may see', async () => {
  const { call, raw, A, B, project } = await setup();
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'T', priority: 3, status: 'TODO' })).body;
  const n = (await call('admin', 'POST', '/notes', { taskId: t.id, title: 'Plan note', body: '- one\n- two' })).body;
  // raw export: header is the note's own company by default, and can be switched
  let x = xmlOf((await raw('admin', 'GET', `/notes/${n.id}/export.docx?format=raw`)).rawPayload);
  assert.match(x, /ALPHA LTD/); assert.match(x, /w:fill="/); assert.match(x, /Page /);
  x = xmlOf((await raw('admin', 'GET', `/notes/${n.id}/export.docx?format=raw&companyId=${B.id}&color=crimson`)).rawPayload);
  assert.match(x, /BETA LTD/); assert.match(x, /9F1239/); assert.doesNotMatch(x, /ALPHA LTD/);
  // proper note stores the chosen header company with the draft
  const g = (await call('admin', 'POST', `/notes/${n.id}/draft/generate`, { mode: 'plain', headerCompanyId: B.id, headerColor: 'teal', today: '2026-04-03' })).body;
  assert.equal(g.draft.headerCompanyId, B.id);
  await call('admin', 'PUT', `/notes/${n.id}/draft`, { draft: g.draft });
  x = xmlOf((await raw('admin', 'GET', `/notes/${n.id}/export.docx`)).rawPayload);
  assert.match(x, /BETA LTD/); assert.match(x, /0F766E/); assert.match(x, /SUB: /);
  // a member of A only cannot put company B in the header
  assert.equal((await raw('USER', 'GET', `/notes/${n.id}/export.docx?format=raw&companyId=${B.id}`)).statusCode, 404);
  assert.equal((await raw('USER', 'GET', `/notes/${n.id}/export.docx?format=raw`)).statusCode, 200);
});
