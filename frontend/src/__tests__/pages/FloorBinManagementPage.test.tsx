import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FloorBinManagementPage } from '../../pages/FloorBinManagementPage';

const BINS = [
  {
    payload: 'BBN-KNB-1',
    bin_number: 1,
    part_code: 'KNB',
    part_name: 'Knob bin',
    status: 'wip',
    batch: {
      id: 8,
      payload: 'BBN-KNB-1',
      bin_number: 1,
      printer_id: 4,
      printer_name: 'Bench A',
      archive_id: 22,
      print_name: 'Knob plate',
      part_code: 'KNB',
      quantity: 30,
      remaining_quantity: 7,
      status: 'wip',
      harvested_at: '2026-08-26T12:00:00Z',
    },
  },
  {
    payload: 'BBN-BUT-1',
    bin_number: 1,
    part_code: 'BUT',
    part_name: 'Button bin',
    status: 'available',
    batch: null,
  },
];

describe('FloorBinManagementPage', () => {
  it('shows active assignments and can override the remaining quantity', async () => {
    let overrideBody: unknown = null;
    server.use(
      http.get('/api/v1/floor/inventory/bins', () => HttpResponse.json(BINS)),
      http.post('/api/v1/floor/inventory/bins/quantity-override', async ({ request }) => {
        overrideBody = await request.json();
        return HttpResponse.json({ result: 'empty_recorded' });
      }),
    );
    const user = userEvent.setup();
    render(<FloorBinManagementPage />);

    expect(await screen.findByText('Knob bin 1')).toBeInTheDocument();
    expect(screen.getByText('7 remaining / 30 harvested')).toBeInTheDocument();
    expect(screen.getByText('Button bin 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear quantity' }));
    await waitFor(() => expect(overrideBody).toEqual({ payload: 'BBN-KNB-1', remaining_quantity: 0 }));
  });

  it('confirms before unlinking an active assignment', async () => {
    let unlinkedPayload: unknown = null;
    server.use(
      http.get('/api/v1/floor/inventory/bins', () => HttpResponse.json(BINS)),
      http.post('/api/v1/floor/inventory/bins/unlink', async ({ request }) => {
        unlinkedPayload = await request.json();
        return HttpResponse.json({ result: 'unlinked' });
      }),
    );
    const user = userEvent.setup();
    render(<FloorBinManagementPage />);

    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    expect(screen.getByText('Unlink bin assignment?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unlink bin' }));

    await waitFor(() => expect(unlinkedPayload).toEqual({ payload: 'BBN-KNB-1' }));
  });
});
