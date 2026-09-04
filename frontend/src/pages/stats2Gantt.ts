/**
 * Stats 2 weekly Gantt segment math (1a → midnight axis).
 *
 * Overnight remainder is drawn only as a continuation on later day rows —
 * never as a same-day left-edge "wrap". Wrapping tomorrow's early hours onto
 * today's left edge collides with yesterday's continuation on that same strip.
 */

export const GANTT_AXIS_START = 1 * 60;
export const GANTT_AXIS_END = 24 * 60;
export const GANTT_MIDNIGHT = 24 * 60;
/** Minimum bar width so overnight stubs stay clickable; labels hide below this. */
export const GANTT_MIN_SEG_MINUTES = 8;
export const GANTT_LABEL_MIN_WIDTH_PCT = 4.5;

export type GanttJobLike = {
  start_at: string;
  end_at: string;
  clear_until?: string | null;
  part_code: string;
  quantity_per_plate?: number;
  filename?: string | null;
  rationale?: string | null;
};

export type GanttSegment = {
  key: string;
  leftPct: number;
  widthPct: number;
  wrap: boolean;
  label: string;
  showLabel: boolean;
  title: string;
  rounded: string;
  partCode: string;
};

/** Minutes from local midnight of ``dayIso`` (YYYY-MM-DD). May be > 1440 or negative. */
export function minutesFromDay(iso: string, dayIso: string): number {
  const dayStart = new Date(`${dayIso}T00:00:00`);
  const ts = new Date(iso);
  return Math.round((ts.getTime() - dayStart.getTime()) / 60000);
}

export function ganttAxisLabels(): string[] {
  return ['1a', '3a', '6a', '9a', '12p', '3p', '6p', '9p', '12a'];
}

export function jobBarLabel(job: { part_code: string; quantity_per_plate?: number }): string {
  const qty = Math.max(1, Number(job.quantity_per_plate) || 1);
  return `${job.part_code} x${qty}`;
}

/** Clock from naive ISO ``YYYY-MM-DDTHH:MM:SS`` (matches Stats2Page). */
function hhmm(iso: string): string {
  if (!iso || iso.length < 16) return '—';
  return iso.slice(11, 16);
}

function jobTitleBase(job: GanttJobLike): string {
  const clearLabel = job.clear_until ? ` · clear ${hhmm(job.clear_until)}` : '';
  return `${jobBarLabel(job)} ${job.filename || ''} (${job.rationale || ''}) ${hhmm(job.start_at)}→${hhmm(job.end_at)}${clearLabel}`;
}

export function pushGanttSegment(
  segments: GanttSegment[],
  opts: {
    job: GanttJobLike;
    keySuffix: string;
    segStart: number;
    segEnd: number;
    wrap: boolean;
    rounded: string;
    label: string;
    title: string;
    axisStart: number;
    axisEnd: number;
    span: number;
    idx: number;
  },
): void {
  const start = Math.max(opts.segStart, opts.axisStart);
  const end = Math.min(opts.segEnd, opts.axisEnd);
  if (end <= start) return;
  const widthMinutes = Math.max(GANTT_MIN_SEG_MINUTES, end - start);
  const widthPct = (widthMinutes / opts.span) * 100;
  segments.push({
    key: `${opts.job.start_at}-${opts.idx}-${opts.keySuffix}`,
    leftPct: ((start - opts.axisStart) / opts.span) * 100,
    widthPct,
    wrap: opts.wrap,
    label: opts.label,
    showLabel: widthPct >= GANTT_LABEL_MIN_WIDTH_PCT,
    title: opts.title,
    rounded: opts.rounded,
    partCode: opts.job.part_code,
  });
}

/**
 * Segments for a job that *starts* on ``dayIso``.
 * Overnight: run to midnight on the right with a ``→`` cue. The remainder is
 * drawn on later days via ``buildContinuationSegments`` (no same-day wrap).
 */
