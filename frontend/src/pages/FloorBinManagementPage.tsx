import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser, Link2Off, Loader2, Package } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, type FloorBinManagement } from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { useToast } from '../contexts/ToastContext';

function statusLabel(status: string): string {
  if (status === 'visual_qc_passed') return 'Visual QC passed';
  if (status === 'wip') return 'In WIP';
  if (status === 'harvested') return 'Awaiting visual QC';
  return status.replaceAll('_', ' ');
}

export function FloorBinManagementPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [unlinkTarget, setUnlinkTarget] = useState<FloorBinManagement | null>(null);

  const binsQuery = useQuery({
    queryKey: ['floor-bin-management'],
    queryFn: api.getFloorBinManagement,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['floor-bin-management'] });
  const overrideMutation = useMutation({
    mutationFn: ({ payload, remaining_quantity }: { payload: string; remaining_quantity: number }) =>
      api.overrideFloorBinQuantity({ payload, remaining_quantity }),
    onSuccess: async () => {
      await refresh();
      showToast(t('inventory.binQuantityUpdated', 'Bin quantity updated'), 'success');
    },
    onError: () => showToast(t('inventory.binQuantityUpdateFailed', 'Could not update bin quantity'), 'error'),
  });
  const unlinkMutation = useMutation({
    mutationFn: (payload: string) => api.unlinkFloorBin({ payload }),
    onSuccess: async () => {
      setUnlinkTarget(null);
      await refresh();
      showToast(t('inventory.binUnlinked', 'Bin assignment cleared'), 'success');
    },
    onError: () => showToast(t('inventory.binUnlinkFailed', 'Could not clear bin assignment'), 'error'),
  });

  const bins = binsQuery.data ?? [];
  const activeCount = bins.filter((bin) => bin.batch !== null).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-3 text-2xl font-bold text-white">
          <Package className="h-7 w-7 text-bambu-green" />
          {t('inventory.binsTitle', 'Part bins')}
        </h1>
        <p className="mt-1 max-w-3xl text-bambu-gray">
          {t(
            'inventory.binsSubtitle',
            'Manage the shared KNB and BUT bins. A bin is assigned to a printer only for its current fill.',
          )}
        </p>
      </div>

      <div className="grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3">
        <Summary label={t('inventory.binsTotal', 'Total bins')} value={bins.length} />
        <Summary label={t('inventory.binsAssigned', 'Assigned')} value={activeCount} />
        <Summary label={t('inventory.binsAvailable', 'Available')} value={Math.max(0, bins.length - activeCount)} />
      </div>

      <section className="overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary">
        <div className="border-b border-bambu-dark-tertiary px-4 py-3">
          <h2 className="font-semibold text-white">{t('inventory.binsManagementHeading', 'Shared reusable bins')}</h2>
          <p className="mt-0.5 text-xs text-bambu-gray">
            {t('inventory.binsManagementHint', 'Override a remaining count when needed, or unlink a fill completely.')}
          </p>
        </div>
        {binsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-bambu-gray">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : binsQuery.isError ? (
          <div className="px-4 py-16 text-center">
            <p className="font-medium text-white">{t('inventory.binsLoadError', 'Could not load bins')}</p>
            <Button className="mt-3" variant="secondary" onClick={() => binsQuery.refetch()}>
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {bins.map((bin) => {
              const batch = bin.batch;
              const draft = drafts[bin.payload] ?? String(batch?.remaining_quantity ?? 0);
              const parsed = Number(draft);
              const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000;
              const busy = overrideMutation.isPending || unlinkMutation.isPending;
              return (
                <article key={bin.payload} className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-white">{bin.part_name} {bin.bin_number}</h3>
                      <p className="mt-1 font-mono text-xs text-bambu-gray">{bin.payload}</p>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-xs ${batch ? 'bg-bambu-green/15 text-bambu-green' : 'bg-bambu-dark-tertiary text-bambu-gray'}`}>
                      {batch ? statusLabel(bin.status) : t('inventory.binAvailable', 'Available')}
                    </span>
                  </div>

                  {batch ? (
                    <>
                      <div className="mt-4 space-y-1 text-sm text-bambu-gray-light">
                        <p>{batch.printer_name ?? 'Printer'}{batch.print_name ? ` · ${batch.print_name}` : ''}</p>
                        <p>{batch.remaining_quantity} {t('inventory.binRemaining', 'remaining')} / {batch.quantity} {t('inventory.binHarvested', 'harvested')}</p>
                      </div>
                      <div className="mt-4 flex items-end gap-2">
                        <label className="min-w-0 flex-1">
                          <span className="mb-1 block text-xs text-bambu-gray">{t('inventory.binOverrideLabel', 'Remaining quantity')}</span>
                          <input
                            aria-label={`${bin.part_name} ${bin.bin_number} remaining quantity`}
                            type="number"
                            min={0}
                            max={100000}
                            step={1}
                            value={draft}
                            disabled={busy}
                            onChange={(event) => setDrafts((current) => ({ ...current, [bin.payload]: event.target.value }))}
                            className="w-full rounded border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
                          />
                        </label>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!valid || busy}
                          onClick={() => overrideMutation.mutate({ payload: bin.payload, remaining_quantity: parsed })}
                        >
                          {t('inventory.binOverride', 'Override')}
                        </Button>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => overrideMutation.mutate({ payload: bin.payload, remaining_quantity: 0 })}
                        >
                          <Eraser className="h-4 w-4" />
                          {t('inventory.binClearQuantity', 'Clear quantity')}
                        </Button>
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => setUnlinkTarget(bin)}>
                          <Link2Off className="h-4 w-4" />
                          {t('inventory.binUnlink', 'Unlink')}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="mt-5 text-sm text-bambu-gray">
                      {t('inventory.binReadyHint', 'This bin can be assigned during the next matching harvest.')}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {unlinkTarget && (
        <ConfirmModal
          title={t('inventory.binUnlinkTitle', 'Unlink bin assignment?')}
          message={t('inventory.binUnlinkMessage', 'This will release {{bin}} from {{printer}} and make it available for another harvest. The historical batch record will remain in the audit history.', {
            bin: `${unlinkTarget.part_name} ${unlinkTarget.bin_number}`,
            printer: unlinkTarget.batch?.printer_name ?? 'its printer',
          })}
          confirmText={t('inventory.binUnlinkConfirm', 'Unlink bin')}
          variant="danger"
          isLoading={unlinkMutation.isPending}
          onCancel={() => setUnlinkTarget(null)}
          onConfirm={() => unlinkMutation.mutate(unlinkTarget.payload)}
        />
      )}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-bambu-gray">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white">{value}</div>
    </div>
  );
}
