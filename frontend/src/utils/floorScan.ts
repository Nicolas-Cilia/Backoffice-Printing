/**
 * Scan routing for the floor page (docs/floor-plan.md §4).
 *
 * A pistol types a string and Enter; the **prefix** decides what it means.
 * Classification is local and synchronous — the screen has to react the
 * instant Enter lands, and a round trip per keystroke-burst would show as lag
 * on every scan.
 *
 * **Dispatch is on (open station × prefix), never one-station-one-prefix.**
 * Harvest accepts `BBP-` then `BBD-`; part/error flows are handled from idle
 * through Fit Check, Rework, and Discard. A station owning a single kind of code was never true, so the router
 * is shaped for the general case from the start — later phases add handlers to
 * this table rather than restructuring it.
 *
 * Phase 8 adds harvest handling for `BBP-` and `BBD-`, and from **two**
 * places: an open Harvest station (§5.4, entry #1) and the printer info page
 * with nothing open (§5.6, entry #2). That second entry is why `routeScan`
 * takes an optional `viewingPrinterId` — everything else stays keyed on the
 * open station alone.
 * Reusable `BBN-` bin codes follow the same two Harvest entry points, plus
 * idle/WIP routing for the quantity and QC gates.
 *
 * Fit Check and Rework (§5.4a/§5.4b) are **not** stations, despite printing
 * `BBS-…` QRs like one — there is no session, no open/close, and dispatch
 * for them is not on (open station × prefix) at all. The flow is scan a
 * part, then scan a location: "part scanned, awaiting a location" is a tiny
 * bit of state the *page* holds locally (not this module, and not the
 * server — see `FloorScanPage`), and `routeScan` only classifies each scan
 * on its own; it does not know whether a part is currently pending.
 */

/** Payload prefixes from §4. */
export const PREFIX_STATION = 'BBS-';
export const PREFIX_PRINTER = 'BBP-';
export const PREFIX_PART = 'BBD-';
export const PREFIX_BIN = 'BBN-';

/** Shared reusable bottom-housing bins (`BBN-BOT-1` … `BBN-BOT-3`). */
export function isBotBinPayload(payload: string): boolean {
  return /^BBN-BOT-/i.test(payload.trim());
}
export const PREFIX_DEFECT = 'BBF-';
export const PREFIX_COMMAND = 'BBX-';
export const PREFIX_REASON = 'BBR-';

/** The Harvest station's slug and full QR payload (`backend/app/services/
 *  floor_codes.py`). Named here rather than left as inline string literals
 *  because phase 8 has to compare against it in two different places (the
 *  router below, and the takeover call on a `locked` part-scan result) — one
 *  constant means a slug typo can't silently desync the two. */
export const HARVEST_STATION_SLUG = 'harvest';

/** Initial QC Pass, Sanding, and WIP Rework slugs and payloads (§5.4a/§5.4b). Not stations —
 *  these exist so `routeScan` can recognise their exact `BBS-…` payload and
 *  pull it out of the generic 'station' classification, same reasoning as
 *  `HARVEST_STATION_SLUG` above. */
export const FIT_CHECK_LOCATION_SLUG = 'fit-check';
export const SANDING_LOCATION_SLUG = 'sanding';
export const WIP_REWORK_LOCATION_SLUG = 'wip-rework';
/** @deprecated Use `WIP_REWORK_LOCATION_SLUG`. */
export const REWORK_LOCATION_SLUG = WIP_REWORK_LOCATION_SLUG;
export const FIT_CHECK_PAYLOAD = `${PREFIX_STATION}initial-qc-pass`;
/** Existing labels remain scannable after the Initial QC Pass rename. */
export const LEGACY_FIT_CHECK_PAYLOAD = `${PREFIX_STATION}${FIT_CHECK_LOCATION_SLUG}`;
export const SANDING_PAYLOAD = `${PREFIX_STATION}${SANDING_LOCATION_SLUG}`;
export const WIP_REWORK_PAYLOAD = `${PREFIX_STATION}${WIP_REWORK_LOCATION_SLUG}`;
/** Pre-WIP bench labels printed as `BBS-rework` before Sanding was named. */
export const LEGACY_SANDING_PAYLOAD = `${PREFIX_STATION}rework`;

