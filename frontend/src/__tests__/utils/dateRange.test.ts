import { describe, expect, it } from 'vitest';
import {
  compareDateKeys,
  daysInMonth,
  endOfLocalDay,
  firstWeekdayOfMonth,
  formatDateRangeLabel,
  isDateKeyInRange,
  isTimestampInDateRange,
  orderedDateRange,
  parseDateKey,
  shiftMonth,
  startOfLocalDay,
  toDateKey,
} from '../../utils/dateRange';

describe('dateRange', () => {
  it('round-trips a local date through YYYY-MM-DD without UTC shift', () => {
    const date = new Date(2026, 7, 24, 22, 30, 0);
    expect(toDateKey(date)).toBe('2026-08-24');
    const parsed = parseDateKey('2026-08-24');
    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(7);
    expect(parsed?.getDate()).toBe(24);
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('not-a-date')).toBeNull();
  });

  it('covers the whole local day for range bounds', () => {
    const start = startOfLocalDay('2026-08-24');
    const end = endOfLocalDay('2026-08-24');
    expect(start?.getHours()).toBe(0);
    expect(end?.getHours()).toBe(23);
    expect(end?.getMinutes()).toBe(59);
  });

  it('orders a backwards range', () => {
    expect(orderedDateRange('2026-08-27', '2026-08-20')).toEqual({
      from: '2026-08-20',
      to: '2026-08-27',
    });
    expect(compareDateKeys('2026-08-20', '2026-08-27')).toBe(-1);
  });

  it('includes timestamps on the start and end days', () => {
    const afternoon = new Date(2026, 7, 24, 15, 0, 0);
    expect(isTimestampInDateRange(afternoon, '2026-08-24', '2026-08-24')).toBe(true);
    expect(isTimestampInDateRange(afternoon, '2026-08-20', '2026-08-24')).toBe(true);
    expect(isTimestampInDateRange(afternoon, '2026-08-25', '2026-08-27')).toBe(false);
    expect(isTimestampInDateRange(afternoon, '2026-08-20', '2026-08-23')).toBe(false);
  });

  it('treats an unset range as a match and a missing timestamp as a miss', () => {
    const afternoon = new Date(2026, 7, 24, 15, 0, 0);
    expect(isTimestampInDateRange(afternoon, null, null)).toBe(true);
    expect(isTimestampInDateRange(null, '2026-08-24', '2026-08-24')).toBe(false);
  });

  it('formats a single day and a multi-day span', () => {
    const single = formatDateRangeLabel({ from: '2026-08-24', to: '2026-08-24' });
    const span = formatDateRangeLabel({ from: '2026-08-20', to: '2026-08-27' });
    expect(single).toMatch(/24/);
    expect(span).toMatch(/20/);
    expect(span).toMatch(/27/);
    expect(formatDateRangeLabel({ from: null, to: null })).toBe('');
  });

  it('knows month length, weekday, and month shifting', () => {
    expect(daysInMonth(2026, 7)).toBe(31);
    expect(firstWeekdayOfMonth(2026, 7)).toBe(6);
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(isDateKeyInRange('2026-08-24', '2026-08-20', '2026-08-27')).toBe(true);
    expect(isDateKeyInRange('2026-08-19', '2026-08-20', '2026-08-27')).toBe(false);
  });
});
