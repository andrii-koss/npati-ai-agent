import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { InMemoryWorkspaceStore, canonicalPayloadHash, verifyAuditEntries, type AuditEntry, type AuthContext, type WorkspaceStore } from "@npati/workspace";
import { AuditLogService, AuditUnavailableError, redactAuditMetadata } from "../apps/agent-api/src/audit-log";
import { registerAuditRoutes } from "../apps/agent-api/src/audit-routes";
import { AuthenticationError } from "../apps/agent-api/src/auth";
import type { AuditRepository } from "../apps/agent-api/src/audit-repository";

const admin: AuthContext = { workspaceId: "ws-audit", userId: "user-admin", permissions: ["workspace:read", "business:manage", "admin:all", "audit:read"] };
const member: AuthContext = { workspaceId: "ws-audit", userId: "user-member", permissions: ["workspace:read", "business:manage"] };
const stranger: AuthContext = { workspaceId: "ws-other", userId: "user-admin", permissions: ["workspace:read", "business:manage", "admin:all"] };

async function harness(config: Partial<ConstructorParameters<typeof AuditLogService>[1]> = {}) {
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const company = await store.createCompany(admin, { name: "Audit Co" }, "audit-company");
  const service = new AuditLogService(store, {
    verifyIntervalMs: 3_600_000, anchorIntervalMs: 3_600_000, retentionDays: 365, blockOnBreak: true, signingKey: "test-audit-key",
    ...config,
  });
  return { store, company, service };
}

const record = (service: AuditLogService, companyId: string, action: string, payload: unknown = { action }, metadata: Record<string, unknown> = {}) =>
  service.record(admin, {
    companyId, actor: admin.userId, actorRole: "admin", action, resourceType: "test", decision: "allowed", payload, metadata,
  });

