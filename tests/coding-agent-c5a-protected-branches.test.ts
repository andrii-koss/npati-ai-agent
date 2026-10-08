import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthContext, CodeSession, CodeSessionMode } from "@npati/workspace";
import {
  PolicyEngine,
  type PolicyEngineDeps,
  type PolicyRequest,
} from "../apps/agent-api/src/code-policy-engine";
import { classifyShellCommand, detectGitWriteAttempts } from "../apps/agent-api/src/code-shell-classifier";
import {
  CodeProtectedBranchRepository,
  CodeProtectedBranchService,
  DEFAULT_PROTECTED_BRANCHES,
  type CodeProtectedBranchStore,
} from "../apps/agent-api/src/code-protected-branches";
import {
  CODE_CANONICAL_SESSION_MODES,
  CODE_PRIVILEGED_PERMISSIONS,
  CodeRbac,
  createRoleRegistry,
  requiredPermissionForAction,
} from "../apps/agent-api/src/code-rbac";
import {
  CodeSessionModeService,
  resolveSessionMode,
} from "../apps/agent-api/src/code-session-mode-routes";
import {
  CodeMembershipService,
  type CodeMembershipStore,
  type CompanyInvite,
  type CompanyMember,
  type CompanyRole,
} from "../apps/agent-api/src/code-membership";
import { CodeProjectTrustService } from "../apps/agent-api/src/code-project-trust";
import { CodeShellRuntime } from "../apps/agent-api/src/code-shell-runtime";
import { holdsProductionPermission } from "../apps/agent-api/src/code-step-up";
import { registerCodeMembershipRoutes } from "../apps/agent-api/src/code-membership-routes";

/**
 * C5a (D9/D6/D4/D7/D3/D10) — the gaps the C5a read-through and the test runs found, pinned shut.
 *
 * The central case is D9: `git push origin main` used to be an `approval` for everybody, because the
 * shell classifier only hard-denied `git push --force` and nothing consulted
 * `code-protected-branches.ts`. The engine now consults the **company** policy in its hard-deny phase,
 * which is why the "an extended company list decides the push" case below is the proof that the list is
 * read by the enforcement layer and not merely stored.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";
const SHELL_TOOL = "code.shell.exec";

const TOOL_IDS = ["code.shell.exec", "code.fs.read", "code.fs.write", "code.fs.edit", "code.fs.move", "code.verify.run", "code.fs.delete", "code.deps.add"];

function context(role: string | null, userId: string, permissions: string[] = ["workspace:read", "workspace:write", "admin:all"]): AuthContext {
  return { workspaceId: "ws-1", companyId: COMPANY, userId, permissions, role } as unknown as AuthContext;
}

const owner = context("owner", "u-owner");
const agentPrincipal: AuthContext = { workspaceId: "ws-1", companyId: COMPANY, userId: "agent:runner-1", externalSubject: "agent:runner-1", permissions: ["workspace:read", "workspace:write"], role: "owner" } as unknown as AuthContext;

/** A principal in the shape `code-rbac.ts` reads: `role` in the context, permissions additive. */
function principal(overlay: { role?: string; userId?: string; externalSubject?: string; permissions?: string[] }): AuthContext {
  return {
    workspaceId: "ws-1",
    companyId: COMPANY,
    userId: overlay.userId ?? "u-principal",
    permissions: overlay.permissions ?? [],
    ...(overlay.role === undefined ? {} : { role: overlay.role }),
    ...(overlay.externalSubject === undefined ? {} : { externalSubject: overlay.externalSubject }),
  } as unknown as AuthContext;
}

/** The company role resolver the protected-branch service uses (the real one is company membership). */
function roleResolver(roles: Record<string, string | null>) {
  return async (ctx: AuthContext) => roles[String(ctx.userId ?? "")] ?? null;
}

interface EngineHarness {
  engine: PolicyEngine;
  approvals: { requested: Array<Record<string, unknown>>; consumed: Array<{ id: string; params: Record<string, unknown> }> };
  policy: CodeProtectedBranchService;
}

function protectedBranchService(store?: CodeProtectedBranchStore): CodeProtectedBranchService {
  return new CodeProtectedBranchService({
    store: store ?? new CodeProtectedBranchRepository(),
    resolveRole: roleResolver({ "u-owner": "owner", "u-dev": "developer" }),
    // The administrative path refuses without a journal; the enforcement path never needs one.
    audit: { record: async () => undefined },
  });
}

function engineHarness(policy: CodeProtectedBranchService, overrides: Partial<PolicyEngineDeps> = {}): EngineHarness {
  const approvals = {
    requested: [] as Array<Record<string, unknown>>,
    consumed: [] as Array<{ id: string; params: Record<string, unknown> }>,
  };
  const deps: PolicyEngineDeps = {
    flags: { async assertEnabled() { return true; } },
    capabilities: { get: (id: string) => (TOOL_IDS.includes(id) ? { id, status: "active", version: 1 } : undefined) },
    // The real classifier: the suite must exercise the shipped `hard_deny` / `approval` levels.
    classifier: (command: string) => classifyShellCommand(command),
    approvals: {
      async requestApproval(_ctx, _companyId, input) {
        approvals.requested.push(input);
        return { id: `approval-${approvals.requested.length}` };
      },
      async consumeApproved(_ctx, _companyId, id, params) {
        approvals.consumed.push({ id, params });
        return { id };
      },
    },
    // Egress enforcement is guaranteed so the network gate (which precedes the approval phase for
    // `git push`) is not the phase under test.
    networkEnforcement: () => true,
    protectedBranches: policy,
    ...overrides,
  };
  return { engine: new PolicyEngine(deps), approvals, policy };
}

function pushRequest(ctx: AuthContext, command: string, extra: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    ctx,
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    tool: SHELL_TOOL,
    command,
    sessionMode: "full_auto_sandbox",
    ...extra,
  };
}

