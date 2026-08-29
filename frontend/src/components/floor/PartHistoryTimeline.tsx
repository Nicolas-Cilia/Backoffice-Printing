import { useTranslation } from 'react-i18next';
import type { FloorInventoryPartEvent } from '../../api/client';
import { formatFloorDate } from '../../utils/floorScan';
import {
  kitAssignedBranches,
  partEventDotClass,
  partEventLabel,
  unitLinkedTargets,
  type PartTimelineKitBranch,
  type PartTimelineUnitLink,
} from '../../utils/floorPartHistory';

const LINK_CLASS =
  'font-mono text-bambu-green-light underline-offset-2 hover:underline focus:outline-none focus-visible:underline';

export type PartHistoryTimelineHandlers = {
  onOpenSticker?: (sticker: string) => void;
  onOpenBinBatch?: (batchId: number, payload: string | null) => void;
  onOpenSerial?: (serial: string, unitId: number | null) => void;
};

export function PartHistoryTimeline({
  events,
  partCode,
  handlers,
  compact = false,
}: {
  events: FloorInventoryPartEvent[];
  partCode: string | null | undefined;
  handlers?: PartHistoryTimelineHandlers;
  /** Slightly larger type for the floor scan panel. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const titleClass = compact ? 'text-white' : 'text-base text-white';
  const timeClass = compact ? 'text-xs text-bambu-gray' : 'text-sm text-bambu-gray';

  return (
    <ol className="space-y-3">
      {events.map((event) => {
        const branches =
          event.action === 'kit_assigned' ? kitAssignedBranches(event.details) : null;
        const unitLinks =
          event.action === 'unit_linked'
            ? unitLinkedTargets(
                event.details,
                partCode === 'TOP' ? 'top' : partCode === 'BOT' ? 'bottom' : null,
              )
            : [];

        if (branches) {
          const knob = branches.find((branch) => branch.slot === 'KNB');
          const button = branches.find((branch) => branch.slot === 'BUT');
          return (
            <li
              key={event.id}
              className="relative min-h-[7rem] pl-7 text-sm"
              aria-label={t('floor.inventoryKitForkLabel', 'Kit linked · knob and button')}
            >
              {/*
                Wishbone fork: origin sits on the main timeline; both curves leave
                its right edge and meet the tip circles on their left edge.
              */}
              <div className="relative -ml-7 h-28 w-full">
                {/* Curves only — dots reuse the same spans as the rest of the timeline */}
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute left-0 top-0 h-28 w-16 text-bambu-dark-tertiary"
                  viewBox="0 0 64 112"
                  fill="none"
                >
                  <path
                    d="M8 56 C 28 56, 28 22, 48 22"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M8 56 C 28 56, 28 90, 48 90"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="absolute left-1 top-14 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-500" />
                <span className="absolute left-[3.25rem] top-[1.375rem] z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-500" />
                <span className="absolute left-[3.25rem] top-[5.625rem] z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-500" />

                {knob && (
                  <KitBranchTip
                    className="absolute left-[3.75rem] top-[0.55rem] z-10"
                    title={t('floor.inventoryKitKnobLinked', 'Knob linked')}
                    branch={knob}
                    occurredAt={event.occurred_at}
                    handlers={handlers}
                  />
                )}
                {button && (
                  <KitBranchTip
                    className="absolute left-[3.75rem] top-[4.85rem] z-10"
                    title={t('floor.inventoryKitButtonLinked', 'Button linked')}
                    branch={button}
                    occurredAt={event.occurred_at}
                    handlers={handlers}
                  />
                )}
              </div>
            </li>
          );
        }

        return (
          <li key={event.id} className="relative pl-7 text-sm">
            <span
              className={`absolute left-1 top-1.5 z-10 h-2 w-2 -translate-x-1/2 rounded-full ${partEventDotClass(event.action)}`}
            />
            <p className={titleClass}>{partEventLabel(event, partCode, t)}</p>
            <p className={timeClass}>
              {formatFloorDate(event.occurred_at, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>

            {unitLinks.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {unitLinks.map((link) => (
                  <li key={`${link.kind}-${link.label}`}>
                    <UnitLinkButton link={link} handlers={handlers} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function KitBranchTip({
  className,
  title,
  branch,
  occurredAt,
  handlers,
}: {
  className?: string;
  title: string;
  branch: PartTimelineKitBranch;
  occurredAt: string;
  handlers?: PartHistoryTimelineHandlers;
}) {
  return (
    <div className={`min-w-0 leading-tight ${className ?? ''}`}>
      <p className="text-white">{title}</p>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        {handlers?.onOpenBinBatch ? (
          <button
            type="button"
            className={LINK_CLASS}
            onClick={() => handlers.onOpenBinBatch?.(branch.batchId, branch.payload)}
          >
            {branch.label}
          </button>
        ) : (
          <span className="font-mono text-bambu-gray-light">{branch.label}</span>
        )}
        <span className="text-bambu-gray">
          {formatFloorDate(occurredAt, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </span>
      </p>
    </div>
  );
}

function UnitLinkButton({
  link,
  handlers,
}: {
  link: PartTimelineUnitLink;
  handlers?: PartHistoryTimelineHandlers;
}) {
  const { t } = useTranslation();
  const prefix =
    link.kind === 'serial'
      ? t('floor.inventoryUnitLinkSerial', 'Serial')
      : link.kind === 'sticker'
        ? t('floor.inventoryUnitLinkHousing', 'Housing')
        : t('floor.inventoryUnitLinkKit', 'Kit');

  const prefixEl = <span className="mr-1 text-xs text-bambu-gray">{prefix}</span>;

  if (link.kind === 'serial' && handlers?.onOpenSerial && link.serial) {
    return (
      <span className="inline-flex items-baseline">
        {prefixEl}
        <button
          type="button"
          className={LINK_CLASS}
          onClick={() => handlers.onOpenSerial?.(link.serial!, link.unitId ?? null)}
        >
          {link.label}
        </button>
      </span>
    );
  }
  if (link.kind === 'sticker' && handlers?.onOpenSticker && link.sticker) {
    return (
      <span className="inline-flex items-baseline">
        {prefixEl}
        <button
          type="button"
          className={LINK_CLASS}
          onClick={() => handlers.onOpenSticker?.(link.sticker!)}
        >
          {link.label}
        </button>
      </span>
    );
  }
  if (link.kind === 'kit' && handlers?.onOpenBinBatch && link.batchId != null) {
    return (
      <span className="inline-flex items-baseline">
        {prefixEl}
        <button
          type="button"
          className={LINK_CLASS}
          onClick={() => handlers.onOpenBinBatch?.(link.batchId!, link.payload ?? null)}
        >
          {link.label}
        </button>
      </span>
    );
  }
  return (
    <span className="font-mono text-bambu-gray-light">
      {prefixEl}
      {link.label}
    </span>
  );
}
