/** Recharts pie cornerRadius helpers for filament tracking charts. */

export const RING_CORNER = 6;
export const RING_GAP_ANGLE = 3;
/** Below this arc (degrees), Recharts cornerRadius draws square caps — skip it. */
export const MIN_SLICE_ANGLE_FOR_CORNER = 18;

/** Rounded pie caps only when the slice is wide enough for Recharts geometry. */
export function ringCornerRadiusForSlice(
  grams: number,
  totalGrams: number,
  sliceCount: number,
): number {
  if (grams <= 0 || totalGrams <= 0) return 0;
  if (sliceCount <= 1) return RING_CORNER;
  const usableAngle = 360 - RING_GAP_ANGLE * sliceCount;
  const sliceAngle = (grams / totalGrams) * usableAngle;
  return sliceAngle < MIN_SLICE_ANGLE_FOR_CORNER ? 0 : RING_CORNER;
}
