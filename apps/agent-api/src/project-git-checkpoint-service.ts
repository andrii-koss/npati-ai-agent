import path from "node:path";
import type { AuthContext, ProjectCheckpoint, CheckpointTrigger } from "@npati/workspace";
import { safeProjectPath } from "./project-workspace";
import { GitError } from "./project-git-service";

export interface ProjectGitCheckpointHost {
  requireWrite: (ctx: AuthContext) => void
  ensureRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
  getCheckpoint: (ctx: AuthContext, companyId: string, projectId: string, checkpointId: string) => Promise<ProjectCheckpoint>
  createCheckpoint: (ctx: AuthContext, companyId: string, projectId: string, input: { name: string; description?: string; trigger?: CheckpointTrigger; runId?: string }) => Promise<ProjectCheckpoint>
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  assertNoSymlinkPath: (dir: string, files: string[]) => Promise<void>
  resolveRevertTarget: (ctx: AuthContext, companyId: string, projectId: string, input: { checkpointId?: string; commitHash?: string }) => Promise<string>
  pathExistsInCommit: (dir: string, commit: string, file: string) => Promise<boolean>
  removePathForRevert: (dir: string, file: string) => Promise<void>
}

export async function restoreCheckpoint(host: ProjectGitCheckpointHost, ctx: AuthContext, companyId: string, projectId: string, checkpointId: string, options?: { approved?: boolean }): Promise<{ restoredCheckpoint: ProjectCheckpoint; backupCheckpoint: ProjectCheckpoint }> {
    host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const target = await host.getCheckpoint(ctx, companyId, projectId, checkpointId);

    if (!target.commitHash) {
      throw new GitError("CHECKPOINT_NO_COMMIT", "Checkpoint does not have an associated commit hash", 400);
    }

    // MANDATORY SAFETY: Create automatic pre-restore checkpoint before rolling back!
    const backupCheckpoint = await host.createCheckpoint(ctx, companyId, projectId, {
      name: `Before restoring "${target.name}"`,
      description: `Automatic safety checkpoint taken prior to rollback to checkpoint ${checkpointId} (${target.commitHash.slice(0, 7)})`,
      trigger: "pre_restore",
    });

    // Hard reset to the checkpoint's commit
    await host.runGit(dir, ["-c", "core.autocrlf=false", "reset", "--hard", target.commitHash]);
    await host.runGit(dir, ["clean", "-fd", "-e", ".npati-*", "-e", ".worktrees"]);

    return {
      restoredCheckpoint: target,
      backupCheckpoint,
    };
  }

export async function restorePaths(host: ProjectGitCheckpointHost, ctx: AuthContext, companyId: string, projectId: string, input: { files: string[]; checkpointId?: string; commitHash?: string }): Promise<{ restored: string[]; removed: string[]; failed: Array<{ path: string; reason: string }>; targetCommit: string; safetyCheckpointId: string | null }> {
    host.requireWrite(ctx);
    const requested = Array.isArray(input?.files) ? input.files : [];
    if (requested.length === 0) throw new GitError("FILES_REQUIRED", "List of files to restore is required", 400);
    if (requested.length > 200) throw new GitError("TOO_MANY_FILES", "At most 200 paths can be restored at once", 400);

    // Validate everything up front: a single bad path must refuse the whole call, not partially apply a revert.
    const safeFiles = requested.map((file) => {
      if (typeof file === "string" && file.trimStart().startsWith("~")) {
        throw new GitError("INVALID_PATH", "Home-relative paths are not allowed", 400);
      }
      return safeProjectPath(file);
    });
    if (new Set(safeFiles).size !== safeFiles.length) throw new GitError("DUPLICATE_PATHS", "Duplicate paths in restore request", 400);

    const dir = await host.ensureRepository(ctx, companyId, projectId);
    await host.assertNoSymlinkPath(dir, safeFiles);

    const targetCommit = await host.resolveRevertTarget(ctx, companyId, projectId, input);

    // MANDATORY SAFETY: the same pre-restore checkpoint `restoreCheckpoint` takes, so a path revert is undoable.
    const safety = await host.createCheckpoint(ctx, companyId, projectId, {
      name: `Before restoring ${safeFiles.length} path(s)`,
      description: `Automatic safety checkpoint taken prior to a path-scoped restore of: ${safeFiles.join(", ")}`,
      trigger: "pre_restore",
    });

    const restored: string[] = [];
    const removed: string[] = [];
    const failed: Array<{ path: string; reason: string }> = [];
    for (const file of safeFiles) {
      try {
        const existedInTarget = await host.pathExistsInCommit(dir, targetCommit, file);
        if (existedInTarget) {
          // Path-scoped checkout. `--` separates paths from revisions so a path can never be read as an option.
          await host.runGit(dir, ["checkout", targetCommit, "--", file]);
          restored.push(file);
        } else {
          await host.removePathForRevert(dir, file);
          removed.push(file);
        }
      } catch (error) {
        failed.push({ path: file, reason: error instanceof Error ? error.message : "restore_failed" });
      }
    }

    return { restored, removed, failed, targetCommit, safetyCheckpointId: safety?.id ?? null };
  }