describe("security-gate: C5a protected branches — the company policy decides the push (D9)", () => {
  it("hard-denies a push into a branch of the company policy, and keeps the rest at approval", async () => {
    const policy = protectedBranchService();
    // The owner extends the policy: `production` is protected, `main` is not (the company list REPLACES
    // the built-in default, it does not extend it).
    await policy.updatePolicy(owner, COMPANY, { branches: ["production", "release"], expectedRevision: 0 });

    const harness = engineHarness(policy);
    const protectedPush = await harness.engine.evaluate(pushRequest(owner, "git push origin production"));
    expect(protectedPush).toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny", status: 403 });
    expect(protectedPush.reasons.join(" ")).toContain("production");

    // `main` is NOT in the stored company policy, so the push keeps its ordinary `approval` class. If the
    // enforcement layer were still using the built-in list, this case would be denied and the one above
    // would be allowed: the two outcomes together prove the company list is what the engine reads.
    const unprotectedPush = await harness.engine.evaluate(pushRequest(owner, "git push origin main"));
    expect(unprotectedPush).toMatchObject({ decision: "require_approval", phase: "approval" });
    expect(harness.approvals.requested).toHaveLength(1);
  });

  it("denies a protected-branch push for an owner with admin:all in full_auto_sandbox with approved:true", async () => {
    const policy = protectedBranchService();
    const harness = engineHarness(policy);
    // The plan's literal case: the owner holds `admin:all`, the session is the unattended mode and an
    // approval is presented. The hard deny is decided in phase 4b, before the approval phase exists.
    const result = await harness.engine.evaluate(pushRequest(owner, "git push origin main", { approved: true, approvalId: "approval-1" }));
    expect(result).toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny", status: 403 });
    expect(result.retryable).toBe(false);
    // The refusal is not routed through an approval: nothing was requested and nothing was consumed.
    expect(harness.approvals.requested).toHaveLength(0);
    expect(harness.approvals.consumed).toHaveLength(0);
  });

  it("denies an agent principal the same push, with and without an approval claim", async () => {
    const harness = engineHarness(protectedBranchService());
    // An agent may never be the approver, so the approval claim is refused even earlier (phase 2).
    expect(await harness.engine.evaluate(pushRequest(agentPrincipal, "git push origin main", { approved: true, approvalId: "approval-1" })))
      .toMatchObject({ decision: "deny", code: "agent_cannot_approve", phase: "rbac" });
    expect(await harness.engine.evaluate(pushRequest(agentPrincipal, "git push origin main")))
      .toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny", status: 403 });
    expect(harness.approvals.requested).toHaveLength(0);
    expect(harness.approvals.consumed).toHaveLength(0);
  });

  it("refuses a force push with force_push_denied, including for a branch only the company protects", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["trunk"], expectedRevision: 0 });
    const harness = engineHarness(policy);

    const direct = await harness.engine.evaluate(pushRequest(owner, "git push --force origin trunk", { approved: true, approvalId: "approval-1" }));
    expect(direct).toMatchObject({ decision: "deny", code: "force_push_denied", phase: "hard_deny", status: 403 });
    // `-f` and the refspec form are the same operation.
    expect(await harness.engine.evaluate(pushRequest(owner, "git push -f origin trunk"))).toMatchObject({ code: "force_push_denied" });
    expect(await harness.engine.evaluate(pushRequest(owner, "git push origin +trunk"))).toMatchObject({ code: "force_push_denied" });
    expect(harness.approvals.consumed).toHaveLength(0);

    // A force push into a branch the company policy does not protect stays an approval, never an allow.
    expect(await harness.engine.evaluate(pushRequest(owner, "git push --force origin feature/topic"))).toMatchObject({
      decision: "require_approval",
      code: "approval_required",
    });
  });

  it("keeps a push into an unprotected branch at approval in every mode, and never automatic", async () => {
    const harness = engineHarness(protectedBranchService());
    for (const sessionMode of ["edit", "auto", "auto_edit", "full_auto", "full_auto_sandbox"] as const) {
      const result = await harness.engine.evaluate(pushRequest(owner, "git push origin feature/topic", { sessionMode }));
      expect(result.decision, sessionMode).toBe("require_approval");
      expect(result.code, sessionMode).toBe("approval_required");
    }
    // `plan` denies the approval class outright (the matrix), it does not allow it either.
    expect(await harness.engine.evaluate(pushRequest(owner, "git push origin feature/topic", { sessionMode: "plan" })))
      .toMatchObject({ decision: "deny", code: "session_mode_denied" });
  });

  it("falls back to the built-in default branches when the policy store cannot be read", async () => {
    const broken: CodeProtectedBranchStore = {
      async get() { throw new Error("store down"); },
      async save() { throw new Error("store down"); },
    };
    const policy = protectedBranchService(broken);
    const harness = engineHarness(policy);

    // Conservative default: `main` stays protected (never "allow because the policy is unknown").
    expect(await harness.engine.evaluate(pushRequest(owner, "git push origin main")))
      .toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny" });
    expect(DEFAULT_PROTECTED_BRANCHES).toEqual(["main", "master", "release"]);
    // A branch outside the default set is not protected by default, so the ordinary approval applies.
    expect(await harness.engine.evaluate(pushRequest(owner, "git push origin feature/topic")))
      .toMatchObject({ decision: "require_approval" });
    // Changing the policy with an unreadable store refuses (503) instead of pretending to have stored it.
    await expect(policy.updatePolicy(owner, COMPANY, { branches: ["trunk"], expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "protected_branches_store_unavailable", httpStatus: 503, retryable: true });
  });

  it("cannot be relaxed by a caller-supplied field on the policy request", async () => {
    const harness = engineHarness(protectedBranchService());
    const sneaky = {
      ...pushRequest(owner, "git push origin main"),
      protectedBranches: [],
      protected_branches: [],
      options: { protectedBranches: [] },
    } as unknown as PolicyRequest;
    expect(await harness.engine.evaluate(sneaky)).toMatchObject({ decision: "deny", code: "protected_branch_write_denied" });
  });

  it("refuses the git write when the policy port itself fails (fail closed)", async () => {
    const harness = engineHarness(protectedBranchService(), {
      protectedBranches: { evaluateGitWrite: async () => { throw new Error("policy exploded"); } },
    });
    expect(await harness.engine.evaluate(pushRequest(owner, "git push origin main"))).toMatchObject({
      decision: "deny",
      code: "protected_branch_policy_unavailable",
      phase: "hard_deny",
      status: 503,
    });
  });

  it("parses the branch a git push writes to, including the refspec forms", () => {
    expect(detectGitWriteAttempts("git push origin main")).toEqual([{ operation: "push", branch: "main" }]);
    expect(detectGitWriteAttempts("git push --force origin refs/heads/release")).toEqual([{ operation: "force_push", branch: "release" }]);
    expect(detectGitWriteAttempts("git push origin HEAD:main")).toEqual([{ operation: "push", branch: "main" }]);
    expect(detectGitWriteAttempts("git push origin :main")).toEqual([{ operation: "push", branch: "main" }]);
    expect(detectGitWriteAttempts("git push origin +main")).toEqual([{ operation: "force_push", branch: "main" }]);
    expect(detectGitWriteAttempts("cd /workspace && git -C /workspace push origin master")).toEqual([{ operation: "push", branch: "master" }]);
    expect(detectGitWriteAttempts("git push origin main feature/x")).toEqual([
      { operation: "push", branch: "main" },
      { operation: "push", branch: "feature/x" },
    ]);
    // A push that names no branch (its branch is a property of the checkout) and a non-push are not
    // resolved to a branch — the ordinary risk class applies.
    expect(detectGitWriteAttempts("git push")).toEqual([{ operation: "push", branch: "" }]);
    expect(detectGitWriteAttempts("git status")).toEqual([]);
    expect(detectGitWriteAttempts("git commit -m 'push the fix'")).toEqual([]);
  });

  it("keeps the classifier's force-push hard deny and its company-list option", () => {
    expect(classifyShellCommand("git push --force origin main").risk).toBe("hard_deny");
    expect(classifyShellCommand("git push --force origin prod").risk).not.toBe("hard_deny");
    expect(classifyShellCommand("git push --force origin prod", { protectedBranches: ["main", "master", "release", "prod"] }).risk).toBe("hard_deny");
    // A plain push stays an approval at the classifier level: the company-policy hard deny is the
    // engine's, which is the only layer that can read the company policy.
    expect(classifyShellCommand("git push origin main").risk).toBe("approval");
  });
});

