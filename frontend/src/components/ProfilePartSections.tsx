import { useCallback, useEffect, useState, type MutableRefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Layers, Loader2, Plus, Trash2, Upload, X } from 'lucide-react';
import { ApiError, api } from '../api/client';
import type { LocalPreset, ProfilePartReplacePreview, ProfilePartSectionView, ProfilePartSlotView } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { compactSpecItems, hasViewableSpecs, mergeProductionSpecs } from '../utils/productionSpecs';
import { Button } from './Button';
import { LocalPresetDownloadButton } from './LocalPresetDownloadButton';
import { ProcessSpecsModal } from './ProcessSpecsModal';
import { ProductionParameterDiffTable } from './production/ProductionParameterDiffTable';

export const PROFILE_PARTS_KEY = ['profilePartSections'] as const;

export type ProfilePartAttachFn = (sectionId: number, preset: LocalPreset) => void;
const PROCESS_FILE_ACCEPT = '.json,.zip,.orca_filament,.bbscfg,.bbsflmt';

type ReplacePresetRef = { id: number; name: string };

function printerLabel(preset: LocalPreset, t: (key: string) => string): string {
  const cleaned = preset.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const bbl = cleaned.match(/@BBL\s+(.+?)(?:\s+[\d.]+\s*nozzle)?$/i);
  if (bbl?.[1]) return bbl[1].trim();
  const longForm = cleaned.match(/@Bambu Lab\s+(.+?)(?:\s+[\d.]+\s*nozzle)?$/i);
  if (longForm?.[1]) return longForm[1].trim();
  return t('profiles.localProfiles.partSections.unknownPrinter');
}

function displayPrinter(code: string, t: (key: string) => string): string {
  return code.startsWith('unknown:') ? t('profiles.localProfiles.partSections.unknownPrinter') : code;
}

