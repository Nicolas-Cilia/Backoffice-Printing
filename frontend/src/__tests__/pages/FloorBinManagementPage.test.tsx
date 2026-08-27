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
    expect(screen.getAllByText('Available')[0].parentElement?.parentElement).toHaveClass(
      'grid-cols-1',
      'sm:grid-cols-2',
      'lg:grid-cols-4',
    );

    await user.click(screen.getByRole('button', { name: 'Clear quantity' }));
    expect(screen.getByText('Clear remaining quantity?')).toBeInTheDocument();
    expect(overrideBody).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Clear quantity' })[1]);
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

  it('uses the same green Visual QC pass badge as Part History', async () => {
    server.use(
      http.get('/api/v1/floor/inventory/bins', () => HttpResponse.json([
        {
          ...BINS[0],
          status: 'visual_qc_passed',
          batch: { ...BINS[0].batch, status: 'visual_qc_passed' },
        },
      ])),
    );
    render(<FloorBinManagementPage />);

    const badge = await screen.findByText('Visual QC pass');
    expect(badge).toHaveClass(
      'inline-flex',
      'border-green-600',
      'bg-green-100',
      'text-green-800',
      'dark:bg-green-500/20',
      'dark:text-green-300',
    );
  });

  it('keeps an unlinked fill visible and lets it be matched to a printer job', async () => {
    let relinkBody: unknown = null;
    server.use(
      http.get('/api/v1/floor/inventory/bins', () => HttpResponse.json([
        {
          ...BINS[0],
          status: 'unlinked',
          batch: { ...BINS[0].batch, status: 'unlinked' },
        },
      ])),
      http.get('/api/v1/floor/printers', () => HttpResponse.json([
        { id: 4, payload: 'BBP-4', name: 'Bench A', model: 'X1C', location: null, is_active: true },
      ])),
      http.get('/api/v1/floor/inventory/bins/batches/:batchId/job-candidates', () => HttpResponse.json([
        { id: 99, print_name: 'Button plate', completed_at: '2026-08-26T12:00:00Z' },
      ])),
      http.post('/api/v1/floor/inventory/bins/batches/:batchId/relink', async ({ request }) => {
        relinkBody = await request.json();
        return HttpResponse.json({ result: 'recorded' });
      }),
    );
    const user = userEvent.setup();
    render(<FloorBinManagementPage />);

    expect(await screen.findByText('Knob bin 1')).toBeInTheDocument();
    expect(screen.getAllByText('Needs relinking')).toHaveLength(2);
    expect(screen.getByText('Printer/job needs relinking')).toBeInTheDocument();
    expect(screen.queryByText('Bench A · Knob plate')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Printer' }), '4');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Completed job' }), '99');
    await user.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(relinkBody).toEqual({ archive_id: 99 }));
  });
});
