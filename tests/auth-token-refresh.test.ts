import { describe, expect, it } from "vitest";
import { getTokenRefreshDelayMs } from "../apps/web/src/auth-token-refresh";

function tokenExpiringIn(seconds: number, now: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(now / 1000) + seconds }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${payload}.signature`;
}

describe("Agent access token renewal timing", () => {
  const now = 1_700_000_000_000;

  it("renews a 12-second token before it expires", () => {
    expect(getTokenRefreshDelayMs(tokenExpiringIn(12, now), now)).toBe(6000);
  });

  it("renews normal tokens before expiry and caps the interval", () => {
    expect(getTokenRefreshDelayMs(tokenExpiringIn(15 * 60, now), now)).toBe(600_000);
    expect(getTokenRefreshDelayMs(tokenExpiringIn(60 * 60, now), now)).toBe(600_000);
  });

  it("retries promptly for expired tokens and uses a safe fallback for invalid JWTs", () => {
    expect(getTokenRefreshDelayMs(tokenExpiringIn(-1, now), now)).toBe(1000);
    expect(getTokenRefreshDelayMs("not-a-jwt", now)).toBe(600_000);
  });
});
