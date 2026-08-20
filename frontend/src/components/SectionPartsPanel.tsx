import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Box, FileBox, GripVertical, Loader2, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { api } from '../api/client';
import type { LibrarySectionPart } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { compactSpecItems, hasViewableSpecs, mergeProductionSpecs } from '../utils/productionSpecs';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import { ProductionSpecsModal } from './production/ProductionSpecsModal';
import { ReplaceSectionPartParametersModal } from './ReplaceSectionPartParametersModal';

interface SectionPartsPanelProps {
  sectionId: number;
  canManage: boolean;
  openAdd?: boolean;
  onOpenAddHandled?: () => void;
}

const EMPTY_PARTS: LibrarySectionPart[] = [];

function SortableSectionPartCard({
  part,
  canDrag,
  onMoveBy,
  children,
}: {
  part: LibrarySectionPart;
  canDrag: boolean;
  onMoveBy: (delta: number) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: part.id, disabled: !canDrag });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      data-testid={`section-part-card-${part.code}`}
      className={`bg-bambu-dark rounded-lg border overflow-hidden flex gap-3 p-3 items-start origin-top-left ${
        isDragging ? 'border-bambu-green z-10' : 'border-bambu-dark-tertiary'
      }`}
    >
      {canDrag && (
        <button
          type="button"
          className="shrink-0 self-start mt-1 rounded p-0.5 text-bambu-gray hover:text-white cursor-grab active:cursor-grabbing touch-none"
          aria-label={t('fileManager.sectionParts.dragHandle')}
          title={t('fileManager.sectionParts.dragHandle')}
          {...attributes}
          {...listeners}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault();
              event.stopPropagation();
              onMoveBy(1);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault();
              event.stopPropagation();
              onMoveBy(-1);
            }
          }}
        >
          <GripVertical className="w-4 h-4" />
        </button>
      )}
      {children}
    </div>
  );
}

