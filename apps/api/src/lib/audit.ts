import type { Db } from './db.ts';
import { newId, nowIso } from './db.ts';

export async function audit(db: Db, e: { companyId?: string | null; entityType: string; entityId: string; action: string; detail?: unknown; auto?: boolean; userId?: string | null }) {
  await db.run(
    `INSERT INTO activity_log (id, company_id, entity_type, entity_id, action, detail, auto, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [newId(), e.companyId ?? null, e.entityType, e.entityId, e.action,
     e.detail === undefined ? null : typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail),
     e.auto ? 1 : 0, e.userId ?? null, nowIso()]);
}
