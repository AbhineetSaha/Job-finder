/**
 * Timezone and sending-window tests.
 *
 * US DST transition dates used below:
 *   2025-03-09 — spring forward (02:00 → 03:00 local)
 *   2025-11-02 — fall back (02:00 → 01:00 local)
 */
import { describe, expect, it } from 'vitest';
import {
  fromWallClock,
  getOffsetMs,
  isValidTimeZone,
  localTimeOnDay,
  minutesSinceMidnight,
  parseTimeOfDay,
  startOfLocalDay,
  toWallClock,
  wallClockExists,
} from '../../src/domain/timezone.js';
import {
  describeWindows,
  isWithinSendingWindow,
  nextWindowStart,
  normalizeSendDays,
  normalizeWindows,
} from '../../src/domain/window.js';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const CHI = 'America/Chicago';
const PHX = 'America/Phoenix'; // no DST

describe('timezone conversion', () => {
  it('converts local wall clock to UTC correctly across DST', () => {
    // EST (UTC-5) in January
    expect(fromWallClock({ year: 2025, month: 1, day: 15, hour: 9, minute: 0 }, NY).toISOString()).toBe(
      '2025-01-15T14:00:00.000Z',
    );
    // EDT (UTC-4) in July — one hour earlier in UTC for the same wall clock
    expect(fromWallClock({ year: 2025, month: 7, day: 15, hour: 9, minute: 0 }, NY).toISOString()).toBe(
      '2025-07-15T13:00:00.000Z',
    );
  });

  it('handles every supported US zone', () => {
    expect(fromWallClock({ year: 2025, month: 7, day: 15, hour: 9, minute: 0 }, LA).toISOString()).toBe(
      '2025-07-15T16:00:00.000Z',
    );
    expect(fromWallClock({ year: 2025, month: 7, day: 15, hour: 9, minute: 0 }, CHI).toISOString()).toBe(
      '2025-07-15T14:00:00.000Z',
    );
    // Arizona does not observe DST, so the offset is identical in both seasons.
    expect(getOffsetMs(new Date('2025-01-15T12:00:00Z'), PHX)).toBe(
      getOffsetMs(new Date('2025-07-15T12:00:00Z'), PHX),
    );
  });

  it('reports the correct offsets either side of a transition', () => {
    expect(getOffsetMs(new Date('2025-01-15T12:00:00Z'), NY) / 3_600_000).toBe(-5);
    expect(getOffsetMs(new Date('2025-07-15T12:00:00Z'), NY) / 3_600_000).toBe(-4);
  });

  it('identifies wall-clock times that do not exist in a spring-forward gap', () => {
    expect(wallClockExists({ year: 2025, month: 3, day: 9, hour: 1, minute: 30 }, NY)).toBe(true);
    expect(wallClockExists({ year: 2025, month: 3, day: 9, hour: 2, minute: 30 }, NY)).toBe(false);
    expect(wallClockExists({ year: 2025, month: 3, day: 9, hour: 3, minute: 30 }, NY)).toBe(true);
  });

  it('resolves a gap time FORWARD, never to an earlier instant', () => {
    // Resolving 02:30 backwards to 01:30 EST would schedule a send an hour
    // before the configured window. It must land after the transition.
    const resolved = fromWallClock({ year: 2025, month: 3, day: 9, hour: 2, minute: 30 }, NY);
    const transition = new Date('2025-03-09T07:00:00Z');
    expect(resolved.getTime()).toBeGreaterThanOrEqual(transition.getTime());
  });

  it('resolves an ambiguous fall-back time deterministically', () => {
    const resolved = fromWallClock({ year: 2025, month: 11, day: 2, hour: 1, minute: 30 }, NY);
    expect(Number.isNaN(resolved.getTime())).toBe(false);
    expect(toWallClock(resolved, NY).hour).toBe(1);
  });

  it('round-trips instants through wall clock', () => {
    const instant = new Date('2025-07-15T13:00:00Z');
    const wall = toWallClock(instant, NY);
    expect(wall).toMatchObject({ year: 2025, month: 7, day: 15, hour: 9, minute: 0 });
    expect(wall.weekday).toBe(2); // a Tuesday
  });

  it('computes local midnight and local times on offset days', () => {
    expect(startOfLocalDay(new Date('2025-07-15T13:00:00Z'), NY).toISOString()).toBe(
      '2025-07-15T04:00:00.000Z',
    );
    expect(
      localTimeOnDay(new Date('2025-07-15T13:00:00Z'), NY, 9 * 60, 1).toISOString(),
    ).toBe('2025-07-16T13:00:00.000Z');
  });

  it('crosses a DST boundary when adding a day, keeping the same wall clock', () => {
    // 09:00 the day before and the day after a transition are 23 or 25 real
    // hours apart, not 24. The wall clock is what must stay constant.
    const before = new Date('2025-03-08T14:00:00Z'); // 09:00 EST
    const next = localTimeOnDay(before, NY, 9 * 60, 1);
    expect(toWallClock(next, NY).hour).toBe(9);
    expect(next.toISOString()).toBe('2025-03-09T13:00:00.000Z');
  });

  it('validates zone identifiers', () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it('parses times of day and rejects malformed ones', () => {
    expect(parseTimeOfDay('09:00')).toBe(540);
    expect(parseTimeOfDay('16:30')).toBe(990);
    expect(parseTimeOfDay('9:05')).toBe(545);
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('09:60')).toBeNull();
    expect(parseTimeOfDay('nope')).toBeNull();
  });

  it('computes minutes since local midnight', () => {
    expect(minutesSinceMidnight(new Date('2025-07-15T13:30:00Z'), NY)).toBe(9 * 60 + 30);
  });
});

