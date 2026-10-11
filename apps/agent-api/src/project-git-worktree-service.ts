import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AuthContext } from "@npati/workspace";
import { safeProjectPath } from "./project-workspace";
import { CodeGitWorkflowError, GIT_CONFLICT_ESCALATED, MAX_GIT_MERGE_ATTEMPTS, buildConflictEscalation, runMergeWithAutoResolve, type GitConflictResolverPort } from "./code-git-workflow";
import { GitError, GitConflictEscalationError, safeAgentSlug } from "./project-git-service";
import type { GitBranchResult } from "./project-git-service";

export interface ProjectGitWorktreeHost {
  mergeLocks: Map<string, Promise<void>>
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  requireWrite: (ctx: AuthContext) => void
  ensureRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
  branch: (ctx: AuthContext, companyId: string, projectId: string, options: { action: "list" | "create" | "switch"; branch?: string }) => Promise<GitBranchResult>
  getAgentWorktreePath: (dir: string, agentSlug: string) => string
  safeAgentSlug: (slug: string) => string
}

export async function createAgentWorktree(host: ProjectGitWorktreeHost, ctx: AuthContext, companyId: string, projectId: string, options: { agentSlug: string; baseBranch?: string }): Promise<{ worktreePath: string; branch: string; baseBranch: string }> {
    host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const slug = host.safeAgentSlug(options.agentSlug);
    const branch = `agent/${slug}`;
    const baseBranch = options.baseBranch ?? "project/main";

    // Ensure baseBranch exists (point to HEAD if not yet created)
    const { branches } = await host.branch(ctx, companyId, projectId, { action: "list" });
    if (!branches.includes(baseBranch)) {
      await host.runGit(dir, ["branch", baseBranch, "HEAD"]).catch(() => undefined);
    }

    const wtDir = host.getAgentWorktreePath(dir, options.agentSlug);
    await mkdir(path.dirname(wtDir), { recursive: true });

    // Clean up if worktree already exists at this path
    try {
      await host.runGit(dir, ["worktree", "remove", "--force", wtDir]);
    } catch {}
    await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    await host.runGit(dir, ["worktree", "prune"]).catch(() => undefined);

    // Create worktree on branch starting from baseBranch
    await host.runGit(dir, ["worktree", "add", "-B", branch, wtDir, baseBranch]);

    return {
      worktreePath: wtDir,
      branch,
      baseBranch,
    };
  }

export async function commitAgentWorktree(host: ProjectGitWorktreeHost, ctx: AuthContext, companyId: string, projectId: string, options: { agentSlug: string; message: string; stageAll?: boolean }): Promise<{ commitHash: string; message: string }> {
    host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const wtDir = host.getAgentWorktreePath(dir, options.agentSlug);
    const message = options.message?.trim() || `Agent ${options.agentSlug} update`;

    // Stage changes in worktree
    await host.runGit(wtDir, ["add", "-A"]);

    // Assert safe index in worktree
    const { stdout: stagedOut } = await host.runGit(wtDir, ["diff", "--no-ext-diff", "--cached", "--name-only", "-z"]);
    for (const file of stagedOut.split("\0").filter(Boolean)) {
      try { safeProjectPath(file); }
      catch { throw new GitError("PROTECTED_FILE", "Protected files cannot be committed in worktree", 403); }
    }

    // Check status
    const { stdout: statusOut } = await host.runGit(wtDir, ["status", "--porcelain=v1"]);
    if (statusOut.trim().length > 0) {
      await host.runGit(wtDir, ["commit", "-m", message]);
    } else {
      await host.runGit(wtDir, ["commit", "--allow-empty", "-m", message]);
    }

    const { stdout: hashOut } = await host.runGit(wtDir, ["rev-parse", "HEAD"]);
    return {
      commitHash: hashOut.trim(),
      message,
    };
  }

