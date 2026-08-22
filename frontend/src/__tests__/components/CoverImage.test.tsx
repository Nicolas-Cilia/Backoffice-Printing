/**
 * CoverImage resilience: waits for stream token, retries after load errors,
 * and recovers when the token arrives after first paint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { CoverImage } from '../../components/CoverImage';
import { setStreamToken } from '../../api/client';
import { render } from '../utils';

function fireImgError(container: HTMLElement) {
  const img = container.querySelector('img[aria-hidden]') || container.querySelector('img');
  expect(img).toBeTruthy();
  act(() => {
    img!.dispatchEvent(new Event('error'));
  });
}

function fireImgLoad(container: HTMLElement) {
  const img = container.querySelector('img[aria-hidden]') || container.querySelector('img');
  expect(img).toBeTruthy();
  act(() => {
    img!.dispatchEvent(new Event('load'));
  });
}

describe('CoverImage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setStreamToken(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setStreamToken(null);
  });

  it('shows the wireframe placeholder while loading', async () => {
    setStreamToken('tok-ready');
    const { container } = render(<CoverImage url="/api/v1/printers/1/cover" printName="Benchy" />);

    await waitFor(() => {
      expect(container.querySelector('img[aria-hidden]')).toBeTruthy();
    });
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('retries after an error instead of giving up permanently', async () => {
    const { container } = render(<CoverImage url="/api/v1/printers/1/cover" printName="Benchy" />);

    // Wait for AuthProvider / stream-token query to settle (avoids a mid-retry
    // reset when the query token replaces a manually seeded one).
    await waitFor(() => {
      const src = container.querySelector('img[aria-hidden]')?.getAttribute('src');
      expect(src).toBeTruthy();
      expect(src).toContain('token=');
    });

    const srcBefore = container.querySelector('img[aria-hidden]')!.getAttribute('src');
    fireImgError(container);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    await waitFor(() => {
      const srcAfter = container.querySelector('img[aria-hidden]')?.getAttribute('src');
      expect(srcAfter).toBeTruthy();
      expect(srcAfter).not.toBe(srcBefore);
      expect(srcAfter).toContain('r=1');
    });
    expect(screen.getByTestId('cover-image')).toHaveAttribute('data-gave-up', 'false');
  });

  it('recovers when the stream token arrives after first paint', async () => {
    const { container } = render(<CoverImage url="/api/v1/printers/1/cover" printName="Benchy" />);

    // No token yet → no img src (avoids sticky 401 placeholder).
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeTruthy();

    act(() => {
      setStreamToken('tok-after-login');
    });

    await waitFor(() => {
      const img = container.querySelector('img[aria-hidden]');
      expect(img?.getAttribute('src')).toContain('token=tok-after-login');
    });

    fireImgLoad(container);
    await waitFor(() => {
      expect(screen.getByAltText(/print preview/i)).toBeTruthy();
    });
  });

  it('keeps the last good cover while a retry is in flight', async () => {
    setStreamToken('tok-ready');
    const { container } = render(<CoverImage url="/api/v1/printers/1/cover" printName="Benchy" />);

    await waitFor(() => {
      expect(container.querySelector('img[aria-hidden]')).toBeTruthy();
    });
    fireImgLoad(container);

    await waitFor(() => {
      expect(screen.getByAltText(/print preview/i)).toBeTruthy();
    });

    fireImgError(container);
    // Preview stays while retrying
    expect(screen.getByAltText(/print preview/i)).toBeTruthy();
  });
});
