import { describe, it, expect } from 'vitest';
import { classifyScan, routeScan, formatElapsed, HARVEST_STATION_PAYLOAD } from '../../utils/floorScan';

describe('classifyScan', () => {
  it.each([
    ['BBS-wip', 'station'],
    ['BBP-12', 'printer'],
    ['BBD-000042', 'part'],
    ['BBN-KNB-1', 'bin'],
    ['BBF-warping', 'defect'],
    ['BBX-rework', 'command'],
    ['BBR-doesnt-fit', 'reason'],
  ])('classifies %s as %s', (payload, kind) => {
    expect(classifyScan(payload)).toEqual({ kind, value: payload });
  });

  it('treats anything without a known prefix as a factory SKU', () => {
    // Vendor barcodes carry no prefix of ours, so `sku` is the catch-all
    // rather than a positively identified kind — which is why an
    // unregistered SKU can only be discovered server-side (§6.3).
    expect(classifyScan('4001234567890')).toEqual({ kind: 'sku', value: '4001234567890' });
    expect(classifyScan('GF-A00-K0')).toEqual({ kind: 'sku', value: 'GF-A00-K0' });
  });

  it('tolerates a pistol whitespace suffix', () => {
    // Guns can append whitespace depending on their suffix config; a stray
    // space must not turn a good label into an unknown code.
    expect(classifyScan('  BBS-harvest \n')).toEqual({ kind: 'station', value: 'BBS-harvest' });
  });

  it.each(['', '   ', '\n'])('reports %j as empty', (payload) => {
    expect(classifyScan(payload)).toEqual({ kind: 'empty' });
  });

  it('is case sensitive, since a pistol emits verbatim', () => {
    expect(classifyScan('bbs-wip').kind).toBe('sku');
  });

  it('does not mistake a prefix appearing mid-payload for a station', () => {
    expect(classifyScan('XBBS-wip').kind).toBe('sku');
  });

  describe('product serials (Part Assembly Linking, Wave 2)', () => {
    // Exactly six alphanumeric characters, no hyphen, with at least one
    // letter — `^[A-Z0-9]{6}$` after trim+upper plus `/[A-Z]/`. These start
    // the assembly-linking ceremony (§4/§5), so they must be pulled out of
    // the `sku` catch-all before it.
    it.each(['XG2SNP', '8TBDT9', 'IX72HD', 'XAKZM2', 'GMUOQL', 'OEQ0AC', 'ME2O6N'])(
      'classifies %s as a product serial',
      (serial) => {
        expect(classifyScan(serial)).toEqual({ kind: 'product-serial', value: serial });
      },
    );

    it('trims and uppercases a serial before classifying it', () => {
      expect(classifyScan('  xg2snp \n')).toEqual({ kind: 'product-serial', value: 'XG2SNP' });
    });

    it('leaves all-numeric six-character barcodes as sku (no letter)', () => {
      // Filament SKUs are all numeric; the `/[A-Z]/` guard keeps them out of
      // the serial shape even though the length matches.
      expect(classifyScan('123456')).toEqual({ kind: 'sku', value: '123456' });
    });

    it('does not treat a hyphenated floor code as a serial', () => {
      // Floor codes always carry a `BB*-` prefix with a hyphen, so they can
      // never collide with the no-hyphen serial shape.
      expect(classifyScan('BBD-000123')).toEqual({ kind: 'part', value: 'BBD-000123' });
      expect(classifyScan('ABC-12').kind).toBe('sku');
    });

    it('rejects lengths other than six', () => {
      expect(classifyScan('XG2SN').kind).toBe('sku');
      expect(classifyScan('XG2SNPQ').kind).toBe('sku');
    });
  });
});

