/**
 * Calendar date-range helpers. Keys are local YYYY-MM-DD — never parse those
 * with `new Date('YYYY-MM-DD')`, which is UTC midnight and can land on the
 * previous local day.
 */

export type CalendarDateRange = {
  from: string | null;
  to: string | null;
};

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDateKey(key: string): Date | null {
  const match = DATE_KEY.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function startOfLocalDay(key: string): Date | null {
  const date = parseDateKey(key);
  if (!date) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

export function endOfLocalDay(key: string): Date | null {
  const date = parseDateKey(key);
  if (!date) return null;
  date.setHours(23, 59, 59, 999);
  return date;
}

export function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function orderedDateRange(from: string, to: string): { from: string; to: string } {
  return compareDateKeys(from, to) <= 0 ? { from, to } : { from: to, to: from };
}

export function isDateKeyInRange(key: string, from: string | null, to: string | null): boolean {
  if (from && compareDateKeys(key, from) < 0) return false;
  if (to && compareDateKeys(key, to) > 0) return false;
  return true;
}

/** Inclusive local-day range. Unset bounds are open. */
export function isTimestampInDateRange(
  timestamp: Date | null,
  from: string | null,
  to: string | null,
): boolean {
  if (!from && !to) return true;
  if (!timestamp) return false;
  if (from) {
    const start = startOfLocalDay(from);
    if (start && timestamp < start) return false;
  }
  if (to) {
    const end = endOfLocalDay(to);
    if (end && timestamp > end) return false;
  }
  return true;
}

export function formatDateRangeLabel(range: CalendarDateRange): string {
  if (!range.from && !range.to) return '';
  const fromKey = range.from ?? range.to;
  const toKey = range.to ?? range.from;
  if (!fromKey || !toKey) return '';
  const fromDate = parseDateKey(fromKey);
  const toDate = parseDateKey(toKey);
  if (!fromDate || !toDate) return '';
  if (fromKey === toKey) {
    return toDate.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  const sameYear = fromDate.getFullYear() === toDate.getFullYear();
  const fromText = fromDate.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
  const toText = toDate.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${fromText} – ${toText}`;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}
