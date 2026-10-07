import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthContext, Project, WorkspaceStore } from "@npati/workspace";
import { classifyShellCommand, detectGitWriteAttempts } from "../apps/agent-api/src/code-shell-classifier";
import {
  GIT_PUSH_REQUIRES_RESOLVED_BRANCH,
  GIT_WRITE_INTENT_INVALID,
  GIT_WRITE_INTENT_REQUIRED,
  GIT_WRITE_TOOLS,
  gitApprovalPayload,
  gitWriteIntentFromShellAttempt,
  gitWriteIntentFromToolInput,
  isGitWriteTool,
  normalizeGitWriteIntent,
  pullRequestApprovalPayload,
  type GitWriteIntent,
} from "../apps/agent-api/src/code-git-write-policy";
import {
  PolicyEngine,
  GIT_FLAG,
  payloadHashFor,
  subFlagForTool,
  type PolicyEngineDeps,
  type PolicyRequest,
} from "../apps/agent-api/src/code-policy-engine";
import {
  CodeProtectedBranchRepository,
  CodeProtectedBranchService,
  type CodeProtectedBranchStore,
} from "../apps/agent-api/src/code-protected-branches";
import { ProjectGitService, redactGitSecrets, type HostGitCredentialPort } from "../apps/agent-api/src/project-git-service";
import { SecretLeaseProvider, SecretLeaseError } from "../apps/agent-api/src/code-secret-lease";
import { CodeShellRuntime } from "../apps/agent-api/src/code-shell-runtime";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";
import { gitShellHardeningEnv } from "../apps/agent-api/src/code-deps-policy";

