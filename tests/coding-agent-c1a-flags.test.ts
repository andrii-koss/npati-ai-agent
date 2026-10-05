import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { InMemoryWorkspaceStore, type AuthContext, type FeatureFlag } from "@npati/workspace";
import { AuditLogService, type AuditLogService as AuditLogServiceType } from "../apps/agent-api/src/audit-log";
import {
  CODE_AGENT_MASTER_FLAG, FeatureDisabledError, FeatureFlagError, FeatureFlagService, isValidCodeFlagKey,
} from "../apps/agent-api/src/feature-flags";
import { CodeService } from "../apps/agent-api/src/code-service";
import { registerCodeRoutes } from "../apps/agent-api/src/code-routes";
import { ProjectService } from "../apps/agent-api/src/project-service";
import type { ProjectWorkspace } from "../apps/agent-api/src/project-workspace";

const admin: AuthContext = { workspaceId: "ws-c1a", userId: "c1a-admin", permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all", "owner"] };
const member: AuthContext = { workspaceId: "ws-c1a", userId: "c1a-member", permissions: ["workspace:read", "business:manage"] };
const member2: AuthContext = { workspaceId: "ws-c1a", userId: "c1a-member-2", permissions: ["workspace:read", "business:manage"] };

const auditConfig = { verifyIntervalMs: 3_600_000, anchorIntervalMs: 3_600_000, retentionDays: 365, blockOnBreak: true, signingKey: "c1a-test-key" };

function fakeWorkspace(): ProjectWorkspace {
  return {
    async readFile(_ctx: AuthContext, _companyId: string, _projectId: string, path: string) {
      if (path === "package.json") return { path, content: JSON.stringify({ scripts: { test: "vitest run" } }), revision: "r1", size: 40 };
      throw new Error("not found");
    },
  } as unknown as ProjectWorkspace;
}

async function harness(options: { allowPreGateRollout?: boolean; audit?: AuditLogServiceType; stopSandboxes?: (ctx: AuthContext, companyId: string) => Promise<number> } = {}) {
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const audit = options.audit ?? new AuditLogService(store, auditConfig);
  const flags = new FeatureFlagService(store, audit, { cacheTtlMs: 15_000, allowPreGateRollout: options.allowPreGateRollout ?? false }, options.stopSandboxes);
  const projectService = new ProjectService(store);
  const codeService = new CodeService(store, projectService, fakeWorkspace(), { importRepository: async () => ({}) }, undefined, audit, flags);
  const companyA = await store.createCompany(admin, { name: "Flags A" }, "flags-co-a");
  const companyB = await store.createCompany(admin, { name: "Flags B" }, "flags-co-b");
  return { store, audit, flags, projectService, codeService, companyA, companyB };
}

/** Enables the master flag and `code.write` for one company at the `internal` stage. */
async function enableForCompany(harnessed: Awaited<ReturnType<typeof harness>>, companyId: string, extra: Partial<{ flagKey: string; scope: "global" | "company" | "user"; scopeId: string }> = {}) {
  const { flags, companyA } = harnessed;
  await flags.setFlag(admin, { scope: "company", scopeId: companyId, flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true }, { auditCompanyId: companyId });
  await flags.setFlag(admin, { scope: extra.scope ?? "company", scopeId: extra.scopeId ?? companyId, flagKey: extra.flagKey ?? "code.write", stage: "internal", enabled: true }, { auditCompanyId: companyA.id });
}

describe("security-gate: C1a dark launch", () => {
  it("denies every mutation while nothing is configured, both through the API and directly", async () => {
    const h = await harness();
    const project = await h.projectService.create(admin, h.companyA.id, { name: "Repo", type: "code_project" }, "flag-key-1").then((result) => result.project);

    // Direct service call (no HTTP): the gate lives in the service, so it cannot be bypassed.
    await expect(h.codeService.createSession(admin, h.companyA.id, project.id)).rejects.toBeInstanceOf(FeatureDisabledError);
    await expect(h.codeService.createProject(admin, h.companyA.id, { name: "Nope" })).rejects.toMatchObject({ code: "feature_disabled" });
    await expect(h.codeService.updateProject(admin, h.companyA.id, project.id, { expectedRevision: project.revision })).rejects.toMatchObject({ code: "feature_disabled" });

    const app = Fastify();
    registerCodeRoutes(app, { authenticate: async () => admin } as never, h.codeService, h.flags);
    const created = await app.inject({ method: "POST", url: `/companies/${h.companyA.id}/code/projects`, payload: { name: "Denied" } });
    expect(created.statusCode).toBe(403);
    expect(created.json().error).toMatchObject({ code: "feature_disabled", flagKey: CODE_AGENT_MASTER_FLAG });
    // Reads stay available: History must be readable while the feature is off.
    expect((await app.inject({ method: "GET", url: `/companies/${h.companyA.id}/code/sessions` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/companies/${h.companyA.id}/code/projects` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/companies/${h.companyA.id}/code/limits` })).statusCode).toBe(200);
    const view = await app.inject({ method: "GET", url: `/companies/${h.companyA.id}/code/flags` });
    expect(view.statusCode).toBe(200);
    expect(view.json().darkLaunch).toBe(true);
    expect(view.json().master.enabled).toBe(false);
    expect(view.json().flags.every((flag: { enabled: boolean }) => flag.enabled === false)).toBe(true);
    await app.close();
  });
});

describe("security-gate: C1a flag isolation", () => {
  it("enables one company without enabling another", async () => {
    const h = await harness({ allowPreGateRollout: false });
    await enableForCompany(h, h.companyA.id);

    expect(await h.flags.isEnabled(admin, "code.write", { companyId: h.companyA.id })).toBe(true);
    expect(await h.flags.isEnabled(admin, "code.write", { companyId: h.companyB.id })).toBe(false);
    expect(await h.flags.isEnabled(admin, CODE_AGENT_MASTER_FLAG, { companyId: h.companyB.id })).toBe(false);

    const projectA = await h.codeService.createProject(admin, h.companyA.id, { name: "Enabled repo" });
    const session = await h.codeService.createSession(admin, h.companyA.id, projectA.id);
    expect(session.status).toBe("active");

    await expect(h.codeService.createProject(admin, h.companyB.id, { name: "Other company" })).rejects.toMatchObject({ code: "feature_disabled" });
  });

  it("does not leak a user-scoped allowlist to another user", async () => {
    const h = await harness({ allowPreGateRollout: true });
    const audit = { auditCompanyId: h.companyA.id };
    // The master flag is reachable by both users (allowlist stage), the sub-flag only by one.
    await h.flags.setFlag(admin, { scope: "global", flagKey: CODE_AGENT_MASTER_FLAG, stage: "allowlist", enabled: true, allowlist: [member.userId, member2.userId] }, audit);
    await h.flags.setFlag(admin, { scope: "user", scopeId: member.userId, flagKey: "code.write", stage: "allowlist", enabled: true, allowlist: [member.userId] }, audit);
    // A row that exists for the second user but does not list them stays closed.
    await h.flags.setFlag(admin, { scope: "user", scopeId: member2.userId, flagKey: "code.write", stage: "allowlist", enabled: true, allowlist: [member.userId] }, audit);

    expect(await h.flags.isEnabled(member, "code.write", {})).toBe(true);
    expect(await h.flags.isEnabled(member2, "code.write", {})).toBe(false);
    expect(await h.flags.isEnabled(member, CODE_AGENT_MASTER_FLAG, {})).toBe(true);
  });

  it("keeps the master gate authoritative over every sub-flag", async () => {
    const h = await harness();
    const audit = { auditCompanyId: h.companyA.id };
    // Sub-flag alone must stay off: the master gate is the kill switch and is not implied by a sub-flag.
    await h.flags.setFlag(admin, { scope: "global", flagKey: "code.write", stage: "internal", enabled: true }, audit);
    expect(await h.flags.isEnabled(admin, "code.write", {})).toBe(false);
    // Master on while the sub-flag stays off: still closed, and a narrower scope cannot override it.
    await h.flags.setFlag(admin, { scope: "global", flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true }, audit);
    await h.flags.setFlag(admin, { scope: "global", flagKey: "code.write", stage: "off", enabled: false }, audit);
    expect(await h.flags.isEnabled(admin, "code.write", {})).toBe(false);
    await h.flags.setFlag(admin, { scope: "company", scopeId: h.companyA.id, flagKey: "code.write", stage: "internal", enabled: true }, audit);
    expect(await h.flags.isEnabled(admin, "code.write", { companyId: h.companyA.id })).toBe(true);
    // A broader `off` on the master vetoes the company-level sub-flag (master is authoritative).
    await h.flags.setFlag(admin, { scope: "global", flagKey: CODE_AGENT_MASTER_FLAG, stage: "off", enabled: false }, audit);
    expect(await h.flags.isEnabled(admin, "code.write", { companyId: h.companyA.id })).toBe(false);
    // Company-level master on again (the global stop restored first): the sub-flag works.
    await h.flags.setFlag(admin, { scope: "global", flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true }, audit);
    await h.flags.setFlag(admin, { scope: "company", scopeId: h.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true }, audit);
    expect(await h.flags.isEnabled(admin, "code.write", { companyId: h.companyA.id })).toBe(true);
    // Master off at the same (company) scope: closed immediately, even though the global row is on.
    await h.flags.setFlag(admin, { scope: "company", scopeId: h.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, stage: "off", enabled: false }, audit);
    expect(await h.flags.isEnabled(admin, "code.write", { companyId: h.companyA.id })).toBe(false);
  });

  it("validates flag keys so only the coding namespace can be changed", () => {
    expect(isValidCodeFlagKey(CODE_AGENT_MASTER_FLAG)).toBe(true);
    expect(isValidCodeFlagKey("code.write")).toBe(true);
    expect(isValidCodeFlagKey("code.model_profile.fast-1")).toBe(true);
    expect(isValidCodeFlagKey("code.write.all")).toBe(false);
    expect(isValidCodeFlagKey("billing.unlimited")).toBe(false);
    expect(isValidCodeFlagKey("code.model_profile.")).toBe(false);
  });
});

describe("security-gate: C1a flag administration and kill switch", () => {
  it("refuses flag changes from a non-admin and audits the ones from an admin", async () => {
    const h = await harness();
    await expect(h.flags.setFlag(member, { scope: "global", flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true }))
      .rejects.toMatchObject({ code: "flag_admin_required", status: 403 });

    const saved = await h.flags.setFlag(admin, { scope: "company", scopeId: h.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true }, { auditCompanyId: h.companyA.id });
    expect(saved.revision).toBe(1);
    expect(saved.updatedBy).toBe(admin.userId);

    const journal = await h.audit.list(admin, h.companyA.id);
    expect(journal.map((entry) => entry.action)).toContain("flag.change");
    expect(journal.find((entry) => entry.action === "flag.change")?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await h.flags.history(admin, CODE_AGENT_MASTER_FLAG)).length).toBe(1);
  });

  it("does not apply a flag change when the audit journal is unavailable (fail closed)", async () => {
    const failingAudit = { record: async () => { throw new Error("audit journal is down"); } } as unknown as AuditLogServiceType;
    const h = await harness({ audit: failingAudit });
    await expect(h.flags.setFlag(admin, { scope: "global", flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true }, { auditCompanyId: h.companyA.id }))
      .rejects.toThrow(/audit journal is down/);
    // Nothing was written, so the feature stays dark.
    expect(await h.flags.isEnabled(admin, CODE_AGENT_MASTER_FLAG, { companyId: h.companyA.id })).toBe(false);
    const stored = (await h.store.listFeatureFlags(admin)).filter((flag: FeatureFlag) => flag.flagKey === CODE_AGENT_MASTER_FLAG);
    expect(stored).toHaveLength(0);
  });

  it("rejects a stale revision and a rollout stage above internal before the security gate", async () => {
    const h = await harness();
    await h.flags.setFlag(admin, { scope: "company", scopeId: h.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true }, { auditCompanyId: h.companyA.id });
    await expect(h.flags.setFlag(admin, { scope: "company", scopeId: h.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, enabled: false, expectedRevision: 7 }, { auditCompanyId: h.companyA.id }))
      .rejects.toThrow(/changed by another request/i);
    await expect(h.flags.setFlag(admin, { scope: "company", scopeId: h.companyA.id, flagKey: "code.write", stage: "ga", enabled: true }, { auditCompanyId: h.companyA.id }))
      .rejects.toMatchObject({ code: "gate_not_passed", status: 409 });
    await expect(h.flags.setFlag(admin, { scope: "company", scopeId: h.companyA.id, flagKey: "code.unknown", enabled: true }, { auditCompanyId: h.companyA.id }))
      .rejects.toMatchObject({ code: "invalid_flag_key" });
    await expect(h.flags.setFlag(admin, { scope: "company", flagKey: "code.write", enabled: true }, { auditCompanyId: h.companyA.id }))
      .rejects.toMatchObject({ code: "invalid_flag_key" });

    // With the operator override the staged rollout is allowed (explicit pre-gate rollout).
    const staged = await harness({ allowPreGateRollout: true });
    const flag = await staged.flags.setFlag(admin, { scope: "company", scopeId: staged.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, stage: "percent", enabled: true, rolloutPercent: 50 }, { auditCompanyId: staged.companyA.id });
    expect(flag.stage).toBe("percent");
  });

  it("suspends active sessions, invalidates the cache immediately and audits the kill switch", async () => {
    let stopped = 0;
    const h = await harness({ stopSandboxes: async () => { stopped = 3; return 3; } });
    await enableForCompany(h, h.companyA.id);
    const project = await h.codeService.createProject(admin, h.companyA.id, { name: "Running repo" });
    await h.codeService.createSession(admin, h.companyA.id, project.id);
    await h.codeService.createSession(admin, h.companyA.id, project.id);
    expect(await h.flags.isEnabled(admin, "code.write", { companyId: h.companyA.id })).toBe(true);

    const result = await h.flags.killSwitch(admin, { companyId: h.companyA.id, reason: "security-gate test" });
    expect(result.suspendedSessions).toBe(2);
    expect(result.stoppedSandboxes).toBe(3);
    expect(stopped).toBe(3);

    // Cache invalidated in the same call: no TTL wait, the feature is off right away.
    expect(await h.flags.isEnabled(admin, "code.write", { companyId: h.companyA.id })).toBe(false);
    expect(await h.flags.isEnabled(admin, CODE_AGENT_MASTER_FLAG, { companyId: h.companyA.id })).toBe(false);

    const sessions = await h.store.listCodeSessions(admin, h.companyA.id, undefined, { includeArchived: true });
    expect(sessions.map((session) => session.status)).toEqual(["suspended_by_flag", "suspended_by_flag"]);
    const journal = await h.audit.list(admin, h.companyA.id);
    const killSwitch = journal.find((entry) => entry.action === "flag.kill_switch");
    expect(killSwitch).toBeTruthy();
    expect((killSwitch?.metadata as { plannedSessions?: number }).plannedSessions).toBe(2);
    await expect(h.codeService.createSession(admin, h.companyA.id, project.id)).rejects.toBeInstanceOf(FeatureDisabledError);
  });

  it("auto-disables the master flag on a broken audit chain", async () => {
    const h = await harness();
    await enableForCompany(h, h.companyA.id);
    expect(await h.flags.isEnabled(admin, CODE_AGENT_MASTER_FLAG, { companyId: h.companyA.id })).toBe(true);
    const outcome = await h.flags.evaluateAutoDisable({ ...admin, permissions: ["admin:all"] }, { type: "audit_chain_broken", reason: "sequence gap", companyId: h.companyA.id });
    expect(outcome.disabled).toBe(true);
    expect(await h.flags.isEnabled(admin, CODE_AGENT_MASTER_FLAG, { companyId: h.companyA.id })).toBe(false);
    expect((await h.audit.list(admin, h.companyA.id)).map((entry) => entry.action)).toContain("flag.auto_disable");
  });
});

