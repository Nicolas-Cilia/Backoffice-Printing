import { useMemo, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileBox, Loader2, Plus, Printer, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductionActiveFile, ProductionPartView, ProductionSlotNested } from '../../api/client';
import { Button } from '../Button';
import { ConfirmModal } from '../ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { AddProductionFileModal } from './AddProductionFileModal';
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
  onReplace,
  onDelete,
  onPrint,
}: {
  slot: ProductionSlotNested;
  lockedParameters: Record<string, unknown> | null;
  canUpload: boolean;
  canDelete: boolean;
  onReplace: () => void;
  onDelete: () => void;
  onPrint?: (file: ProductionActiveFile) => void;
}) {
  const { t } = useTranslation();
  const [showSpecs, setShowSpecs] = useState(false);
  const file = slot.active_file;
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
            className="absolute top-1.5 right-1.5 z-10 p-1 rounded-md bg-white/85 border border-black/15 text-gray-800/70 hover:text-red-700 hover:bg-white hover:border-red-300 dark:bg-black/55 dark:border-white/25 dark:text-white/75 dark:hover:text-red-400 dark:hover:bg-black/75 dark:hover:border-red-400/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-500 dark:focus-visible:ring-white/40 transition-colors"
            aria-label={t('fileManager.production.delete')}
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden />
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
  const [showAdd, setShowAdd] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [replaceSlot, setReplaceSlot] = useState<ProductionSlotNested | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    slot: ProductionSlotNested;
    part: ProductionPartView;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

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
    setDroppedFile(next);
    setShowAdd(true);
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
      className={`flex-1 flex flex-col min-h-0 overflow-y-auto ${isDragging ? 'ring-2 ring-bambu-green rounded-lg' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('fileManager.production.title')}</h2>
          <p className="text-sm text-bambu-gray">{t('fileManager.production.subtitle', { printer: printerModel })}</p>
        </div>
        {canUpload && (
          <Button
            variant="secondary"
            onClick={() => {
              setDroppedFile(null);
              setShowAdd(true);
            }}
          >
            <Plus className="w-4 h-4" />
            {t('fileManager.production.addFile')}
          </Button>
        )}
      </div>

      {!hasAnySlots && (
        <div className="flex flex-col items-center justify-center py-12 mb-6 border border-dashed border-bambu-dark-tertiary rounded-lg">
          <FileBox className="w-12 h-12 text-bambu-gray/50 mb-3" />
          <p className="text-white font-medium mb-1">{t('fileManager.production.emptyFolder')}</p>
          <p className="text-sm text-bambu-gray">{t('fileManager.production.dropToAdd')}</p>
        </div>
      )}

      {hasAnySlots && (
        <div className="space-y-8">
          {parts.map((part: ProductionPartView) => (
            <section key={part.id}>
              <div className="flex items-baseline gap-2 mb-3">
                <h3 className="text-sm font-semibold text-white tracking-wide">{part.code}</h3>
                <span className="text-xs text-bambu-gray">{part.name}</span>
              </div>
              {part.slots.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                  {part.slots.map((slot) => (
                    <SlotCard
                      key={slot.id}
                      slot={slot}
                      lockedParameters={part.locked_parameters}
                      canUpload={canUpload}
                      canDelete={canDelete}
                      onReplace={() => setReplaceSlot(slot)}
                      onDelete={() => setDeleteTarget({ slot, part })}
                      onPrint={canPrint ? onPrint : undefined}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {showAdd && (
        <AddProductionFileModal
          folderId={folderId}
          printerModel={printerModel}
          parts={parts}
          initialFile={droppedFile}
          onClose={() => {
            setShowAdd(false);
            setDroppedFile(null);
          }}
          onCreated={() => {
            setShowAdd(false);
            setDroppedFile(null);
            showToast(t('fileManager.production.slotCreated'), 'success');
            refresh();
          }}
        />
      )}

      {replaceSlot && (
        <ReplaceProductionFileModal
          slotId={replaceSlot.id}
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
    </div>
  );
}
