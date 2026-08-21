const EXTERNAL_AMS_ID = 255;
const REGULAR_AMS_SLOT_COUNT = 4;

export type TrackingAssignmentLike = {
  ams_id: number;
  tray_id: number;
  color_hex?: string | null;
  extra_colors?: string | null;
  effect_type?: string | null;
  subtype?: string | null;
  color_name?: string;
};

export type TrackingAmsUnitLike = {
  id: number;
  tray: Array<{ id: number }>;
};

export type TrackingSlotDot =
  | {
      kind: 'tracked';
      trayId: number;
      color_hex: string | null;
      extra_colors: string | null;
      effect_type: string | null;
      subtype: string | null;
      color_name?: string;
    }
  | { kind: 'empty'; trayId: number };

export type TrackingAmsGroup = {
  amsId: number;
  slots: TrackingSlotDot[];
};

/** RRGGBBAA without `#`, for FilamentSwatch. */
export function trackingHexToRgba(hex: string | null | undefined): string | undefined {
  const clean = (hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6,8}$/.test(clean)) return undefined;
  return `${clean.slice(0, 6).toUpperCase()}FF`;
}

function uniqueRegularAmsIds(assignments: TrackingAssignmentLike[]): number[] {
  return [...new Set(assignments.map((row) => row.ams_id).filter((id) => id !== EXTERNAL_AMS_ID))].sort(
    (a, b) => a - b,
  );
}

function slotsForUnit(
  unit: TrackingAmsUnitLike,
  assignments: TrackingAssignmentLike[],
): TrackingSlotDot[] {
  const trayIds =
    unit.tray.length > 0
      ? [...unit.tray].sort((a, b) => a.id - b.id).map((tray) => tray.id)
      : Array.from({ length: REGULAR_AMS_SLOT_COUNT }, (_, i) => i);

  return trayIds.map((trayId) => {
    const assigned = assignments.find((row) => row.ams_id === unit.id && row.tray_id === trayId);
    if (!assigned) return { kind: 'empty', trayId };
    return {
      kind: 'tracked',
      trayId,
      color_hex: assigned.color_hex ?? null,
      extra_colors: assigned.extra_colors ?? null,
      effect_type: assigned.effect_type ?? null,
      subtype: assigned.subtype ?? null,
      color_name: assigned.color_name,
    };
  });
}

/**
 * One group per AMS, slots in AMS order. Untracked slots stay in place as
 * empty so a 1/3/4 assignment still shows slot 2.
 */
export function trackingAmsSwatchGroups(
  assignments: TrackingAssignmentLike[],
  amsUnits: TrackingAmsUnitLike[] = [],
): TrackingAmsGroup[] {
  const regularUnits = amsUnits.filter((unit) => unit.tray.length > 1);
  const units: TrackingAmsUnitLike[] =
    regularUnits.length > 0
      ? regularUnits
      : uniqueRegularAmsIds(assignments).map((id) => ({
          id,
          tray: Array.from({ length: REGULAR_AMS_SLOT_COUNT }, (_, i) => ({ id: i })),
        }));

  return units
    .map((unit) => ({
      amsId: unit.id,
      slots: slotsForUnit(unit, assignments),
    }))
    .filter((group) => group.slots.some((slot) => slot.kind === 'tracked'));
}
