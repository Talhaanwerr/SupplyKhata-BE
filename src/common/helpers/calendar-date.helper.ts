/** Calendar-date helpers for delivery schedule cadence (date-only, local midnight). */

export function parseCalendarDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return startOfDay(parsed);
}

export function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function endOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

/** Add whole calendar days to a date-only value. */
export function addDays(d: Date, days: number): Date {
  const copy = startOfDay(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function todayStart(): Date {
  return startOfDay(new Date());
}
