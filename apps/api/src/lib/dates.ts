// Calendar-date helpers. Dates are 'YYYY-MM-DD' strings treated as calendar days (no time zone shifts).
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const addDays = (d: string, n: number) => new Date(utc(d) + n * 864e5).toISOString().slice(0, 10);
export const diffDays = (from: string, to: string) => Math.round((utc(to) - utc(from)) / 864e5);
export const serverToday = () => new Date().toISOString().slice(0, 10);
/** Add months, clamping to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: string, n: number) {
  const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1, day = +d.slice(8, 10);
  const t = new Date(Date.UTC(y, m + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}
export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export const step = (d: string, f: Frequency, n: number) =>
  f === 'DAILY' ? addDays(d, n) : f === 'WEEKLY' ? addDays(d, 7 * n) : f === 'MONTHLY' ? addMonths(d, n) : f === 'QUARTERLY' ? addMonths(d, 3 * n) : addMonths(d, 12 * n);
/** Next occurrence strictly after both the previous due date and the day it was completed. */
export function nextDue(prevDue: string | null, f: Frequency, n: number, completedOn: string) {
  let d = prevDue ?? completedOn; const floor = prevDue && prevDue > completedOn ? prevDue : completedOn;
  for (let i = 0; i < 1000; i++) { d = step(d, f, n); if (d > floor) return d; }
  return d;
}
