/**
 * Scan routing for the floor page (docs/floor-plan.md §4).
 *
 * A pistol types a string and Enter; the **prefix** decides what it means.
 * Classification is local and synchronous — the screen has to react the
 * instant Enter lands, and a round trip per keystroke-burst would show as lag
 * on every scan.
 *
 * **Dispatch is on (open station × prefix), never one-station-one-prefix.**
 * Harvest accepts `BBP-` then `BBD-`; cleanup accepts `BBD-`, `BBF-` and
 * `BBX-`. A station owning a single kind of code was never true, so the router
 * is shaped for the general case from the start — later phases add handlers to
 * this table rather than restructuring it.
 *
 * Phase 1b handles station codes only. Every other prefix is *recognised* but
 * unhandled, which is deliberately distinct from unrecognised: "not built yet"
 * and "that code means nothing" are different facts, and telling an operator
 * the wrong one wastes a trip to the office.
 */

/** Payload prefixes from §4. */
export const PREFIX_STATION = 'BBS-';
export const PREFIX_PRINTER = 'BBP-';
export const PREFIX_PART = 'BBD-';
export const PREFIX_DEFECT = 'BBF-';
export const PREFIX_COMMAND = 'BBX-';

/** What kind of code a payload is, before any station context is applied. */
export type ScanKind = 'station' | 'printer' | 'part' | 'defect' | 'command' | 'sku';

export type ScanClassification =
  | { kind: 'empty' }
  | { kind: ScanKind; value: string };

const PREFIX_KINDS: ReadonlyArray<readonly [string, ScanKind]> = [
  [PREFIX_STATION, 'station'],
  [PREFIX_PRINTER, 'printer'],
  [PREFIX_PART, 'part'],
  [PREFIX_DEFECT, 'defect'],
  [PREFIX_COMMAND, 'command'],
];

/**
 * Classify one scanned string by prefix.
 *
 * Trims first: a gun's configured suffix can append whitespace, and a stray
 * space must not turn a perfectly good label into an unknown code.
 *
 * Anything without a known prefix is a factory SKU — filament barcodes are
 * printed by the vendor, so they have no prefix of ours to match. That makes
 * `sku` the catch-all rather than a positively identified kind, which is why
 * an unregistered SKU can only be discovered server-side (§6.3).
 */
export function classifyScan(raw: string): ScanClassification {
  const value = raw.trim();
  if (!value) return { kind: 'empty' };

  for (const [prefix, kind] of PREFIX_KINDS) {
    if (value.startsWith(prefix)) return { kind, value };
  }
  return { kind: 'sku', value };
}

/** What the page should do with a scan, given the station currently open. */
export type ScanAction =
  /** A `BBS-` code: hand to the session API (open / close / switch). */
  | { action: 'station'; payload: string }
  /** A real code whose handling lands in a later phase. */
  | { action: 'not-implemented'; kind: ScanKind; value: string }
  /** Nothing scannable. */
  | { action: 'ignore' };

/**
 * Route a scan against the open station.
 *
 * `stationSlug` is the station currently open on this device, or null. It is
 * unused in phase 1b — every non-station code is unhandled regardless of mode
 * — but it is the parameter later phases key on (a `BBD-` means "link this
 * part" under harvest and "look up this part" under cleanup), so it is part of
 * the signature now rather than threaded through later.
 */
export function routeScan(raw: string, stationSlug: string | null): ScanAction {
  const scan = classifyScan(raw);
  if (scan.kind === 'empty') return { action: 'ignore' };
  if (scan.kind === 'station') return { action: 'station', payload: scan.value };

  void stationSlug;
  return { action: 'not-implemented', kind: scan.kind, value: scan.value };
}

/** "4m", "1h 12m" — coarse on purpose. The question it answers is "has this
 *  been sitting open longer than it should have", not "how long exactly". */
export function formatElapsed(totalSeconds: number): string {
  const minutes = Math.max(0, Math.floor(totalSeconds / 60));
  if (minutes < 1) return '<1m';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${minutes}m`;
}
