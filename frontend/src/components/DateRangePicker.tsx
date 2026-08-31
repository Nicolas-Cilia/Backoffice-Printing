import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  daysInMonth,
  firstWeekdayOfMonth,
  formatDateRangeLabel,
  isDateKeyInRange,
  orderedDateRange,
  shiftMonth,
  toDateKey,
  type CalendarDateRange,
} from '../utils/dateRange';

interface DateRangePickerProps {
  label: string;
  value: CalendarDateRange;
  onChange: (range: CalendarDateRange) => void;
  placeholder?: string;
}

function weekdayLabels(): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'short' }),
  );
}

function monthTitle(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthFromKey(key: string): { year: number; month: number } {
  const [year, month] = key.split('-').map(Number);
  return { year, month: month - 1 };
}

export function DateRangePicker({
  label,
  value,
  onChange,
  placeholder,
}: DateRangePickerProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const seed = value.from ?? value.to;
    if (seed) return monthFromKey(seed);
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() };
  });
  const [draftFrom, setDraftFrom] = useState<string | null>(null);
  const [pickingEnd, setPickingEnd] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const pickingEndRef = useRef(false);
  const draftFromRef = useRef<string | null>(null);
  pickingEndRef.current = pickingEnd;
  draftFromRef.current = draftFrom;

  const display = formatDateRangeLabel(value);
  const emptyPlaceholder = placeholder ?? t('floor.dateRangePlaceholder', 'Select dates');

  const previewRange = useMemo(() => {
    if (pickingEnd && draftFrom && hoverKey) {
      return orderedDateRange(draftFrom, hoverKey);
    }
    if (pickingEnd && draftFrom) {
      return { from: draftFrom, to: draftFrom };
    }
    return { from: value.from, to: value.to };
  }, [pickingEnd, draftFrom, hoverKey, value.from, value.to]);

  const closeCalendar = (commitSingleDay: boolean) => {
    if (commitSingleDay && pickingEndRef.current && draftFromRef.current) {
      onChangeRef.current({ from: draftFromRef.current, to: draftFromRef.current });
    }
    setOpen(false);
    setPickingEnd(false);
    setHoverKey(null);
    setDraftFrom(null);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeCalendar(true);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      closeCalendar(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const openCalendar = () => {
    const seed = value.from ?? value.to;
    if (seed) setView(monthFromKey(seed));
    else {
      const today = new Date();
      setView({ year: today.getFullYear(), month: today.getMonth() });
    }
    setDraftFrom(null);
    setPickingEnd(false);
    setHoverKey(null);
    setOpen(true);
  };

  const selectDay = (key: string) => {
    if (!pickingEnd) {
      setDraftFrom(key);
      setPickingEnd(true);
      setHoverKey(key);
      return;
    }
    const next = orderedDateRange(draftFrom ?? key, key);
    onChange(next);
    setDraftFrom(null);
    setPickingEnd(false);
    setHoverKey(null);
    setOpen(false);
  };

  const clearRange = () => {
    onChange({ from: null, to: null });
    setDraftFrom(null);
    setPickingEnd(false);
    setHoverKey(null);
  };

  const goToToday = () => {
    const today = new Date();
    setView({ year: today.getFullYear(), month: today.getMonth() });
  };

  const blanks = firstWeekdayOfMonth(view.year, view.month);
  const count = daysInMonth(view.year, view.month);
  const todayKey = toDateKey(new Date());
  const weekdays = weekdayLabels();

  return (
    <div ref={rootRef} className="flex flex-col gap-1 min-w-0 relative">
      <span className="text-xs text-bambu-gray">{label}</span>
      <button
        type="button"
        className="w-full rounded-md bg-bambu-dark border border-bambu-dark-tertiary px-3 py-2 text-sm text-left text-white focus:outline-none focus:ring-1 focus:ring-bambu-green flex items-center gap-2 min-h-[40px]"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? closeCalendar(true) : openCalendar())}
      >
        <Calendar className="w-4 h-4 text-bambu-gray shrink-0" aria-hidden="true" />
        <span className={`truncate ${display ? 'text-white' : 'text-bambu-gray'}`}>
          {display || emptyPlaceholder}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('floor.dateRangeCalendarLabel', 'Choose a date range')}
          className="absolute top-full left-0 right-0 sm:left-auto sm:right-0 sm:w-[20rem] mt-1 z-20 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-xl p-3"
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              className="p-1.5 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors"
              onClick={() => setView((current) => shiftMonth(current.year, current.month, -1))}
              aria-label={t('common.previous', 'Previous')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-white">{monthTitle(view.year, view.month)}</p>
              <button
                type="button"
                className="px-2 py-0.5 text-xs rounded bg-bambu-dark-tertiary hover:bg-bambu-green/20 text-bambu-gray hover:text-white transition-colors"
                onClick={goToToday}
              >
                {t('common.today', 'Today')}
              </button>
            </div>
            <button
              type="button"
              className="p-1.5 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors"
              onClick={() => setView((current) => shiftMonth(current.year, current.month, 1))}
              aria-label={t('common.next', 'Next')}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {weekdays.map((day) => (
              <div key={day} className="text-center text-[10px] uppercase tracking-wide text-bambu-gray py-1">
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5" onMouseLeave={() => setHoverKey(null)}>
            {Array.from({ length: blanks }, (_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {Array.from({ length: count }, (_, i) => {
              const day = i + 1;
              const key = dateKey(view.year, view.month, day);
              const isToday = key === todayKey;
              const isStart = previewRange.from === key;
              const isEnd = previewRange.to === key;
              const inRange = Boolean(
                previewRange.from &&
                  previewRange.to &&
                  isDateKeyInRange(key, previewRange.from, previewRange.to),
              );
              const isEdge = isStart || isEnd;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectDay(key)}
                  onMouseEnter={() => pickingEnd && setHoverKey(key)}
                  aria-pressed={isEdge}
                  className={`h-8 text-sm rounded-md transition-colors ${
                    isEdge
                      ? 'bg-bambu-green text-white'
                      : inRange
                        ? 'bg-bambu-green/25 text-white'
                        : isToday
                          ? 'text-white ring-1 ring-bambu-green'
                          : 'text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white'
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between mt-3 pt-2 border-t border-bambu-dark-tertiary">
            <p className="text-[11px] text-bambu-gray pr-2">
              {pickingEnd
                ? t('floor.dateRangePickEnd', 'Now pick an end date')
                : t('floor.dateRangePickStart', 'Pick a start date, then an end date')}
            </p>
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={clearRange}
              disabled={!value.from && !value.to && !draftFrom}
            >
              <X className="w-3 h-3" />
              {t('common.clear', 'Clear')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export type { CalendarDateRange };
