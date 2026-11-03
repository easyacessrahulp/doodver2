// In-app notifications + a tiny live-update hub (Server-Sent Events). No email, no external push — works on a plain LAN.
import { EventEmitter } from 'node:events';
import type { Db } from './db.ts';
import { newId, nowIso } from './db.ts';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Tell connected browsers of these users that something changed (the page then re-fetches). Delayed a moment so the database commit is done. */
export function ping(userIds: (string | null | undefined)[], type: string, data: Record<string, unknown> = {}) {
  const ids = [...new Set(userIds.filter(Boolean) as string[])];
  setTimeout(() => { for (const id of ids) bus.emit(`u:${id}`, { type, ...data }); }, 60);
}

export interface NotifyInput { userId: string; kind: string; title: string; body?: string | null; companyId?: string | null; taskId?: string | null; link?: string | null; actorId?: string | null; groupKey?: string | null }

export async function notify(db: Db, n: NotifyInput) {
  if (n.actorId && n.actorId === n.userId) return null;          // never notify people about their own actions
  if (n.groupKey && await db.get('SELECT 1 FROM notifications WHERE user_id = ? AND group_key = ?', [n.userId, n.groupKey])) return null;   // once per event
  const id = newId();
  await db.run('INSERT INTO notifications (id,user_id,company_id,task_id,kind,title,body,group_key,channel,link,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, n.userId, n.companyId ?? null, n.taskId ?? null, n.kind, n.title.slice(0, 200), n.body?.slice(0, 500) ?? null, n.groupKey ?? null, 'IN_APP', n.link ?? null, n.actorId ?? null, nowIso()]);
  ping([n.userId], 'notification');
  return id;
}
