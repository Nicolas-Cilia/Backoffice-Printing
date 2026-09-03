/**
 * Stats 2 — True Capacity page.
 * A calm, fixed Stack/Grid layout (NOT a draggable dashboard) that matches the
 * stats2-capacity-mockup canvas: a centered max-width column with generous
 * gutters, soft section cards, airy hero, compact confidence callout, and a
 * recharts quality hub. No drag grips, no hide/minimize chrome.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Loader2, Settings2, ChevronDown, TriangleAlert } from 'lucide-react';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { api, type Stats2PrintPlan, type Stats2ReadinessPart } from '../api/client';
import { ScrollFadeContainer } from '../components/ScrollFadeContainer';
import { Stats2CapacityConfigCard } from '../components/Stats2CapacityConfigCard';
import { useTheme } from '../contexts/ThemeContext';
import { getCurrencySymbol } from '../utils/currency';
import { RING_GAP_ANGLE, ringCornerRadiusForSlice } from './filamentTrackingChart';
import {
  GANTT_AXIS_END,
  GANTT_AXIS_START,
  buildContinuationSegments,
  buildJobSegments,
  ganttAxisLabels,
  priorJobsForContinuation,
  scheduleDayPartStats,
} from './stats2Gantt';
import { yieldWhereUnitsWent } from './stats2Yield';

// ── Chart palette (recharts needs concrete colours; axis/grid follow theme CSS vars) ──
type QualityTab = 'print' | 'discard' | 'rework';

const ACCENT = '#07bcec';
/** Quality category palette — saturated enough to read on dark charts (avoid pale rose/sky). */
const QUALITY_PASSED = '#22c55e';
const QUALITY_PRINT = '#ef4444';
const QUALITY_DISCARD = '#f59e0b';
const QUALITY_REWORK = '#3b82f6';
const PIE_COLORS = [QUALITY_PRINT, QUALITY_DISCARD, QUALITY_REWORK, '#a78bfa', QUALITY_PASSED, '#ec4899', '#94a3b8', '#eab308'];
const TAB_COLORS: Record<QualityTab, string> = {
  print: QUALITY_PRINT,
  discard: QUALITY_DISCARD,
  rework: QUALITY_REWORK,
};

type ChartTheme = {
  axis: string;
  grid: string;
  cursor: string;
  accent: string;
};

function readCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function useChartTheme(): ChartTheme {
  const { resolvedMode } = useTheme();
  return useMemo(
    () => ({
      axis: readCssVar('--text-muted', '#808080'),
      grid: readCssVar('--border-color', resolvedMode === 'dark' ? '#3d3d3d' : '#d4d4d4'),
      cursor: resolvedMode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
      accent: readCssVar('--accent', ACCENT),
    }),
    [resolvedMode],
  );
}

