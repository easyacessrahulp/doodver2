// Faithful port of an() from the prototype (the live, second definition): same weights, same reasons, same risk/status rules.
import { diffDays } from './dates.ts';

export interface Thresholds { soon: number; stale: number; esc: number }
export interface Reason { tone: 'red' | 'yellow' | 'amber'; text: string }
export interface Analysis { score: number; reasons: Reason[]; overdueDays: number; staleDays: number; followUpDue: boolean; risk: boolean; status: 'r' | 'a' | 'y' | ''; daysToDue: number }
export interface TaskFacts {
  priority: number; dueDate: string | null; lastActivityAt: string; nextFollowupDate: string | null; waitingFor: string | null; status: string;
  delegatedToId: string | null; delegatedToName: string | null; postponeCount: number; blockedByTitle: string | null; blocking: boolean;
}

export function analyse(t: TaskFacts, today: string, th: Thresholds): Analysis {
  const R: Reason[] = []; let s = 0;
  const od = t.dueDate ? diffDays(t.dueDate, today) : -999;                    // days past due (negative = days left)
  const stale = diffDays(t.lastActivityAt.slice(0, 10), today);
  const fu = !!t.nextFollowupDate && t.nextFollowupDate <= today;
  const ds = t.dueDate ? -od : 999;                                            // days until due
  const dl = !!t.delegatedToId; const wait = t.waitingFor || (t.status === 'WAITING' ? 'a response' : '');
  if (od > 0) { s += 50 + od * 3; R.push({ tone: 'red', text: `${od} day${od > 1 ? 's' : ''} overdue` }); }
  else if (od === 0) { s += 30; R.push({ tone: 'yellow', text: 'Due today' }); }
  else if (ds <= th.soon) { s += 18; R.push({ tone: 'yellow', text: `Due in ${ds} day${ds > 1 ? 's' : ''}` }); }
  s += [0, 25, 15, 6, 0][t.priority] ?? 0;
  if (t.priority === 1) R.push({ tone: 'red', text: 'Critical priority' });
  if (od >= th.esc) { s += 15; R.push({ tone: 'red', text: `Escalation: ${od} days overdue` }); }
  if (fu) { s += 25; R.push({ tone: 'yellow', text: t.nextFollowupDate! < today ? 'Follow-up overdue' : 'Follow-up due today' }); }
  if (wait) { R.push({ tone: 'yellow', text: 'Waiting for ' + wait }); s += 6; }
  if (dl && stale >= th.stale) { s += 12; R.push({ tone: 'amber', text: `Delegated to ${t.delegatedToName}, no update for ${stale} days` }); }
  else if (stale >= th.stale && ds <= 7) { s += 10; R.push({ tone: 'amber', text: `No update for ${stale} days` }); }
  if (t.postponeCount > 0) { s += t.postponeCount * 4; R.push({ tone: 'amber', text: `Postponed ${t.postponeCount}×` }); }
  if (t.blockedByTitle) { s += 4; R.push({ tone: 'amber', text: 'Blocked by: ' + t.blockedByTitle }); }
  if (t.blocking) { s += 10; R.push({ tone: 'yellow', text: 'Blocking another task' }); }
  const risk = (od <= 0 && ds <= th.soon && stale >= th.stale) || (dl && stale >= th.stale) || t.postponeCount >= 2 || !!t.blockedByTitle;
  const status = od > 0 ? 'r' : risk ? 'a' : (ds <= th.soon || fu) ? 'y' : '';
  return { score: s, reasons: R, overdueDays: od > 0 ? od : 0, staleDays: stale, followUpDue: fu, risk, status, daysToDue: ds };
}
