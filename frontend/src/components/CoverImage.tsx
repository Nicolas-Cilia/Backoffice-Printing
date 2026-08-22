import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Box } from 'lucide-react';
import { api, getStreamToken, subscribeStreamToken } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

const MAX_COVER_RETRIES = 5;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

/**
 * Print-job cover thumbnail for printer cards.
 *
 * Resilience notes (farm dashboard flakes):
 * - Wait for the camera stream token before setting img.src when auth may
 *   require it. Firing without ?token= yields 401; the previous CoverImage
 *   permanently swapped to the wireframe placeholder and never recovered —
 *   rewriteMediaSrcWithToken cannot fix an unmounted <img>.
 * - Append the token from a reactive source (query + subscribeStreamToken),
 *   not only withStreamToken's module cache read at memo time (#979).
 * - Retry transient failures (FTP 503, timeouts, race before the 3MF lands)
 *   with backoff instead of locking on the first onError.
 * - Keep the last successfully loaded frame visible while a retry is in flight.
 */
export function CoverImage({
  url,
  printName,
  className = 'w-20 h-20',
  radiusClass = 'rounded-lg',
}: {
  url: string | null;
  printName?: string;
  className?: string;
  radiusClass?: string;
}) {
  const { t } = useTranslation();
  const { authEnabled, user, loading: authLoading } = useAuth();
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [moduleToken, setModuleToken] = useState<string | null>(() => getStreamToken());
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: streamTokenData, isPending: streamTokenPending } = useQuery({
    queryKey: ['camera-stream-token', user?.id ?? null],
    queryFn: () => api.getCameraStreamToken(),
    enabled: !authLoading && (!authEnabled || user !== null),
    staleTime: 50 * 60 * 1000,
  });

  useEffect(() => subscribeStreamToken(setModuleToken), []);

  const streamTokenValue = streamTokenData?.token ?? moduleToken;
  // Match CameraPage (#979 / #2521): don't paint a src until the token query
  // has settled (or yielded a token). Avoids 401 → sticky placeholder.
  const waitingForStreamToken = !streamTokenValue && (authEnabled || streamTokenPending || authLoading);

  const cacheBustedUrl = useMemo(() => {
    if (!url || waitingForStreamToken) return null;
    const sep = url.includes('?') ? '&' : '?';
    const bust = encodeURIComponent(printName || 'cover');
    let src = `${url}${sep}v=${bust}`;
    if (retryTick > 0) {
      src += `&r=${retryTick}`;
    }
    if (streamTokenValue) {
      src += `&token=${encodeURIComponent(streamTokenValue)}`;
    }
    return src;
  }, [url, printName, streamTokenValue, waitingForStreamToken, retryTick]);

  useEffect(() => {
    setLoadedSrc(null);
    setGaveUp(false);
    retryCountRef.current = 0;
    setRetryTick(0);
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [url, printName]);

  // Token arrived/rotated after a failed load — clear give-up so the new
  // tokenized src can mount. Keep any previously successful frame visible.
  // (cacheBustedUrl already includes streamTokenValue, so no retryTick bump.)
  useEffect(() => {
    setGaveUp(false);
    retryCountRef.current = 0;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [streamTokenValue]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  const scheduleRetry = () => {
    if (retryCountRef.current >= MAX_COVER_RETRIES) {
      setGaveUp(true);
      return;
    }
    const attempt = retryCountRef.current;
    retryCountRef.current = attempt + 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => {
      setGaveUp(false);
      setRetryTick((n) => n + 1);
    }, delay);
  };

  const showLoader = Boolean(cacheBustedUrl) && !gaveUp;
  const hasPreview = Boolean(loadedSrc);

  return (
    <>
      <div
        className={`${className} flex-shrink-0 ${radiusClass} overflow-hidden bg-bambu-dark-tertiary flex items-center justify-center relative ${hasPreview ? 'cursor-pointer' : ''}`}
        onClick={() => hasPreview && setShowOverlay(true)}
        data-testid="cover-image"
        data-gave-up={gaveUp ? 'true' : 'false'}
      >
        {hasPreview && (
          <img
            src={loadedSrc!}
            alt={t('printers.printPreview')}
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {showLoader && cacheBustedUrl !== loadedSrc && (
          <img
            key={cacheBustedUrl}
            src={cacheBustedUrl!}
            alt=""
            aria-hidden
            className="absolute opacity-0 pointer-events-none w-0 h-0"
            onLoad={() => {
              setLoadedSrc(cacheBustedUrl);
              setGaveUp(false);
              retryCountRef.current = 0;
            }}
            onError={() => scheduleRetry()}
          />
        )}
        {!hasPreview && <Box className="w-8 h-8 text-bambu-gray" />}
      </div>

      {showOverlay && loadedSrc && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-8"
          onClick={() => setShowOverlay(false)}
        >
          <div className="relative max-w-2xl max-h-full">
            <img
              src={loadedSrc}
              alt={t('printers.printPreview')}
              className="max-w-full max-h-[80vh] rounded-lg shadow-2xl"
            />
            {printName && (
              <p className="text-white text-center mt-4 text-lg">{printName}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
