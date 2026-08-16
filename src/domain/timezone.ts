/**
 * Timezone conversion built on the platform's IANA database via
 * `Intl.DateTimeFormat`. Pure, no I/O, no date library.
 *
 * Using the tz database directly means daylight saving is correct by
 * construction — including the two cases that break naive implementations:
 *   - the spring-forward gap, where a wall-clock time does not exist
 *   - the autumn-back overlap, where a wall-clock time happens twice
 *
 * All instants are UTC. Wall-clock values are always paired with a zone.
 */

export const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
] as const;

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string | null | undefined): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** The local wall-clock reading of a UTC instant in a given zone. */
export function toWallClock(instant: Date, timeZone: string): WallClock {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    // h23 can emit "24" for midnight on some engines; fold it back to 0.
    hour: Number(lookup.hour) % 24,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: WEEKDAY_TO_ISO[lookup.weekday ?? 'Mon'] ?? 1,
  };
}

/** Zone offset, in milliseconds, in effect at a given instant. East of UTC is positive. */
export function getOffsetMs(instant: Date, timeZone: string): number {
  const wall = toWallClock(instant, timeZone);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Round to the second: the formatter drops milliseconds.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a local wall-clock time in a zone to a UTC instant.
 *
 * Two passes: guess using the offset at the naive instant, then re-check with
 * the offset actually in effect at the guess. That resolves DST transitions.
 *
 * A wall-clock time inside a spring-forward gap never occurs. Such a time
 * resolves FORWARD, past the transition — never to an earlier instant. This
 * matters: resolving 02:30 backwards to 01:30 would schedule a send an hour
 * before the window the operator configured.
 */
export function fromWallClock(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string,
): Date {
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second ?? 0,
  );

  const firstOffset = getOffsetMs(new Date(asIfUtc), timeZone);
  const firstCandidate = asIfUtc - firstOffset;

  const secondOffset = getOffsetMs(new Date(firstCandidate), timeZone);
  if (secondOffset === firstOffset) {
    return new Date(firstCandidate);
  }

  const secondCandidate = asIfUtc - secondOffset;

  // The second pass is authoritative when it round-trips to the requested wall
  // clock. When neither does, the time is inside a DST gap: take the later
  // instant so scheduling only ever moves forward.
  const roundTrip = toWallClock(new Date(secondCandidate), timeZone);
  const matches =
    roundTrip.year === wall.year &&
    roundTrip.month === wall.month &&
    roundTrip.day === wall.day &&
    roundTrip.hour === wall.hour &&
    roundTrip.minute === wall.minute;

  if (matches) return new Date(secondCandidate);
  return new Date(Math.max(firstCandidate, secondCandidate));
}

/**
 * Whether a wall-clock time actually exists in a zone. False inside a
 * spring-forward gap (e.g. 02:30 on the US spring transition day).
 */
export function wallClockExists(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): boolean {
  const instant = fromWallClock(wall, timeZone);
  const roundTrip = toWallClock(instant, timeZone);
  return (
    roundTrip.year === wall.year &&
    roundTrip.month === wall.month &&
    roundTrip.day === wall.day &&
    roundTrip.hour === wall.hour &&
    roundTrip.minute === wall.minute
  );
}

/** Minutes since local midnight. */
export function minutesSinceMidnight(instant: Date, timeZone: string): number {
  const wall = toWallClock(instant, timeZone);
  return wall.hour * 60 + wall.minute;
}

/** Parse "09:00" / "16:30" into minutes since midnight. Returns null if malformed. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatTimeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The UTC instant of local midnight, `dayOffset` days from the day containing `instant`. */
export function startOfLocalDay(instant: Date, timeZone: string, dayOffset = 0): Date {
  const wall = toWallClock(instant, timeZone);
  // Advance the calendar date in UTC space, which is safe for date arithmetic,
  // then resolve the resulting wall-clock midnight back through the zone.
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + dayOffset));
  return fromWallClock(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timeZone,
  );
}

/** A local wall-clock time on the local day containing `reference`, offset by whole days. */
export function localTimeOnDay(
  reference: Date,
  timeZone: string,
  minutesFromMidnight: number,
  dayOffset = 0,
): Date {
  const wall = toWallClock(reference, timeZone);
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + dayOffset));
  return fromWallClock(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: Math.floor(minutesFromMidnight / 60),
      minute: minutesFromMidnight % 60,
    },
    timeZone,
  );
}

/** Human-readable label, e.g. "Mar 9, 2025, 09:30 EDT". */
export function formatInZone(instant: Date, timeZone: string): string {
  // Explicit components rather than dateStyle/timeStyle: those cannot be
  // combined with timeZoneName, and showing the zone abbreviation is the point.
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}
