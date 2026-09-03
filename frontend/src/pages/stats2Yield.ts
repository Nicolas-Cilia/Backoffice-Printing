/** Pipeline composition for Production yield — where expected units went. */

export type YieldPartTotals = {
  expected_total?: number | null;
  harvested_total?: number | null;
  qc_passed_total?: number | null;
  wip_total?: number | null;
  shipped_total?: number | null;
};

export type YieldWhereSegment = {
  id: 'shipped' | 'still_wip' | 'awaiting_wip' | 'qc_scrap' | 'shortfall';
  value: number;
  label: string;
  /** Tailwind background class for the bar segment. */
  className: string;
};

export type YieldWhereUnitsWent = {
  expected: number;
  harvested: number;
  qcPassed: number;
  wip: number;
  shipped: number;
  /** Harvest − QC (real rejects / fails). */
  qcScrap: number;
  /** max(0, WIP − shipped): still on the floor. */
  stillInWip: number;
  /** max(0, QC − WIP): passed QC, not yet marked WIP. */
  awaitingWip: number;
  /** max(0, expected − harvest): not harvested yet (or short). */
  shortfall: number;
  /** Denominator for the stacked bar (never under-counts segments). */
  barTotal: number;
  segments: YieldWhereSegment[];
};

const SEGMENT_META: Record<
  YieldWhereSegment['id'],
  { label: string; className: string }
> = {
  shipped: { label: 'Shipped', className: 'bg-green-500' },
  still_wip: { label: 'Still in WIP', className: 'bg-blue-500' },
  awaiting_wip: { label: 'QC passed, awaiting WIP', className: 'bg-violet-500' },
  qc_scrap: { label: 'QC scrap', className: 'bg-amber-500' },
  shortfall: { label: 'Short of expected', className: 'bg-slate-400' },
};

/**
 * Telescoping breakdown of expected → harvest → QC → WIP → shipped.
 *
 * When harvest ≤ expected and counts nest (shipped ≤ wip ≤ qc ≤ harvest),
 * segments sum to expected. Over-harvest widens the bar to harvested volume
 * instead of inventing a fake "lost" gap.
 */
export function yieldWhereUnitsWent(parts: YieldPartTotals[]): YieldWhereUnitsWent {
  const expected = parts.reduce((a, p) => a + (Number(p.expected_total) || 0), 0);
  const harvested = parts.reduce((a, p) => a + (Number(p.harvested_total) || 0), 0);
  const qcPassed = parts.reduce((a, p) => a + (Number(p.qc_passed_total) || 0), 0);
  const wip = parts.reduce((a, p) => a + (Number(p.wip_total) || 0), 0);
  const shipped = parts.reduce((a, p) => a + (Number(p.shipped_total) || 0), 0);

  const qcScrap = Math.max(0, harvested - qcPassed);
  const stillInWip = Math.max(0, wip - shipped);
  const awaitingWip = Math.max(0, qcPassed - wip);
  const shortfall = Math.max(0, expected - harvested);

  const pipeline = shipped + stillInWip + awaitingWip + qcScrap;
  const barTotal = Math.max(expected, pipeline + shortfall, 1);

  const raw: Array<{ id: YieldWhereSegment['id']; value: number }> = [
    { id: 'shipped', value: shipped },
    { id: 'still_wip', value: stillInWip },
    { id: 'awaiting_wip', value: awaitingWip },
    { id: 'qc_scrap', value: qcScrap },
    { id: 'shortfall', value: shortfall },
  ];

  const segments: YieldWhereSegment[] = raw
    .filter((s) => s.value > 0)
    .map((s) => ({
      id: s.id,
      value: s.value,
      label: SEGMENT_META[s.id].label,
      className: SEGMENT_META[s.id].className,
    }));

  return {
    expected,
    harvested,
    qcPassed,
    wip,
    shipped,
    qcScrap,
    stillInWip,
    awaitingWip,
    shortfall,
    barTotal,
    segments,
  };
}
