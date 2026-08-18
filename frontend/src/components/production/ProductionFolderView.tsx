import { useMemo, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileBox, Loader2, Plus, Printer, RefreshCw } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductionActiveFile, ProductionPartView, ProductionSlotNested } from '../../api/client';
import { Button } from '../Button';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { AddProductionFileModal } from './AddProductionFileModal';
import { ReplaceProductionFileModal } from './ReplaceProductionFileModal';

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

function SlotCard({
  slot,
  canUpload,
  onReplace,
  onPrint,
}: {
  slot: ProductionSlotNested;
  canUpload: boolean;
  onReplace: () => void;
  onPrint?: (file: ProductionActiveFile) => void;
}) {
  const { t } = useTranslation();
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
      </div>
      <div className="p-3 flex-1 flex flex-col gap-2">
        <h3 className="text-sm font-medium text-white truncate" title={file?.filename}>
          {file?.filename ?? t('fileManager.production.noActiveFile')}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs px-1.5 py-0.5 rounded bg-bambu-dark text-bambu-gray font-mono">
            {slot.version}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded ${statusClass}`}>{statusLabel}</span>
        </div>
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
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canPrint = hasPermission('queue:create');
  const [showAdd, setShowAdd] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [replaceSlot, setReplaceSlot] = useState<ProductionSlotNested | null>(null);
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

      <div className="space-y-8">
        {parts.map((part: ProductionPartView) => (
          <section key={part.id}>
            <div className="flex items-baseline gap-2 mb-3">
              <h3 className="text-sm font-semibold text-white tracking-wide">{part.code}</h3>
              <span className="text-xs text-bambu-gray">{part.name}</span>
            </div>
            {part.slots.length === 0 ? (
              <p className="text-xs text-bambu-gray">{t('fileManager.production.noActiveFile')}</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                {part.slots.map((slot) => (
                  <SlotCard
                    key={slot.id}
                    slot={slot}
                    canUpload={canUpload}
                    onReplace={() => setReplaceSlot(slot)}
                    onPrint={canPrint ? onPrint : undefined}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

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
    </div>
  );
}
