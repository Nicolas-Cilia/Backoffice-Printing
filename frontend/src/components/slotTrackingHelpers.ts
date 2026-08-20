/**
 * Highlight class for an AMS/external slot tile.
 * Lives here so SlotTrackingLabel.tsx only exports React components
 * (`react-refresh/only-export-components`).
 *
 * Inset (no offset) so the ring stays inside the tile and does not collide
 * with SlotTrackingLabel underneath.
 */
export function amsSlotHighlightClass({
  isActive = false,
  isExpected = false,
  isRanOut = false,
}: {
  isActive?: boolean;
  isExpected?: boolean;
  isRanOut?: boolean;
} = {}): string {
  if (isExpected) return 'ring-1 ring-inset ring-amber-400 animate-pulse';
  if (isRanOut) return 'ring-1 ring-inset ring-red-500/70';
  if (isActive) return 'ring-1 ring-inset ring-bambu-green';
  return 'ring-1 ring-inset ring-black/10 dark:ring-white/12';
}
