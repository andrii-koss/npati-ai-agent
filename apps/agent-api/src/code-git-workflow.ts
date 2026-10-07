/**
 * C11 — the git workflow's **non-git** logic: which `code.git.*` tool is what, what an approval for each of
 * them is bound to, the session branch, the preconditions a commit or a push must satisfy, and the
 * conflict-escalation budget.
 *
 * This module is a leaf. It contains **no git implementation**: every command lives in
 * `ProjectGitService`, and the executors in `code-tool-git-executors.ts` only shape arguments and map
 * errors. What lives here is the part that must be identical on the request side and on the enforcement
 * side — otherwise a caller could ask for one thing and be judged on another:
 *
 *  - the **classification** (read-only / mutating / approval-gated / approval-at-the-boundary) is read by
 *    the tool runtime, the policy engine and the capability catalogue, so a tool cannot be write-gated in
 *    one place and read-gated in another;
 *  - the **approval binding** for each write is built here, and the git boundary rebuilds it from the
 *    branch it is about to write, so an approval for one target cannot be redeemed for another;
 *  - the **session branch** is a deterministic function of the session id, so a resume continues on the
 *    branch the work is on instead of opening a second one;
 *  - the **preconditions** (branch, expected revision, protected-branch decision) are asserted before a
 *    commit or a push, which is what makes "the agent does not work on main" and "git and the sandbox ran
 *    against the same revision" checkable facts rather than intentions.
 */

import { createHash } from "node:crypto";
import {
  gitApprovalPayload,
  gitWriteIntentFromToolInput,
  normalizeGitBranch,
  pullRequestApprovalPayload,
  type GitWriteIntent,
} from "./code-git-write-policy";

/** Every tool this module classifies. Kept in alphabetical order so a diff shows exactly what moved. */
export const GIT_TOOL_NAMES: readonly string[] = [
  "code.git.branch.create",
  "code.git.branch.switch",
  "code.git.commit",
  "code.git.diff",
  "code.git.log",
  "code.git.pr.comment",
  "code.git.pr.create",
  "code.git.push",
  "code.git.restore",
  "code.git.stage",
  "code.git.status",
];

const GIT_TOOLS = new Set(GIT_TOOL_NAMES);

/**
 * The read-only git tools. They read the canonical repository and write nothing — not the working tree,
 * not the index, not the remote — which is why they are the only git tools a `REVIEW_CODE` session may
 * call. `code.git.diff` is *not* in the general `READ_TOOLS` class of the policy engine: like the plan
 * tools, the read-only git class is a narrow, explicit list so a future git read cannot silently become
 * available where only reviewing is allowed.
 */
export const GIT_READ_TOOLS: ReadonlySet<string> = new Set([
  "code.git.status",
  "code.git.diff",
  "code.git.log",
]);

/** The git tools that change the working tree, the index or the remote. */
export const GIT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "code.git.branch.create",
  "code.git.branch.switch",
  "code.git.stage",
  "code.git.commit",
  "code.git.restore",
  "code.git.push",
  "code.git.pr.create",
  "code.git.pr.comment",
]);

/**
 * The git tools that need a human approval record.
 *
 * `code.git.restore` destroys uncommitted work that no checkpoint can bring back, and the three remote
 * operations publish something. `branch.create`, `branch.switch`, `stage` and `commit` deliberately do
 * **not**: they are local, reversible and already bounded by the session mode, the `code.git` flag and the
 * capability group. Gating a commit behind an approval would also make the ordinary workflow unusable,
 * because the agent must commit before it can push anything.
 */
export const GIT_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "code.git.restore",
  "code.git.push",
  "code.git.pr.create",
  "code.git.pr.comment",
]);

/**
 * The subset whose approval is consumed at the **git boundary** (`ProjectGitService`) rather than by the
 * tool runtime: the boundary is the only place that can recompute the payload hash from the branch it is
 * about to write (C11 owner decision 5). The tool runtime must therefore *require* a record for these and
 * never spend it, otherwise the write reaches the boundary with nothing left to verify.
 */
export const GIT_BOUNDARY_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "code.git.push",
  "code.git.pr.create",
  "code.git.pr.comment",
]);

export function isCodeGitTool(tool: string): boolean {
  return GIT_TOOLS.has(String(tool ?? ""));
}

/** True when the tool performs a remote write and must therefore carry the typed intent into the policy. */
export function gitToolCarriesWriteIntent(tool: string): boolean {
  return gitWriteIntentFromToolInput(tool, { targetBranch: "x" }) !== null;
}

/** The highest number of automatic merge attempts, after which the conflict belongs to a human. */
export const MAX_GIT_MERGE_ATTEMPTS = 2;

