import { CheckCircle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProductionParameterDiff } from '../../api/client';
import { formatSpecValue, specLabelKey } from '../../utils/productionSpecs';

function formatDiffValue(key: string, value: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (value === null || value === undefined) return '—';
  return formatSpecValue(key, value, t);
}

function formatDiffKey(key: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const labelKey = specLabelKey(key);
  return labelKey ? t(labelKey) : key;
}

export function collectParameterNotes(
  rows: ProductionParameterDiff[],
  notes: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.match) continue;
    const text = (notes[row.key] ?? '').trim();
    if (text) out[row.key] = text;
  }
  return out;
}

export function mismatchNotesComplete(
  rows: ProductionParameterDiff[],
  notes: Record<string, string>,
): boolean {
  return rows.every((row) => row.match || (notes[row.key] ?? '').trim().length > 0);
}

interface ProductionParameterDiffTableProps {
  rows: ProductionParameterDiff[];
  notes?: Record<string, string>;
  onNoteChange?: (key: string, value: string) => void;
}

export function ProductionParameterDiffTable({
  rows,
  notes,
  onNoteChange,
}: ProductionParameterDiffTableProps) {
  const { t } = useTranslation();
  const showNoteColumn = Boolean(onNoteChange) || rows.some((row) => Boolean(row.note?.trim()));

  return (
    <div className="overflow-x-auto rounded-lg border border-bambu-dark-tertiary">
      <table className="w-full text-sm">
        <thead className="bg-bambu-dark text-bambu-gray">
          <tr>
            <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.parameter')}</th>
            <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.lockedValue')}</th>
            <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.incomingValue')}</th>
            {showNoteColumn && (
              <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.parameterNote')}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row: ProductionParameterDiff) => (
            <tr
              key={row.key}
              className={row.match ? 'bg-green-500/10' : 'bg-red-500/10'}
            >
              <td className="px-3 py-2 text-white text-xs">{formatDiffKey(row.key, t)}</td>
              <td className="px-3 py-2 text-bambu-gray text-xs">{formatDiffValue(row.key, row.locked, t)}</td>
              <td className="px-3 py-2 text-xs">
                <span className="inline-flex items-center gap-1">
                  {row.match ? (
                    <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-500" />
                  )}
                  <span className={row.match ? 'text-green-400' : 'text-red-400'}>
                    {formatDiffValue(row.key, row.incoming, t)}
                  </span>
                </span>
                {!showNoteColumn && !row.match && row.note?.trim() ? (
                  <p className="mt-1 text-[11px] text-bambu-gray">{row.note}</p>
                ) : null}
              </td>
              {showNoteColumn && (
                <td className="px-3 py-2 text-xs align-top min-w-[10rem]">
                  {row.match ? null : onNoteChange ? (
                    <textarea
                      value={notes?.[row.key] ?? ''}
                      onChange={(e) => onNoteChange(row.key, e.target.value)}
                      placeholder={t('fileManager.production.parameterNotePlaceholder')}
                      rows={2}
                      aria-label={t('fileManager.production.parameterNote')}
                      className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1.5 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
                    />
                  ) : row.note?.trim() ? (
                    <p className="text-bambu-gray">{row.note}</p>
                  ) : null}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