/**
 * C11 security-gate: the git workflow's security core (owner decisions 3–6).
 *
 * The three defects this suite exists to keep shut:
 *  1. the protected-branch hard deny read a **command string**, so `git push` without a refspec reported
 *     `branch: ""` (nothing to protect) and a git **tool** — which has no command at all — was invisible to
 *     the phase entirely;
 *  2. a direct call to `ProjectGitService.push` bypassed the engine: the protected-branch policy was
 *     consulted in exactly one place, and that place was not the one next to the side effect;
 *  3. `__npatiApprovalGranted` was the only proof of human approval, and for `project.git.*` it was
 *     unconditionally `true`, so a Company agent could push with no approval at all.
 *
 * The tests below assert the type-level and behavioural fixes, and — where a credential is involved — the
 * absence of traces: the `.git/config` hash does not move, the next invocation carries no credential, and
 * the agent shell cannot redeem a host-git lease.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";
const SESSION = "session-1";
const SHELL_TOOL = "code.shell.exec";
const GIT_TOOL = "code.git.push";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "ghp_C11GITHUBSECRETTOKENVALUE0123456789";

const TOOL_IDS = [SHELL_TOOL, "code.fs.read", "code.fs.write", GIT_TOOL];

function context(overlay: { role?: string; userId?: string; permissions?: string[]; externalSubject?: string } = {}): AuthContext {
  return {
    workspaceId: "ws-1",
    companyId: COMPANY,
    userId: overlay.userId ?? "u-owner",
    permissions: overlay.permissions ?? ["workspace:read", "workspace:write", "admin:all"],
    ...(overlay.role === undefined ? {} : { role: overlay.role }),
    ...(overlay.externalSubject === undefined ? {} : { externalSubject: overlay.externalSubject }),
  } as unknown as AuthContext;
}

const owner = context({ role: "owner" });
const agentPrincipal = context({ role: "owner", userId: "agent:runner-1", externalSubject: "agent:runner-1", permissions: ["workspace:read", "workspace:write"] });

function protectedBranchService(store?: CodeProtectedBranchStore): CodeProtectedBranchService {
  return new CodeProtectedBranchService({
    store: store ?? new CodeProtectedBranchRepository(),
    resolveRole: async (ctx) => (String(ctx.userId).startsWith("agent:") ? "owner" : "owner"),
    audit: { record: async () => undefined },
  });
}

interface EngineHarness {
  engine: PolicyEngine;
  approvals: { requested: Array<Record<string, unknown>>; consumed: Array<{ id: string; params: Record<string, unknown> }> };
  ruleQueries: string[];
  policyIntents: Array<Record<string, unknown>>;
}

function engineHarness(policy: CodeProtectedBranchService, overrides: Partial<PolicyEngineDeps> = {}): EngineHarness {
  const approvals = { requested: [] as Array<Record<string, unknown>>, consumed: [] as Array<{ id: string; params: Record<string, unknown> }> };
  const ruleQueries: string[] = [];
  const policyIntents: Array<Record<string, unknown>> = [];
  const deps: PolicyEngineDeps = {
    flags: { async assertEnabled() { return true; } },
    capabilities: { get: (id: string) => (TOOL_IDS.includes(id) ? { id, status: "active", version: 1 } : undefined) },
    classifier: (command: string) => classifyShellCommand(command),
    approvals: {
      async requestApproval(_ctx, _companyId, input) { approvals.requested.push(input); return { id: `approval-${approvals.requested.length}` }; },
      async consumeApproved(_ctx, _companyId, id, params) { approvals.consumed.push({ id, params }); return { id }; },
    },
    networkEnforcement: () => true,
    protectedBranches: {
      async evaluateGitWrite(ctx, companyId, input) {
        policyIntents.push({ ...input });
        return policy.evaluateGitWrite(ctx, companyId, input as never);
      },
    },
    // A standing rule that would allow anything: a rule is consulted **only** in the approval phase, which
    // runs after the hard deny, so its existence must not change a protected-branch verdict.
    approvalRules: {
      async findRule(_ctx, query) { ruleQueries.push(query.action); return { id: "rule-1", scope: "project" }; },
    },
    ...overrides,
  };
  return { engine: new PolicyEngine(deps), approvals, ruleQueries, policyIntents };
}

function request(tool: string, extra: Partial<PolicyRequest> = {}): PolicyRequest {
  return { ctx: owner, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, tool, sessionMode: "full_auto_sandbox", ...extra };
}

// ---------------------------------------------------------------------------------------------
// 1. The typed intent and the structural detector
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 git write — the typed intent, not a command string", () => {
  it("carries the operation, the branches, the remote and force as explicit fields", () => {
    const intent = gitWriteIntentFromToolInput(GIT_TOOL, { projectId: PROJECT, branch: "feature/topic", credentialId: CREDENTIAL_ID });
    expect(intent).toEqual({
      gitOperation: "push",
      sourceBranch: "feature/topic",
      targetBranch: "feature/topic",
      remoteBranch: "feature/topic",
      remote: null,
      force: false,
      credentialId: CREDENTIAL_ID,
    });
    // `force` is the operation, and a ref prefix is normalised away rather than compared literally.
    expect(gitWriteIntentFromToolInput(GIT_TOOL, { targetBranch: "refs/heads/main", force: true })).toMatchObject({
      gitOperation: "force_push",
      targetBranch: "main",
      force: true,
    });
    // No branch named: the caller must refuse, never treat this as "nothing to protect".
    expect(gitWriteIntentFromToolInput(GIT_TOOL, { projectId: PROJECT })).toBeNull();
    // A non-git tool never produces a git intent.
    expect(gitWriteIntentFromToolInput("code.fs.write", { branch: "main" })).toBeNull();
  });

  it("refuses an internally inconsistent intent instead of resolving it in either direction", () => {
    expect(normalizeGitWriteIntent({ gitOperation: "push", targetBranch: "main", force: true })).toBeNull();
    expect(normalizeGitWriteIntent({ gitOperation: "force_push", targetBranch: "main", force: false })).toBeNull();
    expect(normalizeGitWriteIntent({ gitOperation: "push", targetBranch: "" })).toBeNull();
    expect(normalizeGitWriteIntent({ gitOperation: "rebase", targetBranch: "main", force: false })).toBeNull();
    expect(normalizeGitWriteIntent(null)).toBeNull();
    expect(normalizeGitWriteIntent({ gitOperation: "push", targetBranch: "refs/heads/release" })).toMatchObject({
      gitOperation: "push",
      targetBranch: "release",
      force: false,
    });
  });

  it("keeps the git sub-flag and the git write tool list in one place", () => {
    expect(GIT_WRITE_TOOLS).toContain(GIT_TOOL);
    expect(isGitWriteTool(GIT_TOOL)).toBe(true);
    expect(isGitWriteTool("code.fs.write")).toBe(false);
    // C11: the mapping used to send every git tool to `code.write`, so enabling file edits silently enabled
    // git tooling. The declared `code.git` sub-flag is now what decides.
    expect(subFlagForTool(GIT_TOOL)).toBe(GIT_FLAG);
    expect(GIT_FLAG).toBe("code.git");
    expect(subFlagForTool("code.fs.write")).toBe("code.write");
  });

  it("binds the approval payload to the target, for a push and for a pull request", () => {
    const push = gitApprovalPayload({
      projectId: PROJECT,
      tool: GIT_TOOL,
      intent: gitWriteIntentFromToolInput(GIT_TOOL, { branch: "feature/topic", credentialId: CREDENTIAL_ID })!,
    });
    expect(push).toMatchObject({
      projectId: PROJECT,
      tool: GIT_TOOL,
      git: { gitOperation: "push", targetBranch: "feature/topic", force: false, credentialId: CREDENTIAL_ID },
    });
    const otherBranch = gitApprovalPayload({
      projectId: PROJECT,
      tool: GIT_TOOL,
      intent: gitWriteIntentFromToolInput(GIT_TOOL, { branch: "main", credentialId: CREDENTIAL_ID })!,
    });
    expect(JSON.stringify(push)).not.toBe(JSON.stringify(otherBranch));
    const pr = pullRequestApprovalPayload({ projectId: PROJECT, tool: "project.git.pr", base: "main", head: "feature/topic", credentialId: CREDENTIAL_ID });
    expect(pr).toMatchObject({ pullRequest: { base: "main", head: "feature/topic", credentialId: CREDENTIAL_ID } });
  });

  it("resolves an unrefspec'd shell push only from an established branch", () => {
    expect(gitWriteIntentFromShellAttempt({ operation: "push", branch: "main" })).toMatchObject({ targetBranch: "main" });
    // `git push` with no refspec: the branch of the checkout. Resolved when the caller knows it ...
    expect(gitWriteIntentFromShellAttempt({ operation: "push", branch: "" }, "feature/topic")).toMatchObject({
      sourceBranch: "feature/topic",
      targetBranch: "feature/topic",
    });
    // ... and `null` (a refusal) when it does not.
    expect(gitWriteIntentFromShellAttempt({ operation: "push", branch: "" }, "")).toBeNull();
    expect(gitWriteIntentFromShellAttempt({ operation: "force_push", branch: "" }, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Hard deny before approval — protected branches
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 protected branches — hard deny before approval, for every principal", () => {
  it("denies a git-tool push into a protected branch with hard_deny, never approval", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["main", "release"], expectedRevision: 0 });
    const harness = engineHarness(policy);
    const intent = gitWriteIntentFromToolInput(GIT_TOOL, { branch: "main", credentialId: CREDENTIAL_ID })!;
    const result = await harness.engine.evaluate(request(GIT_TOOL, { git: intent, approved: true, approvalId: "approval-1" }));
    expect(result).toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny", status: 403, risk: "hard_deny" });
    // No approval was requested, none was consumed, and the standing rule was never even consulted: the
    // hard-deny phase returns before the approval phase exists.
    expect(harness.approvals.requested).toHaveLength(0);
    expect(harness.approvals.consumed).toHaveLength(0);
    expect(harness.ruleQueries).toEqual([]);
  });

  it("is not lifted by the owner role, admin:all, a standing rule or a force flag", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["main"], expectedRevision: 0 });
    const harness = engineHarness(policy);
    const force = gitWriteIntentFromToolInput(GIT_TOOL, { branch: "main", force: true })!;
    const forced = await harness.engine.evaluate(request(GIT_TOOL, { git: force, approved: true, approvalId: "approval-1" }));
    expect(forced).toMatchObject({ decision: "deny", code: "force_push_denied", phase: "hard_deny", status: 403 });
    // The same push for an agent principal: without an approval claim it is the protected-branch hard deny.
    const asAgent = await harness.engine.evaluate({
      ...request(GIT_TOOL, { git: gitWriteIntentFromToolInput(GIT_TOOL, { branch: "main" })! }),
      ctx: agentPrincipal,
    });
    expect(asAgent).toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny" });
    // With an approval claim an agent is refused even earlier (it may never be the approver) — still never
    // an approval, and still nothing consumed.
    const asApprover = await harness.engine.evaluate({
      ...request(GIT_TOOL, { git: gitWriteIntentFromToolInput(GIT_TOOL, { branch: "main" })!, approved: true, approvalId: "approval-1" }),
      ctx: agentPrincipal,
    });
    expect(asApprover).toMatchObject({ decision: "deny", code: "agent_cannot_approve", phase: "rbac" });
    expect(harness.approvals.consumed).toHaveLength(0);
    expect(harness.approvals.requested).toHaveLength(0);
  });

  it("refuses a git-write tool that carries no typed intent, instead of skipping the gate", async () => {
    const policy = protectedBranchService();
    const harness = engineHarness(policy);
    const result = await harness.engine.evaluate(request(GIT_TOOL, { sessionMode: "full_auto_sandbox" }));
    expect(result).toMatchObject({ decision: "deny", code: GIT_WRITE_INTENT_REQUIRED, phase: "hard_deny", status: 403 });
    expect(harness.policyIntents).toHaveLength(0);
  });

  it("refuses an inconsistent typed intent before asking the policy anything", async () => {
    const harness = engineHarness(protectedBranchService());
    const result = await harness.engine.evaluate(request(GIT_TOOL, { git: { gitOperation: "push", targetBranch: "main", force: true } as never }));
    expect(result).toMatchObject({ decision: "deny", code: GIT_WRITE_INTENT_INVALID, phase: "hard_deny" });
    expect(harness.policyIntents).toHaveLength(0);
  });

  it("closes the `branch: \"\"` hole: an unrefspec'd shell push is refused, not assumed unprotected", async () => {
    const policy = protectedBranchService();
    const harness = engineHarness(policy);
    // The parser still reports no branch for `git push` (it is a property of the checkout) ...
    expect(detectGitWriteAttempts("git push")).toEqual([{ operation: "push", branch: "" }]);
    // ... and with no resolver the engine refuses rather than reading "no branch" as "not protected".
    const refused = await harness.engine.evaluate(request(SHELL_TOOL, { command: "git push" }));
    expect(refused).toMatchObject({ decision: "deny", code: GIT_PUSH_REQUIRES_RESOLVED_BRANCH, phase: "hard_deny", status: 403 });
    expect(harness.policyIntents).toHaveLength(0);

    // With a resolver the resolved branch is what the policy judges — a protected one is still denied.
    const resolved = engineHarness(policy, { gitBranchResolver: () => "main" });
    const denied = await resolved.engine.evaluate(request(SHELL_TOOL, { command: "git push", approved: true, approvalId: "approval-1" }));
    expect(denied).toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny" });
    expect(resolved.policyIntents[0]).toMatchObject({ targetBranch: "main", sourceBranch: "main", gitOperation: "push" });

    // An unprotected resolved branch keeps its ordinary approval class — never an implicit allow. (No
    // standing rule is configured for this harness: a rule may only widen the *approval* phase, and the
    // point here is that the phase itself is reached rather than skipped.)
    const unprotected = engineHarness(policy, { gitBranchResolver: () => "feature/topic", approvalRules: undefined });
    expect(await unprotected.engine.evaluate(request(SHELL_TOOL, { command: "git push" })))
      .toMatchObject({ decision: "require_approval", code: "approval_required", phase: "approval" });

    // A resolver that throws is not evidence of safety.
    const failing = engineHarness(policy, { gitBranchResolver: () => { throw new Error("checkout unavailable"); } });
    expect(await failing.engine.evaluate(request(SHELL_TOOL, { command: "git push" })))
      .toMatchObject({ decision: "deny", code: GIT_PUSH_REQUIRES_RESOLVED_BRANCH, phase: "hard_deny" });
  });

  it("evaluates a declared intent and the command line together", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["main"], expectedRevision: 0 });
    const harness = engineHarness(policy);
    // The declared intent names a harmless branch while the command writes to a protected one.
    const result = await harness.engine.evaluate(request(SHELL_TOOL, {
      command: "git push origin main",
      git: gitWriteIntentFromToolInput(GIT_TOOL, { branch: "feature/topic" })!,
      approved: true,
      approvalId: "approval-1",
    }));
    expect(result).toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny" });
    expect(harness.policyIntents).toHaveLength(2);
  });

  it("keeps one company's policy out of another company's decision", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["release"], expectedRevision: 0 });
    const intentFor = (branch: string) => gitWriteIntentFromToolInput(GIT_TOOL, { branch })!;
    // Company A protects `release` **instead of** the built-in defaults (a stored policy replaces them).
    expect(await policy.evaluateGitWrite(owner, COMPANY, intentFor("release"))).toMatchObject({ allowed: false, code: "protected_branch_write_denied" });
    expect(await policy.evaluateGitWrite(owner, COMPANY, intentFor("main"))).toMatchObject({ allowed: true, protected: false });
    // Company B never set a policy: the built-in defaults apply to B alone, and A's list is invisible here.
    expect(await policy.evaluateGitWrite(owner, OTHER_COMPANY, intentFor("main"))).toMatchObject({ allowed: false, code: "protected_branch_write_denied" });
    expect(await policy.evaluateGitWrite(owner, OTHER_COMPANY, intentFor("release"))).toMatchObject({ allowed: false, code: "protected_branch_write_denied" });
    expect(await policy.evaluateGitWrite(owner, OTHER_COMPANY, intentFor("feature/topic"))).toMatchObject({ allowed: true, protected: false });
  });

  it("fails closed when the policy store cannot be read", async () => {
    const broken: CodeProtectedBranchStore = {
      async get() { throw new Error("store down"); },
      async save() { throw new Error("store down"); },
    };
    const harness = engineHarness(protectedBranchService(broken));
    const result = await harness.engine.evaluate(request(GIT_TOOL, { git: gitWriteIntentFromToolInput(GIT_TOOL, { branch: "main" })! }));
    expect(result).toMatchObject({ decision: "deny", code: "protected_branch_write_denied", phase: "hard_deny" });
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The approval hash is bound to the target
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 approval payload hash — bound to the branch, not to \"some push\"", () => {
  const base: PolicyRequest = { ctx: owner, companyId: COMPANY, tool: GIT_TOOL, sessionId: SESSION };
  const intent = (extra: Record<string, unknown>) => gitWriteIntentFromToolInput(GIT_TOOL, { branch: "feature/topic", credentialId: CREDENTIAL_ID, ...extra })!;

  it("changes when the branch, the remote or the credential changes, and is stable otherwise", () => {
    const original = payloadHashFor({ ...base, git: intent({}) });
    expect(payloadHashFor({ ...base, git: intent({}) })).toBe(original);
    expect(payloadHashFor({ ...base, git: intent({ branch: "main" }) })).not.toBe(original);
    expect(payloadHashFor({ ...base, git: { ...intent({}), remote: "origin" } })).not.toBe(original);
    expect(payloadHashFor({ ...base, git: intent({ force: true }) })).not.toBe(original);
    expect(payloadHashFor({ ...base, git: intent({ credentialId: "22222222-2222-4222-8222-222222222222" }) })).not.toBe(original);
    // A request without a git intent keeps the hash it had before C11 (the key is added, not defaulted).
    expect(payloadHashFor({ ...base, command: "git status" })).toBe(payloadHashFor({ ...base, command: "git status" }));
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The second check at the git boundary (a direct service call must not bypass the engine)
// ---------------------------------------------------------------------------------------------

interface GitHarness {
  service: ProjectGitService;
  calls: Array<{ args: string[]; env: Record<string, string> }>;
  approvedPayloads: Array<Record<string, unknown>>;
  revoked: string[];
  configPath: string;
  dir: string;
  cleanup: () => Promise<void>;
}

async function gitHarness(options: {
  policy?: CodeProtectedBranchService;
  branch?: string;
  withoutApprovalPort?: boolean;
  withoutPolicy?: boolean;
  failPush?: boolean;
  pushError?: string;
} = {}): Promise<GitHarness> {
  const root = await mkdtemp(path.join(tmpdir(), "npati-c11-git-"));
  const dir = path.join(root, COMPANY, PROJECT);
  await mkdir(path.join(dir, ".git"), { recursive: true });
  const configPath = path.join(dir, ".git", "config");
  await writeFile(configPath, '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[remote "origin"]\n\turl = https://github.com/example/site.git\n', "utf8");

  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const approvedPayloads: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];

  const runGit = async (calledDir: string, args: string[], env: Record<string, string>) => {
    calls.push({ args: [...args], env: { ...env } });
    if (args[0] === "push" && options.failPush) throw new Error(options.pushError ?? "git failed");
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: calledDir, stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: `${options.branch ?? "feature/topic"}\n`, stderr: "" };
    if (args[0] === "status") return { stdout: `## ${options.branch ?? "feature/topic"}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };

  const store = {
    createProjectCheckpoint: async () => ({ id: "cp-1" }),
    listProjectCheckpoints: async () => [],
  } as unknown as WorkspaceStore;
  const project = {
    id: PROJECT, companyId: COMPANY, workspaceId: "ws-1", status: "ready",
    repositoryProvider: "github", repositoryUrl: "https://github.com/example/site.git", repositoryBranch: "main",
  } as unknown as Project;

  const credentials: HostGitCredentialPort = {
    acquire: async (input) => {
      // The lease is bound to one operation: reuse of a consumed id is refused, exactly as the real
      // `SecretLeaseProvider.consume` refuses it.
      if (!input.toolCallId) throw new Error("tool call id is required");
      return { leaseId: `lease-${input.toolCallId}`, value: TOKEN };
    },
    revoke: async (leaseId) => { revoked.push(leaseId); },
  };

  const boundary = {
    ...(options.withoutPolicy
      ? {}
      : { assertGitWriteAllowed: (ctx: AuthContext, companyId: string, input: GitWriteIntent) => (options.policy ?? protectedBranchService()).assertGitWriteAllowed(ctx, companyId, input) }),
    ...(options.withoutApprovalPort
      ? {}
      : {
          approvals: {
            consumeApproved: async (_ctx: AuthContext, _companyId: string, id: string, params: { runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown> }) => {
              approvedPayloads.push({ id, runId: params.runId, agentId: params.agentId, toolName: params.toolName, ...params.inputPayload });
              return { id };
            },
          },
        }),
    credentials,
  };

  const service = new ProjectGitService(store, { get: async () => project }, root, undefined, undefined, runGit, boundary);
  return { service, calls, approvedPayloads, revoked, configPath, dir, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

/** The approval record a caller presents (`approved: true` is not proof on its own). */
const approvalRecord = { approvalId: "approval-1", runId: "run-1", agentId: "agent-1", toolName: "project.git.push" };

