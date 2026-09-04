/**
 * Stats 2 capacity config: editable weekly hours, line start / clear, device recipe.
 * Used on Stats 2 (embedded) and Settings → Queue (card chrome).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Check, ChevronDown, Copy, Save } from 'lucide-react';
import {
  api,
  type Printer,
  type Stats2DeviceRecipe,
  type Stats2Globals,
  type Stats2PrinterTimeBlock,
  type Stats2ScheduleShift,
} from '../api/client';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Curated IANA zones — avoid free-text typos like "PST" that break staffed-minute math. */
const TIMEZONE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)' },
  { value: 'America/Denver', label: 'Mountain Time (Denver)' },
  { value: 'America/Phoenix', label: 'Arizona (Phoenix)' },
  { value: 'America/Chicago', label: 'Central Time (Chicago)' },
  { value: 'America/New_York', label: 'Eastern Time (New York)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'America/Toronto', label: 'Toronto' },
  { value: 'America/Mexico_City', label: 'Mexico City' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Shanghai', label: 'Shanghai' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

const MINUTE_CHOICES = [0, 15, 30, 45] as const;

type DayDraft = {
  day_of_week: number;
  enabled: boolean;
  start_time: string;
  end_time: string;
  operator_count: number;
};

type BlockDraft = {
  key: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  label: string;
  enabled: boolean;
};

function newBlockKey(): string {
  return `b-${Math.random().toString(36).slice(2, 10)}`;
}

function draftsFromBlocks(blocks: Stats2PrinterTimeBlock[], printerId: number): BlockDraft[] {
  return blocks
    .filter((b) => b.printer_id === printerId)
    .map((b) => ({
      key: newBlockKey(),
      day_of_week: b.day_of_week,
      start_time: (b.start_time || '12:00').slice(0, 5),
      end_time: (b.end_time || '13:00').slice(0, 5),
      label: b.label || '',
      enabled: b.enabled !== false,
    }))
    .sort((a, b) => a.day_of_week - b.day_of_week || minutesOfDay(a.start_time) - minutesOfDay(b.start_time));
}

function snapshotBlocks(printerId: number | null, drafts: BlockDraft[]): string {
  return JSON.stringify({
    printerId,
    drafts: drafts.map((d) => ({
      day_of_week: d.day_of_week,
      start_time: d.start_time,
      end_time: d.end_time,
      label: d.label,
      enabled: d.enabled,
    })),
  });
}

type AmPmParts = { hour12: number; minute: number; ampm: 'AM' | 'PM' };

/** Format stored 24h ``HH:MM`` as ``8:00 AM`` / ``5:00 PM``. */
function formatAmPm(hhmm: string): string {
  const parts = parseHhmm(hhmm);
  return `${parts.hour12}:${String(parts.minute).padStart(2, '0')} ${parts.ampm}`;
}

function parseHhmm(hhmm: string): AmPmParts {
  const match = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '08:00').trim());
  let hours24 = match ? Number(match[1]) : 8;
  let minute = match ? Number(match[2]) : 0;
  if (!Number.isFinite(hours24) || hours24 < 0 || hours24 > 23) hours24 = 8;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) minute = 0;
  return {
    hour12: hours24 % 12 || 12,
    minute,
    ampm: hours24 < 12 ? 'AM' : 'PM',
  };
}