describe('sending windows', () => {
  const config = {
    windows: [
      { start: '09:00', end: '11:30' },
      { start: '13:00', end: '16:30' },
    ],
    sendDays: [1, 2, 3, 4, 5],
    timeZone: NY,
  };

  it('allows a send inside a window', () => {
    // 2025-07-15 is a Tuesday; 14:00Z = 10:00 EDT.
    expect(isWithinSendingWindow(new Date('2025-07-15T14:00:00Z'), config).allowed).toBe(true);
    // 18:00Z = 14:00 EDT, inside the afternoon window.
    expect(isWithinSendingWindow(new Date('2025-07-15T18:00:00Z'), config).allowed).toBe(true);
  });

  it('blocks a send in the lunch gap between windows', () => {
    // 16:30Z = 12:30 EDT.
    const result = isWithinSendingWindow(new Date('2025-07-15T16:30:00Z'), config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('OUTSIDE_WINDOW');
  });

  it('blocks a send outside business hours', () => {
    // 03:00Z = 23:00 EDT the previous day.
    expect(isWithinSendingWindow(new Date('2025-07-15T03:00:00Z'), config).allowed).toBe(false);
  });

  it('blocks a send on a non-permitted day', () => {
    // 2025-07-19 is a Saturday.
    const result = isWithinSendingWindow(new Date('2025-07-19T14:00:00Z'), config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('DAY_NOT_PERMITTED');
  });

  it('evaluates the window in the prospect timezone, not the server timezone', () => {
    // 17:00Z is 13:00 EDT (inside the NY afternoon window) but 10:00 PDT
    // (inside the LA morning window). Both allowed, for different reasons.
    const ny = isWithinSendingWindow(new Date('2025-07-15T17:00:00Z'), { ...config, timeZone: NY });
    const la = isWithinSendingWindow(new Date('2025-07-15T17:00:00Z'), { ...config, timeZone: LA });
    expect(ny.allowed).toBe(true);
    expect(la.allowed).toBe(true);

    // 13:30Z is 09:30 EDT (allowed) but 06:30 PDT (too early).
    expect(isWithinSendingWindow(new Date('2025-07-15T13:30:00Z'), { ...config, timeZone: NY }).allowed).toBe(true);
    expect(isWithinSendingWindow(new Date('2025-07-15T13:30:00Z'), { ...config, timeZone: LA }).allowed).toBe(false);
  });

  it('fails closed with no windows configured', () => {
    const result = isWithinSendingWindow(new Date('2025-07-15T14:00:00Z'), { ...config, windows: [] });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('NO_WINDOWS_CONFIGURED');
  });

  it('fails closed on an invalid timezone', () => {
    const result = isWithinSendingWindow(new Date('2025-07-15T14:00:00Z'), {
      ...config,
      timeZone: 'Nowhere/Nothing',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('INVALID_TIMEZONE');
  });

  it('discards malformed and inverted windows rather than misreading them', () => {
    // 16:00–09:00 as an "overnight window" would send at 3am. Dropped instead.
    const normalized = normalizeWindows([
      { start: '09:00', end: '11:30' },
      { start: '16:00', end: '09:00' },
      { start: 'garbage', end: '10:00' },
      { start: '10:00', end: '10:00' },
    ]);
    expect(normalized).toEqual([{ startMinutes: 540, endMinutes: 690 }]);
  });

  it('normalises send days, dropping invalid values', () => {
    expect(normalizeSendDays([3, 1, 1, 9, 0, -2, 5])).toEqual([1, 3, 5]);
    expect(normalizeSendDays(null)).toEqual([]);
  });
});

describe('nextWindowStart', () => {
  const config = {
    windows: [
      { start: '09:00', end: '11:30' },
      { start: '13:00', end: '16:30' },
    ],
    sendDays: [1, 2, 3, 4, 5],
    timeZone: NY,
  };

  it('returns the current instant when already inside a window', () => {
    const now = new Date('2025-07-15T14:00:00Z');
    expect(nextWindowStart(now, config)?.toISOString()).toBe(now.toISOString());
  });

  it('advances to the afternoon window from the midday gap', () => {
    // 16:30Z = 12:30 EDT → next start is 13:00 EDT = 17:00Z.
    expect(nextWindowStart(new Date('2025-07-15T16:30:00Z'), config)?.toISOString()).toBe(
      '2025-07-15T17:00:00.000Z',
    );
  });

  it('advances to the next morning after the last window closes', () => {
    // 21:00Z Tue = 17:00 EDT → next is Wed 09:00 EDT = 13:00Z.
    expect(nextWindowStart(new Date('2025-07-15T21:00:00Z'), config)?.toISOString()).toBe(
      '2025-07-16T13:00:00.000Z',
    );
  });

  it('skips the weekend', () => {
    // 21:00Z Friday 2025-07-18 → Monday 2025-07-21 09:00 EDT = 13:00Z.
    expect(nextWindowStart(new Date('2025-07-18T21:00:00Z'), config)?.toISOString()).toBe(
      '2025-07-21T13:00:00.000Z',
    );
  });

  it('produces a valid instant across a DST transition', () => {
    // Friday 2025-03-07 evening → Monday 2025-03-10, after the Sunday change.
    const next = nextWindowStart(new Date('2025-03-07T23:00:00Z'), config);
    expect(next).not.toBeNull();
    const wall = toWallClock(next as Date, NY);
    expect(wall.hour).toBe(9);
    expect(wall.day).toBe(10);
    // 09:00 EDT is 13:00Z, proving the post-transition offset was used.
    expect((next as Date).toISOString()).toBe('2025-03-10T13:00:00.000Z');
  });

  it('returns null when the configuration can never permit a send', () => {
    expect(nextWindowStart(new Date(), { ...config, windows: [] })).toBeNull();
    expect(nextWindowStart(new Date(), { ...config, sendDays: [] })).toBeNull();
    expect(nextWindowStart(new Date(), { ...config, timeZone: 'Bad/Zone' })).toBeNull();
  });

  it('never moves backwards in time', () => {
    for (const iso of [
      '2025-07-15T02:00:00Z',
      '2025-07-15T14:00:00Z',
      '2025-07-15T16:31:00Z',
      '2025-07-19T12:00:00Z',
      '2025-03-09T06:30:00Z',
      '2025-11-02T05:30:00Z',
    ]) {
      const from = new Date(iso);
      const next = nextWindowStart(from, config);
      expect(next, iso).not.toBeNull();
      expect((next as Date).getTime(), iso).toBeGreaterThanOrEqual(from.getTime());
    }
  });
});

describe('describeWindows', () => {
  it('renders a readable summary for the UI', () => {
    const summary = describeWindows({
      windows: [{ start: '09:00', end: '11:30' }],
      sendDays: [1, 5],
      timeZone: NY,
    });
    expect(summary).toContain('09:00–11:30');
    expect(summary).toContain('America/New_York');
    expect(summary).toContain('Monday');
    expect(summary).toContain('Friday');
  });
});
