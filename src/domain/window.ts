/**
 * Sending windows. Pure, no I/O.
 *
 * A window is a local wall-clock range on permitted weekdays, evaluated in the
 * prospect's timezone when known and the campaign's otherwise (brief §28).
 */
import {
  formatTimeOfDay,
  isValidTimeZone,
  localTimeOnDay,
  minutesSinceMidnight,
  parseTimeOfDay,
  toWallClock,
} from './timezone.js';

export interface SendingWindow {
  /** "09:00" */
  start: string;
  /** "11:30" */
  end: string;
}

export interface NormalizedWindow {
  startMinutes: number;
  endMinutes: number;
}

export interface WindowConfig {
  windows: SendingWindow[];
  /** ISO weekdays, 1 = Monday. Empty means no day is permitted. */
  sendDays: number[];
  timeZone: string;
}

/**
 * Validate and normalise configured windows. Malformed entries are dropped
 * rather than throwing, and an inverted range (end <= start) is dropped too:
 * silently treating 16:00–09:00 as an overnight window would send at 3am.
 */
export function normalizeWindows(windows: SendingWindow[]): NormalizedWindow[] {
  const normalized: NormalizedWindow[] = [];
  for (const window of windows) {
    const startMinutes = parseTimeOfDay(window.start ?? '');
    const endMinutes = parseTimeOfDay(window.end ?? '');
    if (startMinutes === null || endMinutes === null) continue;
    if (endMinutes <= startMinutes) continue;
    normalized.push({ startMinutes, endMinutes });
  }
  return normalized.sort((a, b) => a.startMinutes - b.startMinutes);
}

export function normalizeSendDays(days: number[] | null | undefined): number[] {
  if (!Array.isArray(days)) return [];
  const valid = days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return [...new Set(valid)].sort((a, b) => a - b);
}

export interface WindowCheck {
  allowed: boolean;
  reason: 'IN_WINDOW' | 'NO_WINDOWS_CONFIGURED' | 'DAY_NOT_PERMITTED' | 'OUTSIDE_WINDOW' | 'INVALID_TIMEZONE';
  detail: string;
}

/**
 * Is `instant` inside a permitted window?
 *
 * Fails closed: an invalid zone or an empty window list means "not allowed",
 * never "allowed by default" (brief §66.15).
 */
export function isWithinSendingWindow(instant: Date, config: WindowConfig): WindowCheck {
  if (!isValidTimeZone(config.timeZone)) {
    return {
      allowed: false,
      reason: 'INVALID_TIMEZONE',
      detail: `"${config.timeZone}" is not a valid IANA time zone.`,
    };
  }

  const windows = normalizeWindows(config.windows);
  if (windows.length === 0) {
    return {
      allowed: false,
      reason: 'NO_WINDOWS_CONFIGURED',
      detail: 'No valid sending window is configured, so sending is not permitted.',
    };
  }

  const sendDays = normalizeSendDays(config.sendDays);
  const wall = toWallClock(instant, config.timeZone);

  if (!sendDays.includes(wall.weekday)) {
    return {
      allowed: false,
      reason: 'DAY_NOT_PERMITTED',
      detail: `${dayName(wall.weekday)} is not a permitted sending day.`,
    };
  }

  const nowMinutes = minutesSinceMidnight(instant, config.timeZone);
  const match = windows.find((w) => nowMinutes >= w.startMinutes && nowMinutes < w.endMinutes);
  if (match) {
    return {
      allowed: true,
      reason: 'IN_WINDOW',
      detail: `Inside ${formatTimeOfDay(match.startMinutes)}–${formatTimeOfDay(match.endMinutes)} ${config.timeZone}.`,
    };
  }

  return {
    allowed: false,
    reason: 'OUTSIDE_WINDOW',
    detail: `${formatTimeOfDay(nowMinutes)} ${config.timeZone} is outside ${windows
      .map((w) => `${formatTimeOfDay(w.startMinutes)}–${formatTimeOfDay(w.endMinutes)}`)
      .join(', ')}.`,
  };
}

/**
 * The next instant at or after `from` that falls inside a window.
 * Returns null if the configuration can never permit a send.
 *
 * Searches forward day by day (bounded) rather than computing arithmetically,
 * because DST means "tomorrow at 09:00 local" is not always exactly 24 hours
 * later.
 */
export function nextWindowStart(from: Date, config: WindowConfig, maxDaysAhead = 14): Date | null {
  if (!isValidTimeZone(config.timeZone)) return null;

  const windows = normalizeWindows(config.windows);
  const sendDays = normalizeSendDays(config.sendDays);
  if (windows.length === 0 || sendDays.length === 0) return null;

  for (let dayOffset = 0; dayOffset <= maxDaysAhead; dayOffset += 1) {
    // Probe midday to identify the calendar day robustly across transitions.
    const probe = localTimeOnDay(from, config.timeZone, 12 * 60, dayOffset);
    const wall = toWallClock(probe, config.timeZone);
    if (!sendDays.includes(wall.weekday)) continue;

    for (const window of windows) {
      const windowStart = localTimeOnDay(from, config.timeZone, window.startMinutes, dayOffset);
      const windowEnd = localTimeOnDay(from, config.timeZone, window.endMinutes, dayOffset);

      // Already inside this window: now is fine.
      if (from >= windowStart && from < windowEnd) return from;
      // Window starts later today (or on a future day).
      if (windowStart > from) return windowStart;
    }
  }

  return null;
}

/** Human-readable summary for the UI and for blocked-send explanations. */
export function describeWindows(config: WindowConfig): string {
  const windows = normalizeWindows(config.windows);
  const sendDays = normalizeSendDays(config.sendDays);
  if (windows.length === 0) return 'No sending window configured';
  const times = windows
    .map((w) => `${formatTimeOfDay(w.startMinutes)}–${formatTimeOfDay(w.endMinutes)}`)
    .join(', ');
  const days = sendDays.length === 0 ? 'no days' : sendDays.map(dayName).join(', ');
  return `${times} ${config.timeZone} on ${days}`;
}

function dayName(isoWeekday: number): string {
  return (
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][isoWeekday - 1] ??
    'Unknown'
  );
}
