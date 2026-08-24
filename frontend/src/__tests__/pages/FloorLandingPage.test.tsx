import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FloorLandingPage } from '../../pages/FloorLandingPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

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