describe("security-gate: C1c audit chain integrity", () => {
  it("chains entries per company and verifies the head hash", async () => {
    const { service, company } = await harness();
    const first = await record(service, company.id, "a.one");
    const second = await record(service, company.id, "a.two");
    const third = await record(service, company.id, "a.three");
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.entryHash);
    expect(third.prevHash).toBe(second.entryHash);
    const verification = await service.verify(admin, company.id);
    expect(verification).toMatchObject({ ok: true, entryCount: 3, headHash: third.entryHash });
  });

  it("detects every kind of out-of-band change: content, link, order and gap", async () => {
    const { service, company } = await harness();
    await record(service, company.id, "a.one", { action: "one" });
    await record(service, company.id, "a.two", { action: "two" });
    const entries = await service.list(admin, company.id);
    expect(verifyAuditEntries(entries).ok).toBe(true);

    const tampered = (mutate: (list: AuditEntry[]) => AuditEntry[]) => verifyAuditEntries(mutate(structuredClone(entries)));
    // 1. metadata rewritten by someone with DB access
    expect(tampered((list) => { list[1]!.metadata = { injected: true }; return list; })).toMatchObject({ ok: false, brokenAtSequence: 2, reason: expect.stringContaining("entry_hash") });
    // 2. entry hash rewritten to match the tampered content but the link left intact
    expect(tampered((list) => { list[0]!.entryHash = "0".repeat(64); return list; })).toMatchObject({ ok: false, brokenAtSequence: 1 });
    // 3. a row deleted in the middle leaves a sequence gap
    expect(tampered((list) => [list[0]!, { ...list[1]!, sequence: 3 }])).toMatchObject({ ok: false });
    // 4. a second row inserted with a sequence that already exists (duplicate / fork attempt)
    expect(tampered((list) => [list[0]!, { ...list[1]!, sequence: 1 }])).toMatchObject({ ok: false });
  });

  it("binds the entry to the exact payload: substitution changes the recorded hash", async () => {
    const { service, company } = await harness();
    const approved = await record(service, company.id, "approval.decide", { command: "npm test", cwd: "/workspace" });
    const substituted = await record(service, company.id, "approval.decide", { command: "rm -rf /", cwd: "/workspace" });
    expect(approved.payloadHash).toBe(canonicalPayloadHash({ command: "npm test", cwd: "/workspace" }));
    expect(substituted.payloadHash).not.toBe(approved.payloadHash);
  });

  it("fails closed when the journal cannot be written", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(admin, { name: "Broken" }, "audit-broken");
    const failing = Object.create(store) as WorkspaceStore;
    (failing as unknown as { appendAuditEntry: () => Promise<never> }).appendAuditEntry = async () => { throw new Error("database is down"); };
    const service = new AuditLogService(failing, { verifyIntervalMs: 1000, anchorIntervalMs: 1000, retentionDays: 30, blockOnBreak: true });
    await expect(service.record(admin, {
      companyId: company.id, actor: admin.userId, actorRole: "admin", action: "policy.change", resourceType: "policy", decision: "allowed",
    })).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it("blocks new privileged writes after a detected break and recovers after an investigation clears it", async () => {
    const { store, service, company } = await harness();
    await record(service, company.id, "a.one");
    // Simulate an administrative edit: rewrite the stored chain in place (the DB trigger prevents
    // this in PostgreSQL; here we prove the verifier notices and that writes then fail closed).
    const entries = await store.listAuditEntries(admin, company.id);
    const tamperedEntry = { ...entries[0]!, entryHash: "f".repeat(64) };
    (store as unknown as { auditLog: Map<string, AuditEntry[]> }).auditLog.set(company.id, [tamperedEntry]);

    const verification = await service.verify(admin, company.id);
    expect(verification.ok).toBe(false);
    expect(verification.alert).toContain("CRITICAL");
    expect(service.isBlocked(company.id)).toBe(true);
    await expect(record(service, company.id, "a.two")).rejects.toBeInstanceOf(AuditUnavailableError);

    service.clearBlock(company.id);
    expect(service.isBlocked(company.id)).toBe(false);
  });

  it("keeps secrets and prompt content out of the journal", async () => {
    const { service, company } = await harness();
    const entry = await service.record(admin, {
      companyId: company.id, actor: admin.userId, actorRole: "admin", action: "secret.test", resourceType: "test", decision: "allowed",
      payload: { action: "secret.test" },
      metadata: {
        apiKey: "sk-live-abcdefghijklmnop", token: "ghp_0123456789abcdefghijklmnop",
        prompt: "You are a helpful assistant", content: "file body", nested: { authorization: "Bearer abcdefghijklmnop.qrstuvwx" },
        safe: "visible",
      },
    });
    const metadata = JSON.stringify(entry.metadata);
    expect(metadata).not.toContain("sk-live");
    expect(metadata).not.toContain("ghp_");
    expect(metadata).not.toContain("You are a helpful");
    expect(metadata).not.toContain("file body");
    expect(metadata).not.toContain("Bearer abc");
    expect(entry.metadata.safe).toBe("visible");
    // Direct unit check of the redactor for the same rules (the masker covers known key shapes and
    // database URLs, so a token that only differs by key name is still redacted by key).
    expect(redactAuditMetadata("token ghp_0123456789abcdefghijklmnopqrstuvwxyz")).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
    expect(redactAuditMetadata("postgres://user:supersecret@db:5432/npati")).not.toContain("supersecret");
  });

  it("isolates companies: entries and verification never cross a company or workspace boundary", async () => {
    const { store, service, company } = await harness();
    const other = await store.createCompany(admin, { name: "Other Co" }, "audit-other");
    await record(service, company.id, "a.one");
    await record(service, other.id, "b.one");

    const firstChain = await service.list(admin, company.id);
    expect(firstChain).toHaveLength(1);
    expect(firstChain[0]!.action).toBe("a.one");
    expect((await service.verify(admin, other.id)).entryCount).toBe(1);

    await expect(service.list(stranger, company.id)).rejects.toThrow(/not available/i);
    await expect(service.verify(stranger, company.id)).rejects.toThrow();
  });

  it("writes signed daily anchors outside the database and detects a rewritten anchor", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "npati-audit-"));
    const { service, company } = await harness({ anchorDirectory: directory, signingKey: "anchor-key" });
    await record(service, company.id, "a.one");
    const anchors = await service.writeDailyAnchors(admin.workspaceId, new Date());
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.anchorPath).toBeTruthy();
    expect(anchor.headHash).toBe((await service.verify(admin, company.id)).headHash);

    const file = anchor.anchorPath!;
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { signature: string; headHash: string };
    expect(onDisk.signature).toBe(anchor.signature);
    expect(await service.readAnchorFile(file)).toMatchObject({ ok: true, headHash: anchor.headHash });

    // A rewritten anchor (for example by an attacker with DB and file access) fails verification.
    onDisk.headHash = "0".repeat(64);
    await writeFile(file, JSON.stringify(onDisk), "utf8");
    expect(await service.readAnchorFile(file)).toMatchObject({ ok: false, reason: expect.stringContaining("signature") });

    const listed = await service.anchors(admin, company.id);
    expect(listed).toHaveLength(1);
  });
});

