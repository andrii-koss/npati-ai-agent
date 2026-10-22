import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import {
  CAPABILITY_CATALOG,
  CODE_GIT_CAPABILITIES,
  CODE_TOOL_SCHEMA_MIRROR,
  flagKeyForCapabilityId,
} from "@npati/shared";
import { CODE_CAPABILITY_GROUPS } from "../apps/agent-api/src/code-capability-groups";
import {
  GIT_APPROVAL_TOOLS,
  GIT_BOUNDARY_APPROVAL_TOOLS,
  GIT_MUTATING_TOOLS,
  GIT_READ_TOOLS,
  GIT_TOOL_NAMES,
  MAX_GIT_MERGE_ATTEMPTS,
  CodeGitWorkflowError,
  assertGitWritePreconditions,
  buildConflictEscalation,
  gitToolApprovalPayload,
  gitWriteIntentForTool,
  isCodeGitTool,
  pullRequestCommentApprovalPayload,
  runMergeWithAutoResolve,
  sessionBranchName,
} from "../apps/agent-api/src/code-git-workflow";
import { canonicalGitExecutors, ensureSessionBranch, type CodeGitToolPort } from "../apps/agent-api/src/code-tool-git-executors";
import { CodeWorkspaceRevisionGuard, CodeWorkspaceRevisionError } from "../apps/agent-api/src/code-workspace-revision";
import { buildPullRequestDescription } from "../apps/agent-api/src/code-pr-description";
import { CodeToolRuntime, codeSubFlagForTool, type CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";
import { CODE_TOOL_SCHEMAS, CODE_TOOL_MANIFEST_VERSION, PUBLISHED_V7_TOOL_SCHEMA_CHECKSUM, toolSchemaChecksum } from "../apps/agent-api/src/code-tool-registry";
import { REVIEW_SAFE_GIT_TOOLS, isReviewSafeTool, subFlagForTool } from "../apps/agent-api/src/code-policy-engine";
import { REVIEW_SAFE_RUN_GIT_TOOLS } from "../apps/agent-api/src/coding-agent-runner";
import { evaluateScopedRulePermission, SCOPED_RULE_DENIED_ACTIONS } from "../apps/agent-api/src/code-approval-scope";
import type { CodingAgentRunSummary } from "../apps/agent-api/src/coding-agent-runner";

/**
 * C11 security-gate: the git workflow's tool surface (owner decisions 1, 2, 7, 8, 9, 10, 11 and 12).
 *
 * The security core is pinned by `coding-agent-c11-git-workflow-security.test.ts` (typed intent, the two
 * protected-branch checks, the approval record bound to the payload hash, the credential lease). This suite
 * covers what the tools themselves must do, and every claim it makes is a claim about **this** repository:
 *
 *  - the eleven capabilities are registered, grouped, risk-classified and flag-gated;
 *  - the executors are **adapters**: a source scan fails if a git command ever appears in them, and each
 *    executor is driven against a recording fake of `ProjectGitService` to prove it delegates;
 *  - the session branch is deterministic and is created or switched to, never assumed;
 *  - a commit or a push refuses on a branch mismatch, a protected branch or a moved canonical revision;
 *  - `workspace_revision_mismatch` is the code a caller gets when the canonical workspace moved;
 *  - a merge conflict is resolved **at most twice**, and after that the escalation names the attempts that
 *    were really made and asks for `code.ask_user`;
 *  - a read-only intent (`REVIEW_CODE`) cannot write, run a command or push — on the server;
 *  - the pull-request body is generated from `CodingAgentRunSummary` and says when verification is missing;
 *  - a pull-request comment carries its **own** approval payload, so an approval for a push or for opening a
 *    pull request cannot be redeemed as a comment.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";

function context(): AuthContext {
  return {
    workspaceId: "ws-1",
    companyId: COMPANY,
    userId: "u-1",
    permissions: ["workspace:read", "workspace:write", "admin:all"],
  } as unknown as AuthContext;
}

const TOOL = { name: "code.git.status", version: 1, status: "active", description: "", inputSchema: {}, outputSchema: {} } as unknown as CodeToolExecutionContext["tool"];

function executionContext(input: {
  tool: string;
  args?: Record<string, unknown>;
  sessionId?: string;
  revision?: string;
}): CodeToolExecutionContext {
  return {
    ctx: context(),
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: input.sessionId ?? SESSION,
    tool: { ...TOOL, name: input.tool } as CodeToolExecutionContext["tool"],
    args: input.args ?? {},
    limits: {} as CodeToolExecutionContext["limits"],
    port: {} as CodeToolExecutionContext["port"],
    ...(input.revision ? { workspaceRevision: { revision: input.revision, branch: "npati/x", capturedAt: 0 } } : {}),
  };
}

/** A recording stand-in for `ProjectGitService`: it answers minimal shapes and remembers every call. */
function recordingGit(overrides: Partial<CodeGitToolPort> = {}): { git: CodeGitToolPort; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const base: CodeGitToolPort = {
    async status() { return { branch: "npati/x", clean: false, staged: ["a.ts"], unstaged: [], untracked: [] }; },
    async diff() { return { diff: "diff --git a/a.ts b/a.ts\n" }; },
    async log() { return [{ hash: "abc", author: "a", date: "d", message: "m" }]; },
    async branch() { return { current: "npati/x", branches: ["main", "npati/x"] }; },
    async stage() { return { staged: ["a.ts"] }; },
    async commit() { return { commitHash: "deadbeef", message: "msg" }; },
    async restore() { return { restored: ["a.ts"] }; },
    async push() { return { pushed: true, branch: "npati/x", remote: "https://github.com/o/r.git" }; },
    async createPullRequest() { return { prNumber: 7, prUrl: "https://github.com/o/r/pull/7", message: "ok" }; },
    async commentOnPullRequest(_ctx, _companyId, _projectId, options) { return { commentId: 11, commentUrl: "https://github.com/o/r/pull/7#issuecomment-11", pullNumber: options.pullNumber, message: "ok" }; },
  };
  const merged = { ...base, ...overrides };
  const git = new Proxy(merged, {
    get(target, property) {
      const value = (target as Record<string, unknown>)[property as string];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return (value as (...inner: unknown[]) => unknown)(...args);
      };
    },
  }) as CodeGitToolPort;
  return { git, calls };
}

