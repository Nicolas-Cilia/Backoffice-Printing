/**
 * Wedge-scanner burst capture for `/floor/scan`.
 *
 * USB barcode pistols type a full payload in ~30–80 ms between characters.
 * When focus leaves the hidden scan input (after a button tap, modal, or
 * quantity field), those keystrokes would hit whatever is focused — or bubble
 * to Layout's global shortcuts (digit keys navigate). This module buffers
 * rapid printable characters and flushes them as one scan payload.
 */

/** Max gap between characters still considered one scanner burst. */
export const FLOOR_SCAN_BURST_GAP_MS = 100;

/** Flush the buffer if Enter never arrives after the last character. */
export const FLOOR_SCAN_FLUSH_TIMEOUT_MS = 150;

/** Marks the hidden always-focused scan input (excluded from capture skip). */
export const FLOOR_SCAN_INPUT_ATTR = 'data-floor-scan-input';

export const FLOOR_SCAN_INPUT_SELECTOR = `[${FLOOR_SCAN_INPUT_ATTR}]`;

export type BurstBuffer = {
  text: string;
  lastAt: number | null;
};

export const EMPTY_BURST_BUFFER: BurstBuffer = { text: '', lastAt: null };

export function isFloorScanInput(element: HTMLElement): boolean {
  return element.closest(FLOOR_SCAN_INPUT_SELECTOR) !== null;
}

/**
 * True when the event target is a field where the operator is intentionally
 * typing (quantity, reason text, etc.). The hidden scan input is excluded —
 * it has its own Enter handler and window capture is skipped while it holds
 * focus to avoid double-dispatch.
 */
export function isUserTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    if (isFloorScanInput(target)) return true;
    return true;
  }
  return false;
}

/** Single printable character from KeyboardEvent.key. */
export function isPrintableScanChar(key: string): boolean {
  return key.length === 1 && key !== '\n' && key !== '\r';
}

/**
 * Append one character to the burst buffer. If the gap since the previous
 * character exceeds `maxGapMs`, the prior burst is abandoned and a new one
 * starts — slow human keypresses on the page background do not concatenate.
 */
export function applyBurstChar(
  buffer: BurstBuffer,
  char: string,
  now: number,
  maxGapMs: number = FLOOR_SCAN_BURST_GAP_MS,
): BurstBuffer {
  if (
    buffer.lastAt !== null &&
    buffer.text.length > 0 &&
    now - buffer.lastAt > maxGapMs
  ) {
    return { text: char, lastAt: now };
  }
  if (buffer.text.length === 0) {
    return { text: char, lastAt: now };
  }
  return { text: buffer.text + char, lastAt: now };
}

export function shouldFlushBuffer(buffer: BurstBuffer): boolean {
  return buffer.text.trim().length > 0;
}

export function takeFlushPayload(buffer: BurstBuffer): { payload: string; buffer: BurstBuffer } {
  return { payload: buffer.text.trim(), buffer: EMPTY_BURST_BUFFER };
}

export type BurstCaptureOptions = {
  onScan: (payload: string) => void;
  burstGapMs?: number;
  flushTimeoutMs?: number;
  scheduleFlush: (fn: () => void, ms: number) => void;
  cancelFlush: () => void;
  getNow?: () => number;
};

/** Factory for the window keydown handler — pure aside from scheduling side effects. */
export function createBurstCaptureKeyDownHandler(options: BurstCaptureOptions): (e: KeyboardEvent) => void {
  const burstGapMs = options.burstGapMs ?? FLOOR_SCAN_BURST_GAP_MS;
  const flushTimeoutMs = options.flushTimeoutMs ?? FLOOR_SCAN_FLUSH_TIMEOUT_MS;
  const getNow = options.getNow ?? (() => Date.now());

  let buffer: BurstBuffer = EMPTY_BURST_BUFFER;

  const flush = () => {
    if (!shouldFlushBuffer(buffer)) return;
    const { payload, buffer: cleared } = takeFlushPayload(buffer);
    buffer = cleared;
    options.cancelFlush();
    if (payload) options.onScan(payload);
  };

  return (e: KeyboardEvent) => {
    if (isUserTypingTarget(e.target)) return;

    if (e.key === 'Enter') {
      if (!shouldFlushBuffer(buffer)) return;
      e.preventDefault();
      e.stopPropagation();
      const { payload, buffer: cleared } = takeFlushPayload(buffer);
      buffer = cleared;
      options.cancelFlush();
      options.onScan(payload);
      return;
    }

    if (!isPrintableScanChar(e.key)) return;

    buffer = applyBurstChar(buffer, e.key, getNow(), burstGapMs);
    e.preventDefault();
    e.stopPropagation();
    options.scheduleFlush(flush, flushTimeoutMs);
  };
}