export async function mergeAgentWorktree(host: ProjectGitWorktreeHost, ctx: AuthContext, companyId: string, projectId: string, options: {
      agentSlug: string;
      targetBranch?: string;
      message?: string;
      /** C11: the automatic-resolution strategy provider; absent means no automatic retry is attempted. */
      conflictResolver?: GitConflictResolverPort | null;
      /** C11: overrides the budget. Clamped to `MAX_GIT_MERGE_ATTEMPTS` so a caller cannot raise it. */
      maxAttempts?: number;
    }): Promise<{ merged: boolean; commitHash: string; targetBranch: string; sourceBranch: string; attempts: number }> {
    host.requireWrite(ctx);
    const lockKey = `${companyId}:${projectId}`;
    const prev = host.mergeLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    host.mergeLocks.set(lockKey, prev.then(() => current));
    await prev;

    try {
      const dir = await host.ensureRepository(ctx, companyId, projectId);
      const slug = host.safeAgentSlug(options.agentSlug);
      const sourceBranch = `agent/${slug}`;
      const targetBranch = options.targetBranch ?? "project/main";
      const commitMsg = options.message?.trim() || `Merge ${sourceBranch} into ${targetBranch}`;

      // Ensure targetBranch exists
      const { branches } = await host.branch(ctx, companyId, projectId, { action: "list" });
      if (!branches.includes(targetBranch)) {
        await host.runGit(dir, ["branch", targetBranch, "HEAD"]).catch(() => undefined);
      }

      // Switch to targetBranch in main repo
      await host.runGit(dir, ["checkout", targetBranch]);

      const outcome = await runMergeWithAutoResolve({
        sourceBranch,
        targetBranch,
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        resolver: options.conflictResolver ?? null,
        merge: async (strategy) => {
          const args = ["merge", "--no-ff", "-m", commitMsg];
          if (strategy !== "none") args.push(`-X${strategy}`);
          args.push(sourceBranch);
          await host.runGit(dir, args);
        },
        readConflicts: async () => {
          const { stdout } = await host.runGit(dir, ["diff", "--name-only", "--diff-filter=U"]);
          return stdout.split(/\r?\n/).filter(Boolean);
        },
        abort: async () => {
          await host.runGit(dir, ["merge", "--abort"]);
        },
      }).catch((error: unknown) => {
        /**
         * The workflow module reports the escalation as its own structured error; this service's callers
         * (`project-git-routes.ts`, `project-multi-agent.ts`, the worktree suite) catch
         * `GitConflictEscalationError`, and the escalation payload travels with it so a caller can act on the
         * attempt count and the suggested next tool instead of re-deriving them from a message.
         */
        if (error instanceof CodeGitWorkflowError && error.code === GIT_CONFLICT_ESCALATED) {
          const escalation = (error.details as { escalation?: {
            attempts: number; maxAttempts: number; conflictingFiles: string[]; sourceBranch: string;
            targetBranch: string; suggestedTool: "code.ask_user"; question: string;
          } }).escalation;
          const built = escalation ?? buildConflictEscalation({
            attempts: 1, conflictingFiles: [], sourceBranch, targetBranch,
          });
          throw new GitConflictEscalationError(
            built.conflictingFiles,
            `Merge conflict detected between ${sourceBranch} and ${targetBranch} in: ${built.conflictingFiles.join(", ")}`,
            {
              attempts: built.attempts,
              maxAttempts: built.maxAttempts,
              sourceBranch,
              targetBranch,
              suggestedTool: built.suggestedTool,
              question: built.question,
            },
          );
        }
        throw error;
      });

      const { stdout: headOut } = await host.runGit(dir, ["rev-parse", "HEAD"]);
      return {
        merged: true,
        commitHash: headOut.trim(),
        targetBranch,
        sourceBranch,
        attempts: outcome.attempts,
      };
    } finally {
      release();
    }
  }

export async function listAgentWorktrees(host: ProjectGitWorktreeHost, ctx: AuthContext, companyId: string, projectId: string): Promise<Array<{ worktreePath: string; branch: string; head: string }>> {
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const { stdout } = await host.runGit(dir, ["worktree", "list", "--porcelain"]);
    const lines = stdout.split(/\r?\n/);
    const wtBase = path.resolve(path.join(dir, ".worktrees"));

    const worktrees: Array<{ worktreePath: string; branch: string; head: string }> = [];
    let curPath = "";
    let curHead = "";
    let curBranch = "";

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        if (curPath && curPath.startsWith(wtBase + path.sep)) {
          worktrees.push({ worktreePath: curPath, branch: curBranch, head: curHead });
        }
        curPath = path.resolve(line.slice(9).trim());
        curHead = "";
        curBranch = "";
      } else if (line.startsWith("HEAD ")) {
        curHead = line.slice(5).trim();
      } else if (line.startsWith("branch ")) {
        curBranch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      }
    }
    if (curPath && curPath.startsWith(wtBase + path.sep)) {
      worktrees.push({ worktreePath: curPath, branch: curBranch, head: curHead });
    }

    return worktrees;
  }

