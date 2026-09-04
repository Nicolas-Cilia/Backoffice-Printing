import { describe, expect, it } from 'vitest';
import {
  buildPartTimeline,
  consumedBySticker,
  FLOOR_PASS_BADGE_CLASS,
  FLOOR_PASS_EVENT_DOT_CLASS,
  formatCustomStatus,
  isFloorPassBinStatus,
  isFloorPassPartAction,
  kitAssignedBranches,
  partEventDotClass,
  partEventLabel,
  unitEventLabel,
} from '../../utils/floorPartHistory';

describe('floorPartHistory pass status styling', () => {
  it.each([
    'fit_check',
    'fit_checked',
    'ready_for_production',
    'support_removed',
    'overhang_removed',
    'hot_air_removed',
  ])('treats %s as a pass part action', (action) => {
    expect(isFloorPassPartAction(action)).toBe(true);
    expect(partEventDotClass(action)).toBe(FLOOR_PASS_EVENT_DOT_CLASS);
  });

  it('uses green badge styling for pass bin statuses', () => {
    expect(isFloorPassBinStatus('visual_qc_passed')).toBe(true);
    expect(isFloorPassBinStatus('ready_for_production')).toBe(true);
    expect(FLOOR_PASS_BADGE_CLASS).toContain('border-green-600');
    expect(FLOOR_PASS_BADGE_CLASS).toContain('dark:bg-green-500/20');
  });

  it('formats the new floor statuses for manual overrides', () => {
    expect(formatCustomStatus('ready_for_production')).toBe('Staged for Production');
    expect(formatCustomStatus('support_removed')).toBe('Support Removed');
    expect(formatCustomStatus('overhang_removed')).toBe('Overhang Removed');
    expect(formatCustomStatus('hot_air_removed')).toBe('Hot Air Removed');
  });

  it('reads the consuming TOP sticker from a consumed bin event', () => {
    expect(consumedBySticker({ source: 'kit_assign', part_sticker: 'BBD-000000' })).toBe(
      'BBD-000000',
    );
    expect(consumedBySticker({ source: 'kit_reassign', part_sticker: '  BBD-000123 ' })).toBe(
      'BBD-000123',
    );
  });

  it('returns null when a consumed bin event carries no sticker attribution', () => {
    expect(consumedBySticker(null)).toBeNull();
    expect(consumedBySticker(undefined)).toBeNull();
    expect(consumedBySticker({ source: 'kit_assign' })).toBeNull();
    expect(consumedBySticker({ part_sticker: '' })).toBeNull();
  });

  it('labels a WIP audit event as In WIP', () => {
    const t = (_key: string, fallback: string) => fallback;
    expect(
      partEventLabel(
        { id: 1, action: 'wip', details: null, occurred_at: '2026-08-27T12:00:00' },
        'TOP',
        t,
      ),
    ).toBe('In WIP');
  });

  it('uses a blue dot for WIP events', () => {
    expect(partEventDotClass('wip')).toBe('bg-sky-500');
    expect(partEventDotClass('in_wip')).toBe('bg-sky-500');
  });

  it('orders same-second WIP before kit_assigned in the timeline', () => {
    const timeline = buildPartTimeline(
      { id: 7, labeled_at: '2026-08-28T13:50:00', archive_id: 1 },
      [
        {
          id: 10,
          action: 'kit_assigned',
          details: {
            kit_knob_batch_id: 1,
            kit_button_batch_id: 2,
            knob_bin_payload: 'BBN-KNB-1',
            button_bin_payload: 'BBN-BUT-1',
          },
          occurred_at: '2026-08-28T13:53:00',
        },
        {
          id: 11,
          action: 'wip',
          details: null,
          occurred_at: '2026-08-28T13:53:00',
        },
      ],
    );
    const actions = timeline.map((event) => event.action);
    expect(actions.indexOf('wip')).toBeLessThan(actions.indexOf('kit_assigned'));
  });

  it('builds knob/button branches from a kit_assigned event', () => {
    expect(
      kitAssignedBranches({
        kit_knob_batch_id: 31,
        kit_button_batch_id: 32,
        knob_bin_payload: 'BBN-KNB-9',
        button_bin_payload: 'BBN-BUT-9',
      }),
    ).toEqual([
      { slot: 'KNB', batchId: 31, label: 'BBN-KNB-9 #31', payload: 'BBN-KNB-9' },
      { slot: 'BUT', batchId: 32, label: 'BBN-BUT-9 #32', payload: 'BBN-BUT-9' },
    ]);
  });

  it('labels serial timeline steps without repeating the serial', () => {
    const t = (_key: string, fallback: string, options?: Record<string, unknown>) =>
      options?.reason ? fallback.replace('{{reason}}', String(options.reason)) : fallback;
    expect(
      unitEventLabel(
        {
          id: 1,
          action: 'unit_linked',
          details: { serial_code: 'XG2SNP', unit_id: 7 },
          occurred_at: '2026-08-28T12:00:00',
        },
        t,
      ),
    ).toBe('Linked');
    expect(
      unitEventLabel(
        {
          id: 2,
          action: 'shipped',
          details: { serial_code: 'XG2SNP', unit_id: 7, source: 'serial_ready_to_ship' },
          occurred_at: '2026-08-29T15:00:00',
        },
        t,
      ),
    ).toBe('Ready to Ship');
    expect(
      unitEventLabel(
        {
          id: 3,
          action: 'rework',
          details: {
            source: 'serial_return',
            reason_code: 'doesnt_fit',
            reason_text: 'Customer return',
          },
          occurred_at: '2026-08-29T09:00:00',
        },
        t,
      ),
    ).toBe('Sent to Rework · doesnt fit · Customer return');
  });
});
