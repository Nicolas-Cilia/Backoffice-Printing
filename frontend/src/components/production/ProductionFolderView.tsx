import { useMemo, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileBox, Loader2, Plus, Printer, RefreshCw, Tag, Trash2, X } from 'lucide-react';
import { api } from '../../api/client';
import type { LibraryTagSummary, ProductionActiveFile, ProductionPartView, ProductionSlotNested } from '../../api/client';
import { Button } from '../Button';
import { ScrollFadeContainer } from '../ScrollFadeContainer';
import { BulkTagsPickerModal } from '../BulkTagsPickerModal';
import { ConfirmModal } from '../ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { AddProductionFileModal } from './AddProductionFileModal';
import { AddProductionPartModal } from './AddProductionPartModal';
import { ReplaceProductionFileModal } from './ReplaceProductionFileModal';
import {
  compactSpecItems,
  formatSpecValue,
  formatSupportsValue,
  hasViewableSpecs,
  mergeProductionSpecs,
  orderedSpecEntries,
  specLabelKey,
} from '../../utils/productionSpecs';

interface ProductionFolderViewProps {
  folderId: number;
  printerModel: string;
  canUpload: boolean;
  onPrint?: (file: ProductionActiveFile) => void;
}

function isSlicedFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.gcode') || lower.endsWith('.gcode.3mf');
}

function specStatus(slot: ProductionSlotNested): 'mismatch' | 'overrides' | 'match' {
  if (slot.last_mismatch) return 'mismatch';
  if (slot.has_overrides) return 'overrides';
  return 'match';
}

