import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, RotateCcw, Save, Trash2, Loader2 } from 'lucide-react';

import { api } from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { formatFileSize } from '../utils/file';
import { parseUTCDate } from '../utils/date';

function formatRelativeDays(iso: string): string {
  const target = parseUTCDate(iso);
  if (!target) return '';
  const days = Math.ceil((target.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return days <= 0 ? 'any moment' : days === 1 ? '1 day' : `${days} days`;
}

function formatDeletedAt(iso: string): string {
  const date = parseUTCDate(iso);
  return date ? date.toLocaleString() : iso;
}

type PendingAction =
  | { type: 'delete'; id: number; filename: string }
  | { type: 'empty' }
  | { type: 'bulkDelete'; count: number }
  | null;

export function LibraryTrashPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, authEnabled } = useAuth();
  const [pending, setPending] = useState<PendingAction>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const isAdmin = !authEnabled || hasPermission('library:purge');

  const trashQuery = useQuery({
    queryKey: ['library-trash'],
    queryFn: () => api.listLibraryTrash(200, 0),
  });

  const settingsQuery = useQuery({
    queryKey: ['library-trash-settings'],
    queryFn: () => api.getLibraryTrashSettings(),
    enabled: isAdmin,
  });

  const [retentionDraft, setRetentionDraft] = useState<number | null>(null);
  useEffect(() => {
    if (settingsQuery.data && retentionDraft === null) {
      setRetentionDraft(settingsQuery.data.retention_days);
    }
  }, [settingsQuery.data, retentionDraft]);

  const updateRetentionMutation = useMutation({
    mutationFn: (days: number) => {
      // Preserve current auto-purge config — this control only touches retention.
      const current = settingsQuery.data;
      return api.updateLibraryTrashSettings({
        retention_days: days,
        auto_purge_enabled: current?.auto_purge_enabled ?? false,
        auto_purge_days: current?.auto_purge_days ?? 90,
        auto_purge_include_never_printed: current?.auto_purge_include_never_printed ?? true,
      });
    },
    onSuccess: (res) => {
      showToast(t('libraryTrash.toast.retentionSaved', { days: res.retention_days }), 'success');
      queryClient.invalidateQueries({ queryKey: ['library-trash-settings'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash'] });
    },
    onError: (e: Error) => showToast(e.message || t('libraryTrash.toast.retentionFailed'), 'error'),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => api.restoreLibraryTrash(id),
    onSuccess: () => {
      showToast(t('libraryTrash.toast.restored'), 'success');
      queryClient.invalidateQueries({ queryKey: ['library-trash'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
    },
    onError: (e: Error) => showToast(e.message || t('libraryTrash.toast.restoreFailed'), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.hardDeleteLibraryTrash(id),
    onSuccess: () => {
      showToast(t('libraryTrash.toast.purged'), 'success');
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ['library-trash'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
    },
    onError: (e: Error) => showToast(e.message || t('libraryTrash.toast.purgeFailed'), 'error'),
  });

  const emptyMutation = useMutation({
    mutationFn: () => api.emptyLibraryTrash(),
    onSuccess: (result) => {
      showToast(t('libraryTrash.toast.emptied', { count: result.deleted }), 'success');
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ['library-trash'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
    },
    onError: (e: Error) => showToast(e.message || t('libraryTrash.toast.emptyFailed'), 'error'),
  });

  // Bulk restore / delete run the existing per-item endpoints in parallel.
  // The backend has no bulk endpoints (and given typical trash sizes of
  // dozens of files, spinning up a Promise.all is fast enough that a new
  // endpoint would be gratuitous).
  const bulkRestoreMutation = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => api.restoreLibraryTrash(id))),
    onSuccess: (_, ids) => {
      showToast(t('libraryTrash.toast.bulkRestored', { count: ids.length }), 'success');
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['library-trash'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
    },
    onError: (e: Error) => showToast(e.message || t('libraryTrash.toast.restoreFailed'), 'error'),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => api.hardDeleteLibraryTrash(id))),
    onSuccess: (_, ids) => {
      showToast(t('libraryTrash.toast.bulkPurged', { count: ids.length }), 'success');
      setSelected(new Set());
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ['library-trash'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
    },
    onError: (e: Error) => showToast(e.message || t('libraryTrash.toast.purgeFailed'), 'error'),
  });

  const items = useMemo(() => trashQuery.data?.items ?? [], [trashQuery.data?.items]);
  const retentionDays = trashQuery.data?.retention_days ?? 30;
  const totalBytes = useMemo(() => items.reduce((sum, i) => sum + i.file_size, 0), [items]);
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const someSelected = selected.size > 0 && !allSelected;
  const confirmBusy = deleteMutation.isPending || emptyMutation.isPending || bulkDeleteMutation.isPending;

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))));
  };

  const handleConfirm = () => {
    if (!pending) return;
    if (pending.type === 'delete') {
      deleteMutation.mutate(pending.id);
    } else if (pending.type === 'bulkDelete') {
      bulkDeleteMutation.mutate(Array.from(selected));
    } else {
      emptyMutation.mutate();
    }
  };

  const checkboxClass =
    'rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green cursor-pointer';

  return (
    <div className="p-4 md:p-8 min-h-[calc(100vh-64px)] flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Link
            to="/files"
            className="text-bambu-gray hover:text-white hover:bg-bambu-dark p-1 rounded transition-colors"
            title={t('libraryTrash.backToFiles')}
            aria-label={t('libraryTrash.backToFiles')}
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              <Trash2 className="w-7 h-7 text-bambu-green" />
              {t('libraryTrash.title')}
            </h1>
            <p className="text-bambu-gray mt-1">
              {isAdmin
                ? t('libraryTrash.subtitleAdmin', { days: retentionDays })
                : t('libraryTrash.subtitleUser', { days: retentionDays })}
            </p>
          </div>
        </div>
        {items.length > 0 && (
          <Button variant="danger" onClick={() => setPending({ type: 'empty' })}>
            <Trash2 className="w-4 h-4 mr-2" />
            {t('libraryTrash.emptyTrash')}
          </Button>
        )}
      </div>

      {isAdmin && settingsQuery.data && (
        <div className="flex flex-wrap items-center gap-3 mb-6 p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary">
          <label htmlFor="retention-days" className="text-sm font-medium text-white">
            {t('libraryTrash.retentionLabel')}
          </label>
          <input
            id="retention-days"
            type="number"
            min={1}
            max={365}
            value={retentionDraft ?? settingsQuery.data.retention_days}
            onChange={(e) =>
              setRetentionDraft(Math.max(1, Math.min(365, parseInt(e.target.value || '0', 10) || 0)))
            }
            className="w-20 bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-bambu-green"
          />
          <span className="text-sm text-bambu-gray">{t('libraryTrash.days')}</span>
          <Button
            variant="secondary"
            onClick={() => retentionDraft != null && updateRetentionMutation.mutate(retentionDraft)}
            disabled={
              updateRetentionMutation.isPending ||
              retentionDraft == null ||
              retentionDraft === settingsQuery.data.retention_days
            }
            className="ml-auto"
          >
            {updateRetentionMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            {t('common.save')}
          </Button>
        </div>
      )}

      {trashQuery.isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
            <p className="text-sm text-bambu-gray">{t('libraryTrash.loading')}</p>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-16">
          <div className="p-4 bg-bambu-dark rounded-2xl mb-4">
            <Trash2 className="w-12 h-12 text-bambu-gray/50" />
          </div>
          <h3 className="text-lg font-medium text-white mb-2">{t('libraryTrash.empty')}</h3>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4 p-2 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary">
            <span className="text-sm text-bambu-gray px-2">
              {t('libraryTrash.summary', { count: items.length, size: formatFileSize(totalBytes) })}
            </span>
            {selected.size > 0 && (
              <>
                <span className="text-sm text-bambu-gray">
                  {t('libraryTrash.selectionCount', { count: selected.size })}
                </span>
                <div className="hidden sm:block flex-1" />
                <div className="w-full sm:w-auto flex flex-wrap items-center gap-2 mt-2 sm:mt-0">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => bulkRestoreMutation.mutate(Array.from(selected))}
                    disabled={bulkRestoreMutation.isPending}
                  >
                    {bulkRestoreMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <RotateCcw className="w-4 h-4 mr-1" />
                    )}
                    {t('libraryTrash.bulkRestore')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setPending({ type: 'bulkDelete', count: selected.size })}
                    disabled={bulkDeleteMutation.isPending}
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    {t('libraryTrash.bulkPurge')}
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-bambu-gray font-medium border-b border-bambu-dark-tertiary">
                <tr>
                  <th className="px-4 py-2 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={toggleAll}
                      aria-label={t('libraryTrash.selectAll')}
                      className={checkboxClass}
                    />
                  </th>
                  <th className="px-4 py-2">{t('libraryTrash.col.filename')}</th>
                  <th className="px-4 py-2">{t('libraryTrash.col.folder')}</th>
                  <th className="px-4 py-2 text-right">{t('libraryTrash.col.size')}</th>
                  <th className="px-4 py-2 whitespace-nowrap">{t('libraryTrash.col.deleted')}</th>
                  <th className="px-4 py-2 whitespace-nowrap">{t('libraryTrash.col.autoPurge')}</th>
                  {isAdmin && <th className="px-4 py-2">{t('libraryTrash.col.owner')}</th>}
                  <th className="px-4 py-2 text-right">{t('libraryTrash.col.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bambu-dark-tertiary">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-bambu-dark-tertiary/50 transition-colors">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggleOne(item.id)}
                        aria-label={t('libraryTrash.selectOne', { filename: item.filename })}
                        className={checkboxClass}
                      />
                    </td>
                    <td
                      className="px-4 py-3 text-white truncate max-w-md"
                      title={item.filename}
                    >
                      {item.filename}
                    </td>
                    <td className="px-4 py-3 text-bambu-gray">{item.folder_name ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-bambu-gray tabular-nums whitespace-nowrap">
                      {formatFileSize(item.file_size)}
                    </td>
                    <td className="px-4 py-3 text-bambu-gray whitespace-nowrap">
                      {formatDeletedAt(item.deleted_at)}
                    </td>
                    <td className="px-4 py-3 text-bambu-gray whitespace-nowrap">
                      <span title={formatDeletedAt(item.auto_purge_at)}>
                        {t('libraryTrash.autoPurgeIn', { when: formatRelativeDays(item.auto_purge_at) })}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-bambu-gray">
                        {item.created_by_username ?? '—'}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => restoreMutation.mutate(item.id)}
                          disabled={restoreMutation.isPending}
                        >
                          <RotateCcw className="w-4 h-4 mr-1" />
                          {t('libraryTrash.restore')}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setPending({ type: 'delete', id: item.id, filename: item.filename })}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="w-4 h-4 mr-1" />
                          {t('libraryTrash.purgeNow')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {pending && (
        <ConfirmModal
          onCancel={() => {
            if (!confirmBusy) setPending(null);
          }}
          onConfirm={handleConfirm}
          title={
            pending.type === 'delete'
              ? t('libraryTrash.confirm.purgeTitle')
              : pending.type === 'bulkDelete'
                ? t('libraryTrash.confirm.bulkPurgeTitle')
                : t('libraryTrash.confirm.emptyTitle')
          }
          message={
            pending.type === 'delete'
              ? t('libraryTrash.confirm.purgeBody', { filename: pending.filename })
              : pending.type === 'bulkDelete'
                ? t('libraryTrash.confirm.bulkPurgeBody', { count: pending.count })
                : t('libraryTrash.confirm.emptyBody', { count: items.length })
          }
          confirmText={t('libraryTrash.confirm.cta')}
          variant="danger"
          isLoading={confirmBusy}
        />
      )}

      {trashQuery.isError && (
        <div className="mt-4 text-sm text-red-400 flex items-center gap-3">
          {(trashQuery.error as Error | null)?.message ?? t('libraryTrash.loadError')}
          <Button variant="secondary" onClick={() => navigate('/files')}>
            {t('libraryTrash.backToFiles')}
          </Button>
        </div>
      )}
    </div>
  );
}
