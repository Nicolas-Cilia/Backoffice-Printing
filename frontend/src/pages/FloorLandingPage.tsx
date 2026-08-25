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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanLine, QrCode, Loader2 } from 'lucide-react';
import { Button } from '../components/Button';
import { api, type FloorSession } from '../api/client';
import { getDeviceId } from '../utils/floorDevice';
import { formatElapsed } from '../utils/floorScan';

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
            'Scan is the pistol-input station for the floor. Codes prints the QR labels that make scanning work.',
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
        <article className="bg-bambu-dark-secondary rounded-lg p-6 flex flex-col">
          <ScanLine className="w-8 h-8 text-bambu-green mb-3" aria-hidden="true" />
          <h2 className="text-white font-semibold text-lg">{t('floor.landingScanTitle', 'Scan')}</h2>
          <p className="text-sm text-bambu-gray mt-1 flex-1">
            {t(
              'floor.landingScanDescription',
              'Pistol-input station for the printer line, cleanup bench, WIP shelf, and warehouse.',
            )}
          </p>
          <Button className="mt-4 self-start" onClick={() => navigate('/floor/scan')}>
            {t('floor.landingScanAction', 'Open Scan')}
          </Button>
        </article>

        <article className="bg-bambu-dark-secondary rounded-lg p-6 flex flex-col">
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

      <SessionsPanel t={t} />
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
    <section className="bg-bambu-dark-secondary rounded-lg overflow-hidden max-w-3xl">
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

export default FloorLandingPage;
