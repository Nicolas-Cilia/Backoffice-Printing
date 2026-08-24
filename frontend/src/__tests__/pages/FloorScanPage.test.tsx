import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { FloorScanPage } from '../../pages/FloorScanPage';
import { server } from '../mocks/server';
import * as floorSound from '../../utils/floorSound';

const WIP_SESSION = {
  id: 1,
  station_slug: 'wip',
  station_name: 'WIP',
  device_id: 'this-device',
  opened_at: '2026-08-24T10:00:00',
  open_seconds: 0,
};

/** No session on load — the common case at the start of a shift. */
function mockNoSession() {
  server.use(http.get('/api/v1/floor/session', () => HttpResponse.json(null)));
}

/** Captures the scan POST body so tests can assert what was actually sent. */
function mockScan(response: unknown, status = 200) {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  server.use(
    http.post('/api/v1/floor/session/scan', async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(response, { status });
    }),
  );
  return captured;
}

async function scan(text: string) {
  const input = screen.getByLabelText('Scan field');
  // fireEvent, not userEvent: a pistol dispatches the whole scan with no yield
  // between the last keystroke and Enter, which is the race the page's ref
  // handling exists for.
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('FloorScanPage (Phase 1b sessions)', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(localStorage.setItem).mockReset();
    // jsdom has no WebAudio; the util degrades silently, but spying keeps the
    // assertions about *when* a tone fires honest.
    vi.spyOn(floorSound, 'playScanErrorTone').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resuming a session', () => {
    it('shows the idle prompt when this device holds nothing', async () => {
      mockNoSession();
      render(<FloorScanPage />);

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
      expect(screen.getByLabelText('Scan field')).toHaveFocus();
    });

    it('resumes an already-open station after a reload', async () => {
      // The session lives server-side precisely so an accidental F5 does not
      // strand an open station nobody can see (§2.4).
      server.use(
        http.get('/api/v1/floor/session', () =>
          HttpResponse.json({ ...WIP_SESSION, open_seconds: 4500 }),
        ),
      );
      render(<FloorScanPage />);

      expect(await screen.findByText('WIP')).toBeInTheDocument();
      expect(screen.getByText('Open for 1h 15m')).toBeInTheDocument();
    });

    it('falls back to idle when the session lookup fails', async () => {
      // Rescanning the station QR is one action away, so a failed resume is
      // not worth an error screen.
      server.use(
        http.get('/api/v1/floor/session', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })),
      );
      render(<FloorScanPage />);

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
    });
  });

  describe('opening, closing and switching', () => {
    it('opens a station and shows it prominently with elapsed time', async () => {
      mockNoSession();
      const captured = mockScan({
        result: 'opened',
        station_slug: 'wip',
        station_name: 'WIP',
        session: WIP_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText('WIP')).toBeInTheDocument();
      expect(screen.getByText('Open for <1m')).toBeInTheDocument();
      // The payload is round-tripped, not a slug derived client-side.
      expect(captured.body).toMatchObject({ payload: 'BBS-wip' });
      expect(captured.body?.device_id).toBeTruthy();
    });

    it('confirms a close and returns to idle', async () => {
      mockNoSession();
      mockScan({
        result: 'closed',
        station_slug: 'wip',
        station_name: 'WIP',
        session: null,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText('WIP closed')).toBeInTheDocument();
    });

    it('shows the new station after a switch', async () => {
      mockNoSession();
      mockScan({
        result: 'switched',
        station_slug: 'storage-receive',
        station_name: '+ Storage',
        session: { ...WIP_SESSION, id: 2, station_slug: 'storage-receive', station_name: '+ Storage' },
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-storage-receive');

      expect(await screen.findByText('+ Storage')).toBeInTheDocument();
    });

    it('closes the session from the on-screen control', async () => {
      server.use(
        http.get('/api/v1/floor/session', () => HttpResponse.json(WIP_SESSION)),
        http.delete('/api/v1/floor/session', () => HttpResponse.json(WIP_SESSION)),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('WIP');

      await user.click(screen.getByRole('button', { name: 'Close station' }));

      expect(await screen.findByText('Scan a code')).toBeInTheDocument();
    });
  });

  describe('a station held by another device', () => {
    const lockedResponse = {
      result: 'locked',
      station_slug: 'wip',
      station_name: 'WIP',
      session: null,
      blocking: { ...WIP_SESSION, device_id: 'other-device', open_seconds: 50400 },
    };

    it('refuses with the holder and elapsed time, and offers takeover', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText('WIP is open elsewhere')).toBeInTheDocument();
      // Elapsed time is the whole basis for the decision: 14h reads as
      // abandoned overnight, where 3m would read as someone mid-task.
      expect(screen.getByText('Open for 14h 0m on another device')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take over' })).toBeEnabled();
    });

    it('rings the error tone, since the refusal may happen out of sight', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      await screen.findByText('WIP is open elsewhere');
      expect(floorSound.playScanErrorTone).toHaveBeenCalled();
    });

    it('takes the station over and opens it here', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      const captured: { body: Record<string, unknown> | null } = { body: null };
      server.use(
        http.post('/api/v1/floor/session/takeover', async ({ request }) => {
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            result: 'opened',
            station_slug: 'wip',
            station_name: 'WIP',
            session: WIP_SESSION,
            blocking: null,
          });
        }),
      );
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');
      await user.click(await screen.findByRole('button', { name: 'Take over' }));

      expect(await screen.findByText('Open for <1m')).toBeInTheDocument();
      expect(captured.body).toMatchObject({ payload: 'BBS-wip' });
    });

    it('warns that taking over discards the other session', async () => {
      mockNoSession();
      mockScan(lockedResponse);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText(/closes the other session/)).toBeInTheDocument();
    });
  });

  describe('scans the app cannot use', () => {
    it('reports an unrecognised code as unknown', async () => {
      mockNoSession();
      mockScan({ detail: 'Not a station code: BBS-nope' }, 404);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-nope');

      expect(await screen.findByText('Unknown code')).toBeInTheDocument();
      expect(screen.getByText('BBS-nope')).toBeInTheDocument();
      expect(floorSound.playScanErrorTone).toHaveBeenCalled();
    });

    it('distinguishes a recognised prefix whose phase has not shipped', async () => {
      // "Not built yet" and "that code means nothing" send an operator to
      // different places, so they must not render identically (§4).
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');

      expect(await screen.findByText('Not handled yet')).toBeInTheDocument();
      expect(screen.getByText('BBP-12')).toBeInTheDocument();
    });

    it.each([
      ['BBD-000042', 'part'],
      ['BBF-warping', 'defect'],
      ['BBX-rework', 'command'],
      ['4001234567890', 'factory SKU'],
    ])('treats %s (%s) as not-yet-handled rather than unknown', async (payload) => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan(payload);

      expect(await screen.findByText('Not handled yet')).toBeInTheDocument();
    });

    it('ignores a bare Enter with no scanned content', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      fireEvent.keyDown(screen.getByLabelText('Scan field'), { key: 'Enter' });

      expect(screen.getByText('Scan a code')).toBeInTheDocument();
    });

    it('surfaces a real backend failure without blaming the label', async () => {
      mockNoSession();
      mockScan({ detail: 'database is on fire' }, 500);
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(await screen.findByText('Scan failed')).toBeInTheDocument();
    });
  });

  describe('pistol input handling', () => {
    it('reads the just-typed value when Enter fires in the same tick', async () => {
      // A pistol fires characters and Enter with no yield between, before
      // React has re-rendered — the handler must read the ref, not a stale
      // state closure.
      mockNoSession();
      const captured = mockScan({
        result: 'opened',
        station_slug: 'wip',
        station_name: 'WIP',
        session: WIP_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      await waitFor(() => expect(captured.body).not.toBeNull());
      expect(captured.body).toMatchObject({ payload: 'BBS-wip' });
    });

    it('clears the field after each scan', async () => {
      mockNoSession();
      mockScan({
        result: 'opened',
        station_slug: 'wip',
        station_name: 'WIP',
        session: WIP_SESSION,
        blocking: null,
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');

      expect(screen.getByLabelText('Scan field')).toHaveValue('');
    });

    it('keeps focus on the scan field after a click elsewhere', async () => {
      mockNoSession();
      const user = userEvent.setup();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      const input = screen.getByLabelText('Scan field');
      await user.click(document.body);

      await waitFor(() => expect(input).toHaveFocus());
    });
  });

  describe('transient message timing', () => {
    // Fake timers are installed *before* render, with shouldAdvanceTime so the
    // MSW round trips still resolve. Installing them afterwards would leave the
    // component's setTimeout scheduled on the real clock, and advancing the
    // fake one would prove nothing — the persistence test below would pass even
    // if `locked` wrongly auto-cleared.
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reverts an error to idle after a few seconds', async () => {
      mockNoSession();
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBP-12');
      expect(await screen.findByText('Not handled yet')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(screen.getByText('Scan a code')).toBeInTheDocument();
    });

    it('leaves the takeover prompt up instead of timing it out', async () => {
      // A refusal is a decision point, not a flash: timing it out would drop
      // the operator back to idle with the station still held elsewhere.
      mockNoSession();
      mockScan({
        result: 'locked',
        station_slug: 'wip',
        station_name: 'WIP',
        session: null,
        blocking: { ...WIP_SESSION, device_id: 'other', open_seconds: 600 },
      });
      render(<FloorScanPage />);
      await screen.findByText('Scan a code');

      await scan('BBS-wip');
      expect(await screen.findByText('WIP is open elsewhere')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(screen.getByText('WIP is open elsewhere')).toBeInTheDocument();
    });
  });
});