/** Theme-aware tooltip — Recharts default styles ignore page light/dark tokens. */
function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number | string;
    color?: string;
    dataKey?: string | number;
  }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-2 text-xs shadow-lg">
      {label != null && String(label) !== '' ? (
        <div className="mb-1 font-medium text-white">{label}</div>
      ) : null}
      <ul className="space-y-0.5">
        {payload.map((entry, i) => {
          const name = entry.name ?? (entry.dataKey != null ? String(entry.dataKey) : '');
          return (
            <li key={i} className="flex items-center gap-2 text-bambu-gray-light">
              {entry.color ? (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
              ) : null}
              <span className="min-w-0">
                {name ? <span>{name}: </span> : null}
                <span className="font-medium text-white">{entry.value}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Gantt part colours (kept close to the canvas mock).
const PART_COLORS: Record<string, string> = {
  TOP: 'bg-sky-500/80',
  BOT: 'bg-amber-500/80',
  KNB: 'bg-emerald-500/80',
  BUT: 'bg-violet-500/80',
};

type QualityResp = {
  total?: number;
  reasons?: Array<{ reason: string; count: number }>;
  by_printer?: Array<{
    printer_id?: number | null;
    printer_name?: string;
    count: number;
  }>;
  by_part?: Array<{
    part_code?: string;
    count: number;
  }>;
  daily?: Array<{ date: string; total: number }>;
};

function lookbackFromPreset(preset: string): number {
  if (preset === 'last-7') return 7;
  if (preset === 'this-month') return 31;
  return 30;
}

/** Whole devices only — you can't ship 1.5 devices. Floor so we never overstate. */
function fmtDevices(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.floor(n).toString();
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.round(n).toString();
}

function wholeDevices(n: number | null | undefined): number {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.floor(n);
}

type CapacityHistoryPoint = {
  date: string;
  devices_per_day_realistic?: number;
  devices_per_day_theoretical?: number;
  devices_shipped?: number;
};

/** Staffed-minute durations: under 1h → "13 min"; else "1h 5m". */
function fmtDurationMinutes(minutes: number | null | undefined): string {
  if (minutes == null || Number.isNaN(minutes)) return '—';
  const total = Math.max(0, minutes);
  if (total < 1) return '< 1 min';
  const rounded = Math.round(total);
  if (rounded < 60) return `${rounded} min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function hhmm(iso: string | null | undefined): string {
  if (!iso || iso.length < 16) return '—';
  return iso.slice(11, 16);
}

function minuteOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

// ── Reusable presentational atoms ──────────────────────────────────────────

type Tone = 'neutral' | 'warning' | 'danger' | 'info' | 'success' | 'accent';

const TONE_PILL: Record<Tone, string> = {
  neutral: 'bg-bambu-dark-tertiary text-bambu-gray-light',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  danger: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200',
  success: 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200',
  accent: 'bg-bambu-green/20 text-bambu-green',
};

function Pill({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_PILL[tone]} ${className}`}>
      {children}
    </span>
  );
}

function TogglePill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? 'bg-bambu-green/20 text-bambu-green ring-1 ring-bambu-green/40'
          : 'bg-bambu-dark-tertiary text-bambu-gray-light hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

const STAT_TONE: Record<Tone, string> = {
  neutral: 'text-white',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  info: 'text-blue-600 dark:text-blue-400',
  success: 'text-green-600 dark:text-green-400',
  accent: 'text-bambu-green',
};

function Stat({ value, label, tone = 'neutral' }: { value: ReactNode; label: string; tone?: Tone }) {
  return (
    <div className="space-y-0.5">
      <div className={`text-2xl font-semibold leading-none ${STAT_TONE[tone]}`}>{value}</div>
      <div className="text-xs text-bambu-gray">{label}</div>
    </div>
  );
}

const CALLOUT_TONE: Record<Tone, string> = {
  neutral: 'border-bambu-dark-tertiary bg-bambu-dark/40 text-bambu-gray-light',
  warning:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100',
  danger:
    'border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100',
  info: 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-100',
  success:
    'border-green-300 bg-green-50 text-green-900 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-100',
  accent: 'border-bambu-green/40 bg-bambu-green/10 text-bambu-green',
};

function Callout({ tone = 'neutral', title, children }: { tone?: Tone; title: string; children?: ReactNode }) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs ${CALLOUT_TONE[tone]}`}>
      <div className="font-semibold">{title}</div>
      {children != null && <div className="mt-1 leading-relaxed opacity-90">{children}</div>}
    </div>
  );
}

type UsageSegment = { id: string; value: number; className: string; label: string };

function UsageBar({
  segments,
  total,
  leftLabel,
  rightLabel,
}: {
  segments: UsageSegment[];
  total: number;
  leftLabel?: string;
  rightLabel?: string;
}) {
  return (
    <div className="space-y-1.5">
      {(leftLabel || rightLabel) && (
        <div className="flex justify-between text-xs">
          <span className="text-bambu-gray-light">{leftLabel}</span>
          <span className="text-bambu-gray">{rightLabel}</span>
        </div>
      )}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bambu-dark-tertiary">
        {segments.map((s) =>
          total > 0 && s.value > 0 ? (
            <div
              key={s.id}
              className={s.className}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value}`}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────

function truncateTick(value: string, max = 14) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Top-N horizontal bars; remainder rolled into one "Other" row so 20–30 labels stay readable. */
function BarByCategory({
  categories,
  data,
  color,
  maxBars = 10,
  otherLabel = 'Other',
  seriesName = 'Events',
}: {
  categories: string[];
  data: number[];
  color: string;
  maxBars?: number;
  otherLabel?: string;
  seriesName?: string;
}) {
  const chartTheme = useChartTheme();
  const sorted = categories
    .map((name, i) => ({ name, value: data[i] ?? 0 }))
    .sort((a, b) => b.value - a.value);

  const truncated = sorted.length > maxBars;
  const head = truncated ? sorted.slice(0, maxBars - 1) : sorted;
  const rest = truncated ? sorted.slice(maxBars - 1) : [];
  const chartData = truncated
    ? [...head, { name: `${otherLabel} (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0) }]
    : head;

  const height = Math.min(280, Math.max(140, chartData.length * 26 + 20));

  return (
    <div className="space-y-1">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} horizontal={false} />
          <XAxis
            type="number"
            stroke={chartTheme.axis}
            fontSize={11}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            stroke={chartTheme.axis}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={108}
            tickFormatter={(v: string) => truncateTick(String(v))}
            interval={0}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: chartTheme.cursor }} />
          <Bar dataKey="value" name={seriesName} fill={color} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      {truncated ? (
        <p className="text-[11px] text-bambu-gray">
          Top {maxBars - 1} of {sorted.length} · rest grouped as {otherLabel} · Export for full list
        </p>
      ) : null}
    </div>
  );
}

function ReasonSliceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: { reason: string; count: number; fill?: string } }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 shadow-lg">
      <div className="flex items-center gap-2">
        {row.fill ? (
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.fill }} />
        ) : null}
        <span className="text-sm font-medium text-white">{row.reason}</span>
      </div>
      <div className="mt-0.5 text-xs text-bambu-gray">{row.count}</div>
    </div>
  );
}

/** Same ring geometry as Filament Tracking's printer-share donut. */
function ReasonPie({ data }: { data: Array<{ reason: string; count: number }> }) {
  const [hoveredReason, setHoveredReason] = useState<string | null>(null);
  const rows = data.filter((r) => r.count > 0);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const pieRows = rows.map((row, i) => ({
    ...row,
    fill: PIE_COLORS[i % PIE_COLORS.length],
  }));

  return (
    // Center the block when short; donut stays put and only the legend scrolls when tall.
    <div className="flex h-full min-h-0 flex-col justify-center overflow-hidden">
      <div className="grid max-h-full min-h-0 w-full grid-rows-[auto_minmax(0,1fr)] gap-5 overflow-hidden">
        <div
          className="printer-share-chart relative mx-auto size-[10.5rem] shrink-0 overflow-visible"
          role="img"
          aria-label={
            total > 0
              ? pieRows.map((row) => `${row.reason} ${row.count}`).join(', ')
              : 'No reason data'
          }
        >
          {pieRows.length > 0 && (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieRows}
                  dataKey="count"
                  nameKey="reason"
                  cx="50%"
                  cy="50%"
                  innerRadius="62%"
                  outerRadius="95%"
                  paddingAngle={pieRows.length > 1 ? RING_GAP_ANGLE : 0}
                  cornerRadius={0}
                  startAngle={90}
                  endAngle={-270}
                  stroke="none"
                  isAnimationActive={false}
                  onMouseEnter={(entry) => {
                    const reason = (entry as { reason?: string } | undefined)?.reason;
                    setHoveredReason(reason ?? null);
                  }}
                  onMouseLeave={() => setHoveredReason(null)}
                >
                  {pieRows.map((row) => {
                    // Recharts honors Cell cornerRadius at runtime; typings omit it.
                    const cellProps = {
                      key: row.reason,
                      fill: row.fill,
                      cornerRadius: ringCornerRadiusForSlice(row.count, total, pieRows.length),
                      style: { cursor: 'pointer' as const, outline: 'none' },
                    };
                    return <Cell {...(cellProps as ComponentProps<typeof Cell>)} />;
                  })}
                </Pie>
                <Tooltip
                  content={<ReasonSliceTooltip />}
                  isAnimationActive={false}
                  animationDuration={0}
                  allowEscapeViewBox={{ x: true, y: true }}
                  wrapperStyle={{ zIndex: 30, outline: 'none', pointerEvents: 'none', transition: 'none' }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <div className="text-lg font-bold leading-none text-white">{total}</div>
            <div className="mt-1 text-[11px] text-bambu-gray">events</div>
          </div>
        </div>
        <ScrollFadeContainer
          className="overflow-y-auto pr-1"
          fadeFromClassName="from-bambu-dark-secondary"
        >
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {pieRows.map((row) => (
              <li
                key={row.reason}
                className={`flex min-w-0 items-start gap-2.5 transition-opacity ${
                  hoveredReason != null && hoveredReason !== row.reason ? 'opacity-40' : ''
                }`}
              >
                <span
                  className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: row.fill }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm leading-snug text-white" title={row.reason}>
                    {row.reason}
                  </div>
                  <div className="mt-0.5 text-xs tabular-nums text-bambu-gray">
                    {row.count}
                    {total > 0 ? ` · ${Math.round((row.count / total) * 100)}%` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </ScrollFadeContainer>
      </div>
    </div>
  );
}

// ── Gantt ───────────────────────────────────────────────────────────────────

function GanttDay({
  day,
  priorDays,
}: {
  day: Stats2PrintPlan['days'][0];
  priorDays: Stats2PrintPlan['days'];
}) {
  // Hooks must run unconditionally (early returns for empty/unstaffed days below).
  const lanesRef = useRef<HTMLDivElement>(null);
  const [lineHeightPx, setLineHeightPx] = useState(0);

  const axisStart = GANTT_AXIS_START;
  const axisEnd = GANTT_AXIS_END;
  const span = axisEnd - axisStart;
  const staffedStart = day.staffed_windows?.length
    ? (() => {
        const [h, m] = day.staffed_windows[0].start_time.split(':').map(Number);
        return h * 60 + m;
      })()
    : 8 * 60;
  const staffedEnd = day.staffed_windows?.length
    ? (() => {
        const [h, m] = day.staffed_windows[day.staffed_windows.length - 1].end_time.split(':').map(Number);
        return h * 60 + m;
      })()
    : 17 * 60;

  const sortedLanes = [...day.lanes].sort((a, b) => {
    const ah = a.hypothetical ? 1 : 0;
    const bh = b.hypothetical ? 1 : 0;
    if (ah !== bh) return ah - bh;
    const am = a.printer_model.localeCompare(b.printer_model);
    if (am !== 0) return am;
    return a.printer_name.localeCompare(b.printer_name);
  });

  // Only mount ScrollFadeContainer when nested scrolling is on. Its
  // overscroll-behavior:contain would otherwise trap page wheel events even
  // with ≤15 lanes (no height cap / no inner scroll).
  const nestScroll = sortedLanes.length > 15;
  const showTimeline = day.staffed_minutes > 0 && day.lanes.length > 0;

  // Measure the real lane stack height. `inset-y-0` alone can end up sizing to the
  // scrollport (not content) when a parent has overflow, which truncates the guide mid-row.
  useLayoutEffect(() => {
    if (!showTimeline) {
      setLineHeightPx(0);
      return;
    }
    const el = lanesRef.current;
    if (!el) return;
    const sync = () => setLineHeightPx(el.scrollHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showTimeline, sortedLanes.length, day.date, day.line_start_at, nestScroll]);

  if (day.staffed_minutes <= 0) {
    return (
      <Callout tone="neutral" title="Unstaffed">
        No operator hours — timeline empty. Prints that finish overnight wait for the next staffed clear window; line
        start still applies on the next staffed day.
      </Callout>
    );
  }

  if (!day.lanes.length) {
    return (
      <Callout tone="info" title="No printer lanes yet">
        Add active printers (or production files for their models) to see the weekly schedule.
      </Callout>
    );
  }

  const hatchLeft =
    staffedStart > axisStart
      ? {
          left: 0,
          width: ((Math.min(staffedStart, axisEnd) - axisStart) / span) * 100,
        }
      : null;
  const hatchRight =
    staffedEnd < axisEnd
      ? {
          left: ((Math.max(staffedEnd, axisStart) - axisStart) / span) * 100,
          width: ((axisEnd - Math.max(staffedEnd, axisStart)) / span) * 100,
        }
      : null;

  const lineMin = minuteOfDay(day.line_start_at);
  const showLineStart = lineMin >= axisStart && lineMin <= axisEnd;
  const lineLeftPct = ((lineMin - axisStart) / span) * 100;
  const lineStartTitle = `Line start ${hhmm(day.line_start_at)} — ready-for-assembly deadline`;

  const laneRows = sortedLanes.map((lane) => {
    const hyp = Boolean(lane.hypothetical);
    const priorJobs = priorJobsForContinuation(priorDays, lane.printer_id, day.date, axisStart);
    const segments = [
      ...priorJobs.flatMap((job, idx) =>
        buildContinuationSegments(job, day.date, axisStart, axisEnd, span, idx),
      ),
      ...lane.jobs.flatMap((job, idx) =>
        buildJobSegments(job, day.date, axisStart, axisEnd, span, idx),
      ),
    ];
    return (
      <div key={lane.printer_id} className="flex h-8 items-center gap-3">
        <div className="w-24 shrink-0 overflow-hidden text-xs leading-tight">
          <div
            className={`truncate font-medium ${hyp ? 'text-bambu-gray-light' : 'text-white'}`}
            title={lane.printer_name}
          >
            {lane.printer_name}
          </div>
          <div className="truncate text-bambu-gray">
            {lane.printer_model}
            {hyp ? (
              <span className="ml-1 text-[10px] uppercase tracking-wide text-bambu-green/80">
                what-if
              </span>
            ) : null}
          </div>
        </div>
        <div
          className={`relative h-8 min-w-0 flex-1 overflow-hidden rounded-md bg-bambu-dark ${
            hyp
              ? 'border border-dashed border-bambu-green/40'
              : 'border border-bambu-dark-tertiary'
          }`}
        >
          {hatchLeft ? (
            <div
              className="absolute inset-y-0 bg-[repeating-linear-gradient(-45deg,transparent,transparent_4px,rgba(128,128,128,0.18)_4px,rgba(128,128,128,0.18)_8px)]"
              style={{ left: `${hatchLeft.left}%`, width: `${hatchLeft.width}%` }}
            />
          ) : null}
          {hatchRight ? (
            <div
              className="absolute inset-y-0 bg-[repeating-linear-gradient(-45deg,transparent,transparent_4px,rgba(128,128,128,0.18)_4px,rgba(128,128,128,0.18)_8px)]"
              style={{ left: `${hatchRight.left}%`, width: `${hatchRight.width}%` }}
            />
          ) : null}
          {(lane.time_blocks || []).map((block, bi) => {
            const [sh, sm] = block.start_time.split(':').map(Number);
            const [eh, em] = block.end_time.split(':').map(Number);
            const bStart = Math.max(axisStart, sh * 60 + sm);
            const bEnd = Math.min(axisEnd, eh * 60 + em);
            if (bEnd <= bStart) return null;
            return (
              <div
                key={`tb-${lane.printer_id}-${bi}`}
                className="absolute inset-y-0 z-[2] bg-rose-500/25 ring-1 ring-inset ring-rose-400/40"
                style={{
                  left: `${((bStart - axisStart) / span) * 100}%`,
                  width: `${((bEnd - bStart) / span) * 100}%`,
                }}
                title={
                  block.label
                    ? `Reserved: ${block.label} (${block.start_time}–${block.end_time})`
                    : `Reserved / must be free (${block.start_time}–${block.end_time})`
                }
              />
            );
          })}
          {segments.map((seg) => (
            <div
              key={seg.key}
              className={`absolute top-1 bottom-1 z-[1] flex items-center px-1.5 text-[10px] text-white ${
                PART_COLORS[seg.partCode] || 'bg-slate-500'
              } ${seg.rounded} ${seg.wrap ? 'opacity-90 ring-1 ring-inset ring-white/25' : ''} ${
                hyp ? 'opacity-85' : ''
              }`}
              style={{
                left: `${seg.leftPct}%`,
                width: `${Math.min(seg.widthPct, 100 - seg.leftPct)}%`,
              }}
              title={seg.title}
            >
              {seg.showLabel ? <span className="truncate">{seg.label}</span> : null}
            </div>
          ))}
        </div>
      </div>
    );
  });

  const lanesBody = (
    <div ref={lanesRef} className="relative flex flex-col gap-2.5">
      {showLineStart && lineHeightPx > 0 ? (
        <div
          className="pointer-events-none absolute top-0 z-20"
          style={{ left: 'calc(6rem + 0.75rem)', right: 0, height: lineHeightPx }}
          title={lineStartTitle}
          aria-hidden
        >
          <div
            className="absolute top-0 w-1 -translate-x-1/2 bg-blue-400/40"
            style={{ left: `${lineLeftPct}%`, height: lineHeightPx }}
          />
        </div>
      ) : null}
      {laneRows}
    </div>
  );

  return (
    <div className="space-y-2.5">
      <div className="flex justify-between overflow-x-auto px-24 text-[10px] text-bambu-gray">
        {ganttAxisLabels().map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      {nestScroll ? (
        <div className="h-[min(39rem,70vh)] min-h-0">
          <ScrollFadeContainer className="overflow-x-auto pr-1" fadeFromClassName="from-bambu-dark">
            {lanesBody}
          </ScrollFadeContainer>
        </div>
      ) : (
        <div className="overflow-x-auto pr-1">{lanesBody}</div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-[10px] text-bambu-gray">
        {(['TOP', 'BOT', 'KNB', 'BUT'] as const).map((part) => (
          <span key={part} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${PART_COLORS[part]}`} />
            {part}
          </span>
        ))}
        <span className="hidden h-3 w-px bg-bambu-dark-tertiary sm:inline-block" aria-hidden />
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-1 bg-blue-400/40" aria-hidden />
          Line start ({hhmm(day.line_start_at)}) — ready for assembly
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm border border-bambu-dark-tertiary bg-[repeating-linear-gradient(-45deg,transparent,transparent_2px,rgba(128,128,128,0.35)_2px,rgba(128,128,128,0.35)_4px)]"
            aria-hidden
          />
          Unstaffed hours
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm bg-rose-500/25 ring-1 ring-inset ring-rose-400/40"
            aria-hidden
          />
          Reserved / must be free
        </span>
        <span className="flex items-center gap-1.5">
          <span className="flex items-center gap-0.5" aria-hidden>
            {(['TOP', 'BOT', 'KNB', 'BUT'] as const).map((part) => (
              <span
                key={part}
                className={`inline-block h-2.5 w-2 rounded-sm opacity-90 ring-1 ring-inset ring-white/25 ${PART_COLORS[part]}`}
              />
            ))}
          </span>
          Overnight from prior day (ringed)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-bambu-green/40 bg-bambu-dark"
            aria-hidden
          />
          What-if printer
        </span>
      </div>
    </div>
  );
}