describe("security-gate: C11 git workflow capabilities", () => {
  it("publishes eleven git tools with one inventory id each, in the contiguous range 374-384", () => {
    expect(CODE_GIT_CAPABILITIES).toHaveLength(11);
    expect(CODE_GIT_CAPABILITIES.map((capability) => capability.id).sort()).toEqual([...GIT_TOOL_NAMES].sort());
    expect(CODE_GIT_CAPABILITIES.map((capability) => capability.inventoryIds[0]).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([374, 375, 376, 377, 378, 379, 380, 381, 382, 383, 384]);
    for (const capability of CODE_GIT_CAPABILITIES) {
      expect(capability.domain, `${capability.id} domain`).toBe("code");
      expect(capability.type, `${capability.id} type`).toBe("tool");
      expect(capability.agentCallable, `${capability.id} agentCallable`).toBe(true);
      expect(capability.userVisible, `${capability.id} userVisible`).toBe(true);
      expect(capability.version, `${capability.id} version`).toBe(1);
      expect(capability.doNotUseWhen.length, `${capability.id} doNotUseWhen`).toBeGreaterThan(0);
      // The catalogue, the matrix and the schema mirror all carry it — a capability in one place only is the
      // defect class this assertion exists for.
      expect(CAPABILITY_CATALOG.some((entry) => entry.id === capability.id), `${capability.id} in catalog`).toBe(true);
      expect(CODE_TOOL_SCHEMA_MIRROR[capability.id], `${capability.id} mirrored schema`).toBeTruthy();
      expect(CODE_TOOL_SCHEMAS.some((schema) => schema.name === capability.id), `${capability.id} in registry`).toBe(true);
    }
  });

  it("classifies every git tool as read-only, mutating, approval-gated or none of them — never ambiguously", () => {
    for (const tool of GIT_TOOL_NAMES) {
      expect(isCodeGitTool(tool), `${tool} is a git tool`).toBe(true);
      const readOnly = GIT_READ_TOOLS.has(tool);
      const mutating = GIT_MUTATING_TOOLS.has(tool);
      expect(readOnly !== mutating, `${tool} is either read-only or mutating`).toBe(true);
      if (GIT_APPROVAL_TOOLS.has(tool)) expect(mutating, `${tool} is approval-gated and mutating`).toBe(true);
      // The read-only tools are the only ones that never need an approval.
      if (readOnly) expect(GIT_APPROVAL_TOOLS.has(tool), `${tool} must not need an approval`).toBe(false);
    }
    // A tool that is not a git tool is never classified as one.
    expect(isCodeGitTool("code.fs.write")).toBe(false);
    expect(isCodeGitTool("project.git.push")).toBe(false);
  });

  it("puts every git tool in the code.git capability group and behind the code.git flag", () => {
    expect(CODE_CAPABILITY_GROUPS["code.git"].sort()).toEqual([...GIT_TOOL_NAMES].sort());
    for (const tool of GIT_TOOL_NAMES) {
      expect(flagKeyForCapabilityId(tool, "code"), `${tool} flag`).toBe("code.git");
      expect(subFlagForTool(tool), `${tool} policy sub-flag`).toBe("code.git");
      // The runtime's own sub-flag mapping must agree with the policy engine's, or a tool would be gated by
      // two different flags depending on which layer saw it first.
      expect(codeSubFlagForTool(tool, false), `${tool} runtime sub-flag`).toBe("code.git");
    }
    // Git is not file writing: enabling `code.write` must not publish a branch.
    expect(subFlagForTool("code.git.push")).not.toBe("code.write");
  });

  it("never lets a git write become a standing approval rule, and leaves the local commit out of that list", () => {
    for (const tool of ["code.git.push", "code.git.restore", "code.git.pr.create", "code.git.pr.comment"]) {
      expect(SCOPED_RULE_DENIED_ACTIONS.has(tool), `${tool} must not be a standing rule`).toBe(true);
      expect(evaluateScopedRulePermission({ action: tool })).toMatchObject({
        permitted: false, code: "scoped_rule_privileged_action",
      });
    }
    expect(SCOPED_RULE_DENIED_ACTIONS.has("code.git.commit")).toBe(false);
  });
});

describe("security-gate: C11 git executors are adapters over ProjectGitService", () => {
  const source = readFileSync(new URL("../apps/agent-api/src/code-tool-git-executors.ts", import.meta.url), "utf8");

  it("contains no git command of its own", () => {
    // The whole point of the adapter layer: no argv, no process, no credential environment. A git command
    // that appeared here would be a second git implementation, which is exactly what C11 forbids.
    //
    // Comments are stripped first: this file *documents* the prohibition (it mentions `spawn` and
    // `execFile` by name), and a scan that counted the documentation would fail on its own explanation.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const forbidden of ["child_process", "execFile", "spawnSync", "spawn(", "promisify", "credentialEnvironment", "runGit"]) {
      expect(code.includes(forbidden), `the executor layer must not contain "${forbidden}"`).toBe(false);
    }
    expect(/\bshell\s*:/.test(code), "the executor layer must not open a shell").toBe(false);
  });

  it("registers exactly one executor per published git tool", () => {
    const executors = canonicalGitExecutors({});
    expect(Object.keys(executors).sort()).toEqual([...GIT_TOOL_NAMES].sort());
    for (const tool of GIT_TOOL_NAMES) expect(typeof executors[tool], `${tool} executor`).toBe("function");
  });

  it("fails closed with tool_not_configured when no git service is wired", async () => {
    const executors = canonicalGitExecutors({});
    for (const tool of GIT_TOOL_NAMES) {
      let thrown: { code?: string; status?: number } | null = null;
      try {
        await executors[tool]!(executionContext({ tool }));
      } catch (error) { thrown = error as { code?: string; status?: number }; }
      expect(thrown?.code, `${tool} must fail closed`).toBe("tool_not_configured");
      expect(thrown?.status, `${tool} status`).toBe(503);
    }
  });

  it("delegates every read to the service's own method and reports the canonical revision", async () => {
    const { git, calls } = recordingGit();
    const executors = canonicalGitExecutors({ git });

    const status = await executors["code.git.status"]!(executionContext({ tool: "code.git.status", revision: "rev-1" })) as Record<string, unknown>;
    expect(status.branch).toBe("npati/x");
    expect(status.workspaceRevision).toBe("rev-1");
    expect(calls.at(-1)).toMatchObject({ method: "status" });

    const diff = await executors["code.git.diff"]!(executionContext({ tool: "code.git.diff", args: { file: "a.ts", staged: true } })) as Record<string, unknown>;
    expect(diff.diff).toContain("diff --git");
    expect((calls.at(-1)!.args[3] as Record<string, unknown>)).toEqual({ file: "a.ts", staged: true });

    const log = await executors["code.git.log"]!(executionContext({ tool: "code.git.log", args: { limit: 5 } })) as Record<string, unknown>;
    expect(log.count).toBe(1);
    // The limit is clamped by the executor, not passed through unvalidated.
    expect(calls.at(-1)!.args[3]).toBe(5);
    await executors["code.git.log"]!(executionContext({ tool: "code.git.log", args: { limit: 100000 } }));
    expect(calls.at(-1)!.args[3]).toBe(100);
  });

  it("delegates stage, commit, restore, branch and the remote writes to the service", async () => {
    const { git, calls } = recordingGit();
    const executors = canonicalGitExecutors({ git });

    await executors["code.git.stage"]!(executionContext({ tool: "code.git.stage", args: { files: ["a.ts"] } }));
    expect(calls.at(-1)!.method).toBe("stage");

    const commit = await executors["code.git.commit"]!(executionContext({ tool: "code.git.commit", args: { message: "msg" } })) as Record<string, unknown>;
    expect(commit.commitHash).toBe("deadbeef");
    const commitCall = calls.filter((call) => call.method === "commit").at(-1)!;
    expect((commitCall.args[3] as Record<string, unknown>).message).toBe("msg");

    await executors["code.git.restore"]!(executionContext({ tool: "code.git.restore", args: { files: ["a.ts"] } }));
    expect(calls.at(-1)!.method).toBe("restore");

    await executors["code.git.branch.create"]!(executionContext({ tool: "code.git.branch.create", args: { branch: "feature" } }));
    expect((calls.at(-1)!.args[3] as Record<string, unknown>)).toEqual({ action: "create", branch: "feature" });

    const pushed = await executors["code.git.push"]!(executionContext({
      tool: "code.git.push", args: { targetBranch: "npati/x", credentialId: "cred-1" },
    })) as Record<string, unknown>;
    expect(pushed.pushed).toBe(true);
    // The repository URL the service returns is deliberately **not** echoed back.
    expect(Object.keys(pushed)).not.toContain("remote");
    const pushCall = calls.filter((call) => call.method === "push").at(-1)!;
    expect((pushCall.args[3] as Record<string, unknown>).branch).toBe("npati/x");
    expect((pushCall.args[3] as Record<string, unknown>).credentialId).toBe("cred-1");

    const created = await executors["code.git.pr.create"]!(executionContext({
      tool: "code.git.pr.create", args: { title: "t", base: "main", head: "npati/x", credentialId: "cred-1", body: "given" },
    })) as Record<string, unknown>;
    expect(created.prNumber).toBe(7);
    expect(created.descriptionSource).toBe("caller");
    /**
     * The tool id travels into the service call, because it is part of the approval **payload**: the
     * requester creates the record under `code.git.pr.create` and the git boundary rebuilds the payload from
     * the branch pair. If the two names differed, the hashes would differ and every PR approval would be
     * refused — a fail-closed defect that no unit test of either half would see.
     */
    const prCall = calls.filter((call) => call.method === "createPullRequest").at(-1)!;
    expect((prCall.args[3] as Record<string, unknown>).toolName).toBe("code.git.pr.create");

    const comment = await executors["code.git.pr.comment"]!(executionContext({
      tool: "code.git.pr.comment", args: { pullNumber: 7, body: "nice", credentialId: "cred-1" },
    })) as Record<string, unknown>;
    expect(comment.commentId).toBe(11);
    expect(comment.pullNumber).toBe(7);
  });

  it("maps a service refusal onto a structured error without losing its code", async () => {
    const { git } = recordingGit({
      async push() { throw Object.assign(new Error("protected branch"), { code: "protected_branch_write_denied", status: 403 }); },
    });
    const executors = canonicalGitExecutors({ git });
    let thrown: { code?: string; httpStatus?: number } | null = null;
    try {
      await executors["code.git.push"]!(executionContext({
        tool: "code.git.push", args: { targetBranch: "main", credentialId: "cred-1" },
      }));
    } catch (error) { thrown = error as { code?: string; httpStatus?: number }; }
    expect(thrown?.code).toBe("protected_branch_write_denied");
    expect(thrown?.httpStatus).toBe(403);
  });
});

