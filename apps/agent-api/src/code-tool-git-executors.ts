/**
 * C11 (owner decision 2) — the `code.git.*` executors.
 *
 * These are **adapters and nothing else**. Every git command lives in `ProjectGitService`; this module
 * shapes the tool's typed arguments into the service's own request objects, bounds what goes back to the
 * model, and maps a service refusal onto the runtime's structured error without losing its code. There is no
 * `spawn`, no `execFile`, no argv and no `git` string anywhere in this file — a grep for a git command in
 * the executor layer is the check that this stayed true, and `tests/coding-agent-c11-git-workflow.test.ts`
 * asserts it over the source.
 *
 * Three things are deliberately enforced *here*, before the port is called, because they are preconditions
 * of the call rather than properties of a git command:
 *
 *  1. **the session branch** — a commit or a push asserts that the canonical workspace is on the branch the
 *     session is supposed to be working on (`npati/<session-short-id>`), so a run cannot silently land on
 *     `main` because somebody checked it out in between;
 *  2. **the canonical revision** — the revision the call was authorised against is re-checked through
 *     `CodeWorkspaceRevisionGuard`, so a git operation never acts on bytes nobody authorised
 *     (`workspace_revision_mismatch`, fail closed);
 *  3. **the protected-branch decision** — for a remote write the typed intent is handed to the caller's
 *     protected-branch port, which is the *same* decision the policy engine's phase 4b and the git boundary
 *     make, so all three agree by construction rather than by coincidence.
 *
 * The credential is a **reference** in the arguments and is never echoed back: the result reports the branch
 * and the pull-request URL, never a token, never the repository's credential-bearing URL.
 */

import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import {
  CodeGitWorkflowError,
  assertGitWritePreconditions,
  gitWriteIntentForTool,
  sessionBranchName,
} from "./code-git-workflow";
import type { CodeWorkspaceRevisionGuard, CodeWorkspaceRevisionSnapshot } from "./code-workspace-revision";

/** Bounds on what a git tool may return: the model reads lists and diffs, never a whole repository. */
export const GIT_TOOL_LIMITS = Object.freeze({
  maxPaths: 500,
  maxLogEntries: 100,
  maxDiffChars: 128_000,
});

export interface GitStatusResult { branch: string; clean: boolean; staged: string[]; unstaged: string[]; untracked: string[] }
export interface GitLogEntry { hash: string; author: string; date: string; message: string }
export interface GitBranchResult { current: string; branches: string[] }
export interface GitWriteApprovalRequest { approvalId: string; runId: string; agentId: string; toolName: string }

/**
 * The service surface these executors need. It is structurally satisfied by `ProjectGitService`, which is
 * the point: the application passes the service itself and no adapter wrapper exists that could drift.
 */
export interface CodeGitToolPort {
  status(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string): Promise<GitStatusResult>;
  /**
   * C11 read-only repository state — structurally satisfied by `ProjectGitService.inspectRepository()`, which
   * `lstat`s and runs two read-only `rev-parse` probes and creates nothing. Optional so every recording
   * stand-in keeps working; when it is present the **push** pre-flight uses it for the branch question.
   *
   * `status()` is not a read on this service: it reaches `ensureRepository()`, i.e. `git init` plus a
   * `.gitignore` write plus an initial commit for a workspace that has no repository. On the push path that
   * was wrong twice over — it mutated the workspace before the git boundary had consumed the human's approval,
   * and it made that approval's `repositoryInitialized: false` fact untrue by the time the boundary
   * re-inspected, so the approved "create the repository and push" could never be redeemed.
   */
  inspectRepository?(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string): Promise<{ initialized: boolean; branch: string | null }>;
  diff(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, options?: { file?: string; staged?: boolean }): Promise<{ diff: string }>;
  log(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, limit?: number): Promise<GitLogEntry[]>;
  branch(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, options: { action: "list" | "create" | "switch"; branch?: string }): Promise<GitBranchResult>;
  stage(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, files?: string[]): Promise<{ staged: string[] }>;
  commit(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, options: { message: string; files?: string[]; stageAll?: boolean }): Promise<{ commitHash: string; message: string }>;
  restore(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, options: { files: string[] }): Promise<{ restored: string[] }>;
  push(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, options: {
    branch?: string; sourceBranch?: string; credentialId?: string; approved?: boolean; force?: boolean; remote?: string;
    approval?: GitWriteApprovalRequest;
  }): Promise<{ pushed: boolean; branch: string; remote: string }>;
  createPullRequest(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, options: {
    title: string; body?: string; base?: string; head?: string; credentialId?: string; approved?: boolean;
    /** C11: the tool id the approval payload is bound to; it must match the requester's, or the hash differs. */
    toolName?: string;
    approval?: GitWriteApprovalRequest;
  }): Promise<{ prNumber?: number; prUrl?: string; message: string }>;
  commentOnPullRequest(ctx: CodeToolExecutionContext["ctx"], companyId: string, projectId: string, options: {
    pullNumber: number; body: string; credentialId?: string; approved?: boolean; approval?: GitWriteApprovalRequest;
  }): Promise<{ commentId?: number; commentUrl?: string; pullNumber: number; message: string }>;
}

