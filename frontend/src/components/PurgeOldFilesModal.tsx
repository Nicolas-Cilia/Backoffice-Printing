import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react';

import { api } from '../api/client';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import { formatFileSize } from '../utils/file';

interface PurgeOldFilesModalProps {
  onClose: () => void;
}

const DEFAULT_DAYS = 90;

export function PurgeOldFilesModal({ onClose }: PurgeOldFilesModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [days, setDays] = useState(DEFAULT_DAYS);
  const [includeNeverPrinted, setIncludeNeverPrinted] = useState(true);

  // Debounce the preview query so dragging a slider isn't a DoS.
  const [debouncedDays, setDebouncedDays] = useState(days);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedDays(days), 300);
    return () => window.clearTimeout(handle);
  }, [days]);

  const previewQuery = useQuery({
    queryKey: ['library-purge-preview', debouncedDays, includeNeverPrinted],
    queryFn: () => api.previewLibraryPurge(debouncedDays, includeNeverPrinted),
    enabled: debouncedDays >= 1,
  });

  const purgeMutation = useMutation({
    mutationFn: () => api.executeLibraryPurge(days, includeNeverPrinted),
    onSuccess: (res) => {
      showToast(t('libraryPurge.toast.success', { count: res.moved_to_trash }), 'success');
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      onClose();
    },
    onError: (e: Error) => showToast(e.message || t('libraryPurge.toast.failed'), 'error'),
  });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !purgeMutation.isPending) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, purgeMutation.isPending]);

  const preview = previewQuery.data;
  const count = preview?.count ?? 0;
  const totalBytes = preview?.total_bytes ?? 0;
  const canConfirm = count > 0 && !purgeMutation.isPending;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-lg border border-bambu-dark-tertiary max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between shrink-0">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-bambu-green" />
            {t('libraryPurge.title')}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-bambu-dark rounded"
            aria-label={t('common.close')}
            disabled={purgeMutation.isPending}
          >
            <X className="w-5 h-5 text-bambu-gray" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <p className="text-sm text-bambu-gray">
            {t('libraryPurge.description')}
          </p>

          <div>
            <label htmlFor="purge-days" className="block text-sm font-medium text-white mb-1">
              {t('libraryPurge.ageLabel')}
            </label>
            <div className="flex items-center gap-3">
              <input
                id="purge-days"
                type="number"
                min={1}
                max={3650}
                value={days}
                onChange={(e) => setDays(Math.max(1, Math.min(3650, parseInt(e.target.value || '0', 10) || 0)))}
                className="w-24 bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
              />
              <span className="text-sm text-bambu-gray">{t('libraryPurge.days')}</span>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeNeverPrinted}
              onChange={(e) => setIncludeNeverPrinted(e.target.checked)}
              className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
            />
            <span className="text-sm text-white">{t('libraryPurge.includeNeverPrinted')}</span>
          </label>

          <div className="rounded border border-bambu-dark-tertiary bg-bambu-dark p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-bambu-gray mb-2">
              {t('libraryPurge.effectsTitle')}
            </div>
            <ul className="text-sm text-bambu-gray space-y-1 list-disc pl-4">
              <li>{t('libraryPurge.effect1')}</li>
              <li>{t('libraryPurge.effect2')}</li>
              <li>{t('libraryPurge.effect3')}</li>
              <li>{t('libraryPurge.effect4')}</li>
            </ul>
          </div>

          <div className="rounded border border-bambu-dark-tertiary bg-bambu-dark p-3">
            {previewQuery.isLoading || previewQuery.isFetching ? (
              <div className="flex items-center gap-2 text-sm text-bambu-gray">
                <Loader2 className="w-4 h-4 animate-spin" /> {t('libraryPurge.previewLoading')}
              </div>
            ) : previewQuery.isError ? (
              <div className="text-sm text-red-400">
                {(previewQuery.error as Error | null)?.message ?? t('libraryPurge.previewFailed')}
              </div>
            ) : (
              <div className="text-sm text-white">
                <div className="font-medium">
                  {t('libraryPurge.previewSummary', { count, size: formatFileSize(totalBytes) })}
                </div>
                {preview?.sample_filenames && preview.sample_filenames.length > 0 && (
                  <ul className="mt-2 text-xs text-bambu-gray space-y-0.5 list-disc pl-4">
                    {preview.sample_filenames.map((name) => (
                      <li key={name} className="truncate">{name}</li>
                    ))}
                    {count > preview.sample_filenames.length && (
                      <li className="list-none italic text-bambu-gray">
                        {t('libraryPurge.andMore', { count: count - preview.sample_filenames.length })}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-2 items-start text-xs text-amber-400 bg-amber-900/20 rounded px-3 py-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{t('libraryPurge.warning')}</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-bambu-dark-tertiary shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={purgeMutation.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={!canConfirm}
            onClick={() => purgeMutation.mutate()}
          >
            {purgeMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
                {t('libraryPurge.purging')}
              </>
            ) : (
              t('libraryPurge.confirmCta', { count })
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
