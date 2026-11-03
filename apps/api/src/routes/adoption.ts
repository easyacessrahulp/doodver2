import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { HttpError, notFound } from '../lib/errors.ts';
import { notify } from '../lib/notify.ts';
import { serverToday, addDays } from '../lib/dates.ts';
import { DOCX_MIME } from '../lib/word.ts';

/** For the owner: who is really using DOOD, and who is not. Counts only — never the content of private chats. */
export default async function adoptionRoutes(app: FastifyInstance) {
  const { db } = app;
  const adminOnly = (req: any) => { if (!req.user!.isAdmin) throw new HttpError(403, 'FORBIDDEN', 'Owner only'); };

  async function compute(days: number, today: string) {
    const since = new Date(Date.now() - days * 864e5).toISOString(); const sinceDay = since.slice(0, 10);
    const users = await db.all<any>(`SELECT u.id, u.name, u.login_id, u.email, u.is_admin, u.person_id, u.active, u.last_login_at, u.login_count, u.created_at, p.designation FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.archived_at IS NULL ORDER BY u.name`);
    const n = async (sql: string, p: any[]) => ((await db.get<any>(sql, p)) as any)?.n ?? 0;
    const rows = [];
    for (const u of users) {
      const pid = u.personId ?? '';
      const activeDays = await n(`SELECT COUNT(DISTINCT d) n FROM (SELECT substr(at,1,10) d FROM login_history WHERE user_id = ? AND ok = 1 AND kind = 'LOGIN' AND at >= ? UNION SELECT substr(created_at,1,10) FROM activity_log WHERE user_id = ? AND created_at >= ?)`, [u.id, since, u.id, since]);
      const completed = await db.all<any>(`SELECT due_date, completed_at FROM tasks WHERE completed_by_id = ? AND status = 'DONE' AND completed_at >= ?`, [u.id, since]);
      const onTime = completed.filter((t) => !t.dueDate || t.completedAt.slice(0, 10) <= t.dueDate).length;
      const unopened = await n(`SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'ASSIGNED' AND read_at IS NULL AND created_at < ?`, [u.id, new Date(Date.now() - 864e5).toISOString()]);
      const lastDays = u.lastLoginAt ? Math.floor((Date.parse(today) - Date.parse(u.lastLoginAt.slice(0, 10))) / 864e5) : null;
      rows.push({
        userId: u.id, name: u.name, loginId: u.loginId ?? u.email, designation: u.designation, isAdmin: !!u.isAdmin, active: !!u.active, lastLoginAt: u.lastLoginAt, daysSinceLogin: lastDays, loginCount: u.loginCount, activeDays, windowDays: days,
        status: !u.active ? 'DISABLED' : lastDays === null ? 'NEVER' : lastDays <= 2 ? 'ACTIVE' : lastDays <= 7 ? 'SLOW' : 'INACTIVE',
        tasksCreated: await n(`SELECT COUNT(*) n FROM tasks WHERE created_by_id = ? AND created_at >= ? AND archived_at IS NULL`, [u.id, since]),
        tasksCompleted: completed.length, onTimePct: completed.length ? Math.round((onTime / completed.length) * 100) : null,
        overdueNow: await n(`SELECT COUNT(*) n FROM tasks WHERE archived_at IS NULL AND status <> 'DONE' AND due_date < ? AND (owner_id = ? OR delegated_to_id = ?)`, [today, u.id, pid]),
        openNow: await n(`SELECT COUNT(*) n FROM tasks WHERE archived_at IS NULL AND status <> 'DONE' AND (owner_id = ? OR delegated_to_id = ?)`, [u.id, pid]),
        unopenedAssignments: unopened,
        callsDone: await n(`SELECT COUNT(*) n FROM calls WHERE done_at >= ? AND updated_by_id = ?`, [since, u.id]),
        followupsDone: await n(`SELECT COUNT(*) n FROM followups WHERE done_at >= ? AND updated_by_id = ?`, [since, u.id]),
        notesWritten: await n(`SELECT COUNT(*) n FROM notes WHERE created_by_id = ? AND created_at >= ?`, [u.id, since]),
        focusMinutes: await n(`SELECT COALESCE(SUM(actual_minutes),0) n FROM focus_sessions WHERE user_id = ? AND started_at >= ? AND ended_at IS NOT NULL`, [u.id, since]),
        messagesSent: await n(`SELECT COUNT(*) n FROM chat_messages WHERE author_id = ? AND created_at >= ? AND kind <> 'SYSTEM'`, [u.id, since]),
        meetingsJoined: await n(`SELECT COUNT(*) n FROM meeting_participants WHERE user_id = ? AND joined_at >= ?`, [u.id, since]),
        announcementsPendingAck: await n(`SELECT COUNT(*) n FROM announcements a WHERE a.archived_at IS NULL AND a.requires_ack = 1 AND (a.publish_at IS NULL OR a.publish_at <= ?) AND (a.expires_at IS NULL OR a.expires_at > ?)
          AND (a.audience = 'ALL' OR (a.audience = 'COMPANY' AND a.company_id IN (SELECT company_id FROM company_memberships WHERE user_id = ? AND archived_at IS NULL))
               OR (a.audience = 'SELECTED' AND EXISTS (SELECT 1 FROM announcement_targets t WHERE t.announcement_id = a.id AND t.user_id = ?)))
          AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ? AND r.ack_at IS NOT NULL)`, [since, since, u.id, u.id, u.id]),
        aiUses: await n(`SELECT COUNT(*) n FROM ai_usage WHERE user_id = ? AND day >= ? AND kind <> 'test'`, [u.id, sinceDay]),
      });
    }
    return rows;
  }

  app.get('/admin/adoption', async (req) => {
    adminOnly(req); const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    const today = q.today ?? serverToday(); const items = await compute(q.days, today);
    const team = items.filter((i) => i.active);
    const summary = { people: team.length, activeToday: team.filter((i) => i.daysSinceLogin === 0).length, active: team.filter((i) => i.status === 'ACTIVE').length,
      notUsing: team.filter((i) => i.status === 'INACTIVE' || i.status === 'NEVER').length, overdue: team.reduce((a, i) => a + i.overdueNow, 0), unopened: team.reduce((a, i) => a + i.unopenedAssignments, 0), completed: team.reduce((a, i) => a + i.tasksCompleted, 0) };
    const daily = await db.all<any>(`SELECT substr(at,1,10) day, COUNT(DISTINCT user_id) users FROM login_history WHERE ok = 1 AND kind = 'LOGIN' AND at >= ? GROUP BY substr(at,1,10) ORDER BY day`, [addDays(today, -q.days) + 'T00:00:00.000Z']);
    return { today, days: q.days, summary, items, daily };
  });

  app.get('/admin/logins', async (req) => {
    adminOnly(req); const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return { items: await db.all(`SELECT h.*, u.name AS user_name, a.name AS actor_name FROM login_history h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN users a ON a.id = h.actor_id ORDER BY h.at DESC LIMIT ?`, [q.limit]) };
  });

  app.post('/admin/adoption/nudge', async (req) => {
    adminOnly(req); const b = z.object({ userId: z.string(), message: z.string().trim().max(300).optional() }).parse(req.body);
    if (!(await db.get('SELECT 1 FROM users WHERE id = ? AND active = 1', [b.userId]))) throw notFound();
    await notify(db, { userId: b.userId, kind: 'NUDGE', title: `${req.user!.name} is waiting for your update`, body: b.message ?? 'Please open DOOD and update your pending jobs.', link: 'home', actorId: req.user!.id });
    return { ok: true };
  });

  app.get('/admin/adoption/export.xlsx', async (req, reply) => {
    adminOnly(req); const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const items = await compute(q.days, serverToday());
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Usage');
    const cols: [string, string][] = [['name', 'Name'], ['loginId', 'User ID'], ['status', 'Status'], ['lastLoginAt', 'Last login'], ['loginCount', 'Logins (all time)'], ['activeDays', `Active days (last ${q.days})`], ['tasksCreated', 'Tasks created'],
      ['tasksCompleted', 'Tasks completed'], ['onTimePct', 'On-time %'], ['openNow', 'Open now'], ['overdueNow', 'Overdue now'], ['unopenedAssignments', 'Unopened assignments'], ['callsDone', 'Calls/mails done'], ['followupsDone', 'Follow-ups done'],
      ['notesWritten', 'Notes'], ['focusMinutes', 'Focus minutes'], ['messagesSent', 'Messages'], ['meetingsJoined', 'Meetings joined'], ['announcementsPendingAck', 'Announcements not acknowledged'], ['aiUses', 'AI uses']];
    ws.columns = cols.map(([key, header]) => ({ key, header, width: Math.max(12, header.length + 2) }));
    ws.getRow(1).font = { bold: true }; for (const i of items) ws.addRow(i); ws.views = [{ state: 'frozen', ySplit: 1 }];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="dood-usage-${serverToday()}.xlsx"`).send(buf);
  });
  void DOCX_MIME;
}