export interface CanonicalGitExecutorOptions {
  /** The existing git service. Absent → every git tool fails closed with `tool_not_configured`. */
  git?: CodeGitToolPort;
  /** The canonical revision guard. Absent → the revision precondition cannot be proven, so it is not claimed. */
  revisions?: CodeWorkspaceRevisionGuard;
  /** The protected-branch port: the same check phase 4b and the git boundary perform. */
  assertProtectedBranch?: (input: { ctx: CodeToolExecutionContext["ctx"]; companyId: string; intent: ReturnType<typeof gitWriteIntentForTool> }) => Promise<{ allowed: boolean; branch: string; code?: string; reason?: string }>;
  /** The branch a session works on. Absent → the session branch is reported but not required. */
  sessionBranch?: (input: { ctx: CodeToolExecutionContext["ctx"]; companyId: string; projectId: string; sessionId?: string }) => Promise<string | null>;
  /**
   * The run's summary, used to generate a pull-request body when the caller supplies none (owner decision
   * 11). Absent → the tool states `descriptionSource: "unavailable"` instead of inventing prose.
   */
  describeRun?: (input: { ctx: CodeToolExecutionContext["ctx"]; companyId: string; projectId: string; sessionId?: string }) => Promise<{ title: string; body: string } | null>;
}

function toolNotConfigured(tool: string, what: string): never {
  throw new CodeToolError("tool_not_configured", `${tool} has no ${what} configured`, 503, "configure", false, tool);
}

/** A service or workflow refusal keeps its own code and status: the model learns what was actually wrong. */
export function rethrowGit(error: unknown, tool: string): never {
  if (error instanceof CodeToolError) throw error;
  const shaped = error as { code?: unknown; status?: unknown; httpStatus?: unknown; message?: unknown; details?: unknown; retryable?: unknown };
  if (error instanceof CodeGitWorkflowError) {
    // `Object.assign` rather than the typed constructor: the code comes from the workflow module and is not
    // part of this runtime's closed vocabulary of argument-validation failures — the same pattern
    // `rethrowCanonical` uses for a canonical `CodeToolError`.
    throw Object.assign(new Error(error.message), {
      code: error.code,
      httpStatus: error.httpStatus,
      tool,
      step: "execute",
      retryable: error.retryable,
      details: error.details,
    });
  }
  if (shaped && typeof shaped.code === "string") {
    const details = shaped.details && typeof shaped.details === "object" && !Array.isArray(shaped.details)
      ? shaped.details as Record<string, unknown>
      : {};
    const status = typeof shaped.httpStatus === "number" ? shaped.httpStatus : (typeof shaped.status === "number" ? shaped.status : 400);
    throw Object.assign(new Error(typeof shaped.message === "string" ? shaped.message : `The git operation was refused (${shaped.code})`), {
      code: shaped.code,
      httpStatus: status,
      tool,
      step: "execute",
      retryable: shaped.retryable === true,
      details,
    });
  }
  throw error;
}

function boundedPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return paths.slice(0, GIT_TOOL_LIMITS.maxPaths).map((value) => String(value));
}

/** The approval record a remote write presents to the git boundary. Absent → the boundary refuses. */
function approvalRecord(input: CodeToolExecutionContext, tool: string): GitWriteApprovalRequest | undefined {
  const approvalId = String((input as { approvalId?: string }).approvalId ?? "");
  if (!approvalId) return undefined;
  return {
    approvalId,
    runId: String(input.runId ?? ""),
    agentId: String((input as { agentId?: string }).agentId ?? ""),
    toolName: tool,
  };
}

