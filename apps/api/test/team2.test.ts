import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup } from './helpers.ts';
import { tick, dailyBackup } from '../src/lib/scheduler.ts';

const opened: any[] = []; after(() => opened.forEach((m) => m.close()));
async function mock(reply: object) {
  const requests: any[] = [];
  const srv = createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { requests.push(JSON.parse(raw || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const h = { requests, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v1`, close: () => { srv.closeAllConnections(); srv.close(); } }; opened.push(h); return h;
}
async function team(ai?: any) {
  const t = await setup(ai ? { ai } : {}); const { call, A, PW } = t;
  const mk = async (loginId: string, name: string, role = 'MEMBER') => {
    const u = (await call('admin', 'POST', '/users', { name, loginId, password: PW, mustChangePassword: false, companies: [{ companyId: A.id, role }] })).body;
    await call(loginId, 'POST', '/auth/login', { loginId, password: PW }); return u;
  };
  return { ...t, ravi: await mk('ravi', 'Ravi'), sita: await mk('sita', 'Sita'), maya: await mk('maya', 'Maya') };
}

test('chat: one-to-one is private; groups; unread counts; task thread follows task visibility; actions become tasks', async () => {
  const { call, A, ravi, sita, maya } = await team();
  const room = (await call('ravi', 'POST', '/chat/direct', { userId: sita.id })).body;
  assert.equal((await call('sita', 'POST', '/chat/direct', { userId: ravi.id })).body.id, room.id, 'same room both ways');
  assert.equal((await call('ravi', 'POST', `/chat/rooms/${room.id}/messages`, { body: 'Hello Sita' })).status, 201);
  assert.equal((await call('maya', 'GET', `/chat/rooms/${room.id}/messages`)).status, 404, 'a third person cannot read it');
  assert.equal((await call('admin', 'GET', `/chat/rooms/${room.id}/messages`)).status, 404, 'not even the owner reads private chats');
  const rooms = (await call('sita', 'GET', '/chat/rooms')).body; assert.equal(rooms.unread, 1); assert.equal(rooms.items[0].title, 'Ravi');
  assert.equal((await call('sita', 'GET', '/notifications/count')).body.chat, 1);
  await call('sita', 'POST', `/chat/rooms/${room.id}/read`); assert.equal((await call('sita', 'GET', '/chat/rooms')).body.unread, 0);
  const g = (await call('ravi', 'POST', '/chat/groups', { name: 'Trademark team', memberIds: [sita.id] })).body;
  assert.equal((await call('maya', 'GET', `/chat/rooms/${g.id}/messages`)).status, 404);
  await call('ravi', 'POST', `/chat/rooms/${g.id}/members`, { memberIds: [maya.id] });
  assert.equal((await call('maya', 'GET', `/chat/rooms/${g.id}/messages`)).status, 200);
  // task thread: only people who can see the task
  const t = (await call('ravi', 'POST', '/tasks', { companyId: A.id, title: 'Private job' })).body;
  const tr = (await call('ravi', 'POST', `/chat/task/${t.id}`)).body;
  assert.equal((await call('sita', 'POST', `/chat/task/${t.id}`)).status, 404);
  await call('ravi', 'PATCH', `/tasks/${t.id}`, { delegatedToId: sita.personId, expectedUpdatedAt: t.updatedAt });
  assert.equal((await call('sita', 'GET', `/chat/rooms/${tr.id}/messages`)).status, 200);
  // an action marked in a chat becomes a real task for the chosen person
  const act = await call('ravi', 'POST', `/chat/rooms/${g.id}/messages`, { body: 'Send the SIVA logo file', kind: 'ACTION', task: { companyId: A.id, personId: maya.personId, dueDate: '2026-11-01' } });
  assert.equal(act.status, 201); assert.ok(act.body.refTaskId);
  assert.equal((await call('maya', 'GET', `/tasks/${act.body.refTaskId}`)).body.title, 'Send the SIVA logo file');
  assert.ok((await call('maya', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'ASSIGNED'));
});

test('chat meetings: invite selected people, calendar, RSVP, live room, decisions/actions, minutes, reminders', async () => {
  const { call, A, ravi, sita, maya, app } = await team();
  const start = new Date(Date.now() + 5 * 60e3).toISOString();
  const m = (await call('ravi', 'POST', '/meetings', { title: 'Call X and Y', agenda: 'Price list', startAt: start, participantIds: [sita.id] })).body;
  assert.equal(m.participants.length, 2); assert.equal(m.status, 'SCHEDULED');
  assert.equal((await call('maya', 'GET', `/meetings/${m.id}`)).status, 404, 'uninvited people cannot see it');
  assert.ok((await call('sita', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'MEETING_INVITE'));
  const day = new Date(start).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const cal = (await call('sita', 'GET', `/calendar?from=${day}&to=${day}`)).body.items;
  assert.ok(cal.some((i: any) => i.kind === 'meeting' && i.title === 'Call X and Y'), 'on the calendar');
  assert.ok(!(await call('maya', 'GET', `/calendar?from=${day}&to=${day}`)).body.items.some((i: any) => i.kind === 'meeting'));
  assert.equal((await call('sita', 'POST', `/meetings/${m.id}/rsvp`, { rsvp: 'YES' })).body.participants.find((p: any) => p.name === 'Sita').rsvp, 'YES');
  assert.ok((await call('ravi', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'MEETING_RSVP'));
  // reminder 10 minutes before (once)
  assert.equal((await tick(app)).reminded, 1); assert.equal((await tick(app)).reminded, 0);
  assert.ok((await call('sita', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'MEETING_SOON'));
  assert.equal((await call('sita', 'POST', `/meetings/${m.id}/start`)).status, 403, 'only the organiser opens it');
  assert.equal((await call('ravi', 'POST', `/meetings/${m.id}/start`)).body.status, 'LIVE');
  assert.ok((await call('sita', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'MEETING_LIVE'));
  await call('sita', 'POST', `/meetings/${m.id}/join`);
  const room = m.roomId;
  await call('ravi', 'POST', `/chat/rooms/${room}/messages`, { body: 'Shall we raise the price by 5%?' });
  await call('sita', 'POST', `/chat/rooms/${room}/messages`, { body: 'Agreed, from 1 December', kind: 'DECISION' });
  await call('sita', 'POST', `/chat/rooms/${room}/messages`, { body: 'Update the price list', kind: 'ACTION', task: { companyId: A.id } });
  const end = (await call('ravi', 'POST', `/meetings/${m.id}/end`)).body;
  assert.equal(end.status, 'ENDED'); assert.equal(end.minutes.writtenBy, 'plain'); assert.deepEqual(end.minutes.decisions, ['Agreed, from 1 December']);
  assert.match(end.minutes.actions[0], /Update the price list/); assert.deepEqual(end.minutes.attendees, ['Ravi', 'Sita']);
  assert.ok((await call('sita', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'MEETING_MINUTES'));
  assert.equal((await call('ravi', 'POST', `/chat/rooms/${room}/messages`, { body: 'late' })).status, 201, 'chat stays open as a record');
  void maya;
});

test('meeting minutes: AI writes them from the conversation when it is on', async () => {
  const mk = await mock({ summary: 'They agreed a 5% rise.', decisions: ['Raise price 5% from 1 Dec'], actions: ['Sita updates the price list'] });
  const { call, ravi, sita } = await team({ apiKey: 'sk-test', model: 'gpt-4o-mini', baseUrl: mk.baseUrl, timeoutMs: 3000, dailyLimit: 50 });
  const m = (await call('ravi', 'POST', '/meetings', { title: 'Pricing', startAt: new Date(Date.now() + 3600e3).toISOString(), participantIds: [sita.id] })).body;
  await call('ravi', 'POST', `/meetings/${m.id}/start`);
  await call('ravi', 'POST', `/chat/rooms/${m.roomId}/messages`, { body: 'Raise price by 5%?' }); await call('sita', 'POST', `/chat/rooms/${m.roomId}/messages`, { body: 'Yes from 1 Dec' });
  const end = (await call('ravi', 'POST', `/meetings/${m.id}/end`)).body;
  assert.equal(end.minutes.writtenBy, 'ai'); assert.equal(end.minutes.summary, 'They agreed a 5% rise.');
  assert.match(JSON.stringify(mk.requests[0].messages), /Raise price by 5%/); void ravi;
});

test('announcements: audience, must-acknowledge, seen-by, reminders, scheduling, who may post', async () => {
  const { call, A, ravi, sita, maya, app } = await team();
  assert.equal((await call('ravi', 'POST', '/announcements', { title: 'x', body: 'y', audience: 'ALL' })).status, 403, 'a member cannot announce to everyone');
  const a = (await call('admin', 'POST', '/announcements', { title: 'Office closed Friday', body: 'Diwali holiday', priority: 'IMPORTANT', audience: 'ALL', requiresAck: true, pinned: true })).body;
  const sel = (await call('admin', 'POST', '/announcements', { title: 'Only Ravi and Sita', body: 'Price review at 4', audience: 'SELECTED', userIds: [ravi.id, sita.id] })).body;
  const ofMaya = (await call('maya', 'GET', '/announcements')).body; assert.deepEqual(ofMaya.items.map((x: any) => x.title), ['Office closed Friday']); assert.equal(ofMaya.needsAck, 1);
  assert.equal((await call('ravi', 'GET', '/announcements')).body.items.length, 2);
  assert.ok((await call('ravi', 'GET', '/notifications')).body.items.some((n: any) => /Office closed/.test(n.title)));
  assert.equal((await call('maya', 'POST', `/announcements/${sel.id}/seen`)).status, 404);
  await call('ravi', 'POST', `/announcements/${a.id}/seen`); await call('sita', 'POST', `/announcements/${a.id}/ack`);
  const readers = (await call('admin', 'GET', `/announcements/${a.id}/readers`)).body.items;
  assert.equal(readers.find((r: any) => r.name === 'Sita').ackAt !== null, true); assert.equal(readers.find((r: any) => r.name === 'Maya').seenAt, null);
  assert.equal((await call('ravi', 'GET', `/announcements/${a.id}/readers`)).status, 403);
  const stats = (await call('admin', 'GET', '/announcements')).body.items.find((x: any) => x.id === a.id).stats; assert.equal(stats.acknowledged, 1); assert.equal(stats.seen, 2);
  const rem = (await call('admin', 'POST', `/announcements/${a.id}/remind`)).body; assert.equal(rem.reminded, 6, 'everyone except the sender and Sita (who already acknowledged)');
  // a Manager may announce to their own company only
  await call('admin', 'POST', '/users', { name: 'Mgr', loginId: 'mgr', password: 'correct-horse-battery', mustChangePassword: false, companies: [{ companyId: A.id, role: 'MANAGER' }] });
  await call('mgr', 'POST', '/auth/login', { loginId: 'mgr', password: 'correct-horse-battery' });
  assert.equal((await call('mgr', 'POST', '/announcements', { title: 'Alpha news', body: 'b', audience: 'COMPANY', companyId: A.id })).status, 201);
  assert.equal((await call('mgr', 'POST', '/announcements', { title: 'All', body: 'b', audience: 'ALL' })).status, 403);
  // timed announcement is invisible and silent until its time
  const future = new Date(Date.now() + 3600e3).toISOString();
  const t = (await call('admin', 'POST', '/announcements', { title: 'Tomorrow news', body: 'b', audience: 'ALL', publishAt: future })).body;
  assert.ok(!(await call('maya', 'GET', '/announcements')).body.items.some((x: any) => x.id === t.id));
  assert.equal(await tick(app, new Date(Date.now() + 2 * 3600e3)).then((r) => r.announced), 1);
  assert.ok((await call('maya', 'GET', '/notifications')).body.items.some((n: any) => /Tomorrow news/.test(n.title)));
  // expiry hides it
  await call('admin', 'PATCH', `/announcements/${a.id}`, { expectedUpdatedAt: (await call('admin', 'GET', '/announcements')).body.items.find((x: any) => x.id === a.id).updatedAt, expiresAt: '2020-01-01T00:00:00Z' });
  assert.ok(!(await call('maya', 'GET', '/announcements')).body.items.some((x: any) => x.id === a.id));
});

test('announcement wording help: AI polishes / translates, plain error when AI is off', async () => {
  const off = await team(); const offR = await off.call('admin', 'POST', '/announcements/polish', { body: 'office closed fri' }); assert.ok(offR.status >= 400 && offR.status !== 500 && offR.body.error.message, 'a clear message, not a crash');
  const mk = await mock({ title: 'Office closed on Friday', body: 'Please note the office will be closed on Friday.' });
  const on = await team({ apiKey: 'sk-test', model: 'gpt-4o-mini', baseUrl: mk.baseUrl, timeoutMs: 3000, dailyLimit: 50 });
  const r = await on.call('admin', 'POST', '/announcements/polish', { body: 'office closed fri', mode: 'polish' });
  assert.equal(r.status, 200); assert.match(r.body.body, /closed on Friday/);
});

test('feed: posts, comments, reactions; finished work shows only to people who can see the task; announcements appear', async () => {
  const { call, A, ravi, sita } = await team();
  const p = (await call('ravi', 'POST', '/feed/posts', { body: 'Good morning team' })).body;
  await call('sita', 'POST', `/feed/posts/${p.id}/comments`, { body: 'Morning!' });
  assert.ok((await call('ravi', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'COMMENT'));
  assert.equal((await call('sita', 'PUT', '/reactions', { entityType: 'POST', entityId: p.id, emoji: '👍' })).status, 200);
  const t = (await call('ravi', 'POST', '/tasks', { companyId: A.id, title: 'Finished thing', dueDate: '2099-01-01' })).body;
  await call('ravi', 'POST', `/tasks/${t.id}/complete`, { note: 'done' });
  const fr = (await call('ravi', 'GET', '/feed')).body.items; const post = fr.find((i: any) => i.id === p.id);
  assert.equal(post.comments, 1); assert.equal(post.reactions[0].n, 1);
  assert.ok(fr.some((i: any) => i.type === 'COMPLETED' && i.title === 'Finished thing' && i.onTime));
  assert.ok(!(await call('sita', 'GET', '/feed')).body.items.some((i: any) => i.type === 'COMPLETED'), 'Sita cannot see Ravi’s private task, so no card either');
  assert.equal((await call('sita', 'PUT', '/reactions', { entityType: 'TASK', entityId: t.id, emoji: '🎉' })).status, 404);
  await call('admin', 'POST', '/announcements', { title: 'Hello all', body: 'b', audience: 'ALL' });
  assert.ok((await call('sita', 'GET', '/feed')).body.items.some((i: any) => i.type === 'ANNOUNCEMENT'));
  assert.equal((await call('sita', 'POST', `/feed/posts/${p.id}/archive`)).status, 403); void sita;
});

test('completion: owner is told; congratulation + facts; self-review saved (AI feedback when on, never for AI-excluded tasks)', async () => {
  const mk = await mock({ feedback: 'Well done finishing a day early. Next time start the supplier call sooner.' });
  const { call, A, ravi, sita } = await team({ apiKey: 'sk-test', model: 'gpt-4o-mini', baseUrl: mk.baseUrl, timeoutMs: 3000, dailyLimit: 50 });
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Renew licence', dueDate: '2099-01-10', delegatedToId: sita.personId })).body;
  assert.equal((await call('ravi', 'GET', `/tasks/${t.id}/review-prompt`)).status, 404);
  const done = await call('sita', 'POST', `/tasks/${t.id}/complete`, { note: 'filed' }); assert.equal(done.status, 200);
  assert.ok((await call('admin', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'COMPLETED' && /Sita completed/.test(n.title)));
  const pr = (await call('sita', 'GET', `/tasks/${t.id}/review-prompt`)).body;
  assert.match(pr.cheer, /Sita/); assert.match(pr.facts, /ahead of the due date/); assert.equal(pr.questions.length, 3); assert.equal(pr.aiAvailable, true);
  const rv = await call('sita', 'POST', `/tasks/${t.id}/review`, { rating: 4, wentWell: 'Called early', challenges: 'Form was unclear', nextTime: 'Ask the clerk first' });
  assert.equal(rv.status, 201); assert.match(rv.body.aiFeedback, /Well done/); assert.match(JSON.stringify(mk.requests[0].messages), /Called early/);
  assert.ok((await call('admin', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'REVIEW'));
  assert.equal((await call('admin', 'GET', `/tasks/${t.id}/reviews`)).body.items.length, 1);
  // excluded from AI: review is saved, AI is not called
  const t2 = (await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'Private matter', aiExcluded: true, delegatedToId: sita.personId })).body;
  const before = mk.requests.length;
  const r2 = await call('sita', 'POST', `/tasks/${t2.id}/review`, { rating: 5, wentWell: 'ok' }); assert.equal(r2.status, 201); assert.equal(r2.body.aiFeedback, null); assert.equal(mk.requests.length, before); void ravi;
});

test('boards: default lists, custom lists, cards in the right list, moving between and within lists, scoped for members', async () => {
  const { call, A, project, ravi, sita } = await team();
  const mine = (await call('ravi', 'POST', '/tasks', { companyId: A.id, title: 'Ravi card', status: 'DOING' })).body;
  await call('sita', 'POST', '/tasks', { companyId: A.id, title: 'Sita card' });
  await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'Project card A' });
  await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'Project card B' });
  const b = (await call('ravi', 'GET', `/boards?companyId=${A.id}`)).body;
  assert.deepEqual(b.lists.map((l: any) => l.name), ['Backlog', 'To do', 'In progress', 'Waiting', 'Delegated', 'Done']);
  assert.deepEqual(b.lists.find((l: any) => l.name === 'In progress').cards.map((c: any) => c.title), ['Ravi card']);
  assert.ok(!JSON.stringify(b).includes('Sita card'), 'a member’s board only has their cards');
  const custom = (await call('ravi', 'POST', '/boards/lists', { companyId: A.id, name: 'Needs approval' })).body;
  const mv = await call('ravi', 'POST', '/boards/move', { taskId: mine.id, listId: custom.id }); assert.equal(mv.status, 200);
  assert.deepEqual((await call('ravi', 'GET', `/boards?companyId=${A.id}`)).body.lists.find((l: any) => l.id === custom.id).cards.map((c: any) => c.title), ['Ravi card']);
  assert.equal((await call('sita', 'POST', '/boards/move', { taskId: mine.id, listId: custom.id })).status, 404, 'cannot move someone else’s card');
  // project board: reorder within a list
  const pb = (await call('admin', 'GET', `/boards?companyId=${A.id}&projectId=${project.id}`)).body; const todo = pb.lists.find((l: any) => l.name === 'To do');
  assert.deepEqual(todo.cards.map((c: any) => c.title).sort(), ['Project card A', 'Project card B']);
  const [a, bb] = todo.cards; await call('admin', 'POST', '/boards/move', { taskId: bb.id, listId: todo.id, beforeTaskId: a.id });
  assert.equal((await call('admin', 'GET', `/boards?companyId=${A.id}&projectId=${project.id}`)).body.lists.find((l: any) => l.name === 'To do').cards[0].id, bb.id);
  assert.equal((await call('admin', 'POST', '/boards/move', { taskId: mine.id, listId: todo.id })).status, 400, 'list of another board refused');
  // last list cannot be removed
  assert.equal((await call('admin', 'POST', `/boards/lists/${custom.id}/archive`)).status, 200);
  assert.ok(!(await call('ravi', 'GET', `/boards?companyId=${A.id}`)).body.lists.some((l: any) => l.id === custom.id)); void sita;
});

test('adoption: owner sees usage per person (counts only), exports it, can nudge; members cannot', async () => {
  const { call, A, ravi, sita, maya } = await team();
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, title: 'For Ravi', delegatedToId: ravi.personId, dueDate: '2020-01-01' })).body; void t;
  await call('ravi', 'POST', '/tasks', { companyId: A.id, title: 'Mine' });
  const r = await call('admin', 'GET', '/admin/adoption?days=30'); assert.equal(r.status, 200);
  const row = (n: string) => r.body.items.find((i: any) => i.name === n);
  assert.equal(row('Ravi').tasksCreated, 1); assert.equal(row('Ravi').overdueNow, 1); assert.equal(row('Ravi').status, 'ACTIVE'); assert.equal(row('Ravi').unopenedAssignments, 0);
  assert.ok(r.body.summary.people >= 4);
  assert.equal((await call('ravi', 'GET', '/admin/adoption')).status, 403);
  assert.equal((await call('ravi', 'GET', '/admin/logins')).status, 403);
  assert.ok((await call('admin', 'GET', '/admin/logins')).body.items.length >= 3);
  assert.equal((await call('admin', 'POST', '/admin/adoption/nudge', { userId: maya.id, message: 'Please update' })).status, 200);
  assert.ok((await call('maya', 'GET', '/notifications')).body.items.some((n: any) => n.kind === 'NUDGE'));
  void sita;
});

test('daily safety copy is written once per day; new tables survive backup → restore', async () => {
  const { call, raw, A, ravi } = await team();
  await call('ravi', 'POST', '/feed/posts', { body: 'hello' });
  const m = (await call('ravi', 'POST', '/meetings', { title: 'M', startAt: new Date(Date.now() + 3600e3).toISOString(), participantIds: [(await call('admin', 'GET', '/team')).body.items.find((x: any) => x.name === 'Sita').id] })).body; void m;
  await call('admin', 'POST', '/announcements', { title: 'A', body: 'b', audience: 'ALL' });
  const bk = await raw('admin', 'GET', '/backup'); assert.equal(bk.statusCode, 200);
  const JSZip = (await import('jszip')).default; const z = await JSZip.loadAsync(bk.rawPayload);
  for (const f of ['meetings', 'chat_rooms', 'chat_messages', 'announcements', 'feed_posts', 'task_participants', 'board_lists', 'login_history']) assert.ok(z.file(`data/${f}.csv`), f + ' in backup');
  void A; void ravi;
});
