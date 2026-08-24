/**
 * Floor: stations, filament kg, harvest, cleanup — `/floor/scan` (docs/floor-plan.md).
 *
 * Phase 0 (§10/§15): the scan shell only. A USB barcode pistol types a
 * string and Enter into whatever has focus, so this page keeps one hidden
 * input focused at all times and shows the result as big, glove-readable
 * status text — no dropdowns, no dense tables. Prefix routing (`BBS-`,
 * `BBP-`, `BBD-`, `BBF-`, `BBX-`, factory SKUs) lands in later phases; until
 * then every scanned string is unknown, matching the documented behavior in
 * §9 ("Unknown scan string → error flash, no state change").
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanLine } from 'lucide-react';

const ERROR_DISPLAY_MS = 3000;

type ScanStatus = { kind: 'idle' } | { kind: 'error'; value: string };

export function FloorScanPage() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  // A USB pistol fires its whole scan (characters + Enter) far faster than a
  // human types — fast enough that the trailing keydown can land before
  // React has committed the render from the preceding onChange calls. Read
  // from a ref (updated synchronously, same tick as onChange) instead of
  // closing over `value` state, so Enter never sees a stale/partial scan.
  const valueRef = useRef('');
  const [status, setStatus] = useState<ScanStatus>({ kind: 'idle' });

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Always-focused scan field (§3.1): the pistol has no mode switch, so
  // whatever has focus IS the scan target. Re-focus on mount and whenever
  // focus escapes to anywhere else on the page (a stray click/tap is the
  // only realistic way to lose it here — there's nothing else on the page
  // to focus).
  useEffect(() => {
    focusInput();
    const onWindowClick = () => focusInput();
    window.addEventListener('click', onWindowClick);
    return () => window.removeEventListener('click', onWindowClick);
  }, [focusInput]);

  useEffect(() => {
    if (status.kind !== 'error') return;
    const timer = window.setTimeout(() => setStatus({ kind: 'idle' }), ERROR_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    valueRef.current = e.target.value;
    setValue(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const scanned = valueRef.current.trim();
    valueRef.current = '';
    setValue('');
    if (!scanned) return;
    // No prefix is recognized yet (Phase 1+ adds BBS-/BBP-/BBD-/BBF-/BBX-
    // and factory SKUs) — every scan is unknown for now, per §9.
    setStatus({ kind: 'error', value: scanned });
  };

  const isError = status.kind === 'error';

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bambu-dark px-6 text-center">
      {/* z-50: above Layout's compact-mode mobile header (z-40) and desktop
          sidebar (z-30) — this page fully covers app chrome regardless of
          viewport width, matching the "sparse: sidebar collapsed or
          minimal" spec (docs/floor-plan.md §3.1). */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={focusInput}
        aria-label={t('floor.scanFieldLabel', 'Scan field')}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="sr-only"
      />

      <ScanLine
        className={`w-16 h-16 mb-6 transition-colors ${isError ? 'text-red-500' : 'text-bambu-green'}`}
        aria-hidden="true"
      />

      <p className={`text-3xl font-bold transition-colors ${isError ? 'text-red-500' : 'text-white'}`}>
        {isError
          ? t('floor.scanUnknown', 'Unknown code')
          : t('floor.scanIdle', 'Scan a code')}
      </p>

      {isError && (
        <p className="mt-3 text-lg text-bambu-gray-light font-mono break-all max-w-2xl">
          {status.value}
        </p>
      )}
    </div>
  );
}

export default FloorScanPage;
