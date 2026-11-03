import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { insertRow } from './crud.ts';

/** Writes the outcome of a call/mail/discussion into the notes (comments) of the task — or of the subtask it was about. */
export async function addFeedbackComment(db: Db, o: { companyId: string; taskId: string; subtaskId?: string | null; userId: string; body: string }) {
  await insertRow(db, 'comments', { companyId: o.companyId, entityType: o.subtaskId ? 'SUBTASK' : 'TASK', entityId: o.subtaskId ?? o.taskId, body: o.body.slice(0, 5000), authorId: o.userId }, o.userId);
  await db.run('UPDATE tasks SET last_activity_at = ? WHERE id = ?', [nowIso(), o.taskId]);
}

export const CHANNELS = { CALL: { icon: '📞', label: 'Call', to: 'with' }, EMAIL: { icon: '✉️', label: 'Email', to: 'to' }, WHATSAPP: { icon: '💬', label: 'WhatsApp', to: 'with' } } as const;
export type Channel = keyof typeof CHANNELS;