export function SectionPartsPanel({
  sectionId,
  canManage,
  openAdd = false,
  onOpenAddHandled,
}: SectionPartsPanelProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const seedInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [seedPartId, setSeedPartId] = useState<number | null>(null);
  const [seedingId, setSeedingId] = useState<number | null>(null);
  const [replacePart, setReplacePart] = useState<LibrarySectionPart | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibrarySectionPart | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [specsPart, setSpecsPart] = useState<LibrarySectionPart | null>(null);
  const [orderedParts, setOrderedParts] = useState<LibrarySectionPart[]>([]);
  const orderedRef = useRef(orderedParts);
  orderedRef.current = orderedParts;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { data } = useQuery({
    queryKey: ['library-section-parts', sectionId],
    queryFn: () => api.getLibrarySectionParts(sectionId),
    enabled: open,
  });
  const parts = data ?? EMPTY_PARTS;

  useEffect(() => {
    setOrderedParts(parts);
  }, [parts]);

  useEffect(() => {
    if (!openAdd) return;
    setOpen(true);
    onOpenAddHandled?.();
  }, [openAdd, onOpenAddHandled]);

  const normalizedCode = code.trim().toUpperCase();
  const codeValid = /^[A-Z]{1,32}$/.test(normalizedCode);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['library-section-parts', sectionId] });
  };

  const persistOrder = async (next: LibrarySectionPart[]) => {
    const previous = orderedRef.current;
    setOrderedParts(next);
    try {
      await api.reorderLibrarySectionParts(
        sectionId,
        next.map((part) => part.id),
      );
      refresh();
    } catch (err) {
      setOrderedParts(previous);
      const message = err instanceof Error ? err.message : String(err);
      showToast(t('fileManager.sectionParts.reorderFailed', { error: message }), 'error');
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const current = orderedRef.current;
    const oldIndex = current.findIndex((part) => part.id === active.id);
    const newIndex = current.findIndex((part) => part.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    void persistOrder(arrayMove(current, oldIndex, newIndex));
  };

  const handleMoveBy = (partId: number, delta: number) => {
    const current = orderedRef.current;
    const index = current.findIndex((part) => part.id === partId);
    if (index < 0) return;
    const nextIndex = Math.max(0, Math.min(current.length - 1, index + delta));
    if (nextIndex === index) return;
    void persistOrder(arrayMove(current, index, nextIndex));
  };

  const handleCreate = async () => {
    if (!codeValid || submitting) return;
    setSubmitting(true);
    setAddError(null);
    try {
      await api.createLibrarySectionPart(sectionId, { code: normalizedCode, name: name.trim() });
      setShowAdd(false);
      setCode('');
      setName('');
      showToast(t('fileManager.sectionParts.created'), 'success');
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAddError(t('fileManager.sectionParts.addFailed', { error: message }));
    } finally {
      setSubmitting(false);
    }
  };

  const openSeedPicker = (partId: number) => {
    setSeedPartId(partId);
    seedInputRef.current?.click();
  };

  const handleSeedFile = async (file: File | undefined) => {
    const partId = seedPartId;
    if (seedInputRef.current) seedInputRef.current.value = '';
    setSeedPartId(null);
    if (!file || partId == null) return;
    setSeedingId(partId);
    try {
      await api.seedLibrarySectionPartParameters(sectionId, partId, file);
      showToast(t('fileManager.sectionParts.seeded'), 'success');
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(t('fileManager.sectionParts.seedFailed', { error: message }), 'error');
    } finally {
      setSeedingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteLibrarySectionPart(sectionId, deleteTarget.id);
      setDeleteTarget(null);
      showToast(t('fileManager.sectionParts.deleted'), 'success');
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(t('fileManager.sectionParts.deleteFailed', { error: message }), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const specsPartMerged = useMemo(
    () => (specsPart ? mergeProductionSpecs(specsPart.locked_parameters, null) : {}),
    [specsPart],
  );

  const renderPartBody = (part: LibrarySectionPart) => {
    const specs = mergeProductionSpecs(part.locked_parameters, null);
    const specItems = hasViewableSpecs(specs) ? compactSpecItems(specs, t) : [];
    const hasContract = Boolean(part.locked_parameters && Object.keys(part.locked_parameters).length > 0);
    return (
      <>
        <div className="w-20 h-20 min-w-20 min-h-20 shrink-0 rounded bg-bambu-dark-secondary flex items-center justify-center overflow-hidden">
          {part.has_thumbnail ? (
            <img
              key={`${part.id}-${part.updated_at}`}
              src={api.getLibrarySectionPartThumbnailUrl(sectionId, part.id, part.updated_at)}
              alt={part.name || part.code}
              className="w-20 h-20 max-w-none object-cover"
            />
          ) : (
            <FileBox className="w-8 h-8 text-bambu-gray/40" />
          )}
        </div>
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <button
            type="button"
            data-testid="section-part-chip"
            disabled={specItems.length === 0}
            onClick={() => {
              if (specItems.length > 0) setSpecsPart(part);
            }}
            className={`text-left truncate ${
              specItems.length > 0 ? 'hover:text-bambu-green cursor-pointer' : 'cursor-default'
            }`}
          >
            <span className="font-mono text-sm font-medium text-white">{part.code}</span>
            {part.name ? <span className="text-xs text-bambu-gray ml-1.5">{part.name}</span> : null}
          </button>
          {specItems.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {specItems.map((item) => (
                <button
                  key={`${part.id}-${item}`}
                  type="button"
                  onClick={() => setSpecsPart(part)}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-bambu-dark-secondary text-bambu-gray hover:text-white"
                >
                  {item}
                </button>
              ))}
            </div>
          )}
          {canManage && (
            <div className="flex flex-wrap items-center gap-1 mt-auto">
              {hasContract ? (
                <button
                  type="button"
                  onClick={() => setReplacePart(part)}
                  className="inline-flex items-center gap-1 text-xs text-bambu-gray hover:text-white px-1.5 py-0.5 rounded hover:bg-bambu-dark-secondary"
                  title={t('fileManager.sectionParts.replaceParametersHelp')}
                  data-testid="section-part-replace"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('fileManager.sectionParts.replaceParameters')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => openSeedPicker(part.id)}
                  disabled={seedingId === part.id}
                  className="inline-flex items-center gap-1 text-xs text-bambu-gray hover:text-white px-1.5 py-0.5 rounded hover:bg-bambu-dark-secondary disabled:opacity-50"
                  title={t('fileManager.sectionParts.setParametersHelp')}
                >
                  {seedingId === part.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Upload className="w-3.5 h-3.5" />
                  )}
                  {t('fileManager.sectionParts.setParameters')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setDeleteTarget(part)}
                className="p-1 rounded text-bambu-gray hover:bg-bambu-dark-secondary hover:text-red-700 dark:hover:text-red-400"
                aria-label={t('fileManager.sectionParts.delete')}
                title={t('fileManager.sectionParts.delete')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </>
    );
  };

  const partGrid = (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
      {orderedParts.map((part) => (
        <SortableSectionPartCard
          key={part.id}
          part={part}
          canDrag={canManage}
          onMoveBy={(delta) => handleMoveBy(part.id, delta)}
        >
          {renderPartBody(part)}
        </SortableSectionPartCard>
      ))}
    </div>
  );

  return (
    <div data-testid="section-parts-panel">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-bambu-gray hover:text-white px-1.5 py-0.5 rounded hover:bg-bambu-dark-secondary"
        title={t('fileManager.sectionParts.title')}
      >
        <Box className="w-3.5 h-3.5" />
        {t('fileManager.sectionParts.title')}
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div
            className="bg-bambu-dark-secondary rounded-lg w-full max-w-3xl border border-bambu-dark-tertiary max-h-[90vh] flex flex-col"
            role="dialog"
            aria-labelledby="section-parts-dialog-title"
          >
            <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between gap-3">
              <h2 id="section-parts-dialog-title" className="text-lg font-semibold text-white">
                {t('fileManager.sectionParts.catalog')}
              </h2>
              <div className="flex items-center gap-2">
                {canManage && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setAddError(null);
                      setShowAdd(true);
                    }}
                  >
                    <Plus className="w-4 h-4" />
                    {t('fileManager.sectionParts.add')}
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-bambu-gray hover:text-white p-1 rounded"
                  aria-label={t('fileManager.production.cancel')}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <input
              ref={seedInputRef}
              type="file"
              accept=".3mf,.gcode,.gcode.3mf"
              className="hidden"
              onChange={(e) => void handleSeedFile(e.target.files?.[0])}
            />

            <div className="p-4 overflow-y-auto flex-1">
              <p className="text-xs text-bambu-gray mb-3">{t('fileManager.sectionParts.notPrintable')}</p>
              {canManage && orderedParts.length > 1 && (
                <p className="text-xs text-bambu-gray mb-3">{t('fileManager.sectionParts.arrangeHint')}</p>
              )}
              {orderedParts.length === 0 ? (
                <p className="text-sm text-bambu-gray">{t('fileManager.sectionParts.empty')}</p>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={orderedParts.map((part) => part.id)} strategy={rectSortingStrategy}>
                    {partGrid}
                  </SortableContext>
                </DndContext>
              )}
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
          <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-md border border-bambu-dark-tertiary">
            <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">{t('fileManager.sectionParts.addTitle')}</h2>
              <button
                type="button"
                onClick={() => !submitting && setShowAdd(false)}
                disabled={submitting}
                className="text-bambu-gray hover:text-white p-1 rounded"
                aria-label={t('fileManager.production.cancel')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-xs text-bambu-gray">{t('fileManager.sectionParts.notPrintable')}</p>
              <label className="block text-sm">
                <span className="text-bambu-gray">{t('fileManager.sectionParts.code')}</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
                  autoFocus
                />
              </label>
              <label className="block text-sm">
                <span className="text-bambu-gray">{t('fileManager.sectionParts.name')}</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
                />
              </label>
              <p className="text-xs text-bambu-gray">{t('fileManager.production.partCodeHint')}</p>
              {addError && <p className="text-sm text-red-500">{addError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setShowAdd(false)} disabled={submitting}>
                  {t('fileManager.production.cancel')}
                </Button>
                <Button type="button" onClick={() => void handleCreate()} disabled={!codeValid || submitting}>
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {t('fileManager.sectionParts.add')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {specsPart && (
        <ProductionSpecsModal
          title={`${specsPart.code}${specsPart.name ? ` · ${specsPart.name}` : ''}`}
          specs={specsPartMerged}
          onClose={() => setSpecsPart(null)}
        />
      )}

      {replacePart && (
        <ReplaceSectionPartParametersModal
          sectionId={sectionId}
          part={replacePart}
          onClose={() => setReplacePart(null)}
          onReplaced={() => {
            setReplacePart(null);
            showToast(t('fileManager.sectionParts.replaced'), 'success');
            refresh();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          variant="danger"
          title={t('fileManager.sectionParts.delete')}
          message={
            deleteTarget.instance_count > 0
              ? t('fileManager.sectionParts.deleteConfirmInUse', {
                  code: deleteTarget.code,
                  count: deleteTarget.instance_count,
                })
              : t('fileManager.sectionParts.deleteConfirm', { code: deleteTarget.code })
          }
          confirmText={t('fileManager.sectionParts.delete')}
          isLoading={deleting}
          onConfirm={() => {
            void handleDelete();
          }}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}