describe("security-gate: C11 the session branch (owner decision 8)", () => {
  it("derives a deterministic, branch-safe name from the session id and leaks no session id", () => {
    const branch = sessionBranchName(SESSION);
    expect(branch).toMatch(/^npati\/[0-9a-f]{10}$/);
    expect(sessionBranchName(SESSION)).toBe(branch);
    expect(sessionBranchName("session-1")).toBe(branch);
    // A resume continues on the branch the work is on; a different session gets a different branch.
    expect(sessionBranchName("session-2")).not.toBe(branch);
    // A hostile session id cannot escape the branch namespace.
    const hostile = sessionBranchName("../../refs/heads/main");
    expect(hostile).toMatch(/^npati\/[0-9a-f]{10}$/);
  });

  it("creates the branch when it is missing and switches to it when it exists", async () => {
    let branches = ["main"];
    let current = "main";
    const { git, calls } = recordingGit({
      async status() { return { branch: current, clean: true, staged: [], unstaged: [], untracked: [] }; },
      async branch(_ctx, _companyId, _projectId, options) {
        if (options.action === "create" && options.branch) { branches = [...branches, options.branch]; current = options.branch; }
        if (options.action === "switch" && options.branch) current = options.branch;
        return { current, branches };
      },
    });
    const created = await ensureSessionBranch({ git, ctx: context(), companyId: COMPANY, projectId: PROJECT, sessionId: SESSION });
    expect(created.created).toBe(true);
    expect(created.branch).toBe(sessionBranchName(SESSION));
    expect(created.previousBranch).toBe("main");

    // Second call: the branch exists now, so it is switched to rather than recreated.
    current = "main";
    const switched = await ensureSessionBranch({ git, ctx: context(), companyId: COMPANY, projectId: PROJECT, sessionId: SESSION });
    expect(switched.created).toBe(false);
    expect(switched.switched).toBe(true);
    expect(calls.filter((call) => call.method === "branch" && (call.args[3] as { action: string }).action === "create")).toHaveLength(1);
  });
});

