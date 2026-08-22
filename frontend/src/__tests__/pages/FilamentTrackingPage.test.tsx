import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render, createTestQueryClient } from '../utils';
import InventoryPageRouter from '../../pages/InventoryPage';
import { FilamentTrackingPage } from '../../pages/FilamentTrackingPage';
import { ringCornerRadiusForSlice } from '../../pages/filamentTrackingChart';
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
    expect(await screen.findByText('No product stock yet')).toBeInTheDocument();
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
    expect(screen.getByText('Named product stock')).toBeInTheDocument();
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
      expect(screen.getByText('No product stock yet')).toBeInTheDocument();
    });
  });

  it('refetches printer consumption after deleting a tracking product', async () => {
    const user = userEvent.setup();
    let deleted = false;
    let consumptionGets = 0;
    server.use(
      http.get('/api/v1/filament-tracking/plan', () =>
        HttpResponse.json(planPayload(deleted ? [] : [whitePlaRow])),
      ),
      http.get('/api/v1/filament-tracking/printer-consumption', () => {
        consumptionGets += 1;
        return HttpResponse.json([]);
      }),
      http.delete('/api/v1/filament-tracking/buckets/1', () => {
        deleted = true;
        return HttpResponse.json({ status: 'ok' });
      }),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    await user.click(await screen.findByRole('button', { name: 'Remove White · PLA' }));
    const getsBeforeDelete = consumptionGets;
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(consumptionGets).toBeGreaterThan(getsBeforeDelete);
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

  it('shows live usage per hour from assigned-product deductions', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.get('/api/v1/filament-tracking/live-rate', () =>
        HttpResponse.json({
          grams_per_hour: 120,
          grams_last_hour: 40,
          grams_so_far: 40,
          active_jobs: 1,
          products: [
            {
              bucket_id: 1,
              color_name: 'EasyRock White',
              material: 'PLA',
              brand: 'EasyRock',
              subtype: null,
              extra_colors: null,
              effect_type: null,
              color_hex: 'FFFFFF',
              grams_so_far: 40,
              grams_last_hour: 40,
              grams_per_hour: 120,
            },
          ],
        }),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const overview = await screen.findByRole('region', { name: 'Filament overview' });
    expect(within(overview).getByText('Live usage')).toBeInTheDocument();
    expect(within(overview).queryByRole('heading', { name: 'Live usage' })).not.toBeInTheDocument();
    const liveTile = within(overview).getByText('Live usage').closest('article');
    expect(liveTile).toBeTruthy();
    expect(await within(liveTile as HTMLElement).findAllByText('120 g/h', { hidden: true })).toHaveLength(2);
    expect(within(liveTile as HTMLElement).getByText('40 g in the last hour')).toBeInTheDocument();
    expect(
      within(liveTile as HTMLElement).getByText('EasyRock White · EasyRock · PLA', { hidden: true }),
    ).toBeInTheDocument();
    expect(within(liveTile as HTMLElement).getByText('1 running now', { hidden: true })).toBeInTheDocument();
  });

  it('shows an em dash while live usage is warming up and keeps last-hour grams', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.get('/api/v1/filament-tracking/live-rate', () =>
        HttpResponse.json({
          grams_per_hour: 0,
          grams_last_hour: 84,
          grams_so_far: 84,
          active_jobs: 2,
          warming_up: true,
          products: [
            {
              bucket_id: 1,
              color_name: 'EasyRock White',
              material: 'PLA',
              brand: 'EasyRock',
              subtype: null,
              extra_colors: null,
              effect_type: null,
              color_hex: 'FFFFFF',
              grams_so_far: 84,
              grams_last_hour: 84,
              grams_per_hour: 0,
            },
          ],
        }),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const overview = await screen.findByRole('region', { name: 'Filament overview' });
    const liveTile = within(overview).getByText('Live usage').closest('article');
    expect(liveTile).toBeTruthy();
    expect(await within(liveTile as HTMLElement).findAllByText('—', { hidden: true })).not.toHaveLength(0);
    expect(within(liveTile as HTMLElement).queryByText('9.1 kg/h')).not.toBeInTheDocument();
    expect(await within(liveTile as HTMLElement).findByText('84 g in the last hour')).toBeInTheDocument();
    expect(within(liveTile as HTMLElement).queryByText('No tracked prints running')).not.toBeInTheDocument();
  });

  it('shows hundreds of grams per hour without converting to kg/h', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.get('/api/v1/filament-tracking/live-rate', () =>
        HttpResponse.json({
          grams_per_hour: 182,
          grams_last_hour: 91,
          grams_so_far: 91,
          active_jobs: 2,
          warming_up: false,
          products: [],
        }),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const overview = await screen.findByRole('region', { name: 'Filament overview' });
    const liveTile = within(overview).getByText('Live usage').closest('article');
    expect(await within(liveTile as HTMLElement).findByText('182 g/h')).toBeInTheDocument();
    expect(within(liveTile as HTMLElement).queryByText(/kg\/h/)).not.toBeInTheDocument();
    expect(within(liveTile as HTMLElement).getByText('91 g in the last hour')).toBeInTheDocument();
  });

  it('shows recent usage as grammage without a leading minus', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.get('/api/v1/filament-tracking/events', () =>
        HttpResponse.json([
          {
            id: 11,
            bucket_id: 1,
            color_name: 'EasyRock White',
            material: 'PLA',
            brand: 'EasyRock',
            subtype: null,
            extra_colors: null,
            effect_type: null,
            color_hex: 'FFFFFF',
            grams: 12,
            occurred_at: '2026-08-20T12:00:00Z',
            kind: 'completed',
            progress: null,
            archive_id: 42,
            printer_id: 1,
            print_name: 'Benchy',
          },
        ]),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const heading = await screen.findByRole('heading', { name: 'Recent usage' });
    const section = heading.closest('section') as HTMLElement;
    expect(section).toBeTruthy();
    expect(await within(section).findByText('Benchy')).toBeInTheDocument();
    expect(within(section).getByText('12 g')).toBeInTheDocument();
    expect(within(section).queryByText('-12 g')).not.toBeInTheDocument();
    expect(within(section).queryByText('-12 grams')).not.toBeInTheDocument();
  });

  it('labels a skip-objects recent-usage row est. and leaves a full-plate job unmarked', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.get('/api/v1/filament-tracking/printer-consumption', () =>
        HttpResponse.json([
          { printer_id: 2, name: 'Founders (6)', grams: 21 },
          { printer_id: 1, name: 'Trump (4)', grams: 133 },
        ]),
      ),
      http.get('/api/v1/filament-tracking/events', () =>
        HttpResponse.json([
          {
            id: 11,
            bucket_id: 1,
            color_name: 'EasyRock White',
            material: 'PLA',
            brand: 'EasyRock',
            subtype: null,
            extra_colors: '000000',
            effect_type: null,
            color_hex: 'FFFFFF',
            grams: 21,
            occurred_at: '2026-08-20T12:00:00Z',
            kind: 'printing',
            progress: 16,
            archive_id: 47,
            printer_id: 2,
            print_name: 'BTN-x47-.2mm-height-.53-width-1.0.0-X1C',
            estimated: true,
          },
          {
            id: 12,
            bucket_id: 1,
            color_name: 'EasyRock White',
            material: 'PLA',
            brand: 'EasyRock',
            subtype: null,
            extra_colors: null,
            effect_type: null,
            color_hex: 'FFFFFF',
            grams: 133,
            occurred_at: '2026-08-20T12:00:00Z',
            kind: 'completed',
            progress: null,
            archive_id: 42,
            printer_id: 1,
            print_name: 'BOT-x2-1.8.2-X1C',
            estimated: false,
          },
        ]),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const heading = await screen.findByRole('heading', { name: 'Recent usage' });
    const section = heading.closest('section') as HTMLElement;
    expect(await within(section).findByText('BTN-x47-.2mm-height-.53-width-1.0.0-X1C')).toBeInTheDocument();
    expect(within(section).getByText('BOT-x2-1.8.2-X1C')).toBeInTheDocument();
    expect(within(section).getAllByText('est.')).toHaveLength(1);
    const foundersRow = within(section).getByText('BTN-x47-.2mm-height-.53-width-1.0.0-X1C').closest('li') as HTMLElement;
    const trumpRow = within(section).getByText('BOT-x2-1.8.2-X1C').closest('li') as HTMLElement;
    expect(within(foundersRow).getByText('est.')).toBeInTheDocument();
    expect(within(foundersRow).getByText('21 g')).toBeInTheDocument();
    expect(within(trumpRow).queryByText('est.')).not.toBeInTheDocument();
    expect(within(trumpRow).getByText('133 g')).toBeInTheDocument();
  });

  it('groups a two-color print into one recent-usage row with both swatches', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.get('/api/v1/filament-tracking/printer-consumption', () =>
        HttpResponse.json([
          { printer_id: 2, name: 'Founders (6)', grams: 24.5 },
          { printer_id: 1, name: 'Trump (4)', grams: 0 },
        ]),
      ),
      http.get('/api/v1/filament-tracking/events', () =>
        HttpResponse.json([
          {
            id: 1,
            bucket_id: 1,
            color_name: 'EasyRock White',
            material: 'PLA',
            brand: null,
            extra_colors: null,
            effect_type: null,
            color_hex: 'FFFFFF',
            grams: 21.1,
            occurred_at: '2026-08-20T18:22:20Z',
            kind: 'printing',
            progress: 12,
            archive_id: 5,
            printer_id: 2,
            print_name: 'BTN-x47-.2mm-height-.53-width-1.0.0-X1C',
          },
          {
            id: 2,
            bucket_id: 2,
            color_name: 'Black',
            material: 'PLA',
            brand: 'PolyLite',
            extra_colors: null,
            effect_type: null,
            color_hex: '000000',
            grams: 3.4,
            occurred_at: '2026-08-20T18:22:20Z',
            kind: 'printing',
            progress: 12,
            archive_id: 5,
            printer_id: 2,
            print_name: 'BTN-x47-.2mm-height-.53-width-1.0.0-X1C',
          },
        ]),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const heading = await screen.findByRole('heading', { name: 'Recent usage' });
    const section = heading.closest('section') as HTMLElement;
    expect(await within(section).findByText('BTN-x47-.2mm-height-.53-width-1.0.0-X1C')).toBeInTheDocument();
    expect(within(section).getAllByText('BTN-x47-.2mm-height-.53-width-1.0.0-X1C')).toHaveLength(1);
    expect(within(section).getAllByTestId('filament-swatch')).toHaveLength(2);
    expect(within(section).getByText('EasyRock White 21 g · Black 3 g')).toBeInTheDocument();
    expect(within(section).getByText('25 g')).toBeInTheDocument();
    expect(within(section).queryByText('-21 grams')).not.toBeInTheDocument();
    expect(within(section).queryByText('-3 grams')).not.toBeInTheDocument();
    expect(within(section).getByText(/Founders \(6\).*printing/)).toBeInTheDocument();
  });

  it('keeps the same filename on two printers as two recent-usage rows', async () => {
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.get('/api/v1/filament-tracking/printer-consumption', () =>
        HttpResponse.json([
          { printer_id: 2, name: 'Founders (6)', grams: 21 },
          { printer_id: 1, name: 'Trump (4)', grams: 12 },
        ]),
      ),
      http.get('/api/v1/filament-tracking/events', () =>
        HttpResponse.json([
          {
            id: 1,
            bucket_id: 1,
            color_name: 'EasyRock White',
            material: 'PLA',
            brand: null,
            extra_colors: null,
            effect_type: null,
            color_hex: 'FFFFFF',
            grams: 21,
            occurred_at: '2026-08-20T18:22:20Z',
            kind: 'printing',
            progress: 16,
            archive_id: 5,
            printer_id: 2,
            print_name: 'BTN-x47-.2mm-height-.53-width-1.0.0-X1C',
          },
          {
            id: 2,
            bucket_id: 1,
            color_name: 'EasyRock White',
            material: 'PLA',
            brand: null,
            extra_colors: null,
            effect_type: null,
            color_hex: 'FFFFFF',
            grams: 12,
            occurred_at: '2026-08-20T18:25:00Z',
            kind: 'printing',
            progress: 35,
            archive_id: 5,
            printer_id: 1,
            print_name: 'BTN-x47-.2mm-height-.53-width-1.0.0-X1C',
          },
        ]),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const heading = await screen.findByRole('heading', { name: 'Recent usage' });
    const section = heading.closest('section') as HTMLElement;
    expect(await within(section).findAllByText('BTN-x47-.2mm-height-.53-width-1.0.0-X1C')).toHaveLength(2);
    expect(within(section).getByText(/Founders \(6\).*printing/)).toBeInTheDocument();
    expect(within(section).getByText(/Trump \(4\).*printing/)).toBeInTheDocument();
    expect(within(section).getByText('21 g')).toBeInTheDocument();
    expect(within(section).getByText('12 g')).toBeInTheDocument();
  });

  it('keeps equal-height cards with a fade-scrolling by-printer legend', async () => {
    const printers = Array.from({ length: 14 }, (_, i) => ({
      printer_id: i + 1,
      name: `Printer #${i + 1}`,
      grams: i < 3 ? (3 - i) * 5 : 0,
    }));
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.get('/api/v1/filament-tracking/printer-consumption', () => HttpResponse.json(printers)),
      http.get('/api/v1/filament-tracking/events', () => HttpResponse.json([])),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const heading = await screen.findByRole('heading', { name: 'Consumption by printer' });
    const section = heading.closest('section') as HTMLElement;
    expect(section.className).toMatch(/lg:h-\[22rem]/);
    expect(await within(section).findByText('Printer #1')).toBeInTheDocument();
    const legend = within(section).getByText('Printer #1').closest('ul') as HTMLElement;
    expect(legend.className).not.toMatch(/justify-evenly/);
    expect(legend.className).toMatch(/gap-1\.5/);
    expect(within(section).getByTestId('scroll-fade-scroller')).toBeInTheDocument();
    expect(within(section).getByTestId('scroll-more-fade')).toBeInTheDocument();

    const recentHeading = screen.getByRole('heading', { name: 'Recent usage' });
    const recentSection = recentHeading.closest('section') as HTMLElement;
    expect(recentSection.className).toMatch(/lg:h-\[22rem]/);
  });

  it('drops pie cornerRadius on tiny slices so caps are not square', () => {
    // 2 g of 100 g ≈ 7° after gaps — below MIN_SLICE_ANGLE_FOR_CORNER
    expect(ringCornerRadiusForSlice(2, 100, 3)).toBe(0);
    // 40 g of 100 g is large enough for rounded caps
    expect(ringCornerRadiusForSlice(40, 100, 3)).toBe(6);
    expect(ringCornerRadiusForSlice(100, 100, 1)).toBe(6);
  });

  it('shows named product rows instead of a collapsed color · material family', async () => {
    const easyRockWhite = {
      ...whitePlaRow,
      bucket_id: 1,
      color_name: 'EasyRock White',
      brand: 'EasyRock',
      extra_colors: null,
      effect_type: null,
    };
    const jadeWhite = {
      ...whitePlaRow,
      bucket_id: 2,
      color_name: 'Jade White',
      brand: 'Bambu Lab',
      on_hand_grams: 12000,
      on_hand_value: 300,
      observed_usage_grams: 800,
    };
    server.use(
      http.get('/api/v1/filament-tracking/plan', () =>
        HttpResponse.json(planPayload([easyRockWhite, jadeWhite])),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    const easyRock = await screen.findByText('EasyRock White · EasyRock · PLA');
    const jade = await screen.findByText('Jade White · Bambu Lab · PLA');
    expect(easyRock.closest('tr')).not.toBe(jade.closest('tr'));
    expect(screen.queryByText('White · PLA')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove EasyRock White · EasyRock · PLA' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Jade White · Bambu Lab · PLA' })).toBeInTheDocument();
  });

  it('invalidates printer-consumption after deleting a product', async () => {
    const user = userEvent.setup();
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.delete('/api/v1/filament-tracking/buckets/1', () => HttpResponse.json({ status: 'ok' })),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(
      <QueryClientProvider client={queryClient}>
        <FilamentTrackingPage />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Remove White · PLA' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const keys = invalidateSpy.mock.calls
        .map((call) => (call[0] as { queryKey?: readonly unknown[] })?.queryKey?.[0])
        .filter(Boolean);
      expect(keys).toEqual(
        expect.arrayContaining([
          'filament-tracking-plan',
          'filament-tracking-events',
          'filament-tracking-printer-consumption',
        ]),
      );
    });
  });

  it('asks for confirmation before resetting tracking data and keeps the stock table', async () => {
    const user = userEvent.setup();
    let resetCalled = false;
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.post('/api/v1/filament-tracking/reset-usage', () => {
        resetCalled = true;
        return HttpResponse.json({ status: 'ok', deleted: 4 });
      }),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(<InventoryPageRouter />);

    await user.click(await screen.findByRole('button', { name: 'Reset tracking' }));
    expect(await screen.findByRole('heading', { name: 'Reset tracking data?' })).toBeInTheDocument();
    expect(screen.getByText(/This permanently erases observed usage/)).toBeInTheDocument();
    expect(screen.getByText(/Named products, on-hand stock/)).toBeInTheDocument();
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Reset tracking data?' })).not.toBeInTheDocument();
    expect(resetCalled).toBe(false);
    expect(screen.getByText('White · PLA')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset tracking' }));
    await user.click(screen.getByRole('button', { name: 'Erase tracking data' }));
    await waitFor(() => {
      expect(resetCalled).toBe(true);
    });
    expect(screen.getByText('White · PLA')).toBeInTheDocument();
  });

  it('invalidates usage queries after resetting tracking data', async () => {
    const user = userEvent.setup();
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    server.use(
      http.get('/api/v1/filament-tracking/plan', () => HttpResponse.json(planPayload())),
      http.post('/api/v1/filament-tracking/reset-usage', () =>
        HttpResponse.json({ status: 'ok', deleted: 1 }),
      ),
    );

    window.history.pushState({}, '', '/inventory?tab=tracking');
    render(
      <QueryClientProvider client={queryClient}>
        <FilamentTrackingPage />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Reset tracking' }));
    await user.click(screen.getByRole('button', { name: 'Erase tracking data' }));

    await waitFor(() => {
      const keys = invalidateSpy.mock.calls
        .map((call) => (call[0] as { queryKey?: readonly unknown[] })?.queryKey?.[0])
        .filter(Boolean);
      expect(keys).toEqual(
        expect.arrayContaining([
          'filament-tracking-plan',
          'filament-tracking-events',
          'filament-tracking-printer-consumption',
          'filament-tracking-live-rate',
        ]),
      );
    });
  });
});
