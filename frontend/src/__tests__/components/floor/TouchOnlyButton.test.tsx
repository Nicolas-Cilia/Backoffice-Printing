import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TouchOnlyButton } from '../../../components/floor/TouchOnlyButton';

function renderButton(onActivate = vi.fn()) {
  render(
    <TouchOnlyButton aria-label="Tap to scan" onActivate={onActivate}>
      Tap to scan
    </TouchOnlyButton>,
  );
  return { onActivate, button: screen.getByRole('button', { name: 'Tap to scan' }) };
}

describe('TouchOnlyButton', () => {
  it('is out of the tab order', () => {
    const { button } = renderButton();
    expect(button).toHaveAttribute('tabindex', '-1');
  });

  it('activates on touch', () => {
    const { onActivate, button } = renderButton();
    fireEvent.pointerDown(button, { pointerType: 'touch', button: 0 });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('activates on a primary mouse press', () => {
    const { onActivate, button } = renderButton();
    fireEvent.pointerDown(button, { pointerType: 'mouse', button: 0 });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('does not activate on Enter or Space from a wedge scanner', () => {
    const { onActivate, button } = renderButton();
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyUp(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.keyUp(button, { key: ' ' });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('does not activate when disabled', () => {
    const onActivate = vi.fn();
    render(
      <TouchOnlyButton aria-label="Tap to scan" onActivate={onActivate} disabled>
        Tap to scan
      </TouchOnlyButton>,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Tap to scan' }), {
      pointerType: 'touch',
      button: 0,
    });
    expect(onActivate).not.toHaveBeenCalled();
  });
});
