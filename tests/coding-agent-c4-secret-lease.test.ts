import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { SecretLeaseProvider, SecretLeaseError, isProductionCredential, redactLeaseValues, resolveSecretLeaseConfig } from "../apps/agent-api/src/code-secret-lease";

const context: AuthContext = { workspaceId: "ws-c4", userId: "user-c4", permissions: ["workspace:read", "business:manage"] };
const adminContext: AuthContext = { workspaceId: "ws-c4", userId: "user-owner", permissions: ["workspace:read", "business:manage", "admin:all"] };
const CREDENTIAL_ID = "3f1a7b8c-1111-4222-8333-444455556666";

const issueInput = (overrides: Record<string, unknown> = {}) => ({
  companyId: "c1", projectId: "p1", sessionId: "s1", purpose: "run build", toolCallId: "t1",
  variableName: "NPM_TOKEN", credentialId: CREDENTIAL_ID, field: "token",
  credential: { id: CREDENTIAL_ID, label: "dev-key", environment: "development" },
  ...overrides,
});

describe("security-gate: C4 secret lease issuance", () => {
  it("returns only a handle and never the secret value", async () => {
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    const lease = await provider.issue(context, issueInput());
    expect(lease.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lease.state).toBe("active");
    expect(JSON.stringify(lease)).not.toMatch(/token[":]+\s*"[^"]{8,}"/i);
    expect(Object.keys(lease)).not.toContain("value");
    expect(lease.expiresAt).toBeGreaterThan(lease.issuedAt);
  });

  it("follows the environment policy: development/staging allowed, unknown denied, production never", async () => {
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    // development and staging are leasable without any override
    await expect(provider.issue(context, issueInput({ credential: { id: CREDENTIAL_ID, label: "dev-key", environment: "development" } }))).resolves.toMatchObject({ state: "active" });
    await expect(provider.issue(context, issueInput({ toolCallId: "t2", credential: { id: CREDENTIAL_ID, label: "stage-key", environment: "staging" } }))).resolves.toMatchObject({ state: "active" });
    // unknown is refused for a normal user even when the operator allowlisted the credential
    await expect(provider.issue(context, issueInput({ toolCallId: "t3", credential: { id: CREDENTIAL_ID, label: "dev-key", environment: "unknown" } })))
      .rejects.toMatchObject({ code: "credential_environment_unknown", httpStatus: 403, details: { reason: "unknown_environment_override_requires_admin" } });
    // missing metadata is refused too
    await expect(provider.issue(context, issueInput({ toolCallId: "t4", credential: null })))
      .rejects.toMatchObject({ code: "credential_environment_unknown", details: { reason: "credential_metadata_missing" } });
    // production is a hard deny, with or without the allowlist
    await expect(provider.issue(adminContext, issueInput({ toolCallId: "t5", credential: { id: CREDENTIAL_ID, label: "dev-key", environment: "production" } })))
      .rejects.toMatchObject({ code: "production_credential_denied", httpStatus: 403, details: { reason: "production_environment" } });
    // the pure predicate now speaks environments only: nothing outside development/staging is leasable
    expect(isProductionCredential({ environment: "production" })).toBe(true);
    expect(isProductionCredential({ environment: "unknown" })).toBe(true);
    expect(isProductionCredential({ label: "prod-api" })).toBe(true);
    expect(isProductionCredential({ environment: "development" })).toBe(false);
    expect(isProductionCredential({ environment: "staging" })).toBe(false);
    expect(isProductionCredential(null)).toBe(true);
  });

  it("lets an owner override an unknown environment only with the allowlist, and audits it", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new SecretLeaseProvider({
      config: { allowedLabels: ["legacy-key"] },
      audit: { record: async (_ctx, input) => { events.push({ action: input.action, metadata: input.metadata }); return {}; } } as never,
    });
    const lease = await provider.issue(adminContext, issueInput({ credential: { id: CREDENTIAL_ID, label: "legacy-key", environment: "unknown" } }));
    expect(lease.state).toBe("active");
    expect(events.map((event) => event.action)).toEqual(["secret_lease.override", "secret_lease.issue"]);
    expect(JSON.stringify(events)).not.toContain("supersecretvalue");
    // an allowlisted credential that is NOT allowlisted by id/label stays refused even for an owner
    await expect(provider.issue(adminContext, issueInput({ toolCallId: "t7", credential: { id: CREDENTIAL_ID, label: "other-key", environment: "unknown" } })))
      .rejects.toMatchObject({ code: "credential_environment_unknown", details: { reason: "unknown_environment_not_allowlisted" } });
    // an override without a journal is refused (fail closed)
    const noJournal = new SecretLeaseProvider({ config: { allowedLabels: ["legacy-key"] } });
    await expect(noJournal.issue(adminContext, issueInput({ toolCallId: "t8", credential: { id: CREDENTIAL_ID, label: "legacy-key", environment: "unknown" } })))
      .rejects.toMatchObject({ code: "audit_unavailable", httpStatus: 503 });
  });

  it("trusts the authoritative credential resolver over the marker sent with the call", async () => {
    const provider = new SecretLeaseProvider({
      resolveCredential: async () => ({ id: CREDENTIAL_ID, label: "spoofed", environment: "production" }),
    });
    // the call claims development, the repository says production: production wins
    await expect(provider.issue(adminContext, issueInput({ credential: { id: CREDENTIAL_ID, label: "dev-key", environment: "development" } })))
      .rejects.toMatchObject({ code: "production_credential_denied", details: { environment: "production" } });
    const missing = new SecretLeaseProvider({ resolveCredential: async () => null });
    await expect(missing.issue(context, issueInput())).rejects.toMatchObject({ code: "credential_environment_unknown", details: { reason: "credential_not_found" } });
  });

  it("refuses to issue a lease when the audit journal is unavailable", async () => {
    const provider = new SecretLeaseProvider({
      config: { allowedLabels: ["dev-key"] },
      audit: { record: async () => { throw new Error("audit is down"); } } as never,
    });
    await expect(provider.issue(context, issueInput())).rejects.toMatchObject({ code: "audit_unavailable", httpStatus: 503 });
    expect(provider.list()).toHaveLength(0);
  });

  it("audits issuance and revocation without the value", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new SecretLeaseProvider({
      config: { allowedLabels: ["dev-key"] },
      audit: { record: async (_ctx, input) => { events.push({ action: input.action, metadata: input.metadata, payload: input.payload }); return {}; } } as never,
    });
    const lease = await provider.issue(context, issueInput());
    await provider.revoke(lease.leaseId, "test_finished");
    expect(events.map((event) => event.action)).toEqual(["secret_lease.issue", "secret_lease.revoke"]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("ghp_");
    expect(serialized).toContain(lease.leaseId);
    expect(serialized).not.toContain("supersecretvalue");
  });

  it("caps the TTL at the configured maximum", async () => {
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"], maxTtlMs: 5_000, defaultTtlMs: 5_000 } });
    const lease = await provider.issue(context, issueInput({ ttlMs: 600_000 }));
    expect(lease.expiresAt - lease.issuedAt).toBe(5_000);
  });
});

describe("security-gate: C4 secret lease delivery and non-inheritance", () => {
  it("hands the sandbox a reference, not a value, and consumes the lease once", async () => {
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    const lease = await provider.issue(context, issueInput());
    const references = provider.environmentReferences(lease.leaseId, "t1");
    expect(references).toEqual({ NPM_TOKEN: { id: CREDENTIAL_ID, field: "token" } });
    expect(() => provider.environmentReferences(lease.leaseId, "t1")).toThrow(SecretLeaseError);
    expect(() => provider.environmentReferences(lease.leaseId, "t2")).toThrow(/tool call it was issued for/);
  });

  it("never lets one call inherit another call's lease", async () => {
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    const lease = await provider.issue(context, issueInput({ toolCallId: "call-a" }));
    expect(() => provider.assertNotInherited(lease.leaseId, "call-b")).toThrow(/tool call it was issued for/);
    expect(provider.assertNotInherited(lease.leaseId, "call-a").leaseId).toBe(lease.leaseId);
    await provider.revokeAllForCall("call-a");
    expect(provider.list({ state: "active" })).toHaveLength(0);
  });

  it("refuses expired leases and revokes them through the reaper", async () => {
    let now = 1_000;
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"], maxTtlMs: 100, defaultTtlMs: 100 }, now: () => now });
    const lease = await provider.issue(context, issueInput());
    now += 500;
    expect(() => provider.environmentReferences(lease.leaseId, "t1")).toThrow(/expired/);
    const second = await provider.issue(context, issueInput({ toolCallId: "t9" }));
    now += 500;
    expect(await provider.reap()).toBeGreaterThanOrEqual(1);
    expect(provider.list().find((item) => item.leaseId === second.leaseId)!.state).toBe("expired");
    expect(provider.list({ state: "active" })).toHaveLength(0);
  });

  it("delivers a tmpfs file once, then deletes it on revoke", async () => {
    const written: Array<{ path: string; content: string }> = [];
    const deleted: string[] = [];
    const provider = new SecretLeaseProvider({
      config: { allowedLabels: ["dev-key"], secretDirectory: "/run/npati-secrets" },
      resolveField: async () => "supersecretvalue",
      writeSecretFile: async ({ path, content }) => { written.push({ path, content }); },
      deleteSecretFile: async ({ path }) => { deleted.push(path); },
    });
    const lease = await provider.issue(context, issueInput({ target: "tmpfsFile" }));
    expect(written).toHaveLength(1);
    expect(written[0]!.path.startsWith("/run/npati-secrets/")).toBe(true);
    const handle = provider.fileHandle(lease.leaseId, "t1");
    expect(handle.variableName).toBe("NPM_TOKEN");
    await provider.revoke(lease.leaseId, "done");
    expect(deleted).toEqual([written[0]!.path]);
    expect(JSON.stringify(lease)).not.toContain("supersecretvalue");
  });

  it("refuses tmpfs delivery when no secret store is configured", async () => {
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    await expect(provider.issue(context, issueInput({ target: "tmpfsFile" })))
      .rejects.toMatchObject({ code: "secret_delivery_unavailable", httpStatus: 503 });
  });

  it("redacts lease values and provider tokens out of any text", () => {
    const text = "using supersecretvalue and ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const redacted = redactLeaseValues(text, ["supersecretvalue"]);
    expect(redacted).not.toContain("supersecretvalue");
    expect(redacted).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
  });

  it("starts and stops the reaper and reports how many leases it revoked", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"], maxTtlMs: 10, defaultTtlMs: 10, reaperIntervalMs: 20 }, now: () => now });
      await provider.issue(context, issueInput());
      const seen: number[] = [];
      provider.startReaper((count) => seen.push(count));
      now += 1_000;
      await vi.advanceTimersByTimeAsync(60);
      expect(seen.reduce((total, value) => total + value, 0)).toBeGreaterThanOrEqual(1);
      provider.stopReaper();
      expect(resolveSecretLeaseConfig({} as NodeJS.ProcessEnv).maxTtlMs).toBe(120_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
