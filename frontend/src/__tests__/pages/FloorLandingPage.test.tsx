import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { FloorLandingPage } from '../../pages/FloorLandingPage';
import { server } from '../mocks/server';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const OPEN_SESSION = {
  id: 1,
  station_slug: 'wip',
  station_name: 'WIP',
  device_id: 'someone-else',
  opened_at: '2026-08-24T10:00:00',
  open_seconds: 50400,
  closed_at: null,
  closed_by_takeover: false,
};

function mockSessions(overview: { open?: unknown[]; recent?: unknown[] } = {}) {
  server.use(
    http.get('/api/v1/floor/sessions', () =>
      HttpResponse.json({ open: overview.open ?? [], recent: overview.recent ?? [] }),
    ),
  );
}

describe('FloorLandingPage', () => {
  it('renders both destinations', () => {
    render(<FloorLandingPage />);

    expect(screen.getByRole('heading', { name: 'Floor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Scan' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open Codes' })).toBeEnabled();
  });

  it('navigates to /floor/scan when Scan is opened', async () => {
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await user.click(screen.getByRole('button', { name: 'Open Scan' }));

    expect(mockNavigate).toHaveBeenCalledWith('/floor/scan');
  });

  it('navigates to /floor/codes when Codes is opened', async () => {
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await user.click(screen.getByRole('button', { name: 'Open Codes' }));

    expect(mockNavigate).toHaveBeenCalledWith('/floor/codes');
  });
});

describe('FloorLandingPage open-sessions panel', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(localStorage.setItem).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists an open station with how long it has been held', async () => {
    mockSessions({ open: [OPEN_SESSION] });
    render(<FloorLandingPage />);

    expect(await screen.findByText('WIP')).toBeInTheDocument();
    // 14h reads as abandoned overnight — the whole basis for closing it.
    expect(screen.getByText(/open 14h 0m/)).toBeInTheDocument();
  });

  it('says whose session it is, not a meaningless device id', async () => {
    // A raw UUID tells a reader nothing; "is this mine or someone else's
    // mid-task" is the question that decides whether to close it.
    mockSessions({ open: [OPEN_SESSION] });
    render(<FloorLandingPage />);

    expect(await screen.findByText(/Another device/)).toBeInTheDocument();
    expect(screen.queryByText(/someone-else/)).not.toBeInTheDocument();
  });

  it('marks a session held by this device', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'floorDeviceId' ? 'my-device' : null,
    );
    mockSessions({ open: [{ ...OPEN_SESSION, device_id: 'my-device' }] });
    render(<FloorLandingPage />);

    expect(await screen.findByText(/This device/)).toBeInTheDocument();
  });

  it('closes a session and refreshes the list', async () => {
    let closed = false;
    server.use(
      http.get('/api/v1/floor/sessions', () =>
        HttpResponse.json({ open: closed ? [] : [OPEN_SESSION], recent: [] }),
      ),
      http.delete('/api/v1/floor/sessions/:id', () => {
        closed = true;
        return HttpResponse.json({ ...OPEN_SESSION, closed_at: '2026-08-24T12:00:00' });
      }),
    );
    const user = userEvent.setup();
    render(<FloorLandingPage />);
    await screen.findByText('WIP');

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(await screen.findByText('No stations are open.')).toBeInTheDocument();
  });

  it('says plainly when nothing is open', async () => {
    mockSessions();
    render(<FloorLandingPage />);

    expect(await screen.findByText('No stations are open.')).toBeInTheDocument();
  });

  it('hides history behind a toggle', async () => {
    const recent = [
      { ...OPEN_SESSION, id: 9, closed_at: '2026-08-24T11:00:00', open_seconds: 120 },
    ];
    mockSessions({ recent });
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await screen.findByText('No stations are open.');
    expect(screen.queryByText(/was open 2m/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Recent history' }));

    expect(await screen.findByText(/was open 2m/)).toBeInTheDocument();
  });

  it('flags a session that was taken over rather than closed', async () => {
    const recent = [
      {
        ...OPEN_SESSION,
        id: 9,
        closed_at: '2026-08-24T11:00:00',
        open_seconds: 120,
        closed_by_takeover: true,
      },
    ];
    mockSessions({ recent });
    const user = userEvent.setup();
    render(<FloorLandingPage />);

    await screen.findByText('No stations are open.');
    await user.click(screen.getByRole('button', { name: 'Recent history' }));

    expect(await screen.findByText('taken over')).toBeInTheDocument();
  });

  it('offers no history toggle when there is none', async () => {
    mockSessions();
    render(<FloorLandingPage />);

    await screen.findByText('No stations are open.');
    expect(screen.queryByRole('button', { name: 'Recent history' })).not.toBeInTheDocument();
  });

  it('surfaces a load failure with a retry', async () => {
    server.use(
      http.get('/api/v1/floor/sessions', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    );
    render(<FloorLandingPage />);

    expect(await screen.findByText('Could not load sessions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('does not break the picker cards', async () => {
    mockSessions({ open: [OPEN_SESSION] });
    render(<FloorLandingPage />);

    await screen.findByText('WIP');
    expect(screen.getByRole('button', { name: 'Open Scan' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open Codes' })).toBeEnabled();
  });
});
