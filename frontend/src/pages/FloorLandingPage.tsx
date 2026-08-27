/**
 * Floor landing page — `/floor` (docs/floor-plan.md §3.1/§15).
 *
 * The sidebar "Floor" item's destination: a picker between the two real
 * Floor pages. Not a kiosk bookmark — floor-bench PCs bookmark the explicit
 * `/floor/scan` URL directly so they never see a picker on reload (§2.1).
 * This page exists so someone navigating normally has any way to *reach*
 * `/floor/codes` at all — before it existed nothing in the app linked there.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanLine, QrCode, Loader2, AlertTriangle, ClipboardList } from 'lucide-react';
import { Button } from '../components/Button';
import { api, type FloorInventoryPart, type FloorSession } from '../api/client';
import { getDeviceId } from '../utils/floorDevice';
import { formatElapsed } from '../utils/floorScan';

/** How many needs-attention rows to fetch and show at once. Matches the
 *  panel's own request, not a separate page-size concept — there is no
 *  pagination control in v1, just the "showing N of total" hint. */
const NEEDS_ATTENTION_LIMIT = 50;

export function FloorLandingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-bambu-gray">
          {t('floor.landingEyebrow', 'Production floor')}
        </p>
        <h1 className="text-2xl font-bold text-white mt-1">{t('floor.landingTitle', 'Floor')}</h1>
        <p className="text-bambu-gray mt-1 max-w-2xl">
          {t(
            'floor.landingSubtitle',
            'Quick access to floor scanning, code printing, and your part history.',
          )}
        </p>
      </div>

      <FloorStats t={t} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full">
        <article className="bg-bambu-dark-secondary rounded-lg p-5 flex flex-col">
          <ScanLine className="w-8 h-8 text-bambu-green mb-3" aria-hidden="true" />
          <h2 className="text-white font-semibold text-lg">{t('floor.landingScanTitle', 'Scan')}</h2>
          <p className="text-sm text-bambu-gray mt-1 flex-1">
            {t(
              'floor.landingScanDescription',
              'Log a completed part from the floor station.',
            )}
          </p>
          <Button className="mt-4 self-start" onClick={() => navigate('/floor/scan')}>
            {t('floor.landingScanAction', 'Open Scan')}
          </Button>
        </article>

        <article className="bg-bambu-dark-secondary rounded-lg p-5 flex flex-col">
          <ClipboardList className="w-8 h-8 text-bambu-green mb-3" aria-hidden="true" />
          <h2 className="text-white font-semibold text-lg">
            {t('floor.inventoryTitle', 'Part history')}
          </h2>
          <p className="text-sm text-bambu-gray mt-1 flex-1">
            {t(
              'floor.landingInventoryDescription',
              'Review linked parts and their print history.',
            )}
          </p>
          <Button className="mt-4 self-start" onClick={() => navigate('/floor/inventory')}>
            {t('floor.landingInventoryAction', 'Open Part history')}
          </Button>
        </article>

        <article className="bg-bambu-dark-secondary rounded-lg p-5 flex flex-col">
          <QrCode className="w-8 h-8 text-bambu-green mb-3" aria-hidden="true" />
          <h2 className="text-white font-semibold text-lg">{t('floor.landingCodesTitle', 'Codes')}</h2>
          <p className="text-sm text-bambu-gray mt-1 flex-1">
            {t(
              'floor.landingCodesDescription',
              'Print the station, printer, and error QR labels the floor scans.',
            )}
          </p>
          <Button className="mt-4 self-start" onClick={() => navigate('/floor/codes')}>
            {t('floor.landingCodesAction', 'Open Codes')}
          </Button>
        </article>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4 w-full">
        <SessionsPanel t={t} />
        <UnlabeledBuildPlatesPanel t={t} />
      </div>
    </div>
  );
}

