import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthContext, Project, ProjectCheckpoint, CheckpointTrigger, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import { safeProjectPath, samePath, ProjectFileError } from "./project-workspace";
import { managedWorkspaceBaseResolver, type WorkspaceBase, type WorkspaceBaseResolverPort } from "./workspace-base-resolver";
import { gitApprovalPayload, normalizeGitBranch, pullRequestApprovalPayload, type GitWriteIntent } from "./code-git-write-policy";
import type { CodeWorkspaceRevisionSnapshot, WorkspaceRevisionPhase } from "./code-workspace-revision";
import {
  CodeGitWorkflowError,
  GIT_CONFLICT_ESCALATED,
  MAX_GIT_MERGE_ATTEMPTS,
  buildConflictEscalation,
  pullRequestCommentApprovalPayload,
  runMergeWithAutoResolve,
  type GitConflictResolverPort,
} from "./code-git-workflow";
import { createAgentWorktree, commitAgentWorktree, mergeAgentWorktree, listAgentWorktrees, type ProjectGitWorktreeHost } from "./project-git-worktree-service";
import { createPullRequest, commentOnPullRequest, type ProjectGitPullRequestHost } from "./project-git-pull-request-service";
import { restoreCheckpoint, restorePaths, type ProjectGitCheckpointHost } from "./project-git-checkpoint-service";
import { requireGitWriteApproval, resolveWriteIntent, type ProjectGitApprovalHost } from "./project-git-approval-service";
import { ensureRepositoryInitialized, inspectRepository, status, branch, type ProjectGitRepositoryHost } from "./project-git-repository-service";
import { diffAgentWorktree, removeAgentWorktree, type ProjectGitWorktreeExtraHost } from "./project-git-worktree-extra-service";
import { createCheckpoint, getCheckpoint, type ProjectGitCheckpointWriteHost } from "./project-git-checkpoint-write-service";
import { push, type ProjectGitPushHost } from "./project-git-push-service";
import { githubToken, acquireCredential, type ProjectGitCredentialHost } from "./project-git-credential-service";
import { currentBranch, type ProjectGitBranchHost } from "./project-git-branch-service";
import { cleanupAllWorktrees, type ProjectGitCleanupHost } from "./project-git-cleanup-service";
import { log, commit, type ProjectGitHistoryHost } from "./project-git-history-service";
import { assertNoSymlinkPath, removePathForRevert, resolveRevertTarget, assertWorkspaceRevisionUnchanged, type ProjectGitGuardHost } from "./project-git-guard-service";
import { resolveProjectWorkspace, assertSafeIndex, ensureRepository, requireWrite, runGit, stage, type ProjectGitWorkspaceHost } from "./project-git-workspace-service";
import { getProjectPath, parseConflictFiles, connectRepository, restore, countWorkspaceFiles, isLargeChange, listCheckpoints, pathExistsInCommit, assertGitWriteBoundary, captureWorkspaceRevision, credentialEnvironment, getAgentWorktreePath, type ProjectGitCoreHost } from "./project-git-core-service";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    /**
     * C11 (owner decision 13): structured detail for a refusal a caller can act on — currently
     * `repository_not_initialized`, whose `requiresInitialization` tells a requester that this write is a
     * *different* act that needs its own approval. It travels to the tool layer unchanged (`rethrowGit` copies
     * it into the structured tool error), so the model learns *why* instead of parsing a message.
     *
     * The union with `string` is not new: `GitConflictEscalationError` has carried its escalation text in
     * `details` since the merge-conflict work, and a subclass property must stay assignable to this one.
     */
    public readonly details: Record<string, unknown> | string = {},
  ) {
    super(message);
    this.name = "GitError";
  }
}

export class GitConflictError extends GitError {
  constructor(
    public readonly conflictingFiles: string[],
    public readonly details: string,
  ) {
    super(
      "GIT_CONFLICT",
      `Git merge conflict detected in ${conflictingFiles.length} file(s): ${conflictingFiles.join(", ")}`,
      409,
    );
    this.name = "GitConflictError";
  }
}

/**
 * C11 (owner decision 9): a merge that could not be finished automatically.
 *
 * The message is **factual**: it reports the number of merge attempts that were actually run and the budget
 * they were run against. It used to claim "exceeded maximum automatic attempts (2)" while the method made
 * exactly one attempt and had no resolver at all — a promise in a string. The counter below is the
 * mechanism that message now describes, and `escalation` carries the structured decision a caller can act
 * on (`code.ask_user` is the suggested tool).
 */
export class GitConflictEscalationError extends GitError {
  constructor(
    public readonly conflictingFiles: string[],
    public readonly details: string,
    public readonly escalation?: {
      attempts: number;
      maxAttempts: number;
      sourceBranch: string;
      targetBranch: string;
      suggestedTool: "code.ask_user";
      question: string;
    },
  ) {
    const attempts = escalation?.attempts ?? 0;
    const maxAttempts = escalation?.maxAttempts ?? MAX_GIT_MERGE_ATTEMPTS;
    super(
      "GIT_CONFLICT_ESCALATED",
      `Git merge conflict in ${conflictingFiles.length} file(s) after ${attempts} of at most ${maxAttempts} automatic `
      + `attempt(s); escalating to user intervention for files: ${conflictingFiles.join(", ")}`,
      409,
    );
    this.name = "GitConflictEscalationError";
  }
}

export class GitApprovalRequiredError extends GitError {
  constructor(message = "External Git write operation requires explicit human approval") {
    super("GIT_APPROVAL_REQUIRED", message, 403);
    this.name = "GitApprovalRequiredError";
  }
}

