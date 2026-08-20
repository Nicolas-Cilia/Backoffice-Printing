/**
 * AssignTrackingColorModal — pick a named tracking product for a printer slot.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { AssignTrackingColorModal } from '../../components/AssignTrackingColorModal';
import { server } from '../mocks/server';

const easyRockWhite = {
  bucket_id: 10,
  color_name: 'EasyRock White',
  material: 'PLA',
  brand: 'EasyRock',
  subtype: null,
  extra_colors: null,
  effect_type: null,
  color_hex: 'FFFFFF',
  on_hand_grams: 8000,
  stock_initialized: true,
  spool_weight_grams: 1000,
  spool_equivalent: 8,
  observed_usage_grams: 200,
  daily_rate_grams: 20,
  monthly_estimate_grams: 600,
  projected_remaining_grams: 7400,
  recommended_spools: 0,
  days_of_cover: 370,
  days_until_order: 360,
  stage: 'week',
  cost_per_kg: 25,
  on_hand_value: 200,
  monthly_cost_estimate: 15,
};

const jadeWhite = {
  ...easyRockWhite,
  bucket_id: 11,
  color_name: 'Jade White',
  brand: 'Bambu Lab',
};

function planPayload(materials = [easyRockWhite, jadeWhite]) {
  return {
    stage: 'week',
    days_observed: 10,
    window_label: 'Week average',
    materials,
    total_on_hand_grams: 16000,
    total_observed_usage_grams: 400,
    total_monthly_estimate_grams: 1200,
    total_on_hand_value: 400,
    total_monthly_cost_estimate: 30,
    total_recommended_spools: 0,
    soonest_days_until_order: 360,
    tracking_started_at: '2026-08-08T00:00:00Z',
  };
}

describe('AssignTrackingColorModal', () => {
  it('lists named products and assigns the selected one', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let assigned: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.post('/api/v1/filament-tracking/assignments', async ({ request }) => {
        assigned = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 1,
          printer_id: 3,
          ams_id: 0,
          tray_id: 2,
          bucket_id: 10,
          color_name: 'EasyRock White',
          material: 'PLA',
          brand: 'EasyRock',
          subtype: null,
          extra_colors: null,
          effect_type: null,
          color_hex: 'FFFFFF',
        });
      }),
    );

    render(
      <AssignTrackingColorModal printerId={3} amsId={0} trayId={2} onClose={onClose} />,
    );

    expect(await screen.findByRole('heading', { name: 'Assign tracking product' })).toBeInTheDocument();
    expect(await screen.findByText('EasyRock White · EasyRock · PLA')).toBeInTheDocument();
    expect(screen.getByText('Jade White · Bambu Lab · PLA')).toBeInTheDocument();
    expect(screen.queryByText('White · PLA')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'EasyRock White · EasyRock · PLA' }));

    await waitFor(() => {
      expect(assigned).toMatchObject({
        printer_id: 3,
        ams_id: 0,
        tray_id: 2,
        bucket_id: 10,
      });
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('filters the product list by search', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
    );

    render(
      <AssignTrackingColorModal printerId={1} amsId={0} trayId={0} onClose={vi.fn()} />,
    );

    await screen.findByText('EasyRock White · EasyRock · PLA');
    await user.type(screen.getByPlaceholderText('Search EasyRock White PLA…'), 'Jade');

    expect(screen.getByText('Jade White · Bambu Lab · PLA')).toBeInTheDocument();
    expect(screen.queryByText('EasyRock White · EasyRock · PLA')).not.toBeInTheDocument();
  });

  it('closes without assigning when Cancel is pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let posted = false;
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.post('/api/v1/filament-tracking/assignments', () => {
        posted = true;
        return HttpResponse.json({});
      }),
    );

    render(
      <AssignTrackingColorModal printerId={1} amsId={0} trayId={0} onClose={onClose} />,
    );

    await screen.findByText('EasyRock White · EasyRock · PLA');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posted).toBe(false);
  });
});
