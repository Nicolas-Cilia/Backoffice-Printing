import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle, Check, AlertTriangle, RefreshCw, ChevronDown, ChevronUp, Palette, X } from 'lucide-react';
import { api } from '../../api/client';
import type { AMSTray } from '../../api/client';
import { useFilamentMapping, type FilamentComparison, type LoadedFilament } from '../../hooks/useFilamentMapping';
import {
  filamentTypesCompatible,
  getGlobalTrayId,
  effectivePreferLowest,
  normalizeColor,
} from '../../utils/amsHelpers';
import { getColorName } from '../../utils/colors';
import { SpoolIcon } from '../spoolbuddy/SpoolIcon';
import { useFilamentLabels } from './useFilamentLabels';
import { buildAmsUnitViews, type AmsUnitView } from './amsUnitViews';
import type { FilamentMappingProps } from './types';

function unitMiniIcon(unit: AmsUnitView, selected: boolean) {
  const colors = unit.trays
    .map((t) => t.loaded?.color ?? (t.tray?.tray_color ? normalizeColor(t.tray.tray_color) : null))
    .filter(Boolean) as string[];
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded border transition-colors ${
        selected
          ? 'border-bambu-green bg-bambu-green/15 text-bambu-green'
          : 'border-bambu-gray/40 text-bambu-gray hover:border-bambu-gray hover:text-white'
      }`}
      title={unit.label}
    >
      {colors.length === 0 ? (
        <span className="text-[9px] font-semibold leading-none">
          {unit.isExternal ? 'Ext' : unit.label.replace(/^AMS-?/, '').replace(/^HT-/, 'H')}
        </span>
      ) : (
        <span className="grid grid-cols-2 gap-px p-0.5 w-full h-full">
          {(colors.length === 1 ? [colors[0], colors[0], colors[0], colors[0]] : colors.slice(0, 4)).map(
            (c, i) => (
              <span key={i} className="rounded-[1px]" style={{ backgroundColor: c }} />
            ),
          )}
        </span>
      )}
    </span>
  );
}

function spoolCaption(loaded: LoadedFilament | undefined, tray: AMSTray | null): string {
  if (loaded) {
    const type = loaded.traySubBrands || loaded.type;
    return `${loaded.colorName} ${type}`.trim();
  }
  if (tray?.tray_type) {
    const color = normalizeColor(tray.tray_color);
    return `${getColorName(color)} ${tray.tray_sub_brands || tray.tray_type}`.trim();
  }
  return '';
}

interface AmsSpoolGridProps {
  unit: AmsUnitView;
  selectedGlobalTrayId: number | null | undefined;
  highlightCompatibleType?: string;
  onSelect: (globalTrayId: number) => void;
  ftsExtruderForSlot: (globalTrayId: number) => number | null;
  ftsInstalled: boolean;
  trayRemainingWeightMap: Map<number, number | null>;
  leftNozzle: string;
  rightNozzle: string;
  remainingShort: (grams: number) => string;
}

function AmsSpoolGrid({
  unit,
  selectedGlobalTrayId,
  highlightCompatibleType,
  onSelect,
  ftsExtruderForSlot,
  ftsInstalled,
  trayRemainingWeightMap,
  leftNozzle,
  rightNozzle,
  remainingShort,
}: AmsSpoolGridProps) {
  const { t } = useTranslation();
  const cols = unit.isHt || unit.trays.length <= 1 ? 1 : Math.min(4, unit.trays.length);

  return (
    <div
      className={`grid gap-2 ${cols === 1 ? 'grid-cols-1 max-w-[5.5rem]' : 'grid-cols-2 sm:grid-cols-4'}`}
      data-testid="ams-spool-grid"
    >
      {unit.trays.map((slot) => {
        const loaded = slot.loaded;
        const isEmpty = !loaded && (!slot.tray?.tray_type || slot.tray.tray_type === '');
        const color = loaded?.color ?? (slot.tray?.tray_color ? normalizeColor(slot.tray.tray_color) : '#808080');
        const globalTrayId = loaded
          ? loaded.globalTrayId
          : unit.isExternal
            ? (slot.tray?.id ?? 254)
            : getGlobalTrayId(unit.amsId, slot.trayId, false);
        const selected = selectedGlobalTrayId === globalTrayId;
        const typeOk =
          !highlightCompatibleType ||
          isEmpty ||
          filamentTypesCompatible(loaded?.type ?? slot.tray?.tray_type, highlightCompatibleType);
        const caption = spoolCaption(loaded, slot.tray);
        const remainingWeight = loaded ? trayRemainingWeightMap.get(loaded.globalTrayId) : null;
        const ftsTarget = ftsInstalled && loaded ? ftsExtruderForSlot(loaded.globalTrayId) : null;
        const ftsBadge =
          ftsTarget == null ? '' : ` [${ftsTarget === 1 ? leftNozzle : rightNozzle}]`;

        return (
          <button
            key={`${unit.key}-${slot.trayId}`}
            type="button"
            disabled={isEmpty}
            onClick={() => {
              if (!isEmpty) onSelect(globalTrayId);
            }}
            className={`relative flex flex-col items-center gap-1 rounded-lg p-1.5 text-center transition-all ${
              isEmpty
                ? 'cursor-default opacity-40'
                : typeOk
                  ? 'hover:bg-white/5 cursor-pointer'
                  : 'opacity-35 hover:opacity-55 cursor-pointer'
            } ${selected ? 'ring-2 ring-bambu-green bg-bambu-green/10' : 'ring-1 ring-transparent'}`}
            title={
              isEmpty
                ? t('printModal.emptySlot', 'Empty')
                : `${caption}${remainingWeight != null ? remainingShort(remainingWeight) : ''}${ftsBadge}`
            }
            aria-label={
              isEmpty
                ? t('printModal.emptySlot', 'Empty')
                : `#${slot.slotNumber} ${caption}${ftsBadge}`
            }
            aria-pressed={selected}
          >
            <span className="absolute top-0.5 left-1 text-[9px] text-bambu-gray/80 font-medium">
              #{slot.slotNumber}
            </span>
            {ftsBadge && (
              <span className="absolute top-0.5 right-1 text-[8px] font-bold text-bambu-green leading-none">
                {ftsBadge.trim()}
              </span>
            )}
            <SpoolIcon color={isEmpty ? '#666' : color} isEmpty={isEmpty} size={40} />
            <span className="text-[10px] leading-tight text-white/80 line-clamp-2 w-full min-h-[1.5rem]">
              {isEmpty ? t('printModal.emptySlot', 'Empty') : caption || loaded?.type || '—'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Filament mapping UI for comparing required filaments with loaded AMS slots.
 * SimplyPrint-style visual AMS spool picker (Bambuddy tokens).
 */
export function FilamentMapping({
  printerId,
  filamentReqs,
  manualMappings,
  onManualMappingChange,
  currencySymbol,
  defaultCostPerKg,
  defaultExpanded = false,
  forceColorMatch,
  onForceColorMatchChange,
  plateLabel,
  archiveAmsMapping,
}: FilamentMappingProps & { defaultExpanded?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [activeUnitKey, setActiveUnitKey] = useState<string | null>(null);
  const [pickingSlotId, setPickingSlotId] = useState<number | null>(null);
  const [usingArchiveMapping, setUsingArchiveMapping] = useState(false);
  const appliedSlotIdsRef = useRef<number[]>([]);

  useEffect(() => {
    setUsingArchiveMapping(false);
    appliedSlotIdsRef.current = [];
    setPickingSlotId(null);
  }, [archiveAmsMapping, plateLabel, printerId]);

  const toggleArchiveMapping = () => {
    if (!archiveAmsMapping || !filamentReqs?.filaments) return;
    if (usingArchiveMapping) {
      const next = { ...manualMappings };
      for (const slotId of appliedSlotIdsRef.current) {
        delete next[slotId];
      }
      onManualMappingChange(next);
      appliedSlotIdsRef.current = [];
      setUsingArchiveMapping(false);
      return;
    }
    const next = { ...manualMappings };
    const appliedSlotIds: number[] = [];
    for (const req of filamentReqs.filaments) {
      const idx = req.slot_id - 1;
      if (req.slot_id > 0 && idx >= 0 && idx < archiveAmsMapping.length && archiveAmsMapping[idx] >= 0) {
        next[req.slot_id] = archiveAmsMapping[idx];
        appliedSlotIds.push(req.slot_id);
      }
    }
    onManualMappingChange(next);
    appliedSlotIdsRef.current = appliedSlotIds;
    setUsingArchiveMapping(true);
  };

  const { data: printerStatus } = useQuery({
    queryKey: ['printer-status', printerId],
    queryFn: () => api.getPrinterStatus(printerId),
    enabled: !!printerId,
  });
  const { data: assignments } = useQuery({
    queryKey: ['spool-assignments', printerId],
    queryFn: () => api.getAssignments(printerId),
    enabled: !!printerId,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });
  const { data: inventoryRemain } = useQuery({
    queryKey: ['printer-inventory-remain', printerId],
    queryFn: () => api.getInventoryRemain(printerId),
    enabled: !!printerId,
    staleTime: 30 * 1000,
  });
  const inventoryByTrayId = useMemo(() => {
    if (!inventoryRemain?.inventory_remain_g) return undefined;
    const map = new Map<number, number>();
    Object.entries(inventoryRemain.inventory_remain_g).forEach(([key, grams]) => {
      const gtid = Number(key);
      if (!Number.isNaN(gtid)) map.set(gtid, grams);
    });
    return map;
  }, [inventoryRemain]);
  const gatedPreferLowest = effectivePreferLowest(
    settings?.prefer_lowest_filament,
    printerStatus?.ams_filament_backup,
  );

  const { loadedFilaments, filamentComparison, hasTypeMismatch, hasColorMismatch } =
    useFilamentMapping(filamentReqs, printerStatus, manualMappings, gatedPreferLowest, inventoryByTrayId);

  const filamentLabels = useFilamentLabels(filamentReqs?.filaments);

  const trayCostMap = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const assignment of assignments || []) {
      const isExternal = assignment.ams_id === 255;
      const globalTrayId = getGlobalTrayId(assignment.ams_id, assignment.tray_id, isExternal);
      map.set(globalTrayId, assignment.spool?.cost_per_kg ?? null);
    }
    return map;
  }, [assignments]);

  const trayRemainingWeightMap = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const assignment of assignments || []) {
      const isExternal = assignment.ams_id === 255;
      const globalTrayId = getGlobalTrayId(assignment.ams_id, assignment.tray_id, isExternal);
      const spool = assignment.spool;
      if (!spool) {
        map.set(globalTrayId, null);
        continue;
      }
      map.set(globalTrayId, Math.max(0, Math.round((spool.label_weight ?? 0) - (spool.weight_used ?? 0))));
    }
    return map;
  }, [assignments]);

  const totalCost = useMemo(() => {
    let total = 0;
    for (const item of filamentComparison) {
      const trayId = item.loaded?.globalTrayId;
      if (trayId == null) continue;
      const assignedCost = trayCostMap.get(trayId) ?? null;
      const costPerKg = assignedCost ?? defaultCostPerKg;
      if (costPerKg > 0) {
        total += (item.used_grams / 1000) * costPerKg;
      }
    }
    return total;
  }, [filamentComparison, trayCostMap, defaultCostPerKg]);

  const hasAnyCost = useMemo(
    () => Array.from(trayCostMap.values()).some((v) => v != null && v > 0),
    [trayCostMap],
  );
  const hasFilamentReqs = filamentReqs?.filaments && filamentReqs.filaments.length > 0;
  const isDualNozzle = filamentReqs?.filaments?.some((f) => f.nozzle_id != null) ?? false;
  const isMultiMaterial = (filamentReqs?.filaments?.length ?? 0) > 1;
  const mappingIncomplete = filamentComparison.some((item) => !item.loaded);

  const amsUnits = useMemo(
    () => (printerStatus ? buildAmsUnitViews(printerStatus, loadedFilaments) : []),
    [printerStatus, loadedFilaments],
  );

  useEffect(() => {
    if (amsUnits.length === 0) {
      setActiveUnitKey(null);
      return;
    }
    setActiveUnitKey((prev) => {
      if (prev && amsUnits.some((u) => u.key === prev)) return prev;
      return amsUnits[0].key;
    });
  }, [amsUnits]);

  // Clear picker when the slot no longer exists (plate/reqs change).
  useEffect(() => {
    if (pickingSlotId == null) return;
    const stillPresent = filamentComparison.some((i) => i.slot_id === pickingSlotId);
    if (!stillPresent) setPickingSlotId(null);
  }, [pickingSlotId, filamentComparison]);

  const activeUnit = amsUnits.find((u) => u.key === activeUnitKey) ?? amsUnits[0];

  const ftsInstalled = printerStatus?.fila_switch?.installed === true;
  const ftsExtruderForSlot = (globalTrayId: number): number | null => {
    const fs = printerStatus?.fila_switch;
    if (!fs?.installed) return null;
    const track = fs.in_slots.indexOf(globalTrayId);
    if (track < 0) return null;
    return fs.out_extruders[track] ?? null;
  };

  if (!hasFilamentReqs || !printerStatus) {
    return null;
  }

  const statusColor = hasTypeMismatch
    ? '#f97316'
    : hasColorMismatch
      ? '#facc15'
      : '#00ae42';

  const handleSlotPick = (fileSlotId: number, globalTrayId: number) => {
    if (fileSlotId <= 0) return;
    onManualMappingChange({
      ...manualMappings,
      [fileSlotId]: globalTrayId,
    });
    if (isMultiMaterial) {
      setPickingSlotId(null);
    }
  };

  const handleClearManual = (fileSlotId: number) => {
    if (fileSlotId <= 0) return;
    const next = { ...manualMappings };
    delete next[fileSlotId];
    onManualMappingChange(next);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await api.refreshPrinterStatus(printerId);
      await new Promise((r) => setTimeout(r, 500));
      await queryClient.refetchQueries({ queryKey: ['printer-status', printerId] });
    } finally {
      setIsRefreshing(false);
    }
  };

  const leftNozzle = t('printModal.leftNozzle');
  const rightNozzle = t('printModal.rightNozzle');
  const remainingShort = (grams: number) =>
    t('printModal.slotRemainingShort', {
      grams,
      defaultValue: ` - ${grams}g left`,
    });

  const pickingItem: FilamentComparison | undefined =
    pickingSlotId != null ? filamentComparison.find((i) => i.slot_id === pickingSlotId) : undefined;
  const pickingIndex =
    pickingSlotId != null ? filamentComparison.findIndex((i) => i.slot_id === pickingSlotId) : -1;

  const renderUnitSwitcher = () => {
    if (amsUnits.length <= 1) return null;
    return (
      <div className="flex items-center gap-1.5 flex-wrap" data-testid="ams-unit-switcher">
        {amsUnits.map((unit) => (
          <button
            key={unit.key}
            type="button"
            onClick={() => setActiveUnitKey(unit.key)}
            className="rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-bambu-green"
            aria-pressed={unit.key === activeUnit?.key}
            aria-label={unit.label}
          >
            {unitMiniIcon(unit, unit.key === activeUnit?.key)}
          </button>
        ))}
      </div>
    );
  };

  const renderSpoolPicker = (
    targetSlotId: number,
    selectedGlobalTrayId: number | null | undefined,
    compatibleType?: string,
  ) => {
    if (!activeUnit) {
      return (
        <p className="text-xs text-bambu-gray">
          {t('printModal.noAmsSlots', 'No AMS or external spools reported by this printer.')}
        </p>
      );
    }
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-bambu-gray font-medium">{activeUnit.label}</span>
          {renderUnitSwitcher()}
        </div>
        <AmsSpoolGrid
          unit={activeUnit}
          selectedGlobalTrayId={selectedGlobalTrayId}
          highlightCompatibleType={compatibleType}
          onSelect={(gtid) => handleSlotPick(targetSlotId, gtid)}
          ftsExtruderForSlot={ftsExtruderForSlot}
          ftsInstalled={ftsInstalled}
          trayRemainingWeightMap={trayRemainingWeightMap}
          leftNozzle={leftNozzle}
          rightNozzle={rightNozzle}
          remainingShort={remainingShort}
        />
        {manualMappings[targetSlotId] !== undefined && (
          <button
            type="button"
            onClick={() => handleClearManual(targetSlotId)}
            className="text-[11px] text-bambu-gray hover:text-white underline-offset-2 hover:underline"
          >
            {t('printModal.useAutoMatch', 'Use auto-match')}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-sm text-bambu-gray hover:text-white transition-colors w-full"
      >
        <Circle className="w-4 h-4" fill={statusColor} stroke="none" />
        <span>
          {plateLabel
            ? `${t('printModal.filamentMapping')} — ${plateLabel}`
            : t('printModal.filamentMapping')}
        </span>
        {hasTypeMismatch ? (
          <span className="text-xs text-orange-700 dark:text-orange-400">(Type not found)</span>
        ) : hasColorMismatch ? (
          <span className="text-xs text-yellow-700 dark:text-yellow-400">(Color mismatch)</span>
        ) : (
          <span className="text-xs text-bambu-green">(Ready)</span>
        )}
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 ml-auto" />
        ) : (
          <ChevronDown className="w-4 h-4 ml-auto" />
        )}
      </button>

      {isExpanded && (
        <div className="mt-2 bg-bambu-dark rounded-lg p-3 space-y-3 relative">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-bambu-gray">
              {isMultiMaterial
                ? t('printModal.clickMaterialToMap', 'Click a material to choose AMS slot')
                : t('printModal.clickToChangeSlot')}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {archiveAmsMapping && (
                <button
                  type="button"
                  onClick={toggleArchiveMapping}
                  title={t('printModal.useArchiveMappingTooltip')}
                  className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded border transition-colors ${
                    usingArchiveMapping
                      ? 'border-bambu-green bg-bambu-green/10 text-bambu-green'
                      : 'border-bambu-gray/30 hover:border-bambu-gray hover:bg-bambu-dark-tertiary text-bambu-gray hover:text-white'
                  }`}
                >
                  <Check className="w-3 h-3" />
                  <span>{t('printModal.useArchiveMapping')}</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleRefresh}
                className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-bambu-gray/30 hover:border-bambu-gray hover:bg-bambu-dark-tertiary transition-colors text-bambu-gray hover:text-white"
                disabled={isRefreshing}
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                <span>{t('printModal.reRead')}</span>
              </button>
            </div>
          </div>

          {/* Multi-material mapping summary chips */}
          {isMultiMaterial && (
            <div className="flex flex-wrap gap-2" data-testid="filament-mapping-summary">
              {filamentComparison.map((item, idx) => {
                const { resolvedName, colorLabel } = filamentLabels[idx] ?? {
                  resolvedName: item.type,
                  colorLabel: getColorName(item.color),
                };
                const mapped = item.loaded;
                const incomplete = !mapped;
                return (
                  <button
                    key={item.slot_id ?? idx}
                    type="button"
                    onClick={() => setPickingSlotId(item.slot_id)}
                    className={`flex flex-col items-center gap-0.5 rounded-md px-1.5 py-1 min-w-[3.25rem] border transition-colors ${
                      pickingSlotId === item.slot_id
                        ? 'border-bambu-green bg-bambu-green/10'
                        : incomplete
                          ? 'border-orange-500/50 bg-orange-500/5'
                          : 'border-bambu-gray/30 hover:border-bambu-gray'
                    }`}
                    title={t('printModal.chooseMaterialSlot', 'Choose which extruder/color to use for Material {{n}}', {
                      n: idx + 1,
                    })}
                    aria-label={`${resolvedName} ${colorLabel}`}
                  >
                    <span
                      className="w-7 h-7 rounded-sm border border-white/20"
                      style={{ backgroundColor: item.color || '#808080' }}
                    />
                    <span className="text-[10px] text-white truncate max-w-[4.5rem]" title={resolvedName}>
                      {item.type}
                    </span>
                    <span
                      className={`text-[10px] font-medium ${
                        incomplete ? 'text-orange-400' : 'text-bambu-green'
                      }`}
                    >
                      {mapped
                        ? mapped.label
                        : t('printModal.unmappedSlot', '—')}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {mappingIncomplete && (
            <p className="text-xs text-orange-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {t('printModal.mustMapMaterials', 'Must select/map materials')}
            </p>
          )}

          {/* Single-material: required row + inline AMS grid */}
          {!isMultiMaterial &&
            filamentComparison.map((item, idx) => {
              const slotId = item.slot_id ?? 0;
              const canForceMatch = slotId > 0 && onForceColorMatchChange != null;
              const { resolvedName, colorLabel } = filamentLabels[idx] ?? {
                resolvedName: item.type,
                colorLabel: getColorName(item.color),
              };
              return (
                <div key={idx} className="space-y-2">
                  <div className="flex items-center gap-2 text-xs min-w-0">
                    <span title={`Required: ${resolvedName} - ${colorLabel}`}>
                      <Circle className="w-3 h-3" fill={item.color} stroke={item.color} />
                    </span>
                    <span className="text-white flex items-center gap-1 min-w-0 flex-1">
                      {isDualNozzle && item.nozzle_id != null && (
                        <span
                          className="inline-flex items-center justify-center w-3.5 h-3.5 rounded text-[9px] font-bold leading-none bg-bambu-gray/20 text-bambu-gray shrink-0"
                          title={
                            item.nozzle_id === 1
                              ? t('printModal.leftNozzleTooltip')
                              : t('printModal.rightNozzleTooltip')
                          }
                        >
                          {item.nozzle_id === 1 ? leftNozzle : rightNozzle}
                        </span>
                      )}
                      <span className="truncate min-w-0" title={resolvedName}>
                        {resolvedName}
                      </span>
                      <span className="text-bambu-gray shrink-0 whitespace-nowrap">
                        ({item.used_grams}g)
                      </span>
                    </span>
                    {item.status === 'match' ? (
                      <Check className="w-3 h-3 text-bambu-green shrink-0" />
                    ) : item.status === 'type_only' ? (
                      <span title="Same type, different color">
                        <AlertTriangle className="w-3 h-3 text-yellow-600 dark:text-yellow-400 shrink-0" />
                      </span>
                    ) : (
                      <span title="Filament type not loaded">
                        <AlertTriangle className="w-3 h-3 text-orange-600 dark:text-orange-400 shrink-0" />
                      </span>
                    )}
                  </div>
                  {renderSpoolPicker(slotId, item.loaded?.globalTrayId, item.type)}
                  {canForceMatch && (
                    <label className="inline-flex items-center gap-1.5 text-xs text-bambu-gray cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={forceColorMatch?.[slotId] ?? false}
                        onChange={(e) => onForceColorMatchChange(slotId, e.target.checked)}
                        className="accent-bambu-green w-3 h-3"
                      />
                      <Palette className="w-3 h-3" />
                      {t('printModal.forceColorMatch')}
                    </label>
                  )}
                </div>
              );
            })}

          {/* Multi-material: AMS picker when a chip is active */}
          {isMultiMaterial && pickingItem && pickingSlotId != null && (
            <div
              className="rounded-lg border border-bambu-gray/40 bg-bambu-dark-secondary p-3 space-y-2 shadow-lg"
              data-testid="ams-material-picker"
              role="dialog"
              aria-label={t(
                'printModal.chooseMaterialSlot',
                'Choose which extruder/color to use for Material {{n}}',
                { n: pickingIndex + 1 },
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-white">
                    {t(
                      'printModal.chooseMaterialSlot',
                      'Choose which extruder/color to use for Material {{n}}',
                      { n: pickingIndex + 1 },
                    )}
                  </p>
                  <p className="text-[11px] text-bambu-gray truncate mt-0.5">
                    {(filamentLabels[pickingIndex]?.resolvedName ?? pickingItem.type) +
                      ' · ' +
                      (filamentLabels[pickingIndex]?.colorLabel ?? getColorName(pickingItem.color))}
                    {isDualNozzle && pickingItem.nozzle_id != null && (
                      <> · {pickingItem.nozzle_id === 1 ? leftNozzle : rightNozzle}</>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPickingSlotId(null)}
                  className="text-bambu-gray hover:text-white p-0.5"
                  aria-label={t('common.close', 'Close')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {renderSpoolPicker(pickingSlotId, pickingItem.loaded?.globalTrayId, pickingItem.type)}
              {onForceColorMatchChange != null && pickingSlotId > 0 && (
                <label className="inline-flex items-center gap-1.5 text-xs text-bambu-gray cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={forceColorMatch?.[pickingSlotId] ?? false}
                    onChange={(e) => onForceColorMatchChange(pickingSlotId, e.target.checked)}
                    className="accent-bambu-green w-3 h-3"
                  />
                  <Palette className="w-3 h-3" />
                  {t('printModal.forceColorMatch')}
                </label>
              )}
            </div>
          )}

          {/* Multi-material closed: compact read-only AMS layout for context */}
          {isMultiMaterial && pickingSlotId == null && activeUnit && (
            <div className="space-y-2 pt-1 border-t border-bambu-gray/20">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-bambu-gray font-medium">{activeUnit.label}</span>
                {renderUnitSwitcher()}
              </div>
              <div
                className={`grid gap-2 pointer-events-none ${
                  activeUnit.isHt || activeUnit.trays.length <= 1
                    ? 'grid-cols-1 max-w-[5.5rem]'
                    : 'grid-cols-2 sm:grid-cols-4'
                }`}
                data-testid="ams-spool-overview"
                aria-hidden
              >
                {activeUnit.trays.map((slot) => {
                  const loaded = slot.loaded;
                  const isEmpty = !loaded && (!slot.tray?.tray_type || slot.tray.tray_type === '');
                  const color =
                    loaded?.color ??
                    (slot.tray?.tray_color ? normalizeColor(slot.tray.tray_color) : '#808080');
                  const caption = spoolCaption(loaded, slot.tray);
                  const mappedHere =
                    loaded != null &&
                    filamentComparison.some(
                      (item) => item.loaded?.globalTrayId === loaded.globalTrayId,
                    );
                  return (
                    <div
                      key={`${activeUnit.key}-ov-${slot.trayId}`}
                      className={`flex flex-col items-center gap-1 rounded-lg p-1.5 ${
                        mappedHere ? 'ring-1 ring-bambu-green/60' : ''
                      } ${isEmpty ? 'opacity-40' : ''}`}
                    >
                      <SpoolIcon color={isEmpty ? '#666' : color} isEmpty={isEmpty} size={36} />
                      <span className="text-[9px] text-bambu-gray">#{slot.slotNumber}</span>
                      <span className="text-[10px] leading-tight text-white/70 line-clamp-2 w-full text-center">
                        {isEmpty ? t('printModal.emptySlot', 'Empty') : caption}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="text-xs text-bambu-gray">
            {t('printModal.totalCost')}{' '}
            <span className="text-white">
              {totalCost > 0 || hasAnyCost ? `${currencySymbol}${totalCost.toFixed(2)}` : 'N/A'}
            </span>
          </div>
          {hasTypeMismatch && (
            <p className="text-xs text-orange-700 dark:text-orange-400">
              Required filament type not found in printer.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