export interface GitStatusResult {
  branch: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitBranchResult {
  current: string;
  branches: string[];
}

/**
 * C11 (owner decision 13, the last known issue): the **read-only** answer to "what state is this project's
 * repository in?".
 *
 * `inspectRepository()` produces it and performs no mutation of any kind: it resolves the workspace path
 * without creating it, `lstat`s `.git`, and — only when `.git` exists — runs the two read-only `git rev-parse`
 * probes below. There is deliberately no `git init`, no `git config`, no `git add` and no write of any file,
 * so a request that is still to be authorised cannot leave a trace on disk. `initialized: false` is a fact a
 * caller reports (`repository_not_initialized`) rather than a state it silently repairs.
 */
export interface GitRepositoryInspection {
  /** The project the workspace belongs to (loaded through the same authorization checks as `getProjectPath`). */
  project: Project;
  /** The project workspace directory. It may not exist yet; an inspection never creates it. */
  dir: string;
  /** `true` when `<dir>/.git` is a directory that belongs to this workspace. */
  initialized: boolean;
  /** The checked-out branch, or `null` when it cannot be established (never a guess). */
  branch: string | null;
}

/**
 * C11 (owner decision 13): the canonical workspace revision, as this boundary reads it.
 *
 * The shape is structural, so `ProjectGitService` does not import the guard implementation and the two stay
 * independently testable. `CodeWorkspaceRevisionGuard` satisfies it as it stands.
 */
export interface ProjectGitRevisionPort {
  capture(scope: { ctx: AuthContext; companyId: string; projectId: string }): Promise<CodeWorkspaceRevisionSnapshot>;
  assertUnchanged(
    scope: { ctx: AuthContext; companyId: string; projectId: string },
    snapshot: CodeWorkspaceRevisionSnapshot,
    phase: WorkspaceRevisionPhase,
  ): Promise<unknown>;
}

/**
 * C11 (owner decision 5): the proof a remote git write needs. `approvalId` names a **real approval
 * record**, and `runId`/`agentId`/`toolName` are the context the record was created for; the port below
 * consumes it atomically, which verifies status, single use, expiry **and the payload hash**.
 */
export interface GitWriteApprovalRequest {
  approvalId: string;
  runId: string;
  agentId: string;
  toolName: string;
}

/**
 * C11 (owner decision 5): the approval record, consumed with the payload hash of the exact write.
 *
 * The structural shape is the existing durable-approval gateway (`CompanyApprovalsRepository
 * .consumeApproved`), deliberately not a new mechanism: the SQL update is what makes "status approved,
 * not consumed, not expired, payload hash matches" a single atomic decision.
 */
export interface GitApprovalPort {
  consumeApproved(
    ctx: AuthContext,
    companyId: string,
    approvalId: string,
    params: { runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown> },
  ): Promise<unknown>;
}

/** C11 (owner decision 6): one credential lease for exactly one host git invocation. */
export interface HostGitCredentialLease {
  leaseId: string;
  /** Used only in the process-scoped environment of this single git invocation. */
  value: string;
}

export interface HostGitCredentialPort {
  /** Issues one lease and resolves its value; the caller revokes it in a `finally`. */
  acquire(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    credentialId: string;
    toolCallId: string;
    purpose: "git.push" | "pull_request.create" | "pull_request.comment";
  }): Promise<HostGitCredentialLease>;
  revoke(leaseId: string, reason: string): Promise<void>;
}

/**
 * C11 (owner decisions 3, 5 and 6): the git-policy boundary of this service.
 *
 * Every member is optional at the type level and **mandatory in effect**: a remote write refuses
 * (`GIT_POLICY_UNAVAILABLE`, `GIT_APPROVAL_UNAVAILABLE`, `GIT_APPROVAL_RECORD_REQUIRED`) when the
 * corresponding port is missing, so a caller that builds the service by hand cannot accidentally push
 * without the two checks. Injection is structural (no service import), which is what keeps this module
 * free of the policy, approval and lease implementations.
 */
export interface ProjectGitBoundary {
  /**
   * The company protected-branch policy, re-consulted **immediately before** the write. This is a second,
   * independent call: the policy engine already decided, but a direct service call (a route, a script, a
   * future tool) would bypass the engine, and that is exactly the path this closes. `assertGitWriteAllowed`
   * throws `CodeProtectedBranchError` (403, `protected_branch_write_denied` / `force_push_denied`).
   */
  assertGitWriteAllowed?: (ctx: AuthContext, companyId: string, input: GitWriteIntent) => Promise<unknown>;
  /** The real approval record for this exact write (`payload_hash` included). */
  approvals?: GitApprovalPort;
  /** One-operation credential leases for the host git process. */
  credentials?: HostGitCredentialPort;
  /**
   * C11 (owner decision 7 + 13): the canonical workspace revision. It is read **before** the approval is
   * consumed and re-checked **after** the write's own initialization (if any) and immediately before the
   * credential lease and the push, because the initialization itself changes the canonical workspace. A
   * moved revision is `workspace_revision_mismatch` (409) with no push. Absent → no revision is claimed,
   * which is the hand-built-service case (a test), never production.
   */
  workspaceRevisions?: ProjectGitRevisionPort;
}

export interface CheckpointThresholds {
  fileThreshold: number;
  lineThreshold: number;
}

export const defaultCheckpointThresholds: CheckpointThresholds = {
  fileThreshold: 5,
  lineThreshold: 200,
};

function validId(value: string) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

export function safeAgentSlug(slug: string): string {
  if (typeof slug !== "string" || !slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new GitError("INVALID_AGENT_SLUG", "Invalid agent slug for worktree", 400);
  }
  const clean = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  if (!clean || clean === "." || clean === "..") throw new GitError("INVALID_AGENT_SLUG", "Invalid agent slug for worktree", 400);
  return clean;
}