// ---------------------------------------------------------------------------------------------
// D6: the session-mode surface
// ---------------------------------------------------------------------------------------------

interface ModeHarness {
  service: CodeSessionModeService;
  state: { mode: CodeSessionMode; revision: number; updates: Array<Record<string, unknown>> };
  audit: Array<{ action: string; decision?: string; metadata?: Record<string, unknown> }>;
}

function modeHarness(): ModeHarness {
  const state: ModeHarness["state"] = { mode: "plan", revision: 3, updates: [] };
  const audit: ModeHarness["audit"] = [];
  const session = (): CodeSession => ({
    id: SESSION, workspaceId: "ws-1", companyId: COMPANY, projectId: PROJECT, userId: "u-owner",
    mode: state.mode, status: "active", dataClassification: "internal", retentionClass: "standard",
    revision: state.revision, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as CodeSession;
  const store = {
    getCodeSession: async () => session(),
    updateCodeSession: async (_ctx: AuthContext, _companyId: string, _sessionId: string, patch: { mode?: CodeSessionMode; expectedRevision?: number }) => {
      state.updates.push({ ...patch });
      state.mode = patch.mode ?? state.mode;
      state.revision += 1;
      return session();
    },
  };
  return {
    service: new CodeSessionModeService({
      store: store as never,
      audit: { record: async (entry) => { audit.push(entry as ModeHarness["audit"][number]); } },
    }),
    state,
    audit,
  };
}

async function refusal<T>(promise: Promise<T>): Promise<Record<string, unknown> | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as Record<string, unknown>;
  }
}

