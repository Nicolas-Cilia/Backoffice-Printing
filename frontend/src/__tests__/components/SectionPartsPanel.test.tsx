import { describe, it, expect } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SectionPartsPanel } from '../../components/SectionPartsPanel';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import type { LibrarySectionPart } from '../../api/client';

const seededPart: LibrarySectionPart = {
  id: 4,
  section_id: 1,
  code: 'TOP',
  name: 'Housing',
  locked_parameters: { layer_height: 0.2, wall_loops: 3 },
  has_thumbnail: true,
  instance_count: 2,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('SectionPartsPanel', () => {
  it('offers Replace parameters when the part already has a contract', async () => {
    const user = userEvent.setup();
    let replaceResolution: string | null = null;
    server.use(
      http.get('/api/v1/library/sections/1/parts', () => HttpResponse.json([seededPart])),
      http.post('/api/v1/library/sections/1/parts/4/parameters/preview', () =>
        HttpResponse.json({
          parameter_diff: [
            { key: 'layer_height', locked: 0.2, incoming: 0.28, match: false },
            { key: 'wall_loops', locked: 3, incoming: 3, match: true },
          ],
          has_mismatches: true,
          has_existing_contract: true,
        }),
      ),
      http.post('/api/v1/library/sections/1/parts/4/parameters', async ({ request }) => {
        const form = await request.formData();
        replaceResolution = form.get('resolution') as string | null;
        return HttpResponse.json({
          ...seededPart,
          locked_parameters: { layer_height: 0.28, wall_loops: 3 },
        });
      }),
    );

    render(<SectionPartsPanel sectionId={1} canManage />);

    await user.click(screen.getByRole('button', { name: 'Parts' }));
    await waitFor(() => {
      expect(screen.getByTestId('section-part-replace')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Set parameters' })).not.toBeInTheDocument();

    await user.click(screen.getByTestId('section-part-replace'));
    await waitFor(() => {
      expect(screen.getByText('Replace part parameters')).toBeInTheDocument();
    });

    const file = new File(['3mf'], 'next.3mf', { type: 'application/octet-stream' });
    await user.upload(screen.getByTestId('section-part-replace-file'), file);

    await waitFor(() => {
      expect(screen.getByText(/parameter\(s\) differ/i)).toBeInTheDocument();
    });

    await user.click(within(screen.getByRole('dialog', { name: /Replace part parameters/ })).getByRole('button', { name: 'Replace parameters' }));
    await waitFor(() => {
      expect(replaceResolution).toBe('accept_baseline');
    });
  });

  it('cache-busts the card thumbnail after replace so the new plate image shows', async () => {
    const user = userEvent.setup();
    let listed: LibrarySectionPart = { ...seededPart };
    server.use(
      http.get('/api/v1/library/sections/1/parts', () => HttpResponse.json([listed])),
      http.post('/api/v1/library/sections/1/parts/4/parameters/preview', () =>
        HttpResponse.json({
          parameter_diff: [],
          has_mismatches: false,
          has_existing_contract: true,
        }),
      ),
      http.post('/api/v1/library/sections/1/parts/4/parameters', async () => {
        listed = {
          ...listed,
          locked_parameters: { layer_height: 0.28, wall_loops: 3 },
          has_thumbnail: true,
          updated_at: '2026-01-01T00:00:01Z',
        };
        return HttpResponse.json(listed);
      }),
    );

    render(<SectionPartsPanel sectionId={1} canManage />);
    await user.click(screen.getByRole('button', { name: 'Parts' }));

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Housing' })).toHaveAttribute(
        'src',
        expect.stringContaining(`v=${encodeURIComponent('2026-01-01T00:00:00Z')}`),
      );
    });

    await user.click(screen.getByTestId('section-part-replace'));
    await waitFor(() => {
      expect(screen.getByText('Replace part parameters')).toBeInTheDocument();
    });

    const file = new File(['3mf'], 'next.3mf', { type: 'application/octet-stream' });
    await user.upload(screen.getByTestId('section-part-replace-file'), file);
    await waitFor(() => {
      expect(
        within(screen.getByRole('dialog', { name: /Replace part parameters/ })).getByRole('button', {
          name: 'Replace parameters',
        }),
      ).toBeEnabled();
    });

    await user.click(
      within(screen.getByRole('dialog', { name: /Replace part parameters/ })).getByRole('button', {
        name: 'Replace parameters',
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Housing' })).toHaveAttribute(
        'src',
        expect.stringContaining(`v=${encodeURIComponent('2026-01-01T00:00:01Z')}`),
      );
    });
  });

  it('drops the card thumbnail when the replacement 3MF has no cover image', async () => {
    const user = userEvent.setup();
    let listed: LibrarySectionPart = { ...seededPart };
    server.use(
      http.get('/api/v1/library/sections/1/parts', () => HttpResponse.json([listed])),
      http.post('/api/v1/library/sections/1/parts/4/parameters/preview', () =>
        HttpResponse.json({
          parameter_diff: [],
          has_mismatches: false,
          has_existing_contract: true,
        }),
      ),
      http.post('/api/v1/library/sections/1/parts/4/parameters', async () => {
        listed = {
          ...listed,
          has_thumbnail: false,
          updated_at: '2026-01-01T00:00:02Z',
        };
        return HttpResponse.json(listed);
      }),
    );

    render(<SectionPartsPanel sectionId={1} canManage />);
    await user.click(screen.getByRole('button', { name: 'Parts' }));
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Housing' })).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('section-part-replace'));
    const file = new File(['3mf'], 'bare.3mf', { type: 'application/octet-stream' });
    await user.upload(screen.getByTestId('section-part-replace-file'), file);
    await waitFor(() => {
      expect(
        within(screen.getByRole('dialog', { name: /Replace part parameters/ })).getByRole('button', {
          name: 'Replace parameters',
        }),
      ).toBeEnabled();
    });
    await user.click(
      within(screen.getByRole('dialog', { name: /Replace part parameters/ })).getByRole('button', {
        name: 'Replace parameters',
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('img', { name: 'Housing' })).not.toBeInTheDocument();
    });
  });

  it('reorders parts with the drag handle so TOP can sit first', async () => {
    const bot: LibrarySectionPart = {
      ...seededPart,
      id: 1,
      code: 'BOT',
      name: 'Bottom',
      sort_order: 0,
      has_thumbnail: false,
      locked_parameters: null,
      instance_count: 0,
    };
    const top: LibrarySectionPart = {
      ...seededPart,
      id: 2,
      code: 'TOP',
      name: 'Housing',
      sort_order: 1,
    };
    let reorderedIds: number[] | null = null;
    server.use(
      http.get('/api/v1/library/sections/1/parts', () =>
        HttpResponse.json(reorderedIds ? [top, bot] : [bot, top]),
      ),
      http.put('/api/v1/library/sections/1/parts/reorder', async ({ request }) => {
        const body = (await request.json()) as { ids: number[] };
        reorderedIds = body.ids;
        return HttpResponse.json([
          { ...top, sort_order: 0 },
          { ...bot, sort_order: 1 },
        ]);
      }),
    );

    render(<SectionPartsPanel sectionId={1} canManage />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Parts' }));

    await waitFor(() => {
      expect(screen.getByTestId('section-part-card-BOT')).toBeInTheDocument();
      expect(screen.getByTestId('section-part-card-TOP')).toBeInTheDocument();
    });

    const dialog = screen.getByRole('dialog', { name: 'Section parts' });
    const cards = within(dialog)
      .getAllByTestId(/section-part-card-/)
      .map((node) => node.getAttribute('data-testid'));
    expect(cards).toEqual(['section-part-card-BOT', 'section-part-card-TOP']);

    const handles = within(dialog).getAllByRole('button', { name: 'Reorder' });
    fireEvent.keyDown(handles[1], { key: 'ArrowLeft' });

    await waitFor(() => {
      expect(reorderedIds).toEqual([2, 1]);
    });
    await waitFor(() => {
      const next = within(dialog)
        .getAllByTestId(/section-part-card-/)
        .map((node) => node.getAttribute('data-testid'));
      expect(next).toEqual(['section-part-card-TOP', 'section-part-card-BOT']);
    });
  });
});
