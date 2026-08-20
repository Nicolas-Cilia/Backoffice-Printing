import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, Clock, Edit2, Loader2, Package, Plus, Save, Trash2, TrendingDown, Wallet, X } from 'lucide-react';
import { Pie, PieChart, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api/client';
import type {
  FilamentTrackingLiveRate,
  FilamentTrackingMaterial,
  FilamentTrackingPrinterConsumption,
  FilamentTrackingStage,
} from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { FilamentSwatch } from '../components/FilamentSwatch';
import { ColorSection } from '../components/spool-form/ColorSection';
import { FilamentSection } from '../components/spool-form/FilamentSection';
import { DEFAULT_BRANDS, MATERIALS } from '../components/spool-form/constants';
import { defaultFormData, type ColorPreset, type SpoolFormData } from '../components/spool-form/types';
import { loadRecentColors, saveRecentColor } from '../components/spool-form/utils';
import { useToast } from '../contexts/ToastContext';
import { getCurrencySymbol } from '../utils/currency';
import { formatDateOnly } from '../utils/date';
import { groupRecentUsage, trackingProductLabel, type RecentUsageJob } from '../utils/filamentTracking';

function stageLabel(stage: FilamentTrackingStage, t: (key: string, defaultValue: string) => string): string {
  if (stage === 'collecting') return t('inventory.trackingStageCalibrating', 'Calibrating');
  if (stage === 'day') return t('inventory.trackingStageDay', 'Day stage');
  if (stage === 'week') return t('inventory.trackingStageWeek', 'Week stage');
  return t('inventory.trackingStageMonth', 'Month stage');
}

function swatchRgba(hex: string | null | undefined): string {
  const clean = (hex || '').replace('#', '');
  if (clean.length >= 6) return `${clean.slice(0, 6)}FF`;
  return '808080FF';
}

function formatKg(grams: number): string {
  if (grams <= 0) return '0 kg';
  return `${(grams / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kg`;
}

function formatSpoolCount(count: number): string {
  return String(Math.round(count));
}

function formatConsumed(grams: number): string {
  const abs = Math.abs(grams);
  if (abs <= 0) return '0 g';
  if (abs >= 1000) {
    const kg = abs / 1000;
    const value = kg % 1 === 0 ? String(kg.toFixed(0)) : kg.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `${value} kg`;
  }
  return `${Math.round(abs)} g`;
}

function formatGramsPerHour(grams: number): string {
  const abs = Math.abs(grams);
  if (abs <= 0) return '0 g/h';
  // kg/h only for true kilogram-scale rates. Hundreds of g/h stay g/h.
  if (abs >= 10000) {
    const kg = abs / 1000;
    const value = kg % 1 === 0 ? String(kg.toFixed(0)) : kg.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `${value} kg/h`;
  }
  return `${Math.round(abs)} g/h`;
}

function formatMoney(amount: number | null | undefined, symbol: string): string {
  if (amount == null) return '—';
  return `${symbol}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseCostPerKg(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parseLeadTimeDays(value: string): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return 7;
  return Math.max(1, Math.min(365, parsed));
}

function rowLabel(row: Pick<FilamentTrackingMaterial, 'color_name' | 'material' | 'brand' | 'subtype' | 'extra_colors' | 'effect_type'>): string {
  return trackingProductLabel(row);
}

const PRINTER_SLICE_COLORS = [
  '#07bcec',
  '#3b82f6',
  '#f59e0b',
  '#a78bfa',
  '#34d399',
  '#f472b6',
  '#fb923c',
  '#38bdf8',
  '#e879f9',
  '#4ade80',
];

function printerSliceColor(printerId: number): string {
  return PRINTER_SLICE_COLORS[Math.abs(printerId) % PRINTER_SLICE_COLORS.length];
}

const RING_CORNER = 6;
const RING_GAP_ANGLE = 3;

export function InventorySectionTabs({
  tab,
  onChange,
}: {
  tab: 'tracking' | 'spools';
  onChange: (tab: 'tracking' | 'spools') => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex rounded-lg bg-bambu-dark-secondary p-1">
      <button
        type="button"
        onClick={() => onChange('tracking')}
        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
          tab === 'tracking' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'
        }`}
      >
        {t('inventory.trackingTab', 'Tracking')}
      </button>
      <button
        type="button"
        onClick={() => onChange('spools')}
        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
          tab === 'spools' ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white'
        }`}
      >
        {t('inventory.spoolsTab', 'Spools')}
      </button>
    </div>
  );
}

export function FilamentTrackingPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [stockModal, setStockModal] = useState<
    { mode: 'add' } | { mode: 'edit'; row: FilamentTrackingMaterial } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<FilamentTrackingMaterial | null>(null);

  const planQuery = useQuery({
    queryKey: ['filament-tracking-plan'],
    queryFn: () => api.getFilamentTrackingPlan(),
  });
  const eventsQuery = useQuery({
    queryKey: ['filament-tracking-events'],
    queryFn: () => api.getFilamentTrackingEvents(),
  });
  const printerConsumptionQuery = useQuery({
    queryKey: ['filament-tracking-printer-consumption'],
    queryFn: () => api.getFilamentTrackingPrinterConsumption(),
  });
  const liveRateQuery = useQuery({
    queryKey: ['filament-tracking-live-rate'],
    queryFn: () => api.getFilamentTrackingLiveRate(),
  });
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const createMutation = useMutation({
    mutationFn: (data: {
      colorName: string;
      colorHex: string;
      material: string;
      brand: string;
      subtype: string;
      extraColors: string;
      effectType: string;
      spools: number;
      spoolWeight: number;
      costPerKg: number | null;
      leadTimeDays: number;
    }) =>
      api.createFilamentTrackingBucket({
        color_name: data.colorName,
        material: data.material,
        brand: data.brand || null,
        subtype: data.subtype || null,
        extra_colors: data.extraColors || null,
        effect_type: data.effectType || null,
        color_hex: data.colorHex,
        on_hand_grams: data.spools * data.spoolWeight,
        spool_weight_grams: data.spoolWeight,
        cost_per_kg: data.costPerKg,
        lead_time_days: data.leadTimeDays,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filament-tracking-plan'] });
      setStockModal(null);
      showToast(t('inventory.trackingStockAdded', 'Stock added'), 'success');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const updateMutation = useMutation({
    mutationFn: (data: {
      id: number;
      kg: number;
      spoolWeight: number;
      colorHex: string;
      colorName: string;
      material: string;
      brand: string;
      subtype: string;
      extraColors: string;
      effectType: string;
      costPerKg: number | null;
      leadTimeDays: number;
    }) =>
      api.updateFilamentTrackingBucket(data.id, {
        color_name: data.colorName,
        material: data.material,
        brand: data.brand || null,
        subtype: data.subtype || null,
        extra_colors: data.extraColors || null,
        effect_type: data.effectType || null,
        on_hand_grams: data.kg * 1000,
        spool_weight_grams: data.spoolWeight,
        color_hex: data.colorHex,
        cost_per_kg: data.costPerKg,
        lead_time_days: data.leadTimeDays,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filament-tracking-plan'] });
      setStockModal(null);
      showToast(t('inventory.trackingStockUpdated', 'Stock updated'), 'success');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteFilamentTrackingBucket(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filament-tracking-plan'] });
      queryClient.invalidateQueries({ queryKey: ['filament-tracking-events'] });
      queryClient.invalidateQueries({ queryKey: ['filament-tracking-printer-consumption'] });
      setPendingDelete(null);
      showToast(t('inventory.trackingStockRemoved', 'Stock removed'), 'success');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const plan = planQuery.data;
  const calibrating = plan?.stage === 'collecting';
  const events = eventsQuery.data ?? [];
  const printerConsumption = printerConsumptionQuery.data ?? [];
  const liveRate = liveRateQuery.data;
  const totalPrinterGrams = printerConsumption.reduce((sum, item) => sum + item.grams, 0);
  const recentJobs = useMemo(() => groupRecentUsage(events), [events]);
  const printerNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of printerConsumption) map.set(row.printer_id, row.name);
    return map;
  }, [printerConsumption]);
  const rows = useMemo(() => plan?.materials ?? [], [plan]);
  const currencySymbol = getCurrencySymbol(settingsQuery.data?.currency || 'USD');
  const defaultCostPerKg = settingsQuery.data?.default_filament_cost ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-bambu-gray">
            {t('inventory.trackingEyebrow', 'Material planning')}
          </p>
          <h1 className="text-2xl font-bold text-white mt-1">
            {t('inventory.trackingTitle', 'Filament Tracking')}
          </h1>
          <p className="text-bambu-gray mt-1 max-w-2xl">
            {t(
              'inventory.trackingSubtitle',
              'Create named products like EasyRock White PLA, assign them to printer slots, and prints subtract from that product. Different whites stay separate.',
            )}
          </p>
        </div>
        <Button onClick={() => setStockModal({ mode: 'add' })}>
          <Plus className="w-4 h-4" />
          {t('inventory.trackingAddStock', 'Add stock')}
        </Button>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3" aria-label="Filament overview">
        <Kpi
          label={t('inventory.trackingOnHand', 'On hand')}
          value={formatKg(plan?.total_on_hand_grams ?? 0)}
          sub={`${rows.filter((m) => m.stock_initialized).length} ${t('inventory.trackingProducts', 'products')}`}
          icon={<Package className="w-4 h-4 text-bambu-green" />}
        />
        <Kpi
          label={t('inventory.trackingStockValue', 'Stock value')}
          value={formatMoney(plan?.total_on_hand_value ?? null, currencySymbol)}
          sub={t('inventory.trackingStockValueHint', 'On-hand grams × cost/kg')}
          icon={<Wallet className="w-4 h-4 text-emerald-400" />}
        />
        <Kpi
          label={t('inventory.trackingObserved', 'Observed usage')}
          value={formatKg(plan?.total_observed_usage_grams ?? 0)}
          sub={plan?.window_label ?? t('inventory.trackingNoData', 'No prints yet')}
          icon={<TrendingDown className="w-4 h-4 text-blue-400" />}
        />
        <Kpi
          label={t('inventory.trackingMonthly', 'Monthly estimate')}
          value={calibrating ? '—' : formatKg(plan?.total_monthly_estimate_grams ?? 0)}
          sub={
            calibrating
              ? t('inventory.trackingNeedDay', 'Needs at least one day of prints')
              : plan?.total_monthly_cost_estimate != null
                ? formatMoney(plan.total_monthly_cost_estimate, currencySymbol)
                : stageLabel(plan?.stage ?? 'collecting', t)
          }
        />
        <Kpi
          label={t('inventory.trackingNextOrder', 'Next order')}
          value={
            plan?.soonest_days_until_order == null
              ? '—'
              : `${plan.soonest_days_until_order}d`
          }
          sub={t(
            'inventory.trackingNextOrderHint',
            'Soonest countdown until an order must be placed',
          )}
          icon={<Clock className="w-4 h-4 text-amber-400" />}
        />
        <LiveUsageKpi rate={liveRate} />
      </section>

      <section className="bg-bambu-dark-secondary rounded-lg overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between border-b border-bambu-dark-tertiary">
          <div>
            <h2 className="text-white font-semibold">
              {t('inventory.trackingStockHeading', 'Named product stock')}
            </h2>
            <p className="text-xs text-bambu-gray mt-0.5">
              {t(
                'inventory.trackingStockHint',
                'Cover is days of stock left at the current rate. Order in is days until you must place the next order (cover minus shipping time). Failed prints count the grams used up to the failure.',
              )}
            </p>
          </div>
          {plan && (
            <span className="text-xs text-bambu-gray">
              {stageLabel(plan.stage, t)} · {t('inventory.trackingDay', 'day')} {Math.max(plan.days_observed, 0)}
            </span>
          )}
        </div>

        {planQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-bambu-gray">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16 px-4">
            <Package className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
            <p className="text-white font-medium">{t('inventory.trackingEmpty', 'No product stock yet')}</p>
            <p className="text-sm text-bambu-gray mt-1 max-w-md mx-auto">
              {t(
                'inventory.trackingEmptyHint',
                'Add EasyRock White PLA (or any named product) and assign it to a printer slot. Prints from that slot subtract here.',
              )}
            </p>
            <Button className="mt-4" onClick={() => setStockModal({ mode: 'add' })}>
              <Plus className="w-4 h-4" />
              {t('inventory.trackingAddStock', 'Add stock')}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-bambu-gray">
                  <th className="px-4 py-2 font-medium">{t('inventory.trackingMaterial', 'Material')}</th>
                  <th className="px-4 py-2 font-medium">{t('inventory.trackingOnHand', 'On hand')}</th>
                  <th className="px-4 py-2 font-medium">{t('inventory.costPerKg', 'Cost per kg')}</th>
                  <th className="px-4 py-2 font-medium">{t('inventory.trackingObserved', 'Observed')}</th>
                  <th className="px-4 py-2 font-medium">{t('inventory.trackingMonthly', 'Monthly est.')}</th>
                  <th className="px-4 py-2 font-medium">{t('inventory.trackingCover', 'Cover')}</th>
                  <th className="px-4 py-2 font-medium">{t('inventory.trackingOrderIn', 'Order in')}</th>
                  <th className="px-4 py-2 font-medium w-20" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <MaterialRow
                    key={row.bucket_id}
                    row={row}
                    calibrating={row.stage === 'collecting'}
                    currencySymbol={currencySymbol}
                    onEdit={() => setStockModal({ mode: 'edit', row })}
                    onDelete={() => setPendingDelete(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-bambu-dark-secondary rounded-lg p-4 flex flex-col min-h-0">
          <h2 className="text-white font-semibold mb-1">
            {t('inventory.trackingByPrinter', 'Consumption by printer')}
          </h2>
          <p className="text-xs text-bambu-gray mb-1">
            {t(
              'inventory.trackingByPrinterHint',
              'Each slice is that printer’s share of tracked usage, including prints still running.',
            )}
          </p>
          {printerConsumption.length === 0 ? (
            <p className="text-sm text-bambu-gray mt-3">
              {t('inventory.trackingNoPrinterUsage', 'No printer usage recorded yet.')}
            </p>
          ) : (
            <PrinterConsumptionChart rows={printerConsumption} totalGrams={totalPrinterGrams} />
          )}
        </section>

        <section className="bg-bambu-dark-secondary rounded-lg p-4 flex flex-col min-h-0">
          <h2 className="text-white font-semibold mb-1">{t('inventory.trackingRecent', 'Recent usage')}</h2>
          <p className="text-xs text-bambu-gray mb-1">
            {t(
              'inventory.trackingRecentHint',
              'Estimates come from the slicer file × progress, not AMS remain%. Skip-objects still charge the full plate.',
            )}
          </p>
          {recentJobs.length === 0 ? (
            <p className="text-sm text-bambu-gray mt-3">{t('inventory.trackingNoEvents', 'No usage recorded yet.')}</p>
          ) : (
            <ul className="divide-y divide-bambu-dark-tertiary">
              {recentJobs.map((job) => (
                <RecentUsageRow
                  key={job.key}
                  job={job}
                  printerName={job.printer_id != null ? printerNameById.get(job.printer_id) : undefined}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {stockModal && (
        <TrackingStockModal
          mode={stockModal.mode}
          row={stockModal.mode === 'edit' ? stockModal.row : undefined}
          isPending={createMutation.isPending || updateMutation.isPending}
          currencySymbol={currencySymbol}
          defaultCostPerKg={defaultCostPerKg}
          onClose={() => setStockModal(null)}
          onAdd={(data) => createMutation.mutate(data)}
          onEdit={(data) => updateMutation.mutate(data)}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title={t('common.delete')}
          message={t(
            'inventory.trackingRemoveConfirm',
            'Are you sure you want to delete {{name}}? This cannot be undone. Usage history for this product will also be removed.',
            { name: rowLabel(pendingDelete) },
          )}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(pendingDelete.bucket_id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function LiveUsageKpi({ rate }: { rate: FilamentTrackingLiveRate | undefined }) {
  const { t } = useTranslation();
  const products = rate?.products ?? [];
  const gramsPerHour = rate?.grams_per_hour ?? 0;
  const gramsLastHour = rate?.grams_last_hour ?? 0;
  const activeJobs = rate?.active_jobs ?? 0;
  const warmingUp = Boolean(rate?.warming_up);
  const idle = activeJobs <= 0 && !warmingUp;
  const headline = warmingUp ? '—' : formatGramsPerHour(gramsPerHour);
  const sub = idle
    ? t('inventory.trackingNoLiveUsage', 'No tracked prints running')
    : t('inventory.trackingLastHour', '{{grams}} in the last hour', {
        grams: formatConsumed(gramsLastHour),
      });

  return (
    <article
      className="relative bg-bambu-dark-secondary rounded-lg p-4 min-w-0 group"
      tabIndex={0}
    >
      <div className="flex items-center gap-2 mb-1">
        <Activity className="w-4 h-4 text-bambu-green" />
        <span className="text-xs text-bambu-gray font-medium uppercase tracking-wide">
          {t('inventory.trackingLiveUsage', 'Live usage')}
        </span>
      </div>
      <div className="text-xl font-bold text-white">{headline}</div>
      <div className="text-xs text-bambu-gray mt-1 truncate">{sub}</div>
      <div className="absolute left-0 right-0 top-full z-20 mt-1 hidden group-hover:block group-focus-within:block">
        <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2.5 shadow-lg">
          <p className="text-[11px] text-bambu-gray">
            {warmingUp
              ? t(
                  'inventory.trackingLiveUsageWarmingHint',
                  'Catching up on an in-progress print. Rate waits until elapsed print time is long enough to be stable.',
                )
              : t(
                  'inventory.trackingLiveUsageHint',
                  'Grams deducted from assigned products on in-progress prints. Rate is grams so far divided by elapsed print time (from print start, not first tracking write).',
                )}
          </p>
          {!idle && (
            <p className="text-xs text-bambu-gray mt-1">
              {warmingUp
                ? t('inventory.trackingLiveUsageWarming', 'Warming up · {{count}} running now', {
                    count: activeJobs,
                  })
                : t('inventory.trackingLiveJobs', '{{count}} running now', { count: activeJobs })}
            </p>
          )}
          {products.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {products.map((row) => (
                <li key={row.bucket_id} className="flex items-center justify-between gap-2 min-w-0">
                  <span className="text-xs text-white truncate">{trackingProductLabel(row)}</span>
                  <span className="text-xs font-semibold text-bambu-green whitespace-nowrap flex-shrink-0">
                    {warmingUp ? '—' : formatGramsPerHour(row.grams_per_hour)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-bambu-gray mt-1.5">
              {t(
                'inventory.trackingLiveUsageEmpty',
                'When a print is deducting from assigned stock, each named product shows up here.',
              )}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

function Kpi({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon?: ReactNode;
}) {
  return (
    <article className="bg-bambu-dark-secondary rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-bambu-gray font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-xl font-bold text-white">{value}</div>
      <div className="text-xs text-bambu-gray mt-1">{sub}</div>
    </article>
  );
}

function PrinterSliceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: FilamentTrackingPrinterConsumption }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="bg-bambu-dark border border-bambu-dark-tertiary rounded-lg px-3 py-2 shadow-lg">
      <div className="flex items-center gap-2">
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: printerSliceColor(row.printer_id) }}
        />
        <span className="text-sm font-medium text-white">{row.name}</span>
      </div>
      <div className="text-xs text-bambu-gray mt-0.5">{formatConsumed(row.grams)}</div>
    </div>
  );
}

function PrinterConsumptionChart({
  rows,
  totalGrams,
}: {
  rows: FilamentTrackingPrinterConsumption[];
  totalGrams: number;
}) {
  const { t } = useTranslation();
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const pieRows = rows.filter((row) => row.grams > 0);
  const label = rows
    .map((row) => `${row.name} ${formatConsumed(row.grams)}`)
    .join(', ');
  return (
    <div className="flex-1 min-h-[10.5rem] flex items-stretch gap-6 mt-3 overflow-visible">
      <div
        className="relative flex-shrink-0 h-full min-h-[10.5rem] min-w-[10.5rem] max-h-full aspect-square max-w-[50%] overflow-visible printer-share-chart"
        role="img"
        aria-label={totalGrams > 0 ? label : 'No usage recorded'}
      >
        {pieRows.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieRows}
                dataKey="grams"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius="62%"
                outerRadius="95%"
                paddingAngle={pieRows.length > 1 ? RING_GAP_ANGLE : 0}
                cornerRadius={RING_CORNER}
                startAngle={90}
                endAngle={-270}
                stroke="none"
                isAnimationActive={false}
                onMouseEnter={(data) => {
                  const id = (data as FilamentTrackingPrinterConsumption | undefined)?.printer_id;
                  setHoveredId(id ?? null);
                }}
                onMouseLeave={() => setHoveredId(null)}
              >
                {pieRows.map((row) => (
                  <Cell
                    key={row.printer_id}
                    fill={printerSliceColor(row.printer_id)}
                    style={{ cursor: 'pointer', outline: 'none' }}
                  />
                ))}
              </Pie>
              <Tooltip
                content={<PrinterSliceTooltip />}
                isAnimationActive={false}
                animationDuration={0}
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 30, outline: 'none', pointerEvents: 'none', transition: 'none' }}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
          <div className="text-lg font-bold text-white leading-none">{formatConsumed(totalGrams)}</div>
          <div className="text-[11px] text-bambu-gray mt-1">{t('inventory.trackingUsed', 'used')}</div>
        </div>
      </div>
      <ul className="flex-1 min-w-0 flex flex-col justify-evenly py-1">
        {rows.map((row) => (
          <li
            key={row.printer_id}
            className={`flex items-center gap-2 text-sm min-w-0 transition-opacity ${
              hoveredId != null && hoveredId !== row.printer_id ? 'opacity-40' : ''
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: printerSliceColor(row.printer_id) }}
            />
            <span className="text-white truncate min-w-0 flex-1">{row.name}</span>
            <span className="text-bambu-gray whitespace-nowrap flex-shrink-0">
              {formatConsumed(row.grams)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentUsageRow({
  job,
  printerName,
}: {
  job: RecentUsageJob;
  printerName?: string;
}) {
  const { t } = useTranslation();
  const head = job.products[0];
  const untracked = job.products.every(
    (product) => product.bucket_id === 0 || product.color_name === 'Unassigned',
  );
  const title = job.print_name?.trim() || (head && !untracked ? trackingProductLabel(head) : 'Print');
  const date = job.occurred_at
    ? formatDateOnly(job.occurred_at, { month: 'short', day: 'numeric' })
    : '';
  const status =
    job.kind !== 'completed'
      ? job.progress != null
        ? `${job.kind} · ${Math.round(job.progress)}%`
        : job.kind
      : null;
  const materials = [...new Set(job.products.map((product) => product.material).filter(Boolean))];
  const meta = [
    printerName,
    job.archive_id != null ? `#${job.archive_id}` : null,
    untracked
      ? t('inventory.trackingUnassigned', 'unassigned')
      : job.products.length === 1
        ? head?.material
        : materials.length === 1
          ? materials[0]
          : null,
    untracked ? null : job.products.length === 1 ? head?.color_name : null,
    date,
    status,
  ]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' • ');
  const productLine =
    job.products.length > 1
      ? job.products.map((product) => `${product.color_name} ${formatConsumed(product.grams)}`).join(' · ')
      : null;

  return (
    <li className="flex items-center gap-3 py-3 first:pt-3">
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {untracked
          ? null
          : job.products.map((product) => (
              <FilamentSwatch
                key={product.bucket_id}
                rgba={swatchRgba(product.color_hex)}
                extraColors={product.extra_colors}
                effectType={product.effect_type}
                subtype={product.subtype}
                className="w-3 h-3"
                effectSize="table"
                title={product.color_name}
              />
            ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white truncate">{title}</div>
        {productLine ? (
          <div className="text-xs text-white/80 truncate">{productLine}</div>
        ) : null}
        <div className="text-xs text-bambu-gray truncate">{meta}</div>
      </div>
      <span className="text-sm font-semibold text-bambu-green whitespace-nowrap">
        {formatConsumed(job.grams)}
        {job.estimated ? (
          <span className="ml-1 text-xs font-normal text-bambu-gray">
            {t('inventory.trackingEstimated', 'est.')}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function MaterialRow({
  row,
  calibrating,
  currencySymbol,
  onEdit,
  onDelete,
}: {
  row: FilamentTrackingMaterial;
  calibrating: boolean;
  currencySymbol: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const label = rowLabel(row);
  return (
    <tr className="border-t border-bambu-dark-tertiary">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <FilamentSwatch
            rgba={swatchRgba(row.color_hex)}
            extraColors={row.extra_colors}
            effectType={row.effect_type}
            subtype={row.subtype}
            effectSize="table"
          />
          <div>
            <div className="text-white font-medium">{label}</div>
            {!row.stock_initialized && (
              <div className="text-xs text-amber-400">{t('inventory.trackingSetStartingStock', 'Set starting stock')}</div>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-white">
        <div>{row.stock_initialized ? formatKg(row.on_hand_grams) : '—'}</div>
        {row.stock_initialized && (
          <div className="text-xs text-bambu-gray">
            {formatSpoolCount(row.spool_equivalent)} {t('inventory.spools', 'spools')}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-white">
        <div>{formatMoney(row.cost_per_kg ?? null, currencySymbol)}</div>
        {row.on_hand_value != null && (
          <div className="text-xs text-bambu-gray">{formatMoney(row.on_hand_value, currencySymbol)}</div>
        )}
      </td>
      <td className="px-4 py-3 text-white">{formatKg(row.observed_usage_grams)}</td>
      <td className="px-4 py-3 text-white">
        <div>{calibrating ? '—' : formatKg(row.monthly_estimate_grams)}</div>
        {!calibrating && row.monthly_cost_estimate != null && (
          <div className="text-xs text-bambu-gray">{formatMoney(row.monthly_cost_estimate, currencySymbol)}</div>
        )}
      </td>
      <td className="px-4 py-3 text-white">
        {row.days_of_cover == null ? '—' : `${Math.round(row.days_of_cover)}d`}
      </td>
      <td className="px-4 py-3 text-white">
        {row.days_until_order == null ? '—' : `${row.days_until_order}d`}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            className="p-1.5 text-bambu-gray hover:text-white rounded transition-colors"
            title={t('common.edit')}
            aria-label={t('inventory.trackingEdit', 'Edit {{name}}', { name: label })}
            onClick={onEdit}
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="p-1.5 text-bambu-gray hover:text-red-600 dark:hover:text-red-400 rounded transition-colors"
            title={t('common.delete')}
            aria-label={t('inventory.trackingRemove', 'Remove {{name}}', { name: label })}
            onClick={onDelete}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function TrackingStockModal({
  mode,
  row,
  isPending,
  currencySymbol,
  defaultCostPerKg,
  onClose,
  onAdd,
  onEdit,
}: {
  mode: 'add' | 'edit';
  row?: FilamentTrackingMaterial;
  isPending: boolean;
  currencySymbol: string;
  defaultCostPerKg: number | null;
  onClose: () => void;
  onAdd: (data: {
    colorName: string;
    colorHex: string;
    material: string;
    brand: string;
    subtype: string;
    extraColors: string;
    effectType: string;
    spools: number;
    spoolWeight: number;
    costPerKg: number | null;
    leadTimeDays: number;
  }) => void;
  onEdit: (data: {
    id: number;
    kg: number;
    spoolWeight: number;
    colorHex: string;
    colorName: string;
    material: string;
    brand: string;
    subtype: string;
    extraColors: string;
    effectType: string;
    costPerKg: number | null;
    leadTimeDays: number;
  }) => void;
}) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState<SpoolFormData>(() => ({
    ...defaultFormData,
    material: row?.material || 'PLA',
    brand: row?.brand || '',
    subtype: row?.subtype || '',
    color_name: row?.color_name || '',
    rgba: swatchRgba(row?.color_hex || 'FFFFFF'),
    extra_colors: row?.extra_colors || '',
    effect_type: row?.effect_type || '',
    label_weight: row?.spool_weight_grams || 1000,
  }));
  const [recentColors, setRecentColors] = useState<ColorPreset[]>(() => loadRecentColors());
  const [spools, setSpools] = useState('10');
  const [kg, setKg] = useState(row ? ((row.on_hand_grams || 0) / 1000).toString() : '0');
  const [costPerKg, setCostPerKg] = useState(() => {
    if (row?.cost_per_kg != null) return String(row.cost_per_kg);
    if (mode === 'add' && defaultCostPerKg != null && defaultCostPerKg > 0) {
      return String(defaultCostPerKg);
    }
    return '';
  });
  const [leadTimeDays, setLeadTimeDays] = useState(
    String(row?.lead_time_days && row.lead_time_days > 0 ? row.lead_time_days : 7),
  );

  const appliedDefaultCost = useRef(false);
  useEffect(() => {
    if (appliedDefaultCost.current || mode !== 'add' || costPerKg !== '') return;
    if (defaultCostPerKg != null && defaultCostPerKg > 0) {
      setCostPerKg(String(defaultCostPerKg));
      appliedDefaultCost.current = true;
    }
  }, [mode, defaultCostPerKg, costPerKg]);

  const updateField = <K extends keyof SpoolFormData>(key: K, value: SpoolFormData[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPending) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isPending]);

  const weight = Math.max(1, formData.label_weight || 1000);
  const productName = formData.color_name.trim();
  const trackedLabel = trackingProductLabel({
    color_name: productName,
    material: formData.material,
    brand: formData.brand,
    subtype: formData.subtype,
  });
  const kgPreview =
    mode === 'add'
      ? (Math.max(0, Number(spools) || 0) * weight) / 1000
      : Math.max(0, Number(kg) || 0);
  const spoolPreview = kgPreview / (weight / 1000);
  const colorHex = `#${formData.rgba.replace('#', '').slice(0, 6)}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={isPending ? undefined : onClose}
    >
      <div
        className="relative w-full max-w-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">
            {mode === 'edit'
              ? t('inventory.trackingEditStock', 'Edit {{name}}', {
                  name: row ? rowLabel(row) : '',
                })
              : t('inventory.trackingAddStock', 'Add stock')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="p-1 text-bambu-gray hover:text-white rounded transition-colors"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-6" style={{ scrollbarGutter: 'stable' }}>
          <div>
            <h3 className="text-sm font-semibold text-bambu-gray uppercase tracking-wide mb-3">
              {t('inventory.filamentInfo')}
            </h3>
            <FilamentSection
              formData={formData}
              updateField={updateField}
              cloudAuthenticated={false}
              loadingCloudPresets={false}
              presetInputValue=""
              setPresetInputValue={() => {}}
              filamentOptions={[]}
              availableBrands={DEFAULT_BRANDS}
              availableMaterials={MATERIALS}
              suggestedBrands={[]}
              suggestedMaterials={[]}
              quickAdd
              detailsRequired={false}
              quantity={1}
              onQuantityChange={() => {}}
              identityOnly
            />
          </div>

          <div>
            <h3 className="text-sm font-semibold text-bambu-gray uppercase tracking-wide mb-3">
              {t('inventory.color')}
            </h3>
            <ColorSection
              formData={formData}
              updateField={updateField}
              recentColors={recentColors}
              onColorUsed={(color) => setRecentColors(saveRecentColor(color, recentColors))}
              catalogColors={[]}
            />
            <p className="text-xs text-bambu-gray mt-3">
              {t(
                'inventory.trackingProductHint',
                'Name the product, e.g. EasyRock White. Assign it to a printer slot so prints subtract from this stock — not from every white.',
              )}
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-bambu-gray uppercase tracking-wide mb-3">
              {t('inventory.trackingStockHeading', 'Stock')}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {mode === 'add' ? (
                <div>
                  <label className="block text-sm font-medium text-bambu-gray mb-1" htmlFor="tracking-spools">
                    {t('inventory.quantity')}
                  </label>
                  <input
                    id="tracking-spools"
                    type="number"
                    min={0}
                    value={spools}
                    onChange={(e) => setSpools(e.target.value)}
                    className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-bambu-gray mb-1" htmlFor="tracking-on-hand-kg">
                    {t('inventory.trackingOnHandKg', 'On hand (kg)')}
                  </label>
                  <div className="relative">
                    <input
                      id="tracking-on-hand-kg"
                      type="number"
                      min={0}
                      step={0.1}
                      value={kg}
                      onChange={(e) => setKg(e.target.value)}
                      className="w-full px-3 py-2 pr-8 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-bambu-gray">kg</span>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-bambu-gray mb-1" htmlFor="tracking-spool-weight">
                  {t('inventory.labelWeight')}
                </label>
                <div className="relative">
                  <input
                    id="tracking-spool-weight"
                    type="number"
                    min={1}
                    value={formData.label_weight}
                    onChange={(e) => updateField('label_weight', Math.max(1, Number(e.target.value) || 1))}
                    className="w-full px-3 py-2 pr-7 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-bambu-gray">g</span>
                </div>
              </div>
            </div>
            <p className="text-xs text-bambu-gray mt-2">
              {kgPreview.toFixed(1)} kg · {formatSpoolCount(spoolPreview)} {t('inventory.spools', 'spools')} · {trackedLabel}
            </p>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-sm font-medium text-bambu-gray mb-1" htmlFor="tracking-cost-per-kg">
                  {t('inventory.costPerKg', 'Cost per kg')}
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-bambu-gray text-sm pointer-events-none">
                    {currencySymbol}
                  </span>
                  <input
                    id="tracking-cost-per-kg"
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder="0.00"
                    value={costPerKg}
                    onChange={(e) => setCostPerKg(e.target.value)}
                    style={{ paddingLeft: `${Math.max(2, currencySymbol.length * 0.6 + 1)}rem` }}
                    className="w-full py-2 pr-3 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-bambu-gray mb-1" htmlFor="tracking-lead-time">
                  {t('inventory.trackingLeadTime', 'Shipping time')}
                </label>
                <div className="relative">
                  <input
                    id="tracking-lead-time"
                    type="number"
                    min={1}
                    max={365}
                    value={leadTimeDays}
                    onChange={(e) => setLeadTimeDays(e.target.value)}
                    className="w-full px-3 py-2 pr-12 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:border-bambu-green"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-bambu-gray">
                    {t('inventory.trackingLeadDays', 'days')}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-xs text-bambu-gray mt-2">
              {t(
                'inventory.trackingLeadTimeHint',
                'Order in counts down to when remaining stock would only last this shipping time.',
              )}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-bambu-dark-tertiary flex-shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={isPending || !productName || !formData.material.trim()}
            onClick={() => {
              const cost = parseCostPerKg(costPerKg);
              const leadDays = parseLeadTimeDays(leadTimeDays);
              if (mode === 'add') {
                onAdd({
                  colorName: productName,
                  colorHex,
                  material: formData.material,
                  brand: formData.brand,
                  subtype: formData.subtype,
                  extraColors: formData.extra_colors,
                  effectType: formData.effect_type,
                  spools: Math.max(0, Number(spools) || 0),
                  spoolWeight: weight,
                  costPerKg: cost,
                  leadTimeDays: leadDays,
                });
              } else if (row) {
                onEdit({
                  id: row.bucket_id,
                  colorName: productName,
                  material: formData.material,
                  brand: formData.brand,
                  subtype: formData.subtype,
                  extraColors: formData.extra_colors,
                  effectType: formData.effect_type,
                  kg: Math.max(0, Number(kg) || 0),
                  spoolWeight: weight,
                  colorHex,
                  costPerKg: cost,
                  leadTimeDays: leadDays,
                });
              }
            }}
          >
            {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
