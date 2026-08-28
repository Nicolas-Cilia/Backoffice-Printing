import { useEffect, useRef } from 'react';
import { createBurstCaptureKeyDownHandler } from '../utils/floorScanCapture';
import { useCancellableTimeout } from './useCancellableTimeout';

type UseFloorScanCaptureOptions = {
  /** When false, listeners are not attached (e.g. while session is loading). */
  enabled?: boolean;
  burstGapMs?: number;
  flushTimeoutMs?: number;
};

/**
 * Window-level wedge-scanner capture for FloorScanPage only.
 * Buffers rapid keystrokes and invokes the same scan handler as the hidden input.
 */
export function useFloorScanCapture(
  onScan: (payload: string) => void,
  options: UseFloorScanCaptureOptions = {},
) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const { schedule, cancel } = useCancellableTimeout();
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    const handler = createBurstCaptureKeyDownHandler({
      onScan: (payload) => onScanRef.current(payload),
      burstGapMs: options.burstGapMs,
      flushTimeoutMs: options.flushTimeoutMs,
      scheduleFlush: schedule,
      cancelFlush: cancel,
    });

    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      cancel();
    };
  }, [enabled, options.burstGapMs, options.flushTimeoutMs, schedule, cancel]);
}