function FloorStats({ t }: { t: ReturnType<typeof useTranslation>['t'] }) {
  const partsQuery = useQuery({
    queryKey: ['floor-inventory-parts'],
    queryFn: () => api.getFloorInventoryParts(true),
    staleTime: 30_000,
  });
  const sessionsQuery = useQuery({
    queryKey: ['floor-sessions'],
    queryFn: () => api.getFloorSessions(),
    staleTime: 15_000,
  });
  const parts = partsQuery.data ?? [];
  const activeParts = parts.filter((part: FloorInventoryPart) => !part.archived_at && !part.released_at);
  const fitCheckQueries = useQueries({
    queries: activeParts.map((part) => ({
      queryKey: ['floor-inventory-part-events', part.id],
      queryFn: () => api.getFloorInventoryPartEvents(part.id),
      staleTime: 60_000,
    })),
  });
  const today = new Date();
  const scannedToday = parts.filter((part: FloorInventoryPart) => {
    const labeledAt = new Date(part.labeled_at);
    return labeledAt.toDateString() === today.toDateString();
  }).length;
  const needsAttention = parts.filter(
    (part: FloorInventoryPart) => !part.archived_at && part.archive_id === null,
  ).length;
  const awaitingFitCheck = activeParts.filter((_, index) =>
    !(fitCheckQueries[index]?.data ?? []).some(
      (event) => event.action === 'fit_check' || event.action === 'fit_checked',
    ),
  ).length;
  const openStations = sessionsQuery.data?.open.length ?? 0;
  const statsLoading =
    partsQuery.isLoading ||
    sessionsQuery.isLoading ||
    fitCheckQueries.some((query) => query.isLoading);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full sm:w-auto sm:max-w-[920px]">
      <div className="border border-bambu-dark-tertiary bg-bambu-dark-secondary rounded-lg px-4 py-3">
        <div className="text-xs text-bambu-gray">
          {t('floor.statsScannedToday', 'Parts scanned today')}
        </div>
        <div className="text-2xl font-bold text-white mt-1">
          {statsLoading ? '—' : scannedToday}
        </div>
      </div>
      <div className="border border-bambu-dark-tertiary bg-bambu-dark-secondary rounded-lg px-4 py-3">
        <div className="text-xs text-bambu-gray">
          {t('floor.statsNeedsAttention', 'Needs attention')}
        </div>
        <div className="text-2xl font-bold text-white mt-1">
          {statsLoading ? '—' : needsAttention}
        </div>
      </div>
      <div className="border border-bambu-dark-tertiary bg-bambu-dark-secondary rounded-lg px-4 py-3">
        <div className="text-xs text-bambu-gray">
          {t('floor.statsAwaitingFitCheck', 'Parts awaiting Initial QC Pass')}
        </div>
        <div className="text-2xl font-bold text-white mt-1">
          {statsLoading ? '—' : awaitingFitCheck}
        </div>
      </div>
      <div className="border border-bambu-dark-tertiary bg-bambu-dark-secondary rounded-lg px-4 py-3">
        <div className="text-xs text-bambu-gray">
          {t('floor.statsOpenStations', 'Open stations')}
        </div>
        <div className="text-2xl font-bold text-white mt-1">
          {statsLoading ? '—' : openStations}
        </div>
      </div>
    </div>
  );
}

/** Open station sessions, and recently closed ones (§2.4).
 *
 * Here rather than on `/floor/scan` because it is an office-side view: the
 * scan page is a kiosk showing one station at a time, and this answers "is
 * anything stuck open across the floor". A session nobody is going back to
 * otherwise has no remedy but taking it over from the bench.
 */