export const GIT_CONFLICT_ESCALATED = "git_conflict_escalated";
export const GIT_BRANCH_MISMATCH = "git_branch_mismatch";
export const GIT_REVISION_MISMATCH = "git_revision_mismatch";
export const GIT_PROTECTED_BRANCH_DENIED = "git_protected_branch_write_denied";
/** The canonical workspace and the revision a git operation was prepared from are not the same. */
export const WORKSPACE_REVISION_MISMATCH = "workspace_revision_mismatch";

export class CodeGitWorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly details: Record<string, unknown> = {},
    readonly retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeGitWorkflowError";
  }

  toStructuredError(): Record<string, unknown> {
    return {
      status: "error", code: this.code, message: this.message,
      httpStatus: this.httpStatus, retryable: this.retryable,
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

/**
 * The branch a coding session works on: `npati/<session-short-id>`.
 *
 * It is derived from the session id rather than generated, so a resumed run — or a second run in the same
 * session — finds the same branch instead of opening a new one per attempt. The short id is a digest, so
 * a session id that is not branch-safe (or that is very long) still produces a valid, stable name that
 * leaks no session identifier into a repository somebody else may read.
 */
export function sessionBranchName(sessionId: string): string {
  const id = String(sessionId ?? "").trim();
  if (!id) throw new CodeGitWorkflowError("git_session_branch_unavailable", "A session branch needs a session id", 400);
  const short = createHash("sha256").update(id).digest("hex").slice(0, 10);
  return `npati/${short}`;
}

/** git's own branch rules, as the service already applies them, expressed once for the callers. */
export function isValidGitBranchName(branch: string): boolean {
  const value = normalizeGitBranch(branch);
  if (!value || value.length > 100) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("@{") || value.endsWith(".lock") || value.endsWith("/")) return false;
  return true;
}

export interface GitWritePreconditions {
  /** The branch the session is supposed to be working on (`npati/<session-short-id>`). */
  expectedBranch: string;
  /** The branch the canonical workspace is actually on, read from the repository. */
  currentBranch: string;
  /** The canonical revision the operation was prepared from. */
  expectedRevision: string;
  /** The canonical revision read immediately before the write. */
  currentRevision: string;
  /**
   * The protected-branch decision for the typed intent, when the caller has one. It is passed in, never
   * computed here: the policy lives in `CodeProtectedBranchService` and is consulted through its port.
   */
  protectedBranch?: { allowed: boolean; branch: string; code?: string; reason?: string } | null;
}

/**
 * The three preconditions a commit or a push must satisfy, checked **before** the command runs and phrased
 * so that each failure names the value that disagreed.
 *
 * They are deliberately separate codes: a run that landed on another branch is a different defect from a
 * run whose workspace moved under it, and a caller that only saw "refused" would not know which one to
 * repair.
 */
export function assertGitWritePreconditions(input: GitWritePreconditions): void {
  const expectedBranch = normalizeGitBranch(input.expectedBranch);
  const currentBranch = normalizeGitBranch(input.currentBranch);
  if (expectedBranch && currentBranch && expectedBranch !== currentBranch) {
    throw new CodeGitWorkflowError(
      GIT_BRANCH_MISMATCH,
      `The project workspace is on "${currentBranch}" but this operation was prepared for "${expectedBranch}"; the write is refused instead of landing on another branch`,
      409,
      { expectedBranch, currentBranch },
    );
  }
  if (input.expectedRevision && input.currentRevision && input.expectedRevision !== input.currentRevision) {
    throw new CodeGitWorkflowError(
      GIT_REVISION_MISMATCH,
      "The canonical workspace changed after this git operation was prepared; the write is refused rather than committing a revision nobody verified",
      409,
      { expectedRevision: input.expectedRevision, currentRevision: input.currentRevision },
    );
  }
  const decision = input.protectedBranch;
  if (decision && decision.allowed === false) {
    throw new CodeGitWorkflowError(
      decision.code ?? GIT_PROTECTED_BRANCH_DENIED,
      decision.reason ?? `The branch "${decision.branch}" is protected; the write is refused`,
      403,
      { branch: decision.branch },
    );
  }
}

/**
 * What an approval for a `code.git.*` write is bound to.
 *
 * Each git write gets its **own** payload shape, which is the point of decision 10's "PR comments need a
 * separate approval": a record created for a push names the branches and the remote, a record created for a
 * comment names the pull-request number and a hash of the comment text, and neither can be presented as the
 * other — the payload hashes differ, so the durable approval gateway refuses the swap.
 *
 * The text of a comment is hashed, never stored: the approval records the reviewer's decision about
 * *some* comment, and the comment itself is not repository state.
 */
export function gitToolApprovalPayload(input: {
  projectId: string;
  tool: string;
  args: Record<string, unknown>;
  /**
   * C11 (owner decision 13): the state of the repository the write targets, **as the read-only inspector
   * found it** (`ProjectGitService.inspectRepository`). It is not read from `args` — a caller's claim about
   * the disk is worth nothing — and the boundary resolves the same fact again immediately before the write.
   * `false` means this write has to create the repository, and `gitApprovalPayload` then binds that fact into
   * the hash; `true`/absent leaves the payload (and its hash) exactly as it was before decision 13.
   */
  repositoryInitialized?: boolean | null;
}): Record<string, unknown> {
  const tool = String(input.tool ?? "");
  const args = input.args ?? {};
  if (tool === "code.git.push") {
    const intent = gitWriteIntentFromToolInput(tool, args);
    if (!intent) {
      throw new CodeGitWorkflowError(
        "git_write_intent_required",
        "code.git.push must name the branch it writes to; without a target there is nothing for the approval to bind",
        400,
      );
    }
    return gitApprovalPayload({
      projectId: input.projectId,
      tool,
      intent: { ...intent, repositoryInitialized: input.repositoryInitialized ?? null },
    });
  }
  if (tool === "code.git.pr.create") {
    return pullRequestApprovalPayload({
      projectId: input.projectId,
      tool,
      base: String(args.base ?? ""),
      head: String(args.head ?? ""),
      credentialId: typeof args.credentialId === "string" ? args.credentialId : null,
    });
  }
  if (tool === "code.git.pr.comment") {
    return pullRequestCommentApprovalPayload({
      projectId: input.projectId,
      tool,
      pullNumber: Number(args.pullNumber),
      body: String(args.body ?? ""),
      credentialId: typeof args.credentialId === "string" ? args.credentialId : null,
    });
  }
  if (tool === "code.git.restore") {
    const files = Array.isArray(args.files) ? args.files.map((file) => String(file)).sort() : [];
    return {
      projectId: String(input.projectId ?? ""),
      tool,
      restore: { files, filesHash: createHash("sha256").update(files.join("\n")).digest("hex") },
    };
  }
  throw new CodeGitWorkflowError(
    "git_approval_binding_undefined",
    `${tool} is approval-gated but has no approval binding; a write with an undefined binding is refused`,
    500,
  );
}

/**
 * The comment binding, kept separate from `pullRequestApprovalPayload` on purpose: opening a pull request
 * and commenting on one are different acts, and sharing a payload shape would let one approval authorise
 * the other.
 */
export function pullRequestCommentApprovalPayload(input: {
  projectId: string;
  tool: string;
  pullNumber: number;
  body: string;
  credentialId?: string | null;
}): Record<string, unknown> {
  return {
    projectId: String(input.projectId ?? ""),
    tool: String(input.tool ?? ""),
    pullRequestComment: {
      pullNumber: Number(input.pullNumber),
      /**
       * The hash is taken over the **trimmed** body, because the trimmed body is what
       * `ProjectGitService.commentOnPullRequest` posts (`String(options.body ?? "").trim()`). Hashing the raw
       * text made the request side and the boundary disagree for any comment that arrived with surrounding
       * whitespace — a newline at the end is enough — so the approval could not be redeemed for the very
       * comment it was granted for. The three call sites (both request sides and the boundary) now hash the
       * same text through this one function.
       */
      bodyHash: createHash("sha256").update(String(input.body ?? "").trim()).digest("hex"),
      credentialId: input.credentialId ?? null,
    },
  };
}

/** The typed intent a git write tool declares, or a refusal when it names no target. Never guessed. */
export function gitWriteIntentForTool(tool: string, args: Record<string, unknown>): GitWriteIntent {
  const intent = gitWriteIntentFromToolInput(tool, args);
  if (!intent) {
    throw new CodeGitWorkflowError(
      "git_write_intent_required",
      `${tool} performs a remote git write, so it must name the branch it writes to`,
      400,
    );
  }
  return intent;
}

// --- conflict escalation ------------------------------------------------------------------------------

/**
 * Where one automatic merge attempt got to. `attempt` counts attempts **already made**, so the value is
 * evidence rather than a plan: the escalation below reports the number of real `git merge` runs.
 */
export interface GitMergeAttempt {
  attempt: number;
  conflictingFiles: string[];
  sourceBranch: string;
  targetBranch: string;
}

/**
 * What a resolver decided for one conflicted attempt. Returning `null` means "I cannot resolve this", which
 * escalates immediately instead of spending the remaining budget on a guess.
 */
export interface GitMergeResolution {
  /** The merge strategy that resolves the whole attempt (`ours` keeps the target branch's side). */
  strategy: "ours" | "theirs";
  /** Why, for the record. Metadata only: it is stored beside the escalation, never as a diff. */
  reason: string;
}

export interface GitConflictResolverPort {
  resolve(input: GitMergeAttempt): Promise<GitMergeResolution | null>;
}

export interface GitConflictEscalation {
  code: typeof GIT_CONFLICT_ESCALATED;
  attempts: number;
  maxAttempts: number;
  conflictingFiles: string[];
  sourceBranch: string;
  targetBranch: string;
  /**
   * The tool the calling agent should use next. The escalation is a *decision request*, and `code.ask_user`
   * is the existing tool that pauses a run until a human answers — inventing a second notification channel
   * here would mean two places know how a run waits for a person.
   */
  suggestedTool: "code.ask_user";
  question: string;
}

/**
 * Turns an exhausted conflict into the structured escalation a caller can act on: the attempts that were
 * really made, the files that are still unmerged, and the question a human has to answer. No diff, no file
 * content — the paths are what a reviewer needs and what may be recorded.
 */
export function buildConflictEscalation(input: {
  attempts: number;
  maxAttempts?: number;
  conflictingFiles: string[];
  sourceBranch: string;
  targetBranch: string;
}): GitConflictEscalation {
  const maxAttempts = input.maxAttempts ?? MAX_GIT_MERGE_ATTEMPTS;
  const files = [...new Set(input.conflictingFiles)].sort();
  return {
    code: GIT_CONFLICT_ESCALATED,
    attempts: input.attempts,
    maxAttempts,
    conflictingFiles: files,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    suggestedTool: "code.ask_user",
    question:
      `Merging ${input.sourceBranch} into ${input.targetBranch} still conflicts after ${input.attempts} automatic `
      + `attempt(s) of at most ${maxAttempts}. Conflicting paths: ${files.join(", ") || "(none reported)"}. `
      + "Choose how to proceed: resolve the conflicting paths by hand, discard the source branch, or merge anyway and accept one side.",
  };
}

/**
 * Runs one merge with a **real** automatic-resolution budget.
 *
 * The loop is the mechanism the escalation message used to promise without implementing: attempt 1 is the
 * plain merge, and each following attempt happens only when a resolver produced a concrete strategy for the
 * conflicts the previous attempt reported. The counter is incremented for every merge that was actually run,
 * so `attempts` in the escalation is reproducible.
 *
 * The caller supplies `merge`: this function never builds a git command line, so run it against the
 * service's own `runGit`.
 */
export async function runMergeWithAutoResolve<T>(input: {
  sourceBranch: string;
  targetBranch: string;
  maxAttempts?: number;
  resolver?: GitConflictResolverPort | null;
  /** Runs one merge attempt; resolves on success and throws when the attempt conflicted. */
  merge(strategy: "none" | "ours" | "theirs"): Promise<T>;
  /** Reads the unmerged paths after a failed attempt. Must not throw for "no conflicts". */
  readConflicts(): Promise<string[]>;
  /** Leaves the repository clean after a failed attempt (the service's `merge --abort`). */
  abort(): Promise<void>;
}): Promise<{ status: "merged"; result: T; attempts: number; resolutions: GitMergeResolution[] }> {
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? MAX_GIT_MERGE_ATTEMPTS, MAX_GIT_MERGE_ATTEMPTS));
  const resolutions: GitMergeResolution[] = [];
  let attempts = 0;
  let conflictingFiles: string[] = [];
  let strategy: "none" | "ours" | "theirs" = "none";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts += 1;
    try {
      const result = await input.merge(strategy);
      return { status: "merged", result, attempts, resolutions };
    } catch (error) {
      conflictingFiles = await input.readConflicts().catch(() => []);
      await input.abort().catch(() => undefined);
      if (attempt >= maxAttempts) break;
      const next = input.resolver
        ? await input.resolver.resolve({
            attempt,
            conflictingFiles,
            sourceBranch: input.sourceBranch,
            targetBranch: input.targetBranch,
          }).catch(() => null)
        : null;
      if (!next) break;
      resolutions.push(next);
      strategy = next.strategy;
      void error;
    }
  }

  throw new CodeGitWorkflowError(
    GIT_CONFLICT_ESCALATED,
    `Merging ${input.sourceBranch} into ${input.targetBranch} still conflicts after ${attempts} automatic attempt(s) of at most ${maxAttempts}`,
    409,
    {
      escalation: buildConflictEscalation({
        attempts,
        maxAttempts,
        conflictingFiles,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
      }),
    },
  );
}
