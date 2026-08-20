/**
 * trackingProductLabel — named Inventory Tracking products (color, brand,
 * material, subtype). extra_colors / effect_type stay on the swatch, not the text.
 * groupRecentUsage — one Recent usage row per print job.
 */

import { describe, it, expect } from 'vitest';
import { groupRecentUsage, trackingProductLabel } from '../../utils/filamentTracking';
import type { FilamentTrackingEvent } from '../../api/client';

function event(overrides: Partial<FilamentTrackingEvent> & Pick<FilamentTrackingEvent, 'id'>): FilamentTrackingEvent {
  return {
    bucket_id: 1,
    color_name: 'White',
    material: 'PLA',
    brand: null,
    subtype: null,
    extra_colors: null,
    effect_type: null,
    color_hex: 'FFFFFF',
    grams: 10,
    occurred_at: '2026-08-20T12:00:00Z',
    kind: 'printing',
    progress: 12,
    archive_id: 5,
    printer_id: 2,
    print_name: 'BTN-x47-.2mm-height-.53-width-1.0.0-X1C',
    ...overrides,
  };
}

describe('trackingProductLabel', () => {
  it('joins color, brand, material, and subtype', () => {
    expect(
      trackingProductLabel({
        color_name: 'EasyRock White',
        material: 'PLA',
        brand: 'EasyRock',
        subtype: 'Basic',
      }),
    ).toBe('EasyRock White · EasyRock · PLA · Basic');
  });

  it('omits empty brand and subtype', () => {
    expect(
      trackingProductLabel({
        color_name: 'Jade White',
        material: 'PLA',
        brand: null,
        subtype: '',
      }),
    ).toBe('Jade White · PLA');
  });

  it('omits extra_colors hex and effect_type from the text', () => {
    expect(
      trackingProductLabel({
        color_name: 'EasyRock White',
        material: 'PLA',
        brand: null,
        subtype: null,
        extra_colors: '000000',
        effect_type: 'sparkle',
      }),
    ).toBe('EasyRock White · PLA');
  });

  it('does not put sparkle fleck hexes in the label', () => {
    const gold = trackingProductLabel({
      color_name: 'White',
      material: 'PLA',
      brand: 'EasyRock',
      extra_colors: 'FFD700',
      effect_type: 'sparkle',
    });
    const silver = trackingProductLabel({
      color_name: 'White',
      material: 'PLA',
      brand: 'EasyRock',
      extra_colors: 'C0C0C0',
      effect_type: 'sparkle',
    });
    expect(gold).toBe('White · EasyRock · PLA');
    expect(silver).toBe('White · EasyRock · PLA');
    expect(gold).not.toMatch(/FFD700|sparkle/i);
    expect(silver).not.toMatch(/C0C0C0|sparkle/i);
  });

  it('omits null extra_colors and effect_type', () => {
    expect(
      trackingProductLabel({
        color_name: 'Jade White',
        material: 'PLA',
        brand: 'Bambu Lab',
        extra_colors: null,
        effect_type: null,
      }),
    ).toBe('Jade White · Bambu Lab · PLA');
  });
});

describe('groupRecentUsage', () => {
  it('collapses two colors on the same printer archive into one job', () => {
    const jobs = groupRecentUsage([
      event({
        id: 1,
        bucket_id: 1,
        color_name: 'EasyRock White',
        grams: 21.1,
        printer_id: 2,
        archive_id: 5,
      }),
      event({
        id: 2,
        bucket_id: 2,
        color_name: 'Black',
        color_hex: '000000',
        grams: 3.4,
        printer_id: 2,
        archive_id: 5,
      }),
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].products.map((row) => row.color_name)).toEqual(['EasyRock White', 'Black']);
    expect(jobs[0].grams).toBeCloseTo(24.5);
    expect(jobs[0].print_name).toBe('BTN-x47-.2mm-height-.53-width-1.0.0-X1C');
    expect(jobs[0].printer_id).toBe(2);
  });

  it('keeps the same filename on two printers as two jobs', () => {
    const jobs = groupRecentUsage([
      event({ id: 1, printer_id: 2, archive_id: 5, grams: 21 }),
      event({ id: 2, printer_id: 1, archive_id: 5, bucket_id: 2, color_name: 'Black', grams: 3 }),
    ]);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.printer_id)).toEqual([2, 1]);
  });

  it('merges two slots of the same product on one job', () => {
    const jobs = groupRecentUsage([
      event({ id: 1, bucket_id: 1, grams: 10, archive_id: 5, printer_id: 2 }),
      event({ id: 2, bucket_id: 1, grams: 4, archive_id: 5, printer_id: 2 }),
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].products).toHaveLength(1);
    expect(jobs[0].products[0].grams).toBe(14);
    expect(jobs[0].grams).toBe(14);
    expect(jobs[0].estimated).toBe(false);
  });

  it('flags a job estimated only when skip-objects marked a product', () => {
    const jobs = groupRecentUsage([
      event({ id: 1, grams: 59.8, estimated: true, progress: 45 }),
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].estimated).toBe(true);
    expect(jobs[0].grams).toBeCloseTo(59.8);
  });

  it('does not flag estimated for remain-unavailable 3MF grams without skips', () => {
    const jobs = groupRecentUsage([
      event({ id: 1, grams: 133, estimated: false, kind: 'completed', progress: null }),
    ]);
    expect(jobs[0].estimated).toBe(false);
    expect(jobs[0].grams).toBe(133);
  });

  it('does not merge unrelated events without archive or shared printer name', () => {
    const jobs = groupRecentUsage([
      event({
        id: 1,
        archive_id: null,
        printer_id: null,
        print_name: null,
        grams: 8,
      }),
      event({
        id: 2,
        archive_id: null,
        printer_id: null,
        print_name: null,
        grams: 3,
      }),
    ]);
    expect(jobs).toHaveLength(2);
  });

  it('marks a job estimated when any product is estimated', () => {
    const jobs = groupRecentUsage([
      event({ id: 1, estimated: true, grams: 133, kind: 'completed', progress: null }),
    ]);
    expect(jobs[0].estimated).toBe(true);
    expect(jobs[0].grams).toBe(133);
  });
});
