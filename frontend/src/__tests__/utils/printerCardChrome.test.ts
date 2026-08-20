import { describe, it, expect } from 'vitest';
import { getPrinterCardChromeClass } from '../../utils/printerCardChrome';
import type { PrinterState } from '../../components/BulkPrinterToolbar';

describe('getPrinterCardChromeClass', () => {
  it('turns paused widgets orange', () => {
    expect(getPrinterCardChromeClass('paused')).toContain('border-status-warning');
    expect(getPrinterCardChromeClass('paused')).toContain('bg-status-warning/20');
  });

  it('turns disconnected widgets red', () => {
    expect(getPrinterCardChromeClass('offline')).toContain('border-status-error');
    expect(getPrinterCardChromeClass('offline')).toContain('bg-status-error/20');
  });

  it('turns HMS-error widgets red so issues scan the same as a disconnect', () => {
    expect(getPrinterCardChromeClass('error')).toContain('border-status-error');
  });

  it('turns finished widgets green', () => {
    expect(getPrinterCardChromeClass('finished')).toContain('border-status-ok');
    expect(getPrinterCardChromeClass('finished')).toContain('bg-status-ok/20');
  });

  it('turns idle widgets green', () => {
    expect(getPrinterCardChromeClass('idle')).toContain('border-status-ok');
    expect(getPrinterCardChromeClass('idle')).toContain('bg-status-ok/20');
  });

  it('leaves printing widgets on the default card chrome', () => {
    expect(getPrinterCardChromeClass('printing')).toBe('');
  });

  it('covers every PrinterState bucket', () => {
    const buckets: PrinterState[] = ['printing', 'paused', 'finished', 'idle', 'error', 'offline'];
    for (const bucket of buckets) {
      expect(typeof getPrinterCardChromeClass(bucket)).toBe('string');
    }
  });
});
