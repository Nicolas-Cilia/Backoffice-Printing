import { useState, useMemo, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  Search,
  Trash2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  HardDrive,
  Droplet,
  Settings2,
  Layers,
  AlertCircle,
  FolderInput,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import type { LocalPreset, LocalPresetsResponse, ProfilePartSectionView } from '../api/client';
import { Card, CardContent } from './Card';
import { Button } from './Button';
import { ProcessSpecsModal } from './ProcessSpecsModal';
import { LocalPresetDownloadButton } from './LocalPresetDownloadButton';
import { ProfilePartSections, PROFILE_PARTS_KEY, type ProfilePartAttachFn } from './ProfilePartSections';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import {
  compactSpecItems,
  hasViewableSpecs,
  mergeProductionSpecs,
} from '../utils/productionSpecs';

const PRESET_SOURCE_LABEL_KEYS: Record<string, string> = {
  bambu: 'profiles.localProfiles.sourceLabels.bambu',
  orcaslicer: 'profiles.localProfiles.sourceLabels.orcaslicer',
  manual: 'profiles.localProfiles.sourceLabels.manual',
};

// Known material types for name-parsing fallback
const MATERIAL_TYPES = ['PLA', 'PETG', 'PCTG', 'ABS', 'ASA', 'TPU', 'PC', 'PA', 'PVA', 'HIPS', 'PP', 'PET', 'NYLON'];

const FILAMENT_TYPE_COLORS: Record<string, string> = {
  PLA: 'E8E8E8', PETG: '4A90D9', ABS: 'E67E22', ASA: 'D35400',
  TPU: '9B59B6', PC: 'BDC3C7', PA: '2ECC71', NYLON: '2ECC71',
  PVA: 'F1C40F', HIPS: '95A5A6', PP: 'ECF0F1', PET: '3498DB',
};

// Extract material type from preset name as fallback
function parseMaterialFromName(name: string): string | null {
  const upper = name.toUpperCase();
  for (const mat of MATERIAL_TYPES) {
    if (new RegExp(`\\b${mat}\\b`).test(upper)) return mat;
  }
  return null;
}

// Extract vendor from preset name (text before the material type)
function parseVendorFromName(name: string): string | null {
  // Strip printer/nozzle suffix first (e.g. "@BBL X1C")
  const clean = name.replace(/@.+$/, '').trim();
  const upper = clean.toUpperCase();
  for (const mat of MATERIAL_TYPES) {
    const idx = upper.indexOf(mat);
    if (idx > 0) {
      const vendor = clean.slice(0, idx).trim();
      // Skip if vendor looks like a generic prefix (e.g., "Generic", "Bambu")
      if (vendor && vendor.length > 1) return vendor;
    }
  }
  return null;
}

function PresetCard({
  preset,
  onDelete,
  onExpand,
  isExpanded,
  onMove,
}: {
  preset: LocalPreset;
  onDelete: (id: number) => void;
  onExpand: (id: number | null) => void;
  isExpanded: boolean;
  onMove?: (preset: LocalPreset) => void;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const [showSpecs, setShowSpecs] = useState(false);
  const isProcess = preset.preset_type === 'process';
  const specs = isProcess ? mergeProductionSpecs(preset.locked_parameters, null) : {};
  const canViewSpecs = isProcess && hasViewableSpecs(specs);
  const summary = canViewSpecs ? compactSpecItems(specs, t) : [];

  // Resolve material type: DB field → parse from name
  const material = preset.filament_type || parseMaterialFromName(preset.name);

  // Resolve vendor: DB field → parse from name
  const vendor = preset.filament_vendor || parseVendorFromName(preset.name);

  // Parse colour for swatch — try explicit colour, then fall back to material type
  let colourHex: string | null = null;
  let hasExplicitColour = false;
  if (preset.default_filament_colour) {
    try {
      const parsed = JSON.parse(preset.default_filament_colour);
      const raw = Array.isArray(parsed) ? parsed[0] : parsed;
      if (typeof raw === 'string' && /^#?[0-9a-fA-F]{6,8}$/.test(raw.replace('#', ''))) {
        colourHex = raw.replace('#', '').slice(0, 6);
        hasExplicitColour = true;
      }
    } catch {
      const raw = preset.default_filament_colour;
      if (/^#?[0-9a-fA-F]{6,8}$/.test(raw.replace('#', ''))) {
        colourHex = raw.replace('#', '').slice(0, 6);
        hasExplicitColour = true;
      }
    }
  }
  if (!colourHex && material) {
    colourHex = FILAMENT_TYPE_COLORS[material.toUpperCase()] || null;
  }

  return (
    <>
    <Card className="bg-bambu-dark border-bambu-dark-tertiary shadow-none [box-shadow:none] hover:border-bambu-dark-tertiary/80 transition-colors">
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {/* 1) Color dot — always shown for filament presets, dimmed if no explicit colour */}
              {preset.preset_type === 'filament' && (
                <div
                  className={`w-4 h-4 rounded-full border border-black/20 flex-shrink-0 ${
                    !hasExplicitColour && !colourHex ? 'opacity-25' : !hasExplicitColour ? 'opacity-50' : ''
                  }`}
                  style={{ backgroundColor: colourHex ? `#${colourHex}` : '#666' }}
                />
              )}
              <span className="text-sm font-medium text-white truncate">{preset.name}</span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* 2) Material tag — fallback to name parsing */}
              {material && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-bambu-green/20 text-bambu-green">
                  {material}
                </span>
              )}
              {/* 3) Vendor — fallback to name parsing */}
              {vendor && (
                <span className="text-xs text-bambu-gray">{vendor}</span>
              )}
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400">
                {t('profiles.localProfiles.badge')}
              </span>
            </div>

            {canViewSpecs && (
              <button
                type="button"
                onClick={() => setShowSpecs(true)}
                className="mt-2 inline-flex items-start gap-0.5 text-left text-[11px] text-bambu-gray leading-snug hover:text-white transition-colors"
                data-testid="process-spec-summary"
                aria-haspopup="dialog"
                aria-expanded={showSpecs}
                aria-label={t('fileManager.production.specs.view')}
              >
                <span>{summary.length > 0 ? summary.join(' · ') : t('fileManager.production.specs.view')}</span>
                <ChevronRight className="w-3 h-3 opacity-80 flex-shrink-0 mt-0.5" aria-hidden />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {onMove && hasPermission('settings:update') && (
              <button
                type="button"
                onClick={() => onMove(preset)}
                className="p-1 text-bambu-gray hover:text-bambu-green transition-colors"
                title={t('profiles.localProfiles.partSections.moveToSection')}
                aria-label={t('profiles.localProfiles.partSections.moveToSection')}
                data-testid="move-unfiled-process"
              >
                <FolderInput className="w-3.5 h-3.5" />
              </button>
            )}
            <LocalPresetDownloadButton presetId={preset.id} />
            {hasPermission('settings:update') && (
              <button
                onClick={() => onDelete(preset.id)}
                className="p-1 text-bambu-gray hover:text-red-600 dark:hover:text-red-400 transition-colors"
                title={t('profiles.localProfiles.delete')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => onExpand(isExpanded ? null : preset.id)}
              className="p-1 text-bambu-gray hover:text-white transition-colors"
            >
              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* 5) Expanded detail — show meaningful fields, hide self-inherits */}
        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-bambu-dark-tertiary text-xs space-y-1.5">
            {material && (
              <div className="flex justify-between">
                <span className="text-bambu-gray">{t('profiles.localProfiles.filamentType')}</span>
                <span className="text-white">{material}</span>
              </div>
            )}
            {vendor && (
              <div className="flex justify-between">
                <span className="text-bambu-gray">{t('profiles.localProfiles.vendor')}</span>
                <span className="text-white">{vendor}</span>
              </div>
            )}
            {preset.nozzle_temp_min != null && preset.nozzle_temp_max != null && (
              <div className="flex justify-between">
                <span className="text-bambu-gray">{t('profiles.localProfiles.nozzleTemp')}</span>
                <span className="text-white">{preset.nozzle_temp_min}–{preset.nozzle_temp_max}°C</span>
              </div>
            )}
            {preset.filament_cost && (
              <div className="flex justify-between">
                <span className="text-bambu-gray">{t('profiles.localProfiles.cost')}</span>
                <span className="text-white">{preset.filament_cost}</span>
              </div>
            )}
            {preset.filament_density && (
              <div className="flex justify-between">
                <span className="text-bambu-gray">{t('profiles.localProfiles.density')}</span>
                <span className="text-white">{preset.filament_density} g/cm³</span>
              </div>
            )}
            {preset.pressure_advance && (
              <div className="flex justify-between">
                <span className="text-bambu-gray">{t('profiles.localProfiles.pressureAdvance')}</span>
                <span className="text-white">{preset.pressure_advance}</span>
              </div>
            )}
            {preset.compatible_printers && (
              <div className="flex justify-between">
                <span className="text-bambu-gray">{t('profiles.localProfiles.compatiblePrinters')}</span>
                <span className="text-white truncate ml-2">
                  {(() => { try { return JSON.parse(preset.compatible_printers).join(', '); } catch { return preset.compatible_printers; } })()}
                </span>
              </div>
            )}
            {/* Only show inherits if different from own name */}
            {preset.inherits && preset.inherits !== preset.name && (
              <div className="flex justify-between">
                <span className="text-bambu-gray">{t('profiles.localProfiles.inheritsFrom')}</span>
                <span className="text-white truncate ml-2">{preset.inherits}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-bambu-gray">{t('profiles.localProfiles.source')}</span>
              <span className="text-white" data-testid="preset-source">
                {PRESET_SOURCE_LABEL_KEYS[preset.source]
                  ? t(PRESET_SOURCE_LABEL_KEYS[preset.source])
                  : preset.source}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
    {showSpecs && canViewSpecs && (
      <ProcessSpecsModal
        title={preset.name}
        specs={specs}
        onClose={() => setShowSpecs(false)}
      />
    )}
    </>
  );
}

export function LocalProfilesView() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [processesOpen, setProcessesOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [movingPreset, setMovingPreset] = useState<LocalPreset | null>(null);
  const attachRef = useRef<ProfilePartAttachFn | null>(null);

  const { data: presets, isLoading } = useQuery({
    queryKey: ['localPresets'],
    queryFn: () => api.getLocalPresets(),
  });

  const { data: partSections = [] } = useQuery({
    queryKey: PROFILE_PARTS_KEY,
    queryFn: () => api.getProfilePartSections(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteLocalPreset(id),
    onSuccess: (_, id) => {
      // Optimistically drop the row from the cached list so the rendered table
      // updates the instant the DELETE returns. Without this the row stays
      // visible until invalidateQueries' background refetch completes, and a
      // quick re-click on the same row opens a second delete-confirm modal
      // that resolves to a 404 (server already deleted it). The cache holds a
      // grouped response (filament / printer / process), not a flat list.
      queryClient.setQueryData<LocalPresetsResponse>(['localPresets'], (old) => {
        if (!old) return old;
        return {
          filament: old.filament.filter((p) => p.id !== id),
          printer: old.printer.filter((p) => p.id !== id),
          process: old.process.filter((p) => p.id !== id),
        };
      });
      queryClient.invalidateQueries({ queryKey: ['localPresets'] });
      // Match the import path: the SliceModal's `slicerPresets` query needs
      // to be invalidated too, otherwise the deleted preset keeps appearing
      // in the slice dropdown until its 60s staleTime expires plus a
      // refocus / remount (#1581).
      queryClient.invalidateQueries({ queryKey: ['slicerPresets'] });
      setDeleteConfirm(null);
      showToast(t('profiles.localProfiles.toast.deleted'));
    },
  });

  const filterPresets = useCallback((list: LocalPreset[]) => {
    if (!searchQuery) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.filament_type?.toLowerCase().includes(q) ||
      p.filament_vendor?.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  const attachedPresetIds = useMemo(() => {
    const ids = new Set<number>();
    for (const section of partSections) {
      for (const slot of section.slots) {
        if (slot.preset?.id != null) ids.add(slot.preset.id);
      }
    }
    return ids;
  }, [partSections]);

  const filaments = useMemo(() => filterPresets(presets?.filament || []), [presets?.filament, filterPresets]);
  const printers = useMemo(() => filterPresets(presets?.printer || []), [presets?.printer, filterPresets]);
  const unfiledProcesses = useMemo(
    () => filterPresets((presets?.process || []).filter((preset) => !attachedPresetIds.has(preset.id))),
    [presets?.process, attachedPresetIds, filterPresets],
  );
  const totalCount = filaments.length + printers.length + unfiledProcesses.length;
  // Count of imported presets BEFORE the search filter — drives whether the
  // search bar shows at all. Gating the search bar on totalCount (post-filter)
  // made it vanish the moment a query matched nothing, leaving the user unable
  // to clear or edit their search without a page refresh (#1470).
  const hasAnyPresets =
    (presets?.filament?.length ?? 0) +
      (presets?.printer?.length ?? 0) +
      (presets?.process?.length ?? 0) >
    0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-bambu-green animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Search Bar */}
      {hasAnyPresets && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('profiles.localProfiles.search')}
            className="w-full pl-9 pr-4 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
          />
        </div>
      )}

      <ProfilePartSections attachRef={attachRef} />

      {/* No presets imported at all */}
      {!hasAnyPresets && !isLoading && (
        <div className="text-center py-12">
          <HardDrive className="w-12 h-12 text-bambu-gray mx-auto mb-3 opacity-50" />
          <p className="text-bambu-gray">{t('profiles.localProfiles.noPresets')}</p>
        </div>
      )}

      {/* Presets exist, but a typed search query matched none of the column lists.
          Do not treat “all processes are in part sections” (empty Unfiled) as a
          search miss when the box is empty. */}
      {hasAnyPresets && searchQuery.trim() !== '' && totalCount === 0 && !isLoading && (
        <div className="text-center py-12">
          <Search className="w-12 h-12 text-bambu-gray mx-auto mb-3 opacity-50" />
          <p className="text-bambu-gray">{t('profiles.localProfiles.noSearchResults')}</p>
        </div>
      )}

      {/* 3-Column Preset Lists */}
      {totalCount > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Filament Column */}
          {filaments.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Droplet className="w-4 h-4 text-bambu-green" />
                <h3 className="text-sm font-medium text-white">
                  {t('profiles.localProfiles.filament')}
                </h3>
                <span className="text-xs text-bambu-gray">({filaments.length})</span>
              </div>
              <div className="space-y-2">
                {filaments.map(p => (
                  <PresetCard
                    key={p.id}
                    preset={p}
                    onDelete={(id) => setDeleteConfirm(id)}
                    onExpand={setExpandedId}
                    isExpanded={expandedId === p.id}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Unfiled process column */}
          {unfiledProcesses.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setProcessesOpen((open) => !open)}
                className="flex items-center gap-2 mb-3 text-left w-full hover:opacity-90"
                aria-expanded={processesOpen}
                aria-label={processesOpen ? t('common.collapse') : t('common.expand')}
                data-testid="toggle-unfiled-processes"
              >
                <ChevronDown
                  className={`w-4 h-4 text-bambu-gray flex-shrink-0 transition-transform duration-300 ease-in-out ${
                    processesOpen ? 'rotate-0' : '-rotate-90'
                  }`}
                  aria-hidden
                />
                <Layers className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h3 className="text-sm font-medium text-white">
                  {t('profiles.localProfiles.process')}
                </h3>
                <span className="text-xs text-bambu-gray">({unfiledProcesses.length})</span>
              </button>
              <div
                className={`rounded-xl transition-[max-height,opacity] duration-300 ease-in-out ${
                  processesOpen
                    ? 'max-h-[4000px] opacity-100 overflow-visible'
                    : 'max-h-0 opacity-0 overflow-hidden'
                }`}
                data-testid="unfiled-processes-list"
                aria-hidden={!processesOpen}
              >
                <div className="space-y-2">
                  {unfiledProcesses.map(p => (
                    <PresetCard
                      key={p.id}
                      preset={p}
                      onDelete={(id) => setDeleteConfirm(id)}
                      onExpand={setExpandedId}
                      isExpanded={expandedId === p.id}
                      onMove={setMovingPreset}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Printer Column */}
          {printers.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Settings2 className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <h3 className="text-sm font-medium text-white">
                  {t('profiles.localProfiles.printer')}
                </h3>
                <span className="text-xs text-bambu-gray">({printers.length})</span>
              </div>
              <div className="space-y-2">
                {printers.map(p => (
                  <PresetCard
                    key={p.id}
                    preset={p}
                    onDelete={(id) => setDeleteConfirm(id)}
                    onExpand={setExpandedId}
                    isExpanded={expandedId === p.id}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {movingPreset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setMovingPreset(null)}
          role="presentation"
        >
          <div
            className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg w-full max-w-md max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="move-unfiled-title"
            data-testid="move-unfiled-section-picker"
          >
            <div className="flex items-center justify-between gap-3 p-4 border-b border-bambu-dark-tertiary">
              <h2 id="move-unfiled-title" className="text-sm font-semibold text-white">
                {t('profiles.localProfiles.partSections.pickSection')}
              </h2>
              <button
                type="button"
                onClick={() => setMovingPreset(null)}
                className="p-1 text-bambu-gray hover:text-white"
                aria-label={t('common.close')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 border-b border-bambu-dark-tertiary">
              <p className="text-xs text-bambu-gray">{t('profiles.localProfiles.partSections.incomingProcess')}</p>
              <p className="text-sm text-white font-medium truncate">{movingPreset.name}</p>
            </div>
            <div className="overflow-y-auto p-4 space-y-2">
              {partSections.length === 0 ? (
                <p className="text-sm text-bambu-gray">{t('profiles.localProfiles.partSections.noSectionsToMove')}</p>
              ) : (
                partSections.map((section: ProfilePartSectionView) => (
                  <button
                    key={section.id}
                    type="button"
                    className="w-full text-left bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 hover:border-bambu-green"
                    data-testid="move-unfiled-section-option"
                    onClick={() => {
                      const preset = movingPreset;
                      setMovingPreset(null);
                      attachRef.current?.(section.id, preset);
                    }}
                  >
                    <span className="text-sm text-white">{section.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg p-6 max-w-sm mx-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
              <h3 className="text-white font-medium">{t('profiles.localProfiles.deleteConfirmTitle')}</h3>
            </div>
            <p className="text-sm text-bambu-gray mb-4">{t('profiles.localProfiles.deleteConfirm')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDeleteConfirm(null)}>
                {t('profiles.localProfiles.cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => deleteMutation.mutate(deleteConfirm)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                {t('profiles.localProfiles.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
