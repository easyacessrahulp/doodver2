import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('subtask follow-ups are tied to the subtask; People workload lists each person’s pending tasks and subtasks, scoped', async () => {
  const { call, A, project } = await setup();
  const asha = (await call('admin', 'POST', '/people', { name: 'Asha', companyId: A.id })).body;
  const t = (await call('admin', 'POST', '/tasks', { companyId: A.id, projectId: project.id, title: 'Big job', priority: 2, status: 'TODO', delegatedToId: asha.id, dueDate: '2020-01-01' })).body;
  const s1 = (await call('admin', 'POST', `/tasks/${t.id}/subtasks`, { title: 'Part for Asha', assigneeId: asha.id, dueDate: '2020-01-02' })).body;
  const fu = await call('admin', 'POST', '/followups', { taskId: t.id, subtaskId: s1.id, type: 'PHONE', personId: asha.id, dueDate: '2030-01-01', note: 'chase part' });
  assert.equal(fu.status, 201); assert.equal(fu.body.subtaskId, s1.id); assert.equal(fu.body.subtaskTitle, 'Part for Asha');
  assert.equal((await call('admin', 'GET', `/followups?subtaskId=${s1.id}`)).body.items.length, 1);
  assert.equal((await call('admin', 'POST', '/followups', { taskId: t.id, subtaskId: 'nope', type: 'PHONE', dueDate: '2030-01-01' })).status, 400);
  const w = (await call('admin', 'GET', '/workload')).body; const row = w.items.find((i: any) => i.personId === asha.id);
  assert.equal(row.openTasks, 1); assert.equal(row.openSubtasks, 1); assert.equal(row.followups, 1); assert.ok(row.overdue >= 2);
  // done items drop out
  await call('admin', 'PATCH', `/subtasks/${s1.id}`, { expectedUpdatedAt: s1.updatedAt, status: 'DONE' });
  assert.equal((await call('admin', 'GET', '/workload')).body.items.find((i: any) => i.personId === asha.id).openSubtasks, 0);
  // someone with no access to the company sees nothing
  assert.equal((await call('outsider', 'GET', '/workload')).body.items.length, 0);
});
