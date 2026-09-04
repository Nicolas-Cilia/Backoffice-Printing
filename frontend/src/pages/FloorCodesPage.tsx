/**
 * Floor Codes — `/floor/codes` (docs/floor-plan.md §3.3).
 *
 * The office side of Floor: print the QR labels that make scanning work.
 * Normal app chrome (unlike the sparse `/floor/scan` shell) because this is
 * used at a desk, not with a pistol in hand.
 *
 * The page groups the printable floor codes by use: stations, other process
 * checkpoints, printers, reusable bins, and Error labels (Sanding / Rework /
 * Discard benches plus on-screen reason buttons).
 *
 * The QR shown per station is rendered client-side purely as a *preview*; the
 * printed artefact is the server-rendered PDF, whose payload comes from the
 * same `payload` string the backend resolves on a scan.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Loader2, Printer, QrCode, Trash2 } from 'lucide-react';
import { api, type FloorErrorLabel } from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { HorizontalScrollFade } from '../components/HorizontalScrollFade';
import { useToast } from '../contexts/ToastContext';
import { openBlobInNewTab } from '../utils/file';

/** Matches MIN_LABEL_MM / MAX_LABEL_MM in backend/app/services/floor_codes.py.
 *  Validated here too so a bad custom size is caught before the round trip. */
const MIN_LABEL_MM = 20;
const MAX_LABEL_MM = 200;
/** Max custom (non-Other) reasons enabled per scan section. */
const MAX_CUSTOM_REASONS_PER_SECTION = 5;

const SIZE_PRESETS_MM = [40, 60, 80] as const;
type SizeMode = '40' | '60' | '80' | 'custom';

type ReasonSection = 'sanding' | 'rework' | 'discard';

const REASON_SECTION_FLAGS: Array<{
  section: ReasonSection;
  flag: 'show_on_sanding' | 'show_on_rework' | 'show_on_discard';
  labelKey: string;
  labelFallback: string;
}> = [
  { section: 'sanding', flag: 'show_on_sanding', labelKey: 'floor.reasonShowSanding', labelFallback: 'Show on Sanding' },
  { section: 'rework', flag: 'show_on_rework', labelKey: 'floor.reasonShowRework', labelFallback: 'Show on Rework' },
  { section: 'discard', flag: 'show_on_discard', labelKey: 'floor.reasonShowDiscard', labelFallback: 'Show on Discard' },
];

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