describe("security-gate: C1a flag API", () => {
  it("enforces admin rights, key validation, revision conflicts and the gate over HTTP", async () => {
    const h = await harness();
    const app = Fastify();
    registerCodeRoutes(app, { authenticate: async () => admin } as never, h.codeService, h.flags);
    const memberApp = Fastify();
    registerCodeRoutes(memberApp, { authenticate: async () => member } as never, h.codeService, h.flags);

    const url = `/companies/${h.companyA.id}/code/flags`;
    const asMember = await memberApp.inject({ method: "PUT", url, payload: { scope: "company", scopeId: h.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true } });
    expect(asMember.statusCode).toBe(403);
    expect(asMember.json().error.code).toBe("flag_admin_required");

    const invalidKey = await app.inject({ method: "PUT", url, payload: { scope: "company", scopeId: h.companyA.id, flagKey: "billing.unlimited", enabled: true } });
    expect(invalidKey.statusCode).toBe(400);
    expect(invalidKey.json().error.code).toBe("invalid_flag_key");

    const created = await app.inject({ method: "PUT", url, payload: { scope: "company", scopeId: h.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, stage: "internal", enabled: true } });
    expect(created.statusCode).toBe(200);
    expect(created.json().revision).toBe(1);

    const conflict = await app.inject({ method: "PUT", url, payload: { scope: "company", scopeId: h.companyA.id, flagKey: CODE_AGENT_MASTER_FLAG, enabled: false, expectedRevision: 9 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("flag_revision_conflict");

    const gated = await app.inject({ method: "PUT", url, payload: { scope: "company", scopeId: h.companyA.id, flagKey: "code.write", stage: "ga", enabled: true } });
    expect(gated.statusCode).toBe(409);
    expect(gated.json().error.code).toBe("gate_not_passed");

    expect((await app.inject({ method: "PUT", url, payload: { scope: "company", scopeId: h.companyA.id, flagKey: "code.write", stage: "internal", enabled: true } })).statusCode).toBe(200);
    const created2 = await app.inject({ method: "POST", url: `/companies/${h.companyA.id}/code/projects`, payload: { name: "Flagged repo" } });
    expect(created2.statusCode).toBe(201);

    const kill = await app.inject({ method: "POST", url: `${url}/kill-switch`, payload: { reason: "incident", scope: "company" } });
    expect(kill.statusCode).toBe(200);
    expect(kill.json().flag.enabled).toBe(false);

    const afterKill = await app.inject({ method: "POST", url: `/companies/${h.companyA.id}/code/projects`, payload: { name: "Denied again" } });
    expect(afterKill.statusCode).toBe(403);
    await app.close(); await memberApp.close();
  });

  it("returns a feature-safe error when the flag service is not configured", async () => {
    const h = await harness();
    const app = Fastify();
    registerCodeRoutes(app, { authenticate: async () => admin } as never, h.codeService, undefined);
    const mutation = await app.inject({ method: "POST", url: `/companies/${h.companyA.id}/code/projects`, payload: { name: "No flags" } });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().error.code).toBe("feature_disabled");
    expect((await app.inject({ method: "GET", url: `/companies/${h.companyA.id}/code/flags` })).statusCode).toBe(503);
    await app.close();
  });
});