function SessionsPanel({ t }: { t: ReturnType<typeof useTranslation>['t'] }) {
  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const thisDevice = getDeviceId();

  const sessionsQuery = useQuery({
    queryKey: ['floor-sessions'],
    queryFn: () => api.getFloorSessions(),
    // Another device can open or close a station at any moment, so a stale
    // list would offer Close on something already gone.
    refetchInterval: 15000,
  });

  const closeMutation = useMutation({
    mutationFn: (sessionId: number) => api.closeFloorSessionById(sessionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['floor-sessions'] }),
  });

  const open = sessionsQuery.data?.open ?? [];
  const recent = sessionsQuery.data?.recent ?? [];

  return (
    <section className="bg-bambu-dark-secondary rounded-lg overflow-hidden w-full">
      <div className="px-4 py-3 border-b border-bambu-dark-tertiary flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold">
            {t('floor.sessionsHeading', 'Open stations')}
          </h2>
          <p className="text-xs text-bambu-gray mt-0.5">
            {t(
              'floor.sessionsHint',
              'A station stays claimed until it is closed. Close one here if nobody is coming back to it.',
            )}
          </p>
        </div>
        {recent.length > 0 && (
          <button
            type="button"
            className="text-sm text-bambu-gray hover:text-white transition-colors"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory
              ? t('floor.sessionsHideHistory', 'Hide history')
              : t('floor.sessionsShowHistory', 'Recent history')}
          </button>
        )}
      </div>

      {sessionsQuery.isLoading ? (
        <div className="flex items-center justify-center py-10 text-bambu-gray">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          {t('common.loading', 'Loading…')}
        </div>
      ) : sessionsQuery.isError ? (
        <div className="text-center py-10 px-4">
          <p className="text-white font-medium">
            {t('floor.sessionsLoadError', 'Could not load sessions')}
          </p>
          <Button className="mt-3" variant="secondary" onClick={() => sessionsQuery.refetch()}>
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      ) : open.length === 0 ? (
        <p className="px-4 py-8 text-center text-bambu-gray">
          {t('floor.sessionsNoneOpen', 'No stations are open.')}
        </p>
      ) : (
        <ul className="divide-y divide-bambu-dark-tertiary">
          {open.map((session) => (
            <li key={session.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-white font-medium">{session.station_name}</div>
                <div className="text-xs text-bambu-gray">
                  {/* A raw UUID means nothing to a reader; what matters is
                      whether the session is theirs to close or someone
                      else's mid-task. */}
                  {session.device_id === thisDevice
                    ? t('floor.sessionsThisDevice', 'This device')
                    : t('floor.sessionsOtherDevice', 'Another device')}
                  {' · '}
                  {t('floor.sessionsOpenFor', 'open {{elapsed}}', {
                    elapsed: formatElapsed(session.open_seconds),
                  })}
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={closeMutation.isPending}
                onClick={() => closeMutation.mutate(session.id)}
              >
                {t('floor.sessionsClose', 'Close')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {showHistory && recent.length > 0 && (
        <div className="border-t border-bambu-dark-tertiary">
          <p className="px-4 pt-3 text-xs uppercase tracking-wide text-bambu-gray">
            {t('floor.sessionsHistoryHeading', 'Closed in the last 24 hours')}
          </p>
          <ul className="divide-y divide-bambu-dark-tertiary">
            {recent.map((session) => (
              <HistoryRow key={session.id} session={session} t={t} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function HistoryRow({
  session,
  t,
}: {
  session: FloorSession;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <li className="flex items-center gap-4 px-4 py-2">
      <div className="min-w-0 flex-1">
        <span className="text-bambu-gray-light text-sm">{session.station_name}</span>
        {/* Ended by someone else, not by its holder — the thing the history
            exists to make visible. */}
        {session.closed_by_takeover && (
          <span className="ml-2 text-xs text-amber-500">
            {t('floor.sessionsTakenOver', 'taken over')}
          </span>
        )}
      </div>
      <span className="text-xs text-bambu-gray whitespace-nowrap">
        {t('floor.sessionsWasOpenFor', 'was open {{elapsed}}', {
          elapsed: formatElapsed(session.open_seconds),
        })}
      </span>
      {session.closed_at && (
        <span className="text-xs text-bambu-gray whitespace-nowrap">
          {new Date(session.closed_at).toLocaleTimeString()}
        </span>
      )}
    </li>
  );
}

/** Labeled parts with no resolved job (§7.2), newest first — the office-side
 *  counterpart to the harvest screen's "no job found" statement. A part
 *  lands here whenever a printer had nothing finished to bind to at harvest
 *  time; the fix is matching it to the right job by hand, which is why the
 *  sticker code and printer are what a reader needs, not a call to action.
 *
 *  Quiet on purpose, matching §7.2's framing of the underlying case as a
 *  plain fact rather than a fault: no red, no "error", not even in an empty
 *  state that would otherwise read as "nothing is wrong" — it just isn't
 *  phrased as if something usually is. */
function UnlabeledBuildPlatesPanel({ t }: { t: ReturnType<typeof useTranslation>['t'] }) {
  const queryClient = useQueryClient();
  const partsQuery = useQuery({
    queryKey: ['floor-unlabeled-build-plates'],
    queryFn: () => api.getFloorUnlabeledBuildPlates(NEEDS_ATTENTION_LIMIT),
    // A harvest session elsewhere can add to this list at any moment; same
    // cadence as the open-sessions panel above rather than a faster poll —
    // this is a backlog to work through, not something needing live update.
    refetchInterval: 15000,
  });

  const parts = partsQuery.data ?? [];
  const dismiss = useMutation({
    mutationFn: (id: number) => api.dismissFloorUnlabeledBuildPlate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['floor-unlabeled-build-plates'] }),
  });

  return (
    <section className="bg-bambu-dark-secondary rounded-lg overflow-hidden w-full">
      <div className="px-4 py-3 border-b border-bambu-dark-tertiary">
        <h2 className="text-white font-semibold">
          {t('floor.needsAttentionHeading', 'Build plates needing linking')}
        </h2>
        <p className="text-xs text-bambu-gray mt-0.5">
          {t(
            'floor.needsAttentionHint',
            'Completed jobs that have not received a linked part yet.',
          )}
        </p>
      </div>

      {partsQuery.isLoading ? (
        <div className="flex items-center justify-center py-10 text-bambu-gray">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          {t('common.loading', 'Loading…')}
        </div>
      ) : partsQuery.isError ? (
        <div className="text-center py-10 px-4">
          <p className="text-white font-medium">
            {t('floor.needsAttentionLoadError', 'Could not load this list')}
          </p>
          <Button className="mt-3" variant="secondary" onClick={() => partsQuery.refetch()}>
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      ) : parts.length === 0 ? (
        // Deliberately the same quiet phrasing as "No stations are open." —
        // an empty backlog is the ordinary state, not a thing to celebrate.
        <p className="px-4 py-8 text-center text-bambu-gray">
          {t('floor.needsAttentionNone', 'No build plates are waiting on parts.')}
        </p>
      ) : (
        <ul className="divide-y divide-bambu-dark-tertiary">
          {parts.map((part) => (
            <li key={part.id} className="flex items-center gap-4 px-4 py-3">
              <AlertTriangle
                className="w-4 h-4 text-amber-500 flex-shrink-0"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="text-white font-medium">{part.print_name}</div>
                <div className="text-xs text-bambu-gray">{part.printer_name}</div>
              </div>
              <span className="text-xs text-bambu-gray whitespace-nowrap">
                {part.completed_at
                  ? new Date(`${part.completed_at}Z`).toLocaleString()
                  : t('floor.needsAttentionUnknownTime', 'Unknown time')}
              </span>
              <Button
                variant="secondary"
                onClick={() => {
                  if (
                    window.confirm(
                      t('floor.dismissBuildPlateConfirm', 'Hide {{name}} from the production backlog?', {
                        name: part.print_name ?? t('floor.dismissBuildPlateFallback', 'this build plate'),
                      }),
                    )
                  ) {
                    dismiss.mutate(part.id);
                  }
                }}
                disabled={dismiss.isPending}
              >
                {t('floor.dismissBuildPlate', 'Not for production')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default FloorLandingPage;
