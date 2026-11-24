import { describe, expect, it } from "vitest";
import { NpatiBackendAuthProvider } from "../apps/agent-api/src/auth";
import { ScopedRemoteAccessTokenManager } from "../apps/agent-api/src/security-guardrails-and-tokens";
import { resolveTrustProxy } from "../apps/agent-api/src/app";

/** Security audit 2026-11-24, L2: a client-supplied X-Forwarded-For satisfied remote-token IP allowlists. */
describe("L2: client IP comes from the socket unless a proxy is trusted", () => {
  const manager = new ScopedRemoteAccessTokenManager("4d3c2b1a0f9e8d7c6b5a49382716f5e4d3c2b1a0");
  const { token } = manager.mintRemoteToken({ tenantId: "workspace:w", companyId: "c", userId: "u", scopes: ["chat:use"], ipAllowlist: ["203.0.113.7"] });
  const provider = new NpatiBackendAuthProvider({ remoteTokensManager: manager });

  it("a spoofed X-Forwarded-For does not satisfy the allowlist", async () => {
    await expect(provider.authenticate({ headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.7" }, ip: "198.51.100.9", query: {} } as never))
      .rejects.toMatchObject({ status: 401, code: "INVALID_REMOTE_TOKEN" });
  });

  it("the real client address does", async () => {
    await expect(provider.authenticate({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.7", query: {} } as never))
      .resolves.toMatchObject({ userId: "u", companyId: "c" });
  });

  it("trustProxy is off unless configured", () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
    expect(resolveTrustProxy("false")).toBe(false);
    const oneHop = resolveTrustProxy("1") as (address: string, hop: number) => boolean;
    expect([oneHop("10.0.0.1", 0), oneHop("10.0.0.2", 1)]).toEqual([true, false]);
    expect(resolveTrustProxy("10.0.0.0/8, 172.16.0.1")).toEqual(["10.0.0.0/8", "172.16.0.1"]);
  });
});
