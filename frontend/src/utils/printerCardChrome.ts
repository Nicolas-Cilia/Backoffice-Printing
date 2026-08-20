import type { PrinterState } from '../components/BulkPrinterToolbar';

/**
 * Card chrome (border + wash) so operators can scan the printer grid.
 *
 * Paused → orange, disconnected/error → red, idle/finished → green.
 * Printing stays the default card chrome so in-progress jobs don't look
 * like idle/available printers.
 */
export function getPrinterCardChromeClass(bucket: PrinterState): string {
  switch (bucket) {
    case 'paused':
      return '!border-2 !border-status-warning !bg-status-warning/20';
    case 'offline':
    case 'error':
      return '!border-2 !border-status-error !bg-status-error/20';
    case 'finished':
    case 'idle':
      return '!border-2 !border-status-ok !bg-status-ok/20';
    default:
      return '';
  }
}
