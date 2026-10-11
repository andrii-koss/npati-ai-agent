import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AuthContext, Project, ProjectCheckpoint, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import { safeProjectPath } from "./project-workspace";
import type { WorkspaceBaseResolverPort } from "./workspace-base-resolver";
import type { GitWriteIntent } from "./code-git-write-policy";
import type { CodeWorkspaceRevisionSnapshot } from "./code-workspace-revision";
import { createAgentWorktree, commitAgentWorktree, mergeAgentWorktree, listAgentWorktrees } from "./project-git-worktree-service";
import { createPullRequest, commentOnPullRequest } from "./project-git-pull-request-service";
import { restoreCheckpoint, restorePaths } from "./project-git-checkpoint-service";
import { requireGitWriteApproval, resolveWriteIntent } from "./project-git-approval-service";
import { ensureRepositoryInitialized, inspectRepository, status, branch } from "./project-git-repository-service";
import { diffAgentWorktree, removeAgentWorktree } from "./project-git-worktree-extra-service";
import { createCheckpoint, getCheckpoint } from "./project-git-checkpoint-write-service";
import { push } from "./project-git-push-service";
import { githubToken, acquireCredential } from "./project-git-credential-service";
import { currentBranch } from "./project-git-branch-service";
import { cleanupAllWorktrees } from "./project-git-cleanup-service";
import { log, commit } from "./project-git-history-service";
import { assertNoSymlinkPath, removePathForRevert, resolveRevertTarget, assertWorkspaceRevisionUnchanged } from "./project-git-guard-service";
import { resolveProjectWorkspace, assertSafeIndex, ensureRepository, requireWrite, runGit, stage } from "./project-git-workspace-service";
import { GitError, safeAgentSlug } from "./project-git-service";
import type { ProjectGitBoundary, CheckpointThresholds } from "./project-git-service";

