import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { api } from '../api/client';
import { Button } from './Button';
import { FilamentSwatch } from './FilamentSwatch';
import { useToast } from '../contexts/ToastContext';
import { trackingProductLabel } from '../utils/filamentTracking';

function swatchRgba(hex: string | null | undefined): string {
  const clean = (hex || '').replace('#', '');
  if (clean.length >= 6) return `${clean.slice(0, 6)}FF`;
  return '808080FF';
}

export function AssignTrackingColorModal({
  printerId,
  amsId,
  trayId,
  onClose,
}: {
  printerId: number;
  amsId: number;
  trayId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');

  const planQuery = useQuery({
    queryKey: ['filament-tracking-plan'],
    queryFn: () => api.getFilamentTrackingPlan(),
  });

  const assignMutation = useMutation({
    mutationFn: (bucketId: number) =>
      api.assignFilamentTrackingSlot({
        printer_id: printerId,
        ams_id: amsId,
        tray_id: trayId,
        bucket_id: bucketId,
      }),
    onSuccess: (assigned) => {
      queryClient.invalidateQueries({ queryKey: ['filament-tracking-assignments'] });
      showToast(
        t('inventory.trackingAssigned', 'Assigned {{name}}', {
          name: trackingProductLabel(assigned),
        }),
        'success',
      );
      onClose();
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const products = useMemo(() => {
    const rows = planQuery.data?.materials ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      trackingProductLabel(row).toLowerCase().includes(q),
    );
  }, [planQuery.data, search]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">
            {t('inventory.trackingAssignTitle', 'Assign tracking product')}
          </h2>
          <button type="button" onClick={onClose} className="p-1 text-bambu-gray hover:text-white rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          <p className="text-sm text-bambu-gray">
            {t(
              'inventory.trackingAssignHint',
              'This slot will subtract from the named product, not from a physical spool remaining weight.',
            )}
          </p>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('inventory.trackingAssignSearch', 'Search EasyRock White PLA…')}
            className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm placeholder:text-bambu-gray/50 focus:outline-none focus:border-bambu-green"
          />
          {planQuery.isLoading ? (
            <div className="flex justify-center py-8 text-bambu-gray">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : products.length === 0 ? (
            <p className="text-sm text-bambu-gray py-6 text-center">
              {t('inventory.trackingAssignEmpty', 'Create a tracking product first, then assign it here.')}
            </p>
          ) : (
            <ul className="space-y-1">
              {products.map((row) => (
                <li key={row.bucket_id}>
                  <button
                    type="button"
                    disabled={assignMutation.isPending}
                    onClick={() => assignMutation.mutate(row.bucket_id)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-bambu-dark-tertiary"
                  >
                    <FilamentSwatch
                      rgba={swatchRgba(row.color_hex)}
                      extraColors={row.extra_colors}
                      effectType={row.effect_type}
                      subtype={row.subtype}
                      effectSize="table"
                    />
                    <span className="text-white text-sm">
                      {trackingProductLabel(row)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="p-4 border-t border-bambu-dark-tertiary flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