function redactSecrets(text: string): string {
  return text.replace(/https:\/\/[^@\s]+@/g, "https://***@")
    .replace(/(?:ghp_|github_pat_)[a-zA-Z0-9_]+/g, "***TOKEN***")
    // C11: the git credential is delivered as an `Authorization: Basic <base64>` extraheader. A failing
    // git command can echo the config it was given (`-c`/`GIT_CONFIG_VALUE_n` appear in some messages), and
    // the base64 blob would not match either pattern above, so the header is masked explicitly.
    .replace(/Authorization:\s*(?:Basic|Bearer)\s+[A-Za-z0-9+/=_-]+/gi, "Authorization: ***")
    .replace(/GIT_CONFIG_VALUE_\d+=\S*/g, "GIT_CONFIG_VALUE_***");
}

/** Exported for the security-gate suite: redaction of a credential-bearing git error is pinned directly. */
export { redactSecrets as redactGitSecrets };

export class ProjectGitService {
  private readonly thresholds: CheckpointThresholds;
  /**
   * C15: the canonical-workspace resolver. It used to be a bare root string that this class joined a second
   * time — the same join `LocalProjectWorkspace` performed, from a value passed in separately, which is two
   * sources of truth the moment a mounted folder can change the answer. A string is still accepted (every
   * existing construction site and suite passes one) and is wrapped in a managed-only resolver, so the behaviour
   * of a deployment without mounts is byte-identical while `app.ts` passes the shared resolver both consumers
   * read.
   */
  private readonly bases: WorkspaceBaseResolverPort;

  constructor(
    private readonly workspaceStore: WorkspaceStore,
    private readonly projectService: Pick<ProjectService, "get">,
    workspaceRoot: string | WorkspaceBaseResolverPort,
    thresholds?: Partial<CheckpointThresholds>,
    private readonly resolveGithubCredential?: (ctx: AuthContext, companyId: string, credentialId: string) => Promise<string>,
    /**
     * Test seam for the git process. Production passes nothing and the real `git` binary is used; a suite injects
     * a spooler so it can assert the exact argv (for example that a path-scoped revert never issues `reset --hard`).
     */
    private readonly runGitImpl?: (dir: string, args: string[], env: Record<string, string>) => Promise<{ stdout: string; stderr: string }>,
    /**
     * C11: the git-policy boundary — the protected-branch re-check performed immediately before a remote
     * write, the approval record consumed with this write's payload hash, and the one-operation credential
     * lease. Wired in `app.ts`; a missing member refuses the write rather than skipping a check.
     */
    private readonly boundary?: ProjectGitBoundary,
  ) {
    this.bases = typeof workspaceRoot === "string" ? managedWorkspaceBaseResolver(workspaceRoot) : workspaceRoot;
    this.thresholds = {
      fileThreshold: thresholds?.fileThreshold ?? (Number(process.env.NPATI_CHECKPOINT_FILE_THRESHOLD) || defaultCheckpointThresholds.fileThreshold),
      lineThreshold: thresholds?.lineThreshold ?? (Number(process.env.NPATI_CHECKPOINT_LINE_THRESHOLD) || defaultCheckpointThresholds.lineThreshold),
    };
  }

  private coreHost(): ProjectGitCoreHost {
    return {
      bases: this.bases,
      projectService: this.projectService,
      workspaceStore: this.workspaceStore,
      thresholds: this.thresholds,
      boundary: this.boundary,
      runGitImpl: this.runGitImpl,
      resolveGithubCredential: this.resolveGithubCredential,
      diff: this.diff.bind(this),
      validId: validId,
      redactSecrets: redactSecrets,
      execFileAsync: execFileAsync,
      resolveProjectWorkspace: this.resolveProjectWorkspace.bind(this),
      runGit: this.runGit.bind(this),
      assertSafeIndex: this.assertSafeIndex.bind(this),
      requireWrite: this.requireWrite.bind(this),
      githubToken: this.githubToken.bind(this),
      inspectRepository: this.inspectRepository.bind(this),
      ensureRepositoryInitialized: this.ensureRepositoryInitialized.bind(this),
      ensureRepository: this.ensureRepository.bind(this),
      status: this.status.bind(this),
      log: this.log.bind(this),
      branch: this.branch.bind(this),
      stage: this.stage.bind(this),
      commit: this.commit.bind(this),
      createCheckpoint: this.createCheckpoint.bind(this),
      getCheckpoint: this.getCheckpoint.bind(this),
      restoreCheckpoint: this.restoreCheckpoint.bind(this),
      restorePaths: this.restorePaths.bind(this),
      resolveRevertTarget: this.resolveRevertTarget.bind(this),
      removePathForRevert: this.removePathForRevert.bind(this),
      assertNoSymlinkPath: this.assertNoSymlinkPath.bind(this),
      push: this.push.bind(this),
      createPullRequest: this.createPullRequest.bind(this),
      commentOnPullRequest: this.commentOnPullRequest.bind(this),
      resolveWriteIntent: this.resolveWriteIntent.bind(this),
      currentBranch: this.currentBranch.bind(this),
      requireGitWriteApproval: this.requireGitWriteApproval.bind(this),
      assertWorkspaceRevisionUnchanged: this.assertWorkspaceRevisionUnchanged.bind(this),
      acquireCredential: this.acquireCredential.bind(this),
      createAgentWorktree: this.createAgentWorktree.bind(this),
      commitAgentWorktree: this.commitAgentWorktree.bind(this),
      diffAgentWorktree: this.diffAgentWorktree.bind(this),
      mergeAgentWorktree: this.mergeAgentWorktree.bind(this),
      removeAgentWorktree: this.removeAgentWorktree.bind(this),
      cleanupAllWorktrees: this.cleanupAllWorktrees.bind(this),
      listAgentWorktrees: this.listAgentWorktrees.bind(this),
    };
  }