/** Item→location pipeline destinations (`backend/app/services/floor_codes.py`).
 *  Like Initial QC Pass / Rework these print `BBS-…` QRs but are *not*
 *  sessions: the operator scans an item (a `BBD-` part or a `BBN-` bin) and
 *  then one of these location codes, and the pairing commits with no
 *  open-station-first step. Recognised out of the generic 'station'
 *  classification for exactly that reason. */
export const READY_FOR_PRODUCTION_LOCATION_SLUG = 'ready-for-production-inventory';
export const PRODUCTION_WIP_LOCATION_SLUG = 'production-wip';
export const BIN_EMPTY_LOCATION_SLUG = 'bin-empty';
export const SUPPORT_REMOVAL_LOCATION_SLUG = 'support-removal';
export const OVERHANG_REMOVAL_LOCATION_SLUG = 'overhang-removal';
export const HOT_AIR_REMOVAL_LOCATION_SLUG = 'hot-air-removal';

/** Every location slug a scan can resolve to (the two existing benches plus
 *  the six item→location destinations). The page decides which are valid for
 *  whichever item is currently pending — this router only classifies. */
export type LocationSlug =
  | 'fit-check'
  | 'sanding'
  | 'wip-rework'
  | typeof READY_FOR_PRODUCTION_LOCATION_SLUG
  | typeof PRODUCTION_WIP_LOCATION_SLUG
  | typeof BIN_EMPTY_LOCATION_SLUG
  | typeof SUPPORT_REMOVAL_LOCATION_SLUG
  | typeof OVERHANG_REMOVAL_LOCATION_SLUG
  | typeof HOT_AIR_REMOVAL_LOCATION_SLUG;

/** Payload → location slug for the item→location destinations. */
const ITEM_LOCATION_PAYLOADS: ReadonlyMap<string, LocationSlug> = new Map([
  [`${PREFIX_STATION}${READY_FOR_PRODUCTION_LOCATION_SLUG}`, READY_FOR_PRODUCTION_LOCATION_SLUG],
  [`${PREFIX_STATION}${PRODUCTION_WIP_LOCATION_SLUG}`, PRODUCTION_WIP_LOCATION_SLUG],
  [`${PREFIX_STATION}${BIN_EMPTY_LOCATION_SLUG}`, BIN_EMPTY_LOCATION_SLUG],
  [`${PREFIX_STATION}${SUPPORT_REMOVAL_LOCATION_SLUG}`, SUPPORT_REMOVAL_LOCATION_SLUG],
  [`${PREFIX_STATION}${OVERHANG_REMOVAL_LOCATION_SLUG}`, OVERHANG_REMOVAL_LOCATION_SLUG],
  [`${PREFIX_STATION}${HOT_AIR_REMOVAL_LOCATION_SLUG}`, HOT_AIR_REMOVAL_LOCATION_SLUG],
]);

