import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { ProductionFolderView } from '../../../components/production/ProductionFolderView';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { ProductionFolderView as ProductionFolderPayload } from '../../../api/client';

const folderWithSpecs: ProductionFolderPayload = {
  folder_id: 9,
  printer_model: 'X1C',
  section_id: 1,
  parts: [
    {
      id: 1,
      code: 'TOP',
      name: 'Top Housing',
      instance_id: 10,
      locked_parameters: {
        layer_height: 0.2,
        sparse_infill_density: 20,
        brim_type: 'auto_brim',
        brim_object_gap: 0.1,
        fuzzy_skin: 'none',
        wall_loops: 3,
        enable_support: false,
      },
      slots: [
        {
          id: 5,
          quantity: 1,
          major: 1,
          revision: 13,
          minor: 2,
          version: '1.13.2',
          active_file: {
            id: 42,
            filename: 'TOP - 1.13.2 - X1C.gcode.3mf',
            thumbnail_path: null,
            file_size: 1024,
            print_time_seconds: 3600,
            sliced_for_model: 'X1C',
          },
          has_overrides: false,
          last_mismatch: false,
          parameter_overrides: null,
        },
      ],
    },
    {
      id: 2,
      code: 'BOT',
      name: 'Bottom Housing',
      instance_id: null,
      locked_parameters: null,
      slots: [],
    },
  ],
};

