import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import InventoryPageRouter from '../../pages/InventoryPage';
import { server } from '../mocks/server';

const whitePlaRow = {
  bucket_id: 1,
  color_name: 'White',
  material: 'PLA',
  color_hex: 'FFFFFF',
  on_hand_grams: 99500,
  stock_initialized: true,
  spool_weight_grams: 1000,
  spool_equivalent: 99.5,
  observed_usage_grams: 3500,
  daily_rate_grams: 500,
  monthly_estimate_grams: 15000,
  projected_remaining_grams: 84500,
  recommended_spools: 0,
  days_of_cover: 199,
  days_until_order: 192,
  stage: 'week',
  cost_per_kg: 25,
  on_hand_value: 2487.5,
  monthly_cost_estimate: 375,
  lead_time_days: 7,
  reorder_grams: 3500,
};

function planPayload(materials = [whitePlaRow]) {
  return {
    stage: 'week',
    days_observed: 10,
    window_label: 'Week average · extrapolating to 30 days',
    materials,
    total_on_hand_grams: materials.reduce((sum, row) => sum + row.on_hand_grams, 0),
    total_observed_usage_grams: materials.reduce((sum, row) => sum + row.observed_usage_grams, 0),
    total_monthly_estimate_grams: 15000,
    total_on_hand_value: materials.reduce((sum, row) => sum + (row.on_hand_value ?? 0), 0),
    total_monthly_cost_estimate: 375,
    total_recommended_spools: 0,
    soonest_days_until_order: (() => {
      const countdowns = materials
        .map((row) => row.days_until_order)
        .filter((value): value is number => value != null);
      return countdowns.length ? Math.min(...countdowns) : null;
    })(),
    tracking_started_at: '2026-08-08T00:00:00Z',
  };
}

describe('Filament tracking tab', () => {
  it('opens tracking by default on the Filament page', async () => {
    window.history.pushState({}, '', '/inventory');
    render(<InventoryPageRouter />);

    expect(await screen.findByRole('heading', { name: 'Filament Tracking' })).toBeInTheDocument();
    expect(await screen.findByText('No color stock yet')).toBeInTheDocument();
  });

  it('shows color + material rows from the plan API', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const product = await screen.findByText('White · PLA');
    const row = product.closest('tr');
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText('199d')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('192d')).toBeInTheDocument();
    expect(screen.getByText('Order in')).toBeInTheDocument();
    expect(screen.queryByText('Buy')).not.toBeInTheDocument();
    expect(screen.getAllByText('192d').length).toBeGreaterThanOrEqual(1);
  });

  it('asks for confirmation before deleting a color · material row', async () => {
    const user = userEvent.setup();
    let deleted = false;
    server.use(
      http.get('/api/v1/filament-tracking/plan', () =>
        HttpResponse.json(planPayload(deleted ? [] : [whitePlaRow])),
      ),
      http.delete('/api/v1/filament-tracking/buckets/1', () => {
        deleted = true;
        return HttpResponse.json({ status: 'ok' });
      }),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    await user.click(await screen.findByRole('button', { name: 'Remove White · PLA' }));
    expect(await screen.findByRole('heading', { name: 'Delete' })).toBeInTheDocument();
    expect(
      screen.getByText(/Are you sure you want to delete White · PLA/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByText('White · PLA')).toBeInTheDocument();
    expect(deleted).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Remove White · PLA' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.getByText('No color stock yet')).toBeInTheDocument();
    });
  });

  it('edits on-hand stock from the row action', async () => {
    const user = userEvent.setup();
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.patch('/api/v1/filament-tracking/buckets/1', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 1,
          color_name: 'White',
          material: 'PLA',
          color_hex: 'FFFFFF',
          on_hand_grams: 85000,
          spool_weight_grams: 1000,
          stock_initialized: true,
          tracking_started_at: '2026-08-08T00:00:00Z',
          created_at: '2026-08-08T00:00:00Z',
        });
      }),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    await user.click(await screen.findByRole('button', { name: 'Edit White · PLA' }));
    expect(await screen.findByRole('heading', { name: 'Edit White · PLA' })).toBeInTheDocument();

    const kgInput = screen.getByLabelText('On hand (kg)');
    await user.clear(kgInput);
    await user.type(kgInput, '85');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(patched).toMatchObject({
        on_hand_grams: 85000,
        spool_weight_grams: 1000,
        cost_per_kg: 25,
        lead_time_days: 7,
      });
    });
  });

  it('opens the spool color picker when adding stock', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    await user.click((await screen.findAllByRole('button', { name: 'Add stock' }))[0]);
    expect(await screen.findByPlaceholderText('Search colors...')).toBeInTheDocument();
    expect(screen.getByText('Common colors')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Select material...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search brand...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Basic, Matte, Silk...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jade White, Fire Red...')).toBeInTheDocument();
    expect(screen.getByText('Extra colors')).toBeInTheDocument();
    expect(screen.getByTestId('extra-colors-input')).toBeInTheDocument();
    expect(screen.getByText('Effect')).toBeInTheDocument();
    expect(screen.getByTestId('effect-type-select')).toBeInTheDocument();
    expect(screen.getByLabelText('Cost per kg')).toBeInTheDocument();
    expect(screen.getByLabelText('Shipping time')).toHaveValue(7);
  });
});
