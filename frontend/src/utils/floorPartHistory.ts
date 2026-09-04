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

/**
 * The consuming TOP sticker recorded on a `consumed` bin event, if any.
 *
 * Kit assign / reassign write the pulling part's `part_sticker` into the event
 * details so bin history can read "Consumed by BBD-000000". Older events without
 * attribution return `null`, leaving a bare "Consumed".
 */
export function consumedBySticker(
  details: Record<string, unknown> | null | undefined,
): string | null {
  const sticker = details?.part_sticker;
  return typeof sticker === 'string' && sticker.trim() ? sticker.trim() : null;
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
    case 'kit_assigned':
      return t('floor.inventoryEventKitAssigned', 'Kit linked');
    case 'kit_reassigned': {
      const slot = event.details?.slot;
      const newBatchId = event.details?.new_batch_id;
      const slotLabel = slot === 'KNB' ? 'KNB' : slot === 'BUT' ? 'BUT' : null;
      const label = kitBatchDisplayLabel(event.details?.bin_payload, newBatchId);
      return slotLabel && label
        ? t('floor.inventoryEventKitReassignedTo', 'Kit reassigned · {{slot}} {{batch}}', {
            slot: slotLabel,
            batch: label,
          })
        : t('floor.inventoryEventKitReassigned', 'Kit reassigned');
    }
    case 'unit_linked': {
      const serial = event.details?.serial_code;
      return typeof serial === 'string' && serial.trim()
        ? t('floor.inventoryEventUnitLinkedToSerial', 'Unit linked · {{serial}}', {
            serial: serial.trim(),
          })
        : t('floor.inventoryEventUnitLinked', 'Unit linked');
    }
    case 'shipped':
      return t('floor.inventoryEventShipped', 'Shipped');
    case 'unit_unlinked': {
      if (event.details?.source === 'unit_replace') {
        const role = event.details?.role;
        return role === 'top'
          ? t('floor.inventoryEventUnitUnlinkedTopReplace', 'Top housing removed')
          : role === 'bottom'
            ? t('floor.inventoryEventUnitUnlinkedBottomReplace', 'Bottom housing removed')
            : t('floor.inventoryEventUnitUnlinkedReplace', 'Housing removed');
      }
      return t('floor.inventoryEventUnitUnlinked', 'Unit unlinked');
    }
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
    case 'bot_bin_loaded': {
      const binPayload = event.details?.bin_payload;
      return typeof binPayload === 'string' && binPayload.trim()
        ? t('floor.inventoryEventBotBinLoaded', 'Loaded into BOT bin · {{bin}}', { bin: binPayload.trim() })
        : t('floor.inventoryEventBotBinLoadedGeneric', 'Loaded into BOT bin');
    }
    default:
      return event.action.replaceAll('_', ' ');
  }
}

/**
 * Labels for the serial (unit) timeline — where the serial has been, not the
 * housings' finishing history. Omits the redundant "· SERIAL" suffix used on
 * part history when the viewer is already on that serial card.
 */