function SlotSpecsModal({
  title,
  specs,
  onClose,
}: {
  title: string;
  specs: Record<string, unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rows = orderedSpecEntries(specs);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="production-specs-title"
      >
        <div className="flex items-center justify-between gap-3 p-4 border-b border-bambu-dark-tertiary">
          <h2 id="production-specs-title" className="text-sm font-semibold text-white truncate">
            {t('fileManager.production.specs.title')}
            {title ? <span className="text-bambu-gray font-normal"> · {title}</span> : null}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-bambu-dark-tertiary text-bambu-gray hover:text-white"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <dl className="overflow-y-auto p-4 space-y-0">
          {rows.map(([key, value]) => {
            const labelKey = specLabelKey(key);
            return (
              <div
                key={key}
                className="flex items-baseline justify-between gap-4 py-1.5 border-b border-bambu-dark-tertiary last:border-0"
              >
                <dt className="text-xs text-bambu-gray">{labelKey ? t(labelKey) : key}</dt>
                <dd className="text-xs text-white text-right font-medium">
                  {key === 'enable_support' ? formatSupportsValue(specs, t) : formatSpecValue(key, value, t)}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

function SlotCard({
  slot,
  lockedParameters,
  canUpload,
  canDelete,
  canEditTags,
  onReplace,
  onDelete,
  onPrint,
  onEditTags,
  onRemoveTag,
}: {
  slot: ProductionSlotNested;
  lockedParameters: Record<string, unknown> | null;
  canUpload: boolean;
  canDelete: boolean;
  canEditTags: boolean;
  onReplace: () => void;
  onDelete: () => void;
  onPrint?: (file: ProductionActiveFile) => void;
  onEditTags?: (file: ProductionActiveFile) => void;
  onRemoveTag?: (fileId: number, tagId: number) => void;
}) {
  const { t } = useTranslation();
  const [showSpecs, setShowSpecs] = useState(false);
  const file = slot.active_file;
  const attachedTags = file?.tags ?? [];
  const status = specStatus(slot);
  const statusLabel =
    status === 'mismatch'
      ? t('fileManager.production.lastReplaceMismatched')
      : status === 'overrides'
        ? t('fileManager.production.differsByDesign')
        : t('fileManager.production.matchesSpec');
  const statusClass =
    status === 'mismatch'
      ? 'bg-red-500/20 text-red-400'
      : status === 'overrides'
        ? 'bg-amber-500/20 text-amber-400'
        : 'bg-bambu-green/20 text-bambu-green';
  const specs = mergeProductionSpecs(lockedParameters, slot.parameter_overrides);
  const canViewSpecs = Boolean(file && hasViewableSpecs(specs));
  const summary = canViewSpecs ? compactSpecItems(specs, t) : [];
  const statusChipClass = `text-xs px-1.5 py-0.5 rounded ${statusClass}`;

  return (
    <div className="bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary overflow-hidden flex flex-col">
      <div className="aspect-square bg-bambu-dark flex items-center justify-center overflow-hidden relative">
        {file?.thumbnail_path ? (
          <img
            src={api.getLibraryFileThumbnailUrl(file.id)}
            alt={file.filename}
            className="w-full h-full object-cover"
          />
        ) : (
          <FileBox className="w-12 h-12 text-bambu-gray/30" />
        )}
        <span className="absolute top-2 left-2 text-xs px-1.5 py-0.5 rounded font-medium bg-bambu-dark/80 text-white">
          x{slot.quantity}
        </span>
        {canDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="absolute top-1.5 right-1.5 z-10 p-1.5 rounded bg-bambu-dark-secondary/90 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-red-700 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bambu-gray transition-colors"
            aria-label={t('fileManager.production.delete')}
          >
            <Trash2 className="w-4 h-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-2">
        <h3 className="text-sm font-medium text-white truncate" title={file?.filename}>
          {file?.filename ?? t('fileManager.production.noActiveFile')}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs px-1.5 py-0.5 rounded bg-bambu-dark text-bambu-gray font-mono">
            {slot.version}
          </span>
          {canViewSpecs ? (
            <button
              type="button"
              onClick={() => setShowSpecs(true)}
              className={`${statusChipClass} inline-flex items-center gap-0.5 cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current`}
              aria-haspopup="dialog"
              aria-expanded={showSpecs}
            >
              {statusLabel}
              <ChevronRight className="w-3 h-3 opacity-80" aria-hidden />
            </button>
          ) : (
            <span className={statusChipClass}>{statusLabel}</span>
          )}
        </div>
        {summary.length > 0 && (
          <p className="text-[11px] text-bambu-gray leading-snug" data-testid="production-spec-summary">
            {summary.join(' · ')}
          </p>
        )}
        {file && (attachedTags.length > 0 || canEditTags) && (
          <div className="flex flex-wrap gap-1">
            {attachedTags.map((tg: LibraryTagSummary) => (
              <span
                key={tg.id}
                className="inline-flex items-center max-w-full rounded-full bg-bambu-green/10 text-bambu-green text-[10px]"
              >
                <span className={`inline-flex items-center gap-0.5 pl-1.5 py-0.5 min-w-0 ${
                  canEditTags && onRemoveTag ? 'rounded-l-full' : 'pr-1.5 rounded-full'
                }`} title={tg.name}>
                  <Tag className="w-2.5 h-2.5 flex-shrink-0" />
                  <span className="truncate">{tg.name}</span>
                </span>
                {canEditTags && onRemoveTag && (
                  <button
                    type="button"
                    className="pr-1 pl-0.5 py-0.5 hover:text-white rounded-r-full"
                    onClick={() => onRemoveTag(file.id, tg.id)}
                    aria-label={t('fileManager.tags.removeFromFileAria', { name: tg.name })}
                    title={t('fileManager.tags.removeFromFileAria', { name: tg.name })}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </span>
            ))}
            {canEditTags && onEditTags && (
              <button
                type="button"
                onClick={() => onEditTags(file)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-bambu-green/70 text-bambu-green text-[11px] font-medium hover:bg-bambu-green/10 transition-colors"
                aria-label={t('fileManager.tags.addToFileAria')}
                title={t('fileManager.tags.fileTooltip')}
              >
                <Plus className="w-3 h-3" />
                {t('fileManager.tags.title')}
              </button>
            )}
          </div>
        )}
        <div className="mt-auto flex flex-col gap-2 pt-1">
          {canUpload && (
            <Button onClick={onReplace} className="w-full">
              {t('fileManager.production.replace')}
            </Button>
          )}
          {onPrint && file && isSlicedFilename(file.filename) && (
            <Button variant="secondary" onClick={() => onPrint(file)} className="w-full">
              <Printer className="w-4 h-4" />
              {t('fileManager.production.print')}
            </Button>
          )}
        </div>
      </div>
      {showSpecs && (
        <SlotSpecsModal
          title={file?.filename ?? slot.version}
          specs={specs}
          onClose={() => setShowSpecs(false)}
        />
      )}
    </div>
  );
}

export function ProductionFolderView({
  folderId,
  printerModel,
  canUpload,
  onPrint,
}: ProductionFolderViewProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission, hasAnyPermission } = useAuth();
  const queryClient = useQueryClient();
  const canPrint = hasPermission('queue:create');
  const canDelete = hasAnyPermission('library:delete_own', 'library:delete_all');
  const canEditTags = hasAnyPermission('library:update_own', 'library:update_all');
  const [showAdd, setShowAdd] = useState(false);
  const [showAddPart, setShowAddPart] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [addInitialCode, setAddInitialCode] = useState('');
  const [replaceSlot, setReplaceSlot] = useState<ProductionSlotNested | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    slot: ProductionSlotNested;
    part: ProductionPartView;
  } | null>(null);
  const [removePartTarget, setRemovePartTarget] = useState<ProductionPartView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [removingPart, setRemovingPart] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tagPickerTarget, setTagPickerTarget] = useState<{
    fileIds: number[];
    currentTagIds?: number[];
  } | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['production-folder', folderId],
    queryFn: () => api.getProductionFolder(folderId),
  });

  const parts = data?.parts ?? [];
  const hasAnySlots = useMemo(() => parts.some((part) => part.slots.length > 0), [parts]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['production-folder', folderId] });
    void queryClient.invalidateQueries({ queryKey: ['library-files'] });
    void queryClient.invalidateQueries({ queryKey: ['library-folders'] });
  };

  const openFileTagPicker = (file: ProductionActiveFile) => {
    setTagPickerTarget({
      fileIds: [file.id],
      currentTagIds: (file.tags ?? []).map((tg) => tg.id),
    });
  };

  const handleRemoveTag = async (fileId: number, tagId: number) => {
    try {
      await api.bulkAssignLibraryTags([fileId], [tagId], 'remove');
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message || t('fileManager.tags.applyFailed'), 'error');
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!canUpload) return;
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (!canUpload) {
      showToast(t('fileManager.production.uploadIntoProductionBlocked'), 'warning');
      return;
    }
    const next = e.dataTransfer.files[0];
    if (!next) return;
    openAddFile(undefined, next);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteProductionSlot(deleteTarget.slot.id);
      setDeleteTarget(null);
      showToast(t('fileManager.production.slotDeleted'), 'success');
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(t('fileManager.production.deleteFailed', { error: message }), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleConfirmRemovePart = async () => {
    if (!removePartTarget) return;
    setRemovingPart(true);
    try {
      await api.removeProductionPart(folderId, removePartTarget.id);
      setRemovePartTarget(null);
      showToast(t('fileManager.production.partRemoved'), 'success');
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(t('fileManager.production.removePartFailed', { error: message }), 'error');
    } finally {
      setRemovingPart(false);
    }
  };

  const openAddFile = (code?: string, file: File | null = null) => {
    setAddInitialCode(code ?? '');
    setDroppedFile(file);
    setShowAdd(true);
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
          <p className="text-sm text-bambu-gray">{t('fileManager.production.loading')}</p>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-bambu-gray">{t('fileManager.production.loading')}</p>
        <Button variant="secondary" onClick={() => void refetch()}>
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={`flex-1 flex flex-col min-h-0 overflow-hidden ${isDragging ? 'ring-2 ring-bambu-green rounded-lg' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 shrink-0">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('fileManager.production.title')}</h2>
          <p className="text-sm text-bambu-gray">
            {printerModel
              ? t('fileManager.production.subtitle', { printer: printerModel })
              : t('fileManager.trackPrintSettingsHelp')}
          </p>
        </div>
        {canUpload && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => setShowAddPart(true)}
            >
              <Plus className="w-4 h-4" />
              {t('fileManager.production.addPart')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => openAddFile()}
            >
              <Plus className="w-4 h-4" />
              {t('fileManager.production.addFile')}
            </Button>
          </div>
        )}
      </div>

      {!hasAnySlots && (
        <div className="flex flex-col items-center justify-center py-12 mb-6 border border-dashed border-bambu-dark-tertiary rounded-lg shrink-0">
          <FileBox className="w-12 h-12 text-bambu-gray/50 mb-3" />
          <p className="text-white font-medium mb-1">{t('fileManager.production.emptyFolder')}</p>
          <p className="text-sm text-bambu-gray">{t('fileManager.production.dropToAdd')}</p>
        </div>
      )}

      {parts.length > 0 && (
        <ScrollFadeContainer>
          <div className="space-y-8 pb-4">
            {parts.map((part: ProductionPartView) => (
              <section key={part.id}>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <h3 className="text-sm font-semibold text-white tracking-wide">{part.code}</h3>
                    <span className="text-xs text-bambu-gray truncate">{part.name}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {canUpload && (
                      <Button variant="secondary" onClick={() => openAddFile(part.code)}>
                        <Plus className="w-4 h-4" />
                        {t('fileManager.production.addFileToPart')}
                      </Button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => setRemovePartTarget(part)}
                        className="p-1.5 rounded text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-red-700 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bambu-gray transition-colors"
                        aria-label={t('fileManager.production.removePart')}
                      >
                        <Trash2 className="w-4 h-4" aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
                {part.slots.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                    {part.slots.map((slot) => (
                      <SlotCard
                        key={slot.id}
                        slot={slot}
                        lockedParameters={part.locked_parameters}
                        canUpload={canUpload}
                        canDelete={canDelete}
                        canEditTags={canEditTags}
                        onReplace={() => setReplaceSlot(slot)}
                        onDelete={() => setDeleteTarget({ slot, part })}
                        onPrint={canPrint ? onPrint : undefined}
                        onEditTags={openFileTagPicker}
                        onRemoveTag={handleRemoveTag}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-bambu-gray">{t('fileManager.production.emptyPart')}</p>
                )}
              </section>
            ))}
          </div>
        </ScrollFadeContainer>
      )}

      {showAdd && (
        <AddProductionFileModal
          folderId={folderId}
          printerModel={printerModel}
          parts={parts}
          initialFile={droppedFile}
          initialCode={addInitialCode}
          onClose={() => {
            setShowAdd(false);
            setDroppedFile(null);
            setAddInitialCode('');
          }}
          onCreated={() => {
            setShowAdd(false);
            setDroppedFile(null);
            setAddInitialCode('');
            showToast(t('fileManager.production.slotCreated'), 'success');
            refresh();
          }}
        />
      )}

      {showAddPart && (
        <AddProductionPartModal
          folderId={folderId}
          onClose={() => setShowAddPart(false)}
          onCreated={() => {
            setShowAddPart(false);
            showToast(t('fileManager.production.partAdded'), 'success');
            refresh();
          }}
        />
      )}

      {replaceSlot && (
        <ReplaceProductionFileModal
          slotId={replaceSlot.id}
          code={parts.find((part) => part.slots.some((slot) => slot.id === replaceSlot.id))?.code ?? ''}
          quantity={replaceSlot.quantity}
          major={replaceSlot.major}
          revision={replaceSlot.revision}
          minor={replaceSlot.minor}
          currentVersion={replaceSlot.version}
          printerModel={printerModel}
          onClose={() => setReplaceSlot(null)}
          onReplaced={() => {
            setReplaceSlot(null);
            showToast(t('fileManager.production.slotReplaced'), 'success');
            refresh();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          variant="danger"
          title={t('fileManager.production.deleteConfirmTitle')}
          message={`${t('fileManager.production.deleteConfirm', {
            code: deleteTarget.part.code,
            quantity: deleteTarget.slot.quantity,
            version: deleteTarget.slot.version,
            printer: printerModel,
          })}\n\n${t('fileManager.production.deleteConfirmDetail')}`}
          confirmText={t('fileManager.production.delete')}
          isLoading={deleting}
          onConfirm={() => {
            void handleConfirmDelete();
          }}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        />
      )}

      {removePartTarget && (
        <ConfirmModal
          variant="danger"
          title={t('fileManager.production.removePartConfirmTitle')}
          message={
            removePartTarget.slots.length > 0
              ? `${t('fileManager.production.removePartConfirmWithFiles', {
                  code: removePartTarget.code,
                  name: removePartTarget.name,
                  printer: printerModel,
                  count: removePartTarget.slots.length,
                })}\n\n${t('fileManager.production.deleteConfirmDetail')}`
              : t('fileManager.production.removePartConfirmEmpty', {
                  code: removePartTarget.code,
                  name: removePartTarget.name,
                  printer: printerModel,
                })
          }
          confirmText={t('fileManager.production.removePart')}
          isLoading={removingPart}
          onConfirm={() => {
            void handleConfirmRemovePart();
          }}
          onCancel={() => {
            if (!removingPart) setRemovePartTarget(null);
          }}
        />
      )}

      <BulkTagsPickerModal
        open={tagPickerTarget !== null}
        fileIds={tagPickerTarget?.fileIds ?? []}
        currentTagIds={tagPickerTarget?.currentTagIds}
        onClose={() => setTagPickerTarget(null)}
      />
    </div>
  );
}
