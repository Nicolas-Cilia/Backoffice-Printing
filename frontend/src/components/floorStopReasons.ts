import type { TFunction } from 'i18next';
import type { FloorStopReasonCode } from '../api/client';

export const FLOOR_STOP_REASON_OPTIONS: Array<{
  value: FloorStopReasonCode;
  key: string;
  fallback: string;
}> = [
  { value: 'first_layer_issue', key: 'floor.stopReasonFirstLayer', fallback: 'First layer issue' },
  { value: 'warping', key: 'floor.stopReasonWarping', fallback: 'Warping' },
  { value: 'layer_lines', key: 'floor.stopReasonLayerLines', fallback: 'Layer lines' },
  { value: 'filament_issue', key: 'floor.stopReasonFilament', fallback: 'Filament issue' },
  { value: 'other', key: 'floor.stopReasonOther', fallback: 'Other' },
];

export function floorStopReasonLabel(
  reasonCode: FloorStopReasonCode,
  reasonText: string | null,
  t: TFunction,
): string {
  if (reasonCode === 'other') return reasonText || t('floor.stopReasonOther', 'Other');
  const option = FLOOR_STOP_REASON_OPTIONS.find((candidate) => candidate.value === reasonCode);
  return option ? t(option.key, option.fallback) : reasonCode;
}