export function formatFloorDate(value: string, options?: Intl.DateTimeFormatOptions): string {
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`;
  return new Date(zoned).toLocaleString(undefined, options);
}
export const HARVEST_STATION_PAYLOAD = `${PREFIX_STATION}${HARVEST_STATION_SLUG}`;

/** What kind of code a payload is, before any station context is applied.
 *  `product-serial` is Part Assembly Linking (Wave 2): a bought product
 *  serial (`XG2SNP`) — six alphanumeric, no hyphen, at least one letter —
 *  that starts the assembly-linking ceremony. */
export type ScanKind =
  | 'station'
  | 'printer'
  | 'part'
  | 'bin'
  | 'defect'
  | 'command'
  | 'reason'
  | 'product-serial'
  | 'sku';

/** Exactly six alphanumeric characters after trim + uppercase (§4). The
 *  additional `/[A-Z]/` guard below keeps all-numeric vendor barcodes out of
 *  this shape — those stay `sku`. Hyphenated floor codes never match. */
const PRODUCT_SERIAL_PATTERN = /^[A-Z0-9]{6}$/;

export type ScanClassification =
  | { kind: 'empty' }
  | { kind: ScanKind; value: string };

const PREFIX_KINDS: ReadonlyArray<readonly [string, ScanKind]> = [
  [PREFIX_STATION, 'station'],
  [PREFIX_PRINTER, 'printer'],
  [PREFIX_PART, 'part'],
  [PREFIX_BIN, 'bin'],
  [PREFIX_DEFECT, 'defect'],
  [PREFIX_COMMAND, 'command'],
  [PREFIX_REASON, 'reason'],
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

  // Part Assembly Linking (Wave 2): a bought product serial (`XG2SNP`) —
  // exactly six alphanumeric characters, no hyphen, with at least one letter.
  // Normalized to upper before matching (the pistol may emit either case);
  // all-numeric barcodes fail the `/[A-Z]/` guard and fall through to `sku`.
  const upper = value.toUpperCase();
  if (PRODUCT_SERIAL_PATTERN.test(upper) && /[A-Z]/.test(upper)) {
    return { kind: 'product-serial', value: upper };
  }

  return { kind: 'sku', value };
}

/** What the page should do with a scan, given the station currently open. */
export type ScanAction =
  /** A `BBS-` code: hand to the session API (open / close / switch). */
  | { action: 'station'; payload: string }
  /** A `BBP-` code with no station open: show the printer info page (§5.6). */
  | { action: 'printer-info'; payload: string }
  /** A `BBP-` code under an open Harvest station: bind/rebind/close the plate
   *  (§5.4 flow, entry #1). */
  | { action: 'harvest-printer'; payload: string }
  /** A `BBD-` code that should link a part. Two entry points share this one
   *  action (§5.4): under an open Harvest station `printerId` is absent
   *  because the session already carries its own binding; from the printer
   *  info page it carries the viewed printer's id, which is only a *hint*
   *  used to claim the harvest lock on the first such scan (§5.6, entry #2). */
  | { action: 'harvest-part'; payload: string; printerId?: number }
  /** A reusable KNB/BUT bin. During Harvest it starts/captures a batch; from
   *  a printer info page it is the direct Harvest entry point. */
  | { action: 'harvest-bin'; payload: string; printerId?: number }
  /** A bin scanned at idle, waiting for the operator to scan a location. */
  | { action: 'bin-scanned'; payload: string }
  /** A `BBD-` code with no station open and no printer being viewed — the
   *  start of the scan-part-then-location flow (§5.4a/§5.4b). The page
   *  remembers this as the pending part; nothing is written yet. */
  | { action: 'part-scanned'; payload: string }
  /** A location-QR scan — Initial QC Pass, Rework, or one of the six
   *  item→location destinations. Pulled out of the generic 'station'
   *  classification because none is a session (§5.4a/§5.4b, § item→location).
   *  Meaningless without an item already pending; the *page* decides that
   *  and which slugs are valid for the pending item, since this router has
   *  no notion of pending state. */
  | { action: 'location'; slug: LocationSlug; payload: string }
  /** A `BBR-…` reason code — only meaningful mid Sanding or WIP-Rework flow (a part is
   *  pending and its location was Sanding or WIP Rework); same "page decides" reasoning
   *  as 'location' above. */
  | { action: 'rework-reason'; payload: string }
  | { action: 'error-label'; payload: string }
  | { action: 'command'; payload: string }
  /** A bought product serial (`XG2SNP`) — Part Assembly Linking (Wave 2).
   *  Only meaningful at idle (start the link ceremony) or on an already-linked
   *  serial (lookup); the *page* decides that, same as 'location' above, so
   *  this classification never depends on the open station. */
  | { action: 'product-serial'; value: string }
  /** A real code whose handling lands in a later phase. */
  | { action: 'not-implemented'; kind: ScanKind; value: string }
  /** Nothing scannable. */
  | { action: 'ignore' };

/**
 * Route a scan against the open station.
 *
 * `stationSlug` is the station currently open on this device, or null — the
 * "station" half of the (station × prefix) dispatch. A `BBD-` will mean "link
 * this part" under harvest and "start the part flow" from idle; a `BBP-`
 * already means two different things depending on it.
 *
 * `viewingPrinterId` is the printer shown on the info page, if any — the only
 * other place a `BBD-` scan means something (§5.6, phase 8's entry #2). It is
 * optional and ignored outside that one case, so every pre-phase-8 call site
 * that only ever passed two arguments keeps behaving exactly as before.
 */
export function routeScan(
  raw: string,
  stationSlug: string | null,
  viewingPrinterId?: number | null,
): ScanAction {
  const scan = classifyScan(raw);
  if (scan.kind === 'empty') return { action: 'ignore' };

  if (scan.kind === 'product-serial') {
    // Station-independent, like 'location'/'rework-reason': the page decides
    // whether a serial starts a ceremony (idle) or is a lookup (already
    // linked), so the router only classifies it here.
    return { action: 'product-serial', value: scan.value };
  }

  if (scan.kind === 'station') {
    // Initial QC Pass, Sanding, and WIP Rework print `BBS-…` QRs but are not sessions
    // (§5.4a/§5.4b) — pull their exact payloads out before the generic
    // station-scan path, unconditionally: whether this is meaningful right
    // now (is a part actually pending?) is the page's call, not the
    // router's, so this classification never depends on `stationSlug`.
    if (scan.value === FIT_CHECK_PAYLOAD || scan.value === LEGACY_FIT_CHECK_PAYLOAD)
      return { action: 'location', slug: 'fit-check', payload: scan.value };
    if (scan.value === SANDING_PAYLOAD || scan.value === LEGACY_SANDING_PAYLOAD)
      return { action: 'location', slug: 'sanding', payload: scan.value };
    if (scan.value === WIP_REWORK_PAYLOAD)
      return { action: 'location', slug: 'wip-rework', payload: scan.value };
    const itemLocationSlug = ITEM_LOCATION_PAYLOADS.get(scan.value);
    if (itemLocationSlug) return { action: 'location', slug: itemLocationSlug, payload: scan.value };
    return { action: 'station', payload: scan.value };
  }

  if (scan.kind === 'reason') {
    // Only meaningful mid-Rework-flow; the page checks that, not this
    // router (same reasoning as 'location' above).
    return { action: 'rework-reason', payload: scan.value };
  }

  if (scan.kind === 'defect') return { action: 'error-label', payload: scan.value };
  if (scan.kind === 'command') return { action: 'command', payload: scan.value };

  if (scan.kind === 'printer') {
    // With no station open, a printer scan is a lookup, not a claim: it shows
    // the info page and takes no harvest lock (§5.6). Under an open Harvest
    // station the same code binds/rebinds/closes the plate instead (§5.4).
    if (stationSlug === null) return { action: 'printer-info', payload: scan.value };
    if (stationSlug === HARVEST_STATION_SLUG) return { action: 'harvest-printer', payload: scan.value };
    return { action: 'not-implemented', kind: scan.kind, value: scan.value };
  }

  if (scan.kind === 'part') {
    // Under Harvest the session already knows (or will learn) which plate
    // this belongs to, so no hint is needed or sent.
    if (stationSlug === HARVEST_STATION_SLUG) return { action: 'harvest-part', payload: scan.value };
    // No station open: a part scan from the printer info page is entry #2
    // (§5.6) — but only when a printer is actually being viewed.
    if (stationSlug === null && viewingPrinterId != null) {
      return { action: 'harvest-part', payload: scan.value, printerId: viewingPrinterId };
    }
    // No station open, nothing being viewed: the start of scan-part-then-
    // location (§5.4a/§5.4b). Restricted to pure idle on purpose — scanning
    // a part while some real station (WIP, etc.) is open stays whatever it
    // already was (unhandled), rather than silently starting an unrelated
    // flow underneath active station work.
    if (stationSlug === null) return { action: 'part-scanned', payload: scan.value };
    return { action: 'not-implemented', kind: scan.kind, value: scan.value };
  }

  if (scan.kind === 'bin') {
    // BOT bins collect QC-passed bottoms — no Harvest quantity flow.
    if (!isBotBinPayload(scan.value)) {
      if (stationSlug === HARVEST_STATION_SLUG) return { action: 'harvest-bin', payload: scan.value };
      if (stationSlug === null && viewingPrinterId != null) {
        return { action: 'harvest-bin', payload: scan.value, printerId: viewingPrinterId };
      }
    }
    // Idle: the start of scan-bin-then-location (Initial QC, Ready-for-
    // Production, Production WIP, Empty Bin). Bins no longer route through an
    // open WIP session — that path was removed in favour of item→location.
    if (stationSlug === null) return { action: 'bin-scanned', payload: scan.value };
    return { action: 'not-implemented', kind: scan.kind, value: scan.value };
  }

  return { action: 'not-implemented', kind: scan.kind, value: scan.value };
}

/** "7s", "4m", "1h 12m".
 *
 *  Seconds for the first minute, then minutes. The fine-grained start is
 *  what makes the counter visibly *live* — a station that just opened shows
 *  it ticking, so an operator can see the screen is responding rather than
 *  frozen on a stale "<1m". Past a minute the question changes to "has this
 *  been sitting open longer than it should have", where second-level
 *  precision is noise. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${minutes}m`;
}
