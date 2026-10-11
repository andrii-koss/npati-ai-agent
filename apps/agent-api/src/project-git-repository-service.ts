import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthContext, Project } from "@npati/workspace";
import type { WorkspaceBaseResolverPort } from "./workspace-base-resolver";
import { normalizeGitBranch } from "./code-git-write-policy";
import { GitError, GitConflictError } from "./project-git-service";
import type { GitStatusResult, GitBranchResult, GitRepositoryInspection } from "./project-git-service";

export interface ProjectGitRepositoryHost {
  bases: WorkspaceBaseResolverPort
  assertSafeIndex: (dir: string) => Promise<void>
  ensureRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
  requireWrite: (ctx: AuthContext) => void
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  resolveProjectWorkspace: (ctx: AuthContext, companyId: string, projectId: string, options: { create: boolean }) => Promise<{ project: Project; dir: string; readOnly: boolean; mounted: boolean }>
}

export async function ensureRepositoryInitialized(host: ProjectGitRepositoryHost, ctx: AuthContext, companyId: string, projectId: string): Promise<string> {
    const { dir } = await host.resolveProjectWorkspace(ctx, companyId, projectId, { create: true });
    const gitDir = path.join(dir, ".git");
    const exists = await lstat(gitDir).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) {
      await host.runGit(dir, ["init", "-b", "main"]);
      await host.runGit(dir, ["config", "user.name", "NPATI AI Agent"]);
      await host.runGit(dir, ["config", "user.email", "agent@npati.ai"]);
      await host.runGit(dir, ["config", "commit.gpgsign", "false"]);

      const gitignorePath = path.join(dir, ".gitignore");
      let gitignoreContent = "";
      try {
        gitignoreContent = await readFile(gitignorePath, "utf-8");
      } catch {
        // file doesn't exist yet
      }
      if (!gitignoreContent.includes(".worktrees")) {
        const defaultGitignore = [
          "node_modules",
          "dist",
          "build",
          ".next",
          ".cache",
          ".worktrees",
          ".npati-worktrees",
          ".npati-*",
          ".env",
          ".env.*",
          "*.pem",
          "*.key",
          "npm-debug.log*",
          "yarn-debug.log*",
          "yarn-error.log*",
        ].join("\n") + "\n";
        await writeFile(gitignorePath, gitignoreContent ? `${gitignoreContent.trimEnd()}\n.worktrees\n.npati-worktrees\n` : defaultGitignore, "utf-8");
      }

      await host.runGit(dir, ["add", "-A"]);
      await host.assertSafeIndex(dir);
      await host.runGit(dir, ["commit", "-m", "Initial project workspace"]);
    }
    const { stdout } = await host.runGit(dir, ["rev-parse", "--show-toplevel"]);
    if (path.resolve(stdout.trim()).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new GitError("INVALID_WORKSPACE", "Git repository must belong to the project workspace", 403);
    return dir;
  }

export async function inspectRepository(host: ProjectGitRepositoryHost, ctx: AuthContext, companyId: string, projectId: string): Promise<GitRepositoryInspection> {
    const { project, dir } = await host.resolveProjectWorkspace(ctx, companyId, projectId, { create: false });
    const gitEntry = await lstat(path.join(dir, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!gitEntry) return { project, dir, initialized: false, branch: null };
    /**
     * A `.git` that is not a directory is a pointer file (a linked worktree, a submodule, a `gitdir:` file).
     * Running `git init` over it — which the pre-C11 code would do — writes into somebody else's checkout, so
     * the state is refused instead of being "repaired". The membership probe below would reject it anyway;
     * this refuses it before any git process starts.
     */
    if (!gitEntry.isDirectory()) {
      throw new GitError("INVALID_WORKSPACE", "The project workspace is not an initialized repository of its own", 403);
    }
    const { stdout } = await host.runGit(dir, ["rev-parse", "--show-toplevel"]);
    if (path.resolve(stdout.trim()).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new GitError("INVALID_WORKSPACE", "Git repository must belong to the project workspace", 403);
    let branch: string | null = null;
    try {
      const head = await host.runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const resolved = normalizeGitBranch(head.stdout);
      // A detached HEAD answers with the literal `HEAD`, which is not a branch a write can name.
      if (resolved && resolved !== "HEAD") branch = resolved;
    } catch {
      // An unresolvable checkout is `null`, never a guessed branch: the caller decides what that means (a
      // named branch does not care, an unnamed one is refused as `BRANCH_UNRESOLVED`).
    }
    return { project, dir, initialized: true, branch };
  }

export async function status(host: ProjectGitRepositoryHost, ctx: AuthContext, companyId: string, projectId: string): Promise<GitStatusResult> {
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const { stdout } = await host.runGit(dir, ["status", "--porcelain=v1", "-b"]);
    const lines = stdout.split(/\r?\n/).filter(Boolean);

    let branch = "main";
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const branchMatch = line.slice(3).match(/^([^. ]+)/);
        if (branchMatch && branchMatch[1]) branch = branchMatch[1];
        continue;
      }
      const x = line[0];
      const y = line[1];
      const file = line.slice(3).trim();
      if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes((x ?? "") + (y ?? ""))) throw new GitConflictError([file], "Unmerged Git index requires user intervention");

      if (x === "?" && y === "?") {
        untracked.push(file);
      } else {
        if (x && x !== " " && x !== "?") staged.push(file);
        if (y && y !== " " && y !== "?") unstaged.push(file);
      }
    }

    return {
      branch,
      clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
      staged,
      unstaged,
      untracked,
    };
  }

export async function branch(host: ProjectGitRepositoryHost, ctx: AuthContext, companyId: string, projectId: string, options: { action: "list" | "create" | "switch"; branch?: string }): Promise<GitBranchResult> {
    if (options.action !== "list") host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);

    if (options.action === "create") {
      if (!options.branch || !/^[a-zA-Z0-9._\/-]{1,100}$/.test(options.branch)) {
        throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
      }
      await host.runGit(dir, ["checkout", "-b", options.branch]);
    } else if (options.action === "switch") {
      if (!options.branch || !/^[a-zA-Z0-9._\/-]{1,100}$/.test(options.branch)) {
        throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
      }
      await host.runGit(dir, ["checkout", options.branch]);
    }

    const { stdout } = await host.runGit(dir, ["branch", "--no-color"]);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    let current = "main";
    const branches: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (line.startsWith("* ")) {
        current = trimmed.slice(2);
        branches.push(current);
      } else if (trimmed) {
        branches.push(trimmed);
      }
    }

    return { current, branches };
  }