// ── Readiness table (airy) ──────────────────────────────────────────────────

const TH = 'py-2 px-2 text-left font-medium text-bambu-gray';
const TD = 'py-2.5 px-2 text-white';

type ReliabilityPrinter = {
  printer_id: number;
  printer_name: string;
  jobs: number;
  job_success?: number | null;
};

function PrinterReliabilityTable({ printers }: { printers: ReliabilityPrinter[] }) {
  const { t } = useTranslation();
  const scrollable = printers.length > 8;
  // Optimistic: assume overflow until ScrollFadeContainer measures (avoids a flash).
  const [hasMoreBelow, setHasMoreBelow] = useState(scrollable);

  const table = (
    <table className="w-full border-collapse text-xs">
      <thead className={scrollable ? 'sticky top-0 z-10 bg-bambu-dark-secondary' : undefined}>
        <tr className="border-b border-bambu-dark-tertiary">
          <th className={TH}>Printer</th>
          <th className={`${TH} text-right`}>Jobs</th>
          <th className={`${TH} text-right`}>Success</th>
          <th className={`${TH} text-right`}>Rank</th>
        </tr>
      </thead>
      <tbody>
        {printers.map((p, i) => (
          <tr key={p.printer_id} className="border-b border-bambu-dark-tertiary/50">
            <td className={`${TD} ${i === 0 ? 'text-emerald-700 dark:text-emerald-300' : ''}`}>
              {p.printer_name}
            </td>
            <td className={`${TD} text-right`}>{p.jobs}</td>
            <td className={`${TD} text-right`}>
              {p.job_success != null ? `${Math.round(Number(p.job_success) * 100)}%` : '—'}
            </td>
            <td className={`${TD} text-right text-bambu-gray`}>#{i + 1}</td>
          </tr>
        ))}
        {!printers.length && (
          <tr>
            <td colSpan={4} className="py-3 text-center text-bambu-gray">
              No reliability data in range.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <div className="space-y-2">
      {scrollable ? (
        <div className="h-72">
          <ScrollFadeContainer
            className="pr-1"
            fadeFromClassName="from-bambu-dark-secondary"
            onHasMoreChange={setHasMoreBelow}
          >
            {table}
          </ScrollFadeContainer>
        </div>
      ) : (
        table
      )}
      {scrollable && hasMoreBelow && (
        <p className="flex items-center justify-center gap-1 text-[11px] text-bambu-gray">
          <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
          {t('stats2.printerReliabilityScrollHint', 'Scroll for all {{count}} printers', {
            count: printers.length,
          })}
        </p>
      )}
    </div>
  );
}

function ReadinessTable({ parts, detailed }: { parts: Stats2ReadinessPart[]; detailed: boolean }) {
  if (!parts.length) {
    return <p className="text-sm text-bambu-gray">No parts on the floor in range.</p>;
  }
  if (detailed) {
    return (
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-bambu-dark-tertiary">
            <th className={TH}>Part</th>
            <th className={`${TH} text-right`}>In WIP</th>
            <th className={`${TH} text-right`}>Staged</th>
            <th className={`${TH} text-right`}>Initial QC ↑</th>
            <th className={`${TH} text-right`}>Rework ≠</th>
            <th className={`${TH} text-right`}>Linked ⌀</th>
            <th className={`${TH} text-right`}>Ready now</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr key={p.part_code} className="border-b border-bambu-dark-tertiary/50">
              <td className={`${TD} font-medium ${p.is_binding ? 'text-amber-700 dark:text-amber-300' : ''}`}>{p.part_code}</td>
              <td className={`${TD} text-right`}>{p.in_wip}</td>
              <td className={`${TD} text-right`}>{p.staged_for_prod}</td>
              <td className={`${TD} text-right`}>{p.initial_qc_finished}</td>
              <td className={`${TD} text-right`}>{p.rework_sanding}</td>
              <td className={`${TD} text-right`}>{p.linked}</td>
              <td className={`${TD} text-right font-semibold ${p.is_binding ? 'text-amber-700 dark:text-amber-300' : ''}`}>{p.ready_now}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-bambu-dark-tertiary">
          <th className={TH}>Part</th>
          <th className={`${TH} text-right`}>Ready now</th>
          <th className={`${TH} text-right`}>Upstream</th>
          <th className={`${TH} text-right`}>Per device</th>
          <th className={`${TH} text-right`}>Devices covered</th>
        </tr>
      </thead>
      <tbody>
        {parts.map((p) => (
          <tr key={p.part_code} className="border-b border-bambu-dark-tertiary/50">
            <td className={`${TD} font-medium ${p.is_binding ? 'text-amber-700 dark:text-amber-300' : ''}`}>{p.part_code}</td>
            <td className={`${TD} text-right font-semibold ${p.is_binding ? 'text-amber-700 dark:text-amber-300' : ''}`}>{p.ready_now}</td>
            <td className={`${TD} text-right`}>{p.upstream}</td>
            <td className={`${TD} text-right`}>{p.qty_per_device}</td>
            <td className={`${TD} text-right`}>{fmtDevices(p.devices_covered)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Section shell (fixed layout — no drag grips, no dashboard chrome) ─────────

function Section({
  title,
  trailing,
  children,
  className,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-bambu-dark-tertiary/70 bg-bambu-dark-secondary/70 ${className ?? ''}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5 pb-2">
        <h2 className="text-base font-medium text-white tracking-tight">{title}</h2>
        {trailing ?? null}
      </header>
      <div className="px-6 pb-6 pt-2">{children}</div>
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function Stats2Page() {
  const { t } = useTranslation();
  const chartTheme = useChartTheme();
  const [datePreset, setDatePreset] = useState('last-30');
  const [partFilter, setPartFilter] = useState('all');
  const [readinessMode, setReadinessMode] = useState<'summary' | 'detailed'>('summary');
  const [dayIndex, setDayIndex] = useState(() => (new Date().getDay() === 0 ? 6 : new Date().getDay() - 1));
  /** Draft in the input — does not hit the API until Apply. */
  const [targetDraft, setTargetDraft] = useState<string>('');
  /** Applied what-if (undefined = schedule at measured capacity). */
  const [appliedTarget, setAppliedTarget] = useState<number | undefined>(undefined);
  const [timelineMode, setTimelineMode] = useState<'capacity' | 'buffer'>('capacity');
  const [configOpen, setConfigOpen] = useState(false);
  const [capacityWhyOpen, setCapacityWhyOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [qualityTab, setQualityTab] = useState<QualityTab>('print');

  const lookback = lookbackFromPreset(datePreset);
  const partCode = partFilter === 'all' ? undefined : partFilter;

  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['stats2-overview'],
    queryFn: () => api.getStats2Overview(),
  });
  const { data: readiness } = useQuery({
    queryKey: ['stats2-readiness'],
    queryFn: () => api.getStats2Readiness(),
  });
  const { data: buildPlan } = useQuery({
    queryKey: ['stats2-build-plan'],
    queryFn: () => api.getStats2BuildPlan(),
  });
  // Measured schedulable ceiling from overview (not the what-if pack response).
  const overviewCapacityMax =
    overview?.capacity?.devices_per_day_theoretical ??
    overview?.capacity?.devices_per_day_realistic ??
    undefined;
  const {
    data: printPlan,
    isFetching: printPlanFetching,
    isError: printPlanError,
  } = useQuery({
    queryKey: ['stats2-print-plan', appliedTarget, timelineMode, overviewCapacityMax],
    queryFn: () =>
      api.getStats2PrintPlan({
        targetDevices: appliedTarget,
        timelineMode,
        schedulableCeiling:
          overviewCapacityMax != null && Number.isFinite(Number(overviewCapacityMax))
            ? Number(overviewCapacityMax)
            : undefined,
      }),
    placeholderData: keepPreviousData,
  });
  const { data: yieldData } = useQuery({
    queryKey: ['stats2-yield', lookback, partCode],
    queryFn: () => api.getStats2Yield(lookback, partCode),
  });
  const { data: leadTimes } = useQuery({
    queryKey: ['stats2-lead-times', lookback],
    queryFn: () => api.getStats2LeadTimes(lookback),
  });
  const { data: qualityPrint } = useQuery({
    queryKey: ['stats2-quality', 'print', lookback],
    queryFn: () => api.getStats2QualityReasons({ lookbackDays: lookback, category: 'print' }),
  });
  const { data: qualityDiscard } = useQuery({
    queryKey: ['stats2-quality', 'discard', lookback],
    queryFn: () => api.getStats2QualityReasons({ lookbackDays: lookback, category: 'discard' }),
  });
  const { data: qualityRework } = useQuery({
    queryKey: ['stats2-quality', 'rework', lookback],
    queryFn: () => api.getStats2QualityReasons({ lookbackDays: lookback, category: 'rework_sanding' }),
  });
  const { data: qualityPassed } = useQuery({
    queryKey: ['stats2-quality', 'passed', lookback],
    queryFn: () => api.getStats2QualityReasons({ lookbackDays: lookback, category: 'passed' }),
  });
  const { data: reliability } = useQuery({
    queryKey: ['stats2-reliability', lookback],
    queryFn: () => api.getStats2PrinterReliability(lookback),
  });
  const { data: plateFeedback } = useQuery({
    queryKey: ['stats2-plate-feedback', lookback],
    queryFn: () => api.getStats2PlateFeedback(lookback),
  });
  const { data: filament } = useQuery({
    queryKey: ['stats2-filament', lookback],
    queryFn: () => api.getStats2Filament(lookback),
  });
  const { data: capacityHistory } = useQuery({
    queryKey: ['stats2-capacity-history', lookback],
    queryFn: () => api.getStats2CapacityHistory(Math.min(lookback, 30)),
  });

  const day = printPlan?.days?.[dayIndex];
  const hasExplicitTarget = appliedTarget != null;
  // Prefer overview (already measured schedulable) over print-plan capacity fields —
  // what-if responses no longer re-measure, and devices_achievable under a huge ask
  // can under-count due to non-monotonic packing.
  const capacityMax =
    overview?.capacity?.devices_per_day_theoretical ??
    overview?.capacity?.devices_per_day_realistic ??
    printPlan?.capacity_devices_theoretical ??
    printPlan?.capacity_devices_realistic ??
    buildPlan?.devices_per_day_theoretical ??
    buildPlan?.devices_per_day_realistic ??
    undefined;

  const parseDraftTarget = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const n = Math.floor(Number(trimmed));
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };

  const applyWhatIf = () => {
    const next = parseDraftTarget(targetDraft);
    setAppliedTarget(next);
    if (next != null) setTargetDraft(String(next));
    else setTargetDraft('');
  };

  const resetWhatIf = () => {
    setTargetDraft('');
    setAppliedTarget(undefined);
  };

  const content = useMemo<Record<string, ReactNode>>(() => {
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const scheduleDayLabel = dayLabels[dayIndex] ?? 'Mon';
    const scheduledByPart = scheduleDayPartStats(day);
    const yieldParts =
      (yieldData?.parts as
        | Array<{
            part_code: string;
            expected_total: number;
            harvested_total: number;
            qc_passed_total: number;
            wip_total: number;
            shipped_total: number;
            harvest_yield_pct?: number | null;
          }>
        | undefined) || [];
    const leadMetrics =
      (leadTimes?.metrics as
        | Array<{
            metric_id: string;
            label: string;
            median_minutes?: number | null;
            p90_minutes?: number | null;
            median_hours?: number | null;
            p90_hours?: number | null;
          }>
        | undefined) || [];
    const leadNote = (leadTimes?.note as string | undefined) || undefined;
    const printersRel =
      (reliability?.printers as
        | Array<{ printer_id: number; printer_name: string; jobs: number; job_success?: number | null }>
        | undefined) || [];
    const historyPoints = (capacityHistory?.points as CapacityHistoryPoint[] | undefined) || [];
    const trendRows = historyPoints.map((p) => ({
      label: p.date.slice(5),
      theoretical: wholeDevices(p.devices_per_day_theoretical),
      realistic: wholeDevices(p.devices_per_day_realistic),
      shipped: wholeDevices(p.devices_shipped),
    }));
    const filamentParts =
      (filament?.parts as Array<{ part_code: string; grams_per_device_part?: number | null }> | undefined) || [];

    // Surface low-confidence capacity inputs compactly (no amber warning wall):
    // a single collapsible callout + a small "defaults" badge in the hero.
    const capacityComponents = (overview?.components as Array<Record<string, unknown>> | undefined) || [];
    const confidenceFlags = capacityComponents
      .map((c) => {
        const issues: string[] = [];
        if (c.incomplete) issues.push(t('stats2.flagNoSlot', 'no active slot'));
        if (c.print_time_assumed) issues.push(t('stats2.flagAssumedTime', 'assumed print time'));
        if (c.using_defaults) issues.push(t('stats2.flagDefaultYields', 'default yields'));
        if (c.warning) issues.push(String(c.warning));
        return issues.length ? { part: String(c.part_code || '?'), issues } : null;
      })
      .filter((f): f is { part: string; issues: string[] } => f !== null);

    // ── Quality hub derived data ──
    const qPrint = qualityPrint as QualityResp | undefined;
    const qDiscard = qualityDiscard as QualityResp | undefined;
    const qRework = qualityRework as QualityResp | undefined;
    const qPassed = qualityPassed as QualityResp | undefined;
    const printTotal = qPrint?.total ?? 0;
    const discardTotal = qDiscard?.total ?? 0;
    const reworkTotal = qRework?.total ?? 0;
    const passedTotal = qPassed?.total ?? 0;
    const lossTotal = printTotal + discardTotal + reworkTotal;

    const activeQ = qualityTab === 'print' ? qPrint : qualityTab === 'discard' ? qDiscard : qRework;
    const activeByPrinter = activeQ?.by_printer || [];
    const activeByPart = activeQ?.by_part || [];
    const activeReasons = (activeQ?.reasons || []).slice(0, 8);
    const activeTotal = activeQ?.total ?? 0;
    const hotPrinter = activeByPrinter[0];

    const daySet = new Set<string>();
    [qPrint, qDiscard, qRework, qPassed].forEach((q) => (q?.daily || []).forEach((d) => daySet.add(d.date)));
    const days = [...daySet].sort();
    const trendData = days.map((date) => ({
      label: date.slice(5), // MM-DD
      passed: qPassed?.daily?.find((d) => d.date === date)?.total ?? 0,
      print: qPrint?.daily?.find((d) => d.date === date)?.total ?? 0,
      discard: qDiscard?.daily?.find((d) => d.date === date)?.total ?? 0,
      rework: qRework?.daily?.find((d) => d.date === date)?.total ?? 0,
    }));

    // ── Yield: where expected units went (not a fake "lost" gap) ──
    const yieldWhere = yieldWhereUnitsWent(yieldParts);

    // ── Cleanup feedback derived data ──
    const cleanupExpected = plateFeedback?.expected_plate_clear_minutes as number | undefined;
    const cleanupActual = (plateFeedback?.staffed_hours_only as { median_minutes?: number | null } | undefined)
      ?.median_minutes;
    const cleanupStatus = String(plateFeedback?.status || 'insufficient_data');
    const cleanupBehind = cleanupStatus === 'behind';
    const cleanupAhead = cleanupStatus === 'ahead';

    return {
      'device-capacity': (() => {
        const drag = overview?.capacity?.yield_drag;
        const theoWhole =
          drag?.devices_theoretical_whole ??
          wholeDevices(overview?.capacity?.devices_per_day_theoretical);
        const expectedWhole =
          drag?.devices_expected_whole ??
          wholeDevices(overview?.capacity?.devices_per_day_realistic);
        const gap = theoWhole - expectedWhole;
        const stages = (drag?.stages || []).filter((s) => Number(s.devices_lost) >= 1);
        const stagesSum = stages.reduce((a, s) => a + Number(s.devices_lost || 0), 0);
        // Prefer backend waterfall when it telescopes; otherwise hide rather than show bad math.
        const hasYieldDrag = Boolean(drag) && gap >= 1 && stagesSum === gap;
        const bindingPart = drag?.binding_part || overview?.capacity?.binding_part;
        const bindingRates = (drag?.parts || []).find(
          (p) => p.is_binding || p.part_code === bindingPart,
        );
        const pct = (rate: number | null | undefined) =>
          rate == null || Number.isNaN(rate) ? '—' : `${Math.round(rate * 100)}%`;

        return (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            <div className="space-y-1">
              <div className="text-xs uppercase tracking-wide text-bambu-gray">Expected</div>
              <div className="text-4xl font-bold leading-none text-bambu-green">
                {overviewLoading ? '…' : fmtDevices(overview?.capacity.devices_per_day_realistic)}
              </div>
              <div className="text-xs text-bambu-gray-light">
                {t('stats2.expectedSub', 'after print / harvest / QC yields')}
              </div>
              {hasYieldDrag && (
                <button
                  type="button"
                  onClick={() => setCapacityWhyOpen((o) => !o)}
                  aria-expanded={capacityWhyOpen}
                  className="mt-1 inline-flex items-center gap-1 rounded-md text-xs text-bambu-gray-light outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-bambu-green/50"
                >
                  {t('stats2.yieldDragWhyLink', 'Why {{expected}} instead of {{theo}}?', {
                    expected: expectedWhole,
                    theo: theoWhole,
                  })}
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 transition ${capacityWhyOpen ? 'rotate-180' : ''}`}
                  />
                </button>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-bambu-gray">Theoretical (100% yield)</span>
                {confidenceFlags.length > 0 && <Pill tone="warning">defaults</Pill>}
              </div>
              <div className="text-3xl font-semibold leading-none text-white">
                {fmtDevices(overview?.capacity.devices_per_day_theoretical)}
              </div>
              <div className="text-xs text-bambu-gray-light">
                {t('stats2.theoreticalSub', 'plate starts the weekly schedule can clear')}
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-bambu-gray">Print bottleneck</div>
              <div>
                <Pill tone="warning">{overview?.capacity.binding_part || '—'}</Pill>
              </div>
              <div className="text-xs text-bambu-gray-light">
                {overview?.capacity.binding_part
                  ? t(
                      'stats2.bottleneckHint',
                      'Slowest part · sets the complete-device ceiling',
                    )
                  : t('stats2.bottleneckNone', 'No binding part')}
              </div>
            </div>
          </div>
          {capacityWhyOpen && hasYieldDrag && (
            <div className="rounded-xl border border-bambu-dark-tertiary/80 bg-bambu-dark-tertiary/35 px-4 py-3.5 space-y-3">
              <div>
                <div className="text-sm font-medium text-white">
                  {t('stats2.yieldDragTitle', 'Why expected is lower than theoretical')}
                </div>
                <p className="mt-1 text-xs text-bambu-gray-light">
                  {t('stats2.yieldDragIntro', {
                    defaultValue:
                      'Theoretical {{theo}} assumes every packed plate succeeds. Expected {{expected}} is what remains after real print, harvest, and QC losses.',
                    theo: theoWhole,
                    expected: expectedWhole,
                  })}
                </p>
              </div>
              {bindingRates && bindingPart && (
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <Pill tone="neutral">
                    {bindingPart} print {pct(bindingRates.print_job_success)}
                  </Pill>
                  <Pill tone="neutral">
                    harvest {pct(bindingRates.harvest_yield)}
                  </Pill>
                  <Pill tone="neutral">
                    QC {pct(bindingRates.qc_yield)}
                  </Pill>
                </div>
              )}
              <ol className="space-y-1.5 text-xs">
                <li className="flex items-center justify-between gap-3 px-1">
                  <span className="text-bambu-gray-light">
                    {t('stats2.yieldDragTheoStep', 'Theoretical (100% yield)')}
                  </span>
                  <span className="font-semibold tabular-nums text-white">{theoWhole}</span>
                </li>
                {stages.map((s) => {
                  const n = Number(s.devices_lost) || 0;
                  const stageLabel =
                    s.stage === 'print'
                      ? t('stats2.yieldDragPrint', 'Print failures')
                      : s.stage === 'harvest'
                        ? t('stats2.yieldDragHarvest', 'Harvest scrap')
                        : t('stats2.yieldDragQc', 'QC rejects');
                  return (
                    <li
                      key={s.stage}
                      className="flex items-center justify-between gap-3 rounded-lg bg-black/25 px-2.5 py-2"
                    >
                      <span className="text-bambu-gray-light">
                        − {stageLabel}
                        {s.binding_part ? (
                          <span className="text-bambu-gray"> · {s.binding_part}</span>
                        ) : null}
                      </span>
                      <span className="font-semibold tabular-nums text-amber-200">−{n}</span>
                    </li>
                  );
                })}
                <li className="flex items-center justify-between gap-3 border-t border-white/10 px-1 pt-2">
                  <span className="text-bambu-gray-light">
                    {t('stats2.yieldDragExpectedStep', 'Expected (after yields)')}
                  </span>
                  <span className="font-semibold tabular-nums text-bambu-green">{expectedWhole}</span>
                </li>
              </ol>
              <p className="text-[11px] text-bambu-gray">
                {t('stats2.scheduleAssumptions', {
                  defaultValue:
                    'Assumes {{clear}} min plate clear · {{staffed}} staffed/day.',
                  clear: overview?.capacity.expected_plate_clear_minutes ?? '—',
                  staffed: fmtDurationMinutes(overview?.capacity.staffed_minutes),
                })}
              </p>
            </div>
          )}
          {confidenceFlags.length > 0 && (
            <details className="group rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs dark:border-amber-500/40 dark:bg-amber-500/10">
              <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold text-amber-900 dark:text-amber-100">
                <TriangleAlert className="h-3.5 w-3.5" />
                {t('stats2.lowConfidence', 'Low confidence')} · {confidenceFlags.length}{' '}
                {confidenceFlags.length === 1 ? 'part' : 'parts'} using defaults
                <ChevronDown className="ml-auto h-3.5 w-3.5 transition group-open:rotate-180" />
              </summary>
              <ul className="mt-2 space-y-1 text-amber-800/90 dark:text-amber-100/90">
                {confidenceFlags.map((f) => (
                  <li key={f.part}>
                    <span className="font-semibold text-white">{f.part}</span>: {f.issues.join(', ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        );
      })(),
      readiness: (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs uppercase tracking-wide text-bambu-gray">Devices buildable now</div>
              <div className="text-4xl font-bold leading-none text-bambu-green">
                {fmtDevices(readiness?.devices_buildable_now)}
              </div>
              <div className="text-xs text-bambu-gray-light">Staged for Prod + In WIP · as of now</div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-bambu-gray">Short part</span>
                <div className="flex gap-1.5">
                  <TogglePill active={readinessMode === 'summary'} onClick={() => setReadinessMode('summary')}>
                    Summary
                  </TogglePill>
                  <TogglePill active={readinessMode === 'detailed'} onClick={() => setReadinessMode('detailed')}>
                    Detailed
                  </TogglePill>
                </div>
              </div>
              {readiness?.binding_part ? (
                <Pill tone="warning">
                  {readiness.binding_part} —{' '}
                  {readiness.parts.find((p) => p.part_code === readiness.binding_part)?.ready_now ?? 0} ready now
                </Pill>
              ) : (
                <Pill tone="success">No shortage</Pill>
              )}
              <div className="text-xs text-bambu-gray-light">
                Line {hhmm(readiness?.line_start_at)} · ready deadline {hhmm(readiness?.ready_deadline_at)}
              </div>
            </div>
          </div>
          <ReadinessTable parts={readiness?.parts || []} detailed={readinessMode === 'detailed'} />
          <p className="text-xs text-bambu-gray">
            Ready now = Staged + WIP · Upstream = Initial QC only · Rework separate · Linked (⌀) excluded · Source:
            floor inventory
          </p>
        </div>
      ),
      'print-schedule': (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => (
                <TogglePill key={label} active={dayIndex === i} onClick={() => setDayIndex(i)}>
                  {label}
                </TogglePill>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <TogglePill active={timelineMode === 'capacity'} onClick={() => setTimelineMode('capacity')}>
                {t('stats2.timelineCapacity', 'Capacity')}
              </TogglePill>
              <TogglePill active={timelineMode === 'buffer'} onClick={() => setTimelineMode('buffer')}>
                {t('stats2.timelineBuffer', 'Buffer stock')}
              </TogglePill>
            </div>
          </div>
          {timelineMode === 'buffer' && (
            <Callout
              tone="info"
              title={t('stats2.bufferTimelineTitle', 'Buffer stock timeline')}
            >
              {t('stats2.bufferTimelineBody', {
                defaultValue:
                  'Advisory only — keeps ready-on-hand at configured mins (default BUT 80, KNB 50). When below, schedules whole plates (e.g. BUT×47). Shared printers spend time on catch-up instead of other parts; capacity KPI stays on the Capacity timeline.',
              })}
              {printPlan?.buffer_debt && Object.keys(printPlan.buffer_debt).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(printPlan.buffer_debt).map(([code, debt]) => (
                    <Pill key={code} tone="warning">
                      {code}: {fmtInt(printPlan.buffer_ready?.[code])} ready / target{' '}
                      {fmtInt(printPlan.buffer_targets?.[code])} → catch-up {fmtInt(debt)}
                    </Pill>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-xs text-bambu-gray-light">
                  {t('stats2.bufferTimelineOk', 'All configured parts are at or above their ready targets.')}
                </div>
              )}
            </Callout>
          )}
          {day && day.lanes.length > 0 && day.staffed_minutes > 0 && timelineMode === 'capacity' && (
            <Callout tone="info" title={`Ready before line start (${hhmm(day.line_start_at)})`}>
              Schedule runs 1am–midnight. The blue guide is when parts should be ready for assembly. Overnight prints
              continue onto the next day (ringed bars on the left). Packing hits the daily ask first, then prefers
              expected good parts per printer-minute.
            </Callout>
          )}
          {day ? (
            <div className={printPlanFetching ? 'opacity-70 transition-opacity' : undefined}>
              {printPlanFetching && (
                <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] text-bambu-gray">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {t('stats2.whatIfFetching', 'Updating schedule…')}
                </div>
              )}
              {printPlan?.hypothetical_fleet && (
                <p className="mb-2 text-[11px] text-bambu-gray-light">
                  {t('stats2.hypotheticalFleetNote', {
                    defaultValue:
                      'Timeline includes +{{n}} hypothetical printers ({{detail}}) for this ask — dashed lanes.',
                    n: Object.values(printPlan.hypothetical_added || {}).reduce(
                      (sum, v) => sum + Number(v || 0),
                      0,
                    ),
                    detail:
                      Object.entries(printPlan.hypothetical_added || {})
                        .map(([model, count]) => `${model}×${count}`)
                        .join(', ') || '—',
                  })}
                </p>
              )}
              <GanttDay day={day} priorDays={printPlan?.days?.slice(0, dayIndex) || []} />
            </div>
          ) : (
            <p className="text-sm text-bambu-gray">Loading schedule…</p>
          )}
        </div>
      ),
      'build-plan': (
        <div className="space-y-5">
          <p className="text-xs text-bambu-gray-light">
            {t(
              'stats2.buildPlanHint',
              'Each row lists the plate file(s) the weekly schedule starts for that part. Plates and parts are whole starts from the selected day — same bars as the timeline above.',
            )}
          </p>
          <details className="group rounded-xl border border-bambu-dark-tertiary/80 bg-bambu-dark-tertiary/40 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-white [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1">
                {t('stats2.whatIfTitle', 'Simulate a daily device ask')}
                {hasExplicitTarget ? (
                  <span className="ml-2 font-normal text-bambu-green">
                    · {fmtDevices(appliedTarget)}/day
                  </span>
                ) : capacityMax != null ? (
                  <span className="ml-2 font-normal text-bambu-gray">
                    · {t('stats2.capacityMaxHint', 'Capacity ~{{n}}/day', { n: fmtDevices(capacityMax) })}
                  </span>
                ) : null}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70 transition group-open:rotate-180" aria-hidden />
            </summary>
            <div className="mt-2.5 space-y-2.5">
              <p className="text-[11px] text-bambu-gray-light max-w-xl">
                {t(
                  'stats2.whatIfHint',
                  'Does not change the floor — only redraws this week\'s Gantt and the plate counts below. Leave empty (or Reset) to pack at measured capacity.',
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-bambu-gray" htmlFor="stats2-whatif-target">
                  {t('stats2.targetDevicesDay', 'Devices / day')}
                </label>
                <input
                  id="stats2-whatif-target"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  className="w-24 rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5 text-sm text-white"
                  value={targetDraft}
                  onChange={(e) => setTargetDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyWhatIf();
                    }
                  }}
                  placeholder={fmtDevices(capacityMax)}
                  aria-label={t('stats2.targetDevicesDay', 'Devices / day')}
                />
                <button
                  type="button"
                  onClick={applyWhatIf}
                  disabled={printPlanFetching}
                  className="rounded-full bg-bambu-green/20 px-3 py-1.5 text-xs font-medium text-bambu-green ring-1 ring-bambu-green/40 disabled:opacity-50"
                >
                  {t('stats2.whatIf', 'Run what-if')}
                </button>
                {hasExplicitTarget && (
                  <button
                    type="button"
                    onClick={resetWhatIf}
                    disabled={printPlanFetching}
                    className="rounded-full px-3 py-1.5 text-xs font-medium text-bambu-gray-light ring-1 ring-bambu-dark-tertiary hover:text-white disabled:opacity-50"
                  >
                    {t('stats2.whatIfReset', 'Reset to capacity')}
                  </button>
                )}
                {printPlanFetching && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-bambu-gray">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    {t('stats2.whatIfFetching', 'Updating schedule…')}
                  </span>
                )}
              </div>
            </div>
          </details>
          {printPlanError && (
            <Callout tone="danger" title={t('stats2.whatIfError', 'Could not load schedule')}>
              {t(
                'stats2.whatIfErrorBody',
                'The what-if request failed. Try again, or Reset to capacity.',
              )}
            </Callout>
          )}
          {hasExplicitTarget &&
            printPlan &&
            (printPlan.feasible === false ||
              (printPlan.short_parts || []).length > 0 ||
              (capacityMax != null && Number(appliedTarget) > Number(capacityMax))) && (
            <Callout
              tone="warning"
              title={t('stats2.targetNotFeasible', 'Ask is above print capacity')}
            >
              <p>
                {t('stats2.targetNotFeasibleBody', {
                  defaultValue:
                    'Asked for {{target}}/day; fleet can schedule about {{achievable}}/day.',
                  target: fmtDevices(appliedTarget),
                  achievable: fmtDevices(
                    capacityMax ?? printPlan.devices_achievable ?? appliedTarget,
                  ),
                })}
              </p>
              {(() => {
                const shorts = printPlan.short_parts || [];
                if (!shorts.length) {
                  return printPlan.binding_print_part ? (
                    <p className="mt-1.5">
                      {t('stats2.bindingPartSuffix', {
                        defaultValue: 'Binding part: {{binding}}.',
                        binding: printPlan.binding_print_part,
                      })}
                    </p>
                  ) : null;
                }
                const modelSets = shorts.map((s) => new Set(s.eligible_models || []));
                let sharesModel = false;
                for (let i = 0; i < modelSets.length && !sharesModel; i += 1) {
                  for (let j = i + 1; j < modelSets.length; j += 1) {
                    for (const m of modelSets[i]) {
                      if (modelSets[j].has(m)) {
                        sharesModel = true;
                        break;
                      }
                    }
                    if (sharesModel) break;
                  }
                }
                return (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-[11px] font-medium text-amber-100/90">
                      {t('stats2.shortPartsHeading', 'Short parts (same operator schedule):')}
                    </p>
                    <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-amber-50/90">
                      {shorts.map((s) => {
                        const models =
                          (s.eligible_models || []).length > 0
                            ? (s.eligible_models || []).join('/')
                            : t('stats2.shortPartUnknownModels', 'eligible');
                        return (
                          <li key={s.part_code}>
                            {t('stats2.shortPartLine', {
                              defaultValue:
                                '{{part}} {{packed}}/{{needed}} — need at least {{extra}} more {{models}} printer(s)',
                              part: s.part_code,
                              packed: fmtInt(s.parts_packed),
                              needed: fmtInt(s.parts_needed),
                              extra: fmtInt(s.min_extra_printers ?? 0),
                              models,
                            })}
                          </li>
                        );
                      })}
                    </ul>
                    {sharesModel && (
                      <p className="text-[11px] text-amber-100/70">
                        {t(
                          'stats2.shortPartsSharedNote',
                          'Extra printers are per-part lower bounds (same operator schedule). Shared models count once in reality — do not add the numbers together.',
                        )}
                      </p>
                    )}
                  </div>
                );
              })()}
            </Callout>
          )}
          {hasExplicitTarget &&
            printPlan?.feasible !== false &&
            !(printPlan?.short_parts || []).length &&
            !(capacityMax != null && Number(appliedTarget) > Number(capacityMax)) && (
            <p className="text-xs text-bambu-gray">
              {t('stats2.scenarioAtTarget', {
                defaultValue:
                  'Showing plate starts for {{n}} devices/day on {{day}} (same bars as the timeline).',
                n: fmtDevices(appliedTarget),
                day: scheduleDayLabel,
              })}
            </p>
          )}
          {!hasExplicitTarget && (
            <p className="text-xs text-bambu-gray">
              {t('stats2.scenarioAtCapacity', {
                defaultValue:
                  'Showing plate starts for {{day}} at measured capacity. Enter a number and Run what-if to simulate a different daily ask.',
                day: scheduleDayLabel,
              })}
            </p>
          )}
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-bambu-dark-tertiary">
                <th className={TH}>Part</th>
                <th className={TH}>Slot (file)</th>
                <th className={`${TH} text-right`}>Qty</th>
                <th className={`${TH} text-right`}>Plates</th>
                <th className={`${TH} text-right`}>Parts</th>
              </tr>
            </thead>
            <tbody>
              {(buildPlan?.rows || []).map((r) => {
                const scheduled = scheduledByPart.get(r.part_code);
                const plates = scheduled?.plates ?? 0;
                const parts = scheduled?.parts ?? 0;
                const filenames =
                  scheduled && scheduled.filenames.length > 0
                    ? scheduled.filenames.join(' · ')
                    : r.recommended_filename || '—';
                const qtyLabel =
                  scheduled && scheduled.quantities.length > 0
                    ? scheduled.quantities.join(' · ')
                    : String(r.quantity_per_plate || '—');
                const shortRow =
                  hasExplicitTarget &&
                  (printPlan?.short_parts || []).find((s) => s.part_code === r.part_code);
                const isShort = Boolean(shortRow) || Boolean(r.is_binding && !hasExplicitTarget);
                return (
                  <tr key={r.part_code} className="border-b border-bambu-dark-tertiary/50">
                    <td
                      className={`${TD} font-medium ${
                        isShort ? 'text-amber-700 dark:text-amber-300' : ''
                      }`}
                    >
                      {r.part_code}
                      {isShort ? ' ★' : ''}
                    </td>
                    <td className={`${TD} max-w-[9rem] truncate`} title={filenames}>
                      {filenames}
                    </td>
                    <td className={`${TD} text-right`}>{qtyLabel}</td>
                    <td className={`${TD} text-right`}>{fmtInt(plates)}</td>
                    <td className={`${TD} text-right`}>
                      {fmtInt(parts)}
                      {shortRow ? (
                        <div className="text-[10px] font-normal text-amber-600/90 dark:text-amber-200/70">
                          {fmtInt(shortRow.parts_packed)}/{fmtInt(shortRow.parts_needed)}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {!(buildPlan?.rows || []).length && (
                <tr>
                  <td colSpan={5} className="py-3 text-center text-bambu-gray">
                    No build plan yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ),
      cleanup: (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-8">
            <Stat value={`${cleanupExpected ?? '—'} min`} label="Expected clear time" />
            <Stat
              value={`${cleanupActual ?? '—'} min`}
              label="Actual average (staffed)"
              tone={cleanupBehind ? 'warning' : cleanupAhead ? 'success' : 'neutral'}
            />
          </div>
          {cleanupStatus === 'insufficient_data' ? (
            <Callout tone="neutral" title="Not enough clears yet">
              Need at least 3 staffed-hours plate clears to judge against target.
            </Callout>
          ) : cleanupBehind ? (
            <Callout tone="warning" title="Behind target">
              Average staffed clear time exceeds the configured expectation — consider updating the assumption or
              adding floor coverage.
            </Callout>
          ) : cleanupAhead ? (
            <Callout tone="success" title="Ahead of target">
              Clears are faster than the configured expectation.
            </Callout>
          ) : (
            <Callout tone="info" title="On target">
              Average clear time is within ±20% of the configured expectation.
            </Callout>
          )}
          <p className="text-xs text-bambu-gray">
            {(plateFeedback?.note as string | undefined) ||
              'Staffed operating minutes only — overnight and weekends do not count. Not used as a capacity input.'}
          </p>
        </div>
      ),
      'capacity-trend': (
        <div className="space-y-2">
          {trendRows.length > 1 ? (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={trendRows} margin={{ top: 5, right: 8, left: -18, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} vertical={false} />
                <XAxis dataKey="label" stroke={chartTheme.axis} fontSize={11} tickLine={false} minTickGap={28} />
                <YAxis stroke={chartTheme.axis} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, color: chartTheme.axis }} />
                <Line type="monotone" dataKey="theoretical" name="Theoretical" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="realistic" name="Realistic" stroke="#22d3ee" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="shipped" name="Actually shipped" stroke="#fb923c" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-bambu-gray">Not enough history to plot a trend yet.</p>
          )}
          <p className="text-xs text-bambu-gray">
            Y-axis: devices/day · Capacity = schedule + recipe slots + fleet · Shipped = floor outcomes
          </p>
        </div>
      ),
      'production-yield': (
        <div className="space-y-5">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-bambu-dark-tertiary">
                <th className={TH}>Part</th>
                <th className={`${TH} text-right`}>Expected</th>
                <th className={`${TH} text-right`}>Harvest</th>
                <th className={`${TH} text-right`}>QC</th>
                <th className={`${TH} text-right`}>WIP</th>
                <th className={`${TH} text-right`}>Shipped</th>
                <th className={`${TH} text-right`}>Harvest %</th>
              </tr>
            </thead>
            <tbody>
              {yieldParts.map((p) => (
                <tr key={p.part_code} className="border-b border-bambu-dark-tertiary/50">
                  <td className={`${TD} font-medium`}>{p.part_code}</td>
                  <td className={`${TD} text-right`}>{fmtInt(p.expected_total)}</td>
                  <td className={`${TD} text-right`}>{fmtInt(p.harvested_total)}</td>
                  <td className={`${TD} text-right`}>{fmtInt(p.qc_passed_total)}</td>
                  <td className={`${TD} text-right`}>{fmtInt(p.wip_total)}</td>
                  <td className={`${TD} text-right`}>{fmtInt(p.shipped_total)}</td>
                  <td className={`${TD} text-right`}>
                    {p.harvest_yield_pct != null ? `${p.harvest_yield_pct}%` : '—'}
                  </td>
                </tr>
              ))}
              {!yieldParts.length && (
                <tr>
                  <td colSpan={7} className="py-3 text-center text-bambu-gray">
                    No yield data in range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {yieldWhere.expected > 0 && (
            <div className="space-y-2">
              <UsageBar
                total={yieldWhere.barTotal}
                leftLabel="Where expected went (all parts)"
                rightLabel={`${fmtInt(yieldWhere.shipped)} shipped / ${fmtInt(yieldWhere.expected)} expected`}
                segments={yieldWhere.segments}
              />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-bambu-gray">
                {yieldWhere.segments.map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1.5">
                    <span className={`inline-block h-2 w-2 rounded-sm ${s.className}`} />
                    {s.label}: {fmtInt(s.value)}
                  </span>
                ))}
              </div>
              <p className="text-xs text-bambu-gray">
                Still in WIP / awaiting WIP are on the floor — not scrap. QC scrap is harvest − QC
                passed. Shortfall is expected − harvest.
              </p>
            </div>
          )}
        </div>
      ),
      'lead-times': (
        <div className="space-y-3">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-bambu-dark-tertiary">
                <th className={TH}>Metric</th>
                <th className={`${TH} text-right`} title="Typical (middle) staffed time">
                  Typical
                </th>
                <th
                  className={`${TH} text-right`}
                  title="9 out of 10 cases finish within this staffed time"
                >
                  9 of 10 under
                </th>
              </tr>
            </thead>
            <tbody>
              {leadMetrics.map((m) => {
                const typical =
                  m.median_minutes != null
                    ? m.median_minutes
                    : m.median_hours != null
                      ? m.median_hours * 60
                      : null;
                const p90 =
                  m.p90_minutes != null ? m.p90_minutes : m.p90_hours != null ? m.p90_hours * 60 : null;
                return (
                  <tr key={m.metric_id} className="border-b border-bambu-dark-tertiary/50">
                    <td className={`${TD} pr-2`}>{m.label}</td>
                    <td className={`${TD} text-right`}>{fmtDurationMinutes(typical)}</td>
                    <td className={`${TD} text-right`}>{fmtDurationMinutes(p90)}</td>
                  </tr>
                );
              })}
              {!leadMetrics.length && (
                <tr>
                  <td colSpan={3} className="py-3 text-center text-bambu-gray">
                    No lead-time data in range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="text-xs text-bambu-gray">
            {leadNote ||
              'Staffed operating minutes only — overnight and weekends do not count toward these times.'}
          </p>
        </div>
      ),
      'quality-reasons': (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat value={fmtInt(passedTotal)} label="QC passed" tone="success" />
            <Stat value={fmtInt(printTotal)} label="Print failures" tone="danger" />
            <Stat value={fmtInt(discardTotal)} label="Discards" tone="warning" />
            <Stat value={fmtInt(reworkTotal)} label="Rework / sanding" tone="info" />
          </div>

          {lossTotal > 0 && (
            <UsageBar
              total={lossTotal}
              leftLabel="Loss mix (all categories)"
              rightLabel={`${lossTotal} events`}
              segments={[
                { id: 'print', value: printTotal, className: 'bg-red-500', label: 'Print failures' },
                { id: 'discard', value: discardTotal, className: 'bg-amber-500', label: 'Discards' },
                { id: 'rework', value: reworkTotal, className: 'bg-blue-500', label: 'Rework' },
              ]}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <TogglePill active={qualityTab === 'print'} onClick={() => setQualityTab('print')}>
              Print failures
            </TogglePill>
            <TogglePill active={qualityTab === 'discard'} onClick={() => setQualityTab('discard')}>
              Discards
            </TogglePill>
            <TogglePill active={qualityTab === 'rework'} onClick={() => setQualityTab('rework')}>
              Rework / sanding
            </TogglePill>
          </div>

          {hotPrinter && activeTotal > 0 ? (
            <Callout
              tone={qualityTab === 'print' ? 'danger' : qualityTab === 'discard' ? 'warning' : 'info'}
              title={`Hot printer · ${hotPrinter.printer_name || 'unknown'}`}
            >
              {hotPrinter.count} of {activeTotal} events in this tab (
              {activeTotal ? Math.round((hotPrinter.count / activeTotal) * 100) : 0}%).
            </Callout>
          ) : (
            <Callout tone="neutral" title="No events in this tab">
              Nothing recorded for this category in the selected range.
            </Callout>
          )}

          {activeTotal > 0 && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)] lg:items-stretch">
              <div className="space-y-5">
                {activeByPrinter.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-white">By printer (originating machine)</div>
                    <BarByCategory
                      categories={activeByPrinter.map((p) => p.printer_name || 'unknown')}
                      data={activeByPrinter.map((p) => p.count)}
                      color={TAB_COLORS[qualityTab]}
                      maxBars={10}
                      otherLabel="Other printers"
                    />
                  </div>
                )}
                {activeByPart.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-white">By part (TOP / BOT / KNB / BUT)</div>
                    <BarByCategory
                      categories={activeByPart.map((p) => p.part_code || 'unknown')}
                      data={activeByPart.map((p) => p.count)}
                      color={TAB_COLORS[qualityTab]}
                      maxBars={8}
                      otherLabel="Other parts"
                    />
                  </div>
                )}
              </div>
              {activeReasons.length > 0 && (
                <div className="flex min-h-0 flex-col gap-2 self-stretch overflow-hidden lg:h-auto">
                  <div className="shrink-0 text-xs font-semibold text-white">By reason</div>
                  <div className="min-h-0 flex-1">
                    <ReasonPie data={activeReasons} />
                  </div>
                </div>
              )}
            </div>
          )}

          {trendData.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-white">Daily trend (all categories)</div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trendData} margin={{ top: 5, right: 8, left: -18, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} vertical={false} />
                  <XAxis dataKey="label" stroke={chartTheme.axis} fontSize={11} tickLine={false} minTickGap={28} />
                  <YAxis stroke={chartTheme.axis} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11, color: chartTheme.axis }} />
                  <Line type="monotone" dataKey="passed" name="QC passed" stroke={QUALITY_PASSED} strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="print" name="Print failures" stroke={QUALITY_PRINT} strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="discard" name="Discards" stroke={QUALITY_DISCARD} strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="rework" name="Rework" stroke={QUALITY_REWORK} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          <p className="text-xs text-bambu-gray">
            QC passed = initial fit check (sanding is rework). Printer = machine that printed the part.
            Part codes come from the labeled part, or from the print name for plate failures.
            Drill down via hover or Export.
          </p>
        </div>
      ),
      reliability: <PrinterReliabilityTable printers={printersRel} />,
      filament: (() => {
        const hasEstimate = filament?.grams_per_device_estimate != null;
        const hasParts = filamentParts.some((p) => p.grams_per_device_part != null);
        const currencySymbol = getCurrencySymbol(String(filament?.currency || 'USD'));
        const costPerKg = Number(filament?.cost_per_kg ?? 0);
        const hasCost = filament?.cost_per_device_estimate != null && costPerKg > 0;
        if (!hasEstimate && !hasParts) {
          return (
            <div className="space-y-1">
              <p className="text-sm text-bambu-gray">No filament estimate yet.</p>
              <p className="text-xs text-bambu-gray">
                Needs slicer filament weight on each recommended recipe slot file.
              </p>
            </div>
          );
        }
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-8">
              <Stat
                value={hasEstimate ? `${Number(filament!.grams_per_device_estimate).toFixed(0)} g` : '—'}
                label="Estimated grams / device (recipe slot file ÷ qty/plate)"
                tone="accent"
              />
              <Stat
                value={
                  hasCost
                    ? `${currencySymbol}${Number(filament!.cost_per_device_estimate).toFixed(2)}`
                    : '—'
                }
                label={`Estimated cost / device (at ${currencySymbol}${costPerKg.toFixed(2)}/kg)`}
                tone="accent"
              />
            </div>
            {hasParts && (
              <BarByCategory
                categories={filamentParts.map((p) => p.part_code)}
                data={filamentParts.map((p) => Number(p.grams_per_device_part || 0))}
                color={ACCENT}
                seriesName="Grams"
              />
            )}
            <p className="text-xs text-bambu-gray">
              Grams · slicer weight on each recommended slot file, divided by parts per plate.
              Cost uses Settings default filament $/kg.
            </p>
          </div>
        );
      })(),
      configuration: (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-bambu-gray max-w-xl leading-relaxed">
              Schedule · line start · BOM · cleanup — edits refresh capacity and the weekly print plan.
            </p>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-bambu-dark-tertiary px-3 py-1.5 text-xs text-bambu-gray-light hover:text-white"
              onClick={() => setConfigOpen((v) => !v)}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {configOpen ? 'Collapse' : 'Expand editor'}
            </button>
          </div>
          {configOpen && (
            <div className="space-y-3">
              <Stats2CapacityConfigCard embedded />
              <p className="text-xs text-bambu-gray">
                Also available under{' '}
                <Link to="/settings" className="text-bambu-green underline">
                  Settings → Queue
                </Link>
                .
              </p>
            </div>
          )}
        </div>
      ),
    };
  }, [
    t,
    chartTheme,
    overview,
    overviewLoading,
    readiness,
    readinessMode,
    day,
    dayIndex,
    timelineMode,
    buildPlan,
    printPlan,
    targetDraft,
    appliedTarget,
    hasExplicitTarget,
    capacityMax,
    printPlanFetching,
    printPlanError,
    plateFeedback,
    yieldData,
    leadTimes,
    qualityPrint,
    qualityDiscard,
    qualityRework,
    qualityPassed,
    qualityTab,
    reliability,
    filament,
    capacityHistory,
    configOpen,
    capacityWhyOpen,
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-8 md:px-10 md:py-10 space-y-6 md:space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">{t('stats2.pageTitle', 'Stats 2 — True Capacity')}</h1>
          <p className="text-sm text-bambu-gray">
            Device print capacity, readiness, schedule, yield, and quality.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            className="rounded border border-bambu-dark-tertiary bg-bambu-dark-tertiary px-2 py-1.5 text-sm text-white"
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value)}
          >
            <option value="last-30">Last 30 days</option>
            <option value="last-7">Last 7 days</option>
            <option value="this-month">This month</option>
          </select>
          <select
            className="rounded border border-bambu-dark-tertiary bg-bambu-dark-tertiary px-2 py-1.5 text-sm text-white"
            value={partFilter}
            onChange={(e) => setPartFilter(e.target.value)}
          >
            <option value="all">All parts</option>
            <option value="TOP">TOP</option>
            <option value="BOT">BOT</option>
            <option value="BUT">BUT</option>
            <option value="KNB">KNB</option>
          </select>
          <button
            type="button"
            disabled={exporting}
            className="rounded bg-bambu-green px-3 py-1.5 text-sm font-medium text-bambu-dark disabled:opacity-50"
            onClick={async () => {
              setExporting(true);
              try {
                const { blob, filename } = await api.exportStats2({
                  format: 'csv',
                  lookbackDays: lookback,
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? '…' : t('stats2.export', 'Export CSV')}
          </button>
        </div>
      </div>

      <Section title={t('stats2.deviceCapacity', 'Device capacity (print throughput)')}>
        {content['device-capacity']}
      </Section>

      <Section title={t('stats2.todaysReadiness', "Today's readiness (on-hand)")}>{content.readiness}</Section>

      <Section title={t('stats2.printSchedule', "This week's print schedule")}>{content['print-schedule']}</Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section title={t('stats2.buildPlan', 'Build plan')}>{content['build-plan']}</Section>
        <div className="space-y-5">
          <Section title={t('stats2.cleanup', 'Cleanup: target vs reality')}>{content.cleanup}</Section>
          <Section title={t('stats2.capacityTrend', 'Capacity trend')}>{content['capacity-trend']}</Section>
        </div>
      </div>

      <Section title={t('stats2.productionYield', 'Production yield')}>{content['production-yield']}</Section>

      <Section title={t('stats2.leadTimes', 'Floor lead times')}>{content['lead-times']}</Section>

      <Section title={t('stats2.qualityReasons', 'Quality & loss reasons')}>{content['quality-reasons']}</Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section title={t('stats2.printerReliability', 'Printer reliability')}>{content.reliability}</Section>
        <Section title={t('stats2.filamentPerDevice', 'Filament per device')}>{content.filament}</Section>
      </div>

      <Section title={t('stats2.configuration', 'Configuration')}>{content.configuration}</Section>
    </div>
  );
}

export default Stats2Page;
