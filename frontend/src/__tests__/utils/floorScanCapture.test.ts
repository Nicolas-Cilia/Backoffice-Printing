import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyBurstChar,
  createBurstCaptureKeyDownHandler,
  EMPTY_BURST_BUFFER,
  FLOOR_SCAN_BURST_GAP_MS,
  isPrintableScanChar,
  isUserTypingTarget,
  shouldFlushBuffer,
  takeFlushPayload,
} from '../../utils/floorScanCapture';

describe('floorScanCapture buffer', () => {
  it('assembles a fast burst into one payload', () => {
    let buffer = EMPTY_BURST_BUFFER;
    const gap = 30;
    for (const char of 'BBP-12') {
      buffer = applyBurstChar(buffer, char, buffer.lastAt === null ? 0 : buffer.lastAt! + gap);
    }
    expect(buffer.text).toBe('BBP-12');
    expect(shouldFlushBuffer(buffer)).toBe(true);
    expect(takeFlushPayload(buffer).payload).toBe('BBP-12');
  });

  it('flushes on Enter via the keydown handler', () => {
    const onScan = vi.fn();
    const scheduleFlush = vi.fn();
    const cancelFlush = vi.fn();
    let now = 0;
    const handler = createBurstCaptureKeyDownHandler({
      onScan,
      scheduleFlush,
      cancelFlush,
      getNow: () => now,
    });

    for (const char of 'BBP-12') {
      now += 30;
      handler(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    }
    handler(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onScan).toHaveBeenCalledOnce();
    expect(onScan).toHaveBeenCalledWith('BBP-12');
  });

  it('ignores slow typing — gaps reset the buffer instead of concatenating', () => {
    let buffer = EMPTY_BURST_BUFFER;
    const slowGap = FLOOR_SCAN_BURST_GAP_MS + 50;

    buffer = applyBurstChar(buffer, 'B', 0);
    buffer = applyBurstChar(buffer, 'B', slowGap);
    buffer = applyBurstChar(buffer, 'P', slowGap * 2);
    buffer = applyBurstChar(buffer, '-', slowGap * 3);
    buffer = applyBurstChar(buffer, '1', slowGap * 4);
    buffer = applyBurstChar(buffer, '2', slowGap * 5);

    expect(buffer.text).toBe('2');
    expect(takeFlushPayload(buffer).payload).not.toBe('BBP-12');
  });

  it('does not flush on Enter when the buffer is empty', () => {
    const onScan = vi.fn();
    const handler = createBurstCaptureKeyDownHandler({
      onScan,
      scheduleFlush: vi.fn(),
      cancelFlush: vi.fn(),
    });
    handler(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onScan).not.toHaveBeenCalled();
  });

  it.each(['Enter', 'Shift', 'ArrowDown', 'Tab'])('does not treat %s as a scan character', (key) => {
    expect(isPrintableScanChar(key)).toBe(false);
  });

  it('treats single printable characters as scan characters', () => {
    expect(isPrintableScanChar('B')).toBe(true);
    expect(isPrintableScanChar('-')).toBe(true);
  });
});

describe('floorScanCapture target filtering', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('skips capture for quantity and reason inputs', () => {
    const qty = document.createElement('input');
    qty.type = 'number';
    container.appendChild(qty);
    expect(isUserTypingTarget(qty)).toBe(true);
  });

  it('skips capture for the hidden scan input', () => {
    const scan = document.createElement('input');
    scan.setAttribute('data-floor-scan-input', '');
    container.appendChild(scan);
    expect(isUserTypingTarget(scan)).toBe(true);
  });

  it('does not skip capture for buttons or bare divs', () => {
    const button = document.createElement('button');
    container.appendChild(button);
    expect(isUserTypingTarget(button)).toBe(false);

    const div = document.createElement('div');
    container.appendChild(div);
    expect(isUserTypingTarget(div)).toBe(false);
  });

  it('prevents default on captured digit keys so global nav shortcuts do not fire', () => {
    const onScan = vi.fn();
    const handler = createBurstCaptureKeyDownHandler({
      onScan,
      scheduleFlush: vi.fn(),
      cancelFlush: vi.fn(),
      getNow: () => 0,
    });
    const event = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    Object.defineProperty(event, 'target', { value: document.body });

    handler(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });
});