  private workspaceHost(): ProjectGitWorkspaceHost {
    return {
      bases: this.bases,
      projectService: this.projectService,
      runGitImpl: this.runGitImpl,
      validId: validId,
      redactSecrets: redactSecrets,
      parseConflictFiles: this.parseConflictFiles.bind(this),
      status: this.status.bind(this),
      execFileAsync: execFileAsync,
      ensureRepositoryInitialized: this.ensureRepositoryInitialized.bind(this),
    };
  }

  private guardHost(): ProjectGitGuardHost {
    return {
      boundary: this.boundary,
      workspaceStore: this.workspaceStore,
      runGit: this.runGit.bind(this),
      getCheckpoint: this.getCheckpoint.bind(this),
      listCheckpoints: this.listCheckpoints.bind(this),
    };
  }

  private historyHost(): ProjectGitHistoryHost {
    return {
      runGit: this.runGit.bind(this),
      requireWrite: this.requireWrite.bind(this),
      ensureRepository: this.ensureRepository.bind(this),
      assertSafeIndex: this.assertSafeIndex.bind(this),
      status: this.status.bind(this),
      stage: this.stage.bind(this),
    };
  }

  private cleanupHost(): ProjectGitCleanupHost {
    return {
      runGit: this.runGit.bind(this),
      requireWrite: this.requireWrite.bind(this),
      ensureRepository: this.ensureRepository.bind(this),
    };
  }

  private branchHost(): ProjectGitBranchHost {
    return {
      inspectRepository: this.inspectRepository.bind(this),
    };
  }

  private credentialHost(): ProjectGitCredentialHost {
    return {
      boundary: this.boundary,
      resolveGithubCredential: this.resolveGithubCredential,
    };
  }

  private pushHost(): ProjectGitPushHost {
    return {
      boundary: this.boundary,
      resolveGithubCredential: this.resolveGithubCredential,
      runGit: this.runGit.bind(this),
      requireWrite: this.requireWrite.bind(this),
      requireGitWriteApproval: this.requireGitWriteApproval.bind(this),
      acquireCredential: this.acquireCredential.bind(this),
      ensureRepositoryInitialized: this.ensureRepositoryInitialized.bind(this),
      inspectRepository: this.inspectRepository.bind(this),
      resolveWriteIntent: this.resolveWriteIntent.bind(this),
      assertGitWriteBoundary: this.assertGitWriteBoundary.bind(this),
      captureWorkspaceRevision: this.captureWorkspaceRevision.bind(this),
      assertWorkspaceRevisionUnchanged: this.assertWorkspaceRevisionUnchanged.bind(this),
      credentialEnvironment: this.credentialEnvironment.bind(this),
    };
  }

  private checkpointWriteHost(): ProjectGitCheckpointWriteHost {
    return {
      workspaceStore: this.workspaceStore,
      assertSafeIndex: this.assertSafeIndex.bind(this),
      ensureRepository: this.ensureRepository.bind(this),
      getProjectPath: this.getProjectPath.bind(this),
      requireWrite: this.requireWrite.bind(this),
      runGit: this.runGit.bind(this),
      status: this.status.bind(this),
      countWorkspaceFiles: this.countWorkspaceFiles.bind(this),
    };
  }

  private worktreeExtraHost(): ProjectGitWorktreeExtraHost {
    return {
      runGit: this.runGit.bind(this),
      requireWrite: this.requireWrite.bind(this),
      ensureRepository: this.ensureRepository.bind(this),
      getAgentWorktreePath: this.getAgentWorktreePath.bind(this),
    };
  }

  private repositoryHost(): ProjectGitRepositoryHost {
    return {
      bases: this.bases,
      assertSafeIndex: this.assertSafeIndex.bind(this),
      ensureRepository: this.ensureRepository.bind(this),
      requireWrite: this.requireWrite.bind(this),
      runGit: this.runGit.bind(this),
      resolveProjectWorkspace: this.resolveProjectWorkspace.bind(this),
    };
  }

  private approvalHost(): ProjectGitApprovalHost {
    return {
      boundary: this.boundary,
      currentBranch: this.currentBranch.bind(this),
    };
  }

  private checkpointHost(): ProjectGitCheckpointHost {
    return {
      requireWrite: this.requireWrite.bind(this),
      ensureRepository: this.ensureRepository.bind(this),
      getCheckpoint: this.getCheckpoint.bind(this),
      createCheckpoint: this.createCheckpoint.bind(this),
      runGit: this.runGit.bind(this),
      assertNoSymlinkPath: this.assertNoSymlinkPath.bind(this),
      resolveRevertTarget: this.resolveRevertTarget.bind(this),
      pathExistsInCommit: this.pathExistsInCommit.bind(this),
      removePathForRevert: this.removePathForRevert.bind(this),
    };
  }

  private pullRequestHost(): ProjectGitPullRequestHost {
    return {
      boundary: this.boundary,
      resolveGithubCredential: this.resolveGithubCredential,
      getProjectPath: this.getProjectPath.bind(this),
      requireGitWriteApproval: this.requireGitWriteApproval.bind(this),
      requireWrite: this.requireWrite.bind(this),
      acquireCredential: this.acquireCredential.bind(this),
    };
  }

