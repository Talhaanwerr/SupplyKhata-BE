/**
 * Calendar-day helpers that do NOT depend on the Node process timezone.
 *
 * Convention for date-only business fields (cost effectiveFrom, billDate, etc.):
 * - Store as UTC midnight of that Y-M-D: Date.UTC(y, m-1, d, 0, 0, 0, 0)
 * - Resolve "as of day D" with end of that UTC calendar day (23:59:59.999Z)
 * - "Today" for a tenant uses tenant.timezone via Intl (falls back to Asia/Karachi)
 *
 * For real timestamps (createdAt, statusEvents.at), use start/endOfZonedDayUtc
 * so the inclusive day matches the tenant's wall clock.
 */

const DEFAULT_TENANT_TZ = 'Asia/Karachi';

export function parseCalendarDateUtc(value: string, endOfDay = false): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    const parsed = new Date(value);
    return parsed;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return endOfDay
    ? new Date(Date.UTC(year, month, day, 23, 59, 59, 999))
    : new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

export function formatCalendarDateUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Normalize any Date to UTC midnight of its UTC calendar day. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/** Normalize any Date to UTC end of its UTC calendar day. */
export function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Today's calendar Y-M-D in an IANA timezone (e.g. Asia/Karachi). */
export function todayYmdInTimeZone(timeZone: string = DEFAULT_TENANT_TZ, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || DEFAULT_TENANT_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TENANT_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }
}

/** End of "today" in the given timezone, as a UTC Date (for lte cost lookups). */
export function endOfTodayInTimeZoneUtc(
  timeZone: string = DEFAULT_TENANT_TZ,
  now = new Date(),
): Date {
  return parseCalendarDateUtc(todayYmdInTimeZone(timeZone, now), true);
}

/** Start of "today" in the given timezone, as UTC midnight of that calendar day. */
export function startOfTodayInTimeZoneUtc(
  timeZone: string = DEFAULT_TENANT_TZ,
  now = new Date(),
): Date {
  return parseCalendarDateUtc(todayYmdInTimeZone(timeZone, now), false);
}

/**
 * Offset of `timeZone` at `date`: localWallAsUtc - actualUtc.
 * Positive for zones ahead of UTC (e.g. Asia/Karachi ≈ +5h).
 */
export function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const tz = timeZone || DEFAULT_TENANT_TZ;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TENANT_TZ,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return asIfUtc - date.getTime();
}

/** Instant when Y-M-D hh:mm:ss.ms occurs on the wall clock in `timeZone`. */
export function zonedWallTimeToUtc(
  ymd: string,
  timeZone: string,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) {
    throw new Error(`Invalid date: ${ymd}`);
  }
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  const tz = timeZone || DEFAULT_TENANT_TZ;
  // Iterate once to correct for DST / offset at the target local time.
  let utc = Date.UTC(y, m, d, hour, minute, second, ms);
  for (let i = 0; i < 2; i++) {
    const offset = getTimeZoneOffsetMs(new Date(utc), tz);
    utc = Date.UTC(y, m, d, hour, minute, second, ms) - offset;
  }
  return new Date(utc);
}

/** Start of calendar day in tenant TZ as an absolute UTC instant (for timestamp ranges). */
export function startOfZonedDayUtc(ymd: string, timeZone: string = DEFAULT_TENANT_TZ): Date {
  return zonedWallTimeToUtc(ymd, timeZone, 0, 0, 0, 0);
}

/** End of calendar day in tenant TZ as an absolute UTC instant (for timestamp ranges). */
export function endOfZonedDayUtc(ymd: string, timeZone: string = DEFAULT_TENANT_TZ): Date {
  return zonedWallTimeToUtc(ymd, timeZone, 23, 59, 59, 999);
}

export { DEFAULT_TENANT_TZ };
