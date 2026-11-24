import { afterEach, describe, expect, it, vi } from "vitest";
import { NpatiBackendAuthProvider } from "../apps/agent-api/src/auth";
import { OidcDashboardGate, configuredOidc } from "../apps/agent-api/src/security-guardrails-and-tokens";

/**
 * Security audit 2026-11-24, C2: OIDC used to default to an issuer on a domain this project does not control and fetched
 * its signing keys from `${issuer}/.well-known/jwks.json`, so whoever held that domain could mint administrator tokens
 * for every installation. OIDC must exist only when an operator configured a key source.
 */
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

describe("C2: OIDC is off unless an operator configures a key source", () => {
  it("compose's issuer/audience defaults alone do not enable OIDC", () => {
    expect(configuredOidc({ OIDC_ISSUER: "https://auth.npati.ai", OIDC_AUDIENCE: "npati-dashboard" })).toBeNull();
  });

  it("an x-oidc-token header is refused without any network request", async () => {
    process.env = { NODE_ENV: "test", OIDC_ISSUER: "https://auth.npati.ai", OIDC_AUDIENCE: "npati-dashboard" };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new NpatiBackendAuthProvider({ remoteTokensManager: { verifyRemoteToken: () => ({ isValid: false }) } as never });
    const token = OidcDashboardGate.createMockOidcToken({ roles: ["admin"] });
    await expect(provider.authenticate({ headers: { "x-oidc-token": token }, query: {} } as never))
      .rejects.toMatchObject({ status: 401, code: "OIDC_NOT_CONFIGURED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a configured JWKS source is still honoured", () => {
    expect(configuredOidc({ OIDC_ISSUER: "https://idp.example.com", OIDC_AUDIENCE: "npati", OIDC_JWKS_URI: "https://idp.example.com/jwks" }))
      .toMatchObject({ expectedIssuer: "https://idp.example.com", allowedAlgorithms: ["RS256"] });
  });
});
