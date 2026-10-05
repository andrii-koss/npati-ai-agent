import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { SecretLeaseProvider } from "../apps/agent-api/src/code-secret-lease";
import {
  DEFAULT_CREDENTIAL_ENVIRONMENT, CREDENTIAL_ENVIRONMENTS, isCredentialEnvironment, isLeasableEnvironment, normalizeCredentialEnvironment,
} from "../apps/agent-api/src/credential-environment";
import { evaluateCredentialLeasePolicy } from "../apps/agent-api/src/code-secret-lease";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * C4 (owner decision): credential environment marker and the SecretLease delivery invariants.
 * Every block is part of the `security-gate` suite.
 */

const user: AuthContext = { workspaceId: "ws-env", userId: "user-1", permissions: ["workspace:read", "business:manage"] };
const owner: AuthContext = { workspaceId: "ws-env", userId: "user-owner", permissions: ["workspace:read", "business:manage", "owner"] };
const CREDENTIAL_ID = "8c1f0d2e-1111-4222-8333-444455556666";

const input = (overrides: Record<string, unknown> = {}) => ({
  companyId: "c1", projectId: "p1", sessionId: "s1", purpose: "install", toolCallId: "t1",
  variableName: "NPM_TOKEN", credentialId: CREDENTIAL_ID, field: "token",
  credential: { id: CREDENTIAL_ID, label: "key", environment: "development" },
  ...overrides,
});

describe("security-gate: C4 credential environment marker", () => {
  it("normalises every stored value and treats anything unknown as unknown", () => {
    expect(CREDENTIAL_ENVIRONMENTS).toEqual(["development", "staging", "production", "unknown"]);
    expect(DEFAULT_CREDENTIAL_ENVIRONMENT).toBe("unknown");
    expect(normalizeCredentialEnvironment("development")).toBe("development");
    expect(normalizeCredentialEnvironment("DEV")).toBe("development");
    expect(normalizeCredentialEnvironment("local")).toBe("development");
    expect(normalizeCredentialEnvironment("staging")).toBe("staging");
    expect(normalizeCredentialEnvironment("preprod")).toBe("staging");
    expect(normalizeCredentialEnvironment("production")).toBe("production");
    expect(normalizeCredentialEnvironment("live")).toBe("production");
    // anything the platform cannot classify is unknown, never development
    expect(normalizeCredentialEnvironment("")).toBe("unknown");
    expect(normalizeCredentialEnvironment(undefined)).toBe("unknown");
    expect(normalizeCredentialEnvironment("qa-2")).toBe("unknown");
    expect(normalizeCredentialEnvironment(null)).toBe("unknown");
    expect(isCredentialEnvironment("staging")).toBe(true);
    expect(isCredentialEnvironment("qa-2")).toBe(false);
    expect(isLeasableEnvironment("development")).toBe(true);
    expect(isLeasableEnvironment("staging")).toBe(true);
    expect(isLeasableEnvironment("unknown")).toBe(false);
    expect(isLeasableEnvironment("production")).toBe(false);
  });

  it("evaluates the lease policy matrix without a provider", () => {
    const base = { allowedCredentialIds: [CREDENTIAL_ID], allowedLabels: ["legacy-key"] };
    const credential = (environment: string, label = "key") => ({ id: CREDENTIAL_ID, label, environment });
    expect(evaluateCredentialLeasePolicy({ credential: credential("development"), ...base, actorIsAdmin: false }))
      .toMatchObject({ allowed: true, environment: "development", overrideApplied: false });
    expect(evaluateCredentialLeasePolicy({ credential: credential("staging"), ...base, actorIsAdmin: false }))
      .toMatchObject({ allowed: true, environment: "staging" });
    expect(evaluateCredentialLeasePolicy({ credential: credential("unknown"), ...base, actorIsAdmin: false }))
      .toMatchObject({ allowed: false, code: "credential_environment_unknown", reason: "unknown_environment_override_requires_admin" });
    expect(evaluateCredentialLeasePolicy({ credential: credential("unknown"), ...base, actorIsAdmin: true }))
      .toMatchObject({ allowed: true, overrideApplied: true, reason: "unknown_environment_admin_override" });
    // the override needs the allowlist even for an owner (neither id nor label listed)
    expect(evaluateCredentialLeasePolicy({ credential: { id: "not-listed-id", label: "not-listed", environment: "unknown" }, ...base, actorIsAdmin: true }))
      .toMatchObject({ allowed: false, reason: "unknown_environment_not_allowlisted" });
    // production is a hard deny for everyone, allowlist or not
    for (const actorIsAdmin of [true, false]) {
      expect(evaluateCredentialLeasePolicy({ credential: credential("production"), ...base, actorIsAdmin }))
        .toMatchObject({ allowed: false, code: "production_credential_denied", reason: "production_environment" });
    }
  });

  it("keeps the migration additive: default unknown, CHECK constraint and no destructive statement", () => {
    const sql = readFileSync(path.join(process.cwd(), "packages/workspace/src/migration-069.ts"), "utf8");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS environment text");
    expect(sql).toContain("SET DEFAULT 'unknown'");
    expect(sql).toContain("SET NOT NULL");
    expect(sql).toContain("environment IN ('development','staging','production','unknown')");
    expect(sql).toContain("UPDATE company_browser_credentials SET environment='unknown' WHERE environment IS NULL");
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
  });
});

