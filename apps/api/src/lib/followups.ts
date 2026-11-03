import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { insertRow } from './crud.ts';

/** tasks.next_followup_date is a cache of the earliest still-pending follow-up (the scoring and "Follow Up Now" read it). */
export async function syncFollowupCache(d: Db, taskId: string) {
  const r = await d.get<any>('SELECT MIN(substr(due_at, 1, 10)) AS d FROM followups WHERE task_id = ? AND done_at IS NULL AND archived_at IS NULL', [taskId]);
  await d.run('UPDATE tasks SET next_followup_date = ? WHERE id = ?', [r?.d ?? null, taskId]);
}

/** Someone set the task's "next follow-up" date directly (task form, snooze, import): keep the follow-up items in step. */
export async function reconcileFollowupDate(d: Db, userId: string, task: { id: string; companyId: string; nextAction?: string | null }, date: string | null) {
  const pending = await d.all<any>('SELECT id FROM followups WHERE task_id = ? AND done_at IS NULL AND archived_at IS NULL ORDER BY substr(due_at, 1, 10), created_at', [task.id]);
  const now = nowIso();
  if (!date) for (const f of pending) await d.run('UPDATE followups SET archived_at = ?, updated_at = ?, updated_by_id = ? WHERE id = ?', [now, now, userId, f.id]);
  else if (pending.length) await d.run('UPDATE followups SET due_at = ?, updated_at = ?, updated_by_id = ? WHERE id = ?', [date, now, userId, pending[0].id]);
  else await insertRow(d, 'followups', { taskId: task.id, companyId: task.companyId, type: 'OTHER', dueAt: date, notes: task.nextAction ?? null }, userId);
  await syncFollowupCache(d, task.id);
}
