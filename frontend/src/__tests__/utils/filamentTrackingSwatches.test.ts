import { describe, expect, it } from 'vitest';
import {
  trackingAmsSwatchGroups,
  trackingHexToRgba,
} from '../../utils/filamentTrackingSwatches';

describe('trackingAmsSwatchGroups', () => {
  it('keeps AMS slot order and marks untracked slots empty', () => {
    const groups = trackingAmsSwatchGroups(
      [
        { ams_id: 0, tray_id: 0, color_hex: 'FFFFFF' },
        { ams_id: 0, tray_id: 2, color_hex: 'FF0000' },
        { ams_id: 0, tray_id: 3, color_hex: '00FF00' },
      ],
      [
        {
          id: 0,
          tray: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }],
        },
      ],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].slots.map((slot) => slot.kind)).toEqual(['tracked', 'empty', 'tracked', 'tracked']);
    expect(groups[0].slots.map((slot) => slot.trayId)).toEqual([0, 1, 2, 3]);
  });

  it('ignores AMS units with no tracking assignments', () => {
    const groups = trackingAmsSwatchGroups(
      [{ ams_id: 0, tray_id: 0, color_hex: 'FFFFFF' }],
      [
        { id: 0, tray: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }] },
        { id: 1, tray: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }] },
      ],
    );
    expect(groups.map((group) => group.amsId)).toEqual([0]);
  });

  it('falls back to four slots when AMS telemetry is missing', () => {
    const groups = trackingAmsSwatchGroups([{ ams_id: 0, tray_id: 1, color_hex: '4B0082' }]);
    expect(groups[0].slots).toHaveLength(4);
    expect(groups[0].slots[1]).toMatchObject({ kind: 'tracked', trayId: 1 });
    expect(groups[0].slots.filter((slot) => slot.kind === 'empty')).toHaveLength(3);
  });
});

describe('trackingHexToRgba', () => {
  it('normalizes 6-char hex to RRGGBBAA', () => {
    expect(trackingHexToRgba('#ffffff')).toBe('FFFFFFFF');
  });
});