  private worktreeHost(): ProjectGitWorktreeHost {
    return {
      mergeLocks: this.mergeLocks,
      runGit: this.runGit.bind(this),
      requireWrite: this.requireWrite.bind(this),
      ensureRepository: this.ensureRepository.bind(this),
      branch: this.branch.bind(this),
      getAgentWorktreePath: this.getAgentWorktreePath.bind(this),
      safeAgentSlug: safeAgentSlug,
    };
  }

  /**
   * The project workspace path, after every authorization check that is not about the repository's state:
   * identifier shape, the project lookup, tenant/workspace ownership, the archived status, the git
   * permission, and the "no symlinked workspace" check.
   *
   * `create` is what separates the two callers and is the whole point of C11's split: the ordinary path
   * creates the workspace directories (the historical behaviour), while `inspectRepository` runs with
   * `create: false` and therefore creates **nothing** — a missing segment is reported as "this workspace
   * does not exist yet" instead of being materialised.
   */
    private async resolveProjectWorkspace(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { create: boolean },
  ): Promise<{ project: Project; dir: string; readOnly: boolean; mounted: boolean }> {
    return resolveProjectWorkspace(this.workspaceHost(), ctx, companyId, projectId, options);
  }

    async getProjectPath(ctx: AuthContext, companyId: string, projectId: string): Promise<{ project: Project; dir: string }> {
    return getProjectPath(this.coreHost(), ctx, companyId, projectId);
  }

    private async runGit(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
    return runGit(this.workspaceHost(), dir, args, env);
  }

    private async assertSafeIndex(dir: string): Promise<void> {
    return assertSafeIndex(this.workspaceHost(), dir);
  }

    private parseConflictFiles(output: string): string[] {
    return parseConflictFiles(this.coreHost(), output);
  }

    private requireWrite(ctx: AuthContext): void {
    return requireWrite(this.workspaceHost(), ctx);
  }

    async connectRepository(ctx: AuthContext, companyId: string, projectId: string, input: { url: string; branch?: string }): Promise<Project> {
    return connectRepository(this.coreHost(), ctx, companyId, projectId, input);
  }

    private async githubToken(ctx: AuthContext, companyId: string, credentialId?: string): Promise<string> {
    return githubToken(this.credentialHost(), ctx, companyId, credentialId);
  }

  /**
   * C11 (owner decision 13, the last known issue): **read-only** repository inspection.
   *
   * What it may do, exhaustively:
   *  - `resolveProjectWorkspace(..., { create: false })` — the authorization checks (`getProjectPath`
   *    without its `mkdir`), so no directory and no file is created;
   *  - `lstat(<dir>/.git)` — a stat, never a write;
   *  - when `.git` is a directory: `git rev-parse --show-toplevel` (the workspace-membership proof the old
   *    `ensureRepository` made **after** initializing, now made before anything can happen) and
   *    `git rev-parse --abbrev-ref HEAD` (the checked-out branch).
   *
   * Both git invocations are read-only `rev-parse` probes: they read the object database/HEAD and print a
   * value. Neither creates `.git`, writes `config`, stages anything, nor touches the worktree — which is why
   * this method is safe to call **before** policy, RBAC and the approval record, and why a request that is
   * refused afterwards leaves the disk byte-identical (pinned by
   * `tests/coding-agent-c11-git-init-approval.test.ts`).
   *
   * `initialized: false` therefore means exactly "there is no repository here yet". It is reported, never
   * repaired: creating the repository is `ensureRepositoryInitialized()` and it happens only behind an
   * approval that binds that fact.
   */
    async inspectRepository(ctx: AuthContext, companyId: string, projectId: string): Promise<GitRepositoryInspection> {
    return inspectRepository(this.repositoryHost(), ctx, companyId, projectId);
  }

  /**
   * C11 (owner decision 13): the **mutating** half, and the only place in this service that creates a
   * repository.
   *
   * It runs `git init`, the four identity/hook settings, the `.gitignore` write and the initial commit when
   * `.git` is absent, and then proves the repository belongs to this workspace. Every caller that can reach
   * it with an uninitialized workspace must have passed policy, RBAC and — for a remote write — the approval
   * record first; `push` calls it immediately before the credential lease and the push, after the approval
   * that binds `repositoryInitialized: false` has been consumed. A read-only path must never call it.
   */
    async ensureRepositoryInitialized(ctx: AuthContext, companyId: string, projectId: string): Promise<string> {
    return ensureRepositoryInitialized(this.repositoryHost(), ctx, companyId, projectId);
  }

  /**
   * C11: the historical name of the mutating half, kept for the existing callers (the read paths — `status`,
   * `diff`, `log`, `branch`, the checkpoint and worktree methods — and the project lifecycle code outside
   * this module). It is deliberately an alias and not a second implementation: one place creates a
   * repository. A **write** path must not use it before its checks; the C11 write path uses
   * `inspectRepository()` and `ensureRepositoryInitialized()` instead.
   *
   * @deprecated mutating; use `inspectRepository()` to read the state and `ensureRepositoryInitialized()`
   * after the authorization and approval of a write.
   */
    async ensureRepository(ctx: AuthContext, companyId: string, projectId: string): Promise<string> {
    return ensureRepository(this.workspaceHost(), ctx, companyId, projectId);
  }

    async status(ctx: AuthContext, companyId: string, projectId: string): Promise<GitStatusResult> {
    return status(this.repositoryHost(), ctx, companyId, projectId);
  }

  async diff(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options?: { file?: string; staged?: boolean },
  ): Promise<{ diff: string }> {
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const args = ["diff", "--no-ext-diff"];
    if (options?.staged) args.push("--cached");
    if (options?.file) {
      const cleanPath = safeProjectPath(options.file);
      args.push("--", cleanPath);
    }
    const { stdout } = await this.runGit(dir, args);
    return { diff: stdout.slice(0, 128_000) };
  }

