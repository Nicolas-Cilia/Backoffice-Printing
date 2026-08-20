import type { PrinterState } from '../components/BulkPrinterToolbar';

const TINTED = 'printer-card-tinted';

/**
 * Card chrome (border + wash) so operators can scan the printer grid.
 *
 * Paused → orange, disconnected/error → red, idle/finished → green.
 * Printing stays the default card chrome so in-progress jobs don't look
 * like idle/available printers.
 *
 * The wash is an opaque mix of the status color and the card fill
 * (see `.printer-card-chrome-*` in index.css). A translucent
 * `bg-status-ok/20` replaced the card surface and washed out inner
 * labels, tracks, and disabled controls.
 */
export function getPrinterCardChromeClass(bucket: PrinterState): string {
  switch (bucket) {
    case 'paused':
      return `${TINTED} printer-card-chrome-warning !border-2 !border-status-warning`;
    case 'offline':
    case 'error':
      return `${TINTED} printer-card-chrome-error !border-2 !border-status-error`;
    case 'finished':
    case 'idle':
      return `${TINTED} printer-card-chrome-ok !border-2 !border-status-ok`;
    default:
      return '';
  }
}

/**
 * Idle/unavailable Pause/Stop — readable on a tinted card, still obviously
 * not the armed yellow/red actions.
 */
export const PRINTER_CARD_DISABLED_CONTROL =
  'bg-bambu-dark text-bambu-gray cursor-not-allowed';