function NamePromptModal({
  title,
  placeholder,
  confirmLabel,
  submitting,
  onClose,
  onSubmit,
}: {
  title: string;
  placeholder: string;
  confirmLabel: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (name: string, options: { parameter_tracking: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [trackParameters, setTrackParameters] = useState(true);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="presentation">
      <div
        className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg w-full max-w-sm p-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="part-section-name-title"
      >
        <h2 id="part-section-name-title" className="text-sm font-semibold text-white mb-3">{title}</h2>
        <label className="block text-sm">
          <span className="text-bambu-gray">{t('profiles.localProfiles.partSections.sectionName')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
            autoFocus
            className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
          />
        </label>
        <label className="flex items-start gap-2 mt-3 cursor-pointer">
          <input
            type="checkbox"
            checked={trackParameters}
            onChange={(e) => setTrackParameters(e.target.checked)}
            className="mt-0.5 rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
            data-testid="track-parameters"
          />
          <span>
            <span className="block text-sm text-white">{t('profiles.localProfiles.partSections.trackParameters')}</span>
            <span className="block text-xs text-bambu-gray mt-0.5">
              {t('profiles.localProfiles.partSections.trackParametersHelp')}
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2 mt-4">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t('profiles.localProfiles.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!name.trim() || submitting}
            onClick={() => onSubmit(name.trim(), { parameter_tracking: trackParameters })}
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReplaceProcessModal({
  slot,
  preset,
  preview,
  previewing,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  slot: ProfilePartSlotView;
  preset: ReplacePresetRef;
  preview: ProfilePartReplacePreview | null;
  previewing: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (resolution: 'proceed' | 'accept_baseline') => void;
}) {
  const { t } = useTranslation();
  const mismatchCount = preview?.parameter_diff.filter((row) => !row.match).length ?? 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-2xl border border-bambu-dark-tertiary max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{t('profiles.localProfiles.partSections.replaceTitle')}</h2>
          <button type="button" onClick={onClose} disabled={submitting} className="text-bambu-gray hover:text-white p-1 rounded" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-sm">
            <p className="text-bambu-gray">{t('profiles.localProfiles.partSections.incomingProcess')}</p>
            <p className="text-white font-medium">{preset.name}</p>
            <p className="text-xs text-bambu-gray mt-1">{displayPrinter(slot.printer_model, t)}</p>
          </div>
          {previewing && (
            <div className="flex items-center gap-2 text-sm text-bambu-gray">
              <Loader2 className="w-4 h-4 animate-spin text-bambu-green" />
              {t('fileManager.production.previewing')}
            </div>
          )}
          {preview && (
            <>
              {preview.has_mismatches && (
                <p className="text-sm text-amber-500">{t('fileManager.production.mismatchCount', { count: mismatchCount })}</p>
              )}
              <ProductionParameterDiffTable rows={preview.parameter_diff} />
            </>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              {t('fileManager.production.cancel')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onSubmit('proceed')}
              disabled={!preview || submitting}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.production.proceedAnyway')}
            </Button>
            <Button type="button" onClick={() => onSubmit('accept_baseline')} disabled={!preview || submitting}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.production.acceptBaseline')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfirmAttachModal({
  preset,
  printerModel,
  preview,
  submitting,
  cancelLabel,
  onClose,
  onProceed,
}: {
  preset: ReplacePresetRef;
  printerModel: string;
  preview: ProfilePartReplacePreview;
  submitting: boolean;
  cancelLabel?: string;
  onClose: () => void;
  onProceed: () => void;
}) {
  const { t } = useTranslation();
  const mismatchCount = preview.parameter_diff.filter((row) => !row.match).length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation">
      <div
        className="bg-bambu-dark-secondary rounded-lg w-full max-w-2xl border border-bambu-dark-tertiary max-h-[90vh] overflow-y-auto"
        data-testid="confirm-attach-modal"
      >
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{t('profiles.localProfiles.partSections.confirmAttachTitle')}</h2>
          <button type="button" onClick={onClose} disabled={submitting} className="text-bambu-gray hover:text-white p-1 rounded" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-sm">
            <p className="text-bambu-gray">{t('profiles.localProfiles.partSections.incomingProcess')}</p>
            <p className="text-white font-medium">{preset.name}</p>
            <p className="text-xs text-bambu-gray mt-1">{displayPrinter(printerModel, t)}</p>
          </div>
          {preview.has_mismatches && (
            <p className="text-sm text-amber-500">{t('fileManager.production.mismatchCount', { count: mismatchCount })}</p>
          )}
          <ProductionParameterDiffTable rows={preview.parameter_diff} />
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting} data-testid="confirm-attach-cancel">
              {cancelLabel ?? t('profiles.localProfiles.partSections.dontUpload')}
            </Button>
            <Button type="button" onClick={onProceed} disabled={submitting} data-testid="confirm-attach-proceed">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('fileManager.production.proceedAnyway')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SlotMismatchModal({
  title,
  rows,
  onClose,
}: {
  title: string;
  rows: ProfilePartSlotView['parameter_diff'];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const mismatchCount = rows.filter((row) => !row.match).length;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="slot-mismatch-title"
        data-testid="slot-mismatch-modal"
      >
        <div className="flex items-center justify-between gap-3 p-4 border-b border-bambu-dark-tertiary">
          <div className="min-w-0">
            <h2 id="slot-mismatch-title" className="text-sm font-semibold text-white truncate">
              {t('fileManager.production.lastReplaceMismatched')}
              {title ? <span className="text-bambu-gray font-normal"> · {title}</span> : null}
            </h2>
            {mismatchCount > 0 && (
              <p className="text-xs text-amber-500 mt-1">{t('fileManager.production.mismatchCount', { count: mismatchCount })}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-bambu-dark-tertiary text-bambu-gray hover:text-white"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <ProductionParameterDiffTable rows={rows} />
        </div>
      </div>
    </div>
  );
}

function SlotCard({
  slot,
  onReplaceFile,
  onRemove,
  canEdit,
  replacePending,
  parameterTracking,
}: {
  slot: ProfilePartSlotView;
  onReplaceFile: (files: FileList | null) => void;
  onRemove: () => void;
  canEdit: boolean;
  replacePending: boolean;
  parameterTracking: boolean;
}) {
  const { t } = useTranslation();
  const [showSpecs, setShowSpecs] = useState(false);
  const specs = mergeProductionSpecs(slot.preset?.locked_parameters ?? null, slot.parameter_overrides ?? null);
  const canViewSpecs = Boolean(slot.preset && hasViewableSpecs(specs));
  const isMismatch = parameterTracking && (slot.spec_status === 'mismatch' || slot.last_mismatch);
  const diffRows = slot.parameter_diff ?? [];
  const canViewDiff = isMismatch && diffRows.length > 0;
  const statusLabel = isMismatch
    ? t('fileManager.production.lastReplaceMismatched')
    : t('fileManager.production.matchesSpec');
  const statusClass = isMismatch ? 'bg-red-500/20 text-red-400' : 'bg-bambu-green/20 text-bambu-green';
  const statusChipClass = `text-xs px-1.5 py-0.5 rounded ${statusClass}`;
  const canOpenStatus = parameterTracking && (canViewDiff || canViewSpecs);
  const replaceInputId = `replace-part-process-${slot.id}`;

  return (
    <>
      <div
        className="bg-bambu-dark border border-bambu-dark-tertiary rounded-lg p-3"
        data-testid="profile-part-slot"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-xs font-semibold text-white">{displayPrinter(slot.printer_model, t)}</span>
              {parameterTracking && (
                canOpenStatus ? (
                  <button
                    type="button"
                    onClick={() => setShowSpecs(true)}
                    className={`${statusChipClass} inline-flex items-center gap-0.5 cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current`}
                    aria-haspopup="dialog"
                    aria-expanded={showSpecs}
                    data-testid="profile-part-slot-status"
                  >
                    {statusLabel}
                    <ChevronRight className="w-3 h-3 opacity-80" aria-hidden />
                  </button>
                ) : (
                  <span className={statusChipClass} data-testid="profile-part-slot-status">
                    {statusLabel}
                  </span>
                )
              )}
            </div>
            {!parameterTracking && canViewSpecs ? (
              <button
                type="button"
                onClick={() => setShowSpecs(true)}
                className="text-sm text-white truncate max-w-full text-left hover:text-bambu-green"
                data-testid="profile-part-slot-own-specs"
              >
                {slot.preset?.name ?? '—'}
              </button>
            ) : (
              <p className="text-sm text-white truncate">{slot.preset?.name ?? '—'}</p>
            )}
          </div>
          {(slot.preset || canEdit) && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {slot.preset && <LocalPresetDownloadButton presetId={slot.preset.id} />}
              {canEdit && (
                <>
                  <input
                    id={replaceInputId}
                    type="file"
                    accept={PROCESS_FILE_ACCEPT}
                    className="sr-only"
                    data-testid="replace-part-process"
                    disabled={replacePending}
                    onChange={(e) => {
                      onReplaceFile(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={replacePending}
                    data-testid="profile-part-slot-replace"
                    onClick={() => document.getElementById(replaceInputId)?.click()}
                  >
                    {t('profiles.localProfiles.partSections.replace')}
                  </Button>
                  <button
                    type="button"
                    onClick={onRemove}
                    className="p-1 text-bambu-gray hover:text-red-400"
                    title={t('profiles.localProfiles.partSections.remove')}
                    data-testid="profile-part-slot-remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {showSpecs && canViewDiff && (
        <SlotMismatchModal
          title={slot.preset?.name ?? displayPrinter(slot.printer_model, t)}
          rows={diffRows}
          onClose={() => setShowSpecs(false)}
        />
      )}
      {showSpecs && !canViewDiff && canViewSpecs && (
        <ProcessSpecsModal
          title={slot.preset?.name ?? displayPrinter(slot.printer_model, t)}
          specs={specs}
          onClose={() => setShowSpecs(false)}
        />
      )}
    </>
  );
}

function findOccupiedSlot(
  section: ProfilePartSectionView,
  preset: LocalPreset,
  t: (key: string) => string,
): ProfilePartSlotView | undefined {
  const label = printerLabel(preset, t);
  return section.slots.find(
    (slot) => slot.printer_model === label || slot.preset?.printer_model === label,
  );
}

export function ProfilePartSections({
  attachRef,
}: {
  attachRef?: MutableRefObject<ProfilePartAttachFn | null>;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:update');
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [creating, setCreating] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<{ slot: ProfilePartSlotView; preset: ReplacePresetRef } | null>(null);
  const [replacePreview, setReplacePreview] = useState<ProfilePartReplacePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [specSection, setSpecSection] = useState<ProfilePartSectionView | null>(null);
  const [deleteSectionId, setDeleteSectionId] = useState<number | null>(null);
  const [reviewDiff, setReviewDiff] = useState<{ title: string; rows: ProfilePartSlotView['parameter_diff'] } | null>(null);
  const [confirmAttach, setConfirmAttach] = useState<{
    sectionId: number;
    preset: ReplacePresetRef;
    printerModel: string;
    preview: ProfilePartReplacePreview;
    fromMove?: boolean;
  } | null>(null);

  const { data: sections = [] } = useQuery({
    queryKey: PROFILE_PARTS_KEY,
    queryFn: () => api.getProfilePartSections(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: PROFILE_PARTS_KEY });
    queryClient.invalidateQueries({ queryKey: ['localPresets'] });
  };

  const createMutation = useMutation({
    mutationFn: ({ name, parameter_tracking }: { name: string; parameter_tracking: boolean }) =>
      api.createProfilePartSection(name, { parameter_tracking }),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      showToast(t('profiles.localProfiles.partSections.toast.created'));
    },
    onError: (err: Error) => {
      showToast(t('profiles.localProfiles.partSections.createFailed', { error: err.message }), 'error');
    },
  });

  const deleteSectionMutation = useMutation({
    mutationFn: (id: number) => api.deleteProfilePartSection(id),
    onSuccess: () => {
      invalidate();
      setDeleteSectionId(null);
      showToast(t('profiles.localProfiles.partSections.toast.deleted'));
    },
  });

  const addMutation = useMutation({
    mutationFn: ({
      sectionId,
      presetId,
      resolution,
    }: {
      sectionId: number;
      presetId: number;
      resolution?: 'proceed';
    }) => api.addProfilePartSlot(sectionId, presetId, resolution),
    onSuccess: () => {
      invalidate();
      setConfirmAttach(null);
      showToast(t('profiles.localProfiles.partSections.toast.processAdded'));
    },
    onError: (err: Error) => {
      showToast(t('profiles.localProfiles.partSections.addFailed', { error: err.message }), 'error');
    },
  });

  const replaceMutation = useMutation({
    mutationFn: ({
      slotId,
      presetId,
      resolution,
    }: {
      slotId: number;
      presetId: number;
      resolution: 'proceed' | 'accept_baseline';
    }) => api.replaceProfilePartSlot(slotId, { preset_id: presetId, resolution }),
    onSuccess: () => {
      invalidate();
      setReplaceTarget(null);
      setReplacePreview(null);
      showToast(t('profiles.localProfiles.partSections.toast.replaced'));
    },
    onError: (err: Error) => {
      setReplaceError(t('profiles.localProfiles.partSections.replaceFailed', { error: err.message }));
    },
  });

  const importMutation = useMutation({
    mutationFn: ({ sectionId, file, slotId }: { sectionId: number; file: File; slotId?: number }) =>
      api.importProfilePartSectionProcess(sectionId, file, slotId),
    onSuccess: (result) => {
      invalidate();
      if (result.errors.length > 0) {
        showToast(t('profiles.localProfiles.partSections.uploadFailed', { error: result.errors.join('; ') }), 'error');
      }
      if (result.needs_replace.length > 0) {
        const pending = result.needs_replace[0];
        const slot = result.section.slots.find((item) => item.id === pending.existing_slot_id);
        if (slot) {
          setReplaceTarget({ slot, preset: { id: pending.preset_id, name: pending.preset_name } });
          setReplacePreview(pending.preview);
          setReplaceError(null);
          setPreviewing(false);
        }
        if (result.attached.length > 0) {
          showToast(t('profiles.localProfiles.partSections.toast.uploaded'));
        }
        return;
      }
      if (result.needs_confirm.length > 0) {
        const pending = result.needs_confirm[0];
        setConfirmAttach({
          sectionId: result.section.id,
          preset: { id: pending.preset_id, name: pending.preset_name },
          printerModel: pending.printer_model,
          preview: pending.preview,
        });
        if (result.attached.length > 0) {
          showToast(t('profiles.localProfiles.partSections.toast.uploaded'));
        }
        return;
      }
      if (result.attached.length > 0) {
        showToast(t('profiles.localProfiles.partSections.toast.uploaded'));
      }
    },
    onError: (err: Error) => {
      showToast(t('profiles.localProfiles.partSections.uploadFailed', { error: err.message }), 'error');
    },
  });

  const removeSlotMutation = useMutation({
    mutationFn: (slotId: number) => api.deleteProfilePartSlot(slotId),
    onSuccess: () => {
      invalidate();
      showToast(t('profiles.localProfiles.partSections.toast.slotRemoved'));
    },
    onError: (err: Error) => {
      showToast(t('profiles.localProfiles.partSections.removeFailed', { error: err.message }), 'error');
    },
  });

  const openReplace = async (
    slot: ProfilePartSlotView,
    preset: ReplacePresetRef,
    preview?: ProfilePartReplacePreview,
  ) => {
    setReplaceTarget({ slot, preset });
    setReplaceError(null);
    if (preview) {
      setReplacePreview(preview);
      setPreviewing(false);
      return;
    }
    setReplacePreview(null);
    setPreviewing(true);
    try {
      const next = await api.previewReplaceProfilePartSlot(slot.id, preset.id);
      setReplacePreview(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setReplaceError(t('profiles.localProfiles.partSections.previewFailed', { error: message }));
    } finally {
      setPreviewing(false);
    }
  };

  const handleAttach = useCallback(
    async (sectionId: number, preset: LocalPreset) => {
      const section = sections.find((item) => item.id === sectionId);
      if (!section) return;
      const occupied = findOccupiedSlot(section, preset, t);
      if (occupied) {
        void openReplace(occupied, preset);
        return;
      }
      if (section.parameter_tracking === false) {
        addMutation.mutate({ sectionId, presetId: preset.id });
        return;
      }
      try {
        const preview = await api.previewAddProfilePartSlot(sectionId, preset.id);
        if (preview.has_mismatches) {
          setConfirmAttach({
            sectionId,
            preset: { id: preset.id, name: preset.name },
            printerModel: preview.printer_model,
            preview,
            fromMove: true,
          });
          return;
        }
        addMutation.mutate({ sectionId, presetId: preset.id });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const latest = sections.find((item) => item.id === sectionId);
          const fallback = latest ? findOccupiedSlot(latest, preset, t) : undefined;
          if (fallback) {
            void openReplace(fallback, preset);
            return;
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        showToast(t('profiles.localProfiles.partSections.moveFailed', { error: message }), 'error');
      }
    },
    [addMutation, openReplace, sections, showToast, t],
  );

  useEffect(() => {
    if (!attachRef) return;
    attachRef.current = (sectionId, preset) => {
      void handleAttach(sectionId, preset);
    };
    return () => {
      attachRef.current = null;
    };
  }, [attachRef, handleAttach]);

  const handleSectionUpload = (sectionId: number, files: FileList | null, slotId?: number) => {
    const file = files?.[0];
    if (!file) return;
    importMutation.mutate({ sectionId, file, slotId });
  };

  return (
    <div className="space-y-3" data-testid="profile-part-sections">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-bambu-green" />
          <h3 className="text-sm font-medium text-white">{t('profiles.localProfiles.partSections.title')}</h3>
        </div>
        {canEdit && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setCreating(true)} data-testid="add-part-section">
            <Plus className="w-3.5 h-3.5" />
            {t('profiles.localProfiles.partSections.addSection')}
          </Button>
        )}
      </div>

      {sections.length === 0 && (
        <p className="text-xs text-bambu-gray">{t('profiles.localProfiles.partSections.empty')}</p>
      )}

      <div className="space-y-4">
        {sections.map((section) => {
          const tracking = section.parameter_tracking !== false;
          const specs = mergeProductionSpecs(section.locked_parameters, null);
          const canViewSpecs = tracking && hasViewableSpecs(specs);
          const summary = canViewSpecs ? compactSpecItems(specs, t) : [];
          return (
            <div
              key={section.id}
              className="border border-bambu-dark-tertiary rounded-lg p-4 bg-bambu-dark-secondary"
              data-testid="profile-part-section"
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-white truncate">{section.name}</h4>
                  {canViewSpecs && (
                    <button
                      type="button"
                      onClick={() => setSpecSection(section)}
                      className="mt-1 inline-flex items-start gap-0.5 text-left text-[11px] text-bambu-gray leading-snug hover:text-white transition-colors"
                      data-testid="section-spec-summary"
                    >
                      <span>{summary.join(' · ')}</span>
                      <ChevronRight className="w-3 h-3 opacity-80 flex-shrink-0 mt-0.5" aria-hidden />
                    </button>
                  )}
                </div>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => setDeleteSectionId(section.id)}
                    className="p-1 text-bambu-gray hover:text-red-400"
                    title={t('profiles.localProfiles.partSections.deleteSection')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {section.slots.length === 0 ? (
                <p className="text-xs text-bambu-gray mb-3">{t('profiles.localProfiles.partSections.noProcesses')}</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                  {section.slots.map((slot) => (
                    <SlotCard
                      key={slot.id}
                      slot={slot}
                      canEdit={canEdit}
                      parameterTracking={section.parameter_tracking !== false}
                      replacePending={importMutation.isPending}
                      onReplaceFile={(files) => handleSectionUpload(section.id, files, slot.id)}
                      onRemove={() => removeSlotMutation.mutate(slot.id)}
                    />
                  ))}
                </div>
              )}

              {canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex">
                    <input
                      id={`upload-part-process-${section.id}`}
                      type="file"
                      accept={PROCESS_FILE_ACCEPT}
                      className="sr-only"
                      data-testid="upload-part-process"
                      disabled={importMutation.isPending}
                      onChange={(e) => {
                        handleSectionUpload(section.id, e.target.files);
                        e.target.value = '';
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={importMutation.isPending}
                      data-testid="upload-part-process-button"
                      onClick={() => document.getElementById(`upload-part-process-${section.id}`)?.click()}
                    >
                      {importMutation.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Upload className="w-3.5 h-3.5" />
                      )}
                      {t('profiles.localProfiles.partSections.uploadProcess')}
                    </Button>
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {creating && (
        <NamePromptModal
          title={t('profiles.localProfiles.partSections.addSection')}
          placeholder={t('profiles.localProfiles.partSections.namePlaceholder')}
          confirmLabel={t('profiles.localProfiles.partSections.create')}
          submitting={createMutation.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(name, options) => createMutation.mutate({ name, ...options })}
        />
      )}

      {replaceTarget && (
        <ReplaceProcessModal
          slot={replaceTarget.slot}
          preset={replaceTarget.preset}
          preview={replacePreview}
          previewing={previewing}
          submitting={replaceMutation.isPending}
          error={replaceError}
          onClose={() => {
            setReplaceTarget(null);
            setReplacePreview(null);
            setReplaceError(null);
          }}
          onSubmit={(resolution) =>
            replaceMutation.mutate({
              slotId: replaceTarget.slot.id,
              presetId: replaceTarget.preset.id,
              resolution,
            })
          }
        />
      )}

      {confirmAttach && (
        <ConfirmAttachModal
          preset={confirmAttach.preset}
          printerModel={confirmAttach.printerModel}
          preview={confirmAttach.preview}
          submitting={addMutation.isPending}
          cancelLabel={
            confirmAttach.fromMove
              ? t('profiles.localProfiles.partSections.dontMove')
              : undefined
          }
          onClose={() => setConfirmAttach(null)}
          onProceed={() =>
            addMutation.mutate({
              sectionId: confirmAttach.sectionId,
              presetId: confirmAttach.preset.id,
              resolution: 'proceed',
            })
          }
        />
      )}

      {reviewDiff && (
        <SlotMismatchModal
          title={reviewDiff.title}
          rows={reviewDiff.rows}
          onClose={() => setReviewDiff(null)}
        />
      )}

      {specSection && specSection.locked_parameters && (
        <ProcessSpecsModal
          title={specSection.name}
          specs={mergeProductionSpecs(specSection.locked_parameters, null)}
          onClose={() => setSpecSection(null)}
        />
      )}

      {deleteSectionId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg p-4 max-w-sm w-full">
            <h3 className="text-white font-medium mb-2">{t('profiles.localProfiles.partSections.deleteSection')}</h3>
            <p className="text-sm text-bambu-gray mb-4">{t('profiles.localProfiles.partSections.deleteSectionConfirm')}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setDeleteSectionId(null)}>
                {t('profiles.localProfiles.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={deleteSectionMutation.isPending}
                onClick={() => deleteSectionMutation.mutate(deleteSectionId)}
              >
                {t('profiles.localProfiles.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
