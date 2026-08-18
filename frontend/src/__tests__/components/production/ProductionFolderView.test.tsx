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
    expect(screen.getByRole('button', { name: 'View specs' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View specs' }));
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
  });
});
