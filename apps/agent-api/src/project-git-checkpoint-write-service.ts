import path from "node:path";
import type { AuthContext, Project, ProjectCheckpoint, CheckpointTrigger, WorkspaceStore } from "@npati/workspace";
import { status } from "./project-git-repository-service";
import type { GitStatusResult } from "./project-git-service";

export interface ProjectGitCheckpointWriteHost {
  workspaceStore: WorkspaceStore
  assertSafeIndex: (dir: string) => Promise<void>
  ensureRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
  getProjectPath: (ctx: AuthContext, companyId: string, projectId: string) => Promise<{ project: Project; dir: string }>
  requireWrite: (ctx: AuthContext) => void
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  status: (ctx: AuthContext, companyId: string, projectId: string) => Promise<GitStatusResult>
  countWorkspaceFiles: (dir: string) => Promise<number>
}

export async function createCheckpoint(host: ProjectGitCheckpointWriteHost, ctx: AuthContext, companyId: string, projectId: string, input: { name: string; description?: string; trigger?: CheckpointTrigger; runId?: string }): Promise<ProjectCheckpoint> {
    host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const trigger = input.trigger ?? "manual";

    // Snapshot bytes must not depend on the operator's global newline conversion.
    await host.runGit(dir, ["-c", "core.autocrlf=false", "add", "-A"]);
    await host.assertSafeIndex(dir);
    const staged = await host.runGit(dir, ["diff", "--cached", "--name-only", "-z"]);
    if (staged.stdout) {
      await host.runGit(dir, ["-c", "core.autocrlf=false", "commit", "-m", `Checkpoint: ${input.name}`]);
    }

    const { stdout } = await host.runGit(dir, ["rev-parse", "HEAD"]);
    const commitHash = stdout.trim();
    const fileCount = await host.countWorkspaceFiles(dir);

    const checkpoint = await host.workspaceStore.createProjectCheckpoint(ctx, companyId, projectId, {
      name: input.name,
      description: input.description,
      commitHash,
      trigger,
      runId: input.runId,
      fileCount,
    });
    await host.runGit(dir, ["update-ref", `refs/npati/checkpoints/${checkpoint.id}`, commitHash]);
    return checkpoint;
  }

export async function getCheckpoint(host: ProjectGitCheckpointWriteHost, ctx: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> {
    await host.getProjectPath(ctx, companyId, projectId);
    return host.workspaceStore.getProjectCheckpoint(ctx, companyId, projectId, checkpointId);
  }

