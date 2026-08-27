/**
 * Routing tests for the inventory / filament nav split (Agent C).
 *
 *  - /filament        → the filament InventoryPage
 *  - /inventory       → the FloorInventoryPage (production-floor parts)
 *  - /floor/inventory → redirects to /inventory (query string preserved)
 *
 * Renders the real AppRoutes tree in a MemoryRouter. Auth is disabled so the
 * ProtectedRoute / PermissionRoute guards pass through, the WebSocket hooks
 * are stubbed out, and Layout / the two pages are replaced with markers so the
 * assertions pin the path→page mapping rather than page internals.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router-dom';

vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    authEnabled: false,
    loading: false,
    user: null,
    hasPermission: () => true,
  }),
}));

vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => {} }));
vi.mock('../hooks/usePrintProgressTitle', () => ({ usePrintProgressTitle: () => {} }));
vi.mock('../hooks/useCameraStreamToken', () => ({
  useStreamTokenSync: () => {},
}));

vi.mock('../components/Layout', () => ({
  Layout: () => (
    <div>
      <LocationProbe />
      <Outlet />
    </div>
  ),
}));

vi.mock('../pages/InventoryPage', () => ({
  default: () => <div>FILAMENT_INVENTORY_PAGE</div>,
}));

vi.mock('../pages/FloorInventoryPage', () => ({
  FloorInventoryPage: () => <div>FLOOR_INVENTORY_PAGE</div>,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

import { AppRoutes } from '../App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('AppRoutes inventory / filament split', () => {
  it('renders the filament InventoryPage at /filament', () => {
    renderAt('/filament');
    expect(screen.getByText('FILAMENT_INVENTORY_PAGE')).toBeInTheDocument();
  });

  it('renders the FloorInventoryPage at /inventory', () => {
    renderAt('/inventory');
    expect(screen.getByText('FLOOR_INVENTORY_PAGE')).toBeInTheDocument();
  });

  it('redirects /floor/inventory to /inventory', () => {
    renderAt('/floor/inventory');
    expect(screen.getByText('FLOOR_INVENTORY_PAGE')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/inventory');
  });

  it('preserves the query string when redirecting /floor/inventory?tab=bins', () => {
    renderAt('/floor/inventory?tab=bins');
    expect(screen.getByText('FLOOR_INVENTORY_PAGE')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/inventory?tab=bins');
  });
});