/**
 * The canonical revision this call was authorised against.
 *
 * The runtime captures it once, before any pre-flight, and passes it in; only a caller that did not (a test,
 * a direct invocation) causes a capture here. That ordering is what makes the value a *precondition* rather
 * than a second reading: a revision captured after the authorisation would prove nothing.
 */
async function readRevision(
  options: CanonicalGitExecutorOptions,
  input: CodeToolExecutionContext,
): Promise<{ revision: string | null; snapshot: CodeWorkspaceRevisionSnapshot | null }> {
  if (input.workspaceRevision) {
    return { revision: input.workspaceRevision.revision, snapshot: input.workspaceRevision };
  }
  if (!options.revisions) return { revision: null, snapshot: null };
  const snapshot = await options.revisions.capture({
    ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId ?? null,
  });
  return { revision: snapshot.revision, snapshot };
}

/**
 * The three preconditions, evaluated before a git write is dispatched.
 *
 * Reading the branch through the service's own `status` (rather than through a second git call) is what
 * keeps "which branch are we on" a single answer: the same parsed result the model sees is the one the
 * precondition is judged on.
 *
 * C11 (owner decision 13) — the one exception, and it is about **not mutating**: for a push against a
 * workspace that has no repository yet, `status()` would create the repository (`ensureRepository` →
 * `git init`), i.e. the push pre-flight would perform the very initialization the approval is bound to —
 * before the git boundary had consumed that approval, and leaving a state the boundary no longer matches.
 * The read-only `inspectRepository` is asked instead, and when it reports "no repository" the branch
 * comparison is not claimed: there is no checkout branch, the push names its target explicitly, and both the
 * approval and the boundary's protected-branch policy bind that name. Every other case — including an
 * initialized checkout with an unresolvable HEAD — keeps the `status()` answer and the comparison as it was.
 */
