import { FilamentSwatch } from './FilamentSwatch';
import { trackingProductLabel } from '../utils/filamentTracking';

/** Assignment payload from PrintersPage `trackingForSlot` — not a second source. */
export type SlotTrackingAssigned = {
  color_name: string;
  material: string;
  brand?: string | null;
  subtype?: string | null;
  color_hex: string | null;
  extra_colors?: string | null;
  effect_type?: string | null;
};

function swatchRgba(hex: string | null | undefined): string | undefined {
  const clean = (hex || '').replace('#', '');
  if (clean.length >= 6) return `${clean.slice(0, 6)}FF`;
  return undefined;
}

/**
 * Compact Inventory Tracking product label shown under an AMS/external slot.
 * Renders nothing when the slot has no tracking assignment — never invents a color.
 */
export function SlotTrackingLabel({
  assigned,
}: {
  assigned: SlotTrackingAssigned | null | undefined;
}) {
  if (!assigned) return null;
  const label = trackingProductLabel(assigned);
  if (!label) return null;

  const rgba = swatchRgba(assigned.color_hex);
  const showSwatch = Boolean(rgba || assigned.extra_colors);

  return (
    <div
      data-testid="slot-tracking-label"
      className="mt-0.5 flex min-w-0 items-center justify-center gap-0.5 px-0.5"
      title={label}
    >
      {showSwatch && (
        <FilamentSwatch
          rgba={rgba}
          extraColors={assigned.extra_colors}
          effectType={assigned.effect_type}
          subtype={assigned.subtype}
          className="w-[14px] h-[14px]"
          effectSize="table"
        />
      )}
      <span className="truncate text-[8px] leading-tight text-bambu-gray">{label}</span>
    </div>
  );
}

export default SlotTrackingLabel;
