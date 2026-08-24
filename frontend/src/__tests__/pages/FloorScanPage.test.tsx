import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FloorScanPage } from '../../pages/FloorScanPage';

describe('FloorScanPage (Phase 0 shell)', () => {
  it('renders idle status with a hidden, auto-focused scan field', () => {
    render(<FloorScanPage />);

    expect(screen.getByText('Scan a code')).toBeInTheDocument();
    const input = screen.getByLabelText('Scan field');
    expect(input).toHaveFocus();
  });

  it('flashes an error for an unrecognized scan without crashing the page', async () => {
    const user = userEvent.setup();
    render(<FloorScanPage />);

    const input = screen.getByLabelText('Scan field');
    await user.type(input, 'garbage-not-a-real-prefix{Enter}');

    expect(screen.getByText('Unknown code')).toBeInTheDocument();
    expect(screen.getByText('garbage-not-a-real-prefix')).toBeInTheDocument();
    // Page stays stable — idle heading area is gone (replaced by the error
    // text) but nothing else broke, and the field is cleared for the next scan.
    expect(screen.queryByText('Scan a code')).not.toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('ignores a bare Enter with no scanned content', async () => {
    const user = userEvent.setup();
    render(<FloorScanPage />);

    const input = screen.getByLabelText('Scan field');
    await user.type(input, '{Enter}');

    expect(screen.getByText('Scan a code')).toBeInTheDocument();
  });

  it('reads the just-typed value even when Enter fires in the same tick as the last keystroke', () => {
    // A USB pistol fires its whole scan far faster than a human types —
    // fast enough that onChange and the trailing Enter keydown can land in
    // the same synchronous dispatch, before React has re-rendered between
    // them. fireEvent (unlike userEvent) dispatches with no yield in
    // between, reproducing exactly that race: this must still read the
    // value from the just-fired onChange, not a stale pre-keystroke closure.
    render(<FloorScanPage />);

    const input = screen.getByLabelText('Scan field');
    fireEvent.change(input, { target: { value: 'BBP-12' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('Unknown code')).toBeInTheDocument();
    expect(screen.getByText('BBP-12')).toBeInTheDocument();
  });

  it('keeps focus on the scan field after a click elsewhere on the page', async () => {
    const user = userEvent.setup();
    render(<FloorScanPage />);

    const input = screen.getByLabelText('Scan field');
    expect(input).toHaveFocus();

    // Nothing else on the page is focusable, so a stray click (the
    // realistic way a pistol's target could be lost) blurs the field —
    // the window click listener must claim it back.
    await user.click(document.body);

    await waitFor(() => expect(input).toHaveFocus());
  });

  describe('error auto-clear', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reverts to idle a few seconds after an unknown scan', () => {
      render(<FloorScanPage />);

      const input = screen.getByLabelText('Scan field');
      fireEvent.change(input, { target: { value: 'nonsense' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByText('Unknown code')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(screen.getByText('Scan a code')).toBeInTheDocument();
    });
  });
});
