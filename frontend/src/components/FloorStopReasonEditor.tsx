import type { TFunction } from 'i18next';
import type { FloorStopReasonCode } from '../api/client';
import { FLOOR_STOP_REASON_OPTIONS } from './floorStopReasons';

export function FloorStopReasonEditor({
  isFailure,
  questionKey,
  questionFallback,
  selectedReason,
  reasonText,
  busy,
  onSelect,
  onReasonTextChange,
  onCancel,
  onSave,
  t,
}: {
  isFailure: boolean;
  /** Override the default failure/stop question (e.g. plate failure). */
  questionKey?: string;
  questionFallback?: string;
  selectedReason: FloorStopReasonCode | null;
  reasonText: string;
  busy: boolean;
  onSelect: (reason: FloorStopReasonCode) => void;
  onReasonTextChange: (text: string) => void;
  onCancel: () => void;
  onSave: () => void;
  t: TFunction;
}) {
  const canSave = selectedReason !== null && (selectedReason !== 'other' || reasonText.trim().length > 0);
  const question =
    questionKey && questionFallback
      ? t(questionKey, questionFallback)
      : isFailure
        ? t('floor.failureReasonQuestion', 'Why did this print fail?')
        : t('floor.stopReasonQuestion', 'Why was this print stopped?');

  return (
    <div className="mt-4 border-t border-bambu-dark-tertiary pt-4">
      <p className="text-sm font-semibold text-white">{question}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {FLOOR_STOP_REASON_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={selectedReason === option.value}
            onClick={() => onSelect(option.value)}
            className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
              selectedReason === option.value
                ? 'border-bambu-green bg-bambu-green/10 text-bambu-green'
                : 'border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray-light hover:border-bambu-green/50 hover:text-white'
            }`}
          >
            {t(option.key, option.fallback)}
          </button>
        ))}
      </div>
      {selectedReason === 'other' && (
        <textarea
          value={reasonText}
          onChange={(event) => onReasonTextChange(event.target.value)}
          rows={3}
          maxLength={500}
          autoFocus
          placeholder={
            isFailure
              ? t('floor.failureReasonOtherPlaceholder', 'Describe why the print failed…')
              : t('floor.stopReasonOtherPlaceholder', 'Describe why the print was stopped…')
          }
          className="mt-3 w-full resize-y rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
        />
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg bg-bambu-dark-tertiary px-3 py-2 text-xs text-white hover:bg-bambu-dark disabled:opacity-50"
        >
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave || busy}
          className="rounded-lg bg-bambu-green px-3 py-2 text-xs font-medium text-white hover:bg-bambu-green-light disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
        </button>
      </div>
    </div>
  );
}
