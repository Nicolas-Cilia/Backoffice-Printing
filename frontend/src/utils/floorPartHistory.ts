import type { FloorInventoryPart, FloorInventoryPartEvent } from '../api/client';

/** Badge styling shared by Fit Check / Visual QC pass and finishing-step passes. */
export const FLOOR_PASS_BADGE_CLASS =
  'border border-green-600 bg-green-100 text-green-800 shadow-sm shadow-green-500/20 dark:border-green-400/50 dark:bg-green-500/20 dark:text-green-300';

export const FLOOR_PASS_EVENT_DOT_CLASS = 'bg-green-500';

export const FLOOR_PASS_TEXT_CLASS = 'text-green-600 dark:text-green-400';

const FLOOR_PASS_PART_ACTIONS = new Set([
  'fit_check',
  'fit_checked',
  'ready_for_production',
  'support_removed',
  'overhang_removed',
  'hot_air_removed',
]);

export function isFloorPassPartAction(action: string): boolean {
  return FLOOR_PASS_PART_ACTIONS.has(action);
}

export function isFloorPassBinStatus(status: string): boolean {
  return status === 'visual_qc_passed' || status === 'ready_for_production';
}

export function formatCustomStatus(status: string) {
  if (status === 'ready_for_production') {
    return 'Staged for Production';
  }
  if (status === 'support_removed') return 'Support Removed';
  if (status === 'overhang_removed') return 'Overhang Removed';
  if (status === 'hot_air_removed') return 'Hot Air Removed';
  if (status === 'fit_checked' || status === 'fit_check') return 'Fit Check Pass';
  if (status === 'needs_matching') return 'Needs matching';
  if (status === 'wip' || status === 'in_wip') return 'In WIP';
  return status
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function compactEventReason(value: string) {
  const compact = value.trim().replace(/\s+/g, ' ');
  return compact.length > 56 ? `${compact.slice(0, 53)}…` : compact;
}

type PartHistoryT = (key: string, fallback: string, options?: Record<string, unknown>) => string;

/** Human-readable label for one part audit event — shared by Part history and scan page. */
export function partEventLabel(
  event: FloorInventoryPartEvent,
  partCode: string | null | undefined,
  t: PartHistoryT,
) {
  const archiveId = event.details?.archive_id;
  if (event.details?.status_override === true) {
    return t('floor.inventoryEventStatusOverride', 'Status overridden to {{status}}', {
      status: formatCustomStatus(event.action),
    });
  }
  switch (event.action) {
    case 'enrolled':
      return archiveId
        ? t('floor.inventoryEventEnrolledLinked', 'Sticker enrolled · linked at harvest')
        : t('floor.inventoryEventEnrolledNoJob', 'Sticker enrolled · no job found at harvest');
    case 'scanned':
      return t('floor.inventoryEventScanned', 'Scanned at floor');
    case 'relinked':
      return t('floor.inventoryEventRelinked', 'Matched to completed job');
    case 'relinked_by_scan':
      return t('floor.inventoryEventRelinkedByScan', 'Linked by scanner');
    case 'fit_check':
    case 'fit_checked':
      return partCode === 'BUT' || partCode === 'KNB'
        ? t('floor.inventoryEventVisualQcPassed', 'Visual QC pass')
        : t('floor.inventoryEventFitChecked', 'Fit Check Pass');
    case 'rework':
    case 'sanding': {
      const reasonCode = event.details?.reason_code;
      const reasonText = event.details?.reason_text;
      const errorName = event.details?.error_name;
      const reasonLabel =
        typeof errorName === 'string' && errorName
          ? errorName
          : typeof reasonCode === 'string' && reasonCode !== 'other'
            ? reasonCode.replaceAll('_', ' ')
            : null;
      const description =
        typeof reasonText === 'string' && reasonText.trim()
          ? compactEventReason(reasonText)
          : null;
      const reason = [reasonLabel, description].filter(Boolean).join(' · ') || null;
      return reason
        ? t('floor.inventoryEventReworkWithReason', 'Sent to Rework · {{reason}}', { reason })
        : t('floor.inventoryEventRework', 'Sent to Rework');
    }
    case 'discarded': {
      const errorName = typeof event.details?.error_name === 'string' ? event.details.error_name : null;
      const reasonText = typeof event.details?.reason_text === 'string' ? event.details.reason_text : null;
      const reason = [errorName, reasonText ? compactEventReason(reasonText) : null].filter(Boolean).join(' · ') || null;
      return reason
        ? t('floor.inventoryEventDiscardedWithReason', 'Discarded · {{reason}}', { reason })
        : t('floor.inventoryEventDiscarded', 'Discarded');
    }
    case 'cleanup':
    case 'cleaned_up':
      return t('floor.inventoryEventCleanedUp', 'Cleaned up');
    case 'support_removed':
      return t('floor.inventoryEventSupportRemoved', 'Support Removed');
    case 'overhang_removed':
      return t('floor.inventoryEventOverhangRemoved', 'Overhang Removed');
    case 'hot_air_removed':
      return t('floor.inventoryEventHotAirRemoved', 'Hot Air Removed');
    case 'ready_for_production':
      return t('floor.inventoryEventStagedForProduction', 'Staged for Production');
    case 'wip':
      return t('floor.inventoryEventInWip', 'In WIP');
    case 'archived':
      return t('floor.inventoryEventArchived', 'Archived from active view');
    case 'restored':
      return t('floor.inventoryEventRestored', 'Restored to active view');
    case 'unlinked': {
      const reasonCode = event.details?.reason_code;
      const reasonText = event.details?.reason_text;
      const reason =
        reasonCode === 'wrong_job'
          ? t('floor.inventoryUnlinkReasonWrongJob', 'Wrong job matched')
          : reasonCode === 'wrong_printer'
            ? t('floor.inventoryUnlinkReasonWrongPrinter', 'Wrong printer scanned')
            : reasonCode === 'other'
              ? (typeof reasonText === 'string' && reasonText) ||
                t('floor.inventoryReasonOther', 'Other')
              : null;
      return reason
        ? t('floor.inventoryEventUnlinkedWithReason', 'Job link removed · {{reason}}', { reason })
        : t('floor.inventoryEventUnlinked', 'Job link removed');
    }
    case 'sticker_replaced': {
      const previousCode = event.details?.previous_code;
      const newCode = event.details?.new_code;
      return typeof previousCode === 'string' && typeof newCode === 'string'
        ? t(
            'floor.inventoryEventStickerReplacedWithCodes',
            'Sticker replaced · {{previousCode}} → {{newCode}}',
            { previousCode, newCode },
          )
        : t('floor.inventoryEventStickerReplaced', 'Sticker replaced');
    }
    case 'part_code_assigned': {
      const assignedCode = event.details?.part_code;
      return typeof assignedCode === 'string'
        ? t('floor.inventoryEventPartCodeAssignedWithCode', 'Part code assigned · {{partCode}}', {
            partCode: assignedCode,
          })
        : t('floor.inventoryEventPartCodeAssigned', 'Part code assigned');
    }
    case 'part_code_changed': {
      const previousCode = event.details?.previous_code;
      const nextCode = event.details?.part_code;
      return typeof previousCode === 'string' && typeof nextCode === 'string'
        ? t(
            'floor.inventoryEventPartCodeChanged',
            'Part code changed · {{previousCode}} → {{partCode}}',
            { previousCode, partCode: nextCode },
          )
        : t('floor.inventoryEventPartCodeChangedGeneric', 'Part code changed');
    }
    case 'part_code_removed': {
      const previousCode = event.details?.previous_code;
      return typeof previousCode === 'string'
        ? t('floor.inventoryEventPartCodeRemovedWithCode', 'Part code removed · {{partCode}}', {
            partCode: previousCode,
          })
        : t('floor.inventoryEventPartCodeRemoved', 'Part code removed');
    }
    default:
      return event.action.replaceAll('_', ' ');
  }
}

/** Always includes enroll from the part row; merges API audit events on top. */
export function buildPartTimeline(
  part: Pick<FloorInventoryPart, 'id' | 'labeled_at' | 'archive_id'>,
  events: FloorInventoryPartEvent[],
): FloorInventoryPartEvent[] {
  const extras = events.filter(
    (event) => event.action !== 'enrolled' && event.action !== 'scanned',
  );
  const enrolledFromApi = events.find((event) => event.action === 'enrolled');
  const enrolled: FloorInventoryPartEvent = enrolledFromApi ?? {
    id: -part.id,
    action: 'enrolled',
    details: part.archive_id != null ? { archive_id: part.archive_id } : null,
    occurred_at: part.labeled_at,
  };
  return [enrolled, ...extras].sort(
    (left, right) =>
      new Date(left.occurred_at).getTime() - new Date(right.occurred_at).getTime(),
  );
}

export function partEventDotClass(action: string): string {
  if (action === 'enrolled' || action === 'relinked' || action === 'relinked_by_scan') {
    return 'bg-bambu-green';
  }
  if (isFloorPassPartAction(action)) {
    return FLOOR_PASS_EVENT_DOT_CLASS;
  }
  if (action === 'rework' || action === 'sanding') {
    return 'bg-orange-500';
  }
  if (action === 'discarded') {
    return 'bg-red-500';
  }
  return 'bg-bambu-gray';
}