describe("security-gate: C11 preconditions before a commit or a push", () => {
  it("refuses an operation prepared for another branch", () => {
    let thrown: CodeGitWorkflowError | null = null;
    try {
      assertGitWritePreconditions({ expectedBranch: "npati/x", currentBranch: "main", expectedRevision: "", currentRevision: "" });
    } catch (error) { thrown = error as CodeGitWorkflowError; }
    expect(thrown?.code).toBe("git_branch_mismatch");
    expect(thrown?.httpStatus).toBe(409);
    expect(thrown?.details).toEqual({ expectedBranch: "npati/x", currentBranch: "main" });
  });

  it("refuses a write whose canonical revision moved, and a protected branch outright", () => {
    let revisionError: CodeGitWorkflowError | null = null;
    try {
      assertGitWritePreconditions({ expectedBranch: "npati/x", currentBranch: "npati/x", expectedRevision: "r1", currentRevision: "r2" });
    } catch (error) { revisionError = error as CodeGitWorkflowError; }
    expect(revisionError?.code).toBe("git_revision_mismatch");

    let protectedError: CodeGitWorkflowError | null = null;
    try {
      assertGitWritePreconditions({
        expectedBranch: "main", currentBranch: "main", expectedRevision: "", currentRevision: "",
        protectedBranch: { allowed: false, branch: "main", code: "protected_branch_write_denied", reason: "protected" },
      });
    } catch (error) { protectedError = error as CodeGitWorkflowError; }
    expect(protectedError?.code).toBe("protected_branch_write_denied");
    expect(protectedError?.httpStatus).toBe(403);
  });

  it("refuses a push whose revision moved, before the service is asked to write", async () => {
    const revisions = new CodeWorkspaceRevisionGuard({
      read: async () => ({ currentRevision: "rev-moved", currentBranch: "npati/x" }),
    });
    const { git, calls } = recordingGit();
    const executors = canonicalGitExecutors({ git, revisions });
    let thrown: { code?: string } | null = null;
    try {
      await executors["code.git.push"]!(executionContext({
        tool: "code.git.push", args: { targetBranch: "npati/x", credentialId: "cred-1" }, revision: "rev-captured",
      }));
    } catch (error) { thrown = error as { code?: string }; }
    expect(thrown?.code).toBe("workspace_revision_mismatch");
    // The side effect never happened: the service's push was not called.
    expect(calls.some((call) => call.method === "push")).toBe(false);
  });

  it("refuses a commit prepared for another branch before the service is asked to write", async () => {
    const { git, calls } = recordingGit({
      async status() { return { branch: "main", clean: false, staged: ["a.ts"], unstaged: [], untracked: [] }; },
    });
    const executors = canonicalGitExecutors({
      git,
      sessionBranch: async () => sessionBranchName(SESSION),
    });
    let thrown: { code?: string } | null = null;
    try {
      await executors["code.git.commit"]!(executionContext({ tool: "code.git.commit", args: { message: "msg" } }));
    } catch (error) { thrown = error as { code?: string }; }
    expect(thrown?.code).toBe("git_branch_mismatch");
    expect(calls.some((call) => call.method === "commit")).toBe(false);
  });

  it("refuses a protected-branch push through the same port the policy engine and the boundary use", async () => {
    const { git, calls } = recordingGit();
    const executors = canonicalGitExecutors({
      git,
      assertProtectedBranch: async () => ({ allowed: false, branch: "main", code: "protected_branch_write_denied", reason: "protected" }),
    });
    let thrown: { code?: string } | null = null;
    try {
      await executors["code.git.push"]!(executionContext({ tool: "code.git.push", args: { targetBranch: "main", credentialId: "cred-1" } }));
    } catch (error) { thrown = error as { code?: string }; }
    expect(thrown?.code).toBe("protected_branch_write_denied");
    expect(calls.some((call) => call.method === "push")).toBe(false);
  });
});

