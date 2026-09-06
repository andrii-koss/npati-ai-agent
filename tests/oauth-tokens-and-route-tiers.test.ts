import { describe, expect, it } from "vitest";
import { OAuthPkceService } from "../apps/agent-api/src/oauth-pkce";
import { TokenRefreshManager } from "../apps/agent-api/src/token-refresh-manager";
import { RouteGuardTiers } from "../apps/agent-api/src/route-guard-tiers";

describe("OAuth 2.0 PKCE (OAuthPkceService)", () => {
  it("generates valid PKCE S256 pair and verifies challenge matching", () => {
    const pair = OAuthPkceService.generatePkcePair();

    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeChallenge.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeChallengeMethod).toBe("S256");

    const isValid = OAuthPkceService.verifyCodeChallenge(pair.codeVerifier, pair.codeChallenge, "S256");
    expect(isValid).toBe(true);

    const isInvalid = OAuthPkceService.verifyCodeChallenge("wrong-verifier-12345", pair.codeChallenge, "S256");
    expect(isInvalid).toBe(false);
  });

  it("issues authorization code and exchanges with correct PKCE verifier", () => {
    const service = new OAuthPkceService();
    const pair = OAuthPkceService.generatePkcePair();

    const code = service.createAuthorizationCode({
      clientId: "client-mobile-app",
      redirectUri: "https://app.npati.io/callback",
      codeChallenge: pair.codeChallenge,
      codeChallengeMethod: "S256",
      userId: "user-123",
      tenantId: "tenant-123",
      scopes: ["chat", "files:read"],
    });

    expect(code).toMatch(/^npati_ac_[0-9a-f]+$/);

    // Exchange with correct verifier
    const exchange = service.exchangeCode({
      code,
      codeVerifier: pair.codeVerifier,
      clientId: "client-mobile-app",
      redirectUri: "https://app.npati.io/callback",
    });

    expect(exchange.valid).toBe(true);
    if (exchange.valid) {
      expect(exchange.userId).toBe("user-123");
      expect(exchange.tenantId).toBe("tenant-123");
      expect(exchange.scopes).toEqual(["chat", "files:read"]);
    }
  });

  it("rejects token exchange when PKCE verifier fails or code is reused", () => {
    const service = new OAuthPkceService();
    const pair = OAuthPkceService.generatePkcePair();

    const code = service.createAuthorizationCode({
      clientId: "client-dashboard",
      redirectUri: "http://localhost:3000/auth",
      codeChallenge: pair.codeChallenge,
      codeChallengeMethod: "S256",
      userId: "user-456",
      tenantId: "tenant-456",
    });

    // Wrong verifier
    const wrongVerifier = service.exchangeCode({
      code,
      codeVerifier: "incorrect-verifier-data",
      clientId: "client-dashboard",
      redirectUri: "http://localhost:3000/auth",
    });

    expect(wrongVerifier.valid).toBe(false);
    if (!wrongVerifier.valid) {
      expect(wrongVerifier.error).toBe("PKCE_VERIFICATION_FAILED");
    }

    // Now exchange with right verifier
    const successfulExchange = service.exchangeCode({
      code,
      codeVerifier: pair.codeVerifier,
      clientId: "client-dashboard",
      redirectUri: "http://localhost:3000/auth",
    });
    expect(successfulExchange.valid).toBe(true);

    // Replay attack: using the code a second time
    const replayExchange = service.exchangeCode({
      code,
      codeVerifier: pair.codeVerifier,
      clientId: "client-dashboard",
      redirectUri: "http://localhost:3000/auth",
    });
    expect(replayExchange.valid).toBe(false);
  });
});

describe("Automatic Token Refresh (TokenRefreshManager)", () => {
  it("issues token pairs and successfully rotates refresh tokens", async () => {
    const manager = new TokenRefreshManager();
    const initialPair = await manager.issueTokenPair("user-a", "tenant-a", ["read", "write"]);

    expect(initialPair.accessToken).toMatch(/^npati_at_/);
    expect(initialPair.refreshToken).toMatch(/^npati_rt_/);
    expect(initialPair.expiresIn).toBe(3600);

    // Refresh token
    const refreshResult = await manager.refreshToken(initialPair.refreshToken);
    expect(refreshResult.success).toBe(true);
    if (refreshResult.success) {
      expect(refreshResult.tokens.accessToken).toBeDefined();
      expect(refreshResult.tokens.refreshToken).not.toBe(initialPair.refreshToken);
    }
  });

  it("detects token reuse and revokes entire token family", async () => {
    const manager = new TokenRefreshManager();
    const initial = await manager.issueTokenPair("user-victim", "tenant-corp");

    // First legitimate refresh
    const firstRefresh = await manager.refreshToken(initial.refreshToken);
    expect(firstRefresh.success).toBe(true);

    // An attacker tries to use the OLD (already rotated) initial refresh token!
    const attackRefresh = await manager.refreshToken(initial.refreshToken);
    expect(attackRefresh.success).toBe(false);
    if (!attackRefresh.success) {
      expect(attackRefresh.error).toContain("TOKEN_REUSE_DETECTED");
    }

    // Now even the new token from legitimate refresh is invalidated because the family was compromised
    if (firstRefresh.success) {
      const subsequentRefresh = await manager.refreshToken(firstRefresh.tokens.refreshToken);
      expect(subsequentRefresh.success).toBe(false);
    }
  });
});

describe("Route Guard Tiers (RouteGuardTiers)", () => {
  it("enforces tier-based rate limits and sliding window bounds", () => {
    const guard = new RouteGuardTiers({
      free: { maxRequestsPerMinute: 3, burstAllowance: 1 },
      pro: { maxRequestsPerMinute: 10, burstAllowance: 2 },
    });

    const clientId = "client-free-user";
    guard.setClientTier(clientId, "free");

    // First 3 requests are allowed
    expect(guard.checkRateLimit(clientId).allowed).toBe(true);
    expect(guard.checkRateLimit(clientId).allowed).toBe(true);
    const r3 = guard.checkRateLimit(clientId);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th request exceeds limit
    const r4 = guard.checkRateLimit(clientId);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterSeconds).toBeGreaterThan(0);

    const headers = RouteGuardTiers.formatHeaders(r4);
    expect(headers["X-RateLimit-Tier"]).toBe("free");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["Retry-After"]).toBeDefined();
  });

  it("allows higher request throughput for pro tier clients", () => {
    const guard = new RouteGuardTiers();
    const proClient = "client-pro-user";
    guard.setClientTier(proClient, "pro");

    for (let i = 0; i < 50; i++) {
      const res = guard.checkRateLimit(proClient);
      expect(res.allowed).toBe(true);
      expect(res.tier).toBe("pro");
    }
  });
});
