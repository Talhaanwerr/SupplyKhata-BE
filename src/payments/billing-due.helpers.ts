/**
 * Pure cycle-aware billing due date helpers (unit-testable).
 *
 * WEEKLY: every 7 days from billingAnchorDate
 * FORTNIGHTLY: every 14 days from billingAnchorDate
 * MONTHLY / CUSTOM: day-of-month billingDueDate (1–31, clamped to month length)
 * CASH_ON_DELIVERY: no scheduled due (returns null)
 */

export type BillingCycle = 'CASH_ON_DELIVERY' | 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY' | 'CUSTOM';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function clampDay(year: number, month: number, day: number): number {
  const last = new Date(year, month + 1, 0).getDate();
  return Math.min(day, last);
}

function addDays(d: Date, days: number): Date {
  const result = startOfDay(d);
  result.setDate(result.getDate() + days);
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
  const y = t.getFullYear();
  const m = t.getMonth();
  const dueThisMonth = startOfDay(new Date(y, m, clampDay(y, m, billingDueDate)));
  if (t.getTime() <= dueThisMonth.getTime()) return dueThisMonth;
  const next = new Date(y, m + 1, 1);
  return startOfDay(
    new Date(
      next.getFullYear(),
      next.getMonth(),
      clampDay(next.getFullYear(), next.getMonth(), billingDueDate),
    ),
  );
}

function lastMonthlyDue(today: Date, billingDueDate: number): Date {
  const t = startOfDay(today);
  const y = t.getFullYear();
  const m = t.getMonth();
  const dueThisMonth = startOfDay(new Date(y, m, clampDay(y, m, billingDueDate)));
  if (t.getTime() >= dueThisMonth.getTime()) return dueThisMonth;
  const prev = new Date(y, m - 1, 1);
  return startOfDay(
    new Date(
      prev.getFullYear(),
      prev.getMonth(),
      clampDay(prev.getFullYear(), prev.getMonth(), billingDueDate),
    ),
  );
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

/** True when two dates fall on the same calendar day (local). */
export function sameCalendarDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}
