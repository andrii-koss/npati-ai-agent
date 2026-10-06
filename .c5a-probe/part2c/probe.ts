/**
 * C5a part 2C local probe (verification aid, not a deliverable).
 *
 * `vitest` cannot start in this sandbox (esbuild's service binary is blocked: `spawn EPERM`), so the
 * assertions of `tests/coding-agent-c5a-protected-branches.test.ts` are replayed directly against the
 * shipped modules:
 *
 *   node --experimental-transform-types --import ./.c5a-probe/part2b/register.mjs .c5a-probe/part2c/probe.ts
 *
 * Every line printed with `ok` is an assertion that passed; a failure throws and exits non-zero.
 */
import assert from "node:assert/strict";
import type { AuthContext, CodeSession, CodeSessionMode } from "@npati/workspace";
import { PolicyEngine, type PolicyEngineDeps, type PolicyRequest } from "../../apps/agent-api/src/code-policy-engine";
import { classifyShellCommand, detectGitWriteAttempts } from "../../apps/agent-api/src/code-shell-classifier";
import {
  CodeProtectedBranchRepository,
  CodeProtectedBranchService,
  DEFAULT_PROTECTED_BRANCHES,
  type CodeProtectedBranchStore,
} from "../../apps/agent-api/src/code-protected-branches";
import {
  CODE_CANONICAL_SESSION_MODES,
  CODE_PRIVILEGED_PERMISSIONS,
  CodeRbac,
  createRoleRegistry,
  requiredPermissionForAction,
} from "../../apps/agent-api/src/code-rbac";
import { CodeSessionModeService, resolveSessionMode } from "../../apps/agent-api/src/code-session-mode-routes";
import {
  CodeMembershipService,
  type CodeMembershipStore,
  type CompanyInvite,
  type CompanyMember,
  type CompanyRole,
} from "../../apps/agent-api/src/code-membership";
import { CodeProjectTrustService } from "../../apps/agent-api/src/code-project-trust";
import { CodeShellRuntime } from "../../apps/agent-api/src/code-shell-runtime";
import { holdsProductionPermission } from "../../apps/agent-api/src/code-step-up";

let passed = 0;
function ok(label: string, condition: boolean, extra?: unknown) {
  if (!condition) throw new Error(`FAILED: ${label}${extra === undefined ? "" : ` (${JSON.stringify(extra)})`}`);
  passed += 1;
  console.log(`ok ${passed} — ${label}`);
}

function matches(label: string, actual: unknown, expected: Record<string, unknown>) {
  const value = actual as Record<string, unknown>;
  for (const [key, want] of Object.entries(expected)) {
    if (!Object.is(value?.[key], want)) {
      throw new Error(`FAILED: ${label} — expected ${key}=${JSON.stringify(want)}, got ${JSON.stringify(value?.[key])}`);
    }
  }
  passed += 1;
  console.log(`ok ${passed} — ${label}`);
}

async function refusal(action: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await action();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("expected a refusal, but the call resolved");
}

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";
const TOOL_IDS = ["code.shell.exec", "code.fs.read", "code.fs.write", "code.fs.edit", "code.fs.move", "code.verify.run", "code.fs.delete", "code.deps.add"];

function context(role: string | null, userId: string, permissions: string[] = ["workspace:read", "workspace:write", "admin:all"]): AuthContext {
  return { workspaceId: "ws-1", companyId: COMPANY, userId, permissions, role } as unknown as AuthContext;
}

const owner = context("owner", "u-owner");
const agentPrincipal = {
  workspaceId: "ws-1", companyId: COMPANY, userId: "agent:runner-1", externalSubject: "agent:runner-1",
  permissions: ["workspace:read", "workspace:write"], role: "owner",
} as unknown as AuthContext;

function protectedBranchService(store?: CodeProtectedBranchStore): CodeProtectedBranchService {
  return new CodeProtectedBranchService({
    store: store ?? new CodeProtectedBranchRepository(),
    resolveRole: async (ctx) => (String(ctx.userId) === "u-owner" ? "owner" : String(ctx.userId) === "u-dev" ? "developer" : null),
    audit: { record: async () => undefined },
  });
}

