import { describe, expect, it } from 'vitest';
import { yieldWhereUnitsWent } from '../../pages/stats2Yield';

describe('yieldWhereUnitsWent', () => {
  it('telescopes to expected when harvest ≤ expected and counts nest', () => {
    const result = yieldWhereUnitsWent([
      {
        expected_total: 100,
        harvested_total: 80,
        qc_passed_total: 70,
        wip_total: 50,
        shipped_total: 20,
      },
    ]);
    expect(result.shipped).toBe(20);
    expect(result.stillInWip).toBe(30);
    expect(result.awaitingWip).toBe(20);
    expect(result.qcScrap).toBe(10);
    expect(result.shortfall).toBe(20);
    expect(result.segments.reduce((a, s) => a + s.value, 0)).toBe(100);
    expect(result.barTotal).toBe(100);
    expect(result.segments.map((s) => s.id)).not.toContain('lost' as never);
  });

  it('does not invent lost when most units are still in WIP', () => {
    const result = yieldWhereUnitsWent([
      { expected_total: 244, harvested_total: 197, qc_passed_total: 191, wip_total: 166, shipped_total: 38 },
    ]);
    expect(result.shipped).toBe(38);
    expect(result.stillInWip).toBe(128);
    expect(result.awaitingWip).toBe(25);
    expect(result.qcScrap).toBe(6);
    expect(result.shortfall).toBe(47);
    expect(result.segments.reduce((a, s) => a + s.value, 0)).toBe(244);
    // Old "lost" would have been 206 — that must not appear as a single scrap bucket.
    expect(result.qcScrap).toBeLessThan(50);
    expect(result.stillInWip + result.awaitingWip).toBeGreaterThan(100);
  });

  it('widens the bar on over-harvest instead of negative shortfall', () => {
    const result = yieldWhereUnitsWent([
      {
        expected_total: 40,
        harvested_total: 53,
        qc_passed_total: 50,
        wip_total: 33,
        shipped_total: 19,
      },
    ]);
    expect(result.shortfall).toBe(0);
    expect(result.qcScrap).toBe(3);
    expect(result.stillInWip).toBe(14);
    expect(result.awaitingWip).toBe(17);
    const sum = result.segments.reduce((a, s) => a + s.value, 0);
    expect(sum).toBe(53);
    expect(result.barTotal).toBe(53);
  });

  it('sums across parts', () => {
    const result = yieldWhereUnitsWent([
      { expected_total: 39, harvested_total: 53, qc_passed_total: 50, wip_total: 33, shipped_total: 19 },
      { expected_total: 94, harvested_total: 70, qc_passed_total: 70, wip_total: 70, shipped_total: 0 },
      { expected_total: 94, harvested_total: 43, qc_passed_total: 43, wip_total: 43, shipped_total: 0 },
      { expected_total: 17, harvested_total: 31, qc_passed_total: 28, wip_total: 20, shipped_total: 19 },
    ]);
    expect(result.expected).toBe(244);
    expect(result.shipped).toBe(38);
    expect(result.qcScrap).toBe(6);
  });
});
