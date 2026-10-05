/**
 * Calendar-date helpers for delivery schedule cadence (date-only).
 * Stored/compared as UTC midnight of the Y-M-D so host TZ does not shift the day.
 */

import {
  parseCalendarDateUtc,
  startOfTodayInTimeZoneUtc,
  DEFAULT_TENANT_TZ,
} from './calendar-utc.helper';

export function parseCalendarDate(value: string): Date {
  const parsed = parseCalendarDateUtc(value, false);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parsed;
}

/** Normalize any Date to UTC midnight of its UTC calendar day. */
export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Add whole calendar days to a date-only value (UTC calendar). */
export function addDays(d: Date, days: number): Date {
  const copy = startOfDay(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export function todayStart(timeZone: string = DEFAULT_TENANT_TZ): Date {
  return startOfTodayInTimeZoneUtc(timeZone);
}
