/**
 * Custom printer card order for the Printers tab.
 *
 * Stored in localStorage like the other Printers-page view prefs
 * (sort, card size, collapsed sections) so a refresh keeps the arrangement
 * without a backend migration.
 */

export const PRINTER_CUSTOM_ORDER_KEY = 'printerCustomOrder';

export function readPrinterCustomOrder(): number[] {
  try {
    const raw = localStorage.getItem(PRINTER_CUSTOM_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
  } catch {
    return [];
  }
}

export function writePrinterCustomOrder(ids: number[]): void {
  try {
    localStorage.setItem(PRINTER_CUSTOM_ORDER_KEY, JSON.stringify(ids));
  } catch {
    // quota exceeded / private mode — arrangement still applies for this session
  }
}

export function applyPrinterCustomOrder<T extends { id: number }>(items: T[], order: number[]): T[] {
  if (order.length === 0 || items.length <= 1) return items;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return 0;
  });
}

export function movePrinterInOrder<T extends { id: number }>(items: T[], id: number, delta: number): T[] {
  const index = items.findIndex((item) => item.id === id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= items.length) return items;
  const copy = [...items];
  const [moved] = copy.splice(index, 1);
  copy.splice(next, 0, moved);
  return copy;
}

/**
 * Merge a (possibly filtered) visible reorder into the full saved order so
 * printers hidden by search/status/location keep their previous slots instead
 * of being pinned to the end of a subset list.
 */
export function mergePrinterCustomOrder(
  visibleOrder: number[],
  previousOrder: number[],
  allIds: number[],
): number[] {
  const known = new Set(allIds);
  const visible = new Set(visibleOrder.filter((id) => known.has(id)));
  const base =
    previousOrder.length > 0
      ? [...previousOrder.filter((id) => known.has(id)), ...allIds.filter((id) => !previousOrder.includes(id))]
      : [...allIds];
  const queue = visibleOrder.filter((id) => known.has(id));
  return base.map((id) => (visible.has(id) ? queue.shift()! : id));
}