export function unitEventLabel(event: FloorInventoryPartEvent, t: PartHistoryT) {
  const details = event.details;
  switch (event.action) {
    case 'unit_linked': {
      if (details?.source === 'unit_replace') {
        const role = details?.role;
        return role === 'top'
          ? t('floor.unitEventTopReplaced', 'Top housing replaced')
          : role === 'bottom'
            ? t('floor.unitEventBottomReplaced', 'Bottom housing replaced')
            : t('floor.unitEventHousingReplaced', 'Housing replaced');
      }
      return t('floor.unitEventLinked', 'Linked');
    }
    case 'unit_unlinked': {
      if (details?.source === 'unit_replace') {
        const role = details?.role;
        return role === 'top'
          ? t('floor.unitEventTopRemoved', 'Top housing removed')
          : role === 'bottom'
            ? t('floor.unitEventBottomRemoved', 'Bottom housing removed')
            : t('floor.unitEventHousingRemoved', 'Housing removed');
      }
      return t('floor.unitEventUnlinked', 'Unlinked');
    }
    case 'shipped':
      return details?.source === 'serial_ready_to_ship'
        ? t('floor.unitEventReadyToShip', 'Ready to Ship')
        : t('floor.inventoryEventShipped', 'Shipped');
    case 'rework':
    case 'sanding': {
      const reasonCode = details?.reason_code;
      const reasonText = details?.reason_text;
      const errorName = details?.error_name;
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
    default:
      return partEventLabel(event, null, t);
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
  return [enrolled, ...extras].sort((left, right) => {
    const timeDelta =
      new Date(left.occurred_at).getTime() - new Date(right.occurred_at).getTime();
    if (timeDelta !== 0) return timeDelta;
    // Same-second WIP + kit_assigned: WIP is the scan action, kit is a side-effect.
    const rank = (action: string) => {
      if (action === 'wip' || action === 'in_wip') return 0;
      if (action === 'kit_assigned') return 1;
      if (action === 'unit_linked') return 2;
      if (action === 'shipped') return 3;
      return 4;
    };
    const rankDelta = rank(left.action) - rank(right.action);
    if (rankDelta !== 0) return rankDelta;
    return left.id - right.id;
  });
}

export function partEventDotClass(action: string): string {
  if (action === 'enrolled' || action === 'relinked' || action === 'relinked_by_scan') {
    return 'bg-bambu-green';
  }
  if (isFloorPassPartAction(action)) {
    return FLOOR_PASS_EVENT_DOT_CLASS;
  }
  if (action === 'wip' || action === 'in_wip') {
    return 'bg-sky-500';
  }
  if (action === 'kit_assigned' || action === 'unit_linked') {
    return 'bg-sky-500';
  }
  if (action === 'unit_unlinked') {
    return 'bg-bambu-gray';
  }
  if (action === 'rework' || action === 'sanding') {
    return 'bg-orange-500';
  }
  if (action === 'discarded') {
    return 'bg-red-500';
  }
  if (action === 'shipped') {
    return 'bg-sky-500';
  }
  return 'bg-bambu-gray';
}

/** Display label for a kit fill referenced from a part event (`BBN-KNB-1 #12`). */
export function kitBatchDisplayLabel(
  payload: unknown,
  batchId: unknown,
): string | null {
  if (typeof batchId !== 'number' || !Number.isFinite(batchId)) return null;
  const code = typeof payload === 'string' ? payload.trim().toUpperCase() : '';
  return code ? `${code} #${batchId}` : `#${batchId}`;
}

export type PartTimelineKitBranch = {
  slot: 'KNB' | 'BUT';
  batchId: number;
  label: string;
  payload: string | null;
};

/** Knob + button tips for a `kit_assigned` branch, when both batch ids are present. */
export function kitAssignedBranches(
  details: Record<string, unknown> | null | undefined,
): PartTimelineKitBranch[] | null {
  if (!details) return null;
  const knobId = details.kit_knob_batch_id;
  const buttonId = details.kit_button_batch_id;
  if (typeof knobId !== 'number' || typeof buttonId !== 'number') return null;
  const knobPayload =
    typeof details.knob_bin_payload === 'string' ? details.knob_bin_payload : null;
  const buttonPayload =
    typeof details.button_bin_payload === 'string' ? details.button_bin_payload : null;
  const knobLabel = kitBatchDisplayLabel(knobPayload, knobId);
  const buttonLabel = kitBatchDisplayLabel(buttonPayload, buttonId);
  if (!knobLabel || !buttonLabel) return null;
  return [
    { slot: 'KNB', batchId: knobId, label: knobLabel, payload: knobPayload },
    { slot: 'BUT', batchId: buttonId, label: buttonLabel, payload: buttonPayload },
  ];
}

export type PartTimelineUnitLink = {
  kind: 'serial' | 'sticker' | 'kit';
  label: string;
  serial?: string;
  unitId?: number | null;
  sticker?: string;
  batchId?: number;
  payload?: string | null;
};

/** Clickable peers recorded on a `unit_linked` event (serial, mate housing, kit). */
export function unitLinkedTargets(
  details: Record<string, unknown> | null | undefined,
  viewerRole: 'top' | 'bottom' | null,
): PartTimelineUnitLink[] {
  if (!details) return [];
  const links: PartTimelineUnitLink[] = [];
  const serial = typeof details.serial_code === 'string' ? details.serial_code.trim() : '';
  const unitId = typeof details.unit_id === 'number' ? details.unit_id : null;
  if (serial) {
    links.push({ kind: 'serial', label: serial, serial, unitId });
  }

  const role =
    viewerRole ??
    (details.role === 'top' || details.role === 'bottom' ? details.role : null);
  const topSticker = typeof details.top_sticker === 'string' ? details.top_sticker.trim() : '';
  const bottomSticker =
    typeof details.bottom_sticker === 'string' ? details.bottom_sticker.trim() : '';
  if (role === 'top' && bottomSticker) {
    links.push({ kind: 'sticker', label: bottomSticker, sticker: bottomSticker });
  } else if (role === 'bottom' && topSticker) {
    links.push({ kind: 'sticker', label: topSticker, sticker: topSticker });
  } else {
    if (topSticker) links.push({ kind: 'sticker', label: topSticker, sticker: topSticker });
    if (bottomSticker) links.push({ kind: 'sticker', label: bottomSticker, sticker: bottomSticker });
  }

  const knobId = details.kit_knob_batch_id;
  const buttonId = details.kit_button_batch_id;
  const knobPayload =
    typeof details.knob_bin_payload === 'string' ? details.knob_bin_payload : null;
  const buttonPayload =
    typeof details.button_bin_payload === 'string' ? details.button_bin_payload : null;
  const knobLabel = kitBatchDisplayLabel(knobPayload, knobId);
  const buttonLabel = kitBatchDisplayLabel(buttonPayload, buttonId);
  if (knobLabel && typeof knobId === 'number') {
    links.push({
      kind: 'kit',
      label: `KNB ${knobLabel}`,
      batchId: knobId,
      payload: knobPayload,
    });
  }
  if (buttonLabel && typeof buttonId === 'number') {
    links.push({
      kind: 'kit',
      label: `BUT ${buttonLabel}`,
      batchId: buttonId,
      payload: buttonPayload,
    });
  }
  return links;
}