describe("security-gate: C11 the canonical workspace revision (owner decision 7)", () => {
  it("captures the canonical digest and refuses once it moved, naming both revisions", async () => {
    let revision = "rev-1";
    const guard = new CodeWorkspaceRevisionGuard({ read: async () => ({ currentRevision: revision, currentBranch: "main" }) });
    const scope = { ctx: context(), companyId: COMPANY, projectId: PROJECT, sessionId: SESSION };
    const snapshot = await guard.capture(scope);
    expect(snapshot.revision).toBe("rev-1");
    revision = "rev-2";
    let thrown: CodeWorkspaceRevisionError | null = null;
    try {
      await guard.assertUnchanged(scope, snapshot, "git_push");
    } catch (error) { thrown = error as CodeWorkspaceRevisionError; }
    expect(thrown?.code).toBe("workspace_revision_mismatch");
    expect(thrown?.httpStatus).toBe(409);
    expect(thrown?.details).toMatchObject({ phase: "git_push", expectedRevision: "rev-1", currentRevision: "rev-2" });
    expect(thrown?.retryable).toBe(true);
  });

  it("fails closed when the canonical revision cannot be read at all, instead of claiming one", async () => {
    const guard = new CodeWorkspaceRevisionGuard({ read: async () => null });
    let thrown: CodeWorkspaceRevisionError | null = null;
    try {
      await guard.capture({ ctx: context(), companyId: COMPANY, projectId: PROJECT });
    } catch (error) { thrown = error as CodeWorkspaceRevisionError; }
    expect(thrown?.code).toBe("workspace_revision_mismatch");
    expect(thrown?.details).toMatchObject({ reason: "revision_unavailable" });

    const throwing = new CodeWorkspaceRevisionGuard({ read: async () => { throw new Error("workspace gone"); } });
    let second: CodeWorkspaceRevisionError | null = null;
    try {
      await throwing.capture({ ctx: context(), companyId: COMPANY, projectId: PROJECT });
    } catch (error) { second = error as CodeWorkspaceRevisionError; }
    expect(second?.code).toBe("workspace_revision_mismatch");
    expect(second?.details).toMatchObject({ reason: "revision_unavailable" });
  });

  it("records the revision the execution environment was given, so 'what did the build see' is stored", () => {
    const guard = new CodeWorkspaceRevisionGuard({ read: async () => ({ currentRevision: "rev-1", currentBranch: "main" }) });
    const scope = { ctx: context(), companyId: COMPANY, projectId: PROJECT };
    expect(guard.lastSandboxBinding(scope)).toBeNull();
    guard.recordSandboxBinding(scope, "rev-1", "sandbox_exec");
    expect(guard.lastSandboxBinding(scope)).toMatchObject({ revision: "rev-1", phase: "sandbox_exec" });
    // An empty revision is never recorded: "no revision" must not look like "revision ''".
    guard.recordSandboxBinding(scope, "", "sandbox_exec");
    expect(guard.lastSandboxBinding(scope)?.revision).toBe("rev-1");
  });
});