describe("security-gate: C1c audit API access control", () => {
  function app(service: AuditLogService, actor: AuthContext | "anonymous") {
    const instance = Fastify();
    const repo = { listAuditLogs: async () => [], getUsageAnalytics: async () => ({}) } as unknown as AuditRepository;
    registerAuditRoutes(instance, {
      auth: { authenticate: async () => { if (actor === "anonymous") throw new AuthenticationError("unauthorized"); return actor; } } as never,
      store: undefined as never,
      repo,
      auditLog: service,
    });
    return instance;
  }

  it("requires the owner/admin role for journal, verify, anchors and export, and returns 401 anonymously", async () => {
    const { service, company, store } = await harness();
    await record(service, company.id, "a.one");
    const make = (actor: AuthContext | "anonymous") => {
      const instance = Fastify();
      const repo = { listAuditLogs: async () => [], getUsageAnalytics: async () => ({}) } as unknown as AuditRepository;
      registerAuditRoutes(instance, {
        auth: { authenticate: async () => { if (actor === "anonymous") throw new AuthenticationError("unauthorized"); return actor; } } as never,
        store,
        repo,
        auditLog: service,
      });
      return instance;
    };

    const asMember = make(member);
    for (const url of [`/companies/${company.id}/audit/journal`, `/companies/${company.id}/audit/verify`, `/companies/${company.id}/audit/anchors`, `/companies/${company.id}/audit/export`]) {
      const denied = await asMember.inject({ method: "GET", url });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("audit_read_denied");
    }
    await asMember.close();

    const anonymous = make("anonymous");
    expect((await anonymous.inject({ method: "GET", url: `/companies/${company.id}/audit/journal` })).statusCode).toBe(401);
    await anonymous.close();

    const asAdmin = make(admin);
    const journal = await asAdmin.inject({ method: "GET", url: `/companies/${company.id}/audit/journal?action=a.one` });
    expect(journal.statusCode).toBe(200);
    expect(journal.json().entries).toHaveLength(1);
    expect(journal.json().blocked).toBe(false);
    expect((await asAdmin.inject({ method: "GET", url: `/companies/${company.id}/audit/verify` })).json()).toMatchObject({ ok: true });
    expect((await asAdmin.inject({ method: "GET", url: `/companies/${company.id}/audit/anchors` })).json().anchors).toHaveLength(0);
    const exported = await asAdmin.inject({ method: "GET", url: `/companies/${company.id}/audit/export` });
    expect(exported.statusCode).toBe(200);
    // The export itself is audited, so the journal grows by exactly one entry.
    const after = await service.list(admin, company.id);
    expect(after.map((entry) => entry.action)).toEqual(["a.one", "audit.export"]);
    await asAdmin.close();
  });

  it("returns feature-safe errors when the journal is not configured", async () => {
    const instance = Fastify();
    const repo = { listAuditLogs: async () => [], getUsageAnalytics: async () => ({}) } as unknown as AuditRepository;
    registerAuditRoutes(instance, { auth: { authenticate: async () => admin } as never, store: undefined as never, repo });
    const response = await instance.inject({ method: "GET", url: "/companies/any/audit/journal" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("audit_unavailable");
    await instance.close();
  });
});