async function assertWriteAllowed(
  options: CanonicalGitExecutorOptions,
  input: CodeToolExecutionContext,
  tool: string,
  git: CodeGitToolPort,
  snapshot: CodeWorkspaceRevisionSnapshot | null,
): Promise<void> {
  const inspection = tool === "code.git.push" && git.inspectRepository
    ? await git.inspectRepository(input.ctx, input.companyId, input.projectId)
    : null;
  const currentBranch = inspection && !inspection.initialized
    ? ""
    : (await git.status(input.ctx, input.companyId, input.projectId)).branch;
  const expectedBranch = options.sessionBranch
    ? await options.sessionBranch({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId }).catch(() => null)
    : null;
  /**
   * The canonical-revision precondition (owner decision 7). When a guard is wired the comparison is made by
   * the guard itself, which refuses with `workspace_revision_mismatch` — the code a caller can act on
   * ("re-read the workspace and retry") instead of a generic git refusal. Without a guard there is no
   * revision to prove, so none is claimed.
   */
  if (options.revisions && snapshot) {
    await options.revisions.assertUnchanged(
      { ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId ?? null },
      snapshot,
      tool === "code.git.push" ? "git_push" : "git_commit",
    );
  }
  let protectedBranch: { allowed: boolean; branch: string; code?: string; reason?: string } | null = null;
  if (options.assertProtectedBranch && tool === "code.git.push") {
    const intent = gitWriteIntentForTool(tool, input.args);
    protectedBranch = await options.assertProtectedBranch({ ctx: input.ctx, companyId: input.companyId, intent });
  }
  assertGitWritePreconditions({
    expectedBranch: expectedBranch ?? "",
    currentBranch: currentBranch ?? "",
    expectedRevision: "",
    currentRevision: "",
    protectedBranch,
  });
}
/** The canonical executors for the `code.git.*` tools, keyed exactly as the registry publishes them. */
export function canonicalGitExecutors(options: CanonicalGitExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    "code.git.status": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const { revision } = await readRevision(options, input);
      try {
        const status = await git!.status(input.ctx, input.companyId, input.projectId);
        const truncated = status.staged.length > GIT_TOOL_LIMITS.maxPaths
          || status.unstaged.length > GIT_TOOL_LIMITS.maxPaths
          || status.untracked.length > GIT_TOOL_LIMITS.maxPaths;
        return {
          branch: status.branch,
          clean: status.clean,
          staged: status.staged.slice(0, GIT_TOOL_LIMITS.maxPaths),
          unstaged: status.unstaged.slice(0, GIT_TOOL_LIMITS.maxPaths),
          untracked: status.untracked.slice(0, GIT_TOOL_LIMITS.maxPaths),
          truncated,
          workspaceRevision: revision,
        };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.diff": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const { revision } = await readRevision(options, input);
      const args = input.args as { file?: string; staged?: boolean };
      try {
        const result = await git!.diff(input.ctx, input.companyId, input.projectId, {
          ...(typeof args.file === "string" ? { file: args.file } : {}),
          ...(args.staged === true ? { staged: true } : {}),
        });
        const diff = result.diff ?? "";
        const files = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]!).slice(0, GIT_TOOL_LIMITS.maxPaths);
        return {
          diff: diff.slice(0, GIT_TOOL_LIMITS.maxDiffChars),
          truncated: diff.length > GIT_TOOL_LIMITS.maxDiffChars,
          files,
          workspaceRevision: revision,
        };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.log": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const args = input.args as { limit?: number };
      const limit = Math.max(1, Math.min(Number(args.limit ?? 20) || 20, GIT_TOOL_LIMITS.maxLogEntries));
      try {
        const entries = await git!.log(input.ctx, input.companyId, input.projectId, limit);
        const bounded = (entries ?? []).slice(0, GIT_TOOL_LIMITS.maxLogEntries);
        return { entries: bounded, count: bounded.length };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.branch.create": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const { revision } = await readRevision(options, input);
      const branch = String((input.args as { branch?: string }).branch ?? "");
      try {
        const result = await git!.branch(input.ctx, input.companyId, input.projectId, { action: "create", branch });
        return { branch: result.current || branch, created: true, workspaceRevision: revision };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.branch.switch": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const branch = String((input.args as { branch?: string }).branch ?? "");
      try {
        const before = await git!.status(input.ctx, input.companyId, input.projectId);
        const result = await git!.branch(input.ctx, input.companyId, input.projectId, { action: "switch", branch });
        return { branch: result.current || branch, previousBranch: before.branch ?? null, switched: true };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.stage": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const files = boundedPaths((input.args as { files?: unknown }).files);
      try {
        const result = await git!.stage(input.ctx, input.companyId, input.projectId, files.length ? files : undefined);
        const staged = (result.staged ?? []).slice(0, GIT_TOOL_LIMITS.maxPaths);
        return { staged, stagedCount: staged.length };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.commit": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const { revision, snapshot } = await readRevision(options, input);
      const args = input.args as { message?: string; files?: unknown; stageAll?: boolean };
      try {
        await assertWriteAllowed(options, input, input.tool.name, git!, snapshot);
        const files = boundedPaths(args.files);
        const result = await git!.commit(input.ctx, input.companyId, input.projectId, {
          message: String(args.message ?? ""),
          ...(files.length ? { files } : {}),
          ...(args.stageAll === true ? { stageAll: true } : {}),
        });
        const status = await git!.status(input.ctx, input.companyId, input.projectId);
        return {
          commitHash: result.commitHash,
          message: result.message,
          branch: status.branch,
          stagedCount: status.staged.length,
          workspaceRevision: revision,
        };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.restore": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const files = boundedPaths((input.args as { files?: unknown }).files);
      try {
        const result = await git!.restore(input.ctx, input.companyId, input.projectId, { files });
        const restored = (result.restored ?? []).slice(0, GIT_TOOL_LIMITS.maxPaths);
        return { restored, restoredCount: restored.length };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.push": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const { revision, snapshot } = await readRevision(options, input);
      const args = input.args as { targetBranch?: string; sourceBranch?: string; credentialId?: string; force?: boolean };
      try {
        await assertWriteAllowed(options, input, input.tool.name, git!, snapshot);
        const result = await git!.push(input.ctx, input.companyId, input.projectId, {
          branch: String(args.targetBranch ?? ""),
          ...(args.sourceBranch ? { sourceBranch: String(args.sourceBranch) } : {}),
          credentialId: String(args.credentialId ?? ""),
          // The flag is not the proof: the boundary consumes the approval record. It is set because the
          // service's own guard reads it, and the record is what decides.
          approved: true,
          ...(args.force === true ? { force: true } : {}),
          ...(() => {
            const approval = approvalRecord(input, input.tool.name);
            return approval ? { approval } : {};
          })(),
        });
        return { pushed: result.pushed === true, branch: result.branch, remoteBranch: result.branch, force: args.force === true };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.pr.create": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const args = input.args as { title?: string; body?: string; base?: string; head?: string; credentialId?: string };
      let body = typeof args.body === "string" ? args.body : "";
      let descriptionSource: "caller" | "run_summary" | "unavailable" = body ? "caller" : "unavailable";
      if (!body && options.describeRun) {
        // Owner decision 11: reuse the run's own summary instead of a second format. A run without a
        // recorded summary says so; it never produces a body that reads like a verified one.
        const summary = await options.describeRun({
          ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId,
        }).catch(() => null);
        if (summary) {
          body = summary.body;
          descriptionSource = "run_summary";
        }
      }
      try {
        const result = await git!.createPullRequest(input.ctx, input.companyId, input.projectId, {
          title: String(args.title ?? ""),
          ...(body ? { body } : {}),
          base: String(args.base ?? ""),
          head: String(args.head ?? ""),
          credentialId: String(args.credentialId ?? ""),
          approved: true,
          // The tool id travels into the approval payload, so the boundary rebuilds the same hash the
          // requester created the record under.
          toolName: input.tool.name,
          ...(() => {
            const approval = approvalRecord(input, input.tool.name);
            return approval ? { approval } : {};
          })(),
        });
        return {
          prNumber: result.prNumber ?? null,
          prUrl: result.prUrl ?? null,
          base: String(args.base ?? ""),
          head: String(args.head ?? ""),
          created: true,
          descriptionSource,
        };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },

    "code.git.pr.comment": async (input) => {
      const git = options.git;
      if (!git) toolNotConfigured(input.tool.name, "git service");
      const args = input.args as { pullNumber?: number; body?: string; credentialId?: string };
      try {
        const result = await git!.commentOnPullRequest(input.ctx, input.companyId, input.projectId, {
          pullNumber: Number(args.pullNumber ?? 0),
          body: String(args.body ?? ""),
          credentialId: String(args.credentialId ?? ""),
          approved: true,
          ...(() => {
            const approval = approvalRecord(input, input.tool.name);
            return approval ? { approval } : {};
          })(),
        });
        return {
          commentId: result.commentId ?? null,
          commentUrl: result.commentUrl ?? null,
          pullNumber: result.pullNumber,
          created: true,
        };
      } catch (error) { rethrowGit(error, input.tool.name); }
    },
  };
}

/**
 * Creates the session branch if it is missing and returns to it if it is not, then reports the branch the
 * workspace is on. Called once at the start of a coding session (owner decision 8), so the run never
 * accumulates work on the repository's main branch.
 *
 * It uses only `branch`/`status`, i.e. the service's own commands: "does the branch exist" is answered by
 * listing branches rather than by parsing a failed `checkout`.
 */
export async function ensureSessionBranch(input: {
  git: CodeGitToolPort;
  ctx: CodeToolExecutionContext["ctx"];
  companyId: string;
  projectId: string;
  sessionId: string;
}): Promise<{ branch: string; created: boolean; switched: boolean; previousBranch: string | null }> {
  const branch = sessionBranchName(input.sessionId);
  const status = await input.git.status(input.ctx, input.companyId, input.projectId);
  const previousBranch = status.branch ?? null;
  if (status.branch === branch) return { branch, created: false, switched: false, previousBranch };
  const listed = await input.git.branch(input.ctx, input.companyId, input.projectId, { action: "list" });
  if ((listed.branches ?? []).includes(branch)) {
    const switched = await input.git.branch(input.ctx, input.companyId, input.projectId, { action: "switch", branch });
    return { branch: switched.current || branch, created: false, switched: true, previousBranch };
  }
  const created = await input.git.branch(input.ctx, input.companyId, input.projectId, { action: "create", branch });
  return { branch: created.current || branch, created: true, switched: true, previousBranch };
}
