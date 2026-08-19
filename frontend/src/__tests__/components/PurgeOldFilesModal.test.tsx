/**
 * Tests for the admin Purge Old Files modal (#1008).
 *
 * Covers: preview round-trip populates count + size + sample filenames,
 * confirm button stays disabled until preview returns count > 0, confirm
 * round-trip posts the correct payload and closes the modal.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PurgeOldFilesModal } from '../../components/PurgeOldFilesModal';

afterEach(() => server.resetHandlers());

describe('PurgeOldFilesModal', () => {
  it('displays preview counts and sample filenames returned by the backend', async () => {
    server.use(
      http.get('*/library/purge/preview', () =>
        HttpResponse.json({
          count: 3,
          total_bytes: 5_242_880,
          sample_filenames: ['a.3mf', 'b.3mf', 'c.3mf'],
          older_than_days: 90,
          include_never_printed: true,
        }),
      ),
    );

    render(<PurgeOldFilesModal onClose={vi.fn()} />);

    await screen.findByText(/3 files/i);
    expect(screen.getByText('a.3mf')).toBeInTheDocument();
    expect(screen.getByText('b.3mf')).toBeInTheDocument();
    expect(screen.getByText('c.3mf')).toBeInTheDocument();
  });

  it('leaves the confirm button disabled when the preview returns zero matches', async () => {
    server.use(
      http.get('*/library/purge/preview', () =>
        HttpResponse.json({
          count: 0,
          total_bytes: 0,
          sample_filenames: [],
          older_than_days: 90,
          include_never_printed: true,
        }),
      ),
    );

    render(<PurgeOldFilesModal onClose={vi.fn()} />);
    await screen.findByText(/0 files/i);

    // The confirm button label contains the count; it should be disabled.
    const confirm = screen.getByRole('button', { name: /Move 0 to trash/i });
    expect(confirm).toBeDisabled();
  });

  it('invokes the purge endpoint and closes the modal on confirm', async () => {
    let purgeBody: { older_than_days: number; include_never_printed: boolean } | null = null;
    server.use(
      http.get('*/library/purge/preview', () =>
        HttpResponse.json({
          count: 2,
          total_bytes: 1024,
          sample_filenames: ['x.3mf', 'y.3mf'],
          older_than_days: 90,
          include_never_printed: true,
        }),
      ),
      http.post('*/library/purge', async ({ request }) => {
        purgeBody = (await request.json()) as typeof purgeBody;
        return HttpResponse.json({ moved_to_trash: 2 });
      }),
    );

    const onClose = vi.fn();
    render(<PurgeOldFilesModal onClose={onClose} />);

    await screen.findByText(/2 files/i);
    await userEvent.click(screen.getByRole('button', { name: /Move 2 to trash/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(purgeBody).toEqual({ older_than_days: 90, include_never_printed: true });
  });

  it('uses File Manager modal chrome rather than a native confirm or light overlay', async () => {
    server.use(
      http.get('*/library/purge/preview', () =>
        HttpResponse.json({
          count: 1,
          total_bytes: 1024,
          sample_filenames: ['a.3mf'],
          older_than_days: 90,
          include_never_printed: true,
        }),
      ),
    );

    render(<PurgeOldFilesModal onClose={vi.fn()} />);

    const heading = await screen.findByRole('heading', { name: /purge old files/i });
    const panel = heading.closest('.bg-bambu-dark-secondary');
    expect(panel).toBeTruthy();
    expect(panel).toHaveClass('border-bambu-dark-tertiary');
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(document.querySelector('.bg-white')).toBeNull();
  });
});