function engineHarness(policy: CodeProtectedBranchService, overrides: Partial<PolicyEngineDeps> = {}) {
  const approvals = { requested: [] as Array<Record<string, unknown>>, consumed: [] as Array<unknown> };
  const deps: PolicyEngineDeps = {
    flags: { async assertEnabled() { return true; } },
    capabilities: { get: (id: string) => (TOOL_IDS.includes(id) ? { id, status: "active", version: 1 } : undefined) },
    classifier: (command: string) => classifyShellCommand(command),
    approvals: {
      async requestApproval(_ctx, _companyId, input) { approvals.requested.push(input); return { id: `approval-${approvals.requested.length}` }; },
      async consumeApproved(_ctx, _companyId, id) { approvals.consumed.push(id); return { id }; },
    },
    networkEnforcement: () => true,
    protectedBranches: policy,
    ...overrides,
  };
  return { engine: new PolicyEngine(deps), approvals, policy };
}

function pushRequest(ctx: AuthContext, command: string, extra: Partial<PolicyRequest> = {}): PolicyRequest {
  return { ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, tool: "code.shell.exec", command, sessionMode: "full_auto_sandbox", ...extra };
}

// ---------------------------------------------------------------------------------------------
// D9 — the company protected-branch policy decides the push
// ---------------------------------------------------------------------------------------------

