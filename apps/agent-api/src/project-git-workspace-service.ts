import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AuthContext, Project } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import { safeProjectPath } from "./project-workspace";
import type { WorkspaceBase, WorkspaceBaseResolverPort } from "./workspace-base-resolver";
import { ensureRepositoryInitialized, inspectRepository, status } from "./project-git-repository-service";
import { GitError, GitConflictError } from "./project-git-service";
import type { GitStatusResult } from "./project-git-service";

export interface ProjectGitWorkspaceHost {
  bases: WorkspaceBaseResolverPort
  projectService: Pick<ProjectService, "get">
  runGitImpl?: (dir: string, args: string[], env: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  validId: (value: string) => boolean
  redactSecrets: (text: string) => string
  parseConflictFiles: (text: string) => string[]
  status: (ctx: AuthContext, companyId: string, projectId: string) => Promise<GitStatusResult>
  execFileAsync: (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>
  ensureRepositoryInitialized: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
}

export async function resolveProjectWorkspace(host: ProjectGitWorkspaceHost, ctx: AuthContext, companyId: string, projectId: string, options: { create: boolean }): Promise<{ project: Project; dir: string; readOnly: boolean; mounted: boolean }> {
    if (!host.validId(companyId) || !host.validId(projectId)) {
      throw new GitError("INVALID_IDENTIFIER", "Invalid company or project identifier", 400);
    }
    const project = await host.projectService.get(ctx, companyId, projectId);
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
    const resolved: WorkspaceBase = await host.bases.resolve(ctx, companyId, projectId);
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
    const segments = resolved.mounted ? [dir] : [host.bases.managedRoot, path.join(host.bases.managedRoot, companyId), dir];
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

export async function assertSafeIndex(host: ProjectGitWorkspaceHost, dir: string): Promise<void> {
    const { stdout } = await runGit(host, dir, ["diff", "--no-ext-diff", "--cached", "--name-only", "-z"]);
    for (const file of stdout.split("\0").filter(Boolean)) {
      try { safeProjectPath(file); }
      catch { throw new GitError("PROTECTED_FILE", "Protected files cannot be staged or committed", 403); }
    }
  }

export async function ensureRepository(host: ProjectGitWorkspaceHost, ctx: AuthContext, companyId: string, projectId: string): Promise<string> {
    return host.ensureRepositoryInitialized(ctx, companyId, projectId);
  }

export function requireWrite(host: ProjectGitWorkspaceHost, ctx: AuthContext): void {
    if (!ctx.permissions.some((permission) => ["*", "owner", "business:manage", "workspace:write"].includes(permission))) {
      throw new GitError("PROJECT_WRITE_DENIED", "Project Git write permission denied", 403);
    }
  }

export async function runGit(host: ProjectGitWorkspaceHost, dir: string, args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
    if (host.runGitImpl) return host.runGitImpl(dir, args, env);
    try {
      const result = await host.execFileAsync("git", ["-c", `core.hooksPath=${path.join(dir, ".git", "npati-disabled-hooks")}`, ...args], {
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
      const combined = host.redactSecrets(`${err.stdout ?? ""} ${err.stderr ?? ""} ${err.message ?? ""}`);
      const conflictFiles = host.parseConflictFiles(combined);
      if (conflictFiles.length > 0) {
        throw new GitConflictError(conflictFiles, combined);
      }
      throw new GitError("GIT_COMMAND_FAILED", `Git command failed: ${combined.slice(0, 500)}`, 400);
    }
  }

export async function stage(host: ProjectGitWorkspaceHost, ctx: AuthContext, companyId: string, projectId: string, files?: string[]): Promise<{ staged: string[] }> {
    requireWrite(host, ctx);
    const dir = await ensureRepository(host, ctx, companyId, projectId);
    if (!files || files.length === 0 || files.includes(".")) {
      await runGit(host, dir, ["add", "-A"]);
    } else {
      const safeFiles = files.map((f) => safeProjectPath(f));
      await runGit(host, dir, ["add", "--", ...safeFiles]);
    }
    await assertSafeIndex(host, dir);
    const st = await host.status(ctx, companyId, projectId);
    return { staged: st.staged };
  }

