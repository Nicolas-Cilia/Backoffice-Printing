/**
 * Tests for the API client auth token handling.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { setAuthToken, getAuthToken, api } from '../../api/client';

// Mock sessionStorage (H-5: tokens are stored in sessionStorage, not localStorage)
const sessionStorageMock = {
  store: {} as Record<string, string>,
  getItem: vi.fn((key: string) => sessionStorageMock.store[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    sessionStorageMock.store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete sessionStorageMock.store[key];
  }),
  clear: vi.fn(() => {
    sessionStorageMock.store = {};
  }),
};

Object.defineProperty(window, 'sessionStorage', {
  value: sessionStorageMock,
});

// Create MSW server
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
  server.resetHandlers();
  sessionStorageMock.clear();
  vi.mocked(localStorage.setItem).mockClear();
  vi.mocked(localStorage.removeItem).mockClear();
  setAuthToken(null);
});
afterAll(() => server.close());

describe('Auth Token Management', () => {
  it('setAuthToken stores token in sessionStorage', () => {
    setAuthToken('test-token-123');
    expect(sessionStorageMock.setItem).toHaveBeenCalledWith('auth_token', 'test-token-123');
    expect(getAuthToken()).toBe('test-token-123');
  });

  it('setAuthToken removes token from sessionStorage when null', () => {
    setAuthToken('test-token-123');
    setAuthToken(null);
    expect(sessionStorageMock.removeItem).toHaveBeenCalledWith('auth_token');
    expect(getAuthToken()).toBeNull();
  });

  it("setAuthToken('persistent') writes to both sessionStorage and localStorage", () => {
    setAuthToken('persist-token', 'persistent');
    expect(sessionStorageMock.setItem).toHaveBeenCalledWith('auth_token', 'persist-token');
    expect(vi.mocked(localStorage.setItem)).toHaveBeenCalledWith('auth_token', 'persist-token');
    expect(getAuthToken()).toBe('persist-token');
  });

  it("setAuthToken('session') writes only to sessionStorage, not localStorage", () => {
    setAuthToken('session-token', 'session');
    expect(sessionStorageMock.setItem).toHaveBeenCalledWith('auth_token', 'session-token');
    expect(vi.mocked(localStorage.setItem)).not.toHaveBeenCalledWith('auth_token', expect.any(String));
  });

  it('setAuthToken(null) removes from both storages regardless of previous persistence', () => {
    setAuthToken('some-token', 'persistent');
    vi.mocked(localStorage.setItem).mockClear();
    setAuthToken(null);
    expect(sessionStorageMock.removeItem).toHaveBeenCalledWith('auth_token');
    expect(vi.mocked(localStorage.removeItem)).toHaveBeenCalledWith('auth_token');
    expect(getAuthToken()).toBeNull();
  });

  it('setAuthToken keeps in-memory token when sessionStorage throws', () => {
    sessionStorageMock.setItem.mockImplementationOnce(() => {
      throw new DOMException('QuotaExceededError');
    });
    // Should not throw even when storage is unavailable
    expect(() => setAuthToken('fallback-token')).not.toThrow();
    // In-memory token must still be set
    expect(getAuthToken()).toBe('fallback-token');
  });

  it('setAuthToken(null) removes from sessionStorage even when localStorage.removeItem throws', () => {
    setAuthToken('some-token', 'persistent');
    vi.mocked(localStorage.removeItem).mockImplementationOnce(() => {
      throw new DOMException('SecurityError');
    });
    // Must not throw — localStorage failure must not abort the sessionStorage removal
    expect(() => setAuthToken(null)).not.toThrow();
    expect(sessionStorageMock.removeItem).toHaveBeenCalledWith('auth_token');
    expect(getAuthToken()).toBeNull();
  });

  it('setAuthToken(null) removes from localStorage even when sessionStorage.removeItem throws', () => {
    setAuthToken('some-token', 'persistent');
    sessionStorageMock.removeItem.mockImplementationOnce(() => {
      throw new DOMException('SecurityError');
    });
    // Must not throw — sessionStorage failure must not abort the localStorage removal
    expect(() => setAuthToken(null)).not.toThrow();
    expect(vi.mocked(localStorage.removeItem)).toHaveBeenCalledWith('auth_token');
    expect(getAuthToken()).toBeNull();
  });
});

describe('API Client Auth Header', () => {
  it('includes Authorization header when token is set', async () => {
    let capturedHeaders: Headers | null = null;

    server.use(
      http.get('/api/v1/settings/spoolman', ({ request }) => {
        capturedHeaders = request.headers;
        return HttpResponse.json({
          spoolman_enabled: 'false',
          spoolman_url: '',
          spoolman_sync_mode: 'auto',
        });
      })
    );

    setAuthToken('test-jwt-token');
    await api.getSpoolmanSettings();

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!.get('Authorization')).toBe('Bearer test-jwt-token');
  });

  it('does not include Authorization header when token is not set', async () => {
    let capturedHeaders: Headers | null = null;

    server.use(
      http.get('/api/v1/settings/spoolman', ({ request }) => {
        capturedHeaders = request.headers;
        return HttpResponse.json({
          spoolman_enabled: 'false',
          spoolman_url: '',
          spoolman_sync_mode: 'auto',
        });
      })
    );

    setAuthToken(null);
    await api.getSpoolmanSettings();

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!.get('Authorization')).toBeNull();
  });

  it('clears token on 401 with invalid token message', async () => {
    server.use(
      http.get('/api/v1/settings/spoolman', () => {
        return HttpResponse.json(
          { detail: 'Could not validate credentials' },
          { status: 401 }
        );
      })
    );

    setAuthToken('expired-token');
    expect(getAuthToken()).toBe('expired-token');

    try {
      await api.getSpoolmanSettings();
    } catch {
      // Expected to throw
    }

    expect(getAuthToken()).toBeNull();
    expect(sessionStorageMock.removeItem).toHaveBeenCalledWith('auth_token');
  });

  it('does not clear token on 401 with generic auth error', async () => {
    server.use(
      http.get('/api/v1/settings/spoolman', () => {
        return HttpResponse.json(
          { detail: 'Authentication required' },
          { status: 401 }
        );
      })
    );

    setAuthToken('valid-token');
    expect(getAuthToken()).toBe('valid-token');

    try {
      await api.getSpoolmanSettings();
    } catch {
      // Expected to throw
    }

    // Token should NOT be cleared for generic auth errors (might be timing issue)
    expect(getAuthToken()).toBe('valid-token');
  });

  it("dispatches 'auth:expired' event on 401 with invalid token message (#1698)", async () => {
    server.use(
      http.get('/api/v1/settings/spoolman', () => {
        return HttpResponse.json(
          { detail: 'Token has expired' },
          { status: 401 }
        );
      })
    );

    setAuthToken('expired-token');
    const listener = vi.fn();
    window.addEventListener('auth:expired', listener);

    try {
      await api.getSpoolmanSettings();
    } catch {
      // Expected to throw
    }

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('auth:expired', listener);
  });

  it("does not dispatch 'auth:expired' on 401 with generic auth error (#1698)", async () => {
    server.use(
      http.get('/api/v1/settings/spoolman', () => {
        return HttpResponse.json(
          { detail: 'Authentication required' },
          { status: 401 }
        );
      })
    );

    setAuthToken('valid-token');
    const listener = vi.fn();
    window.addEventListener('auth:expired', listener);

    try {
      await api.getSpoolmanSettings();
    } catch {
      // Expected to throw
    }

    // Generic 401s might be timing issues, not real expiries — must NOT redirect.
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('auth:expired', listener);
  });
});

describe('Slicer download URLs', () => {
  it('keeps library slicer URLs ending in .3mf when the display name has no extension', () => {
    const path = api.getLibrarySlicerDownloadUrl(12, 'token-abc', 'Mecha Mewtwo No AMS Multi Color Parted Statue');

    expect(path).toBe(
      '/api/v1/library/files/12/dl/token-abc/Mecha%20Mewtwo%20No%20AMS%20Multi%20Color%20Parted%20Statue.3mf'
    );
  });

  it('sanitizes library slicer URL filenames before encoding them', () => {
    const path = api.getLibrarySlicerDownloadUrl(12, 'token-abc', 'folder/model?bad#name.3mf');

    expect(path).toBe('/api/v1/library/files/12/dl/token-abc/folder_model_bad_name.3mf');
  });
});

describe('FormData requests include auth header', () => {
  it('multipart uploads include the Authorization header', async () => {
    // Mock fetch directly for FormData requests (MSW can be flaky with multipart in some environments)
    const originalFetch = global.fetch;
    let capturedHeaders: Headers | null = null;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/timelapse/upload')) {
        capturedHeaders = new Headers(init?.headers);
        return Promise.resolve(new Response(JSON.stringify({
          status: 'ok',
          filename: 'test.mp4',
        }), { status: 200 }));
      }
      return originalFetch(url, init);
    });

    try {
      setAuthToken('test-token');
      const file = new File(['test content'], 'test.mp4', { type: 'video/mp4' });
      await api.uploadArchiveTimelapse(1, file);

      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!.get('Authorization')).toBe('Bearer test-token');
    } finally {
      global.fetch = originalFetch;
    }
  });

});

describe('Printer control endpoints', () => {
  it('refreshPrinterStatus POSTs to /printers/:id/refresh-status', async () => {
    let calledUrl: string | null = null;
    let calledMethod: string | null = null;
    server.use(
      http.post('/api/v1/printers/:id/refresh-status', ({ request, params }) => {
        calledUrl = `/printers/${params.id}/refresh-status`;
        calledMethod = request.method;
        return HttpResponse.json({ status: 'ok' });
      }),
    );

    const result = await api.refreshPrinterStatus(7);
    expect(calledMethod).toBe('POST');
    expect(calledUrl).toBe('/printers/7/refresh-status');
    expect(result).toEqual({ status: 'ok' });
  });

  it('setAirductMode passes mode in query string', async () => {
    let capturedUrl = '';
    server.use(
      http.post('/api/v1/printers/:id/airduct-mode', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ success: true, message: 'ok' });
      }),
    );

    await api.setAirductMode(3, 'cooling');
    expect(capturedUrl).toContain('mode=cooling');

    await api.setAirductMode(3, 'heating');
    expect(capturedUrl).toContain('mode=heating');
  });
});

