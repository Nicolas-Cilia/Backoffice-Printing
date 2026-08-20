import { describe, it, expect } from 'vitest';
import { getPrinterCardChromeClass, PRINTER_CARD_DISABLED_CONTROL } from '../../utils/printerCardChrome';
import type { PrinterState } from '../../components/BulkPrinterToolbar';

describe('getPrinterCardChromeClass', () => {
  it('turns paused widgets orange', () => {
    const cls = getPrinterCardChromeClass('paused');
    expect(cls).toContain('border-status-warning');
    expect(cls).toContain('printer-card-tinted');
    expect(cls).toContain('printer-card-chrome-warning');
  });

  it('turns disconnected widgets red', () => {
    const cls = getPrinterCardChromeClass('offline');
    expect(cls).toContain('border-status-error');
    expect(cls).toContain('printer-card-tinted');
    expect(cls).toContain('printer-card-chrome-error');
  });

  it('turns HMS-error widgets red so issues scan the same as a disconnect', () => {
    expect(getPrinterCardChromeClass('error')).toContain('border-status-error');
    expect(getPrinterCardChromeClass('error')).toContain('printer-card-chrome-error');
  });

  it('turns finished widgets green', () => {
    const cls = getPrinterCardChromeClass('finished');
    expect(cls).toContain('border-status-ok');
    expect(cls).toContain('printer-card-tinted');
    expect(cls).toContain('printer-card-chrome-ok');
  });

  it('turns idle widgets green', () => {
    const cls = getPrinterCardChromeClass('idle');
    expect(cls).toContain('border-status-ok');
    expect(cls).toContain('printer-card-tinted');
    expect(cls).toContain('printer-card-chrome-ok');
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

  it('keeps unavailable Pause/Stop readable without extra opacity fade', () => {
    expect(PRINTER_CARD_DISABLED_CONTROL).toContain('text-bambu-gray');
    expect(PRINTER_CARD_DISABLED_CONTROL).not.toContain('opacity-50');
    expect(PRINTER_CARD_DISABLED_CONTROL).not.toContain('text-bambu-gray/50');
  });
});
