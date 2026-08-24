import { describe, it, expect } from 'vitest';
import { classifyScan, routeScan, formatElapsed } from '../../utils/floorScan';

describe('classifyScan', () => {
  it.each([
    ['BBS-wip', 'station'],
    ['BBP-12', 'printer'],
    ['BBD-000042', 'part'],
    ['BBF-warping', 'defect'],
    ['BBX-rework', 'command'],
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

  it.each(['BBP-12', 'BBD-1', 'BBF-x', 'BBX-multi', '4001234567890'])(
    'reports %s as recognised but not yet handled',
    (payload) => {
      // Distinct from unknown on purpose: "not built yet" and "that code means
      // nothing" send an operator to different places.
      const route = routeScan(payload, null);
      expect(route.action).toBe('not-implemented');
    },
  );

  it('carries the scan kind through, so later phases can dispatch on it', () => {
    const route = routeScan('BBD-000042', 'harvest');
    expect(route).toMatchObject({ action: 'not-implemented', kind: 'part' });
  });

  it('ignores an empty scan', () => {
    expect(routeScan('  ', null)).toEqual({ action: 'ignore' });
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, '<1m'],
    [59, '<1m'],
    [60, '1m'],
    [599, '9m'],
    [3600, '1h 0m'],
    [4500, '1h 15m'],
    [50400, '14h 0m'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected);
  });

  it('never renders a negative duration', () => {
    // Clock skew between server and kiosk must not produce "-3m".
    expect(formatElapsed(-90)).toBe('<1m');
  });
});
