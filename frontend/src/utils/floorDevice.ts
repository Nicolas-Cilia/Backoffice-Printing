/**
 * Device identity for floor station locks (docs/floor-plan.md §2.4).
 *
 * A station session is claimed by a *device*, so the device needs a stable
 * id. It lives in `localStorage` rather than `sessionStorage` deliberately:
 * per-tab identity would let one machine open two sessions in two tabs, which
 * is exactly the "two pistols on one screen" case the per-device rule exists
 * to prevent (§5.5).
 *
 * This is an identity for a lock, not a security boundary — it is client
 * supplied and trivially forgeable. Never authorize on it.
 */

const DEVICE_ID_KEY = 'floorDeviceId';

/** Fallback for environments without `crypto.randomUUID` (older browsers, and
 *  any non-secure-context origin, which a floor PC on plain HTTP may well be —
 *  `crypto.randomUUID` is unavailable outside secure contexts). Collision
 *  resistance here only has to beat "how many machines are on this floor". */
function fallbackId(): string {
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * This machine's device id, generating and persisting one on first use.
 *
 * Storage being unavailable (private mode, quota, a locked-down kiosk) must
 * not break scanning, so an ephemeral id is returned instead. The cost is that
 * such a device gets a fresh identity every load and can strand its own
 * sessions — which is precisely what takeover exists to recover.
 */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;

    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : fallbackId();
    localStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return fallbackId();
  }
}
