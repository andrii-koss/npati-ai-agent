import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthContext, Project, ProjectCheckpoint, CheckpointTrigger, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import { safeProjectPath, ProjectFileError } from "./project-workspace";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
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

export class GitConflictEscalationError extends GitError {
  constructor(
    public readonly conflictingFiles: string[],
    public readonly details: string,
  ) {
    super(
      "GIT_CONFLICT_ESCALATED",
      `Git conflict resolution exceeded maximum automatic attempts (2). Escalating to user intervention for files: ${conflictingFiles.join(", ")}`,
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
    .replace(/(?:ghp_|github_pat_)[a-zA-Z0-9_]+/g, "***TOKEN***");
}

export class ProjectGitService {
  private readonly thresholds: CheckpointThresholds;

  constructor(
    private readonly workspaceStore: WorkspaceStore,
    private readonly projectService: Pick<ProjectService, "get">,
    private readonly workspaceRoot: string,
    thresholds?: Partial<CheckpointThresholds>,
    private readonly resolveGithubCredential?: (ctx: AuthContext, companyId: string, credentialId: string) => Promise<string>,
  ) {
    this.thresholds = {
      fileThreshold: thresholds?.fileThreshold ?? (Number(process.env.NPATI_CHECKPOINT_FILE_THRESHOLD) || defaultCheckpointThresholds.fileThreshold),
      lineThreshold: thresholds?.lineThreshold ?? (Number(process.env.NPATI_CHECKPOINT_LINE_THRESHOLD) || defaultCheckpointThresholds.lineThreshold),
    };
  }

  async getProjectPath(ctx: AuthContext, companyId: string, projectId: string): Promise<{ project: Project; dir: string }> {
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
    const dir = path.join(this.workspaceRoot, companyId, projectId);
    for (const segment of [this.workspaceRoot, path.join(this.workspaceRoot, companyId), dir]) {
      await mkdir(segment).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const entry = await lstat(segment);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new GitError("INVALID_WORKSPACE", "Symlink workspace is not allowed", 403);
    }
    return { project, dir };
  }

  private async runGit(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
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

  async ensureRepository(ctx: AuthContext, companyId: string, projectId: string): Promise<string> {
    const { dir } = await this.getProjectPath(ctx, companyId, projectId);
    const gitDir = path.join(dir, ".git");
    const exists = await lstat(gitDir).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) {
      await this.runGit(dir, ["init", "-b", "main"]);
      await this.runGit(dir, ["config", "user.name", "NPATI AI Agent"]);
      await this.runGit(dir, ["config", "user.email", "agent@npati.ai"]);
      await this.runGit(dir, ["config", "commit.gpgsign", "false"]);

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

      await this.runGit(dir, ["add", "-A"]);
      await this.assertSafeIndex(dir);
      await this.runGit(dir, ["commit", "-m", "Initial project workspace"]);
    }
    const { stdout } = await this.runGit(dir, ["rev-parse", "--show-toplevel"]);
    if (path.resolve(stdout.trim()).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new GitError("INVALID_WORKSPACE", "Git repository must belong to the project workspace", 403);
    return dir;
  }

  async status(ctx: AuthContext, companyId: string, projectId: string): Promise<GitStatusResult> {
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const { stdout } = await this.runGit(dir, ["status", "--porcelain=v1", "-b"]);
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
    if (options.action !== "list") this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);

    if (options.action === "create") {
      if (!options.branch || !/^[a-zA-Z0-9._\/-]{1,100}$/.test(options.branch)) {
        throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
      }
      await this.runGit(dir, ["checkout", "-b", options.branch]);
    } else if (options.action === "switch") {
      if (!options.branch || !/^[a-zA-Z0-9._\/-]{1,100}$/.test(options.branch)) {
        throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
      }
      await this.runGit(dir, ["checkout", options.branch]);
    }

    const { stdout } = await this.runGit(dir, ["branch", "--no-color"]);
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
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const target = await this.getCheckpoint(ctx, companyId, projectId, checkpointId);

    if (!target.commitHash) {
      throw new GitError("CHECKPOINT_NO_COMMIT", "Checkpoint does not have an associated commit hash", 400);
    }

    // MANDATORY SAFETY: Create automatic pre-restore checkpoint before rolling back!
    const backupCheckpoint = await this.createCheckpoint(ctx, companyId, projectId, {
      name: `Before restoring "${target.name}"`,
      description: `Automatic safety checkpoint taken prior to rollback to checkpoint ${checkpointId} (${target.commitHash.slice(0, 7)})`,
      trigger: "pre_restore",
    });

    // Hard reset to the checkpoint's commit
    await this.runGit(dir, ["reset", "--hard", target.commitHash]);
    await this.runGit(dir, ["clean", "-fd"]);

    return {
      restoredCheckpoint: target,
      backupCheckpoint,
    };
  }

  async push(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { branch?: string; credentialId?: string; approved?: boolean },
  ): Promise<{ pushed: boolean; branch: string; remote: string }> {
    this.requireWrite(ctx);
    if (!options.approved) throw new GitApprovalRequiredError();
    const { project } = await this.getProjectPath(ctx, companyId, projectId);
    if (project.repositoryProvider !== "github" || !project.repositoryUrl) throw new GitError("REPOSITORY_NOT_CONNECTED", "Connect a GitHub repository first", 400);
    const branch = options.branch || project.repositoryBranch || "main";
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(branch) || branch.includes("..") || branch.includes("@{")) throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
    const token = await this.githubToken(ctx, companyId, options.credentialId);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
    try {
      await this.runGit(dir, ["push", project.repositoryUrl, branch], {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
      });
    } catch {
      throw new GitError("GIT_PUSH_FAILED", "GitHub push failed; inspect branch and repository permissions", 502);
    }
    return { pushed: true, branch, remote: project.repositoryUrl };
  }

  async createPullRequest(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { title: string; body?: string; base?: string; head?: string; credentialId?: string; approved?: boolean },
  ): Promise<{ prNumber?: number; prUrl?: string; message: string }> {
    this.requireWrite(ctx);
    if (!options.approved) throw new GitApprovalRequiredError();
    const { project } = await this.getProjectPath(ctx, companyId, projectId);
    if (!options.title?.trim()) throw new GitError("PR_TITLE_REQUIRED", "Pull Request title is required", 400);
    if (project.repositoryProvider !== "github" || !project.repositoryUrl) throw new GitError("REPOSITORY_NOT_CONNECTED", "Connect a GitHub repository first", 400);
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(project.repositoryUrl);
    if (!match) throw new GitError("INVALID_REPOSITORY_URL", "Invalid configured GitHub URL", 400);
    const token = await this.githubToken(ctx, companyId, options.credentialId);
    const [, owner, repo] = match;
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "NPATI-Agent-Website-Builder" },
        body: JSON.stringify({ title: options.title.trim(), body: options.body || "", base: options.base || "main", head: options.head || project.repositoryBranch || "main" }),
      });
    } catch {
      throw new GitError("GITHUB_PR_FAILED", "GitHub pull request request failed", 502);
    }
    if (!response.ok) throw new GitError("GITHUB_PR_FAILED", "GitHub rejected the pull request", response.status);
    const data = await response.json() as { number?: number; html_url?: string };
    return { prNumber: data.number, prUrl: data.html_url, message: `Pull Request #${data.number} created successfully.` };
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
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const slug = safeAgentSlug(options.agentSlug);
    const branch = `agent/${slug}`;
    const baseBranch = options.baseBranch ?? "project/main";

    // Ensure baseBranch exists (point to HEAD if not yet created)
    const { branches } = await this.branch(ctx, companyId, projectId, { action: "list" });
    if (!branches.includes(baseBranch)) {
      await this.runGit(dir, ["branch", baseBranch, "HEAD"]).catch(() => undefined);
    }

    const wtDir = this.getAgentWorktreePath(dir, options.agentSlug);
    await mkdir(path.dirname(wtDir), { recursive: true });

    // Clean up if worktree already exists at this path
    try {
      await this.runGit(dir, ["worktree", "remove", "--force", wtDir]);
    } catch {}
    await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    await this.runGit(dir, ["worktree", "prune"]).catch(() => undefined);

    // Create worktree on branch starting from baseBranch
    await this.runGit(dir, ["worktree", "add", "-B", branch, wtDir, baseBranch]);

    return {
      worktreePath: wtDir,
      branch,
      baseBranch,
    };
  }

  async commitAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentSlug: string; message: string; stageAll?: boolean },
  ): Promise<{ commitHash: string; message: string }> {
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const wtDir = this.getAgentWorktreePath(dir, options.agentSlug);
    const message = options.message?.trim() || `Agent ${options.agentSlug} update`;

    // Stage changes in worktree
    await this.runGit(wtDir, ["add", "-A"]);

    // Assert safe index in worktree
    const { stdout: stagedOut } = await this.runGit(wtDir, ["diff", "--no-ext-diff", "--cached", "--name-only", "-z"]);
    for (const file of stagedOut.split("\0").filter(Boolean)) {
      try { safeProjectPath(file); }
      catch { throw new GitError("PROTECTED_FILE", "Protected files cannot be committed in worktree", 403); }
    }

    // Check status
    const { stdout: statusOut } = await this.runGit(wtDir, ["status", "--porcelain=v1"]);
    if (statusOut.trim().length > 0) {
      await this.runGit(wtDir, ["commit", "-m", message]);
    } else {
      await this.runGit(wtDir, ["commit", "--allow-empty", "-m", message]);
    }

    const { stdout: hashOut } = await this.runGit(wtDir, ["rev-parse", "HEAD"]);
    return {
      commitHash: hashOut.trim(),
      message,
    };
  }

  async diffAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentSlug: string; baseBranch?: string },
  ): Promise<{ diff: string; files: string[] }> {
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const slug = safeAgentSlug(options.agentSlug);
    const branch = `agent/${slug}`;
    const baseBranch = options.baseBranch ?? "project/main";

    const { stdout: namesOut } = await this.runGit(dir, ["diff", "--name-only", `${baseBranch}...${branch}`]);
    const files = namesOut.split(/\r?\n/).filter(Boolean);

    const { stdout: diffOut } = await this.runGit(dir, ["diff", "--no-ext-diff", `${baseBranch}...${branch}`]);
    return {
      diff: diffOut.slice(0, 128_000),
      files,
    };
  }

  async mergeAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentSlug: string; targetBranch?: string; message?: string },
  ): Promise<{ merged: boolean; commitHash: string; targetBranch: string; sourceBranch: string }> {
    this.requireWrite(ctx);
    const lockKey = `${companyId}:${projectId}`;
    const prev = this.mergeLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.mergeLocks.set(lockKey, prev.then(() => current));
    await prev;

    try {
      const dir = await this.ensureRepository(ctx, companyId, projectId);
      const slug = safeAgentSlug(options.agentSlug);
      const sourceBranch = `agent/${slug}`;
      const targetBranch = options.targetBranch ?? "project/main";
      const commitMsg = options.message?.trim() || `Merge ${sourceBranch} into ${targetBranch}`;

      // Ensure targetBranch exists
      const { branches } = await this.branch(ctx, companyId, projectId, { action: "list" });
      if (!branches.includes(targetBranch)) {
        await this.runGit(dir, ["branch", targetBranch, "HEAD"]).catch(() => undefined);
      }

      // Switch to targetBranch in main repo
      await this.runGit(dir, ["checkout", targetBranch]);

      try {
        await this.runGit(dir, ["merge", "--no-ff", "-m", commitMsg, sourceBranch]);
      } catch (mergeError: any) {
        // Detect conflicting unmerged files
        let conflictFiles: string[] = [];
        try {
          const { stdout: unmerged } = await this.runGit(dir, ["diff", "--name-only", "--diff-filter=U"]);
          conflictFiles = unmerged.split(/\r?\n/).filter(Boolean);
        } catch {
          if (mergeError instanceof GitConflictError) {
            conflictFiles = mergeError.conflictingFiles;
          }
        }

        // Always abort the in-progress merge immediately to leave main workspace clean
        try {
          await this.runGit(dir, ["merge", "--abort"]);
        } catch {}

        if (conflictFiles.length > 0) {
          throw new GitConflictEscalationError(
            conflictFiles,
            `Merge conflict detected between ${sourceBranch} and ${targetBranch} in: ${conflictFiles.join(", ")}`,
          );
        }
        throw mergeError;
      }

      const { stdout: headOut } = await this.runGit(dir, ["rev-parse", "HEAD"]);
      return {
        merged: true,
        commitHash: headOut.trim(),
        targetBranch,
        sourceBranch,
      };
    } finally {
      release();
    }
  }

  async removeAgentWorktree(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentSlug: string; deleteBranch?: boolean },
  ): Promise<{ removed: boolean }> {
    this.requireWrite(ctx);
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const slug = safeAgentSlug(options.agentSlug);
    const wtDir = this.getAgentWorktreePath(dir, slug);

    try {
      await this.runGit(dir, ["worktree", "remove", "--force", wtDir]);
    } catch {}
    await this.runGit(dir, ["worktree", "prune"]).catch(() => undefined);
    await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);

    if (options.deleteBranch) {
      await this.runGit(dir, ["branch", "-D", `agent/${slug}`]).catch(() => undefined);
    }

    return { removed: true };
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
    const dir = await this.ensureRepository(ctx, companyId, projectId);
    const { stdout } = await this.runGit(dir, ["worktree", "list", "--porcelain"]);
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
}