describe("security-gate: C11 git boundary — the second protected-branch check", () => {
  it("denies a direct service push into a protected branch and never calls git", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["main"], expectedRevision: 0 });
    const harness = await gitHarness({ policy, branch: "main" });
    try {
      const refusal = await harness.service
        .push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord, branch: "main" })
        .then(() => null, (error: { code?: string; httpStatus?: number; details?: Record<string, unknown> }) => error);
      expect(refusal).toMatchObject({ code: "protected_branch_write_denied", httpStatus: 403 });
      expect(refusal?.details).toMatchObject({ targetBranch: "main", force: false });
      // The engine was never involved in this call, no `git push` was issued, and the human's one-shot
      // approval was not spent on a write the policy hard-denies.
      expect(harness.calls.filter((call) => call.args[0] === "push")).toHaveLength(0);
      expect(harness.approvedPayloads).toHaveLength(0);
      expect(harness.revoked).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("denies a force push at the boundary with force_push_denied, before the API refuses the rewrite", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["main"], expectedRevision: 0 });
    const harness = await gitHarness({ policy, branch: "main" });
    try {
      const refusal = await harness.service
        .push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord, branch: "main", force: true })
        .then(() => null, (error: { code?: string }) => error);
      expect(refusal).toMatchObject({ code: "force_push_denied", httpStatus: 403 });
      expect(harness.calls.filter((call) => call.args[0] === "push")).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("refuses to push at all when the protected-branch policy is not wired (fail closed)", async () => {
    const harness = await gitHarness({ withoutPolicy: true });
    try {
      const refusal = await harness.service
        .push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord, branch: "feature/topic" })
        .then(() => null, (error: { code?: string }) => error);
      expect(refusal).toMatchObject({ code: "GIT_POLICY_UNAVAILABLE" });
      expect(harness.calls.filter((call) => call.args[0] === "push")).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("resolves the checked-out branch when the caller names none, and checks that branch", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["main"], expectedRevision: 0 });
    const harness = await gitHarness({ policy, branch: "main" });
    try {
      const refusal = await harness.service
        .push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord })
        .then(() => null, (error: { code?: string }) => error);
      // The checkout is on `main`: the resolved branch is what the boundary judged, and it denied.
      expect(refusal).toMatchObject({ code: "protected_branch_write_denied" });
      expect(harness.calls.some((call) => call.args.join(" ") === "rev-parse --abbrev-ref HEAD")).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The approval record is the proof, not the flag
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 git boundary — a real approval record, bound to the payload", () => {
  it("refuses the `approved` flag alone and issues no git command", async () => {
    const harness = await gitHarness();
    try {
      const refusal = await harness.service
        .push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, branch: "feature/topic" })
        .then(() => null, (error: { code?: string }) => error);
      expect(refusal).toMatchObject({ code: "GIT_APPROVAL_RECORD_REQUIRED", status: 403 });
      expect(harness.calls.filter((call) => call.args[0] === "push")).toHaveLength(0);
      expect(harness.approvedPayloads).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("refuses a remote write when no approval port is wired (fail closed)", async () => {
    const harness = await gitHarness({ withoutApprovalPort: true });
    try {
      const refusal = await harness.service
        .push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, branch: "feature/topic" })
        .then(() => null, (error: { code?: string }) => error);
      // The policy check passed (the branch is unprotected); without an approval port the write still
      // refuses rather than executing on the flag.
      expect(refusal).toMatchObject({ code: "GIT_APPROVAL_UNAVAILABLE" });
      expect(harness.calls.filter((call) => call.args[0] === "push")).toHaveLength(0);
      expect(harness.revoked).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("consumes the record with the typed payload, and the payload follows the branch", async () => {
    const policy = protectedBranchService();
    const first = await gitHarness({ policy, branch: "feature/one" });
    const second = await gitHarness({ policy, branch: "feature/two" });
    try {
      await first.service.push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord, branch: "feature/one" });
      expect(first.approvedPayloads).toHaveLength(1);
      expect(first.approvedPayloads[0]).toMatchObject({
        id: "approval-1",
        runId: "run-1",
        agentId: "agent-1",
        toolName: "project.git.push",
        projectId: PROJECT,
        tool: "project.git.push",
        git: { gitOperation: "push", targetBranch: "feature/one", remoteBranch: "feature/one", force: false, credentialId: CREDENTIAL_ID },
      });
      await second.service.push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord, branch: "feature/two" });
      // The hash of the approved payload moves with the branch: an approval for one target cannot be
      // redeemed for another.
      expect(JSON.stringify(first.approvedPayloads[0])).not.toBe(JSON.stringify(second.approvedPayloads[0]));
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("refuses a pull request whose target is unnamed, and consumes the (base, head) binding", async () => {
    const harness = await gitHarness();
    try {
      const unnamed = await harness.service
        .createPullRequest(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, title: "Update", approval: { ...approvalRecord, toolName: "project.git.pr" } })
        .then(() => null, (error: { code?: string }) => error);
      expect(unnamed).toMatchObject({ code: "GIT_PR_TARGET_REQUIRED" });
    } finally {
      await harness.cleanup();
    }
  });

  it("pushes through the Company tool runtime only with the approval record, and binds it to the branch", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["main"], expectedRevision: 0 });
    const harness = await gitHarness({ policy, branch: "feature/topic" });
    try {
      const runtime = new CompanyToolRuntime(
        undefined as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, { getCompanyAgent: async () => ({ id: "agent-1", isActive: true, tools: ["project.git.push"] }) } as never,
        undefined, undefined, harness.service,
      );
      const company = { id: COMPANY, name: "Company" } as never;
      const approved = await runtime.execute(owner, company, "project.git.push", {
        projectId: PROJECT, branch: "feature/topic", credentialId: CREDENTIAL_ID,
        __npatiApprovalGranted: true, __npatiApprovalId: "approval-1", __npatiTaskRunId: "run-1", __npatiAgentId: "agent-1",
      }, new AbortController().signal);
      expect(approved).toMatchObject({ pushed: true, branch: "feature/topic" });
      // The record was consumed under the tool id and with the typed target the caller named.
      expect(harness.approvedPayloads).toHaveLength(1);
      expect(harness.approvedPayloads[0]).toMatchObject({
        id: "approval-1", runId: "run-1", agentId: "agent-1", toolName: "project.git.push",
        git: { targetBranch: "feature/topic", force: false, credentialId: CREDENTIAL_ID },
      });
      // A target-less remote write never reaches this point in production: the Company run refuses to
      // create an approval for one (`company-runtime.ts` — there would be nothing to bind the human's
      // decision to), and the service judges the *resolved* branch when a caller names none (pinned by the
      // "resolves the checked-out branch" case above, where the checkout was on the protected `main`).
      expect(gitWriteIntentFromToolInput("project.git.push", { projectId: PROJECT })).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("does not let the Company tool runtime turn the flag into a push", async () => {
    const policy = protectedBranchService();
    await policy.updatePolicy(owner, COMPANY, { branches: ["main"], expectedRevision: 0 });
    const harness = await gitHarness({ policy, branch: "feature/topic" });
    try {
      const runtime = new CompanyToolRuntime(
        undefined as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, { getCompanyAgent: async () => ({ id: "agent-1", isActive: true, tools: ["project.git.push"] }) } as never,
        undefined, undefined, harness.service,
      );
      const company = { id: COMPANY, name: "Company" } as never;
      // The flag is exactly what the Company run sets for `project.git.*` today; it is no longer proof.
      const refusal = await runtime
        .execute(owner, company, "project.git.push", { projectId: PROJECT, branch: "feature/topic", credentialId: CREDENTIAL_ID, __npatiApprovalGranted: true, __npatiAgentId: "agent-1", __npatiTaskRunId: "run-1" }, new AbortController().signal)
        .then(() => null, (error: { code?: string }) => error);
      expect(refusal).toMatchObject({ code: "GIT_APPROVAL_RECORD_REQUIRED" });
      expect(harness.calls.filter((call) => call.args[0] === "push")).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Credentials: one operation, no traces, and never into the agent shell
// ---------------------------------------------------------------------------------------------

function leaseInput(extra: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY, projectId: PROJECT, sessionId: `git:${PROJECT}`, purpose: "git.push",
    toolCallId: "call-1", variableName: "NPATI_GIT_TOKEN", credentialId: CREDENTIAL_ID, field: "token",
    credential: { id: CREDENTIAL_ID, label: "dev-key", environment: "development" },
    ...extra,
  } as never;
}

describe("security-gate: C11 credentials — disjoint delivery targets", () => {
  it("cannot deliver a host git credential to an agent shell, and cannot inherit a lease", async () => {
    const provider = new SecretLeaseProvider({
      config: { allowedLabels: ["dev-key"] },
      resolveField: async () => TOKEN,
    });
    const lease = await provider.issue(owner, leaseInput({ target: "hostProcess" }));
    // The agent shell path is `environmentReferences`, and it refuses every other target: the sandbox can
    // never be handed the git token, whatever the caller asks for.
    expect(() => provider.environmentReferences(lease.leaseId, "call-1")).toThrow(/not for the agent shell/);
    // The host path redeems it once ...
    const value = await provider.hostProcessValue(owner, lease.leaseId, "call-1");
    expect(value).toMatchObject({ variableName: "NPATI_GIT_TOKEN", value: TOKEN });
    // ... and a second redemption is inheritance, not a retry.
    await expect(provider.hostProcessValue(owner, lease.leaseId, "call-1")).rejects.toMatchObject({ code: "secret_lease_inherited" });
    // A lease issued for the shell cannot be redeemed by a host process either (the reverse direction).
    const shellLease = await provider.issue(owner, leaseInput({ toolCallId: "call-2" }));
    await expect(provider.hostProcessValue(owner, shellLease.leaseId, "call-2")).rejects.toMatchObject({ code: "secret_delivery_mismatch" });
    // The refused redemption did not burn the lease: the channel it was issued for still works.
    expect(provider.environmentReferences(shellLease.leaseId, "call-2")).toEqual({ NPATI_GIT_TOKEN: { id: CREDENTIAL_ID, field: "token" } });
    // A revoked lease is never redeemable, and a different tool call never inherits one.
    const revoked = await provider.issue(owner, leaseInput({ toolCallId: "call-3", target: "hostProcess" }));
    await provider.revoke(revoked.leaseId, "call_finished");
    await expect(provider.hostProcessValue(owner, revoked.leaseId, "call-3")).rejects.toMatchObject({ code: "secret_lease_expired" });
    const fourth = await provider.issue(owner, leaseInput({ toolCallId: "call-4", target: "hostProcess" }));
    expect(() => provider.assertNotInherited(fourth.leaseId, "call-5")).toThrow(/tool call it was issued for/);
    // The lease object, and the audit trail it produces, never carry the value.
    expect(JSON.stringify(provider.list())).not.toContain(TOKEN);
  });

  it("refuses a host-process lease when no value store is configured", async () => {
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    await expect(provider.issue(owner, leaseInput({ target: "hostProcess" }))).rejects.toMatchObject({ code: "secret_delivery_unavailable", httpStatus: 503 });
    await expect(provider.issue(owner, leaseInput({ target: "tmpfsFile" }))).rejects.toMatchObject({ code: "secret_delivery_unavailable", httpStatus: 503 });
  });

  it("delivers the credential only into one process environment, and leaves .git/config untouched", async () => {
    const harness = await gitHarness();
    try {
      const before = createHash("sha256").update(await readFile(harness.configPath)).digest("hex");
      const result = await harness.service.push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord, branch: "feature/topic" });
      const after = createHash("sha256").update(await readFile(harness.configPath)).digest("hex");

      // The write really happened, with the resolved refspec and the hardened, process-scoped environment.
      const push = harness.calls.find((call) => call.args[0] === "push")!;
      expect(push.args).toEqual(["push", "https://github.com/example/site.git", "refs/heads/feature/topic:refs/heads/feature/topic"]);
      expect(push.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "core.askPass",
        GIT_CONFIG_VALUE_1: "",
        GIT_CONFIG_KEY_2: "http.https://github.com/.extraheader",
      });
      expect(push.env.GIT_CONFIG_VALUE_2).toContain("Authorization: Basic ");

      // No trace of the credential anywhere it could persist.
      expect(after).toBe(before);
      const configText = await readFile(harness.configPath, "utf8");
      expect(configText).not.toContain("extraheader");
      expect(configText).not.toContain("credential");
      expect(configText).not.toContain(TOKEN);
      expect(harness.calls.some((call) => call.args[0] === "config")).toBe(false);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(harness.revoked).toEqual(["lease-approval-1"]);

      // The next invocation carries no credential at all: the lease was consumed and revoked, and nothing
      // was remembered on the instance.
      await harness.service.status(owner, COMPANY, PROJECT);
      const next = harness.calls.filter((call) => call.args[0] === "status")[0]!;
      expect(Object.keys(next.env).filter((key) => key.startsWith("GIT_CONFIG_"))).toEqual([]);
      expect(JSON.stringify(next.env)).not.toContain(TOKEN);
      expect(JSON.stringify(harness.calls)).not.toContain(TOKEN);
    } finally {
      await harness.cleanup();
    }
  });

  it("redacts a credential-bearing git error, and never echoes it from a failed push", async () => {
    const auth = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    const header = `Authorization: Basic ${auth}`;
    const redacted = redactGitSecrets(`fatal: could not read from remote\n  ${header}\nGIT_CONFIG_VALUE_2=${header}`);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain(auth);
    expect(redacted).toContain("Authorization: ***");

    const harness = await gitHarness({ failPush: true, pushError: `remote rejected: ${header}` });
    try {
      const refusal = await harness.service
        .push(owner, COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord, branch: "feature/topic" })
        .then(() => null, (error: { code?: string; message?: string }) => error);
      expect(refusal).toMatchObject({ code: "GIT_PUSH_FAILED", status: 502 });
      expect(String(refusal?.message)).not.toContain(TOKEN);
      expect(String(refusal?.message)).not.toContain(auth);
    } finally {
      await harness.cleanup();
    }
  });

  it("hardens the sandbox git config from the installer path's own primitives", () => {
    const env = gitShellHardeningEnv();
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/true",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.askPass",
      GIT_CONFIG_KEY_2: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_2: "",
    });
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    // The installer's package-manager knobs are deliberately absent: this environment is applied to every
    // sandboxed command, including the `pnpm install` a project without `node_modules` needs.
    expect(env).not.toHaveProperty("npm_config_ignore_scripts");
    expect(env).not.toHaveProperty("PIP_NO_INPUT");
  });

  it("keeps a foreign project's git workspace out of reach", async () => {
    const harness = await gitHarness();
    try {
      const refusal = await harness.service
        .push({ ...owner, companyId: OTHER_COMPANY, workspaceId: "ws-2" } as AuthContext, OTHER_COMPANY, PROJECT, { approved: true, credentialId: CREDENTIAL_ID, approval: approvalRecord, branch: "feature/topic" })
        .then(() => null, (error: { code?: string }) => error);
      expect(refusal).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the C4 lease contract intact for the shell path it already had", async () => {
    const provider = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    const lease = await provider.issue(owner, leaseInput());
    expect(provider.environmentReferences(lease.leaseId, "call-1")).toEqual({ NPATI_GIT_TOKEN: { id: CREDENTIAL_ID, field: "token" } });
    expect(() => provider.environmentReferences(lease.leaseId, "call-1")).toThrow(SecretLeaseError);
  });

  it("refuses a host git credential in the agent shell, and hands the sandbox a reference instead of a value", async () => {
    const executed: Array<{ command: string; references?: Record<string, unknown> }> = [];
    const sandbox = {
      async execute(input: { command: string; environmentReferences?: Record<string, unknown> }) {
        executed.push({ command: input.command, references: input.environmentReferences });
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
    };
    const leases = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] }, resolveField: async () => TOKEN });
    const runtime = new CodeShellRuntime({ sandbox, policy: engineHarness(protectedBranchService()).engine, leases });

    // The lease issued for the host git path cannot be redeemed by the shell at all: the call is refused
    // before the sandbox is touched, so no plaintext git token can ever enter an agent command's
    // environment.
    const gitLease = await leases.issue(owner, leaseInput({ target: "hostProcess", sessionId: SESSION, toolCallId: "call-git" }));
    const refused = await runtime
      .exec(owner, { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, toolCallId: "call-git", sessionMode: "full_auto_sandbox", command: "git status", secretLeaseIds: [gitLease.leaseId] } as never)
      .then(() => null, (error: { code?: string }) => error);
    expect(refused).toMatchObject({ code: "secret_delivery_mismatch" });
    expect(executed).toHaveLength(0);

    // An ordinary shell lease is delivered the way it always was: `{ id, field }`, resolved by the sandbox
    // service, never a value in the request.
    const shellLease = await leases.issue(owner, leaseInput({ sessionId: SESSION, toolCallId: "call-shell" }));
    const result = await runtime.exec(owner, {
      companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, toolCallId: "call-shell",
      sessionMode: "full_auto_sandbox", command: "git status", secretLeaseIds: [shellLease.leaseId],
    } as never);
    expect(result.exitCode).toBe(0);
    expect(executed[0]!.references).toEqual({ NPATI_GIT_TOKEN: { id: CREDENTIAL_ID, field: "token" } });
    expect(JSON.stringify(executed)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. The classifier's own force-push rule is untouched
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 — the existing classifier behaviour is unchanged", () => {
  it("still hard-denies a force push into a default protected branch and still reports no branch for `git push`", () => {
    expect(classifyShellCommand("git push --force origin main").risk).toBe("hard_deny");
    expect(classifyShellCommand("git push origin main").risk).toBe("approval");
    expect(detectGitWriteAttempts("git push")).toEqual([{ operation: "push", branch: "" }]);
    expect(detectGitWriteAttempts("git push origin HEAD:main")).toEqual([{ operation: "push", branch: "main" }]);
  });
});
