import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Clock3, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import { formatFloorDate } from '../../utils/floorScan';
import { buildPartTimeline, partEventDotClass, partEventLabel } from '../../utils/floorPartHistory';

type ScanPartHistoryProps = {
  partId: number;
  partCode: string | null;
  labeledAt: string;
  archiveId: number | null;
};

/** Read-only part timeline for the floor scan kiosk — no edit controls. */
export function ScanPartHistory({ partId, partCode, labeledAt, archiveId }: ScanPartHistoryProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventsQuery = useQuery({
    queryKey: ['floor-inventory-part-events', partId],
    queryFn: () => api.getFloorInventoryPartEvents(partId),
    staleTime: 30_000,
  });

  const timeline = useMemo(
    () =>
      buildPartTimeline(
        { id: partId, labeled_at: labeledAt, archive_id: archiveId },
        eventsQuery.data ?? [],
      ),
    [archiveId, eventsQuery.data, labeledAt, partId],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || timeline.length === 0) return;
    element.scrollTop = element.scrollHeight;
  }, [timeline.length, partId]);

  return (
    <section
      className="mt-8 w-full max-w-lg text-left"
      aria-label={t('floor.scanPartHistoryLabel', 'Part history')}
    >
      <div className="flex items-center justify-center gap-2">
        <Clock3 className="h-5 w-5 text-bambu-gray" aria-hidden="true" />
        <h3 className="text-lg font-medium text-white">
          {t('floor.scanPartHistoryHeading', 'History')}
        </h3>
      </div>
      <div className="relative mt-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary/60 p-3">
        {eventsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-bambu-gray">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            <span>{t('floor.scanPartHistoryLoading', 'Loading history…')}</span>
          </div>
        ) : timeline.length === 0 ? (
          <p className="py-2 text-center text-sm text-bambu-gray">
            {t('floor.scanPartHistoryEmpty', 'No history yet')}
          </p>
        ) : (
          <div ref={scrollRef} className="max-h-40 overflow-y-auto pr-1">
            <div className="relative">
              <span
                aria-hidden="true"
                className="absolute bottom-2 left-[3px] top-2 w-0.5 bg-bambu-dark-tertiary"
              />
              <ol className="space-y-3">
                {timeline.map((event) => (
                  <li key={event.id} className="relative pl-7">
                    <span
                      className={`absolute left-1 top-2 z-10 h-2 w-2 -translate-x-1/2 rounded-full ${partEventDotClass(event.action)}`}
                    />
                    <p className="text-base text-white">{partEventLabel(event, partCode, t)}</p>
                    <p className="text-sm text-bambu-gray">
                      {formatFloorDate(event.occurred_at, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
        {eventsQuery.isError && (
          <p className="mt-2 text-center text-xs text-bambu-gray">
            {t('floor.scanPartHistoryUnavailable', 'History could not be loaded')}
          </p>
        )}
      </div>
    </section>
  );
}
