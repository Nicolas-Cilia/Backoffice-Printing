/** Label a tracking product the way the stock table and assign modal show it. */
export function trackingProductLabel(row: {
  color_name: string;
  material: string;
  brand?: string | null;
  subtype?: string | null;
}): string {
  return [row.color_name, row.brand, row.material, row.subtype]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' · ');
}
