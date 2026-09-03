import { describe, expect, it } from 'vitest';
import {
  GANTT_AXIS_END,
  GANTT_AXIS_START,
  buildContinuationSegments,
  buildJobSegments,
  ganttRangesOverlap,
  minutesFromDay,
  priorJobsForContinuation,
  scheduleDayPartStats,
} from '../../pages/stats2Gantt';

const SPAN = GANTT_AXIS_END - GANTT_AXIS_START;

function ranges(segs: { leftPct: number; widthPct: number }[]) {
  return segs.map((s) => {
    const start = GANTT_AXIS_START + (s.leftPct / 100) * SPAN;
    const end = start + (s.widthPct / 100) * SPAN;
    return [start, end] as const;
  });
}

describe('stats2Gantt overnight rendering', () => {
  it('does not wrap tomorrow morning onto the start day (avoids left-edge collision)', () => {
    const job = {
      part_code: 'TOP',
      quantity_per_plate: 1,
      start_at: '2026-09-01T17:06:00',
      end_at: '2026-09-02T01:52:00',
    };
    const segs = buildJobSegments(job, '2026-09-01', GANTT_AXIS_START, GANTT_AXIS_END, SPAN, 0);
    expect(segs.every((s) => !s.wrap)).toBe(true);
    expect(segs).toHaveLength(1);
    // Runs to midnight only.
    const [start, end] = ranges(segs)[0];
    expect(start).toBeGreaterThan(16 * 60);
    expect(end).toBe(GANTT_AXIS_END);
  });

  it('shows overnight remainder as continuation on the next day', () => {
    const job = {
      part_code: 'TOP',
      quantity_per_plate: 1,
      start_at: '2026-09-01T17:06:00',
      end_at: '2026-09-02T01:52:00',
    };
    const cont = buildContinuationSegments(job, '2026-09-02', GANTT_AXIS_START, GANTT_AXIS_END, SPAN, 0);
    expect(cont).toHaveLength(1);
    expect(cont[0].wrap).toBe(true);
    const [, end] = ranges(cont)[0];
    expect(end).toBeCloseTo(1 * 60 + 52, 0);
  });

  it('does not paint continuation and a same-day wrap colliding on the left edge', () => {
    const yesterday = {
      part_code: 'TOP',
      quantity_per_plate: 1,
      start_at: '2026-09-01T16:56:00',
      end_at: '2026-09-02T01:42:00',
    };
    const today = {
      part_code: 'TOP',
      quantity_per_plate: 1,
      start_at: '2026-09-02T17:06:00',
      end_at: '2026-09-03T01:52:00',
    };
    const cont = buildContinuationSegments(yesterday, '2026-09-02', GANTT_AXIS_START, GANTT_AXIS_END, SPAN, 0);
    const todaySegs = buildJobSegments(today, '2026-09-02', GANTT_AXIS_START, GANTT_AXIS_END, SPAN, 1);
    const all = [...ranges(cont), ...ranges(todaySegs)];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(ganttRangesOverlap(all[i][0], all[i][1], all[j][0], all[j][1])).toBe(false);
      }
    }
  });

  it('continues multi-day jobs across more than one midnight', () => {
    const job = {
      part_code: 'TOP',
      quantity_per_plate: 4,
      start_at: '2026-09-01T10:00:00',
      end_at: '2026-09-03T08:24:00',
    };
    const priorDays = [
      { lanes: [{ printer_id: 2, jobs: [job] }] },
      { lanes: [{ printer_id: 2, jobs: [] }] },
    ];
    // Wednesday still sees Monday's job via full prior history (not only yesterday).
    const still = priorJobsForContinuation(priorDays, 2, '2026-09-03');
    expect(still).toHaveLength(1);
    const cont = buildContinuationSegments(still[0], '2026-09-03', GANTT_AXIS_START, GANTT_AXIS_END, SPAN, 0);
    expect(cont).toHaveLength(1);
    expect(minutesFromDay(job.end_at, '2026-09-03')).toBe(8 * 60 + 24);
  });
});

describe('scheduleDayPartStats', () => {
  it('counts whole plate starts and physical parts (no decimals)', () => {
    const stats = scheduleDayPartStats({
      lanes: [
        {
          jobs: [
            {
              part_code: 'BUT',
              quantity_per_plate: 47,
              filename: 'BUT x47.3mf',
              start_at: '2026-09-01T08:00:00',
              end_at: '2026-09-01T12:00:00',
            },
            {
              part_code: 'TOP',
              quantity_per_plate: 2,
              filename: 'TOP x2.3mf',
              start_at: '2026-09-01T08:00:00',
              end_at: '2026-09-01T10:00:00',
            },
          ],
        },
        {
          jobs: [
            {
              part_code: 'TOP',
              quantity_per_plate: 1,
              filename: 'TOP x1.3mf',
              start_at: '2026-09-01T10:10:00',
              end_at: '2026-09-01T11:00:00',
            },
          ],
        },
      ],
    });
    expect(stats.get('BUT')).toEqual({
      plates: 1,
      parts: 47,
      filenames: ['BUT x47.3mf'],
      quantities: [47],
    });
    expect(stats.get('TOP')).toEqual({
      plates: 2,
      parts: 3,
      filenames: ['TOP x2.3mf', 'TOP x1.3mf'],
      quantities: [2, 1],
    });
  });

  it('returns empty map when day has no lanes', () => {
    expect(scheduleDayPartStats(undefined).size).toBe(0);
    expect(scheduleDayPartStats({ lanes: [] }).size).toBe(0);
  });
});
