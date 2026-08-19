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

export function ProductionParameterDiffTable({ rows }: { rows: ProductionParameterDiff[] }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-lg border border-bambu-dark-tertiary">
      <table className="w-full text-sm">
        <thead className="bg-bambu-dark text-bambu-gray">
          <tr>
            <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.parameter')}</th>
            <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.lockedValue')}</th>
            <th className="text-left px-3 py-2 font-medium">{t('fileManager.production.incomingValue')}</th>
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