export interface ProjectGitCoreHost {
  bases: WorkspaceBaseResolverPort
  projectService: Pick<ProjectService, "get">
  workspaceStore: WorkspaceStore
  thresholds: CheckpointThresholds
  boundary?: ProjectGitBoundary
  runGitImpl?: (dir: string, args: string[], env: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  resolveGithubCredential?: (ctx: AuthContext, companyId: string, credentialId: string) => Promise<string>
  diff: (ctx: AuthContext, companyId: string, projectId: string, options?: { staged?: boolean }) => Promise<{ diff: string }>
  validId: (value: string) => boolean
  redactSecrets: (text: string) => string
  execFileAsync: (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>
  resolveProjectWorkspace: (...args: any[]) => any
  runGit: (...args: any[]) => any
  assertSafeIndex: (...args: any[]) => any
  requireWrite: (...args: any[]) => any
  githubToken: (...args: any[]) => any
  inspectRepository: (...args: any[]) => any
  ensureRepositoryInitialized: (...args: any[]) => any
  ensureRepository: (...args: any[]) => any
  status: (...args: any[]) => any
  log: (...args: any[]) => any
  branch: (...args: any[]) => any
  stage: (...args: any[]) => any
  commit: (...args: any[]) => any
  createCheckpoint: (...args: any[]) => any
  getCheckpoint: (...args: any[]) => any
  restoreCheckpoint: (...args: any[]) => any
  restorePaths: (...args: any[]) => any
  resolveRevertTarget: (...args: any[]) => any
  removePathForRevert: (...args: any[]) => any
  assertNoSymlinkPath: (...args: any[]) => any
  push: (...args: any[]) => any
  createPullRequest: (...args: any[]) => any
  commentOnPullRequest: (...args: any[]) => any
  resolveWriteIntent: (...args: any[]) => any
  currentBranch: (...args: any[]) => any
  requireGitWriteApproval: (...args: any[]) => any
  assertWorkspaceRevisionUnchanged: (...args: any[]) => any
  acquireCredential: (...args: any[]) => any
  createAgentWorktree: (...args: any[]) => any
  commitAgentWorktree: (...args: any[]) => any
  diffAgentWorktree: (...args: any[]) => any
  mergeAgentWorktree: (...args: any[]) => any
  removeAgentWorktree: (...args: any[]) => any
  cleanupAllWorktrees: (...args: any[]) => any
  listAgentWorktrees: (...args: any[]) => any
}

export async function getProjectPath(host: ProjectGitCoreHost, ctx: AuthContext, companyId: string, projectId: string): Promise<{ project: Project; dir: string }> {
    return host.resolveProjectWorkspace(ctx, companyId, projectId, { create: true });
  }

export function parseConflictFiles(host: ProjectGitCoreHost, output: string): string[] {
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

export async function connectRepository(host: ProjectGitCoreHost, ctx: AuthContext, companyId: string, projectId: string, input: { url: string; branch?: string }): Promise<Project> {
    host.requireWrite(ctx);
    await getProjectPath(host, ctx, companyId, projectId);
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
    return host.workspaceStore.updateProjectRepository(ctx, companyId, projectId, {
      provider: "github", url: `https://github.com/${segments[0]}/${segments[1]}.git`, branch,
    });
  }

export async function restore(host: ProjectGitCoreHost, ctx: AuthContext, companyId: string, projectId: string, options: { files: string[] }): Promise<{ restored: string[] }> {
    host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    if (!options.files || options.files.length === 0) {
      throw new GitError("FILES_REQUIRED", "List of files to restore is required", 400);
    }
    const safeFiles = options.files.map((f) => safeProjectPath(f));
    try {
      await host.runGit(dir, ["checkout", "HEAD", "--", ...safeFiles]);
    } catch {
      await host.runGit(dir, ["restore", "--staged", "--worktree", "--", ...safeFiles]);
    }
    return { restored: safeFiles };
  }

export async function countWorkspaceFiles(host: ProjectGitCoreHost, dir: string): Promise<number> {
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

export async function isLargeChange(host: ProjectGitCoreHost, ctx: AuthContext, companyId: string, projectId: string): Promise<{ isLarge: boolean; changedFiles: number; changedLines: number }> {
    try {
      const st = await host.status(ctx, companyId, projectId);
      const changedFiles = new Set([...st.staged, ...st.unstaged, ...st.untracked]).size;
      const { diff } = await host.diff(ctx, companyId, projectId);
      const { diff: stagedDiff } = await host.diff(ctx, companyId, projectId, { staged: true });
      const changedLines = (diff + "\n" + stagedDiff).split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line)).length;
      const isLarge = changedFiles >= host.thresholds.fileThreshold || changedLines >= host.thresholds.lineThreshold;
      return { isLarge, changedFiles, changedLines };
    } catch {
      return { isLarge: false, changedFiles: 0, changedLines: 0 };
    }
  }

export async function listCheckpoints(host: ProjectGitCoreHost, ctx: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectCheckpoint[]> {
    await getProjectPath(host, ctx, companyId, projectId);
    return host.workspaceStore.listProjectCheckpoints(ctx, companyId, projectId, limit);
  }

export async function pathExistsInCommit(host: ProjectGitCoreHost, dir: string, commit: string, file: string): Promise<boolean> {
    try {
      await host.runGit(dir, ["cat-file", "-e", `${commit}:${file}`]);
      return true;
    } catch {
      return false;
    }
  }

export async function assertGitWriteBoundary(host: ProjectGitCoreHost, ctx: AuthContext, companyId: string, intent: GitWriteIntent): Promise<void> {
    const assertAllowed = host.boundary?.assertGitWriteAllowed;
    if (!assertAllowed) {
      throw new GitError(
        "GIT_POLICY_UNAVAILABLE",
        "The protected-branch policy is not wired to the git boundary; the remote write is refused",
        503,
      );
    }
    await assertAllowed(ctx, companyId, intent);
  }

export async function captureWorkspaceRevision(host: ProjectGitCoreHost, ctx: AuthContext, companyId: string, projectId: string): Promise<CodeWorkspaceRevisionSnapshot | null> {
    const guard = host.boundary?.workspaceRevisions;
    if (!guard) return null;
    return guard.capture({ ctx, companyId, projectId });
  }

export function credentialEnvironment(host: ProjectGitCoreHost, token: string): Record<string, string> {
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

export function getAgentWorktreePath(host: ProjectGitCoreHost, dir: string, agentSlug: string): string {
    const slug = safeAgentSlug(agentSlug);
    const wtBase = path.join(dir, ".worktrees");
    const wtPath = path.join(wtBase, slug);
    const resolved = path.resolve(wtPath);
    if (!resolved.startsWith(path.resolve(wtBase) + path.sep)) {
      throw new GitError("INVALID_WORKTREE_PATH", "Worktree path traversal attempt", 403);
    }
    return resolved;
  }

