// Deletable demo dataset. Every row is flagged is_demo = 1; "clear" archives (never hard-deletes) and "load" restores.
import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { insertRow } from './crud.ts';
import { audit } from './audit.ts';

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

export async function demoStatus(db: Db) {
  const r = await db.get<any>('SELECT COUNT(*) n, SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) active FROM companies WHERE is_demo = 1');
  return { exists: r!.n > 0, active: (r!.active ?? 0) > 0 };
}

export async function loadDemo(db: Db, adminId: string): Promise<{ action: 'created' | 'restored' | 'none' }> {
  const st = await demoStatus(db);
  if (st.active) return { action: 'none' };
  if (st.exists) {
    const t = nowIso();
    for (const tbl of ['companies', 'projects', 'people', 'tasks']) await db.run(`UPDATE ${tbl} SET archived_at = NULL, updated_at = ?, updated_by_id = ? WHERE is_demo = 1`, [t, adminId]);
    await db.run(`UPDATE subtasks SET archived_at = NULL WHERE task_id IN (SELECT id FROM tasks WHERE is_demo = 1)`);
    await audit(db, { entityType: 'DEMO', entityId: 'demo', action: 'DEMO_RESTORED', userId: adminId });
    return { action: 'restored' };
  }
  return db.tx(async (t) => {
    const FLAGGED = new Set(['companies', 'projects', 'people', 'tasks']); // only these tables carry is_demo
    const mk = (tbl: string, d: any) => insertRow(t, tbl, FLAGGED.has(tbl) ? { ...d, isDemo: true } : d, adminId);
    const co: Record<string, string> = {};
    for (const [code, name, short] of [['SMSB', 'SMS Biosystems Pvt Ltd', 'SMS Bio'], ['SMSV', 'SMS Vetcare Technologies Pvt Ltd', 'SMS Vetcare'],
      ['SAGE', 'Sagenome Pvt Ltd', 'Sagenome'], ['GRMS', 'GRMS', 'GRMS']]) co[code] = await mk('companies', { code, name, shortName: short, active: true });
    const pr: Record<string, string> = {};
    for (const [key, company, name] of [['gst', 'SMSB', 'GST Compliance'], ['bank', 'SMSB', 'Banking'], ['sw', 'SMSV', 'Software Development'],
      ['hr', 'SAGE', 'HR'], ['stat', 'GRMS', 'Statutory Compliance'], ['form', 'GRMS', 'Company Formation']])
      pr[key] = await mk('projects', { companyId: co[company], name, ownerId: adminId, priority: 2, status: 'ACTIVE', startDate: day(-60), targetDate: day(120) });
    const pe: Record<string, string> = {};
    for (const [key, company, name, designation, department] of [
      ['anil', 'SMSB', 'Anil Kumar', 'Senior Accountant', 'Finance'], ['divya', 'SMSB', 'Divya Raj', 'Finance Executive', 'Finance'],
      ['arjun', 'SMSV', 'Arjun Das', 'Full-stack Developer', 'Engineering'], ['priya', 'SAGE', 'Priya Nair', 'HR Manager', 'HR'],
      ['fathima', 'GRMS', 'Fathima Beevi', 'Admin Executive', 'Admin'], ['joseph', 'GRMS', 'Joseph Mathew', 'Company Secretary', 'Compliance'],
      ['ca', null, 'Suresh Menon', 'Chartered Accountant (external)', 'Advisors'], ['bank', null, 'Bank Relationship Manager', 'Branch contact', 'Banking'],
    ] as const) pe[key] = await mk('people', { companyId: company ? co[company] : null, name, designation, department, active: true });

    const task = async (company: string, project: string | null, title: string, extra: any = {}) =>
      mk('tasks', { companyId: co[company], projectId: project ? pr[project] : null, title, ownerId: adminId, priority: 3, status: 'TODO', lastActivityAt: nowIso(), ...extra });
    const sub = (taskId: string, company: string, title: string, status = 'TODO', position = 0, dueDate: string | null = null) =>
      mk('subtasks', { taskId, companyId: co[company], title, status, position, progress: status === 'DONE' ? 100 : 0, dueDate, priority: 3, ...(status === 'DONE' ? { completedAt: nowIso() } : {}) });
    const note = (taskId: string, company: string, body: string) => mk('comments', { entityType: 'TASK', entityId: taskId, companyId: co[company], body, authorId: adminId });

    const gstr3b = await task('SMSB', 'gst', 'File GSTR-3B for last month', { priority: 1, status: 'DELEGATED', delegatedToId: pe.anil, delegatedAt: nowIso(), dueDate: day(-3), postponeCount: 1, nextAction: 'Confirm ITC figures with Anil', nextFollowupDate: day(0) });
    await note(gstr3b, 'SMSB', 'Anil says the purchase register is still being matched. Needs ITC figures before filing.');
    const recon = await task('SMSB', 'gst', 'Reconcile GSTR-2B with purchase books', { priority: 2, status: 'DOING', delegatedToId: pe.divya, delegatedAt: nowIso(), dueDate: day(2) });
    await sub(recon, 'SMSB', 'Download GSTR-2B', 'DONE', 0); await sub(recon, 'SMSB', 'Match vendor invoices', 'DOING', 1); await sub(recon, 'SMSB', 'List mismatches for vendors', 'TODO', 2);
    const collateral = await task('SMSB', 'bank', 'Release of collateral security', { priority: 1, status: 'WAITING', waitingFor: 'Bank Relationship Manager', waitingExpectedDate: day(-1), dueDate: day(5), nextAction: 'Call the branch for the release letter', nextFollowupDate: day(0) });
    await note(collateral, 'SMSB', 'Written request submitted to the branch. Awaiting no-dues confirmation.');
    await task('SMSB', 'bank', 'Submit renewal documents for the working-capital facility', { priority: 2, dueDate: day(9), dependsOnId: collateral });
    const rel = await task('SMSV', 'sw', 'Release booking app v1.2', { priority: 2, status: 'DOING', dueDate: day(6), delegatedToId: pe.arjun, delegatedAt: nowIso() });
    await sub(rel, 'SMSV', 'Freeze scope', 'DONE', 0); await sub(rel, 'SMSV', 'Regression test', 'DOING', 1); await sub(rel, 'SMSV', 'Publish release notes', 'TODO', 2);
    await task('SMSV', 'sw', 'Fix invoice PDF rendering bug', { priority: 1, dueDate: day(0), nextAction: 'Reproduce with the long-address invoice' });
    await task('SAGE', 'hr', 'Onboard new lab technician', { priority: 2, status: 'DOING', delegatedToId: pe.priya, delegatedAt: nowIso(), dueDate: day(-1) });
    await task('SAGE', 'hr', 'Quarterly performance reviews', { priority: 3, dueDate: day(14) });
    await task('SAGE', 'hr', 'Update leave policy', { priority: 4, dueDate: day(20) });
    await task('GRMS', 'stat', 'File annual return with the Registrar', { priority: 1, dueDate: day(12), delegatedToId: pe.joseph, delegatedAt: nowIso(), status: 'DELEGATED' });
    await task('GRMS', 'stat', 'Pay monthly TDS', { priority: 2, dueDate: day(1) });
    await task('GRMS', 'form', 'Name approval for new LLP', { priority: 3, status: 'WAITING', waitingFor: 'Registrar of Companies', waitingExpectedDate: day(3), dueDate: day(8) });
    const agr = await task('GRMS', 'form', 'Draft partnership agreement', { priority: 2, dueDate: day(16) });
    await sub(agr, 'GRMS', 'Collect partner details', 'DONE', 0); await sub(agr, 'GRMS', 'First draft', 'TODO', 1); await sub(agr, 'GRMS', 'Review with advisor', 'TODO', 2);
    await task('GRMS', 'stat', 'Renew trade licence', { priority: 3, status: 'DONE', dueDate: day(-7), completedAt: new Date(Date.now() - 864e5).toISOString(), completedById: adminId, completionNote: 'Renewed for the year.' });
    await task('SMSB', 'gst', 'File previous GST return', { priority: 2, status: 'DONE', dueDate: day(-25), completedAt: new Date(Date.now() - 20 * 864e5).toISOString(), completedById: adminId });
    await task('SMSB', null, 'Update fixed asset register', { priority: 4 });
    await audit(t, { entityType: 'DEMO', entityId: 'demo', action: 'DEMO_LOADED', userId: adminId });
    return { action: 'created' as const };
  });
}

export async function clearDemo(db: Db, adminId: string) {
  const t = nowIso();
  await db.tx(async (d) => {
    await d.run(`UPDATE subtasks SET archived_at = ? WHERE archived_at IS NULL AND task_id IN (SELECT id FROM tasks WHERE is_demo = 1)`, [t]);
    await d.run(`UPDATE comments SET archived_at = ? WHERE archived_at IS NULL AND entity_type = 'TASK' AND entity_id IN (SELECT id FROM tasks WHERE is_demo = 1)`, [t]);
    for (const tbl of ['tasks', 'projects', 'people', 'companies'])
      await d.run(`UPDATE ${tbl} SET archived_at = ?, updated_at = ?, updated_by_id = ? WHERE is_demo = 1 AND archived_at IS NULL`, [t, t, adminId]);
    await audit(d, { entityType: 'DEMO', entityId: 'demo', action: 'DEMO_CLEARED', userId: adminId });
  });
}