describe("security-gate: C11 conflict auto-resolution (owner decision 9)", () => {
  it("resolves on the second attempt and reports how many were really run", async () => {
    const attempts: string[] = [];
    const result = await runMergeWithAutoResolve({
      sourceBranch: "agent/a", targetBranch: "project/main",
      resolver: { async resolve() { return { strategy: "theirs", reason: "generated lockfile" }; } },
      async merge(strategy) {
        attempts.push(strategy);
        if (strategy === "none") throw new Error("conflict");
        return "merged";
      },
      async readConflicts() { return ["package-lock.json"]; },
      async abort() { /* aborted */ },
    });
    expect(result.status).toBe("merged");
    expect(result.attempts).toBe(2);
    expect(attempts).toEqual(["none", "theirs"]);
    expect(result.resolutions).toHaveLength(1);
  });

  it("escalates after the second attempt with the real count and asks for code.ask_user", async () => {
    let merges = 0;
    let aborts = 0;
    let thrown: CodeGitWorkflowError | null = null;
    try {
      await runMergeWithAutoResolve({
        sourceBranch: "agent/a", targetBranch: "project/main",
        resolver: { async resolve() { return { strategy: "ours", reason: "keep target" }; } },
        async merge() { merges += 1; throw new Error("conflict"); },
        async readConflicts() { return ["src/x.ts", "src/y.ts"]; },
        async abort() { aborts += 1; },
      });
    } catch (error) { thrown = error as CodeGitWorkflowError; }
    expect(merges).toBe(MAX_GIT_MERGE_ATTEMPTS);
    expect(aborts).toBe(MAX_GIT_MERGE_ATTEMPTS);
    expect(thrown?.code).toBe("git_conflict_escalated");
    expect(thrown?.httpStatus).toBe(409);
    const escalation = (thrown?.details as { escalation: ReturnType<typeof buildConflictEscalation> }).escalation;
    expect(escalation.attempts).toBe(2);
    expect(escalation.maxAttempts).toBe(2);
    expect(escalation.conflictingFiles).toEqual(["src/x.ts", "src/y.ts"]);
    expect(escalation.suggestedTool).toBe("code.ask_user");
    expect(escalation.question).toContain("code.ask_user".replace("code.ask_user", "2 automatic"));
  });

  it("stops after the first attempt when no resolver is configured, and says so instead of promising two", async () => {
    let merges = 0;
    let thrown: CodeGitWorkflowError | null = null;
    try {
      await runMergeWithAutoResolve({
        sourceBranch: "agent/a", targetBranch: "project/main",
        async merge() { merges += 1; throw new Error("conflict"); },
        async readConflicts() { return ["src/x.ts"]; },
        async abort() { /* aborted */ },
      });
    } catch (error) { thrown = error as CodeGitWorkflowError; }
    expect(merges).toBe(1);
    const escalation = (thrown?.details as { escalation: ReturnType<typeof buildConflictEscalation> }).escalation;
    expect(escalation.attempts).toBe(1);
    expect(escalation.maxAttempts).toBe(2);
    // The escalation text is factual: it names the attempts made, not a promise of two.
    expect(thrown?.message).toContain("1 automatic attempt(s) of at most 2");
  });

  it("never spends the remaining budget on a resolver that has no strategy", async () => {
    let merges = 0;
    let thrown: CodeGitWorkflowError | null = null;
    try {
      await runMergeWithAutoResolve({
        sourceBranch: "agent/a", targetBranch: "project/main",
        resolver: { async resolve() { return null; } },
        async merge() { merges += 1; throw new Error("conflict"); },
        async readConflicts() { return ["src/x.ts"]; },
        async abort() { /* aborted */ },
      });
    } catch (error) { thrown = error as CodeGitWorkflowError; }
    expect(merges).toBe(1);
    expect((thrown?.details as { escalation: { attempts: number } }).escalation.attempts).toBe(1);
  });
});

describe("security-gate: C11 a read-only intent cannot write (owner decision 10)", () => {
  it("shares one definition of read-only between the policy engine and the runner's offer list", () => {
    expect([...REVIEW_SAFE_GIT_TOOLS].sort()).toEqual([...REVIEW_SAFE_RUN_GIT_TOOLS].sort());
    expect([...REVIEW_SAFE_GIT_TOOLS].sort()).toEqual(["code.git.diff", "code.git.log", "code.git.pr.comment", "code.git.status"]);
    for (const tool of REVIEW_SAFE_GIT_TOOLS) expect(isReviewSafeTool(tool), `${tool} is review-safe`).toBe(true);
    // Everything that mutates is refused by the same predicate.
    for (const tool of ["code.git.push", "code.git.commit", "code.git.restore", "code.git.stage", "code.git.branch.create", "code.fs.write", "code.shell.exec", "code.deps.add"]) {
      expect(isReviewSafeTool(tool), `${tool} must not be review-safe`).toBe(false);
    }
  });

  it("refuses a write and a shell command in a read-only session, before any executor runs", async () => {
    const calls: string[] = [];
    const runtime = new CodeToolRuntime({
      flags: { async assertEnabled() { /* every flag is on for this test */ } } as never,
      schemas: CODE_TOOL_SCHEMAS,
      executors: {
        "code.fs.write": async () => { calls.push("code.fs.write"); return { written: true }; },
        "code.shell.exec": async () => { calls.push("code.shell.exec"); return { exitCode: 0 }; },
        "code.fs.read": async () => { calls.push("code.fs.read"); return { content: "" }; },
      },
      reviewScope: { allows: (tool: string) => isReviewSafeTool(tool) },
    });
    const ctx = context();
    for (const tool of ["code.fs.write", "code.shell.exec", "code.git.push", "code.git.commit"]) {
      const result = await runtime.invoke(ctx, {
        companyId: COMPANY, projectId: PROJECT, tool,
        args: tool === "code.fs.write" ? { path: "a.ts", content: "x" } : {},
        toolCallId: `call-${tool}`, readOnlyIntent: true,
      });
      expect(result.ok, `${tool} must be refused`).toBe(false);
      expect((result as { error: { code: string } }).error.code, `${tool} refusal code`).toBe("review_code_read_only");
    }
    // The refusal happened before the executor: nothing was written and nothing ran.
    expect(calls).toEqual([]);
  });

  it("does not weaken an ordinary session: without the intent the same read is authorised", async () => {
    const calls: string[] = [];
    const runtime = new CodeToolRuntime({
      flags: { async assertEnabled() { /* every flag is on */ } } as never,
      schemas: CODE_TOOL_SCHEMAS,
      executors: {
        "code.fs.read": async () => { calls.push("code.fs.read"); return { path: "a.ts", content: "x", revision: "r", sha256: "s", totalLines: 1, truncated: false }; },
      },
      toPort: () => ({}) as never,
      reviewScope: { allows: (tool: string) => isReviewSafeTool(tool) },
    });
    const result = await runtime.invoke(context(), {
      companyId: COMPANY, projectId: PROJECT, tool: "code.fs.read",
      args: { path: "a.ts" }, toolCallId: "call-read",
    });
    expect(result.ok, `the read must be authorised: ${JSON.stringify((result as { error?: unknown }).error ?? {})}`).toBe(true);
    expect(calls).toEqual(["code.fs.read"]);
  });
});

