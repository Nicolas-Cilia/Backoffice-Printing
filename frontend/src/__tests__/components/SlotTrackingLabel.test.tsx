/**
 * SlotTrackingLabel — Inventory Tracking product under an AMS/external slot.
 * Renders nothing when the slot is unassigned so we never invent a color.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { SlotTrackingLabel, amsSlotHighlightClass } from '../../components/SlotTrackingLabel';

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
    expect(screen.getByTestId('slot-tracking-label').className).toContain('mt-1.5');
    expect(screen.getByTestId('filament-swatch').className).toContain('w-[14px]');
    expect(screen.getByTestId('filament-swatch').className).toContain('h-[14px]');
    expect(screen.getByText('White · EasyRock · PLA').className).toContain('text-bambu-gray-light');
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

describe('amsSlotHighlightClass', () => {
  it('insets the active ring so it does not collide with SlotTrackingLabel', () => {
    const cls = amsSlotHighlightClass({ isActive: true });
    expect(cls).toContain('ring-bambu-green');
    expect(cls).toContain('ring-inset');
    expect(cls).toContain('ring-1');
    expect(cls).not.toContain('ring-offset');
    expect(cls).not.toContain('ring-2');
  });

  it('insets expected and ran-out rings the same way', () => {
    expect(amsSlotHighlightClass({ isExpected: true })).toContain('ring-inset');
    expect(amsSlotHighlightClass({ isRanOut: true })).toContain('ring-inset');
    expect(amsSlotHighlightClass({ isExpected: true })).not.toContain('ring-offset');
  });

  it('gives idle slots a hairline inset ring instead of a flush tile', () => {
    const cls = amsSlotHighlightClass();
    expect(cls).toContain('ring-inset');
    expect(cls).toContain('ring-black/10');
  });
});
