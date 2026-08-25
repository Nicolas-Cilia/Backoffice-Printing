/**
 * Floor Codes — `/floor/codes` (docs/floor-plan.md §3.3).
 *
 * The office side of Floor: print the QR labels that make scanning work.
 * Normal app chrome (unlike the sparse `/floor/scan` shell) because this is
 * used at a desk, not with a pistol in hand.
 *
 * Phase 1a ships the Station labels tab only — that is exactly what phase
 * 1b's own test gate needs (a printable `BBS-…` to scan). Printer labels
 * (phase 7) and Error/Command labels (phase 9) are shown as disabled tabs so
 * the page's shape is honest about what exists rather than hiding it.
 *
 * The QR shown per station is rendered client-side purely as a *preview*; the
 * printed artefact is the server-rendered PDF, whose payload comes from the
 * same `payload` string the backend resolves on a scan.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Loader2, Printer, QrCode } from 'lucide-react';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { useToast } from '../contexts/ToastContext';
import { openBlobInNewTab } from '../utils/file';

/** Matches MIN_LABEL_MM / MAX_LABEL_MM in backend/app/services/floor_codes.py.
 *  Validated here too so a bad custom size is caught before the round trip. */
const MIN_LABEL_MM = 20;
const MAX_LABEL_MM = 200;

const SIZE_PRESETS_MM = [40, 60, 80] as const;
type SizeMode = '40' | '60' | '80' | 'custom';

const SIZE_STORAGE_KEY = 'floorCodeLabelSize';

interface StoredSize {
  mode: SizeMode;
  width: number;
  height: number;
}

const DEFAULT_SIZE: StoredSize = { mode: '60', width: 60, height: 60 };