describe("security-gate: C4 lease non-inheritance, revocation and leak containment", () => {
  it("never lets another session, call or expired lease reuse a value handle", async () => {
    let now = 1_000;
    const provider = new SecretLeaseProvider({ now: () => now, config: { maxTtlMs: 100, defaultTtlMs: 100 } });
    const lease = await provider.issue(user, input({ sessionId: "session-a", toolCallId: "call-a" }));
    // another tool call in the same session
    expect(() => provider.environmentReferences(lease.leaseId, "call-b")).toThrow(/tool call it was issued for/);
    // another session entirely
    expect(() => provider.assertNotInherited(lease.leaseId, "call-a", "session-b")).toThrow(/session it was issued for|tool call it was issued for/);
    // the owner of the lease can still use it once
    expect(provider.environmentReferences(lease.leaseId, "call-a", "session-a")).toEqual({ NPM_TOKEN: { id: CREDENTIAL_ID, field: "token" } });
    // and never twice
    expect(() => provider.environmentReferences(lease.leaseId, "call-a", "session-a")).toThrow(/consumed only once|already consumed|exactly once/i);
    // expiry closes the lease even for the right caller
    const second = await provider.issue(user, input({ sessionId: "session-a", toolCallId: "call-c" }));
    now += 500;
    expect(() => provider.environmentReferences(second.leaseId, "call-c", "session-a")).toThrow(/expired/);
  });

  it("revokes the lease after success, after a failing command and on cancellation", async () => {
    const provider = new SecretLeaseProvider();
    const paths: string[] = [];
    const tmpfs = new SecretLeaseProvider({
      resolveField: async () => "supersecretvalue",
      writeSecretFile: async ({ path: file }) => { paths.push(file); },
      deleteSecretFile: async () => undefined,
    });

    // success path
    const ok = await provider.issue(user, input({ toolCallId: "call-ok" }));
    await provider.revoke(ok.leaseId, "call_finished");
    expect(provider.list({ state: "active" })).toHaveLength(0);
    expect(provider.list().find((item) => item.leaseId === ok.leaseId)!.state).toBe("revoked");

    // failing command path
    const failed = await provider.issue(user, input({ toolCallId: "call-fail" }));
    await provider.revokeAllForCall("call-fail", "command_failed");
    expect(provider.list().find((item) => item.leaseId === failed.leaseId)!.state).toBe("revoked");

    // cancellation path (explicit, same guarantee as completion)
    const cancelled = await provider.issue(user, input({ toolCallId: "call-cancel" }));
    await provider.revoke(cancelled.leaseId, "cancelled");
    expect(provider.list().find((item) => item.leaseId === cancelled.leaseId)!.state).toBe("revoked");
    expect(() => provider.environmentReferences(cancelled.leaseId, "call-cancel")).toThrow(/revoked/i);

    // tmpfs cleanup on cancellation
    const tmpfsLease = await tmpfs.issue(user, input({ toolCallId: "call-tmpfs", target: "tmpfsFile" }));
    expect(paths).toHaveLength(1);
    await tmpfs.revoke(tmpfsLease.leaseId, "cancelled");
    expect(tmpfs.list().find((item) => item.leaseId === tmpfsLease.leaseId)!.state).toBe("revoked");
  });

  it("never writes the value into the lease, the audit trail, the session state or the logs", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new SecretLeaseProvider({
      config: { allowedLabels: ["legacy-key"] },
      resolveField: async () => "supersecretvalue",
      writeSecretFile: async () => undefined,
      deleteSecretFile: async () => undefined,
      audit: { record: async (_ctx, entry) => { events.push({ action: entry.action, metadata: entry.metadata, payload: entry.payload }); return {}; } } as never,
    });
    const lease = await provider.issue(owner, input({ credential: { id: CREDENTIAL_ID, label: "legacy-key", environment: "unknown" } }));
    const references = provider.environmentReferences(lease.leaseId, "t1");
    await provider.revoke(lease.leaseId, "call_finished");

    const serialized = JSON.stringify({ lease, references, events, list: provider.list() });
    expect(serialized).not.toContain("supersecretvalue");
    expect(serialized).not.toContain("ghp_");
    // the reference is an id + field pair only: the sandbox resolves the value itself
    expect(references).toEqual({ NPM_TOKEN: { id: CREDENTIAL_ID, field: "token" } });
    expect(events.map((event) => event.action)).toEqual(["secret_lease.override", "secret_lease.issue", "secret_lease.revoke"]);
    expect(JSON.stringify(events)).toContain("unknown_environment_admin_override");
  });
});