    async log(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    limit = 20,
  ): Promise<GitLogEntry[]> {
    return log(this.historyHost(), ctx, companyId, projectId, limit);
  }

    async branch(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { action: "list" | "create" | "switch"; branch?: string },
  ): Promise<GitBranchResult> {
    return branch(this.repositoryHost(), ctx, companyId, projectId, options);
  }

    async stage(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    files?: string[],
  ): Promise<{ staged: string[] }> {
    return stage(this.workspaceHost(), ctx, companyId, projectId, files);
  }

    async commit(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { message: string; files?: string[]; stageAll?: boolean },
  ): Promise<{ commitHash: string; message: string }> {
    return commit(this.historyHost(), ctx, companyId, projectId, options);
  }

    async restore(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { files: string[] },
  ): Promise<{ restored: string[] }> {
    return restore(this.coreHost(), ctx, companyId, projectId, options);
  }

    async countWorkspaceFiles(dir: string): Promise<number> {
    return countWorkspaceFiles(this.coreHost(), dir);
  }

    async isLargeChange(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<{ isLarge: boolean; changedFiles: number; changedLines: number }> {
    return isLargeChange(this.coreHost(), ctx, companyId, projectId);
  }

    async createCheckpoint(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { name: string; description?: string; trigger?: CheckpointTrigger; runId?: string },
  ): Promise<ProjectCheckpoint> {
    return createCheckpoint(this.checkpointWriteHost(), ctx, companyId, projectId, input);
  }

    async listCheckpoints(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    limit = 50,
  ): Promise<ProjectCheckpoint[]> {
    return listCheckpoints(this.coreHost(), ctx, companyId, projectId, limit);
  }

    async getCheckpoint(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    checkpointId: string,
  ): Promise<ProjectCheckpoint> {
    return getCheckpoint(this.checkpointWriteHost(), ctx, companyId, projectId, checkpointId);
  }

    async restoreCheckpoint(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    checkpointId: string,
    options?: { approved?: boolean },
  ): Promise<{ restoredCheckpoint: ProjectCheckpoint; backupCheckpoint: ProjectCheckpoint }> {
    return restoreCheckpoint(this.checkpointHost(), ctx, companyId, projectId, checkpointId, options);
  }

  /**
   * C7: revert **only the named paths** to the state they had at a checkpoint (or an explicit revision).
   *
   * The semantics are "make these paths look like the checkpoint", which is not the same as "restore whatever HEAD
   * has":
   *  - a path that **existed in the checkpoint** is restored from it — this covers a modified file, a file deleted
   *    after the checkpoint, and the old side of a rename;
   *  - a path that **did not exist in the checkpoint** but exists now was created afterwards, so it is **removed** —
   *    the new side of a rename disappears, and the pair of paths ends up in the checkpoint state;
   *  - the target is always a checkpoint commit (or an explicit revision), never a bare `HEAD`: anchoring on HEAD
   *    would keep the changes the run committed after the checkpoint.
   *
   * Why this is its own method instead of `restoreCheckpoint`: that one reverts everything with `git reset --hard` +
   * `git clean -fd`, which is right for "revert all" and destructive for "revert this one file" — it would discard
   * unrelated work nobody asked to touch. Nothing here resets the workspace.
   *
   * Guards, all enforced **before** any filesystem or git change:
   *  - every path goes through the canonical `safeProjectPath` (refuses `..`, absolute paths, drive letters,
   *    backslashes, protected/secret paths) and `~`-prefixed paths are refused outright;
   *  - each path component is checked with `lstat` **and** `realpath`, because a Windows junction is a reparse point
   *    that `lstat().isSymbolicLink()` does not report — and since this method can now **delete**, a link that
   *    resolves outside the workspace must abort the call rather than let the deletion follow it;
   *  - a mandatory pre-revert safety checkpoint is taken first, so the revert itself is reversible;
   *  - per-path outcomes are collected, so one path that cannot be reverted never marks the others as done.
   */
    async restorePaths(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { files: string[]; checkpointId?: string; commitHash?: string },
  ): Promise<{ restored: string[]; removed: string[]; failed: Array<{ path: string; reason: string }>; targetCommit: string; safetyCheckpointId: string | null }> {
    return restorePaths(this.checkpointHost(), ctx, companyId, projectId, input);
  }

  /**
   * The commit a path revert is anchored on: an explicit revision, else the newest `pre_run` checkpoint (falling back
   * to the newest checkpoint). A bare `HEAD` is deliberately **not** a fallback — anchoring on HEAD would silently
   * keep whatever the run committed after the checkpoint, which is the opposite of "revert to the checkpoint state".
   */
    private async resolveRevertTarget(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { checkpointId?: string; commitHash?: string },
  ): Promise<string> {
    return resolveRevertTarget(this.guardHost(), ctx, companyId, projectId, input);
  }

  /** Whether a path exists at a commit. `cat-file -e` exits non-zero for a path that is not in that tree. */
    private async pathExistsInCommit(dir: string, commit: string, file: string): Promise<boolean> {
    return pathExistsInCommit(this.coreHost(), dir, commit, file);
  }

  /**
   * Removes a path that did not exist at the checkpoint, which is how "revert a path that was created afterwards"
   * reaches the checkpoint state. Every safety check happens before the deletion, and only the named path is touched:
   * parents are never pruned, so a revert can never take a directory with it.
   */
    private async removePathForRevert(dir: string, file: string): Promise<void> {
    return removePathForRevert(this.guardHost(), dir, file);
  }

  /** Refuse a path that is, or traverses, a symlink: git must never write through a link out of the workspace. */
    private async assertNoSymlinkPath(dir: string, files: string[]): Promise<void> {
    return assertNoSymlinkPath(this.guardHost(), dir, files);
  }

    async push(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: {
      branch?: string;
      /**
       * C11: the local branch to publish, when it differs from the remote branch being written. The
       * `code.git.push` tool names both, and the approval payload binds both, so the two must resolve to the
       * same pair on the request side and at the boundary — collapsing them here would make the hashes
       * disagree and refuse every approval.
       */
      sourceBranch?: string;
      credentialId?: string;
      approved?: boolean;
      /** C11: `true` asks for a history rewrite. The policy judges it; the structured API then refuses it. */
      force?: boolean;
      /** C11: a remote the caller names explicitly, when one is meaningful (bound into the approval hash). */
      remote?: string;
      /** C11 (owner decision 5): the real approval record for this exact write. */
      approval?: GitWriteApprovalRequest;
    },
  ): Promise<{ pushed: boolean; branch: string; remote: string }> {
    return push(this.pushHost(), ctx, companyId, projectId, options);
  }

    async createPullRequest(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: {
      title: string;
      body?: string;
      base?: string;
      head?: string;
      credentialId?: string;
      approved?: boolean;
      /**
       * C11: the tool id the approval record was created under. It is part of the approval **payload**, so it
       * must be the same string on both sides — the requester (`code-tool-runtime`) names the tool it was
       * called with, and the boundary rebuilds the payload here. Defaulting to `project.git.pr` keeps every
       * existing caller (`company-tool-runtime`) byte-for-byte identical, and the `code.git.pr.create`
       * executor passes its own id, which is what makes the two hashes comparable.
       */
      toolName?: string;
      /** C11 (owner decision 5): the real approval record for this exact pull request. */
      approval?: GitWriteApprovalRequest;
    },
  ): Promise<{ prNumber?: number; prUrl?: string; message: string }> {
    return createPullRequest(this.pullRequestHost(), ctx, companyId, projectId, options);
  }

  /**
   * C11 (owner decisions 10 and 11): post one comment on an existing pull request.
   *
   * This is the sanctioned way a `REVIEW_CODE` session says something about a pull request. Reviewing is
   * read-only, and the only thing a review may *write* is a comment — which is not repository state, and
   * which therefore needs neither a branch nor a protected-branch decision. It does need an approval, and it
   * gets its **own** binding: the pull-request number and a hash of the comment text. An approval obtained
   * for a push or for opening a pull request produces a different payload hash, so the durable approval
   * gateway refuses to redeem it here — that is what "PR comments require a separate approval" means in
   * code rather than in a comment.
   *
   * The credential is a one-operation lease whose value only ever reaches the `Authorization` header of this
   * single request and which is revoked in the `finally`, exactly like a push.
   */
    async commentOnPullRequest(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: {
      pullNumber: number;
      body: string;
      credentialId?: string;
      approved?: boolean;
      approval?: GitWriteApprovalRequest;
    },
  ): Promise<{ commentId?: number; commentUrl?: string; pullNumber: number; message: string }> {
    return commentOnPullRequest(this.pullRequestHost(), ctx, companyId, projectId, options);
  }

  /**
   * C11 (owner decision 3): the branch a remote write targets, as the **typed** intent the policy and the
   * approval both read. A named branch is used as given; without one the **inspection** is asked (never the
   * configured default, never a `git init`), and an unresolvable checkout refuses instead of guessing.
   *
   * C11 (owner decision 13): the intent also carries the initialization fact the inspection resolved. It is
   * what `gitApprovalPayload` binds as `repositoryInitialized: false`, so the approval covers the act of
   * creating the repository — and only that act.
   */
    private async resolveWriteIntent(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    project: Project,
    namedBranch: string | undefined,
    force: boolean,
    credentialId?: string,
    namedSourceBranch?: string,
    inspection?: GitRepositoryInspection,
  ): Promise<GitWriteIntent> {
    return resolveWriteIntent(this.approvalHost(), ctx, companyId, projectId, project, namedBranch, force, credentialId, namedSourceBranch, inspection);
  }

  /**
   * The branch the project checkout is on, from a **read-only** inspection.
   *
   * Before C11 this called `ensureRepository`, which initializes a repository that does not exist — so
   * asking "which branch is this?" could create `.git`, write `.gitignore` and commit, for a request that
   * was on its way to being refused. The inspection answers the same question with `lstat` and two
   * `rev-parse` probes, and an uninitialized workspace is reported as what it is.
   */
    private async currentBranch(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    inspection?: GitRepositoryInspection,
  ): Promise<string> {
    return currentBranch(this.branchHost(), ctx, companyId, projectId, inspection);
  }

  /**
   * C11 (owner decision 5): consume the real approval record for this write.
   *
   * Two refusals are possible and both are deliberate: no approval port means the deployment cannot verify
   * an approval at all (503, fail closed), and no approval *record* means the caller presented only the
   * `approved` flag — which is not proof (`GIT_APPROVAL_RECORD_REQUIRED`).
   */
    private async requireGitWriteApproval(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    binding: GitWriteIntent | { projectId: string; tool: string; payload: Record<string, unknown> },
    toolName: string,
    approval?: GitWriteApprovalRequest,
  ): Promise<void> {
    return requireGitWriteApproval(this.approvalHost(), ctx, companyId, projectId, binding, toolName, approval);
  }

  /**
   * C11 (owner decision 3): the second, independent protected-branch check, immediately before the write.
   * No port means no check, and no check means no write.
   */
    private async assertGitWriteBoundary(ctx: AuthContext, companyId: string, intent: GitWriteIntent): Promise<void> {
    return assertGitWriteBoundary(this.coreHost(), ctx, companyId, intent);
  }

  /**
   * C11 (owner decision 7 + 13): the canonical revision this write is prepared from, read **before** the
   * approval is consumed and before any side effect. `null` means no guard is wired (a service built by hand
   * in a test), in which case no revision is claimed rather than assumed unchanged. A guard that cannot read
   * the revision throws (`workspace_revision_mismatch`) — an unprovable revision is a refusal, never a pass.
   */
    private async captureWorkspaceRevision(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<CodeWorkspaceRevisionSnapshot | null> {
    return captureWorkspaceRevision(this.coreHost(), ctx, companyId, projectId);
  }

  /**
   * C11 (owner decision 7 + 13): the second half of the revision proof, run **after** the write's own
   * initialization and immediately before the credential lease and the push. A moved revision is
   * `workspace_revision_mismatch` (409, retryable) with no push at all.
   */
    private async assertWorkspaceRevisionUnchanged(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    snapshot: CodeWorkspaceRevisionSnapshot | null,
  ): Promise<void> {
    return assertWorkspaceRevisionUnchanged(this.guardHost(), ctx, companyId, projectId, snapshot);
  }

  /**
   * C11 (owner decision 6): the credential for one git operation.
   *
   * The lease port is the production path (one lease, one operation, revoked in the caller's `finally`).
   * The legacy resolver stays as the fallback for non-production hosts; in both cases the value only ever
   * reaches `credentialEnvironment`, i.e. the process-scoped environment of one invocation — never
   * `.git/config`, never a log, never the returned result.
   */
    private async acquireCredential(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { credentialId?: string; purpose: "git.push" | "pull_request.create" | "pull_request.comment"; toolCallId: string },
  ): Promise<{ value: string; leaseId: string | null }> {
    return acquireCredential(this.credentialHost(), ctx, companyId, projectId, input);
  }

  /**
   * C11 (owner decision 6): the git hardening of a credentialed invocation, all of it scoped to this one
   * process.
   *
   * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` sits at **command-line scope**, so the authorization extraheader
   * is given to this invocation only and `.git/config` is never written. The same scope *neutralises* the
   * credential surfaces too: an empty `credential.helper` resets the helper list (a helper configured in
   * the repository or in a user config cannot run), an empty `core.askPass` disables a configured askpass,
   * and `GIT_TERMINAL_PROMPT=0` is already set by `runGit`. `GIT_CONFIG_NOSYSTEM=1` removes the system
   * config from the same invocation.
   */
    private credentialEnvironment(token: string): Record<string, string> {
    return credentialEnvironment(this.coreHost(), token);
  }

  private readonly mergeLocks = new Map<string, Promise<void>>();

    getAgentWorktreePath(dir: string, agentSlug: string): string {
    return getAgentWorktreePath(this.coreHost(), dir, agentSlug);
  }

    async createAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentSlug: string; baseBranch?: string },
  ): Promise<{ worktreePath: string; branch: string; baseBranch: string }> {
    return createAgentWorktree(this.worktreeHost(), ctx, companyId, projectId, options);
  }

