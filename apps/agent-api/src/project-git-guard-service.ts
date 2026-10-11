import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { AuthContext, ProjectCheckpoint, WorkspaceStore } from "@npati/workspace";
import { samePath } from "./project-workspace";
import type { CodeWorkspaceRevisionSnapshot } from "./code-workspace-revision";
import { getCheckpoint } from "./project-git-checkpoint-write-service";
import { commit } from "./project-git-history-service";
import { GitError } from "./project-git-service";
import type { ProjectGitBoundary } from "./project-git-service";

export interface ProjectGitGuardHost {
  boundary?: ProjectGitBoundary
  workspaceStore: WorkspaceStore
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  getCheckpoint: (ctx: AuthContext, companyId: string, projectId: string, checkpointId: string) => Promise<ProjectCheckpoint>
  listCheckpoints: (ctx: AuthContext, companyId: string, projectId: string, limit?: number) => Promise<ProjectCheckpoint[]>
}

export async function assertNoSymlinkPath(host: ProjectGitGuardHost, dir: string, files: string[]): Promise<void> {
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

export async function removePathForRevert(host: ProjectGitGuardHost, dir: string, file: string): Promise<void> {
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
    await host.runGit(dir, ["rm", "--cached", "--ignore-unmatch", "-r", "--", file]).catch(() => undefined);
  }

export async function resolveRevertTarget(host: ProjectGitGuardHost, ctx: AuthContext, companyId: string, projectId: string, input: { checkpointId?: string; commitHash?: string }): Promise<string> {
    if (input.checkpointId) {
      const checkpoint = await host.getCheckpoint(ctx, companyId, projectId, input.checkpointId);
      if (!checkpoint.commitHash) throw new GitError("CHECKPOINT_NO_COMMIT", "Checkpoint does not have an associated commit hash", 400);
      return checkpoint.commitHash;
    }
    if (input.commitHash) {
      if (!/^[0-9a-fA-F]{7,64}$/.test(input.commitHash)) throw new GitError("INVALID_COMMIT", "Invalid commit hash", 400);
      return input.commitHash;
    }
    const checkpoints = await host.listCheckpoints(ctx, companyId, projectId, 50);
    const target = checkpoints.find((checkpoint) => checkpoint.trigger === "pre_run") ?? checkpoints[0];
    if (!target?.commitHash) throw new GitError("NO_CHECKPOINT", "There is no checkpoint to revert these paths to", 409);
    return target.commitHash;
  }

export async function assertWorkspaceRevisionUnchanged(host: ProjectGitGuardHost, ctx: AuthContext, companyId: string, projectId: string, snapshot: CodeWorkspaceRevisionSnapshot | null): Promise<void> {
    if (!snapshot) return;
    const guard = host.boundary?.workspaceRevisions;
    if (!guard) return;
    await guard.assertUnchanged({ ctx, companyId, projectId }, snapshot, "git_push");
  }