function loadStoredSize(): StoredSize {
  try {
    const raw = localStorage.getItem(SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_SIZE;
    const parsed = JSON.parse(raw) as Partial<StoredSize>;
    const mode = parsed.mode;
    if (mode !== 'custom' && mode !== '40' && mode !== '60' && mode !== '80') return DEFAULT_SIZE;
    return {
      mode,
      width: Number(parsed.width) || DEFAULT_SIZE.width,
      height: Number(parsed.height) || DEFAULT_SIZE.height,
    };
  } catch {
    return DEFAULT_SIZE;
  }
}

function isValidDimension(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_LABEL_MM && value <= MAX_LABEL_MM;
}

/** Which label family is being printed. Errors land in phase 9. */
type CodesTab = 'stations' | 'printers';

export function FloorCodesPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [tab, setTab] = useState<CodesTab>('stations');

  const stationsQuery = useQuery({
    queryKey: ['floor-stations'],
    queryFn: () => api.getFloorStations(),
  });
  const printersQuery = useQuery({
    queryKey: ['floor-printers'],
    queryFn: () => api.getFloorPrinters(),
    // Only fetched once the tab is opened: an office user printing station
    // labels has no reason to pull the printer list.
    enabled: tab === 'printers',
  });

  const stations = useMemo(() => stationsQuery.data ?? [], [stationsQuery.data]);
  const printers = useMemo(() => printersQuery.data ?? [], [printersQuery.data]);

  /** The rows the active tab prints, reduced to what the picker needs. Both
   *  label families are a list of (payload, title, subtitle) — keeping one
   *  shape means the selection, size picker and print button are written
   *  once rather than duplicated per tab. */
  const items = useMemo(
    () =>
      tab === 'stations'
        ? stations.map((s) => ({ payload: s.payload, title: s.name, subtitle: s.description }))
        : printers.map((p) => ({
            payload: p.payload,
            title: p.name,
            subtitle: [p.model, p.location].filter(Boolean).join(' · ') || '—',
          })),
    [tab, stations, printers],
  );

  const activeQuery = tab === 'stations' ? stationsQuery : printersQuery;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [size, setSize] = useState<StoredSize>(() => loadStoredSize());
  const [printing, setPrinting] = useState(false);

  // Default to everything checked: the common errand is "print the whole set
  // for a new bench", not picking one. Keyed on the payload list so switching
  // tabs re-selects for the tab now shown rather than carrying a stale
  // selection across.
  const payloadKey = items.map((i) => i.payload).join('|');
  useEffect(() => {
    setSelected(new Set(payloadKey ? payloadKey.split('|') : []));
  }, [payloadKey]);

  useEffect(() => {
    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(size));
  }, [size]);

  const { width, height } =
    size.mode === 'custom'
      ? { width: size.width, height: size.height }
      : { width: Number(size.mode), height: Number(size.mode) };

  const sizeValid = isValidDimension(width) && isValidDimension(height);
  const canPrint = selected.size > 0 && sizeValid && !printing;

  const toggle = (payload: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(payload)) next.delete(payload);
      else next.add(payload);
      return next;
    });
  };

  const allSelected = items.length > 0 && selected.size === items.length;

  const handlePrint = async () => {
    if (!canPrint) return;
    // Preserve catalog order so the PDF's page order matches the list.
    const payloads = items.map((i) => i.payload).filter((p) => selected.has(p));
    setPrinting(true);
    try {
      const body = { payloads, width_mm: width, height_mm: height };
      const blob =
        tab === 'stations'
          ? await api.printFloorStationLabels(body)
          : await api.printFloorPrinterLabels(body);
      openBlobInNewTab(
        blob,
        tab === 'stations' ? 'bambuddy-station-labels.pdf' : 'bambuddy-printer-labels.pdf',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('floor.codesPrintError', 'Could not generate labels: {{msg}}', { msg }), 'error');
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-bambu-gray">
          {t('floor.landingEyebrow', 'Production floor')}
        </p>
        <h1 className="text-2xl font-bold text-white mt-1">{t('floor.codesTitle', 'Codes')}</h1>
        <p className="text-bambu-gray mt-1 max-w-2xl">
          {t(
            'floor.codesSubtitle',
            'Print the QR labels the floor scans. Print to office paper, cut out, and tape them where they belong.',
          )}
        </p>
      </div>

      <div className="inline-flex rounded-lg bg-bambu-dark-secondary p-1">
        <button
          type="button"
          onClick={() => setTab('stations')}
          aria-current={tab === 'stations' ? 'page' : undefined}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            tab === 'stations' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'
          }`}
        >
          {t('floor.codesTabStations', 'Station labels')}
        </button>
        <button
          type="button"
          onClick={() => setTab('printers')}
          aria-current={tab === 'printers' ? 'page' : undefined}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            tab === 'printers' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'
          }`}
        >
          {t('floor.codesTabPrinters', 'Printer labels')}
        </button>
        {/* Error labels land with cleanup (phase 9). Shown disabled rather
            than hidden so the page's shape stays honest about what exists. */}
        <button
          type="button"
          disabled
          className="px-3 py-1.5 text-sm rounded-md transition-colors text-bambu-gray opacity-50 cursor-not-allowed"
        >
          {t('floor.codesTabErrors', 'Error labels')}
        </button>
      </div>

      <section className="bg-bambu-dark-secondary rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-bambu-dark-tertiary flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-white font-semibold">
              {tab === 'stations'
                ? t('floor.codesStationsHeading', 'Station labels')
                : t('floor.codesPrintersHeading', 'Printer labels')}
            </h2>
            <p className="text-xs text-bambu-gray mt-0.5">
              {tab === 'stations'
                ? t(
                    'floor.codesStationsHint',
                    'One label per station. Scanning a station QR opens or closes that station on the scan page.',
                  )
                : t(
                    'floor.codesPrintersHint',
                    'One label per printer, stuck on the machine. Scanning it shows what that printer is doing and what it last finished.',
                  )}
            </p>
          </div>
          {items.length > 0 && (
            <button
              type="button"
              className="text-sm text-bambu-gray hover:text-white transition-colors"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(items.map((i) => i.payload)))
              }
            >
              {allSelected
                ? t('floor.codesSelectNone', 'Select none')
                : t('floor.codesSelectAll', 'Select all')}
            </button>
          )}
        </div>

        {activeQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-bambu-gray">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : activeQuery.isError ? (
          <div className="text-center py-16 px-4">
            <QrCode className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
            <p className="text-white font-medium">
              {tab === 'stations'
                ? t('floor.codesLoadError', 'Could not load stations')
                : t('floor.codesPrintersLoadError', 'Could not load printers')}
            </p>
            <Button className="mt-4" variant="secondary" onClick={() => activeQuery.refetch()}>
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        ) : items.length === 0 ? (
          // Reachable on the printers tab for an install with no printers
          // added yet — an empty list with no explanation reads as a bug.
          <div className="text-center py-16 px-4">
            <QrCode className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
            <p className="text-white font-medium">
              {t('floor.codesNoPrinters', 'No printers to label yet')}
            </p>
            <p className="text-sm text-bambu-gray mt-1">
              {t('floor.codesNoPrintersHint', 'Add a printer first, then print its label here.')}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-bambu-dark-tertiary">
            {items.map((item) => (
              <CodeRow
                key={item.payload}
                payload={item.payload}
                title={item.title}
                subtitle={item.subtitle}
                checked={selected.has(item.payload)}
                onToggle={() => toggle(item.payload)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="bg-bambu-dark-secondary rounded-lg p-4 space-y-3">
        <h2 className="text-white font-semibold">{t('floor.codesSizeHeading', 'Label size')}</h2>

        <div className="flex flex-wrap items-center gap-2">
          {SIZE_PRESETS_MM.map((preset) => {
            const mode = String(preset) as SizeMode;
            const active = size.mode === mode;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => setSize((prev) => ({ ...prev, mode }))}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  active ? 'bg-bambu-green text-white' : 'bg-bambu-dark text-bambu-gray hover:text-white'
                }`}
              >
                {preset} × {preset} mm
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setSize((prev) => ({ ...prev, mode: 'custom' }))}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              size.mode === 'custom'
                ? 'bg-bambu-green text-white'
                : 'bg-bambu-dark text-bambu-gray hover:text-white'
            }`}
          >
            {t('floor.codesSizeCustom', 'Custom')}
          </button>
        </div>

        {size.mode === 'custom' && (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium text-bambu-gray mb-1" htmlFor="floor-label-width">
                {t('floor.codesSizeWidth', 'Width (mm)')}
              </label>
              <input
                id="floor-label-width"
                type="number"
                min={MIN_LABEL_MM}
                max={MAX_LABEL_MM}
                value={size.width}
                onChange={(e) => setSize((prev) => ({ ...prev, width: Number(e.target.value) }))}
                className="w-28 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-bambu-gray mb-1" htmlFor="floor-label-height">
                {t('floor.codesSizeHeight', 'Height (mm)')}
              </label>
              <input
                id="floor-label-height"
                type="number"
                min={MIN_LABEL_MM}
                max={MAX_LABEL_MM}
                value={size.height}
                onChange={(e) => setSize((prev) => ({ ...prev, height: Number(e.target.value) }))}
                className="w-28 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
              />
            </div>
          </div>
        )}

        {!sizeValid && (
          <p className="text-sm text-red-500">
            {t('floor.codesSizeInvalid', 'Size must be between {{min}} and {{max}} mm.', {
              min: MIN_LABEL_MM,
              max: MAX_LABEL_MM,
            })}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button onClick={handlePrint} disabled={!canPrint}>
            {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
            {/* Phrased to avoid a plural form: these strings are inline
                defaults, so a real _one/_other pair would have to be added to
                all 13 locale files for one button. */}
            {t('floor.codesPrint', 'Print selected ({{count}})', { count: selected.size })}
          </Button>
          <span className="text-xs text-bambu-gray">
            {t('floor.codesPrintHint', 'Opens a PDF in a new tab — print it from there.')}
          </span>
        </div>
      </section>
    </div>
  );
}

/** One printable row, used by both label families. The QR is a *preview*
 *  rendered client-side; the printed artefact is the server-rendered PDF,
 *  whose payload comes from the same string the backend resolves on a scan. */
function CodeRow({
  payload,
  title,
  subtitle,
  checked,
  onToggle,
}: {
  payload: string;
  title: string;
  subtitle: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={title}
        className="w-4 h-4 flex-shrink-0 accent-bambu-green"
      />
      {/* White plate behind the preview: a QR needs light quiet-zone contrast,
          and the page background is near-black. */}
      <div className="bg-white rounded p-1 flex-shrink-0" aria-hidden="true">
        <QRCodeSVG value={payload} size={48} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-white font-medium">{title}</div>
        <div className="text-xs text-bambu-gray truncate">{subtitle}</div>
      </div>
      <code className="text-xs text-bambu-gray-light font-mono whitespace-nowrap">{payload}</code>
    </li>
  );
}

export default FloorCodesPage;
