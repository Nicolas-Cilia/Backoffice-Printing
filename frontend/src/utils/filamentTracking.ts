import type { FilamentTrackingEvent } from '../api/client';

/** Label a tracking product the way the stock table and assign modal show it.
 *  Text is the given color name plus brand/material/subtype. extra_colors hex
 *  and effect_type stay on the swatch (sparkle flecks), not in this string. */
export function trackingProductLabel(row: {
  color_name: string;
  material: string;
  brand?: string | null;
  subtype?: string | null;
  extra_colors?: string | null;
  effect_type?: string | null;
}): string {
  return [row.color_name, row.brand, row.material, row.subtype]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' · ');
}

export type RecentUsageJob = {
  key: string;
  products: FilamentTrackingEvent[];
  print_name: string | null;
  printer_id: number | null;
  archive_id: number | null;
  kind: string;
  progress: number | null;
  occurred_at: string;
  grams: number;
  estimated: boolean;
};

function recentUsageJobKey(event: FilamentTrackingEvent): string {
  const printer = event.printer_id ?? 'none';
  if (event.archive_id != null) {
    return `printer:${printer}:archive:${event.archive_id}`;
  }
  const name = (event.print_name || '').trim().toLowerCase();
  if (name) {
    return `printer:${printer}:${event.kind}:${name}`;
  }
  return `printer:${printer}:event:${event.id}`;
}

function mergeJobProducts(events: FilamentTrackingEvent[]): FilamentTrackingEvent[] {
  const byBucket = new Map<number, FilamentTrackingEvent>();
  for (const event of events) {
    const existing = byBucket.get(event.bucket_id);
    if (!existing) {
      byBucket.set(event.bucket_id, { ...event });
      continue;
    }
    existing.grams += event.grams;
    existing.estimated = Boolean(existing.estimated) || Boolean(event.estimated);
    if (event.progress != null && (existing.progress == null || event.progress > existing.progress)) {
      existing.progress = event.progress;
    }
    if (event.occurred_at > existing.occurred_at) existing.occurred_at = event.occurred_at;
  }
  return [...byBucket.values()].sort(
    (a, b) => Math.abs(b.grams) - Math.abs(a.grams) || a.color_name.localeCompare(b.color_name),
  );
}

/** One Recent usage row per print job (same printer + archive, or live name). */
export function groupRecentUsage(events: FilamentTrackingEvent[]): RecentUsageJob[] {
  const groups = new Map<string, FilamentTrackingEvent[]>();
  const order: string[] = [];
  for (const event of events) {
    const key = recentUsageJobKey(event);
    const rows = groups.get(key);
    if (!rows) {
      groups.set(key, [event]);
      order.push(key);
    } else {
      rows.push(event);
    }
  }
  return order.map((key) => {
    const products = mergeJobProducts(groups.get(key) ?? []);
    const head = products[0];
    const progress = products.reduce<number | null>((max, event) => {
      if (event.progress == null) return max;
      return max == null ? event.progress : Math.max(max, event.progress);
    }, null);
    const occurred_at = products.reduce(
      (latest, event) => (event.occurred_at > latest ? event.occurred_at : latest),
      head?.occurred_at ?? '',
    );
    return {
      key,
      products,
      print_name: products.find((event) => event.print_name?.trim())?.print_name ?? null,
      printer_id: head?.printer_id ?? null,
      archive_id: head?.archive_id ?? null,
      kind: head?.kind ?? 'completed',
      progress,
      occurred_at,
      grams: products.reduce((sum, event) => sum + Math.abs(event.grams), 0),
      estimated: products.some((event) => Boolean(event.estimated)),
    };
  });
}
