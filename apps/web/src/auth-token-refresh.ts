const DEFAULT_REFRESH_DELAY_MS = 10 * 60 * 1000;

// Refresh before expiry, including installations with unusually short JWT lifetimes.
export function getTokenRefreshDelayMs(token: string, now = Date.now()): number {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return DEFAULT_REFRESH_DELAY_MS;
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { exp?: number };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return DEFAULT_REFRESH_DELAY_MS;

    const remainingMs = payload.exp * 1000 - now;
    const marginMs = Math.min(5 * 60 * 1000, Math.max(3000, remainingMs / 2));
    return Math.max(1000, Math.min(DEFAULT_REFRESH_DELAY_MS, remainingMs - marginMs));
  } catch {
    return DEFAULT_REFRESH_DELAY_MS;
  }
}
