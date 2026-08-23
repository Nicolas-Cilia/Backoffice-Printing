/** Recharts pie cornerRadius helpers for filament tracking charts. */

export const RING_CORNER = 6;
export const RING_GAP_ANGLE = 3;

/**
 * Inner ring radius in px. The chart box is a fixed 10.5rem (168px) square
 * (size-[10.5rem] in FilamentTrackingPage); Recharts subtracts its default
 * 5px chart margin per side, leaving a 79px max radius, and the Pie uses
 * innerRadius="62%" ≈ 49px. Undershooting slightly only shrinks the corner
 * radius a touch — it can never reintroduce square caps.
 */
const INNER_RADIUS_PX = 48;

/** Slack so float rounding inside Recharts can't tip a borderline slice
 * back into the square-cap fallback path. */
const CORNER_SAFETY = 0.9;

/**
 * Largest cornerRadius Recharts can actually round a slice of this arc with.
 *
 * Recharts' Sector spends asin(cr / (R ± cr)) degrees of arc on every rounded
 * corner (getTangentCircle). When the two corners on one edge need more
 * degrees than the slice has, getSectorWithCorner silently falls back to a
 * plain square-edged sector path — the "square caps on small slices" bug.
 * The inner edge (smaller R) is the binding constraint:
 *   2·asin(cr / (INNER_RADIUS_PX + cr)) ≤ arc
 * Solving for cr: cr ≤ sin(arc/2)·R / (1 − sin(arc/2)). Instead of zeroing
 * the radius below a threshold (which guaranteed square caps), shrink it
 * smoothly so every slice keeps fully rounded caps.
 */
export function ringCornerRadiusForArc(arcDegrees: number): number {
  if (arcDegrees <= 0) return 0;
  // The full RING_CORNER is already safe from ~14° up; skip the trig well
  // above that so wide slices (including arc > 180°) take the fast path.
  if (arcDegrees >= 30) return RING_CORNER;
  const s = Math.sin((arcDegrees / 2) * (Math.PI / 180));
  const maxCorner = (s * INNER_RADIUS_PX) / (1 - s);
  return Math.min(RING_CORNER, CORNER_SAFETY * maxCorner);
}

/** Rounded pie caps sized to what each slice's geometry supports. */
export function ringCornerRadiusForSlice(
  grams: number,
  totalGrams: number,
  sliceCount: number,
): number {
  if (grams <= 0 || totalGrams <= 0) return 0;
  if (sliceCount <= 1) return RING_CORNER;
  const usableAngle = 360 - RING_GAP_ANGLE * sliceCount;
  if (usableAngle <= 0) return 0;
  const sliceAngle = (grams / totalGrams) * usableAngle;
  return ringCornerRadiusForArc(sliceAngle);
}