function toHhmm(parts: AmPmParts): string {
  let hours24 = parts.hour12 % 12;
  if (parts.ampm === 'PM') hours24 += 12;
  return `${String(hours24).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function minutesOfDay(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '00:00').trim());
  const h = match ? Number(match[1]) : 0;
  const m = match ? Number(match[2]) : 0;
  return h * 60 + m;
}

function hhmmFromMinutes(total: number): string {
  const clamped = Math.max(0, Math.min(total, 23 * 60 + 45));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Keep start strictly before end; nudge the other side by 1h when needed. */
function clampShiftTimes(
  start: string,
  end: string,
  changed: 'start' | 'end',
): { start_time: string; end_time: string } {
  let s = minutesOfDay(start);
  let e = minutesOfDay(end);
  if (s < e) return { start_time: start, end_time: end };
  const span = 60;
  if (changed === 'start') {
    e = Math.min(s + span, 23 * 60 + 45);
    if (e <= s) s = Math.max(0, e - span);
  } else {
    s = Math.max(0, e - span);
    if (s >= e) e = Math.min(s + span, 23 * 60 + 45);
  }
  return { start_time: hhmmFromMinutes(s), end_time: hhmmFromMinutes(e) };
}

function snapshotSchedule(globals: Stats2Globals, days: DayDraft[]): string {
  return JSON.stringify({
    globals,
    days: days.map((d) => ({
      day_of_week: d.day_of_week,
      enabled: d.enabled,
      start_time: d.start_time,
      end_time: d.end_time,
      operator_count: d.operator_count,
    })),
  });
}

function SaveActions({
  saving,
  dirty,
  saved,
  onSave,
  label,
}: {
  saving: boolean;
  dirty: boolean;
  saved: boolean;
  onSave: () => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        disabled={saving || !dirty}
        onClick={onSave}
        className="inline-flex items-center gap-1.5 rounded-lg bg-bambu-green px-3.5 py-2 text-sm font-medium text-bambu-dark disabled:opacity-50"
      >
        <Save className="h-3.5 w-3.5" aria-hidden />
        {saving ? t('common.saving', 'Saving…') : label}
      </button>
      {saved && !dirty ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-300" role="status" aria-live="polite">
          <Check className="w-3.5 h-3.5" aria-hidden />
          {t('stats2.configSaved', 'Saved — capacity will refresh')}
        </span>
      ) : null}
      {dirty && !saving ? (
        <span className="text-xs text-amber-200/90" role="status" aria-live="polite">
          {t('stats2.unsavedChanges', 'Unsaved changes')}
        </span>
      ) : null}
    </div>
  );
}

function timezoneOptionsFor(value: string): Array<{ value: string; label: string }> {
  if (TIMEZONE_OPTIONS.some((o) => o.value === value)) return [...TIMEZONE_OPTIONS];
  if (!value) return [...TIMEZONE_OPTIONS];
  return [{ value, label: value }, ...TIMEZONE_OPTIONS];
}

function emptyWeek(): DayDraft[] {
  return DAY_LABELS.map((_, i) => ({
    day_of_week: i,
    enabled: false,
    start_time: '08:00',
    end_time: '17:00',
    operator_count: 1,
  }));
}

function draftsFromShifts(shifts: Stats2ScheduleShift[]): DayDraft[] {
  const base = emptyWeek();
  for (const s of shifts) {
    const i = s.day_of_week;
    if (i < 0 || i > 6) continue;
    // Prefer an enabled shift if multiple exist for the day
    if (!base[i].enabled || s.enabled) {
      base[i] = {
        day_of_week: i,
        enabled: s.enabled,
        start_time: s.start_time?.slice(0, 5) || '08:00',
        end_time: s.end_time?.slice(0, 5) || '17:00',
        operator_count: Math.max(1, s.operator_count || 1),
      };
    }
  }
  return base;
}

function weekdayDefaults(): DayDraft[] {
  return DAY_LABELS.map((_, i) => ({
    day_of_week: i,
    enabled: i < 5,
    start_time: '08:00',
    end_time: '17:00',
    operator_count: 2,
  }));
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-bambu-dark-tertiary/60 bg-bambu-dark/40 p-5 sm:p-6 space-y-4 min-w-0">
      <h4 className="text-sm font-medium text-white">{title}</h4>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="text-xs text-bambu-gray">{label}</div>
      <div className="min-w-0">{children}</div>
      {hint ? <div className="text-[11px] leading-snug text-bambu-gray">{hint}</div> : null}
    </div>
  );
}

const inputClass =
  'w-full min-w-0 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-tertiary px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-bambu-green/50';

const compactSelectClass =
  'w-full appearance-none rounded-md border border-bambu-dark-tertiary bg-bambu-dark py-1.5 pl-2.5 pr-7 text-sm tabular-nums text-white focus:outline-none focus:ring-1 focus:ring-bambu-green/50';

/** Native select with a centered custom caret (browser caret sits too low with our padding). */
function SelectInput({
  className = '',
  children,
  disabled,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={`relative min-w-0 ${disabled ? 'opacity-50' : ''}`}>
      <select
        {...props}
        disabled={disabled}
        className={`${inputClass} appearance-none pr-10 ${className}`}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray"
        aria-hidden
      />
    </div>
  );
}

function CompactSelect({
  value,
  onChange,
  'aria-label': ariaLabel,
  children,
}: {
  value: string | number;
  onChange: (value: string) => void;
  'aria-label'?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative min-w-0">
      <select
        className={compactSelectClass}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-bambu-gray"
        aria-hidden
      />
    </div>
  );
}

/** Closed: short “8:00 AM” button. Open: hour / min / AM·PM popover with room for text + caret. */
function AmPmTimeSelect({
  value,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (hhmm: string) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const parts = parseHhmm(value);
  const minuteChoices = MINUTE_CHOICES.includes(parts.minute as (typeof MINUTE_CHOICES)[number])
    ? [...MINUTE_CHOICES]
    : [...MINUTE_CHOICES, parts.minute].sort((a, b) => a - b);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const commit = (patch: Partial<AmPmParts>) => {
    onChange(toHhmm({ ...parts, ...patch }));
  };

  return (
    <div className={`relative block w-full min-w-0 ${disabled ? 'opacity-50' : ''}`} ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-tertiary px-3 py-2.5 text-sm text-white hover:border-bambu-green/40 focus:outline-none focus:ring-1 focus:ring-bambu-green/50 disabled:cursor-not-allowed"
      >
        <span className="whitespace-nowrap tabular-nums">{formatAmPm(value)}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-bambu-gray" aria-hidden />
      </button>
      {open && !disabled ? (
        <div
          role="dialog"
          className="absolute left-0 z-40 mt-1.5 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-2.5 shadow-xl"
        >
          <div className="grid grid-cols-[4.5rem_4.75rem_5rem] gap-2">
            <CompactSelect
              value={parts.hour12}
              aria-label={ariaLabel ? `${ariaLabel} hour` : 'Hour'}
              onChange={(v) => commit({ hour12: Number(v) })}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </CompactSelect>
            <CompactSelect
              value={parts.minute}
              aria-label={ariaLabel ? `${ariaLabel} minutes` : 'Minutes'}
              onChange={(v) => commit({ minute: Number(v) })}
            >
              {minuteChoices.map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, '0')}
                </option>
              ))}
            </CompactSelect>
            <CompactSelect
              value={parts.ampm}
              aria-label={ariaLabel ? `${ariaLabel} AM/PM` : 'AM/PM'}
              onChange={(v) => commit({ ampm: v as 'AM' | 'PM' })}
            >
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </CompactSelect>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Stats2CapacityConfigCard({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [globals, setGlobals] = useState<Stats2Globals | null>(null);
  const [days, setDays] = useState<DayDraft[]>(() => emptyWeek());
  const [recipe, setRecipe] = useState<Stats2DeviceRecipe | null>(null);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [allTimeBlocks, setAllTimeBlocks] = useState<Stats2PrinterTimeBlock[]>([]);
  const [blockPrinterId, setBlockPrinterId] = useState<number | null>(null);
  const [blockDrafts, setBlockDrafts] = useState<BlockDraft[]>([]);
  const [blocksSnapshot, setBlocksSnapshot] = useState('');
  const [savingBlocks, setSavingBlocks] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [scheduleSnapshot, setScheduleSnapshot] = useState('');
  const [loaded, setLoaded] = useState(false);
  const savedFlashTimer = useRef<number | null>(null);

  const flashSaved = () => {
    setSavedFlash(true);
    if (savedFlashTimer.current) window.clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = window.setTimeout(() => setSavedFlash(false), 3000);
  };

  useEffect(
    () => () => {
      if (savedFlashTimer.current) window.clearTimeout(savedFlashTimer.current);
    },
    [],
  );

  const load = useCallback(async () => {
    try {
      const [sched, bom, blockRes, printerList] = await Promise.all([
        api.getStats2Schedule(),
        api.getStats2DeviceRecipe(),
        api.getStats2PrinterTimeBlocks(),
        api.getPrinters(),
      ]);
      const nextDays = draftsFromShifts(sched.shifts);
      const nextGlobals: Stats2Globals = {
        ...sched.globals,
        ready_buffer_targets: {
          BUT: 80,
          KNB: 50,
          TOP: 0,
          BOT: 0,
          ...(sched.globals.ready_buffer_targets || {}),
        },
      };
      setGlobals(nextGlobals);
      setDays(nextDays);
      setScheduleSnapshot(snapshotSchedule(nextGlobals, nextDays));
      setRecipe(bom);
      const activePrinters = printerList
        .filter((p) => p.is_active !== false)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      setPrinters(activePrinters);
      setAllTimeBlocks(blockRes.blocks || []);
      const initialPrinterId = activePrinters[0]?.id ?? null;
      setBlockPrinterId(initialPrinterId);
      const drafts = initialPrinterId != null ? draftsFromBlocks(blockRes.blocks || [], initialPrinterId) : [];
      setBlockDrafts(drafts);
      setBlocksSnapshot(snapshotBlocks(initialPrinterId, drafts));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const invalidateStats2 = useCallback(async () => {
    await queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === 'string' && String(q.queryKey[0]).startsWith('stats2'),
    });
  }, [queryClient]);

  const updateDay = (idx: number, patch: Partial<DayDraft>) => {
    setDays((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  const updateDayTime = (idx: number, field: 'start_time' | 'end_time', next: string) => {
    setDays((prev) =>
      prev.map((d, i) => {
        if (i !== idx) return d;
        const start = field === 'start_time' ? next : d.start_time;
        const end = field === 'end_time' ? next : d.end_time;
        const clamped = clampShiftTimes(start, end, field === 'start_time' ? 'start' : 'end');
        return { ...d, ...clamped };
      }),
    );
  };

  const updateGlobal = <K extends keyof Stats2Globals>(key: K, value: Stats2Globals[K]) => {
    setGlobals((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const scheduleDirty = Boolean(globals && snapshotSchedule(globals, days) !== scheduleSnapshot);
  const blocksDirty = snapshotBlocks(blockPrinterId, blockDrafts) !== blocksSnapshot;

  const selectBlockPrinter = (printerId: number) => {
    if (blocksDirty && !window.confirm('Discard unsaved time-block changes for this printer?')) {
      return;
    }
    setBlockPrinterId(printerId);
    const drafts = draftsFromBlocks(allTimeBlocks, printerId);
    setBlockDrafts(drafts);
    setBlocksSnapshot(snapshotBlocks(printerId, drafts));
  };

  const updateBlockDraft = (key: string, patch: Partial<BlockDraft>) => {
    setBlockDrafts((prev) =>
      prev.map((b) => {
        if (b.key !== key) return b;
        const next = { ...b, ...patch };
        if (patch.start_time != null || patch.end_time != null) {
          const clamped = clampShiftTimes(next.start_time, next.end_time, patch.start_time != null ? 'start' : 'end');
          next.start_time = clamped.start_time;
          next.end_time = clamped.end_time;
        }
        return next;
      }),
    );
  };

  const addBlockDraft = () => {
    setBlockDrafts((prev) => [
      ...prev,
      {
        key: newBlockKey(),
        day_of_week: 0,
        start_time: '12:00',
        end_time: '13:00',
        label: '',
        enabled: true,
      },
    ]);
  };

  const removeBlockDraft = (key: string) => {
    setBlockDrafts((prev) => prev.filter((b) => b.key !== key));
  };

  const saveTimeBlocks = async () => {
    if (blockPrinterId == null) return;
    const invalid = blockDrafts.find(
      (b) => b.enabled && minutesOfDay(b.start_time) >= minutesOfDay(b.end_time),
    );
    if (invalid) {
      setError(
        t('stats2.invalidBlockRange', {
          defaultValue: '{{day}}: block start must be before end (got {{start}} → {{end}})',
          day: DAY_LABELS[invalid.day_of_week],
          start: formatAmPm(invalid.start_time),
          end: formatAmPm(invalid.end_time),
        }),
      );
      return;
    }
    setSavingBlocks(true);
    setSavedFlash(false);
    try {
      const next = await api.putStats2PrinterTimeBlocks(blockPrinterId, {
        blocks: blockDrafts
          .filter((b) => b.enabled)
          .map((b) => ({
            day_of_week: b.day_of_week,
            start_time: b.start_time,
            end_time: b.end_time,
            label: b.label.trim() || null,
            enabled: true,
          })),
      });
      setAllTimeBlocks(next.blocks || []);
      const drafts = draftsFromBlocks(next.blocks || [], blockPrinterId);
      setBlockDrafts(drafts);
      setBlocksSnapshot(snapshotBlocks(blockPrinterId, drafts));
      setError(null);
      flashSaved();
      await invalidateStats2();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBlocks(false);
    }
  };

  const readyDeadline = useMemo(() => {
    if (!globals) return '—';
    const [h, m] = globals.production_line_start_time.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return '—';
    const total = h * 60 + m - (globals.pre_line_buffer_minutes || 0);
    const hh = ((Math.floor(total / 60) % 24) + 24) % 24;
    const mm = ((total % 60) + 60) % 60;
    return formatAmPm(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }, [globals]);

  const saveSchedule = async () => {
    if (!globals) return;
    const invalid = days.find((d) => d.enabled && minutesOfDay(d.start_time) >= minutesOfDay(d.end_time));
    if (invalid) {
      setError(
        t('stats2.invalidShiftRange', {
          defaultValue: '{{day}}: start must be before end (got {{start}} → {{end}})',
          day: DAY_LABELS[invalid.day_of_week],
          start: formatAmPm(invalid.start_time),
          end: formatAmPm(invalid.end_time),
        }),
      );
      return;
    }
    setSaving(true);
    setSavedFlash(false);
    try {
      const tz = globals.timezone || 'UTC';
      const shifts: Stats2ScheduleShift[] = days
        .filter((d) => d.enabled)
        .map((d) => ({
          day_of_week: d.day_of_week,
          start_time: d.start_time,
          end_time: d.end_time,
          operator_count: Math.max(1, Math.floor(d.operator_count) || 1),
          timezone: tz,
          enabled: true,
        }));
      const next = await api.putStats2Schedule({
        shifts,
        globals: {
          ...globals,
          ready_buffer_targets: {
            BUT: 80,
            KNB: 50,
            TOP: 0,
            BOT: 0,
            ...(globals.ready_buffer_targets || {}),
          },
        },
      });
      const nextDays = draftsFromShifts(next.shifts);
      const nextGlobals: Stats2Globals = {
        ...next.globals,
        ready_buffer_targets: {
          BUT: 80,
          KNB: 50,
          TOP: 0,
          BOT: 0,
          ...(next.globals.ready_buffer_targets || {}),
        },
      };
      setGlobals(nextGlobals);
      setDays(nextDays);
      setScheduleSnapshot(snapshotSchedule(nextGlobals, nextDays));
      setError(null);
      flashSaved();
      await invalidateStats2();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const body = (
    <div className="space-y-5">
      {!embedded && (
        <p className="text-xs text-bambu-gray leading-relaxed">
          {t(
            'stats2.capacityConfigDescription',
            'Weekly printer hours, production line start, bed clear assumption, and device recipe (Part Models). Used by Stats 2 capacity and schedule.',
          )}
        </p>
      )}

      {!loaded && <p className="text-sm text-bambu-gray">{t('common.loading', 'Loading…')}</p>}
      {error && (
        <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
          {error}
        </p>
      )}

      {globals && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
          <div className="lg:col-span-2 min-w-0 space-y-3">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
              <Panel title={t('stats2.panelLineStart', 'Production line start')}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
                  <Field
                    label={t('stats2.lineStart', 'Line start')}
                    hint={t('stats2.lineStartHint', 'When assembly starts consuming parts')}
                  >
                    <AmPmTimeSelect
                      value={globals.production_line_start_time.slice(0, 5)}
                      onChange={(hhmm) => updateGlobal('production_line_start_time', hhmm)}
                      aria-label={t('stats2.lineStart', 'Line start')}
                    />
                  </Field>
                  <Field
                    label={t('stats2.preLineBuffer', 'Pre-line buffer (min)')}
                    hint={t('stats2.readyDeadlineHint', {
                      defaultValue: 'Ready deadline ≈ {{time}}',
                      time: readyDeadline,
                    })}
                  >
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className={inputClass}
                      value={globals.pre_line_buffer_minutes}
                      onChange={(e) =>
                        updateGlobal('pre_line_buffer_minutes', Math.max(0, Math.floor(Number(e.target.value) || 0)))
                      }
                    />
                  </Field>
                </div>
              </Panel>

              <Panel title={t('stats2.panelCleanup', 'Bed cleanup assumption')}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field
                    label={t('stats2.expectedClear', 'Expected clear (min)')}
                    hint={t('stats2.clearHint', 'Staffed-hours clear time used by capacity')}
                  >
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className={inputClass}
                      value={globals.expected_plate_clear_minutes}
                      onChange={(e) =>
                        updateGlobal(
                          'expected_plate_clear_minutes',
                          Math.max(0, Math.floor(Number(e.target.value) || 0)),
                        )
                      }
                    />
                  </Field>
                  <Field label={t('stats2.timezone', 'Timezone')}>
                    <SelectInput
                      value={globals.timezone}
                      onChange={(e) => updateGlobal('timezone', e.target.value)}
                    >
                      {timezoneOptionsFor(globals.timezone).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                </div>
              </Panel>
            </div>

            <Panel title={t('stats2.panelBufferStock', 'Ready buffer targets')}>
              <p className="mb-3 text-xs text-bambu-gray leading-relaxed">
                {t(
                  'stats2.bufferTargetsHint',
                  'Buffer stock timeline: keep at least this many ready on hand. 0 = no buffer for that part. Catch-up uses whole plates.',
                )}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(['BUT', 'KNB', 'TOP', 'BOT'] as const).map((code) => (
                  <Field key={code} label={code}>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className={inputClass}
                      value={globals.ready_buffer_targets?.[code] ?? (code === 'BUT' ? 80 : code === 'KNB' ? 50 : 0)}
                      onChange={(e) => {
                        const next = Math.max(0, Math.floor(Number(e.target.value) || 0));
                        updateGlobal('ready_buffer_targets', {
                          ...(globals.ready_buffer_targets || { BUT: 80, KNB: 50, TOP: 0, BOT: 0 }),
                          [code]: next,
                        });
                      }}
                      aria-label={`${code} ready buffer`}
                    />
                  </Field>
                ))}
              </div>
            </Panel>
            <SaveActions
              saving={saving}
              dirty={scheduleDirty}
              saved={savedFlash}
              onSave={() => void saveSchedule()}
              label={t('stats2.saveGlobals', 'Save line start & clear')}
            />
          </div>

          <div className="lg:col-span-2 min-w-0">
          <Panel title={t('stats2.weeklyHours', 'Weekly printer hours')}>
            <div className="flex flex-wrap gap-2 mb-1">
              <button
                type="button"
                onClick={() => setDays(weekdayDefaults())}
                className="inline-flex items-center gap-1.5 rounded-lg border border-bambu-dark-tertiary px-2.5 py-1.5 text-xs text-bambu-gray-light hover:text-white hover:border-bambu-green/40"
              >
                <Copy className="w-3.5 h-3.5" />
                {t('stats2.applyWeekdayDefaults', 'Apply Mon–Fri 8:00 AM–5:00 PM')}
              </button>
            </div>

            <div className="divide-y divide-bambu-dark-tertiary/50">
              {days.map((d, idx) => (
                <div
                  key={d.day_of_week}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 first:pt-1 last:pb-1"
                >
                  <label className="flex w-[4.5rem] shrink-0 items-center gap-2 text-sm text-white">
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      onChange={(e) => updateDay(idx, { enabled: e.target.checked })}
                      className="h-4 w-4 accent-bambu-green"
                      aria-label={`${DAY_LABELS[idx]} staffed`}
                    />
                    <span className="font-medium">{DAY_LABELS[idx]}</span>
                  </label>

                  {d.enabled ? (
                    <>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <AmPmTimeSelect
                          value={d.start_time}
                          onChange={(hhmm) => updateDayTime(idx, 'start_time', hhmm)}
                          aria-label={`${DAY_LABELS[idx]} start`}
                        />
                        <span className="text-bambu-gray" aria-hidden>
                          →
                        </span>
                        <AmPmTimeSelect
                          value={d.end_time}
                          onChange={(hhmm) => updateDayTime(idx, 'end_time', hhmm)}
                          aria-label={`${DAY_LABELS[idx]} end`}
                        />
                      </div>
                      <label className="ml-auto flex items-center gap-2 text-xs text-bambu-gray">
                        Ops
                        <input
                          type="number"
                          min={1}
                          step={1}
                          className={`${inputClass} w-14 py-2`}
                          value={d.operator_count}
                          onChange={(e) =>
                            updateDay(idx, {
                              operator_count: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                            })
                          }
                        />
                      </label>
                    </>
                  ) : (
                    <span className="text-xs text-bambu-gray">Off</span>
                  )}
                </div>
              ))}
            </div>

            <div className="pt-1">
              <SaveActions
                saving={saving}
                dirty={scheduleDirty}
                saved={savedFlash}
                onSave={() => void saveSchedule()}
                label={t('stats2.saveSchedule', 'Save schedule & line settings')}
              />
            </div>
          </Panel>
          </div>

          <div className="lg:col-span-2 min-w-0">
            <Panel title={t('stats2.printerTimeBlocks', 'Printer time blocks (must be free)')}>
              <p className="mb-3 text-xs leading-relaxed text-bambu-gray">
                {t(
                  'stats2.printerTimeBlocksHint',
                  'Recurring weekly windows when a printer must stay idle. The weekly schedule will not place a print that overlaps these blocks (including clear time).',
                )}
              </p>
              {!printers.length ? (
                <p className="text-sm text-bambu-gray">
                  {t('stats2.noPrintersForBlocks', 'No active printers to configure.')}
                </p>
              ) : (
                <>
                  <Field label={t('stats2.blockPrinter', 'Printer')}>
                    <SelectInput
                      value={blockPrinterId ?? ''}
                      onChange={(e) => selectBlockPrinter(Number(e.target.value))}
                    >
                      {printers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.model ? ` · ${p.model}` : ''}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>

                  <div className="mt-3 space-y-2">
                    {blockDrafts.length === 0 ? (
                      <p className="text-sm text-bambu-gray">
                        {t('stats2.noBlocksYet', 'No reserved windows for this printer.')}
                      </p>
                    ) : (
                      blockDrafts.map((b) => (
                        <div
                          key={b.key}
                          className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border border-bambu-dark-tertiary/60 px-2.5 py-2"
                        >
                          <SelectInput
                            value={b.day_of_week}
                            onChange={(e) =>
                              updateBlockDraft(b.key, { day_of_week: Number(e.target.value) })
                            }
                            aria-label="Day"
                            className="w-[5.5rem]"
                          >
                            {DAY_LABELS.map((label, idx) => (
                              <option key={label} value={idx}>
                                {label}
                              </option>
                            ))}
                          </SelectInput>
                          <AmPmTimeSelect
                            value={b.start_time}
                            onChange={(hhmm) => updateBlockDraft(b.key, { start_time: hhmm })}
                            aria-label="Block start"
                          />
                          <span className="text-bambu-gray" aria-hidden>
                            →
                          </span>
                          <AmPmTimeSelect
                            value={b.end_time}
                            onChange={(hhmm) => updateBlockDraft(b.key, { end_time: hhmm })}
                            aria-label="Block end"
                          />
                          <input
                            type="text"
                            className={`${inputClass} min-w-[8rem] flex-1 py-2`}
                            placeholder={t('stats2.blockLabel', 'Label (optional)')}
                            value={b.label}
                            onChange={(e) => updateBlockDraft(b.key, { label: e.target.value })}
                          />
                          <button
                            type="button"
                            onClick={() => removeBlockDraft(b.key)}
                            className="rounded-lg px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10"
                          >
                            {t('common.remove', 'Remove')}
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={addBlockDraft}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-bambu-dark-tertiary px-2.5 py-1.5 text-xs text-bambu-gray-light hover:text-white hover:border-bambu-green/40"
                    >
                      {t('stats2.addTimeBlock', 'Add time block')}
                    </button>
                    <SaveActions
                      saving={savingBlocks}
                      dirty={blocksDirty}
                      saved={savedFlash && !blocksDirty}
                      onSave={() => void saveTimeBlocks()}
                      label={t('stats2.saveTimeBlocks', 'Save printer time blocks')}
                    />
                  </div>
                </>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2 min-w-0">
          <Panel title={t('stats2.deviceRecipe', 'Device recipe (Part Models)')}>
            {!recipe?.lines.length ? (
              <p className="text-sm text-bambu-gray">No recipe lines yet.</p>
            ) : (
              <>
                <p className="mb-3 text-xs leading-relaxed text-bambu-gray">
                  Capacity and the weekly schedule use every production file that matches an active
                  printer model — not a single preferred slot. Add files under File Manager → Production.
                </p>
                {recipe.lines.every((l) => l.discovered_slots.length === 0) && (
                  <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                    No matching print files yet. Drop production 3MFs into the printer-model folders under File
                    Manager → Production (A1, H2S, X1C, …) using names like{' '}
                    <span className="font-mono text-amber-800 dark:text-amber-50">BOT x5 - 1.8.2 - H2S.3mf</span>. Stats 2 scans those
                    folders for each recipe part code.
                  </p>
                )}
                <ul className="divide-y divide-bambu-dark-tertiary/50">
                  {recipe.lines.map((line) => {
                    const models = [...new Set(line.discovered_slots.map((s) => s.printer_model).filter(Boolean))];
                    return (
                      <li key={line.id} className="min-w-0 space-y-2 py-4 first:pt-1 last:pb-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-medium text-white">
                            {line.part_code} ×{Math.floor(line.qty_per_device)}
                          </span>
                          <span className="text-xs text-bambu-gray truncate">{line.part_name}</span>
                        </div>
                        {line.discovered_slots.length === 0 ? (
                          <p className="rounded-lg border border-dashed border-bambu-dark-tertiary px-3 py-2.5 text-sm text-bambu-gray">
                            No matching files in Production / {line.part_code} folders yet
                          </p>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="text-[11px] uppercase tracking-wide text-bambu-gray">
                              {models.length} model{models.length === 1 ? '' : 's'} · {line.discovered_slots.length}{' '}
                              file{line.discovered_slots.length === 1 ? '' : 's'}
                            </div>
                            <ul className="space-y-1 text-xs text-bambu-gray-light">
                              {line.discovered_slots.map((s) => (
                                <li key={s.slot_id} className="truncate font-mono">
                                  <span className="text-white/80">{s.printer_model}</span>
                                  {' · '}
                                  {s.filename || `${line.part_code} x${s.quantity}`}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Panel>
          </div>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return body;
  }

  return (
    <div
      id="card-stats2-capacity"
      className="rounded-2xl border border-bambu-dark-tertiary bg-bambu-dark-secondary overflow-hidden"
    >
      <div className="flex items-center gap-2 px-5 sm:px-6 pt-5 pb-2">
        <CalendarClock className="w-4 h-4 text-bambu-green shrink-0" />
        <h3 className="text-base font-semibold text-white">
          {t('stats2.capacityConfig', 'Stats 2 — Capacity config')}
        </h3>
      </div>
      <div className="px-5 sm:px-6 pb-6 pt-2">{body}</div>
    </div>
  );
}