    async commitAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentSlug: string; message: string; stageAll?: boolean },
  ): Promise<{ commitHash: string; message: string }> {
    return commitAgentWorktree(this.worktreeHost(), ctx, companyId, projectId, options);
  }

    async diffAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentSlug: string; baseBranch?: string },
  ): Promise<{ diff: string; files: string[] }> {
    return diffAgentWorktree(this.worktreeExtraHost(), ctx, companyId, projectId, options);
  }

  /**
   * C11 (owner decision 9): merge an agent worktree with a **real** automatic-resolution budget.
   *
   * The loop is the mechanism the escalation message used to describe without implementing. It runs the
   * merge, and when the attempt conflicts it detects the unmerged paths with `--diff-filter=U`, aborts the
   * in-progress merge so the workspace is left clean, and — only if a resolver produced a concrete strategy
   * and the budget is not spent — retries with that strategy. `runMergeWithAutoResolve` counts the attempts
   * that were actually run, so the number in the escalation is evidence.
   *
   * The resolver is injected and optional. Without one, attempt 1 is the only attempt and the escalation says
   * `1` rather than promising two. With one (a model-driven resolution, a project policy, a two-person
   * decision), attempt 2 really runs and can really succeed. `code.ask_user` is the suggested next step,
   * because the agent that called this owns the run that has to wait.
   */
    async mergeAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: {
      agentSlug: string;
      targetBranch?: string;
      message?: string;
      /** C11: the automatic-resolution strategy provider; absent means no automatic retry is attempted. */
      conflictResolver?: GitConflictResolverPort | null;
      /** C11: overrides the budget. Clamped to `MAX_GIT_MERGE_ATTEMPTS` so a caller cannot raise it. */
      maxAttempts?: number;
    },
  ): Promise<{ merged: boolean; commitHash: string; targetBranch: string; sourceBranch: string; attempts: number }> {
    return mergeAgentWorktree(this.worktreeHost(), ctx, companyId, projectId, options);
  }

    async removeAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentSlug: string; deleteBranch?: boolean },
  ): Promise<{ removed: boolean }> {
    return removeAgentWorktree(this.worktreeExtraHost(), ctx, companyId, projectId, options);
  }

    async cleanupAllWorktrees(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<{ cleanedCount: number }> {
    return cleanupAllWorktrees(this.cleanupHost(), ctx, companyId, projectId);
  }

    async listAgentWorktrees(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<Array<{ worktreePath: string; branch: string; head: string }>> {
    return listAgentWorktrees(this.worktreeHost(), ctx, companyId, projectId);
  }
}