describe("security-gate: C5a session modes — role to mode matrix (D6)", () => {
  it("names the canonical modes and normalises the legacy aliases", () => {
    expect([...CODE_CANONICAL_SESSION_MODES]).toEqual(["plan", "ask", "auto_edit", "full_auto_sandbox"]);
    expect(resolveSessionMode("full_auto")).toMatchObject({ mode: "full_auto_sandbox", persisted: "full_auto", legacyAlias: true });
    expect(resolveSessionMode("full_auto_sandbox")).toMatchObject({ mode: "full_auto_sandbox", persisted: "full_auto", legacyAlias: false });
    expect(resolveSessionMode("edit")).toMatchObject({ mode: "ask", persisted: "edit" });
    expect(resolveSessionMode("auto")).toMatchObject({ mode: "auto_edit", persisted: "auto" });
    expect(resolveSessionMode("yolo")).toBe(null);
  });

  it("lets a developer set plan/ask/auto_edit and refuses full_auto_sandbox", async () => {
    for (const mode of ["plan", "ask", "auto_edit"]) {
      const harness = modeHarness();
      const updated = await harness.service.setMode(context("developer", "u-dev", ["workspace:read", "workspace:write"]), COMPANY, SESSION, { mode, expectedRevision: 3 });
      expect(updated, mode).toBeTruthy();
      expect(harness.audit.map((entry) => entry.action), mode).toEqual(["code.session.mode_change"]);
      expect(harness.audit[0]!.metadata, mode).toMatchObject({ to: mode });
    }
    for (const mode of ["full_auto", "full_auto_sandbox"]) {
      const harness = modeHarness();
      const failure = await refusal(harness.service.setMode(context("developer", "u-dev", ["workspace:read", "workspace:write"]), COMPANY, SESSION, { mode, expectedRevision: 3 }));
      expect(failure?.code, mode).toBe("session_mode_not_permitted");
      expect(failure?.httpStatus, mode).toBe(403);
      expect(harness.state.updates, mode).toEqual([]);
      // C5a (D7): the refusal is journalled too.
      expect(harness.audit.map((entry) => entry.action), mode).toEqual(["code.session.mode_change.denied"]);
      expect(harness.audit[0]!.decision, mode).toBe("deny");
    }
  });

  it("lets owner and admin enable the unattended mode by its canonical name, and normalises full_auto", async () => {
    for (const role of ["owner", "admin"] as const) {
      const canonical = modeHarness();
      await canonical.service.setMode(context(role, `u-${role}`), COMPANY, SESSION, { mode: "full_auto_sandbox", expectedRevision: 3 });
      expect(canonical.audit[0]!.metadata, role).toMatchObject({ to: "full_auto_sandbox", legacyAlias: false });
      // The persisted value stays within the migration-065 CHECK vocabulary.
      expect(canonical.state.updates, role).toEqual([{ mode: "full_auto", expectedRevision: 3 }]);

      const legacy = modeHarness();
      await legacy.service.setMode(context(role, `u-${role}`), COMPANY, SESSION, { mode: "full_auto", expectedRevision: 3 });
      expect(legacy.audit[0]!.metadata, role).toMatchObject({ to: "full_auto_sandbox", requestedMode: "full_auto", legacyAlias: true });
    }
  });

  it("refuses a role with no mode at all, an unknown mode and an agent principal — each audited", async () => {
    const reviewer = modeHarness();
    expect((await refusal(reviewer.service.setMode(context("reviewer", "u-rev", ["workspace:read"]), COMPANY, SESSION, { mode: "plan", expectedRevision: 3 })))?.code)
      .toBe("session_mode_admin_required");
    expect(reviewer.audit.map((entry) => entry.action)).toEqual(["code.session.mode_change.denied"]);

    const unknown = modeHarness();
    const invalid = await refusal(unknown.service.setMode(context("owner", "u-owner"), COMPANY, SESSION, { mode: "yolo", expectedRevision: 3 }));
    expect(invalid?.code).toBe("invalid_mode");
    expect(invalid?.httpStatus).toBe(400);
    // A shape error is not an authorization denial: nothing is written to the journal.
    expect(unknown.audit).toEqual([]);

    const agent = modeHarness();
    const denied = await refusal(agent.service.setMode(agentPrincipal, COMPANY, SESSION, { mode: "plan", expectedRevision: 3 }));
    expect(denied?.code).toBe("agent_cannot_change_policy");
    expect(agent.audit.map((entry) => entry.action)).toEqual(["code.session.mode_change.denied"]);
    expect(agent.state.updates).toEqual([]);
  });

  it("takes the role -> mode map from the injected registry, not from a hardcoded role list", async () => {
    const registry = createRoleRegistry({
      roles: { operator: ["workspace:read", "workspace:write"] },
      sessionModes: { operator: ["plan", "auto_edit"] },
    });
    const harness = new CodeSessionModeService({
      store: {
        getCodeSession: async () => ({ revision: 3, mode: "plan" }) as unknown as CodeSession,
        updateCodeSession: async () => ({ revision: 4, mode: "auto" }) as unknown as CodeSession,
      } as never,
      audit: { record: async () => undefined },
      registry,
    });
    await expect(harness.setMode(context("operator", "u-op", ["workspace:read"]), COMPANY, SESSION, { mode: "auto_edit", expectedRevision: 3 })).resolves.toBeTruthy();
    expect((await refusal(harness.setMode(context("operator", "u-op", ["workspace:read"]), COMPANY, SESSION, { mode: "full_auto_sandbox", expectedRevision: 3 })))?.code)
      .toBe("session_mode_not_permitted");
  });
});

// ---------------------------------------------------------------------------------------------
// D4/D7/D10: company membership
// ---------------------------------------------------------------------------------------------

interface MembershipHarness {
  service: CodeMembershipService;
  state: { members: Map<string, CompanyMember>; invites: number; roleUpdates: number };
  audit: Array<{ action: string; decision?: string; metadata?: Record<string, unknown> }>;
}

