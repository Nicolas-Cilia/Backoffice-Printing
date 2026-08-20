/**
 * SlotTrackingLabel — Inventory Tracking product under an AMS/external slot.
 * Renders nothing when the slot is unassigned so we never invent a color.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { SlotTrackingLabel } from '../../components/SlotTrackingLabel';

const assigned = {
  color_name: 'White',
  material: 'PLA',
  brand: 'EasyRock',
  subtype: null,
  color_hex: 'FFFFFF',
  extra_colors: null,
  effect_type: null,
};

describe('SlotTrackingLabel', () => {
  it('shows swatch + trackingProductLabel for an assigned slot', () => {
    render(<SlotTrackingLabel assigned={assigned} />);

    expect(screen.getByTestId('slot-tracking-label')).toHaveTextContent('White · EasyRock · PLA');
    expect(screen.getByTestId('filament-swatch').className).toContain('w-[14px]');
    expect(screen.getByTestId('filament-swatch').className).toContain('h-[14px]');
  });

  it('renders nothing when the slot has no tracking assignment', () => {
    render(<SlotTrackingLabel assigned={null} />);
    expect(screen.queryByTestId('slot-tracking-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filament-swatch')).not.toBeInTheDocument();
  });

  it('does not paint a fake swatch when assigned color_hex is missing', () => {
    render(
      <SlotTrackingLabel
        assigned={{ ...assigned, color_hex: null, extra_colors: null }}
      />,
    );

    expect(screen.getByTestId('slot-tracking-label')).toHaveTextContent('White · EasyRock · PLA');
    expect(screen.queryByTestId('filament-swatch')).not.toBeInTheDocument();
  });

  it('rings a black tracking swatch so the disc stays visible on dark UI', () => {
    render(
      <SlotTrackingLabel
        assigned={{ ...assigned, color_name: 'Black', color_hex: '000000' }}
      />,
    );
    expect(screen.getByTestId('filament-swatch').className).toContain('ring-white/15');
  });

  it('keeps extra_colors and effect_type off the text label', () => {
    render(
      <SlotTrackingLabel
        assigned={{
          ...assigned,
          extra_colors: 'FFD700,C0C0C0',
          effect_type: 'sparkle',
        }}
      />,
    );
    const label = screen.getByTestId('slot-tracking-label');
    expect(label).toHaveTextContent('White · EasyRock · PLA');
    expect(label).not.toHaveTextContent('FFD700,C0C0C0');
    expect(label).not.toHaveTextContent('sparkle');
    expect(screen.getByTestId('filament-swatch')).toBeInTheDocument();
  });
});
