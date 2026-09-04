import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Clock3, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import { formatFloorDate } from '../../utils/floorScan';
import { partEventDotClass, unitEventLabel } from '../../utils/floorPartHistory';

/** Compact serial timeline on the linked-unit scan card (mirrors ScanPartHistory). */
export function ScanUnitHistory({ unitId }: { unitId: number }) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventsQuery = useQuery({
    queryKey: ['floor-unit-events', unitId],
    queryFn: () => api.getUnitEvents(unitId),
    staleTime: 15_000,
  });

  const events = eventsQuery.data ?? [];

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [events.length, unitId]);

  return (
    <section className="mt-4 w-full max-w-md text-left" aria-label={t('floor.scanUnitHistoryLabel', 'Serial history')}>
      <div className="mb-2 flex items-center gap-2">
        <Clock3 className="h-4 w-4 text-bambu-gray" aria-hidden="true" />
        <h3 className="text-sm font-medium text-white">
          {t('floor.scanUnitHistoryHeading', 'History')}
        </h3>
      </div>
      <div className="relative mt-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary/60 p-3">
        {eventsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-bambu-gray">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            <span>{t('floor.scanUnitHistoryLoading', 'Loading history…')}</span>
          </div>
        ) : events.length === 0 ? (
          <p className="py-2 text-center text-sm text-bambu-gray">
            {t('floor.scanUnitHistoryEmpty', 'No history yet')}
          </p>
        ) : (
          <div ref={scrollRef} className="max-h-40 overflow-y-auto pr-1" data-testid="unit-history-timeline">
            <div className="relative">
              <span
                aria-hidden="true"
                className="absolute bottom-2 left-[3px] top-2 w-0.5 bg-bambu-dark-tertiary"
              />
              <ol className="space-y-3">
                {events.map((event) => (
                  <li key={event.id} className="relative pl-7 text-sm">
                    <span
                      className={`absolute left-1 top-1.5 z-10 h-2 w-2 -translate-x-1/2 rounded-full ${partEventDotClass(event.action)}`}
                    />
                    <p className="text-white">{unitEventLabel(event, t)}</p>
                    <p className="text-xs text-bambu-gray">
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
            {t('floor.scanUnitHistoryUnavailable', 'History could not be loaded')}
          </p>
        )}
      </div>
    </section>
  );
}
