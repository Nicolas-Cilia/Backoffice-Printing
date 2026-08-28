import { describe, expect, it } from 'vitest';
import {
  FLOOR_PASS_BADGE_CLASS,
  FLOOR_PASS_EVENT_DOT_CLASS,
  formatCustomStatus,
  isFloorPassBinStatus,
  isFloorPassPartAction,
  partEventDotClass,
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
});
