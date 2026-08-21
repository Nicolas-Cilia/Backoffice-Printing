import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS, type Transform } from '@dnd-kit/utilities';
import { ChevronsUpDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getPrinterImage } from '../utils/printer';
import { movePrinterInOrder } from '../utils/printerCustomOrder';
import { Card, CardContent } from './Card';
import { Button } from './Button';

export function clampArrangeDrag(
  transform: Transform,
  dragging: { top: number; bottom: number } | null | undefined,
  list: { top: number; bottom: number } | null | undefined,
): Transform {
  if (!dragging || !list) {
    return { ...transform, x: 0 };
  }
  const yMin = list.top - dragging.top;
  const yMax = list.bottom - dragging.bottom;
  return {
    ...transform,
    x: 0,
    y: Math.min(Math.max(transform.y, yMin), yMax),
  };
}

export type ArrangePrinterItem = {
  id: number;
  name: string;
  model: string | null;
};

interface ArrangePrintersModalProps {
  isOpen: boolean;
  title: string;
  printers: ArrangePrinterItem[];
  onApply: (orderedIds: number[]) => void;
  onClose: () => void;
}

function SortablePrinterRow({
  printer,
  position,
  onMoveBy,
}: {
  printer: ArrangePrinterItem;
  position: number;
  onMoveBy: (delta: number) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: printer.id });

  const style = {
    transform: CSS.Transform.toString(transform ? { ...transform, x: 0 } : null),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`arrange-printer-${printer.id}`}
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
        isDragging
          ? 'border-bambu-green bg-bambu-green/10 z-10'
          : 'border-bambu-dark-tertiary bg-bambu-dark'
      }`}
    >
      <span
        data-testid="arrange-position"
        className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md border border-bambu-green/40 bg-bambu-green/15 px-1.5 font-mono text-xs font-semibold tabular-nums text-bambu-green"
        aria-label={t('printers.arrange.position', 'Position {{n}}', { n: position })}
      >
        {position}
      </span>
      <img
        src={getPrinterImage(printer.model)}
        alt=""
        className="h-8 w-8 shrink-0 object-contain"
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
        {printer.name}
      </span>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-bambu-gray hover:text-white cursor-grab active:cursor-grabbing touch-none"
        aria-label={t('printers.arrange.dragHandle', 'Reorder')}
        {...attributes}
        {...listeners}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            onMoveBy(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            onMoveBy(-1);
          }
        }}
      >
        <ChevronsUpDown className="h-5 w-5" />
      </button>
    </div>
  );
}

export function ArrangePrintersModal({
  isOpen,
  title,
  printers,
  onApply,
  onClose,
}: ArrangePrintersModalProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ArrangePrinterItem[]>(printers);
  const itemsRef = useRef(items);
  const listRef = useRef<HTMLDivElement>(null);
  itemsRef.current = items;

  const restrictToList = useCallback<Modifier>(
    ({ transform, draggingNodeRect, activeNodeRect }) =>
      clampArrangeDrag(transform, draggingNodeRect ?? activeNodeRect, listRef.current?.getBoundingClientRect()),
    [],
  );

  useEffect(() => {
    if (isOpen) setItems(printers);
  }, [isOpen, printers]);

  const apply = () => onApply(itemsRef.current.map((printer) => printer.id));

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  if (!isOpen) return null;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIndex = prev.findIndex((printer) => printer.id === active.id);
      const newIndex = prev.findIndex((printer) => printer.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      data-testid="arrange-printers-overlay"
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="arrange-printers-title"
        className="w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <CardContent className="flex min-h-0 flex-col p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 id="arrange-printers-title" className="text-lg font-semibold text-white">
              {title}
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-bambu-gray hover:text-white"
              aria-label={t('common.close', 'Close')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToList]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={items.map((printer) => printer.id)} strategy={verticalListSortingStrategy}>
              <div
                ref={listRef}
                className="min-h-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto pr-1"
              >
                {items.map((printer, index) => (
                  <SortablePrinterRow
                    key={printer.id}
                    printer={printer}
                    position={index + 1}
                    onMoveBy={(delta) => {
                      setItems((prev) => movePrinterInOrder(prev, printer.id, delta));
                    }}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          <div className="mt-4 flex justify-end border-t border-bambu-dark-tertiary pt-4">
            <Button type="button" onClick={apply}>{t('common.done', 'Done')}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