const policy = protectedBranchService();
await policy.updatePolicy(owner, COMPANY, { branches: ["production", "release"], expectedRevision: 0 });
{
  const harness = engineHarness(policy);
  const protectedPush = await harness.engine.evaluate(pushRequest(owner, "git push origin production"));
  matches("D9: a push into the company-protected branch is a hard deny", protectedPush, { decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny", status: 403 });
  ok("D9: the refusal names the branch", protectedPush.reasons.join(" ").includes("production"));
  const unprotected = await harness.engine.evaluate(pushRequest(owner, "git push origin main"));
  matches("D9: main is NOT protected once the company policy replaces the default list (proves the company list is read)", unprotected, { decision: "require_approval", phase: "approval" });
  ok("D9: exactly one approval was requested for the unprotected push", harness.approvals.requested.length === 1);
}

{
  const harness = engineHarness(protectedBranchService());
  const ownerPush = await harness.engine.evaluate(pushRequest(owner, "git push origin main", { approved: true, approvalId: "approval-1" }));
  matches("D9: the owner with admin:all in full_auto_sandbox with approved:true is denied", ownerPush, { decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny", status: 403 });
  ok("D9: the denial is not retryable", ownerPush.retryable === false);
  const agentClaim = await harness.engine.evaluate(pushRequest(agentPrincipal, "git push origin main", { approved: true, approvalId: "approval-1" }));
  matches("D9: an agent claiming an approval is refused even earlier (rbac)", agentClaim, { decision: "deny", code: "agent_cannot_approve", phase: "rbac" });
  const agentPlain = await harness.engine.evaluate(pushRequest(agentPrincipal, "git push origin main"));
  matches("D9: an agent push is protected_branch_write_denied", agentPlain, { code: "protected_branch_write_denied", phase: "hard_deny" });
  ok("D9: no approval was requested", harness.approvals.requested.length === 0);
  ok("D9: no approval was consumed", harness.approvals.consumed.length === 0);
}

{
  const forcePolicy = protectedBranchService();
  await forcePolicy.updatePolicy(owner, COMPANY, { branches: ["trunk"], expectedRevision: 0 });
  const harness = engineHarness(forcePolicy);
  matches("D9: a force push into a company-protected branch is force_push_denied", await harness.engine.evaluate(pushRequest(owner, "git push --force origin trunk", { approved: true, approvalId: "approval-1" })), { decision: "deny", code: "force_push_denied", phase: "hard_deny" });
  matches("D9: -f is the same operation", await harness.engine.evaluate(pushRequest(owner, "git push -f origin trunk")), { code: "force_push_denied" });
  matches("D9: the +refspec form is the same operation", await harness.engine.evaluate(pushRequest(owner, "git push origin +trunk")), { code: "force_push_denied" });
  const unprotectedForce = await harness.engine.evaluate(pushRequest(owner, "git push --force origin feature/topic"));
  matches("D9: a force push into an unprotected branch stays an approval", unprotectedForce, { decision: "require_approval", code: "approval_required" });
  ok("D9: no approval consumed by the force push cases", harness.approvals.consumed.length === 0);
}

{
  const harness = engineHarness(protectedBranchService());
  for (const sessionMode of ["edit", "auto", "auto_edit", "full_auto", "full_auto_sandbox"] as const) {
    const result = await harness.engine.evaluate(pushRequest(owner, "git push origin feature/topic", { sessionMode }));
    matches(`D9: a push into an unprotected branch stays an approval (${sessionMode})`, result, { decision: "require_approval", code: "approval_required" });
  }
  matches("D9: plan denies the approval class", await harness.engine.evaluate(pushRequest(owner, "git push origin feature/topic", { sessionMode: "plan" })), { decision: "deny", code: "session_mode_denied" });
}

{
  const broken: CodeProtectedBranchStore = {
    async get() { throw new Error("store down"); },
    async save() { throw new Error("store down"); },
  };
  const brokenPolicy = protectedBranchService(broken);
  const harness = engineHarness(brokenPolicy);
  matches("D9: an unreadable policy falls back to the built-in main default", await harness.engine.evaluate(pushRequest(owner, "git push origin main")), { decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny" });
  ok("D9: the built-in default list is main/master/release", JSON.stringify(DEFAULT_PROTECTED_BRANCHES) === JSON.stringify(["main", "master", "release"]));
  matches("D9: a branch outside the default is still only an approval", await harness.engine.evaluate(pushRequest(owner, "git push origin feature/topic")), { decision: "require_approval" });
  const changeFailure = await refusal(() => brokenPolicy.updatePolicy(owner, COMPANY, { branches: ["trunk"], expectedRevision: 0 }));
  matches("D9: changing the policy with an unreadable store is 503", changeFailure, { code: "protected_branches_store_unavailable", httpStatus: 503, retryable: true });
}

{
  const harness = engineHarness(protectedBranchService());
  const sneaky = { ...pushRequest(owner, "git push origin main"), protectedBranches: [], protected_branches: [], options: { protectedBranches: [] } } as unknown as PolicyRequest;
  matches("D9: a caller-supplied protectedBranches field cannot relax the decision", await harness.engine.evaluate(sneaky), { decision: "deny", code: "protected_branch_write_denied" });
}

{
  const harness = engineHarness(protectedBranchService(), {
    protectedBranches: { evaluateGitWrite: async () => { throw new Error("policy exploded"); } },
  });
  matches("D9: a failing policy port fails closed", await harness.engine.evaluate(pushRequest(owner, "git push origin main")), { decision: "deny", code: "protected_branch_policy_unavailable", phase: "hard_deny", status: 503 });
}

{
  const cases: Array<[string, Array<{ operation: string; branch: string }>]> = [
    ["git push origin main", [{ operation: "push", branch: "main" }]],
    ["git push --force origin refs/heads/release", [{ operation: "force_push", branch: "release" }]],
    ["git push origin HEAD:main", [{ operation: "push", branch: "main" }]],
    ["git push origin :main", [{ operation: "push", branch: "main" }]],
    ["git push origin +main", [{ operation: "force_push", branch: "main" }]],
    ["cd /workspace && git -C /workspace push origin master", [{ operation: "push", branch: "master" }]],
    ["git push origin main feature/x", [{ operation: "push", branch: "main" }, { operation: "push", branch: "feature/x" }]],
    ["git push", [{ operation: "push", branch: "" }]],
    ["git status", []],
    ["git commit -m 'push the fix'", []],
  ];
  for (const [command, expected] of cases) {
    ok(`D9 parser: ${command}`, JSON.stringify(detectGitWriteAttempts(command)) === JSON.stringify(expected), detectGitWriteAttempts(command));
  }
  ok("D9 classifier: force push into a default-protected branch is hard_deny", classifyShellCommand("git push --force origin main").risk === "hard_deny");
  ok("D9 classifier: force push into an unprotected branch is not", classifyShellCommand("git push --force origin prod").risk !== "hard_deny");
  ok("D9 classifier: the protected list is an option", classifyShellCommand("git push --force origin prod", { protectedBranches: ["main", "master", "release", "prod"] }).risk === "hard_deny");
  ok("D9 classifier: a plain push stays an approval (the engine owns the company check)", classifyShellCommand("git push origin main").risk === "approval");
}

// ---------------------------------------------------------------------------------------------
// D6 — session modes
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
    id: SESSION, workspaceId: "ws-1", companyId: COMPANY, projectId: PROJECT, userId: "u-owner", mode: state.mode,
    status: "active", dataClassification: "internal", retentionClass: "standard", revision: state.revision,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
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

ok("D6: the canonical mode vocabulary is plan/ask/auto_edit/full_auto_sandbox", JSON.stringify([...CODE_CANONICAL_SESSION_MODES]) === JSON.stringify(["plan", "ask", "auto_edit", "full_auto_sandbox"]));
matches("D6: full_auto normalises onto full_auto_sandbox", resolveSessionMode("full_auto"), { mode: "full_auto_sandbox", persisted: "full_auto", legacyAlias: true });
matches("D6: the canonical name resolves directly", resolveSessionMode("full_auto_sandbox"), { mode: "full_auto_sandbox", persisted: "full_auto", legacyAlias: false });
matches("D6: edit is the legacy spelling of ask", resolveSessionMode("edit"), { mode: "ask", persisted: "edit" });
matches("D6: auto is the legacy spelling of auto_edit", resolveSessionMode("auto"), { mode: "auto_edit", persisted: "auto" });
ok("D6: an unknown mode is not resolved", resolveSessionMode("yolo") === null);

for (const mode of ["plan", "ask", "auto_edit"]) {
  const harness = modeHarness();
  await harness.service.setMode(context("developer", "u-dev", ["workspace:read", "workspace:write"]), COMPANY, SESSION, { mode, expectedRevision: 3 });
  ok(`D6: a developer may set ${mode}`, harness.audit.length === 1 && harness.audit[0]!.action === "code.session.mode_change" && harness.audit[0]!.metadata?.to === mode);
}
for (const mode of ["full_auto", "full_auto_sandbox"]) {
  const harness = modeHarness();
  const failure = await refusal(() => harness.service.setMode(context("developer", "u-dev", ["workspace:read", "workspace:write"]), COMPANY, SESSION, { mode, expectedRevision: 3 }));
  matches(`D6: a developer may not set ${mode}`, failure, { code: "session_mode_not_permitted", httpStatus: 403 });
  ok(`D6: the refused ${mode} change wrote nothing`, harness.state.updates.length === 0);
  ok(`D6: the refused ${mode} change is audited as denied`, harness.audit.length === 1 && harness.audit[0]!.action === "code.session.mode_change.denied" && harness.audit[0]!.decision === "deny");
}
for (const role of ["owner", "admin"]) {
  const canonical = modeHarness();
  await canonical.service.setMode(context(role, `u-${role}`), COMPANY, SESSION, { mode: "full_auto_sandbox", expectedRevision: 3 });
  ok(`D6: ${role} may set full_auto_sandbox`, canonical.audit[0]!.metadata?.to === "full_auto_sandbox" && canonical.audit[0]!.metadata?.legacyAlias === false);
  ok(`D6: ${role} persists the C1 spelling`, JSON.stringify(canonical.state.updates) === JSON.stringify([{ mode: "full_auto", expectedRevision: 3 }]));
  const legacy = modeHarness();
  await legacy.service.setMode(context(role, `u-${role}`), COMPANY, SESSION, { mode: "full_auto", expectedRevision: 3 });
  ok(`D6: ${role} full_auto is normalised and flagged as legacy`, legacy.audit[0]!.metadata?.to === "full_auto_sandbox" && legacy.audit[0]!.metadata?.requestedMode === "full_auto" && legacy.audit[0]!.metadata?.legacyAlias === true);
}
{
  const reviewer = modeHarness();
  const failure = await refusal(() => reviewer.service.setMode(context("reviewer", "u-rev", ["workspace:read"]), COMPANY, SESSION, { mode: "plan", expectedRevision: 3 }));
  matches("D6: a role with no mode keeps session_mode_admin_required", failure, { code: "session_mode_admin_required" });
  ok("D6: that refusal is audited (D7)", reviewer.audit.length === 1 && reviewer.audit[0]!.action === "code.session.mode_change.denied");

  const unknown = modeHarness();
  const invalid = await refusal(() => unknown.service.setMode(context("owner", "u-owner"), COMPANY, SESSION, { mode: "yolo", expectedRevision: 3 }));
  matches("D6: an unknown mode is invalid_mode 400", invalid, { code: "invalid_mode", httpStatus: 400 });
  ok("D6: a shape error writes no journal entry", unknown.audit.length === 0);

  const agent = modeHarness();
  const denied = await refusal(() => agent.service.setMode(agentPrincipal, COMPANY, SESSION, { mode: "plan", expectedRevision: 3 }));
  matches("D6: an agent is refused", denied, { code: "agent_cannot_change_policy" });
  ok("D6: the agent refusal is audited (D7)", agent.audit.length === 1 && agent.audit[0]!.action === "code.session.mode_change.denied");
  ok("D6: the agent changed nothing", agent.state.updates.length === 0);
}
{
  const registry = createRoleRegistry({ roles: { operator: ["workspace:read"] }, sessionModes: { operator: ["plan", "auto_edit"] } });
  const service = new CodeSessionModeService({
    store: {
      getCodeSession: async () => ({ revision: 3, mode: "plan" }) as unknown as CodeSession,
      updateCodeSession: async () => ({ revision: 4, mode: "auto" }) as unknown as CodeSession,
    } as never,
    audit: { record: async () => undefined },
    registry,
  });
  await service.setMode(context("operator", "u-op", ["workspace:read"]), COMPANY, SESSION, { mode: "auto_edit", expectedRevision: 3 });
  const failure = await refusal(() => service.setMode(context("operator", "u-op", ["workspace:read"]), COMPANY, SESSION, { mode: "full_auto_sandbox", expectedRevision: 3 }));
  matches("D6: the role -> mode map is injected configuration", failure, { code: "session_mode_not_permitted" });
}

// ---------------------------------------------------------------------------------------------
// D4/D7/D10 — company membership
// ---------------------------------------------------------------------------------------------

interface MembershipHarness {
  service: CodeMembershipService;
  state: { members: Map<string, CompanyMember>; invites: number; roleUpdates: number };
  audit: Array<{ action: string; decision?: string }>;
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
    async createCompanyInvite(input) { state.invites += 1; return { ...input, createdAt: new Date() } as CompanyInvite; },
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
const seed: Array<{ userId: string; role: CompanyRole }> = [
  { userId: "u-owner", role: "owner" },
  { userId: "u-admin", role: "admin" },
  { userId: "u-dev", role: "developer" },
];

{
  const harness = membershipHarness(seed);
  const ownerInvite = await refusal(() => harness.service.invite(actor("u-admin"), COMPANY, { email: "x@example.com", role: "owner", token: "token-0123456789abcdef" }));
  matches("D4: an admin cannot invite an owner", ownerInvite, { code: "owner_role_requires_owner", httpStatus: 403 });
  const adminInvite = await refusal(() => harness.service.invite(actor("u-admin"), COMPANY, { email: "x@example.com", role: "admin", token: "token-0123456789abcdef" }));
  matches("D4: an admin cannot invite an admin", adminInvite, { code: "admin_role_requires_owner", httpStatus: 403 });
  ok("D4: no invite was created", harness.state.invites === 0);
  ok("D4/D7: both refusals are audited as denied", harness.audit.length === 2 && harness.audit.every((entry) => entry.action === "code.membership.invite.denied" && entry.decision === "deny"));
}
{
  const harness = membershipHarness(seed);
  const promote = await refusal(() => harness.service.updateRole(actor("u-admin"), COMPANY, { userId: "u-dev", role: "owner", expectedRevision: 1 }));
  matches("D4: an admin cannot promote to owner", promote, { code: "owner_role_requires_owner" });
  ok("D4: the role was not changed", harness.state.roleUpdates === 0);
  const demote = await harness.service.updateRole(actor("u-admin"), COMPANY, { userId: "u-dev", role: "reviewer", expectedRevision: 1 });
  ok("D4: an admin may manage a developer/reviewer", demote.role === "reviewer");
  const ownerPromote = await harness.service.updateRole(actor("u-owner"), COMPANY, { userId: "u-dev", role: "owner", expectedRevision: 2 });
  ok("D4: the owner may hand out the owner role", ownerPromote.role === "owner");
}
{
  const harness = membershipHarness([
    { userId: "u-owner", role: "owner" },
    { userId: "u-owner-2", role: "owner" },
    { userId: "u-admin", role: "admin" },
  ]);
  const failure = await refusal(() => harness.service.removeMember(actor("u-admin"), COMPANY, "u-owner-2"));
  matches("D4: an admin cannot remove an owner", failure, { code: "owner_role_requires_owner" });
  ok("D4: the owner membership survives", harness.state.members.has(`${COMPANY}:u-owner-2`));
}
{
  const harness = membershipHarness([
    { userId: "u-owner", role: "owner" },
    { userId: "u-agent-manager", role: "admin" },
  ]);
  const invited = await harness.service.invite(actor("u-agent-manager"), COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" });
  ok("D10: a human named u-agent-manager is not treated as an agent", invited.role === "developer" && harness.state.invites === 1);
  matches("D10: an agent: principal is refused", await refusal(() => harness.service.invite(actor("agent:runner-1"), COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" })), { code: "agent_cannot_change_policy" });
  matches("D10: a service: subject is refused", await refusal(() => harness.service.invite({ userId: "u-x", externalSubject: "service:automation:1" }, COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" })), { code: "agent_cannot_change_policy" });
}
{
  const harness = membershipHarness([{ userId: "u-owner", role: "owner" }]);
  const stranger = await refusal(() => harness.service.invite(actor("u-stranger"), COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" }));
  matches("D7: a non-member is refused", stranger, { code: "membership_manage_forbidden" });
  ok("D7: the refusal is audited", harness.audit.length === 1 && harness.audit[0]!.action === "code.membership.invite.denied");

  const withoutJournal = new CodeMembershipService({
    store: { getCompanyMembership: async () => null, countCompanyOwners: async () => 1 } as unknown as CodeMembershipStore,
  });
  matches("D7: a missing journal does not change the refusal", await refusal(() => withoutJournal.listMembers(actor("u-stranger"), COMPANY)), { code: "membership_manage_forbidden" });
}

// ---------------------------------------------------------------------------------------------
// D7 — project trust denials
// ---------------------------------------------------------------------------------------------

{
  const audit: Array<{ action: string; decision?: string }> = [];
  const writes: Array<Record<string, unknown>> = [];
  const service = new CodeProjectTrustService({
    store: {
      getProjectCodeTrust: async () => null,
      setProjectCodeTrust: async (_ctx: unknown, _companyId: string, _projectId: string, input: Record<string, unknown>) => { writes.push(input); return input as never; },
    } as never,
    audit: { record: async (entry) => { audit.push(entry as { action: string; decision?: string }); } },
  });
  const failure = await refusal(() => service.trust(context("developer", "u-dev", ["workspace:read", "workspace:write"]), COMPANY, PROJECT, { expectedRevision: 0 }));
  matches("D7: a developer is refused project trust", failure, { code: "code_trust_admin_required" });
  ok("D7: the trust record was not written", writes.length === 0);
  ok("D7: the refusal is journalled as denied", audit.length === 1 && audit[0]!.action === "code.project.trust.denied" && audit[0]!.decision === "deny");

  const withoutJournal = new CodeProjectTrustService({
    store: { getProjectCodeTrust: async () => null, setProjectCodeTrust: async () => ({} as never) } as never,
  });
  matches("D7: an unavailable journal keeps the refusal", await refusal(() => withoutJournal.trust(context("developer", "u-dev"), COMPANY, PROJECT, { expectedRevision: 0 })), { code: "code_trust_admin_required" });
}

// ---------------------------------------------------------------------------------------------
// D3 — privileged permissions are never implied
// ---------------------------------------------------------------------------------------------

{
  const registry = createRoleRegistry({ roles: { owner: ["admin:all", "workspace:write"] } });
  const permissions = registry.permissionsForRole("owner");
  ok("D3: admin:all does not widen the declared set", JSON.stringify(permissions) === JSON.stringify(["admin:all", "workspace:write"]));
  ok("D3: no privileged permission for an admin:all role", CODE_PRIVILEGED_PERMISSIONS.every((privileged) => !permissions.includes(privileged)));

  const everything = createRoleRegistry({ roles: { everything: ["*"] } });
  const wildcard = everything.permissionsForRole("everything");
  ok("D3: `*` widens the ordinary vocabulary", wildcard.includes("workspace:write") && wildcard.includes("audit:read"));
  ok("D3: `*` never widens the privileged vocabulary", CODE_PRIVILEGED_PERMISSIONS.every((privileged) => !wildcard.includes(privileged)));

  const named = createRoleRegistry({ roles: { platform: ["admin:all", "code.prod.operate"] } });
  ok("D3: an explicitly named privileged permission survives", named.permissionsForRole("platform").includes("code.prod.operate"));

  const wildcardOnly = createRoleRegistry({ roles: { owner: ["admin:all", "*"] } });
  ok("D3: step-up does not accept a wildcard as production permission", holdsProductionPermission(owner, wildcardOnly) === false);
  const byName = createRoleRegistry({ roles: { owner: ["admin:all", "code.prod.operate"] } });
  ok("D3: step-up accepts the explicitly named production permission", holdsProductionPermission(owner, byName) === true);
}

// ---------------------------------------------------------------------------------------------
// D11 — the action decides the permission
// ---------------------------------------------------------------------------------------------

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

const rbacAudit = { record: async () => undefined };

{
  const rbac = new CodeRbac({ audit: rbacAudit });
  const mismatch = await refusal(() => rbac.authorize(principal({ role: "owner", permissions: ["admin:all"] }), COMPANY, {
    permission: "workspace:read",
    action: "code.flags.change",
  }));
  matches("D11: a mismatched pair is refused", mismatch, { code: "permission_action_mismatch", httpStatus: 403 });
  ok("D11: the refusal names the expected and the provided permission", mismatch.details?.expected === "business:manage" && mismatch.details?.provided === "workspace:read");

  const unknown = await refusal(() => rbac.authorize(principal({ role: "owner", permissions: ["admin:all"] }), COMPANY, {
    permission: "workspace:write",
    action: "code.made.up",
  }));
  matches("D11: an unmapped action is refused by default", unknown, { code: "action_not_mapped", httpStatus: 403 });

  const developer = principal({ role: "developer", permissions: ["workspace:read", "workspace:write", "tools:execute"] });
  const ownerCtx = principal({ role: "owner", permissions: ["admin:all"] });
  const cases: Array<[string, AuthContext, string]> = [
    ["workspace:write", developer, "code.fs.edit"],
    ["workspace:read", developer, "code.fs.read"],
    ["workspace:write", developer, "code.shell.exec"],
    ["tools:execute", developer, "code.verify.run"],
    ["business:manage", ownerCtx, "code.flags.change"],
    ["business:manage", ownerCtx, "code.membership.invite"],
    ["business:manage", ownerCtx, "code.protected_branches.update"],
    ["business:manage", ownerCtx, "code.project.trust"],
    ["workspace:read", ownerCtx, "code.protected_branches.read"],
    ["workspace:read", ownerCtx, "code.membership.accept"],
    ["audit:read", principal({ role: "owner", permissions: ["audit:read"] }), "code.audit.read"],
  ];
  for (const [permission, ctx, action] of cases) {
    const allowed = await rbac.authorize(ctx, COMPANY, { permission, action });
    ok(`D11: the correct pair is allowed (${permission} / ${action})`, allowed.allowed === true);
    const wrong = await refusal(() => rbac.authorize(ctx, COMPANY, { permission: "admin:all", action }));
    ok(`D11: the same action with a wrong label is refused (${action})`, wrong.code === "permission_action_mismatch");
  }
  ok("D11: code.verify.run requires tools:execute", requiredPermissionForAction("code.verify.run") === "tools:execute");
  ok("D11: a privileged permission resolves to itself as an action", requiredPermissionForAction("code.prod.operate") === "code.prod.operate");
  ok("D11: an empty action has no mapping", requiredPermissionForAction("") === null);

  const wildcardOwner = principal({ role: "owner", permissions: ["admin:all", "*"] });
  const production = { permission: "code.prod.operate", action: "code.deploy.production", production: true };
  const wildcardFailure = await refusal(() => rbac.authorize(wildcardOwner, COMPANY, production));
  ok("D11: a wildcard still never reaches production", wildcardFailure.code === "production_permission_required");
  const named = createRoleRegistry({ roles: { owner: ["admin:all", "code.prod.operate"] } });
  const namedRbac = new CodeRbac({ registry: named, audit: rbacAudit });
  const privileged = await namedRbac.authorize(principal({ role: "owner" }), COMPANY, production);
  ok("D11: an explicitly named role passes the production pair", privileged.allowed === true && privileged.privileged === true);
  const service = principal({ userId: "u-owner", externalSubject: "service:automation:1", role: "owner", permissions: ["admin:all", "code.prod.operate"] });
  const serviceFailure = await refusal(() => namedRbac.authorize(service, COMPANY, production));
  ok("D11: a service identity is refused by the principal invariant", serviceFailure.code === "service_identity_cannot_operate_production");
  const privilegedMismatch = await refusal(() => namedRbac.authorize(principal({ role: "owner" }), COMPANY, {
    permission: "workspace:write", action: "code.deploy.production", production: true,
  }));
  ok("D11: a mismatched privileged pair is refused", privilegedMismatch.code === "permission_action_mismatch");
}

// ---------------------------------------------------------------------------------------------
// Standing rules: the observation that they are inert for file actions
// ---------------------------------------------------------------------------------------------

{
  const queried: string[] = [];
  const harness = engineHarness(protectedBranchService(), {
    approvalRules: {
      async findRule(_ctx, query) {
        queried.push(query.action);
        return { id: "rule-1", scope: "project" };
      },
    },
  });
  for (const tool of ["code.fs.edit", "code.fs.write", "code.fs.move", "code.verify.run"]) {
    const result = await harness.engine.evaluate({ ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, tool, sessionMode: "auto_edit" });
    ok(`scope: ${tool} is allowed without consulting a standing rule`, result.decision === "allow" && result.phase === "approval");
  }
  ok("scope: no standing rule was consulted for any of the four allowlisted file actions", queried.length === 0);
  const shell = await harness.engine.evaluate(pushRequest(owner, "git push origin feature/topic"));
  ok("scope: a shell command in the approval class DOES consult the rule and is allowed by it", shell.decision === "allow" && queried.length === 1 && queried[0] === "code.shell.exec:git:push");
}

// ---------------------------------------------------------------------------------------------
// Legacy pins that must keep holding after D4/D7
// ---------------------------------------------------------------------------------------------

{
  const harness = membershipHarness([{ userId: "u-owner", role: "owner" }]);
  const stranger = await refusal(() => harness.service.invite(actor("u-stranger"), COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" }));
  matches("legacy: a non-member is refused with membership_manage_forbidden", stranger, { code: "membership_manage_forbidden", httpStatus: 403, retryable: false });
  ok("legacy: the refusal still carries details.role === null", stranger.details?.role === null);
  ok("legacy: nothing was created", harness.state.invites === 0);

  const shape = membershipHarness([{ userId: "u-owner", role: "owner" }]);
  const weak = await refusal(() => shape.service.invite(actor("u-owner"), COMPANY, { email: "x@example.com", role: "developer", token: "short" }));
  ok("legacy: a weak token is still invite_token_too_weak (400) with no journal entry", weak.code === "invite_token_too_weak" && weak.httpStatus === 400 && shape.audit.length === 0);
  const badRole = await refusal(() => shape.service.invite(actor("u-owner"), COMPANY, { email: "x@example.com", role: "superuser" as CompanyRole, token: "token-0123456789abcdef" }));
  ok("legacy: an unknown role is still invalid_company_role (400) with no journal entry", badRole.code === "invalid_company_role" && badRole.httpStatus === 400 && shape.audit.length === 0);

  const lastOwner = membershipHarness([{ userId: "u-owner", role: "owner" }]);
  const demote = await refusal(() => lastOwner.service.updateRole(actor("u-owner"), COMPANY, { userId: "u-owner", role: "admin", expectedRevision: 1 }));
  matches("legacy: the only owner still cannot be demoted", demote, { code: "last_owner_protected", httpStatus: 409 });
  ok("legacy: the denied demotion is journalled (D7)", lastOwner.audit.some((entry) => entry.action === "code.membership.role_change.denied"));

  const noJournal = new CodeMembershipService({
    store: {
      getCompanyMembership: async (companyId: string, userId: string) => ({ companyId, userId, role: "owner", status: "active", revision: 1 }),
      countCompanyOwners: async () => 1,
      createCompanyInvite: async () => { throw new Error("must not be called"); },
    } as unknown as CodeMembershipStore,
  });
  const unavailable = await refusal(() => noJournal.invite(actor("u-owner"), COMPANY, { email: "x@example.com", role: "developer", token: "token-0123456789abcdef" }));
  matches("legacy: a missing journal still refuses a change with 503", unavailable, { code: "audit_unavailable", httpStatus: 503, retryable: true });
}

// ---------------------------------------------------------------------------------------------
// D9 end to end: the shell runtime path reaches the same gate
// ---------------------------------------------------------------------------------------------

{
  const executed: string[] = [];
  const sandbox = {
    async execute(input: { command: string }) {
      executed.push(input.command);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  };
  const runtime = new CodeShellRuntime({ sandbox, policy: engineHarness(protectedBranchService()).engine });
  const base = { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, toolCallId: "call-1", sessionMode: "full_auto_sandbox" };
  const protectedPush = await refusal(() => runtime.exec(owner, { ...base, command: "git push origin main", approved: true, approvalId: "approval-1" } as never));
  matches("D9 runtime: the shell path refuses a protected-branch push with the same code", protectedPush, { code: "protected_branch_write_denied", httpStatus: 403 });
  ok("D9 runtime: the sandbox was never called", executed.length === 0);
  const unprotectedPush = await refusal(() => runtime.exec(owner, { ...base, command: "git push origin feature/topic" } as never));
  ok("D9 runtime: an unprotected push still needs an approval and never runs automatically", unprotectedPush.code === "approval_required" && executed.length === 0);
  const allowed = await runtime.exec(owner, { ...base, command: "git status" } as never);
  ok("D9 runtime: a read-only git command still reaches the sandbox", allowed.risk === "safe" && executed.length === 1);
}

console.log(`\nprobe: ${passed} assertions passed`);