describe('ProductionFolderView', () => {
  it('shows a compact spec summary and full specs when locked_parameters are present', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/production/folders/9', () => HttpResponse.json(folderWithSpecs)),
    );

    render(<ProductionFolderView folderId={9} printerModel="X1C" canUpload />);

    await waitFor(() => {
      expect(screen.getByText('TOP - 1.13.2 - X1C.gcode.3mf')).toBeInTheDocument();
    });
    expect(screen.getByTestId('production-spec-summary')).toHaveTextContent('0.2 mm');
    expect(screen.getByTestId('production-spec-summary')).toHaveTextContent('20% infill');
    expect(screen.getByTestId('production-spec-summary')).toHaveTextContent('Auto brim · 0.1 mm gap');
    expect(screen.getByTestId('production-spec-summary')).toHaveTextContent('Supports: Off');
    expect(screen.queryByRole('button', { name: 'View specs' })).not.toBeInTheDocument();

    const specTrigger = screen.getByRole('button', { name: 'Matches spec' });
    expect(specTrigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(specTrigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(specTrigger);
    expect(specTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Current print specs')).toBeInTheDocument();
    expect(screen.getByText('Layer height')).toBeInTheDocument();
    expect(screen.getByText('Infill density')).toBeInTheDocument();
    expect(screen.getByText('Walls')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Brim-object gap')).toBeInTheDocument();
    expect(screen.getByText('0.1 mm')).toBeInTheDocument();
    expect(screen.queryByText('Support type')).not.toBeInTheDocument();
    expect(screen.queryByText('Support style')).not.toBeInTheDocument();
  });

  it('does not render empty catalog parts as file cards', async () => {
    server.use(
      http.get('/api/v1/production/folders/9', () => HttpResponse.json(folderWithSpecs)),
    );

    render(<ProductionFolderView folderId={9} printerModel="X1C" canUpload={false} />);

    await waitFor(() => {
      expect(screen.getByText('TOP')).toBeInTheDocument();
    });
    expect(screen.getByText('BOT')).toBeInTheDocument();
    expect(screen.getAllByText(/1\.13\.2/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('No active file')).toHaveLength(0);
    expect(screen.getByText('No files for this part yet.')).toBeInTheDocument();
  });

  it('does not show BOT or BUT for A1 default parts', async () => {
    server.use(
      http.get('/api/v1/production/folders/11', () =>
        HttpResponse.json({
          folder_id: 11,
          printer_model: 'A1',
          section_id: 1,
          parts: [
            { id: 1, code: 'TOP', name: 'Top Housing', instance_id: 20, locked_parameters: null, slots: [] },
            { id: 3, code: 'KNB', name: 'Knob', instance_id: 21, locked_parameters: null, slots: [] },
          ],
        }),
      ),
    );

    render(<ProductionFolderView folderId={11} printerModel="A1" canUpload />);

    await waitFor(() => {
      expect(screen.getByText('TOP')).toBeInTheDocument();
    });
    expect(screen.getByText('KNB')).toBeInTheDocument();
    expect(screen.queryByText('BOT')).not.toBeInTheDocument();
    expect(screen.queryByText('BUT')).not.toBeInTheDocument();
  });

  it('confirms before removing an empty part row', async () => {
    const user = userEvent.setup();
    let removedPartId: string | null = null;
    server.use(
      http.get('/api/v1/production/folders/9', () => HttpResponse.json(folderWithSpecs)),
      http.delete('/api/v1/production/folders/9/parts/:id', ({ params }) => {
        removedPartId = String(params.id);
        return HttpResponse.json({ removed: true, files_trashed: 0 });
      }),
    );

    render(<ProductionFolderView folderId={9} printerModel="X1C" canUpload />);

    const removeButtons = await screen.findAllByRole('button', { name: 'Remove part' });
    await user.click(removeButtons[removeButtons.length - 1]);
    expect(screen.getByText(/Remove BOT \(Bottom Housing\) from X1C/)).toBeInTheDocument();
    expect(removedPartId).toBeNull();

    const confirmButtons = screen.getAllByRole('button', { name: 'Remove part' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => {
      expect(removedPartId).toBe('2');
    });
  });

  it('does not make the status label a button when the slot has no specs', async () => {
    server.use(
      http.get('/api/v1/production/folders/9', () =>
        HttpResponse.json({
          folder_id: 9,
          printer_model: 'X1C',
          section_id: 1,
          parts: [
            {
              id: 1,
              code: 'TOP',
              name: 'Top Housing',
              instance_id: 10,
              locked_parameters: null,
              slots: [
                {
                  id: 5,
                  quantity: 1,
                  major: 1,
                  revision: 13,
                  minor: 2,
                  version: '1.13.2',
                  active_file: null,
                  has_overrides: false,
                  last_mismatch: false,
                  parameter_overrides: null,
                },
              ],
            },
          ],
        }),
      ),
    );

    render(<ProductionFolderView folderId={9} printerModel="X1C" canUpload={false} />);

    await waitFor(() => {
      expect(screen.getByText('No active file')).toBeInTheDocument();
    });
    expect(screen.getByText('Matches spec')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Matches spec' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View specs' })).not.toBeInTheDocument();
  });

  it('opens specs from the matches-spec label with Enter', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/production/folders/9', () => HttpResponse.json(folderWithSpecs)),
    );

    render(<ProductionFolderView folderId={9} printerModel="X1C" canUpload={false} />);

    const specTrigger = await screen.findByRole('button', { name: 'Matches spec' });
    specTrigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Current print specs')).toBeInTheDocument();
  });

  it('requires confirmation before deleting a production slot', async () => {
    const user = userEvent.setup();
    let deletedSlotId: string | null = null;
    server.use(
      http.get('/api/v1/production/folders/9', () => HttpResponse.json(folderWithSpecs)),
      http.delete('/api/v1/production/slots/:id', ({ params }) => {
        deletedSlotId = String(params.id);
        return HttpResponse.json({ deleted: true });
      }),
    );

    render(<ProductionFolderView folderId={9} printerModel="X1C" canUpload />);

    const deleteControl = await screen.findByRole('button', { name: 'Delete' });
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(deleteControl).toBeInTheDocument();

    await user.click(deleteControl);
    expect(screen.getByText('Delete production file')).toBeInTheDocument();
    expect(screen.getByText(/Delete TOP x1 1\.13\.2 from X1C/)).toBeInTheDocument();
    expect(deletedSlotId).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText('Delete production file')).not.toBeInTheDocument();
    });
    expect(deletedSlotId).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => {
      expect(deletedSlotId).toBe('5');
    });
  });
});
