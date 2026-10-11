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
    if (!validId(companyId) || !validId(projectId)) {
      throw new GitError("INVALID_IDENTIFIER", "Invalid company or project identifier", 400);
    }
    const project = await this.projectService.get(ctx, companyId, projectId);
    if (project.companyId !== companyId || project.id !== projectId || project.workspaceId !== ctx.workspaceId) {
      throw new GitError("PROJECT_ACCESS_DENIED", "Access to project git workspace denied", 403);
    }
    if (project.status === "archived") {
      throw new GitError("PROJECT_ARCHIVED", "Archived project cannot perform git operations", 409);
    }
    if (!ctx.permissions.some((permission) => ["*", "owner", "business:manage", "workspace:read", "workspace:write"].includes(permission))) throw new GitError("PROJECT_ACCESS_DENIED", "Git permission denied", 403);
    /**
     * C15: the workspace comes from the **same resolver** the `WorkspaceProvider` reads, so git, the file tools
     * and the sandbox all act on one canonical directory. A mounted project's git repository is therefore the
     * user's own repository in their own folder — not a copy under the managed root.
     */
    const resolved: WorkspaceBase = await this.bases.resolve(ctx, companyId, projectId);
    const dir = resolved.base;
    if (options.create && resolved.readOnly) {
      // `inspectRepository` (create: false) stays allowed on an `ro` mount — reading a repository is the whole
      // point of a read-only mount — while every path that may materialise a directory or write is refused.
      throw new GitError("MOUNTED_FOLDER_READ_ONLY", "The mounted project folder is read only", 403);
    }
    /**
     * The segments to walk differ by source. A managed workspace is created under the root, so the root, the
     * company directory and the project directory are all checked for a link. A mounted folder already exists
     * and its path was validated component by component by the resolver (realpath + `lstat`, which is what
     * catches a junction), so the managed-root check must **not** be applied to it: the mount is deliberately
     * outside that root, and comparing it against the root would refuse every legitimate mount.
     */
    const segments = resolved.mounted ? [dir] : [this.bases.managedRoot, path.join(this.bases.managedRoot, companyId), dir];
    for (const segment of segments) {
      if (options.create && !resolved.mounted) {
        await mkdir(segment).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      }
      // A read-only caller must tolerate a segment that does not exist, and must not create it: walking one
      // level deeper would be meaningless (nothing below a missing directory exists) and every level above
      // the missing one was already checked. The creating caller keeps the historical behaviour of a hard
      // failure, because after its own `mkdir` a missing directory is a real error, not an absent workspace.
      const entry = await lstat(segment).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && !options.create) return null;
        throw error;
      });
      if (!entry) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new GitError("INVALID_WORKSPACE", "Symlink workspace is not allowed", 403);
    }
    return { project, dir, readOnly: resolved.readOnly, mounted: resolved.mounted };
  }

  async getProjectPath(ctx: AuthContext, companyId: string, projectId: string): Promise<{ project: Project; dir: string }> {
    return this.resolveProjectWorkspace(ctx, companyId, projectId, { create: true });
  }

  private async runGit(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
    if (this.runGitImpl) return this.runGitImpl(dir, args, env);
    try {
      const result = await execFileAsync("git", ["-c", `core.hooksPath=${path.join(dir, ".git", "npati-disabled-hooks")}`, ...args], {
        cwd: dir,
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          ...env,
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (err: any) {
      const combined = redactSecrets(`${err.stdout ?? ""} ${err.stderr ?? ""} ${err.message ?? ""}`);
      const conflictFiles = this.parseConflictFiles(combined);
      if (conflictFiles.length > 0) {
        throw new GitConflictError(conflictFiles, combined);
      }
      throw new GitError("GIT_COMMAND_FAILED", `Git command failed: ${combined.slice(0, 500)}`, 400);
    }
  }

  private async assertSafeIndex(dir: string): Promise<void> {
    const { stdout } = await this.runGit(dir, ["diff", "--no-ext-diff", "--cached", "--name-only", "-z"]);
    for (const file of stdout.split("\0").filter(Boolean)) {
      try { safeProjectPath(file); }
      catch { throw new GitError("PROTECTED_FILE", "Protected files cannot be staged or committed", 403); }
    }
  }

  private parseConflictFiles(output: string): string[] {
    const files = new Set<string>();
    const conflictRegex = /CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+([^\r\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = conflictRegex.exec(output)) !== null) {
      if (match[1]) files.add(match[1].trim());
    }
    const bothModifiedRegex = /(?:both modified|both added|both deleted):\s+([^\r\n]+)/gi;
    while ((match = bothModifiedRegex.exec(output)) !== null) {
      if (match[1]) files.add(match[1].trim());
    }
    return [...files];
  }

  private requireWrite(ctx: AuthContext): void {
    if (!ctx.permissions.some((permission) => ["*", "owner", "business:manage", "workspace:write"].includes(permission))) {
      throw new GitError("PROJECT_WRITE_DENIED", "Project Git write permission denied", 403);
    }
  }

  async connectRepository(ctx: AuthContext, companyId: string, projectId: string, input: { url: string; branch?: string }): Promise<Project> {
    this.requireWrite(ctx);
    await this.getProjectPath(ctx, companyId, projectId);
    let parsed: URL;
    try { parsed = new URL(input.url); } catch { throw new GitError("INVALID_REPOSITORY_URL", "Invalid repository URL", 400); }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new GitError("INVALID_REPOSITORY_URL", "A credential-free GitHub HTTPS URL is required", 400);
    }
    const segments = parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
    if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment))) {
      throw new GitError("INVALID_REPOSITORY_URL", "Invalid GitHub repository path", 400);
    }
    const branch = input.branch?.trim() || "main";
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(branch) || branch.includes("..") || branch.includes("@{") || branch.endsWith(".lock")) {
      throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
    }
    return this.workspaceStore.updateProjectRepository(ctx, companyId, projectId, {
      provider: "github", url: `https://github.com/${segments[0]}/${segments[1]}.git`, branch,
    });
  }

  private async githubToken(ctx: AuthContext, companyId: string, credentialId?: string): Promise<string> {
    if (!credentialId || !this.resolveGithubCredential) throw new GitError("CREDENTIAL_MISSING", "A Company vault credential reference is required", 400);
    return this.resolveGithubCredential(ctx, companyId, credentialId);
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
    return this.ensureRepositoryInitialized(ctx, companyId, projectId);
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
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 100));
    try {
      const { stdout } = await this.runGit(dir, ["log", `-n`, String(safeLimit), `--pretty=format:%H|%an|%ad|%s`]);
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      return lines.map((line) => {
        const [hash = "", author = "", date = "", ...msgParts] = line.split("|");
        return {
          hash,
          author,
          date,
          message: msgParts.join("|"),
        };
      });
    } catch {
      return [];
    }
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
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    if (!files || files.length === 0 || files.includes(".")) {
      await this.runGit(dir, ["add", "-A"]);
    } else {
      const safeFiles = files.map((f) => safeProjectPath(f));
      await this.runGit(dir, ["add", "--", ...safeFiles]);
    }
    await this.assertSafeIndex(dir);
    const st = await this.status(ctx, companyId, projectId);
    return { staged: st.staged };
  }

  async commit(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { message: string; files?: string[]; stageAll?: boolean },
  ): Promise<{ commitHash: string; message: string }> {
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    if (!options.message || !options.message.trim()) {
      throw new GitError("COMMIT_MESSAGE_REQUIRED", "Commit message is required", 400);
    }
    if (options.stageAll || options.files) {
      await this.stage(ctx, companyId, projectId, options.files);
    }
    let st = await this.status(ctx, companyId, projectId);
    if (st.staged.length === 0) {
      await this.stage(ctx, companyId, projectId);
      st = await this.status(ctx, companyId, projectId);
    }
    await this.assertSafeIndex(dir);
    await this.runGit(dir, st.staged.length === 0 ? ["commit", "--allow-empty", "-m", options.message.trim()] : ["commit", "-m", options.message.trim()]);

    const { stdout } = await this.runGit(dir, ["rev-parse", "HEAD"]);
    const commitHash = stdout.trim();
    return { commitHash, message: options.message.trim() };
  }

  async restore(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { files: string[] },
  ): Promise<{ restored: string[] }> {
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    if (!options.files || options.files.length === 0) {
      throw new GitError("FILES_REQUIRED", "List of files to restore is required", 400);
    }
    const safeFiles = options.files.map((f) => safeProjectPath(f));
    try {
      await this.runGit(dir, ["checkout", "HEAD", "--", ...safeFiles]);
    } catch {
      await this.runGit(dir, ["restore", "--staged", "--worktree", "--", ...safeFiles]);
    }
    return { restored: safeFiles };
  }

  async countWorkspaceFiles(dir: string): Promise<number> {
    let count = 0;
    const countDir = async (cur: string) => {
      const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name === ".git" || e.name === "node_modules" || e.name === "dist") continue;
        if (e.isDirectory()) await countDir(path.join(cur, e.name));
        else if (e.isFile()) count++;
      }
    };
    await countDir(dir);
    return count;
  }

  async isLargeChange(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<{ isLarge: boolean; changedFiles: number; changedLines: number }> {
    try {
      const st = await this.status(ctx, companyId, projectId);
      const changedFiles = new Set([...st.staged, ...st.unstaged, ...st.untracked]).size;
      const { diff } = await this.diff(ctx, companyId, projectId);
      const { diff: stagedDiff } = await this.diff(ctx, companyId, projectId, { staged: true });
      const changedLines = (diff + "\n" + stagedDiff).split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line)).length;
      const isLarge = changedFiles >= this.thresholds.fileThreshold || changedLines >= this.thresholds.lineThreshold;
      return { isLarge, changedFiles, changedLines };
    } catch {
      return { isLarge: false, changedFiles: 0, changedLines: 0 };
    }
  }

  async createCheckpoint(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { name: string; description?: string; trigger?: CheckpointTrigger; runId?: string },
  ): Promise<ProjectCheckpoint> {
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const trigger = input.trigger ?? "manual";

    // Commit any uncommitted changes to create a valid git snapshot
    const st = await this.status(ctx, companyId, projectId);
    if (!st.clean) {
      await this.runGit(dir, ["add", "-A"]);
      await this.assertSafeIndex(dir);
      await this.runGit(dir, ["commit", "-m", `Checkpoint: ${input.name}`]);
    }

    const { stdout } = await this.runGit(dir, ["rev-parse", "HEAD"]);
    const commitHash = stdout.trim();
    const fileCount = await this.countWorkspaceFiles(dir);

    const checkpoint = await this.workspaceStore.createProjectCheckpoint(ctx, companyId, projectId, {
      name: input.name,
      description: input.description,
      commitHash,
      trigger,
      runId: input.runId,
      fileCount,
    });
    await this.runGit(dir, ["update-ref", `refs/npati/checkpoints/${checkpoint.id}`, commitHash]);
    return checkpoint;
  }

  async listCheckpoints(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    limit = 50,
  ): Promise<ProjectCheckpoint[]> {
    await this.getProjectPath(ctx, companyId, projectId);
    return this.workspaceStore.listProjectCheckpoints(ctx, companyId, projectId, limit);
  }

  async getCheckpoint(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    checkpointId: string,
  ): Promise<ProjectCheckpoint> {
    await this.getProjectPath(ctx, companyId, projectId);
    return this.workspaceStore.getProjectCheckpoint(ctx, companyId, projectId, checkpointId);
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
    if (input.checkpointId) {
      const checkpoint = await this.getCheckpoint(ctx, companyId, projectId, input.checkpointId);
      if (!checkpoint.commitHash) throw new GitError("CHECKPOINT_NO_COMMIT", "Checkpoint does not have an associated commit hash", 400);
      return checkpoint.commitHash;
    }
    if (input.commitHash) {
      if (!/^[0-9a-fA-F]{7,64}$/.test(input.commitHash)) throw new GitError("INVALID_COMMIT", "Invalid commit hash", 400);
      return input.commitHash;
    }
    const checkpoints = await this.listCheckpoints(ctx, companyId, projectId, 50);
    const target = checkpoints.find((checkpoint) => checkpoint.trigger === "pre_run") ?? checkpoints[0];
    if (!target?.commitHash) throw new GitError("NO_CHECKPOINT", "There is no checkpoint to revert these paths to", 409);
    return target.commitHash;
  }

  /** Whether a path exists at a commit. `cat-file -e` exits non-zero for a path that is not in that tree. */
  private async pathExistsInCommit(dir: string, commit: string, file: string): Promise<boolean> {
    try {
      await this.runGit(dir, ["cat-file", "-e", `${commit}:${file}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes a path that did not exist at the checkpoint, which is how "revert a path that was created afterwards"
   * reaches the checkpoint state. Every safety check happens before the deletion, and only the named path is touched:
   * parents are never pruned, so a revert can never take a directory with it.
   */
  private async removePathForRevert(dir: string, file: string): Promise<void> {
    const resolvedDir = path.resolve(dir);
    const absolute = path.join(resolvedDir, ...file.split("/"));
    const resolvedTarget = path.resolve(absolute);
    if (resolvedTarget !== resolvedDir && !resolvedTarget.startsWith(resolvedDir + path.sep)) {
      throw new GitError("INVALID_PATH", "Restore path escapes the project workspace", 403);
    }
    const entry = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    // Already absent: the checkpoint state is reached and there is nothing to delete.
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new GitError("INVALID_PATH", "Symlink paths cannot be restored", 403);
    const realDir = await realpath(dir).catch(() => undefined);
    if (realDir) {
      const real = await realpath(absolute).catch(() => undefined);
      if (real && !samePath(real, path.join(realDir, ...file.split("/")))) {
        // A junction or mount point that `lstat` did not flag: deleting through it would delete the target.
        throw new GitError("INVALID_PATH", "Symlink paths cannot be restored", 403);
      }
    }
    await rm(absolute, { recursive: entry.isDirectory(), force: true });
    // Best-effort index bookkeeping so a tracked file does not stay staged as present. A path that is not tracked
    // simply matches nothing, and index bookkeeping must never fail the revert.
    await this.runGit(dir, ["rm", "--cached", "--ignore-unmatch", "-r", "--", file]).catch(() => undefined);
  }

  /** Refuse a path that is, or traverses, a symlink: git must never write through a link out of the workspace. */
  private async assertNoSymlinkPath(dir: string, files: string[]): Promise<void> {
    const resolvedDir = path.resolve(dir);
    const realDir = await realpath(dir).catch(() => undefined);
    for (const file of files) {
      const parts = file.split("/");
      let candidate = dir;
      for (let index = 0; index < parts.length; index += 1) {
        candidate = path.join(candidate, parts[index]!);
        const entry = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!entry) break;
        if (entry.isSymbolicLink()) throw new GitError("INVALID_PATH", "Symlink paths cannot be restored", 403);
        // `isSymbolicLink()` misses reparse points that the platform reports as directories (Windows junctions),
        // so the resolved location is compared as well: a link anywhere along the path resolves outside the root.
        if (realDir) {
          const real = await realpath(candidate).catch(() => undefined);
          if (real && !samePath(real, path.join(realDir, ...parts.slice(0, index + 1)))) {
            throw new GitError("INVALID_PATH", "Symlink paths cannot be restored", 403);
          }
        }
      }
      if (!path.resolve(candidate).startsWith(resolvedDir + path.sep) && path.resolve(candidate) !== resolvedDir) {
        throw new GitError("INVALID_PATH", "Restore path escapes the project workspace", 403);
      }
    }
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
    this.requireWrite(ctx);
    if (!options.approved) throw new GitApprovalRequiredError();
    /**
     * C11 (owner decision 13, the last known issue): the order of this method is the fix.
     *
     *   inspect (read-only) -> repository_not_initialized -> policy -> approval -> ensureRepositoryInitialized
     *   -> revision check -> lease -> git push
     *
     * Before it, an unnamed branch asked the checkout for its branch (`resolveWriteIntent` ->
     * `currentBranch`), and `currentBranch` went through `ensureRepository`, which runs `git init` for a
     * repository that does not exist yet. A request that was about to be refused — by the policy, by the
     * missing approval record, by RBAC — still created `.git`, wrote `.gitignore` and made a commit. The
     * inspection below cannot do any of that, and the two git calls it may make are read-only `rev-parse`
     * probes, so every refusal below leaves the disk exactly as it was.
     */
    const inspection = await this.inspectRepository(ctx, companyId, projectId);
    const project = inspection.project;
    if (project.repositoryProvider !== "github" || !project.repositoryUrl) throw new GitError("REPOSITORY_NOT_CONNECTED", "Connect a GitHub repository first", 400);
    const namedBranch = options.branch?.trim();
    const namedSource = options.sourceBranch?.trim();
    for (const candidate of [namedBranch, namedSource]) {
      if (candidate && (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(candidate) || candidate.includes("..") || candidate.includes("@{"))) {
        throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
      }
    }
    // The credential reference must exist *before* anything privileged happens, but the lease itself is
    // only issued after the two checks below: a refused write must not have touched the vault.
    if (!options.credentialId || (!this.boundary?.credentials && !this.resolveGithubCredential)) {
      throw new GitError("CREDENTIAL_MISSING", "A Company vault credential reference is required", 400);
    }
    /**
     * C11 (owner decision 13): an uninitialized workspace is **not** a push target, and this is where the
     * service says so instead of repairing it. The refusal is structured — `repository_not_initialized` with
     * `requiresInitialization: true` and `repositoryInitialized: false` — and it is returned before the
     * policy, before the approval is consumed and before any git process runs, so nothing is created.
     *
     * The act it names is a *different* act with a *different* approval: `create the repository and push`
     * rather than `push`, which is exactly what `gitApprovalPayload` binds through `repositoryInitialized`.
     * A caller that holds an approval record for it presents that record (the request side resolves the same
     * fact through `inspectRepository`, so the two payload hashes are comparable); the record is then
     * verified against the initialization payload below and, once consumed,
     * `ensureRepositoryInitialized()` runs.
     */
    if (!inspection.initialized && !options.approval?.approvalId) {
      throw new GitError(
        "repository_not_initialized",
        "The project workspace has no git repository yet, so this push would have to create one; that is a different "
        + "approved act (it is bound to `repositoryInitialized: false`), and this request carries no approval record for it",
        409,
        { requiresInitialization: true, repositoryInitialized: false, projectId, repositoryState: "uninitialized" },
      );
    }
    /**
     * C11 (owner decision 3): the branch is resolved by the **service** when the caller names none — a
     * `git push` without a refspec writes to the checked-out branch, which is a property of the checkout
     * and never a configuration default. The resolved branch is what the policy is asked about. For an
     * uninitialized workspace the branch comes from the caller or not at all: there is no checkout to ask,
     * and the inspection never creates one.
     */
    const intent = await this.resolveWriteIntent(ctx, companyId, projectId, project, namedBranch, options.force === true, options.credentialId, namedSource, inspection);
    /**
     * C11 (owner decision 7 + 13): the canonical revision this write is prepared from, read **before** any
     * side effect and re-checked after the write's own initialization. Without the port no revision is
     * claimed (a hand-built service); with it, an unreadable revision refuses the write rather than letting
     * it act on bytes nobody can name.
     */
    const authorisedRevision = await this.captureWorkspaceRevision(ctx, companyId, projectId);
    // C11 (owner decision 3): the SECOND protected-branch check, at the git-policy boundary.
    //
    // It runs **before** the approval record is consumed, and that order is deliberate: a hard deny must
    // not spend a human's one-shot approval (the same "hard deny before approval" rule the engine's phase
    // order implements). Nothing that follows this call can change the target of the write — the refspec is
    // built from `intent` — so the check still stands immediately in front of the side effect, and the only
    // work between the two is bookkeeping (the approval consumption and the credential lease).
    await this.assertGitWriteBoundary(ctx, companyId, intent);
    // C11 (owner decision 5): the `approved` flag is not a trust boundary. A real approval record, bound
    // to this payload hash, is consumed before the lease and before the push. The payload is built from the
    // **typed request** (operation, branches, force, credential, and — decision 13 — whether this write has
    // to create the repository), which is the same material the requester approved; the repository URL is
    // deliberately not part of it (it is pinned by the stored, validated `repositoryUrl`, so a caller cannot
    // choose a different remote). A record issued for a plain push therefore cannot be redeemed here, and a
    // record issued for `create the repository and push` cannot be redeemed against an existing repository.
    await this.requireGitWriteApproval(ctx, companyId, projectId, { ...intent, remote: options.remote ?? null }, "project.git.push", options.approval);
    // The structured API performs no history rewrite. The refusal comes *after* the policy spoke, so a
    // force push into a protected branch is reported as `force_push_denied` (the policy's own code) rather
    // than as "unsupported": the reason a caller sees is the reason that actually stopped it. An
    // unprotected force push is refused here — this service does not rewrite history through a tool call.
    if (intent.force) {
      throw new GitError(
        "FORCE_PUSH_NOT_SUPPORTED",
        "This API does not perform force pushes; the write was refused. A force push into a protected branch is force_push_denied",
        403,
      );
    }
    /**
     * C11 (owner decision 13): **the only mutation in this method, and it happens here** — after RBAC
     * (`requireWrite`), after the credential reference and the branch checks, after the protected-branch
     * policy, and after the approval record for `repositoryInitialized: false` was consumed. A refused write
     * never reaches this line.
     */
    if (!inspection.initialized) await this.ensureRepositoryInitialized(ctx, companyId, projectId);
    /**
     * C11 (owner decision 7 + 13): the revision is checked **after** the initialization, because the
     * initialization is itself a change to the canonical workspace (`git init` plus the `.gitignore` write).
     * Comparing a pre-init revision with a post-init one would refuse every first push for a reason nobody
     * could act on, so the comparison the guard makes is: "is the canonical workspace still the revision this
     * write was prepared from?" — with the initialization already applied. An already-initialized repository
     * is unaffected except that the check now also covers the approval window, which is strictly stronger
     * than before; an initialization that moved the workspace refuses the push as
     * `workspace_revision_mismatch` (409, retryable): the approved initialization is on disk, the push is
     * not, and the caller re-prepares against the revision that now exists.
     */
    await this.assertWorkspaceRevisionUnchanged(ctx, companyId, projectId, authorisedRevision);
    // The directory the inspection resolved, and — when this call had to create the repository — the one
    // `ensureRepositoryInitialized()` just proved belongs to this workspace. The write path therefore makes
    // no second "ensure" call: one inspection, one (approved) initialization, then the push.
    const dir = inspection.dir;
    const credential = await this.acquireCredential(ctx, companyId, projectId, {
      credentialId: options.credentialId,
      purpose: "git.push",
      toolCallId: options.approval?.approvalId ?? `git-push:${projectId}:${randomUUID()}`,
    });
    try {
      await this.runGit(
        dir,
        ["push", project.repositoryUrl, `refs/heads/${intent.sourceBranch}:refs/heads/${intent.targetBranch}`],
        this.credentialEnvironment(credential.value),
      );
    } catch (error) {
      if (error instanceof GitError) throw error;
      throw new GitError("GIT_PUSH_FAILED", "GitHub push failed; inspect branch and repository permissions", 502);
    } finally {
      // The lease never outlives the call, whatever happened.
      if (credential.leaseId && this.boundary?.credentials) {
        await this.boundary.credentials.revoke(credential.leaseId, "call_finished").catch(() => undefined);
      }
    }
    return { pushed: true, branch: intent.targetBranch, remote: project.repositoryUrl };
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
    const state = inspection ?? await this.inspectRepository(ctx, companyId, projectId);
    if (!state.initialized) {
      // A caller that names no branch cannot be answered from a repository that does not exist, and this is
      // the refusal that says so without creating one.
      throw new GitError(
        "repository_not_initialized",
        "The project workspace has no git repository yet, so the branch of its checkout cannot be resolved; name the branch explicitly",
        409,
        { requiresInitialization: true, repositoryInitialized: false, projectId, repositoryState: "uninitialized" },
      );
    }
    if (state.branch) return state.branch;
    // A detached HEAD (or an unreadable checkout) answers nothing usable, which is not a branch to push by
    // name: an unresolvable checkout is never a branch name to guess at.
    throw new GitError(
      "BRANCH_UNRESOLVED",
      "The branch of the project checkout could not be resolved; name the branch explicitly",
      409,
    );
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
    const assertAllowed = this.boundary?.assertGitWriteAllowed;
    if (!assertAllowed) {
      throw new GitError(
        "GIT_POLICY_UNAVAILABLE",
        "The protected-branch policy is not wired to the git boundary; the remote write is refused",
        503,
      );
    }
    await assertAllowed(ctx, companyId, intent);
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
    const guard = this.boundary?.workspaceRevisions;
    if (!guard) return null;
    return guard.capture({ ctx, companyId, projectId });
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
    if (!snapshot) return;
    const guard = this.boundary?.workspaceRevisions;
    if (!guard) return;
    await guard.assertUnchanged({ ctx, companyId, projectId }, snapshot, "git_push");
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
    if (this.boundary?.credentials && input.credentialId) {
      const lease = await this.boundary.credentials.acquire({
        ctx, companyId, projectId, credentialId: input.credentialId, toolCallId: input.toolCallId, purpose: input.purpose,
      });
      return { value: lease.value, leaseId: lease.leaseId };
    }
    return { value: await this.githubToken(ctx, companyId, input.credentialId), leaseId: null };
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
    const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
    return {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.askPass",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_2: `Authorization: Basic ${auth}`,
    };
  }

  private readonly mergeLocks = new Map<string, Promise<void>>();

  getAgentWorktreePath(dir: string, agentSlug: string): string {
    const slug = safeAgentSlug(agentSlug);
    const wtBase = path.join(dir, ".worktrees");
    const wtPath = path.join(wtBase, slug);
    const resolved = path.resolve(wtPath);
    if (!resolved.startsWith(path.resolve(wtBase) + path.sep)) {
      throw new GitError("INVALID_WORKTREE_PATH", "Worktree path traversal attempt", 403);
    }
    return resolved;
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
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    let cleanedCount = 0;

    try {
      const { stdout } = await this.runGit(dir, ["worktree", "list", "--porcelain"]);
      const lines = stdout.split(/\r?\n/);
      const wtBase = path.resolve(path.join(dir, ".worktrees"));

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          const wtPath = path.resolve(line.slice(9).trim());
          if (wtPath.startsWith(wtBase + path.sep)) {
            try {
              await this.runGit(dir, ["worktree", "remove", "--force", wtPath]);
              cleanedCount++;
            } catch {}
            await rm(wtPath, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
    } catch {}

    await this.runGit(dir, ["worktree", "prune"]).catch(() => undefined);
    await rm(path.join(dir, ".worktrees"), { recursive: true, force: true }).catch(() => undefined);

    return { cleanedCount };
  }

    async listAgentWorktrees(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<Array<{ worktreePath: string; branch: string; head: string }>> {
    return listAgentWorktrees(this.worktreeHost(), ctx, companyId, projectId);
  }
}