/** Matches the API's slug rule: lowercase words separated by single hyphens. */
function normalizeErrorSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** Pick a unique slug from a display name; operators never enter BBF codes. */
function uniqueErrorSlug(name: string, existing: Array<{ slug: string }>): string {
  const base = normalizeErrorSlug(name) || 'reason';
  if (!existing.some((row) => row.slug === base)) return base;
  let n = 2;
  while (existing.some((row) => row.slug === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Bench QRs printed on the Error labels tab (with Discard), not under Processes. */
const ERROR_TAB_PROCESS_SLUGS = new Set(['sanding', 'wip-rework']);

/** Which label family is being printed. Errors land in phase 9c.
 *  `locations` is a display-only split of the same station catalog as
 *  `stations` (§5.4a/§5.4b's `category` field) — Initial QC Pass and Rework are
 *  QC checkpoints a part passes through, not workflow-mode benches, so they
 *  get their own tab even though they're printed and resolved exactly like
 *  any other `BBS-` code. */
type CodesTab = 'stations' | 'locations' | 'printers' | 'bins' | 'errors';

export function FloorCodesPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

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
  const errorsQuery = useQuery({
    queryKey: ['floor-error-labels'],
    queryFn: () => api.getFloorErrorLabels(),
    enabled: tab === 'errors',
  });
  const binsQuery = useQuery({
    queryKey: ['floor-bins'],
    queryFn: () => api.getFloorBins(),
    enabled: tab === 'bins',
  });
  const [errorName, setErrorName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  const stations = useMemo(
    () => (stationsQuery.data ?? []).filter((s) => s.category === 'station'),
    [stationsQuery.data],
  );
  const locations = useMemo(
    () =>
      (stationsQuery.data ?? []).filter(
        (s) => s.category === 'location' && !ERROR_TAB_PROCESS_SLUGS.has(s.slug),
      ),
    [stationsQuery.data],
  );
  const errorTabProcesses = useMemo(
    () =>
      (stationsQuery.data ?? []).filter(
        (s) => s.category === 'location' && ERROR_TAB_PROCESS_SLUGS.has(s.slug),
      ),
    [stationsQuery.data],
  );
  const printers = useMemo(() => printersQuery.data ?? [], [printersQuery.data]);
  const errors = useMemo(() => errorsQuery.data ?? [], [errorsQuery.data]);
  const bins = useMemo(() => binsQuery.data ?? [], [binsQuery.data]);

  /** The rows the active tab prints, reduced to what the picker needs. Every
   *  label family is a list of (payload, title, subtitle) — keeping
   *  one shape means the selection, size picker and print button are written
   *  once rather than duplicated per tab. */
  const items = useMemo(() => {
    if (tab === 'stations') return stations.map((s) => ({ payload: s.payload, title: s.name, subtitle: s.description }));
    if (tab === 'locations') return locations.map((s) => ({ payload: s.payload, title: s.name, subtitle: s.description }));
    if (tab === 'errors') {
      return [
        ...errorTabProcesses.map((s) => ({
          payload: s.payload,
          title: s.name,
          subtitle: s.description,
        })),
        {
          payload: 'BBX-discard',
          title: 'Discard',
          subtitle: t('floor.codesDiscardSubtitle', 'Then select a reason on screen.'),
        },
      ];
    }
    if (tab === 'bins') return bins.map((bin) => ({
      payload: bin.payload,
      title: `${bin.part_name} ${bin.bin_number}`,
      subtitle: 'Shared reusable bin',
    }));
    return printers.map((p) => ({
      payload: p.payload,
      title: p.name,
      subtitle: [p.model, p.location].filter(Boolean).join(' · ') || '—',
    }));
  }, [tab, stations, locations, errorTabProcesses, printers, bins, t]);

  // Locations shares the station catalog query — it's the same data, split
  // by `category` client-side, not a second fetch. Sanding / Rework / Discard
  // printables live on the Error labels tab with the on-screen reasons.
  const activeQuery = tab === 'printers' ? printersQuery : tab === 'bins' ? binsQuery : stationsQuery;

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
      // Locations prints through the same `/floor/labels/stations` endpoint
      // as Station labels — it's the same catalog and the same `BBS-`
      // resolution on the backend, just a different client-side filter.
      const blob =
        tab === 'printers'
          ? await api.printFloorPrinterLabels(body)
          : tab === 'bins'
            ? await api.printFloorBinLabels(body)
          : tab === 'errors'
            ? await api.printFloorErrorLabels(body)
          : await api.printFloorStationLabels(body);
      const filename =
        tab === 'printers'
          ? 'bambuddy-printer-labels.pdf'
          : tab === 'bins'
            ? 'bambuddy-bin-labels.pdf'
          : tab === 'locations'
            ? 'bambuddy-location-labels.pdf'
            : tab === 'errors'
              ? 'bambuddy-error-labels.pdf'
            : 'bambuddy-station-labels.pdf';
      openBlobInNewTab(blob, filename);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('floor.codesPrintError', 'Could not generate labels: {{msg}}', { msg }), 'error');
    } finally {
      setPrinting(false);
    }
  };

  const customCountForSection = (flag: 'show_on_sanding' | 'show_on_rework' | 'show_on_discard') =>
    errors.filter((label) => label.slug !== 'other' && label[flag]).length;

  const moveErrorLabel = async (label: FloorErrorLabel, direction: -1 | 1) => {
    const customs = errors.filter((row) => row.slug !== 'other');
    const index = customs.findIndex((row) => row.id === label.id);
    const swapIndex = index + direction;
    if (index < 0 || swapIndex < 0 || swapIndex >= customs.length) return;
    const reordered = [...customs];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(swapIndex, 0, moved);
    try {
      await Promise.all(
        reordered.map((row, sortOrder) => api.updateFloorErrorLabel(row.id, { sort_order: sortOrder })),
      );
      await queryClient.invalidateQueries({ queryKey: ['floor-error-labels'] });
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t('floor.reasonReorderFailed', 'Could not reorder reason'),
        'error',
      );
    }
  };

  const toggleErrorSection = async (
    label: FloorErrorLabel,
    flag: 'show_on_sanding' | 'show_on_rework' | 'show_on_discard',
    next: boolean,
  ) => {
    if (label.is_protected || label.slug === 'other') return;
    if (next && customCountForSection(flag) >= MAX_CUSTOM_REASONS_PER_SECTION && !label[flag]) {
      showToast(
        t(
          'floor.reasonSectionCap',
          'At most {{count}} custom reasons can show here (plus Other)',
          { count: MAX_CUSTOM_REASONS_PER_SECTION },
        ),
        'error',
      );
      return;
    }
    try {
      await api.updateFloorErrorLabel(label.id, { [flag]: next });
      await queryClient.invalidateQueries({ queryKey: ['floor-error-labels'] });
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t('floor.reasonUpdateFailed', 'Could not update reason'),
        'error',
      );
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-bambu-gray">
          {t('floor.landingEyebrow', 'Production floor')}
        </p>
        <h1 className="text-2xl font-bold text-white mt-1">{t('floor.codesTitle', 'Codes')}</h1>
        <p className="text-bambu-gray mt-1 max-w-2xl break-words">
          {t(
            'floor.codesSubtitle',
            'Print the QR labels the floor scans. Print to office paper, cut out, and tape them where they belong.',
          )}
        </p>
      </div>

      <HorizontalScrollFade className="w-full md:w-auto" fadeFromClassName="from-bambu-dark">
        <div className="inline-flex flex-nowrap gap-1 rounded-lg bg-bambu-dark-secondary p-1">
        <button
          type="button"
          onClick={() => setTab('stations')}
          aria-current={tab === 'stations' ? 'page' : undefined}
          className={`shrink-0 whitespace-nowrap px-3 py-2.5 text-sm rounded-md transition-colors md:py-1.5 ${
            tab === 'stations' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'
          }`}
        >
          {t('floor.codesTabStations', 'Station labels')}
        </button>
        <button
          type="button"
          onClick={() => setTab('locations')}
          aria-current={tab === 'locations' ? 'page' : undefined}
          className={`shrink-0 whitespace-nowrap px-3 py-2.5 text-sm rounded-md transition-colors md:py-1.5 ${
            tab === 'locations' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'
          }`}
        >
          {t('floor.codesTabLocations', 'Processes')}
        </button>
        <button
          type="button"
          onClick={() => setTab('printers')}
          aria-current={tab === 'printers' ? 'page' : undefined}
          className={`shrink-0 whitespace-nowrap px-3 py-2.5 text-sm rounded-md transition-colors md:py-1.5 ${
            tab === 'printers' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'
          }`}
        >
          {t('floor.codesTabPrinters', 'Printer labels')}
        </button>
        <button
          type="button"
          onClick={() => setTab('bins')}
          aria-current={tab === 'bins' ? 'page' : undefined}
          className={`shrink-0 whitespace-nowrap px-3 py-2.5 text-sm rounded-md transition-colors md:py-1.5 ${
            tab === 'bins' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'
          }`}
        >
          {t('floor.codesTabBins', 'Bins')}
        </button>
        <button
          type="button"
          onClick={() => setTab('errors')}
          aria-current={tab === 'errors' ? 'page' : undefined}
          className={`shrink-0 whitespace-nowrap px-3 py-2.5 text-sm rounded-md transition-colors md:py-1.5 ${tab === 'errors' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'}`}
        >
          {t('floor.codesTabErrors', 'Error labels')}
        </button>
        </div>
      </HorizontalScrollFade>

      <section className="bg-bambu-dark-secondary rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-bambu-dark-tertiary flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-white font-semibold">
              {tab === 'stations'
                ? t('floor.codesStationsHeading', 'Station labels')
                : tab === 'locations'
                  ? t('floor.codesLocationsHeading', 'Processes')
                  : tab === 'errors'
                    ? t('floor.codesErrorsHeading', 'Error labels')
                  : tab === 'bins'
                    ? t('floor.codesBinsHeading', 'Part bins')
                  : t('floor.codesPrintersHeading', 'Printer labels')}
            </h2>
            <p className="text-xs text-bambu-gray mt-0.5">
              {tab === 'stations'
                ? t(
                    'floor.codesStationsHint',
                    'One label per station. Scanning a station QR opens or closes that station on the scan page.',
                  )
                : tab === 'locations'
                  ? t(
                      'floor.codesLocationsHint',
                      'Initial QC Pass and other process checkpoints. Scanning one opens that checkpoint on the scan page, same as a station QR.',
                    )
                  : tab === 'errors'
                    ? t(
                        'floor.codesErrorsHint',
                        'Print Sanding, Rework, and Discard. On-screen reasons below appear as buttons after those scans.',
                      )
                  : tab === 'bins'
                    ? t('floor.codesBinsHint', 'Print three shared reusable KNB bins, three shared reusable BUT bins, and three shared reusable BOT bins.')
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

        {tab !== 'errors' && activeQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-bambu-gray">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : tab !== 'errors' && activeQuery.isError ? (
          <div className="text-center py-16 px-4">
            <QrCode className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
            <p className="text-white font-medium">
              {tab === 'stations'
                ? t('floor.codesLoadError', 'Could not load stations')
                : tab === 'locations'
                  ? t('floor.codesLocationsLoadError', 'Could not load locations')
                  : tab === 'bins'
                    ? t('floor.codesBinsLoadError', 'Could not load bins')
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
              {tab === 'bins'
                ? t('floor.codesNoBins', 'No bins to label yet')
                : t('floor.codesNoPrinters', 'No printers to label yet')}
            </p>
            <p className="text-sm text-bambu-gray mt-1">
              {tab === 'bins'
                ? t('floor.codesNoBinsHint', 'These nine permanent bin labels are available independently of the printer catalog.')
                : t('floor.codesNoPrintersHint', 'Add a printer first, then print its label here.')}
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

      {tab === 'errors' && (
        <section className="bg-bambu-dark-secondary rounded-lg p-4 space-y-3">
          <h2 className="text-white font-semibold">{t('floor.codesReasonsHeading', 'On-screen reasons')}</h2>
          <p className="text-xs text-bambu-gray">
            {t(
              'floor.codesReasonsHint',
              'These appear as buttons after scanning Sanding, Rework, or Discard. They are not printed as QR codes.',
            )}
          </p>
          {errorsQuery.isLoading ? (
            <div className="flex items-center py-4 text-bambu-gray">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              {t('common.loading', 'Loading…')}
            </div>
          ) : errorsQuery.isError ? (
            <div className="py-2">
              <p className="text-sm text-white">{t('floor.reasonsLoadError', 'Could not load reasons')}</p>
              <Button className="mt-3" variant="secondary" onClick={() => errorsQuery.refetch()}>
                {t('common.retry', 'Retry')}
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-bambu-dark-tertiary rounded-lg border border-bambu-dark-tertiary">
              {errors.map((error) => {
                const customs = errors.filter((row) => row.slug !== 'other');
                const customIndex = customs.findIndex((row) => row.id === error.id);
                const isOther = error.is_protected || error.slug === 'other';
                return (
                  <li key={error.id} className="flex flex-col gap-3 px-3 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-white font-medium">
                          {error.name}
                          {isOther && (
                            <span className="ml-2 text-xs font-normal text-bambu-gray">
                              {t('floor.reasonAlwaysShown', 'Always shown')}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {!isOther && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="w-auto"
                              disabled={customIndex <= 0}
                              onClick={() => void moveErrorLabel(error, -1)}
                              aria-label={t('floor.reasonMoveUp', 'Move up')}
                            >
                              ↑
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="w-auto"
                              disabled={customIndex < 0 || customIndex >= customs.length - 1}
                              onClick={() => void moveErrorLabel(error, 1)}
                              aria-label={t('floor.reasonMoveDown', 'Move down')}
                            >
                              ↓
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              className="w-full md:w-auto"
                              onClick={() => setDeleteTarget({ id: error.id, name: error.name })}
                            >
                              <Trash2 className="h-4 w-4" />
                              Remove
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {REASON_SECTION_FLAGS.map(({ flag, labelKey, labelFallback }) => (
                        <label
                          key={flag}
                          className={`inline-flex items-center gap-2 text-sm ${
                            isOther ? 'text-bambu-gray' : 'text-bambu-gray-light'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="rounded border-bambu-dark-tertiary"
                            checked={isOther ? true : Boolean(error[flag])}
                            disabled={isOther}
                            onChange={(event) => void toggleErrorSection(error, flag, event.target.checked)}
                            aria-label={t(labelKey, labelFallback)}
                          />
                          {t(labelKey, labelFallback)}
                        </label>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <h3 className="text-white font-semibold pt-2">{t('floor.codesReasonsAddHeading', 'Add a reason')}</h3>
          <div className="flex flex-wrap gap-2">
            <input
              value={errorName}
              onChange={(e) => setErrorName(e.target.value)}
              placeholder={t('floor.codesReasonNamePlaceholder', 'Reason name')}
              className="min-w-[12rem] flex-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white"
            />
            <Button
              onClick={async () => {
                const name = errorName.trim();
                if (!name) return;
                try {
                  const nextSort =
                    Math.max(0, ...errors.filter((row) => row.slug !== 'other').map((row) => row.sort_order)) + 1;
                  await api.createFloorErrorLabel({
                    name,
                    slug: uniqueErrorSlug(name, errors),
                    sort_order: nextSort,
                  });
                  setErrorName('');
                  await queryClient.invalidateQueries({ queryKey: ['floor-error-labels'] });
                } catch (err) {
                  showToast(err instanceof Error ? err.message : 'Could not add error label', 'error');
                }
              }}
              disabled={!errorName.trim()}
            >
              {t('floor.codesReasonsAdd', 'Add reason')}
            </Button>
          </div>
        </section>
      )}

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

        <div className="flex flex-col items-stretch gap-2 pt-1 md:flex-row md:flex-wrap md:items-center">
          <Button onClick={handlePrint} disabled={!canPrint} className="w-full md:w-auto">
            {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
            {/* Phrased to avoid a plural form: these strings are inline
                defaults, so a real _one/_other pair would have to be added to
                all 13 locale files for one button. */}
            {t('floor.codesPrint', 'Print selected ({{count}})', { count: selected.size })}
          </Button>
          <span className="text-xs text-bambu-gray break-words">
            {t('floor.codesPrintHint', 'Opens a PDF in a new tab — print it from there.')}
          </span>
        </div>
      </section>
      {deleteTarget && (
        <ConfirmModal
          title="Remove error label?"
          message={`This permanently removes ${deleteTarget.name} from on-screen reason buttons. Existing part history keeps the recorded reason. This cannot be undone.`}
          confirmText="Remove permanently"
          variant="danger"
          isLoading={deletePending}
          onCancel={() => !deletePending && setDeleteTarget(null)}
          onConfirm={async () => {
            setDeletePending(true);
            try {
              await api.deleteFloorErrorLabel(deleteTarget.id);
              await queryClient.invalidateQueries({ queryKey: ['floor-error-labels'] });
              setDeleteTarget(null);
            } catch (err) {
              showToast(err instanceof Error ? err.message : 'Could not remove error label', 'error');
            } finally {
              setDeletePending(false);
            }
          }}
        />
      )}
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
    <li className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3 md:items-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={title}
          className="mt-1 h-4 w-4 shrink-0 accent-bambu-green md:mt-0"
        />
        {/* White plate behind the preview: a QR needs light quiet-zone contrast,
            and the page background is near-black. */}
        <div
          className="shrink-0 rounded border border-gray-300 bg-white p-1 shadow-md shadow-gray-400/40 dark:border-gray-700 dark:shadow-none"
          aria-hidden="true"
        >
          <QRCodeSVG value={payload} size={48} />
        </div>
        <div className="min-w-0 flex-1 md:flex md:items-center md:justify-between md:gap-4">
          <div className="min-w-0">
            <div className="break-words font-medium text-white">{title}</div>
            <div className="mt-0.5 break-words text-xs text-bambu-gray md:truncate">{subtitle}</div>
          </div>
          <code className="mt-1 block break-all font-mono text-xs text-bambu-gray-light md:mt-0 md:shrink-0 md:whitespace-nowrap">
            {payload}
          </code>
        </div>
      </div>
    </li>
  );
}

export default FloorCodesPage;
