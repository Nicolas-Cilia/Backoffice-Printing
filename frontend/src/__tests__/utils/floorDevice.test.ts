import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDeviceId } from '../../utils/floorDevice';

describe('getDeviceId', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates and persists an id on first use', () => {
    const id = getDeviceId();

    expect(id).toBeTruthy();
    expect(localStorage.setItem).toHaveBeenCalledWith('floorDeviceId', id);
  });

  it('reuses the stored id on later calls', () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'floorDeviceId' ? 'existing-device-id' : null,
    );

    expect(getDeviceId()).toBe('existing-device-id');
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('uses localStorage, not sessionStorage', () => {
    // Per-tab identity would let one machine hold two sessions in two tabs —
    // exactly the "two pistols on one screen" case the per-device rule exists
    // to prevent (§5.5).
    getDeviceId();
    expect(localStorage.setItem).toHaveBeenCalledWith('floorDeviceId', expect.any(String));
  });

  it('still returns a usable id when storage is unavailable', () => {
    // Private mode, quota, or a locked-down kiosk must not break scanning. The
    // cost is a fresh identity per load, which is what takeover recovers from.
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error('storage disabled');
    });

    const id = getDeviceId();
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(8);
  });

  it('falls back when crypto.randomUUID is missing', () => {
    // A floor PC on plain HTTP is not a secure context, where randomUUID is
    // unavailable — so the fallback is a real path, not defensive padding.
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true,
      writable: true,
    });

    try {
      const id = getDeviceId();
      expect(id).toMatch(/^dev-/);
      expect(id.length).toBeGreaterThan(8);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it('produces distinct ids across machines', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      vi.mocked(localStorage.getItem).mockReturnValue(null);
      seen.add(getDeviceId());
    }
    expect(seen.size).toBe(50);
  });
});
