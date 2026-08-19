import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Clock, Edit2, Loader2, Package, Plus, Save, Trash2, TrendingDown, Wallet, X } from 'lucide-react';
import { api } from '../api/client';
import type { FilamentTrackingMaterial, FilamentTrackingStage } from '../api/client';
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
import { trackingProductLabel } from '../utils/filamentTracking';
import { formatWeight } from '../utils/weight';

function stageLabel(stage: FilamentTrackingStage): string {
  if (stage === 'collecting') return 'Calibrating';
  if (stage === 'day') return 'Day stage';
  if (stage === 'week') return 'Week stage';
  return 'Month stage';
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

function rowLabel(row: Pick<FilamentTrackingMaterial, 'color_name' | 'material' | 'brand' | 'subtype'>): string {
  return trackingProductLabel(row);
}

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
    queryFn: () => api.getFilamentTrackingEvents(12),
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
      setPendingDelete(null);
      showToast(t('inventory.trackingStockRemoved', 'Stock removed'), 'success');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const plan = planQuery.data;
  const calibrating = plan?.stage === 'collecting';
  const events = eventsQuery.data ?? [];
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

      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3" aria-label="Filament overview">
        <Kpi
          label={t('inventory.trackingOnHand', 'On hand')}
          value={formatKg(plan?.total_on_hand_grams ?? 0)}
          sub={`${rows.filter((m) => m.stock_initialized).length} ${t('inventory.trackingColors', 'colors')}`}
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
                : stageLabel(plan?.stage ?? 'collecting')
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
      </section>

      <section className="bg-bambu-dark-secondary rounded-lg overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between border-b border-bambu-dark-tertiary">
          <div>
            <h2 className="text-white font-semibold">
              {t('inventory.trackingStockHeading', 'Color · material stock')}
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
              {stageLabel(plan.stage)} · {t('inventory.trackingDay', 'day')} {Math.max(plan.days_observed, 0)}
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
            <p className="text-white font-medium">{t('inventory.trackingEmpty', 'No color stock yet')}</p>
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

      <section className="bg-bambu-dark-secondary rounded-lg p-4">
        <h2 className="text-white font-semibold mb-1">{t('inventory.trackingRecent', 'Recent usage')}</h2>
        <p className="text-xs text-bambu-gray mb-3">
          {t('inventory.trackingRecentHint', 'Completed and failed prints feeding the average.')}
        </p>
        {events.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('inventory.trackingNoEvents', 'No usage recorded yet.')}</p>
        ) : (
          <ul className="space-y-2">
            {events.map((event) => (
              <li key={event.id} className="flex items-center gap-3 text-sm">
                <FilamentSwatch
                  rgba={swatchRgba(event.color_hex)}
                  extraColors={event.extra_colors}
                  effectType={event.effect_type}
                  subtype={event.subtype}
                  effectSize="table"
                />
                <span className="text-white min-w-0 truncate">
                  {trackingProductLabel(event)}
                  {event.print_name ? ` — ${event.print_name}` : ''}
                </span>
                <span className="text-bambu-gray ml-auto whitespace-nowrap">
                  {formatWeight(event.grams)}
                  {event.kind !== 'completed' && (
                    <span className="ml-2 text-amber-400">
                      {event.kind}
                      {event.progress != null ? ` · ${Math.round(event.progress)}%` : ''}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

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
            'Are you sure you want to delete {{name}}? This cannot be undone. Usage history for this color and material will also be removed.',
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
              <div className="text-xs text-amber-400">Set starting stock</div>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-white">
        <div>{row.stock_initialized ? formatKg(row.on_hand_grams) : '—'}</div>
        {row.stock_initialized && (
          <div className="text-xs text-bambu-gray">
            {formatSpoolCount(row.spool_equivalent)} spools
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