export function buildJobSegments(
  job: GanttJobLike,
  dayIso: string,
  axisStart: number,
  axisEnd: number,
  span: number,
  idx: number,
): GanttSegment[] {
  const startAbs = minutesFromDay(job.start_at, dayIso);
  const endAbs = minutesFromDay(job.end_at, dayIso);
  const label = jobBarLabel(job);
  const titleBase = jobTitleBase(job);
  const segments: GanttSegment[] = [];

  if (endAbs <= GANTT_MIDNIGHT) {
    pushGanttSegment(segments, {
      job,
      keySuffix: 'same',
      segStart: startAbs,
      segEnd: Math.max(endAbs, startAbs + 15),
      wrap: false,
      rounded: 'rounded-sm',
      label,
      title: titleBase,
      axisStart,
      axisEnd,
      span,
      idx,
    });
    return segments;
  }

  if (startAbs < GANTT_MIDNIGHT) {
    pushGanttSegment(segments, {
      job,
      keySuffix: 'pre',
      segStart: startAbs,
      segEnd: GANTT_MIDNIGHT,
      wrap: false,
      rounded: 'rounded-l-sm rounded-r-none',
      label: `${label} →`,
      title: `${titleBase} · continues past midnight (ends ${hhmm(job.end_at)})`,
      axisStart,
      axisEnd,
      span,
      idx,
    });
  }
  return segments;
}

/** Portion of a prior-day job that is still printing on ``dayIso``. */
export function buildContinuationSegments(
  job: GanttJobLike,
  dayIso: string,
  axisStart: number,
  axisEnd: number,
  span: number,
  idx: number,
): GanttSegment[] {
  const startAbs = minutesFromDay(job.start_at, dayIso);
  const endAbs = minutesFromDay(job.end_at, dayIso);
  // Started before today and still running after the visible axis opens.
  if (!(startAbs < 0 && endAbs > axisStart)) return [];

  const label = jobBarLabel(job);
  const titleBase = jobTitleBase(job);
  const segments: GanttSegment[] = [];
  const segEnd = Math.min(endAbs, GANTT_MIDNIGHT);
  const endsToday = endAbs <= GANTT_MIDNIGHT;
  pushGanttSegment(segments, {
    job,
    keySuffix: 'cont',
    segStart: 0,
    segEnd: Math.max(segEnd, axisStart + GANTT_MIN_SEG_MINUTES),
    wrap: true,
    rounded: endsToday ? 'rounded-r-sm rounded-l-none' : 'rounded-none',
    label: endsToday ? `${label} · ${hhmm(job.end_at)}` : `${label} →`,
    title: endsToday
      ? `${titleBase} · overnight continuation (ends ${hhmm(job.end_at)})`
      : `${titleBase} · still printing from prior day`,
    axisStart,
    axisEnd,
    span,
    idx,
  });
  return segments;
}

/** Jobs from earlier weekdays that still overlap ``dayIso`` for this printer. */
export function priorJobsForContinuation(
  priorDays: Array<{ lanes: Array<{ printer_id: number; jobs: GanttJobLike[] }> }>,
  printerId: number,
  dayIso: string,
  axisStart: number = GANTT_AXIS_START,
): GanttJobLike[] {
  const out: GanttJobLike[] = [];
  const seen = new Set<string>();
  for (const day of priorDays) {
    const lane = day.lanes.find((ln) => ln.printer_id === printerId);
    if (!lane) continue;
    for (const job of lane.jobs) {
      const startAbs = minutesFromDay(job.start_at, dayIso);
      const endAbs = minutesFromDay(job.end_at, dayIso);
      if (!(startAbs < 0 && endAbs > axisStart)) continue;
      const key = `${job.start_at}|${job.end_at}|${job.part_code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(job);
    }
  }
  return out;
}

export type ScheduleDayPartStats = {
  plates: number;
  parts: number;
  filenames: string[];
  quantities: number[];
};

/**
 * Whole plate starts + physical parts for one schedule day.
 * Counts only jobs that *start* on that day (same as the Gantt bars), never
 * fractional capacity rates.
 */
export function scheduleDayPartStats(
  day: { lanes?: Array<{ jobs?: GanttJobLike[] }> } | null | undefined,
): Map<string, ScheduleDayPartStats> {
  const map = new Map<string, ScheduleDayPartStats>();
  if (!day?.lanes) return map;
  for (const lane of day.lanes) {
    for (const job of lane.jobs || []) {
      const code = job.part_code;
      if (!code) continue;
      const qty = Math.max(1, Number(job.quantity_per_plate) || 1);
      let row = map.get(code);
      if (!row) {
        row = { plates: 0, parts: 0, filenames: [], quantities: [] };
        map.set(code, row);
      }
      row.plates += 1;
      row.parts += qty;
      const filename = job.filename?.trim();
      if (filename && !row.filenames.includes(filename)) {
        row.filenames.push(filename);
      }
      if (!row.quantities.includes(qty)) {
        row.quantities.push(qty);
      }
    }
  }
  return map;
}

/** True when two absolute minute ranges on the axis overlap. */
export function ganttRangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