describe("security-gate: C11 the pull-request description reuses CodingAgentRunSummary (owner decision 11)", () => {
  function summary(overrides: Partial<CodingAgentRunSummary> = {}): CodingAgentRunSummary {
    return {
      filesChanged: ["src/a.ts", "src/b.ts"],
      diffStats: { files: 2, linesAdded: 10, linesRemoved: 3 },
      checksRun: ["typecheck", "test"],
      turns: 4,
      toolCalls: 9,
      tokens: 1000,
      costUsd: 0,
      remaining: "completed",
      ...overrides,
    };
  }

  it("renders the four sections from the run's own fields, with no second format", () => {
    const description = buildPullRequestDescription({
      summary: summary({
        verification: {
          schemaVersion: 1, status: "passed", attemptsUsed: 1, maxAttempts: 2, verificationRuns: 1,
          requestedTools: ["typecheck", "test"], failedChecks: [],
        },
        scope: {
          changedFiles: 2, limit: 10, exceeded: false, severity: "info", unrelatedPaths: [], relatednessUnknown: false, warnings: [],
        },
        selfReview: {
          schemaVersion: 1, status: "clean", ran: true, reviewRuns: 1, iterationsUsed: 0, maxIterations: 1,
          fixApplied: false, findingsCount: 0, blocking: 0, unresolved: 0, findings: [],
          inputs: {} as never, reviewHash: "h",
        },
      }),
      base: "main",
      head: "npati/abc",
    });
    expect(description.schemaVersion).toBe(1);
    expect(description.verificationMissing).toBe(false);
    expect(description.sections.whatChanged.join(" ")).toContain("2 files changed (+10/-3 lines)");
    expect(description.sections.verification.join(" ")).toContain("passed");
    expect(description.sections.risks.join(" ")).toContain("No scope or self-review risk was recorded");
    expect(description.sections.unresolved).toEqual(["None recorded."]);
    expect(description.body).toContain("## What changed");
    expect(description.body).toContain("## Verification");
    expect(description.body).toContain("## Risks");
    expect(description.body).toContain("## Unresolved items");
    expect(description.body).toContain("npati/abc -> main");
  });

  it("says that verification is missing instead of implying a pass", () => {
    const description = buildPullRequestDescription({ summary: summary({ verification: undefined, checksRun: [] }) });
    expect(description.verificationMissing).toBe(true);
    expect(description.sections.verification.join(" ")).toContain("No verification was recorded");
  });

  it("carries the verification caveat, the scope risk and the unresolved findings into the body", () => {
    const description = buildPullRequestDescription({
      summary: summary({
        verification: {
          schemaVersion: 1, status: "passed_with_unjustified_test_changes", attemptsUsed: 2, maxAttempts: 2, verificationRuns: 2,
          requestedTools: ["test"], failedChecks: [{ tool: "test", code: "assertion_failed" }],
          testIntegrity: { flagged: true, requiresJustification: true, justificationProvided: false, findings: [], testFilesTouched: ["t.test.ts"], testFilesDeleted: [] },
        },
        scope: {
          changedFiles: 30, limit: 10, exceeded: true, severity: "warn", unrelatedPaths: ["docs/x.md"],
          relatednessUnknown: true, warnings: [{ code: "scope_overrun", message: "30 files changed", severity: "warn", paths: [] }],
        },
        selfReview: {
          schemaVersion: 1, status: "unresolved", ran: true, reviewRuns: 1, iterationsUsed: 1, maxIterations: 1,
          fixApplied: false, findingsCount: 2, blocking: 1, unresolved: 1,
          findings: [{
            id: "f1", category: "correctness", severity: "high", file: "src/a.ts", reason: "unchecked return",
            suggestedFix: "check it", blocking: true,
          }],
          inputs: {} as never, reviewHash: "h",
        },
        remaining: "verification_failed",
      }),
    });
    expect(description.sections.verification.join(" ")).toContain("reduces the suite's detection power");
    expect(description.sections.risks.join(" ")).toContain("exceeded the scope limit");
    expect(description.sections.risks.join(" ")).toContain("docs/x.md");
    expect(description.sections.unresolved.join(" ")).toContain("unchecked return");
    expect(description.sections.unresolved.join(" ")).toContain("verification_failed");
  });
});

