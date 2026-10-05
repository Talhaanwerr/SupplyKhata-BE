/**
 * Pure cycle-aware billing due date helpers (unit-testable).
 *
 * Uses UTC calendar days so host process timezone does not shift due dates.
 * Callers should pass `today` already normalized to the tenant's business day
 * (UTC midnight of that Y-M-D).
 *
 * WEEKLY: every 7 days from billingAnchorDate
 * FORTNIGHTLY: every 14 days from billingAnchorDate
 * MONTHLY / CUSTOM: day-of-month billingDueDate (1–31, clamped to month length)
 * CASH_ON_DELIVERY: no scheduled due (returns null)
 */

export type BillingCycle = 'CASH_ON_DELIVERY' | 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY' | 'CUSTOM';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function clampDay(year: number, month: number, day: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(day, last);
}

function addDays(d: Date, days: number): Date {
  const result = startOfDay(d);
  result.setUTCDate(result.getUTCDate() + days);
  return startOfDay(result);
}

function daysBetweenDates(from: Date, to: Date): number {
  return Math.floor((startOfDay(to).getTime() - startOfDay(from).getTime()) / MS_PER_DAY);
}

/** Next due on/after today from an interval anchor (WEEKLY / FORTNIGHTLY). */
function nextDueFromAnchor(today: Date, anchor: Date, intervalDays: number): Date {
  const t = startOfDay(today);
  const a = startOfDay(anchor);
  if (t.getTime() <= a.getTime()) return a;
  const diff = daysBetweenDates(a, t);
  const rem = diff % intervalDays;
  if (rem === 0) return t;
  return addDays(t, intervalDays - rem);
}

/** Most recent due on/before today from an interval anchor. */
function lastDueFromAnchor(today: Date, anchor: Date, intervalDays: number): Date | null {
  const t = startOfDay(today);
  const a = startOfDay(anchor);
  if (t.getTime() < a.getTime()) return null;
  const diff = daysBetweenDates(a, t);
  const rem = diff % intervalDays;
  if (rem === 0) return t;
  return addDays(t, -rem);
}

function nextMonthlyDue(today: Date, billingDueDate: number): Date {
  const t = startOfDay(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const dueThisMonth = startOfDay(new Date(Date.UTC(y, m, clampDay(y, m, billingDueDate))));
  if (t.getTime() <= dueThisMonth.getTime()) return dueThisMonth;
  const nextY = m === 11 ? y + 1 : y;
  const nextM = m === 11 ? 0 : m + 1;
  return startOfDay(new Date(Date.UTC(nextY, nextM, clampDay(nextY, nextM, billingDueDate))));
}

function lastMonthlyDue(today: Date, billingDueDate: number): Date {
  const t = startOfDay(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const dueThisMonth = startOfDay(new Date(Date.UTC(y, m, clampDay(y, m, billingDueDate))));
  if (t.getTime() >= dueThisMonth.getTime()) return dueThisMonth;
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 11 : m - 1;
  return startOfDay(new Date(Date.UTC(prevY, prevM, clampDay(prevY, prevM, billingDueDate))));
}

/**
 * Next scheduled due date on or after `today`, or null if no schedule (COD / missing fields).
 */
export function nextDueDate(
  cycle: BillingCycle | string,
  today: Date,
  billingDueDate?: number | null,
  billingAnchorDate?: Date | null,
): Date | null {
  switch (cycle) {
    case 'CASH_ON_DELIVERY':
      return null;
    case 'WEEKLY':
      if (!billingAnchorDate) return null;
      return nextDueFromAnchor(today, billingAnchorDate, 7);
    case 'FORTNIGHTLY':
      if (!billingAnchorDate) return null;
      return nextDueFromAnchor(today, billingAnchorDate, 14);
    case 'MONTHLY':
    case 'CUSTOM':
      if (billingDueDate == null) return null;
      return nextMonthlyDue(today, billingDueDate);
    default:
      return null;
  }
}

/**
 * Most recent scheduled due date on or before `today`, or null if none yet / no schedule.
 */
export function lastDueDate(
  cycle: BillingCycle | string,
  today: Date,
  billingDueDate?: number | null,
  billingAnchorDate?: Date | null,
): Date | null {
  switch (cycle) {
    case 'CASH_ON_DELIVERY':
      return null;
    case 'WEEKLY':
      if (!billingAnchorDate) return null;
      return lastDueFromAnchor(today, billingAnchorDate, 7);
    case 'FORTNIGHTLY':
      if (!billingAnchorDate) return null;
      return lastDueFromAnchor(today, billingAnchorDate, 14);
    case 'MONTHLY':
    case 'CUSTOM':
      if (billingDueDate == null) return null;
      return lastMonthlyDue(today, billingDueDate);
    default:
      return null;
  }
}

/** True when two dates fall on the same UTC calendar day. */
export function sameCalendarDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}