function membershipHarness(seed: Array<{ userId: string; role: CompanyRole }>): MembershipHarness {
  const state: MembershipHarness["state"] = { members: new Map(), invites: 0, roleUpdates: 0 };
  const audit: MembershipHarness["audit"] = [];
  let revision = 1;
  for (const entry of seed) {
    state.members.set(`${COMPANY}:${entry.userId}`, {
      id: `cm_${entry.userId}`, companyId: COMPANY, userId: entry.userId, role: entry.role, status: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"), revision: 1,
    });
  }
  const store: CodeMembershipStore = {
    async getCompanyMembership(companyId, userId) { return state.members.get(`${companyId}:${userId}`) ?? null; },
    async listCompanyMembers(companyId) { return [...state.members.values()].filter((member) => member.companyId === companyId); },
    async countCompanyOwners(companyId) { return [...state.members.values()].filter((member) => member.companyId === companyId && member.role === "owner").length; },
    async createCompanyInvite(input) {
      state.invites += 1;
      return { ...input, createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z") } as CompanyInvite;
    },
    async findCompanyInviteByTokenHash() { return null; },
    async acceptCompanyInvite() { throw new Error("not used"); },
    async updateCompanyMemberRole(input) {
      state.roleUpdates += 1;
      revision += 1;
      const existing = state.members.get(`${input.companyId}:${input.userId}`)!;
      const next = { ...existing, role: input.role, revision };
      state.members.set(`${input.companyId}:${input.userId}`, next);
      return next;
    },
    async removeCompanyMember(input) { state.members.delete(`${input.companyId}:${input.userId}`); },
  };
  return {
    service: new CodeMembershipService({ store, audit: { record: async (entry) => { audit.push(entry as MembershipHarness["audit"][number]); } } }),
    state,
    audit,
  };
}

const actor = (userId: string) => ({ userId, companyId: COMPANY });

describe("security-gate: C5a membership — an admin cannot mint an owner (D4)", () => {
  const seed: Array<{ userId: string; role: CompanyRole }> = [
    { userId: "u-owner", role: "owner" },
    { userId: "u-admin", role: "admin" },
    { userId: "u-dev", role: "developer" },
  ];

  it("refuses an owner invite and an admin invite from an admin, and keeps the journal", async () => {
    const harness = membershipHarness(seed);
    const ownerInvite = await refusal(harness.service.invite(actor("u-admin"), COMPANY, { email: "x@example.com", role: "owner", token: "token-0123456789abcdef" }));
    expect(ownerInvite?.code).toBe("owner_role_requires_owner");
    expect(ownerInvite?.httpStatus).toBe(403);
    const adminInvite = await refusal(harness.service.invite(actor("u-admin"), COMPANY, { email: "x@example.com", role: "admin", token: "token-0123456789abcdef" }));
    expect(adminInvite?.code).toBe("admin_role_requires_owner");
    expect(adminInvite?.httpStatus).toBe(403);
    expect(harness.state.invites).toBe(0);
    expect(harness.audit.map((entry) => entry.action)).toEqual(["code.membership.invite.denied", "code.membership.invite.denied"]);
    expect(harness.audit.every((entry) => entry.decision === "deny")).toBe(true);
  });

  it("refuses an admin promoting a developer to owner, and lets an admin manage developer/reviewer", async () => {
    const harness = membershipHarness(seed);
    const promote = await refusal(harness.service.updateRole(actor("u-admin"), COMPANY, { userId: "u-dev", role: "owner", expectedRevision: 1 }));
    expect(promote?.code).toBe("owner_role_requires_owner");
    expect(harness.state.roleUpdates).toBe(0);

    const demote = await harness.service.updateRole(actor("u-admin"), COMPANY, { userId: "u-dev", role: "reviewer", expectedRevision: 1 });
    expect(demote.role).toBe("reviewer");

    // An owner may do both.
    const ownerPromote = await harness.service.updateRole(actor("u-owner"), COMPANY, { userId: "u-dev", role: "owner", expectedRevision: 2 });
    expect(ownerPromote.role).toBe("owner");
  });

  it("refuses an admin removing an owner", async () => {
    const harness = membershipHarness([
      { userId: "u-owner", role: "owner" },
      { userId: "u-owner-2", role: "owner" },
      { userId: "u-admin", role: "admin" },
    ]);
    const failure = await refusal(harness.service.removeMember(actor("u-admin"), COMPANY, "u-owner-2"));
    expect(failure?.code).toBe("owner_role_requires_owner");
    expect(harness.state.members.has(`${COMPANY}:u-owner-2`)).toBe(true);
  });

  it("classifies a human named `u-agent-manager` as a user, and an `agent:` principal as an agent (D10)", async () => {
    const harness = membershipHarness([
      { userId: "u-owner", role: "owner" },
      { userId: "u-agent-manager", role: "admin" },
    ]);
    // The old substring test (`includes("agent-")`) refused this manager outright.
    const invited = await harness.service.invite(actor("u-agent-manager"), COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" });
    expect(invited.role).toBe("developer");
    expect(harness.state.invites).toBe(1);

    const agentFailure = await refusal(harness.service.invite(actor("agent:runner-1"), COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" }));
    expect(agentFailure?.code).toBe("agent_cannot_change_policy");
    const serviceFailure = await refusal(harness.service.invite({ userId: "u-x", externalSubject: "service:automation:1" }, COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" }));
    expect(serviceFailure?.code).toBe("agent_cannot_change_policy");
  });

  it("audits a refused management attempt and stays fail-closed without a journal (D7)", async () => {
    const harness = membershipHarness([{ userId: "u-owner", role: "owner" }]);
    const stranger = await refusal(harness.service.invite(actor("u-stranger"), COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" }));
    expect(stranger?.code).toBe("membership_manage_forbidden");
    expect(harness.audit.map((entry) => entry.action)).toEqual(["code.membership.invite.denied"]);

    // No journal at all: the refusal is unchanged (it is already a deny) and nothing else happens.
    const withoutJournal = new CodeMembershipService({
      store: {
        getCompanyMembership: async () => null,
        countCompanyOwners: async () => 1,
      } as unknown as CodeMembershipStore,
    });
    const failure = await refusal(withoutJournal.listMembers(actor("u-stranger"), COMPANY));
    expect(failure?.code).toBe("membership_manage_forbidden");
  });
});

// ---------------------------------------------------------------------------------------------
// D7: project trust denials are journalled
// ---------------------------------------------------------------------------------------------

describe("security-gate: C5a project trust — a refused trust change is journalled (D7)", () => {
  it("records a denied entry before any change, without repository content or secrets", async () => {
    const events: string[] = [];
    const audit: Array<Record<string, unknown>> = [];
    const writes: Array<Record<string, unknown>> = [];
    const service = new CodeProjectTrustService({
      store: {
        getProjectCodeTrust: async () => null,
        setProjectCodeTrust: async (_ctx: unknown, _companyId: string, _projectId: string, input: Record<string, unknown>) => {
          events.push("write");
          writes.push(input);
          return input as never;
        },
      } as never,
      audit: {
        record: async (entry) => {
          events.push(`audit:${(entry as { action: string }).action}`);
          audit.push(entry as unknown as Record<string, unknown>);
        },
      },
    });

    const failure = await refusal(service.trust(context("developer", "u-dev", ["workspace:read", "workspace:write"]), COMPANY, PROJECT, { expectedRevision: 0 }));
    expect(failure?.code).toBe("code_trust_admin_required");
    expect(failure?.httpStatus).toBe(403);

    // The journal entry is the essential fact, and it carries no repository content: an audit record must
    // never become a second copy of a command, a file, a diff or a secret.
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "code.project.trust.denied", decision: "deny", companyId: COMPANY, resourceType: "code_project", resourceId: PROJECT });
    const entry = audit[0]!;
    for (const forbidden of ["command", "content", "diff", "path", "paths", "file", "files", "patch", "token", "secret", "password"]) {
      expect(entry, `the denial entry must not carry ${forbidden}`).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(entry)).not.toMatch(/secret|password|token/i);
    // Ordering: the denial was journalled, and the write path was never reached at all.
    expect(events).toEqual(["audit:code.project.trust.denied"]);
    expect(writes).toEqual([]);

    // The same service, an owner: the journal entry precedes the store write, so the ordering above is
    // about the flow and not about "nothing was written because nothing happened".
    await service.trust(context("owner", "u-owner"), COMPANY, PROJECT, { expectedRevision: 0, reason: "reviewed" });
    expect(events).toEqual(["audit:code.project.trust.denied", "audit:code.project.trust", "write"]);
    expect(writes).toHaveLength(1);

    // An unavailable journal must not change the refusal, and must not throw a different error.
    const withoutJournal = new CodeProjectTrustService({
      store: { getProjectCodeTrust: async () => null, setProjectCodeTrust: async () => ({} as never) } as never,
    });
    expect((await refusal(withoutJournal.trust(context("developer", "u-dev"), COMPANY, PROJECT, { expectedRevision: 0 })))?.code)
      .toBe("code_trust_admin_required");
  });
});

// ---------------------------------------------------------------------------------------------
// D3: privileged permissions are never implied
// ---------------------------------------------------------------------------------------------

describe("security-gate: C5a RBAC — a wildcard never reaches a privileged permission (D3)", () => {
  it("keeps every privileged permission out of a role that only holds admin:all", () => {
    const registry = createRoleRegistry({ roles: { owner: ["admin:all", "workspace:write"] } });
    const permissions = registry.permissionsForRole("owner");
    expect(permissions).toEqual(["admin:all", "workspace:write"]);
    for (const privileged of CODE_PRIVILEGED_PERMISSIONS) {
      expect(permissions, `admin:all must not grant ${privileged}`).not.toContain(privileged);
    }
  });

  it("expands `*` into the ordinary vocabulary but filters the privileged one out", () => {
    const registry = createRoleRegistry({ roles: { everything: ["*"] } });
    const permissions = registry.permissionsForRole("everything");
    // The wildcard does widen ordinary permissions (that is what it means) ...
    expect(permissions).toContain("workspace:write");
    expect(permissions).toContain("audit:read");
    // ... and the filter is what keeps the privileged half out of that expansion.
    for (const privileged of CODE_PRIVILEGED_PERMISSIONS) {
      expect(permissions, `* must not grant ${privileged}`).not.toContain(privileged);
    }
    expect(permissions).not.toContain("code.prod.operate");
  });

  it("still returns a privileged permission a role names explicitly, and step-up trusts only that", () => {
    const named = createRoleRegistry({ roles: { platform: ["admin:all", "code.prod.operate"] } });
    expect(named.permissionsForRole("platform")).toContain("code.prod.operate");

    const wildcardOnly = createRoleRegistry({ roles: { owner: ["admin:all", "*"] } });
    expect(holdsProductionPermission(owner, wildcardOnly)).toBe(false);
    const byName = createRoleRegistry({ roles: { owner: ["admin:all", "code.prod.operate"] } });
    expect(holdsProductionPermission({ ...owner, role: "owner" } as AuthContext, byName)).toBe(true);
  });
});

describe("security-gate: C5a protected branches — the shell runtime reaches the same gate (D9)", () => {
  it("refuses a protected push and never calls the sandbox, while an unprotected push still needs approval", async () => {
    const executed: string[] = [];
    const sandbox = {
      async execute(input: { command: string }) {
        executed.push(input.command);
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
    };
    const runtime = new CodeShellRuntime({ sandbox, policy: engineHarness(protectedBranchService()).engine });
    const base = { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, toolCallId: "call-1", sessionMode: "full_auto_sandbox" as const };

    const protectedPush = await refusal(runtime.exec(owner, { ...base, command: "git push origin main", approved: true, approvalId: "approval-1" } as never));
    expect(protectedPush?.code).toBe("protected_branch_write_denied");
    expect(protectedPush?.httpStatus).toBe(403);
    expect(executed).toEqual([]);

    const unprotectedPush = await refusal(runtime.exec(owner, { ...base, command: "git push origin feature/topic" } as never));
    expect(unprotectedPush?.code).toBe("approval_required");
    expect(executed).toEqual([]);

    const readOnly = await runtime.exec(owner, { ...base, command: "git status" } as never);
    expect(readOnly.risk).toBe("safe");
    expect(executed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// D11: the required permission is derived from the action
// ---------------------------------------------------------------------------------------------

describe("security-gate: C5a RBAC — the action decides the permission (D11)", () => {
  const rbacAudit = () => ({ record: async () => undefined });

  it("refuses a pair whose permission does not match the action", async () => {
    const rbac = new CodeRbac({ audit: rbacAudit() });
    const failure = await refusal(
      rbac.authorize(principal({ role: "owner", permissions: ["admin:all"] }), COMPANY, {
        permission: "workspace:read",
        action: "code.flags.change",
      }),
    );
    expect(failure?.code).toBe("permission_action_mismatch");
    expect(failure?.httpStatus).toBe(403);
    expect(failure?.details).toMatchObject({ expected: "business:manage", provided: "workspace:read" });
  });

  it("refuses an action that has no mapped permission", async () => {
    const rbac = new CodeRbac({ audit: rbacAudit() });
    const failure = await refusal(
      rbac.authorize(principal({ role: "owner", permissions: ["admin:all"] }), COMPANY, {
        permission: "workspace:write",
        action: "code.made.up",
      }),
    );
    expect(failure?.code).toBe("action_not_mapped");
    expect(failure?.httpStatus).toBe(403);
    expect(failure?.details).toMatchObject({ actionMapped: false });
  });

  it("allows the correct pair for every category, and only that pair", async () => {
    const rbac = new CodeRbac({ audit: rbacAudit() });
    const ownerCtx = principal({ role: "owner", permissions: ["admin:all"] });
    const developer = principal({ role: "developer", permissions: ["workspace:read", "workspace:write", "tools:execute"] });
    const cases: Array<[string, ReturnType<typeof principal>, string]> = [
      ["workspace:write", developer, "code.fs.edit"],
      ["workspace:read", developer, "code.fs.read"],
      ["workspace:write", developer, "code.shell.exec"],
      ["tools:execute", developer, "code.verify.run"],
      ["business:manage", ownerCtx, "code.flags.change"],
      ["business:manage", ownerCtx, "code.membership.invite"],
      ["business:manage", ownerCtx, "code.protected_branches.update"],
      ["business:manage", ownerCtx, "code.project.trust"],
    ];
    for (const [permission, ctx, action] of cases) {
      expect(await rbac.authorize(ctx, COMPANY, { permission, action }), `${permission}/${action}`).toMatchObject({ allowed: true, permission, action });
      // The same action with a label that is not the required permission is refused, so the allowance
      // above comes from the action and not from the label the caller chose.
      expect((await refusal(rbac.authorize(ctx, COMPANY, { permission: "admin:all", action })))?.code, action).toBe("permission_action_mismatch");
    }
    expect(requiredPermissionForAction("code.verify.run")).toBe("tools:execute");
    expect(requiredPermissionForAction("code.prod.operate")).toBe("code.prod.operate");
    expect(requiredPermissionForAction("")).toBe(null);
  });

  it("keeps the privileged invariants intact for a correct production pair", async () => {
    const rbac = new CodeRbac({ audit: rbacAudit() });
    const production = { permission: "code.prod.operate", action: "code.deploy.production", production: true } as const;
    // A wildcard role never reaches the privileged permission, correct pair or not.
    const wildcardOwner = principal({ role: "owner", permissions: ["admin:all", "*"] });
    expect((await refusal(rbac.authorize(wildcardOwner, COMPANY, production)))?.code).toBe("production_permission_required");
    // A role that names the permission explicitly passes — and the gate reports it as privileged.
    const named = createRoleRegistry({ roles: { owner: ["admin:all", "code.prod.operate"] } });
    await expect(new CodeRbac({ registry: named, audit: rbacAudit() }).authorize(principal({ role: "owner" }), COMPANY, production))
      .resolves.toMatchObject({ allowed: true, privileged: true });
    // A service identity is refused by the principal invariant before any permission is considered.
    const service = principal({ userId: "u-owner", externalSubject: "service:automation:1", role: "owner", permissions: ["admin:all", "code.prod.operate"] });
    expect((await refusal(new CodeRbac({ registry: named, audit: rbacAudit() }).authorize(service, COMPANY, production)))?.code)
      .toBe("service_identity_cannot_operate_production");
    // A mismatched privileged pair is refused even for a principal that holds the named permission.
    expect((await refusal(new CodeRbac({ registry: named, audit: rbacAudit() }).authorize(principal({ role: "owner" }), COMPANY, {
      permission: "workspace:write",
      action: "code.deploy.production",
      production: true,
    })))?.code).toBe("permission_action_mismatch");
  });
});

// ---------------------------------------------------------------------------------------------
// Standing rules: where they are actually consulted
// ---------------------------------------------------------------------------------------------

describe("security-gate: C5a approval scope — a standing rule is consulted only in the approval phase", () => {
  it("is inert for the file actions the allowlist names, and live for a shell command", async () => {
    const queried: string[] = [];
    const harness = engineHarness(protectedBranchService(), {
      approvalRules: {
        async findRule(_ctx, query) {
          queried.push(query.action);
          return { id: "rule-1", scope: "project" };
        },
      },
    });
    // `code.fs.edit/write/move` and `code.verify.run` are not approval-gated: they carry no command and
    // no `requiresConfirmation`, so `requireApproval` (the only reader of `approvalRules`) is never
    // reached for them and a standing rule for them could not change anything.
    for (const tool of ["code.fs.edit", "code.fs.write", "code.fs.move", "code.verify.run"]) {
      const result = await harness.engine.evaluate({ ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, tool, sessionMode: "auto_edit" });
      expect(result.decision, tool).toBe("allow");
    }
    expect(queried).toEqual([]);
    // A shell command in the approval class does go through the rule lookup — that is the observable
    // effect of a standing allowlist (and not an automatic allow without a rule).
    const shell = await harness.engine.evaluate(pushRequest(owner, "git push origin feature/topic"));
    expect(shell).toMatchObject({ decision: "allow", reasons: expect.arrayContaining(["approval:rule:project"]) });
    expect(queried).toEqual(["code.shell.exec:git:push"]);
  });
});

// ---------------------------------------------------------------------------------------------
// G1 (D14): `PUT …/code/protected-branches` — the route was covered by no test at all
// ---------------------------------------------------------------------------------------------

interface RegisteredRoute {
  method: string;
  url: string;
  handler: (request: never, reply: never) => Promise<unknown>;
}

/**
 * A stand-in for the Fastify instance that only records registrations. The membership surface registers
 * every route as `(url, handler)`, so the two-argument form is the one that matters; a route registered
 * without a handler is a hard error instead of a test that silently calls nothing.
 */
function routeRecorder(routes: RegisteredRoute[]): FastifyInstance {
  const record = (method: string) => (url: string, ...rest: unknown[]) => {
    const handler = [...rest].reverse().find((candidate) => typeof candidate === "function") as RegisteredRoute["handler"] | undefined;
    if (!handler) throw new Error(`${method} ${url} was registered without a handler`);
    routes.push({ method, url, handler });
    return undefined;
  };
  return { get: record("get"), post: record("post"), patch: record("patch"), put: record("put"), delete: record("delete") } as unknown as FastifyInstance;
}

interface ReplyState { status: number; body: unknown }

function routeReply(): { reply: unknown; state: ReplyState } {
  const state: ReplyState = { status: 200, body: undefined };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    status(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply, state };
}

/**
 * The real route over the real gate (`authorizeCompanyAction` → `authorizeCodeAction`), with only the two
 * services stubbed: the membership resolver (roles are its business, tested in its own suite) and the
 * protected-branch policy service (which records what the route really asked it to do). The journal is a
 * spy, because the RBAC gate refuses without one and its entries are part of the evidence here.
 */
function protectedBranchRouteHarness(getContext: () => AuthContext | null, roles: Record<string, string | null> = { "u-owner": "owner", "u-dev": "developer" }) {
  const routes: RegisteredRoute[] = [];
  const updates: Array<{ companyId: string; body: Record<string, unknown>; actor: string }> = [];
  const resolveCalls: string[] = [];
  const audit: Array<{ action: string; decision?: string; metadata?: Record<string, unknown> }> = [];
  const service = {
    async resolveRoleForUser(ctx: AuthContext) {
      resolveCalls.push(String(ctx.userId ?? ""));
      return roles[String(ctx.userId ?? "")] ?? null;
    },
  } as unknown as CodeMembershipService;
  const protectedBranches = {
    async getPolicy() { return { branches: ["main"], revision: 1 }; },
    async updatePolicy(ctx: AuthContext, companyId: string, body: Record<string, unknown>) {
      updates.push({ companyId, body, actor: String(ctx.userId ?? "") });
      return { branches: body.branches ?? ["main"], revision: 2 };
    },
    effectiveGuard: "policy",
  } as unknown as CodeProtectedBranchService;
  return registerCodeMembershipRoutes(routeRecorder(routes), {
    service,
    protectedBranches,
    getAuthContext: () => getContext(),
    audit: { record: async (entry) => { audit.push(entry as (typeof audit)[number]); } },
  }).then(() => {
    const put = routes.find((route) => route.method === "put" && route.url.endsWith("/code/protected-branches"));
    if (!put) throw new Error("the protected-branches PUT route was not registered");
    return { put, updates, resolveCalls, audit };
  });
}

describe("security-gate: C5a protected branches — the update route is a user-only policy change (G1/D14)", () => {
  const policyMutation = { branches: ["main", "production"], expectedRevision: 1 };

  it("lets an owner change the policy, forwards the raw body and journals the allow", async () => {
    const harness = await protectedBranchRouteHarness(() => context("owner", "u-owner"));
    const { reply, state } = routeReply();
    await harness.put.handler({ params: { companyId: COMPANY }, body: policyMutation } as never, reply as never);

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ apiVersion: "v1", policy: { revision: 2, branches: ["main", "production"] } });
    // The administrative body is forwarded as-is: the policy service is the component that rejects an
    // unexpected key (`branches`, `expectedRevision`, `challengeId` only), not the route.
    expect(harness.updates).toEqual([{ companyId: COMPANY, body: policyMutation, actor: "u-owner" }]);
    expect(harness.audit.map((entry) => entry.action)).toEqual(["code.rbac.allow"]);
  });

  it("refuses an agent and a service principal with agent_cannot_change_policy, before the role or the policy is touched", async () => {
    const agent = context("owner", "agent:runner-1", ["workspace:read", "workspace:write", "business:manage", "admin:all", "owner"]);
    const serviceIdentity: AuthContext = {
      workspaceId: "ws-1",
      companyId: COMPANY,
      userId: "u-internal",
      externalSubject: "service:automation:1",
      permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all", "owner"],
      role: "owner",
    } as unknown as AuthContext;

    for (const principalContext of [agent, serviceIdentity]) {
      const harness = await protectedBranchRouteHarness(() => principalContext);
      const { reply, state } = routeReply();
      await harness.put.handler({ params: { companyId: COMPANY }, body: policyMutation } as never, reply as never);

      // `policyChange: true` is what produces this code rather than a generic permission miss, so the
      // refusal names the reason: an agent may never change a policy, whatever permissions it was given.
      expect(state.status).toBe(403);
      expect(state.body).toMatchObject({ error: { code: "agent_cannot_change_policy", retryable: false } });
      expect(harness.updates).toEqual([]);
      // The role is never even resolved, so a membership row cannot become the thing that authorizes it.
      expect(harness.resolveCalls).toEqual([]);
      expect(harness.audit.map((entry) => entry.action)).toEqual(["code.rbac.deny"]);
    }
  });

  it("refuses an unauthenticated caller, and a human member without the permission", async () => {
    // The `Bearer`-less / unresolvable-token case: the context accessor answers `null` and the route refuses
    // before anything else. `authorizeCompanyAction` is never reached.
    const anonymous = await protectedBranchRouteHarness(() => null);
    const anonymousReply = routeReply();
    await anonymous.put.handler({ params: { companyId: COMPANY }, body: policyMutation } as never, anonymousReply.reply as never);
    expect(anonymousReply.state.status).toBe(401);
    expect(anonymousReply.state.body).toMatchObject({ error: { code: "unauthorized" } });
    expect(anonymous.updates).toEqual([]);
    expect(anonymous.audit).toEqual([]);

    // A real developer: authenticated, a member of the company, and still not allowed to move a policy.
    const developer = await protectedBranchRouteHarness(() => context("developer", "u-dev", ["workspace:read", "workspace:write"]));
    const developerReply = routeReply();
    await developer.put.handler({ params: { companyId: COMPANY }, body: policyMutation } as never, developerReply.reply as never);
    expect(developerReply.state.status).toBe(403);
    expect(developerReply.state.body).toMatchObject({ error: { code: "permission_denied" } });
    expect(developer.updates).toEqual([]);
    expect(developer.audit.map((entry) => entry.action)).toEqual(["code.rbac.deny"]);

    // A human with no membership row at all has no role, and no role means no permission.
    const stranger = await protectedBranchRouteHarness(() => context("owner", "u-stranger", ["admin:all"]));
    const strangerReply = routeReply();
    await stranger.put.handler({ params: { companyId: COMPANY }, body: policyMutation } as never, strangerReply.reply as never);
    expect(strangerReply.state.status).toBe(403);
    expect(strangerReply.state.body).toMatchObject({ error: { code: "permission_denied" } });
    expect(stranger.updates).toEqual([]);
  });

  it("still serves the GET policy read to a member, so the route pair is not simply closed", async () => {
    // The negative control for the refusals above: the same harness, the same gates, one route that a
    // developer *may* use — so "everything is refused" is not what makes the PUT cases pass.
    const routes: RegisteredRoute[] = [];
    const developer = context("developer", "u-dev", ["workspace:read"]);
    await registerCodeMembershipRoutes(routeRecorder(routes), {
      service: { resolveRoleForUser: async () => "developer" } as unknown as CodeMembershipService,
      protectedBranches: { getPolicy: async () => ({ branches: ["main"], revision: 1 }), updatePolicy: async () => ({}) } as unknown as CodeProtectedBranchService,
      getAuthContext: () => developer,
      audit: { record: async () => undefined },
    });
    const get = routes.find((route) => route.method === "get" && route.url.endsWith("/code/protected-branches"));
    if (!get) throw new Error("the protected-branches GET route was not registered");
    const { reply, state } = routeReply();
    await get.handler({ params: { companyId: COMPANY } } as never, reply as never);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ policy: { revision: 1 }, defaults: [...DEFAULT_PROTECTED_BRANCHES] });
  });
});