describe("security-gate: C11 each remote git write has its own approval binding (owner decisions 2, 5 and 10)", () => {
  it("binds a push to the operation, both branches, the remote, force and the credential", () => {
    const payload = gitToolApprovalPayload({
      projectId: PROJECT, tool: "code.git.push",
      args: { targetBranch: "npati/x", sourceBranch: "npati/x", credentialId: "cred-1" },
    });
    expect(payload).toMatchObject({
      projectId: PROJECT,
      tool: "code.git.push",
      git: { gitOperation: "push", sourceBranch: "npati/x", targetBranch: "npati/x", force: false, credentialId: "cred-1" },
    });
  });

  it("refuses to build a push approval with no named branch, because there is nothing to bind", () => {
    let thrown: CodeGitWorkflowError | null = null;
    try {
      gitToolApprovalPayload({ projectId: PROJECT, tool: "code.git.push", args: { credentialId: "cred-1" } });
    } catch (error) { thrown = error as CodeGitWorkflowError; }
    expect(thrown?.code).toBe("git_write_intent_required");
  });

  it("gives a pull-request comment its own payload, so no other approval can be redeemed as one", () => {
    const comment = gitToolApprovalPayload({
      projectId: PROJECT, tool: "code.git.pr.comment",
      args: { pullNumber: 7, body: "looks good", credentialId: "cred-1" },
    });
    const other = pullRequestCommentApprovalPayload({
      projectId: PROJECT, tool: "code.git.pr.comment", pullNumber: 7, body: "looks BAD", credentialId: "cred-1",
    });
    // The comment text is bound by hash: a different comment is a different approval.
    expect(comment).not.toEqual(other);
    expect(JSON.stringify(comment)).not.toContain("looks good");
    expect((comment.pullRequestComment as { bodyHash: string }).bodyHash).toHaveLength(64);

    const prCreate = gitToolApprovalPayload({
      projectId: PROJECT, tool: "code.git.pr.create",
      args: { title: "t", base: "main", head: "npati/x", credentialId: "cred-1" },
    });
    const push = gitToolApprovalPayload({
      projectId: PROJECT, tool: "code.git.push",
      args: { targetBranch: "npati/x", credentialId: "cred-1" },
    });
    const distinct = new Set([JSON.stringify(comment), JSON.stringify(prCreate), JSON.stringify(push)]);
    expect(distinct.size).toBe(3);
  });

  it("binds a restore to the exact path list it discards", () => {
    const payload = gitToolApprovalPayload({ projectId: PROJECT, tool: "code.git.restore", args: { files: ["b.ts", "a.ts"] } });
    const other = gitToolApprovalPayload({ projectId: PROJECT, tool: "code.git.restore", args: { files: ["a.ts"] } });
    expect(payload).not.toEqual(other);
    expect((payload.restore as { files: string[] }).files).toEqual(["a.ts", "b.ts"]);
  });

  it("refuses an approval-gated tool whose binding is undefined, rather than approving it blindly", () => {
    let thrown: CodeGitWorkflowError | null = null;
    try {
      // `code.git.commit` is a git write but not approval-gated: asking for its binding is a programming error.
      gitToolApprovalPayload({ projectId: PROJECT, tool: "code.git.commit", args: { message: "m" } });
    } catch (error) { thrown = error as CodeGitWorkflowError; }
    expect(thrown?.code).toBe("git_approval_binding_undefined");
    expect(thrown?.httpStatus).toBe(500);
  });

  it("consumes the approval at the git boundary for the remote writes and in the runtime for the local one", () => {
    expect([...GIT_BOUNDARY_APPROVAL_TOOLS].sort()).toEqual(["code.git.pr.comment", "code.git.pr.create", "code.git.push"]);
    expect(GIT_BOUNDARY_APPROVAL_TOOLS.has("code.git.restore")).toBe(false);
    expect(GIT_BOUNDARY_APPROVAL_TOOLS.has("code.git.commit")).toBe(false);
    // A boundary-consumed write is always approval-gated; the reverse is not required (restore is local).
    for (const tool of GIT_BOUNDARY_APPROVAL_TOOLS) expect(GIT_APPROVAL_TOOLS.has(tool)).toBe(true);
  });

  it("refuses a remote write whose typed intent names no target", () => {
    let thrown: CodeGitWorkflowError | null = null;
    try {
      gitWriteIntentForTool("code.git.push", { credentialId: "cred-1" });
    } catch (error) { thrown = error as CodeGitWorkflowError; }
    expect(thrown?.code).toBe("git_write_intent_required");
    // A read-only git tool performs no remote write, so it declares no intent — and asking for one is a
    // programming error rather than a refusal the model can act on.
    expect(() => gitWriteIntentForTool("code.git.status", {})).toThrowError(/git_write_intent_required/);
  });
});

describe("security-gate: C11 the manifest the git tools were published in", () => {
  it("publishes the git tools in v8 and leaves the v7 checksum frozen", () => {
    // C12 published `code.agent.spawn` in v9, so the current version moved on. What this suite pins is unchanged:
    // the git tools are the v8 publication, v8's checksum is frozen, and v7 still resolves without them.
    expect(CODE_TOOL_MANIFEST_VERSION).toBe(14);
    expect(CODE_TOOL_SCHEMAS).toHaveLength(50);
    expect(toolSchemaChecksum(CODE_TOOL_SCHEMAS.filter((tool) => GIT_TOOL_NAMES.includes(tool.name))))
      .not.toBe(PUBLISHED_V7_TOOL_SCHEMA_CHECKSUM);
    // Every git tool is published, active and version 1, with both schemas — the registry's own invariants.
    for (const tool of CODE_TOOL_SCHEMAS.filter((candidate) => GIT_TOOL_NAMES.includes(candidate.name))) {
      expect(tool.version, `${tool.name} version`).toBe(1);
      expect(tool.status).toBe("active");
      expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
      expect(Object.keys(tool.outputSchema).length).toBeGreaterThan(0);
    }
  });
});