describe('routeScan', () => {
  it('routes a station code to the session API', () => {
    expect(routeScan('BBS-wip', null)).toEqual({ action: 'station', payload: 'BBS-wip' });
  });

  it('routes a station code the same way while another station is open', () => {
    // Switching is the server's decision, not the router's — the router only
    // has to recognise that this is a station code.
    expect(routeScan('BBS-harvest', 'wip')).toEqual({ action: 'station', payload: 'BBS-harvest' });
  });

  it('routes a defect code to error-label — Rework/Discard decide whether one is actually pending', () => {
    // Recognised, not unknown: `error-label` is a real classification now
    // (Rework's reason step, Discard's error step), just meaningless with
    // nothing pending — which is the *page*'s call, not the router's (same
    // reasoning as 'location'/'rework-reason' above).
    expect(routeScan('BBF-x', null)).toEqual({ action: 'error-label', payload: 'BBF-x' });
  });

  it('routes a command code to command — only BBX-discard is handled so far', () => {
    expect(routeScan('BBX-multi', null)).toEqual({ action: 'command', payload: 'BBX-multi' });
  });

  it('reports a factory SKU as recognised but not yet handled', () => {
    // Distinct from unknown on purpose: "not built yet" and "that code means
    // nothing" send an operator to different places. BBD- is excluded here
    // since phase 9a/9b now give it a meaning at idle — see the
    // "fit check and rework" describe block below.
    const route = routeScan('4001234567890', null);
    expect(route.action).toBe('not-implemented');
  });

  it('routes a printer scanned from idle to the info page', () => {
    // §5.6: with no station open a printer scan is a lookup, not a claim.
    expect(routeScan('BBP-12', null)).toEqual({ action: 'printer-info', payload: 'BBP-12' });
  });

  it('does not treat a printer scan as an info lookup while a station is open', () => {
    // Under a non-harvest station, a printer scan still has no handler
    // (phase 8 only teaches Harvest what to do with `BBP-`) — the
    // (station × prefix) dispatch in action, and the reason the router takes
    // the open station as a parameter at all.
    const route = routeScan('BBP-12', 'wip');
    expect(route.action).toBe('not-implemented');
  });

  it('carries the scan kind through, so later phases can dispatch on it', () => {
    // Part-first handling is available from idle; an active station still
    // leaves unrelated part scans recognised-but-unhandled.
    const route = routeScan('BBD-000042', 'wip');
    expect(route).toMatchObject({ action: 'not-implemented', kind: 'part' });
  });

  it('ignores an empty scan', () => {
    expect(routeScan('  ', null)).toEqual({ action: 'ignore' });
  });

  describe('harvest (phase 8, §5.4/§5.6)', () => {
    it('binds/rebinds/closes a plate on a printer scan under an open Harvest station', () => {
      expect(routeScan('BBP-12', 'harvest')).toEqual({ action: 'harvest-printer', payload: 'BBP-12' });
    });

    it('links a part on a part scan under an open Harvest station, with no printer hint', () => {
      // The session already knows (or will learn) which plate this belongs
      // to, so no hint is sent — unlike the info-page entry point below.
      const route = routeScan('BBD-000042', 'harvest');
      expect(route).toEqual({ action: 'harvest-part', payload: 'BBD-000042' });
      expect(route).not.toHaveProperty('printerId');
    });

    it('links a part from the printer info page, carrying the viewed printer as a hint', () => {
      // §5.6 entry #2: nothing open, but a printer is being viewed — the
      // first such scan is what claims the harvest lock server-side.
      expect(routeScan('BBD-000042', null, 12)).toEqual({
        action: 'harvest-part',
        payload: 'BBD-000042',
        printerId: 12,
      });
    });

    it('starts the scan-part-then-location flow when nothing is open and no printer is viewed', () => {
      // Superseded by phase 9a/9b: a bare `BBD-` scan at idle used to be
      // unhandled; it is now the first half of "scan a part, scan a
      // location" (§5.4a/§5.4b) — see that describe block below for the
      // full picture.
      expect(routeScan('BBD-000042', null).action).toBe('part-scanned');
      expect(routeScan('BBD-000042', null, null).action).toBe('part-scanned');
      expect(routeScan('BBD-000042', null, undefined).action).toBe('part-scanned');
    });

    it('exposes the harvest station payload used to reuse the takeover flow', () => {
      // The lock a `locked` part/printer scan reports is the same
      // floor-wide Harvest lock as `BBS-harvest` itself (§2.4) — the
      // constant is what lets the scan page's existing takeover button
      // target it without a second, parallel takeover mechanism.
      expect(HARVEST_STATION_PAYLOAD).toBe('BBS-harvest');
    });

    it('does not let the harvest-only routing leak into a printer scan with no station open', () => {
      // Entry #2 only exists for `BBD-`; a `BBP-` scan with nothing open is
      // always the info-page lookup (§5.6), never harvest-printer, even
      // though a printer id happens to be in scope by coincidence.
      expect(routeScan('BBP-99', null, 12)).toEqual({ action: 'printer-info', payload: 'BBP-99' });
    });
  });

  describe('fit check and rework (phase 9a/9b, §5.4a/§5.4b) — locations, not stations', () => {
    it('starts the scan-part-then-location flow on a bare part scan at idle', () => {
      expect(routeScan('BBD-000042', null)).toEqual({ action: 'part-scanned', payload: 'BBD-000042' });
    });

    it('does not start it when a printer is being viewed — that stays harvest-part (§5.6 entry #2)', () => {
      expect(routeScan('BBD-000042', null, 12)).toEqual({
        action: 'harvest-part',
        payload: 'BBD-000042',
        printerId: 12,
      });
    });

    it('does not start it while a real station is open', () => {
      // Scanning a part while WIP (or any real station) is open must not
      // silently kick off an unrelated flow underneath active station work.
      expect(routeScan('BBD-000042', 'wip').action).toBe('not-implemented');
    });

    it('classifies BBS-initial-qc-pass as a location, pulled out of the generic station action', () => {
      expect(routeScan('BBS-initial-qc-pass', null)).toEqual({
        action: 'location',
        slug: 'fit-check',
        payload: 'BBS-initial-qc-pass',
      });
    });

    it('keeps the legacy BBS-fit-check label working', () => {
      expect(routeScan('BBS-fit-check', null)).toEqual({
        action: 'location',
        slug: 'fit-check',
        payload: 'BBS-fit-check',
      });
    });

    it('classifies BBS-sanding as a pre-WIP location', () => {
      expect(routeScan('BBS-sanding', null)).toEqual({
        action: 'location',
        slug: 'sanding',
        payload: 'BBS-sanding',
      });
    });

    it('classifies BBS-wip-rework as a WIP location', () => {
      expect(routeScan('BBS-wip-rework', null)).toEqual({
        action: 'location',
        slug: 'wip-rework',
        payload: 'BBS-wip-rework',
      });
    });

    it('keeps the legacy BBS-rework label working as Sanding', () => {
      expect(routeScan('BBS-rework', null)).toEqual({ action: 'location', slug: 'sanding', payload: 'BBS-rework' });
    });

    it('classifies a location payload the same way regardless of what station is open', () => {
      // Whether this is *usable* right now (is a part pending?) is the
      // page's call, not the router's — the classification itself never
      // depends on stationSlug.
      expect(routeScan('BBS-initial-qc-pass', 'wip')).toEqual({
        action: 'location',
        slug: 'fit-check',
        payload: 'BBS-initial-qc-pass',
      });
    });

    it('every other BBS- payload still routes as a normal station scan', () => {
      expect(routeScan('BBS-harvest', null)).toEqual({ action: 'station', payload: 'BBS-harvest' });
      expect(routeScan('BBS-storage-move', null)).toEqual({ action: 'station', payload: 'BBS-storage-move' });
    });

    it('classifies a BBR- code as a rework-reason scan', () => {
      expect(routeScan('BBR-doesnt-fit', null)).toEqual({
        action: 'rework-reason',
        payload: 'BBR-doesnt-fit',
      });
    });

    it('classifies a rework-reason scan the same way regardless of station context', () => {
      expect(routeScan('BBR-other', 'wip')).toEqual({ action: 'rework-reason', payload: 'BBR-other' });
    });
  });

  describe('reusable KNB/BUT bins', () => {
    it('routes bins to Harvest for quantity capture', () => {
      expect(routeScan('BBN-KNB-1', 'harvest')).toEqual({ action: 'harvest-bin', payload: 'BBN-KNB-1' });
    });

    it('does not route BOT bins through Harvest', () => {
      expect(routeScan('BBN-BOT-1', 'harvest').action).toBe('not-implemented');
      expect(routeScan('BBN-BOT-2', null, 12)).toEqual({ action: 'bin-scanned', payload: 'BBN-BOT-2' });
    });

    it('routes bins from a printer info page to the direct Harvest path', () => {
      expect(routeScan('BBN-BUT-1', null, 12)).toEqual({
        action: 'harvest-bin',
        payload: 'BBN-BUT-1',
        printerId: 12,
      });
    });

    it('no longer routes bins through an open WIP session', () => {
      // The open-WIP-session bin path was removed in favour of
      // item→location: a bin scanned with any real station open is now
      // unhandled rather than starting a production-WIP intake.
      expect(routeScan('BBN-KNB-1', 'wip').action).toBe('not-implemented');
    });

    it('starts the scan-bin-then-location flow for a bin scanned at idle', () => {
      expect(routeScan('BBN-KNB-1', null)).toEqual({ action: 'bin-scanned', payload: 'BBN-KNB-1' });
    });
  });

  describe('item→location destinations', () => {
    it.each([
      ['BBS-ready-for-production-inventory', 'ready-for-production-inventory'],
      ['BBS-production-wip', 'production-wip'],
      ['BBS-bin-empty', 'bin-empty'],
      ['BBS-support-removal', 'support-removal'],
      ['BBS-overhang-removal', 'overhang-removal'],
      ['BBS-hot-air-removal', 'hot-air-removal'],
    ])('classifies %s as a location scan', (payload, slug) => {
      expect(routeScan(payload, null)).toEqual({ action: 'location', slug, payload });
    });

    it('classifies an item→location code the same way regardless of station context', () => {
      // Whether it is usable right now (is an item pending?) is the page's
      // call — the classification never depends on stationSlug.
      expect(routeScan('BBS-production-wip', 'harvest')).toEqual({
        action: 'location',
        slug: 'production-wip',
        payload: 'BBS-production-wip',
      });
    });
  });

  describe('product serials (Part Assembly Linking, Wave 2)', () => {
    it('routes a product serial to its own action, regardless of station', () => {
      expect(routeScan('XG2SNP', null)).toEqual({ action: 'product-serial', value: 'XG2SNP' });
      // The ceremony is an idle flow, but the router only classifies — whether
      // it is usable right now is the page's call, same as location codes.
      expect(routeScan('8tbdt9', 'harvest')).toEqual({ action: 'product-serial', value: '8TBDT9' });
    });

    it('still reports an all-numeric barcode as a not-yet-handled sku', () => {
      expect(routeScan('123456', null)).toMatchObject({ action: 'not-implemented', kind: 'sku' });
    });
  });

  describe('the pre-phase-8 two-argument call signature', () => {
    // These mirror the pre-existing assertions above almost verbatim — the
    // point being that every one of them still holds calling `routeScan`
    // with exactly two arguments, the way every call site did before phase
    // 8 added the optional third one.
    it.each([
      ['BBS-wip', null, { action: 'station', payload: 'BBS-wip' }],
      ['BBP-12', null, { action: 'printer-info', payload: 'BBP-12' }],
      ['  ', null, { action: 'ignore' }],
    ])('routes %s (station=%s) unchanged', (raw, stationSlug, expected) => {
      expect(routeScan(raw, stationSlug)).toEqual(expected);
    });

    it('still starts the scan-part-then-location flow with no third argument at all', () => {
      expect(routeScan('BBD-000042', null).action).toBe('part-scanned');
    });
  });
});

describe('formatElapsed', () => {
  it.each([
    // Seconds for the first minute, so the counter is visibly live rather
    // than sitting on a stale "<1m" while an operator wonders if it froze.
    [0, '0s'],
    [1, '1s'],
    [7, '7s'],
    [59, '59s'],
    // Then minutes, where second-level precision is noise.
    [60, '1m'],
    [61, '1m'],
    [599, '9m'],
    [3600, '1h 0m'],
    [4500, '1h 15m'],
    [50400, '14h 0m'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected);
  });

  it('never renders a negative duration', () => {
    // Clock skew between server and kiosk must not produce "-3m".
    expect(formatElapsed(-90)).toBe('0s');
  });

  it('crosses cleanly from seconds to minutes', () => {
    // The boundary is where a display bug would hide: 59s must not read
    // "0m", and 60s must not read "60s".
    expect(formatElapsed(59)).toBe('59s');
    expect(formatElapsed(60)).toBe('1m');
  });
});
