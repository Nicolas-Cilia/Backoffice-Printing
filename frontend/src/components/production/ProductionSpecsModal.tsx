import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  formatSpecValue,
  formatSupportsValue,
  orderedSpecEntries,
  specLabelKey,
} from '../../utils/productionSpecs';

interface ProductionSpecsModalProps {
  title: string;
  specs: Record<string, unknown>;
  notes?: Record<string, string> | null;
  onClose: () => void;
}

export function ProductionSpecsModal({
  title,
  specs,
  notes,
  onClose,
}: ProductionSpecsModalProps) {
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
            const note = notes?.[key]?.trim();
            return (
              <div
                key={key}
                className="flex items-baseline justify-between gap-4 py-1.5 border-b border-bambu-dark-tertiary last:border-0"
              >
                <dt className="text-xs text-bambu-gray">{labelKey ? t(labelKey) : key}</dt>
                <dd className="text-xs text-white text-right font-medium">
                  {key === 'enable_support' ? formatSupportsValue(specs, t) : formatSpecValue(key, value, t)}
                  {note ? (
                    <span className="block mt-0.5 text-[11px] font-normal text-amber-400">
                      {t('fileManager.production.mismatchNote')}: {note}
                    </span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}
