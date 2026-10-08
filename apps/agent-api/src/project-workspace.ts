import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthContext, MountedFolderMode, Project } from "@npati/workspace";
import { managedWorkspaceBaseResolver, type WorkspaceBase, type WorkspaceBaseResolverPort } from "./workspace-base-resolver";

export interface ProjectWorkspaceInfo {
  companyId: string;
  projectId: string;
  workspaceId: string;
  logicalPath: string;
  currentBranch: string;
  activeSandboxId?: string;
  currentRevision: string;
}

export interface ProjectFileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  revision?: string;
}

export interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
  revision: string;
}

export interface ProjectFileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
  oldSize?: number;
  newSize?: number;
}

export interface ProjectChangesResult {
  summary: {
    added: number;
    modified: number;
    deleted: number;
    total: number;
  };
  changes: ProjectFileChange[];
}

/**
 * The honest outcome of a workspace removal.
 *
 * `removed` is the state of the disk afterwards, not the fact that we tried: a delete that failed to remove bytes
 * answers `removed: false` with a reason and the outstanding targets, so a caller can never read success from an
 * attempt. `alreadyAbsent` distinguishes "was already gone" (an idempotent re-run) from "we just removed it".
 */
export interface ProjectWorkspaceRemoval {
  removed: boolean;
  alreadyAbsent: boolean;
  /** Absolute path the removal was scoped to. Reported for diagnostics, never for a caller to delete. */
  path: string;
  reason?: string;
  outstanding?: string[];
}

export interface ProjectMountRequest {
  /** The canonical host directory the container must see; the same path the workspace provider uses. */
  source: string;
  /** The container target. Fixed (`/workspace`), never caller-chosen. */
  target: string;
  /** `true` for an `ro` mount: the bind is created with `readonly` at the Docker level. */
  readOnly: boolean;
  mode: MountedFolderMode;
}

export interface ProjectWorkspace {
  info(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string): Promise<ProjectWorkspaceInfo>;
  /**
   * C15: the mounted folder this project's canonical workspace **is**, or `null` when the workspace is managed.
   *
   * It is an optional member because it is a fact only a mount-aware provider owns; a provider without an
   * allowlist answers by omission, and its absence means "no mount", which is exactly the pre-C15 behaviour.
   * The sandbox path reads it to decide three things at once: whether to create the container with a bind
   * mount, and whether to skip the upload **and** the copy-back that would otherwise make the sandbox a second
   * writer of the same directory.
   */
  mountFor?(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectMountRequest | null>;
  listFiles(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string): Promise<ProjectFileEntry[]>;
  getFileTree(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string): Promise<ProjectFileEntry[]>;
  searchFiles(ctx: AuthContext, companyId: string, projectId: string, query: string, workspaceId?: string, agentId?: string): Promise<ProjectFileEntry[]>;
  readFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, workspaceId?: string, agentId?: string): Promise<ProjectFileContent>;
  createFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, content: string, workspaceId?: string, agentId?: string): Promise<ProjectFileContent>;
  writeFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, content: string, expectedRevision: string, workspaceId?: string, agentId?: string): Promise<ProjectFileContent>;
  editFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, find: string, replacement: string, expectedRevision: string, workspaceId?: string, agentId?: string): Promise<ProjectFileContent>;
  deleteFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, workspaceId?: string, agentId?: string): Promise<void>;
  moveFile(ctx: AuthContext, companyId: string, projectId: string, from: string, to: string, expectedRevision: string, workspaceId?: string, agentId?: string): Promise<ProjectFileContent>;
  setBaseline(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string): Promise<{ fileCount: number }>;
  getChanges(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string): Promise<ProjectChangesResult>;
  /**
   * C7: removes the on-disk workspace of a project. This runs **after** the project record is gone, so it cannot
   * depend on a project row and must be safe to call twice.
   */
  removeProjectWorkspace(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectWorkspaceRemoval>;
  registerWorktree?(companyId: string, projectId: string, agentId: string, worktreeDir: string): void;
  unregisterWorktree?(companyId: string, projectId: string, agentId: string): void;
  getWorktree?(companyId: string, projectId: string, agentId?: string): string | undefined;
}

export class ProjectFileError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly currentRevision?: string) { super(message); }
}

/**
 * Compares two resolved paths. Windows path comparison is case-insensitive, and a case mismatch would otherwise
 * read as "this is a link", which would refuse legitimate removals.
 */
export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function safeProjectPath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) throw new ProjectFileError("invalid_path", "Invalid project file path");
  const parts = value.split("/");
  if (parts.length > 32 || parts.some((part) => !part || part === "." || part === ".." || part.includes(":") || /[<>|?*"\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new ProjectFileError("invalid_path", "Invalid project file path");
  if (parts.some((part) => /^(?:\.npati-.*|\.worktrees|\.env(?:\..*)?|\.npmrc|\.netrc|\.git|\.aws|\.ssh|(?:credentials?|secrets?)(?:[._-].*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/i.test(part))) throw new ProjectFileError("secret_path", "Protected file path", 403);
  return parts.join("/");
}

const revision = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
const validId = (value: string) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const fileLimit = (value: number | undefined, fallback: number) => value && Number.isSafeInteger(value) && value > 0 ? value : fallback;

export function generateUnifiedDiff(filePath: string, oldStr: string | null, newStr: string | null): string {
  if (oldStr === null && newStr !== null) {
    const lines = newStr.split(/\r?\n/);
    return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
  }
  if (oldStr !== null && newStr === null) {
    const lines = oldStr.split(/\r?\n/);
    return `--- a/${filePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join("\n")}`;
  }
  if (oldStr === null || newStr === null || oldStr === newStr) return "";

  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);

  if (oldLines.length > 5000 || newLines.length > 5000) {
    return `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n[File too large for unified diff]`;
  }

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    const nextRow = dp[i + 1]!;
    const curRow = dp[i]!;
    for (let j = 0; j < n; j++) {
      if (oldLines[i] === newLines[j]) {
        nextRow[j + 1] = (curRow[j] ?? 0) + 1;
      } else {
        nextRow[j + 1] = Math.max(curRow[j + 1] ?? 0, nextRow[j] ?? 0);
      }
    }
  }

  type DiffOp = { type: "common" | "add" | "del"; text: string; oldLine?: number; newLine?: number };
  const ops: DiffOp[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    const oldLine = oldLines[i - 1] ?? "";
    const newLine = newLines[j - 1] ?? "";
    const dpRow = dp[i] ?? [];
    const dpPrevRow = dp[i - 1] ?? [];
    if (i > 0 && j > 0 && oldLine === newLine) {
      ops.unshift({ type: "common", text: oldLine, oldLine: i, newLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dpRow[j - 1] ?? 0) >= (dpPrevRow[j] ?? 0))) {
      ops.unshift({ type: "add", text: newLine, newLine: j });
      j--;
    } else if (i > 0 && (j === 0 || (dpRow[j - 1] ?? 0) < (dpPrevRow[j] ?? 0))) {
      ops.unshift({ type: "del", text: oldLine, oldLine: i });
      i--;
    }
  }

  const context = 3;
  const hunks: string[] = [];
  let currentHunk: DiffOp[] = [];
  let lastModifiedIndex = -1;

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    if (!op) continue;
    if (op.type !== "common") {
      if (currentHunk.length === 0) {
        const startCtx = Math.max(0, idx - context);
        currentHunk = ops.slice(startCtx, idx);
      }
      currentHunk.push(op);
      lastModifiedIndex = currentHunk.length - 1;
    } else if (currentHunk.length > 0) {
      currentHunk.push(op);
      if (currentHunk.length - 1 - lastModifiedIndex >= context * 2) {
        const hunkToFormat = currentHunk.slice(0, lastModifiedIndex + context + 1);
        hunks.push(formatHunk(hunkToFormat));
        currentHunk = [];
        lastModifiedIndex = -1;
      }
    }
  }

  if (currentHunk.length > 0 && lastModifiedIndex !== -1) {
    const hunkToFormat = currentHunk.slice(0, lastModifiedIndex + context + 1);
    hunks.push(formatHunk(hunkToFormat));
  }

  if (hunks.length === 0) return "";
  return `--- a/${filePath}\n+++ b/${filePath}\n` + hunks.join("\n");
}

function formatHunk(hunkOps: Array<{ type: string; text: string; oldLine?: number; newLine?: number }>): string {
  let oldStart = 0, oldCount = 0, newStart = 0, newCount = 0;
  for (const op of hunkOps) {
    if (op.type === "common") {
      if (oldStart === 0 && op.oldLine) oldStart = op.oldLine;
      if (newStart === 0 && op.newLine) newStart = op.newLine;
      oldCount++;
      newCount++;
    } else if (op.type === "del") {
      if (oldStart === 0 && op.oldLine) oldStart = op.oldLine;
      oldCount++;
    } else if (op.type === "add") {
      if (newStart === 0 && op.newLine) newStart = op.newLine;
      newCount++;
    }
  }
  const lines = hunkOps.map((op) => (op.type === "add" ? `+${op.text}` : op.type === "del" ? `-${op.text}` : ` ${op.text}`));
  return `@@ -${oldStart || 1},${oldCount} +${newStart || 1},${newCount} @@\n${lines.join("\n")}`;
}

export class LocalProjectWorkspace implements ProjectWorkspace {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly activeWorktrees = new Map<string, string>();
  private readonly root: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  /**
   * C15: the **one** resolver of this project's canonical workspace. It defaults to the managed root so every
   * existing construction site and test keeps its exact behaviour, and `app.ts` passes the shared resolver that
   * `ProjectGitService` reads too.
   */
  protected readonly bases: WorkspaceBaseResolverPort;
  constructor(private readonly projects: { get(ctx: AuthContext, companyId: string, projectId: string): Promise<Pick<Project, "id" | "companyId" | "workspaceId" | "status" | "repositoryBranch" | "sandboxId" | "revision">> }, options: { root: string; maxFileBytes?: number; maxFiles?: number; bases?: WorkspaceBaseResolverPort }) {
    this.root = path.resolve(options.root);
    this.bases = options.bases ?? managedWorkspaceBaseResolver(this.root);
    this.maxFileBytes = fileLimit(options.maxFileBytes, 1024 * 1024);
    this.maxFiles = fileLimit(options.maxFiles, 2000);
  }

  registerWorktree(companyId: string, projectId: string, agentId: string, worktreeDir: string): void {
    if (!validId(companyId) || !validId(projectId) || typeof agentId !== "string" || !agentId) {
      throw new ProjectFileError("invalid_worktree", "Invalid worktree parameters");
    }
    const resolved = path.resolve(worktreeDir);
    const expectedBase = path.resolve(path.join(this.root, companyId, projectId, ".worktrees"));
    if (!resolved.startsWith(expectedBase + path.sep)) {
      throw new ProjectFileError("invalid_worktree", "Worktree directory must reside within project .worktrees", 403);
    }
    this.activeWorktrees.set(`${companyId}:${projectId}:${agentId}`, resolved);
  }

  unregisterWorktree(companyId: string, projectId: string, agentId: string): void {
    this.activeWorktrees.delete(`${companyId}:${projectId}:${agentId}`);
  }

  getWorktree(companyId: string, projectId: string, agentId?: string): string | undefined {
    if (!agentId) return undefined;
    return this.activeWorktrees.get(`${companyId}:${projectId}:${agentId}`);
  }

  /**
   * C15: everything that needs the canonical workspace goes through here, so the *one* resolver decides the
   * base and the read-only state for both the managed and the mounted case. A mounted folder is not a special
   * branch of the file operations: it is the same operations with a base that came from the allowlist, which is
   * what makes it a real `WorkspaceProvider` rather than a second implementation of the workspace.
   *
   * The read-only refusal is structural: an `ro` mount cannot be written through *this* API at all (the Docker
   * `readonly` bind is the second, independent wall the owner decision requires, and the sandbox has it even
   * when this layer is bypassed).
   */
  private async access(ctx: AuthContext, companyId: string, projectId: string, mode: "read" | "write", workspaceId?: string, agentId?: string) {
    if (!validId(companyId) || !validId(projectId)) throw new ProjectFileError("invalid_project", "Invalid project identifier");
    const project = await this.projects.get(ctx, companyId, projectId);
    if (project.companyId !== companyId || project.id !== projectId || project.workspaceId !== ctx.workspaceId || (workspaceId !== undefined && workspaceId !== project.workspaceId)) throw new ProjectFileError("workspace_mismatch", "Project workspace access denied", 403);
    if (project.status === "archived" && mode === "write") throw new ProjectFileError("project_archived", "Archived project is read only", 409);
    const allowed = ctx.permissions.includes("*") || ctx.permissions.includes("owner") || ctx.permissions.includes("business:manage") || ctx.permissions.includes(mode === "read" ? "workspace:read" : "workspace:write");
    if (!allowed) throw new ProjectFileError("permission_denied", "Project file access denied", 403);

    // Check if an isolated worktree is registered for this agent
    const wtDir = agentId ? this.activeWorktrees.get(`${companyId}:${projectId}:${agentId}`) : undefined;
    if (wtDir) {
      const entry = await lstat(wtDir).catch(() => undefined);
      if (entry?.isDirectory() && !entry.isSymbolicLink()) {
        return { project, base: wtDir, readOnly: false, mounted: false };
      }
    }

    // The single resolver: a managed base, or the canonical mounted folder, or a refusal when a confirmed mount
    // no longer passes validation. Never a fallback — a mount that stopped being safe must stop the call.
    const resolved: WorkspaceBase = await this.bases.resolve(ctx, companyId, projectId);
    if (mode === "write" && resolved.readOnly) {
      throw new ProjectFileError("mounted_folder_read_only", "The mounted project folder is read only", 409);
    }
    if (resolved.mounted) return { project, base: resolved.base, readOnly: resolved.readOnly, mounted: true };

    const base = resolved.base;
    await mkdir(this.root, { recursive: true });
    for (const candidate of [this.root, path.join(this.root, companyId), base]) {
      await mkdir(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const entry = await lstat(candidate);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ProjectFileError("invalid_path", "Symlink workspace is not allowed");
    }
    return { project, base, readOnly: false, mounted: false };
  }
  /**
   * C15: `info()` is the only place a revision is derived, and it derives it from `tree(base)` — so for a
   * mounted project the digest is a hash over the **mounted** tree (paths, sizes and per-file content digests).
   * Nothing about the mount is visible to `CodeWorkspaceRevisionGuard`: it reads `currentRevision` through the
   * same `ProjectWorkspace.info` it always used, and a change made directly in the mounted folder (by the user,
   * or by a sandbox writing through the rw bind) moves that digest like any other write. That is why
   * `workspace_revision_mismatch` needs no mounted branch: the comparison is between two readings of the same
   * canonical source.
   */
  private async target(base: string, filePath: string) {
    const clean = safeProjectPath(filePath);
    const parts = clean.split("/");
    let candidate = base;
    for (const part of parts) {
      candidate = path.join(candidate, part);
      const entry = await lstat(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (entry?.isSymbolicLink()) throw new ProjectFileError("invalid_path", "Symlink file path is not allowed");
    }
    if (!candidate.startsWith(base + path.sep)) throw new ProjectFileError("invalid_path", "Invalid project file path");
    return { clean, absolute: candidate };
  }
  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    const lockDirectory = path.join(key, ".npati-write-lock");
    const ownerFile = path.join(lockDirectory, "owner");
    const owner = randomUUID();
    const started = Date.now();
    let acquired = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      while (!acquired) {
        try {
          await mkdir(lockDirectory);
          acquired = true;
          await writeFile(ownerFile, owner, "utf8");
        } catch (error) {
          if (acquired) throw error;
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const age = await stat(lockDirectory).then((entry) => Date.now() - entry.mtimeMs, () => 0);
          if (age > 60_000) {
            const stale = lockDirectory + ".stale-" + randomUUID();
            try {
              await rename(lockDirectory, stale);
              await rm(stale, { recursive: true, force: true });
            } catch { /* Another writer may have recovered the lease. */ }
            continue;
          }
          if (Date.now() - started > 10_000) throw new ProjectFileError("workspace_busy", "Project workspace is busy", 409);
          await delay(25);
        }
      }
      heartbeat = setInterval(() => { void utimes(lockDirectory, new Date(), new Date()).catch(() => undefined); }, 5_000);
      heartbeat.unref();
      return await operation();
    } finally {
      try {
        if (heartbeat) clearInterval(heartbeat);
        if (acquired && path.resolve(lockDirectory).startsWith(path.resolve(key) + path.sep)) {
          const currentOwner = await readFile(ownerFile, "utf8").catch(() => "");
          if (currentOwner === owner) await rm(lockDirectory, { recursive: true, force: true });
        }
      } finally {
        release();
        if (this.locks.get(key) === tail) this.locks.delete(key);
      }
    }
  }
  private async bytes(absolute: string) {
    const entry = await lstat(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") throw new ProjectFileError("file_not_found", "Project file not found", 404); throw error; });
    if (!entry.isFile()) throw new ProjectFileError("invalid_path", "Expected a regular file");
    if (entry.size > this.maxFileBytes) throw new ProjectFileError("file_too_large", "Project file size limit exceeded", 413);
    return readFile(absolute);
  }
  private content(clean: string, bytes: Buffer): ProjectFileContent { return { path: clean, content: bytes.toString("utf8"), size: bytes.length, revision: revision(bytes) }; }
  private async tree(base: string): Promise<ProjectFileEntry[]> {
    const items: ProjectFileEntry[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(base, relative), { withFileTypes: true })) {
        const child = relative ? relative + "/" + entry.name : entry.name;
        if (entry.isSymbolicLink() || entry.name.startsWith(".npati-") || entry.name === ".worktrees") continue;
        try { safeProjectPath(child); } catch { continue; }
        if (entry.isDirectory()) { items.push({ path: child, name: entry.name, type: "directory" }); await walk(child); }
        else if (entry.isFile()) {
          const full = path.join(base, child);
          const info = await stat(full);
          items.push({ path: child, name: entry.name, type: "file", size: info.size, revision: info.size <= this.maxFileBytes ? revision(await readFile(full)) : undefined });
        }
        if (items.length > this.maxFiles * 2) throw new ProjectFileError("file_limit", "Project file count limit exceeded", 409);
      }
    };
    await walk("");
    return items.sort((a, b) => a.path.localeCompare(b.path));
  }
  async info(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string) {
    const { project, base } = await this.access(ctx, companyId, projectId, "read", workspaceId, agentId);
    const entries = await this.tree(base);
    return { companyId, projectId, workspaceId: project.workspaceId, logicalPath: `/workspaces/${companyId}/${projectId}`, currentBranch: project.repositoryBranch ?? "main", activeSandboxId: project.sandboxId, currentRevision: revision(JSON.stringify(entries)) };
  }
  async getFileTree(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string) { const { base } = await this.access(ctx, companyId, projectId, "read", workspaceId, agentId); return this.tree(base); }
  async listFiles(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string) { return (await this.getFileTree(ctx, companyId, projectId, workspaceId, agentId)).filter((entry) => entry.type === "file"); }
  async searchFiles(ctx: AuthContext, companyId: string, projectId: string, query: string, workspaceId?: string, agentId?: string) {
    if (typeof query !== "string" || !query.trim() || query.length > 200) throw new ProjectFileError("invalid_query", "Invalid file search query");
    return (await this.listFiles(ctx, companyId, projectId, workspaceId, agentId)).filter((entry) => entry.path.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 100);
  }
  async readFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, workspaceId?: string, agentId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "read", workspaceId, agentId);
    const { clean, absolute } = await this.target(base, filePath);
    const bytes = await this.bytes(absolute);
    const isManifestOrLockfile = /^(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(?:json|lock)|requirements\.txt|Pipfile(?:\.lock)?)$/i.test(path.basename(clean));
    if (!isManifestOrLockfile && (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})\b|(?<![-A-Za-z0-9_])(?:[A-Za-z0-9_]*(?:api[_-]?key|password|secret|token)(?![sS]\b)[A-Za-z0-9_]*)["']?\s*[:=]\s*["'][^"']{8,}["']/i.test(bytes.toString("utf8")))) throw new ProjectFileError("secret_content", "Protected file content", 403);
    return this.content(clean, bytes);
  }
  private async save(absolute: string, content: string) {
    if (typeof content !== "string") throw new ProjectFileError("invalid_content", "Content must be text");
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > this.maxFileBytes) throw new ProjectFileError("file_too_large", "Project file size limit exceeded", 413);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = path.join(path.dirname(absolute), `.npati-${randomUUID()}.tmp`);
    try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, absolute); }
    finally { await rm(temporary, { force: true }); }
    return bytes;
  }
  async createFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, content: string, workspaceId?: string, agentId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId, agentId);
    return this.lock(base, async () => {
      const { clean, absolute } = await this.target(base, filePath);
      if (await lstat(absolute).then(() => true, () => false)) throw new ProjectFileError("file_exists", "Project file already exists", 409);
      if ((await this.listFiles(ctx, companyId, projectId, workspaceId, agentId)).length >= this.maxFiles) throw new ProjectFileError("file_limit", "Project file count limit exceeded", 409);
      const bytes = await this.save(absolute, content);
      return this.content(clean, bytes);
    });
  }
  async writeFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, content: string, expectedRevision: string, workspaceId?: string, agentId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId, agentId);
    return this.lock(base, async () => {
      const { clean, absolute } = await this.target(base, filePath);
      const current = await this.bytes(absolute);
      if (!expectedRevision || expectedRevision !== revision(current)) throw new ProjectFileError("revision_conflict", "Project file revision changed", 409, revision(current));
      return this.content(clean, await this.save(absolute, content));
    });
  }
  async editFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, find: string, replacement: string, expectedRevision: string, workspaceId?: string, agentId?: string) {
    if (typeof find !== "string" || !find || typeof replacement !== "string") throw new ProjectFileError("invalid_edit", "Find and replacement must be text");
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId, agentId);
    return this.lock(base, async () => {
      const { clean, absolute } = await this.target(base, filePath);
      const current = await this.bytes(absolute);
      if (!expectedRevision || expectedRevision !== revision(current)) throw new ProjectFileError("revision_conflict", "Project file revision changed", 409, revision(current));
      const source = current.toString("utf8");
      if (!source.includes(find)) throw new ProjectFileError("edit_not_found", "Find text not found", 409);
      return this.content(clean, await this.save(absolute, source.replace(find, replacement)));
    });
  }
  async moveFile(ctx: AuthContext, companyId: string, projectId: string, from: string, to: string, expectedRevision: string, workspaceId?: string, agentId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId, agentId);
    return this.lock(base, async () => {
      const source = await this.target(base, from), destination = await this.target(base, to);
      const current = await this.bytes(source.absolute);
      if (!expectedRevision || expectedRevision !== revision(current)) throw new ProjectFileError("revision_conflict", "Project file revision changed", 409, revision(current));
      if (await lstat(destination.absolute).then(() => true, () => false)) throw new ProjectFileError("file_exists", "Destination already exists", 409);
      await mkdir(path.dirname(destination.absolute), { recursive: true });
      await rename(source.absolute, destination.absolute);
      return this.content(destination.clean, current);
    });
  }
  async deleteFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, workspaceId?: string, agentId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId, agentId);
    await this.lock(base, async () => { const { absolute } = await this.target(base, filePath); await this.bytes(absolute); await rm(absolute); });
  }

  async setBaseline(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string): Promise<{ fileCount: number }> {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId, agentId);
    return this.lock(base, async () => {
      const files = await this.listFiles(ctx, companyId, projectId, workspaceId, agentId);
      const snapshot: Record<string, string> = {};
      for (const entry of files) {
        if (entry.path.split("/").some((p) => ["node_modules", "dist", "build", ".next", ".cache", ".worktrees"].includes(p))) continue;
        const { absolute } = await this.target(base, entry.path);
        const content = (await this.bytes(absolute)).toString("utf8");
        snapshot[entry.path] = content;
      }
      const baselineFile = path.join(base, ".npati-baseline.json");
      await writeFile(baselineFile, JSON.stringify({ timestamp: new Date().toISOString(), files: snapshot }, null, 2), "utf8");
      return { fileCount: Object.keys(snapshot).length };
    });
  }

  async getChanges(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string, agentId?: string): Promise<ProjectChangesResult> {
    const { base } = await this.access(ctx, companyId, projectId, "read", workspaceId, agentId);
    const baselineFile = path.join(base, ".npati-baseline.json");
    let baselineFiles: Record<string, string> = {};
    try {
      const raw = await readFile(baselineFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.files === "object") baselineFiles = parsed.files;
    } catch {
      // No baseline saved yet; baseline is empty, so all current files show as added
    }

    const currentFiles = await this.listFiles(ctx, companyId, projectId, workspaceId, agentId);
    const currentMap = new Map<string, string>();
    for (const entry of currentFiles) {
      if (entry.path.split("/").some((p) => ["node_modules", "dist", "build", ".next", ".cache", ".worktrees"].includes(p))) continue;
      const { absolute } = await this.target(base, entry.path);
      const content = (await this.bytes(absolute)).toString("utf8");
      currentMap.set(entry.path, content);
    }

    const changes: ProjectFileChange[] = [];
    const allPaths = new Set([...Object.keys(baselineFiles), ...currentMap.keys()]);

    for (const filePath of [...allPaths].sort()) {
      const inBaseline = Object.prototype.hasOwnProperty.call(baselineFiles, filePath);
      const inCurrent = currentMap.has(filePath);

      if (!inBaseline && inCurrent) {
        const content = currentMap.get(filePath)!;
        changes.push({
          path: filePath,
          status: "added",
          diff: generateUnifiedDiff(filePath, null, content),
          newSize: Buffer.byteLength(content, "utf8"),
        });
      } else if (inBaseline && !inCurrent) {
        const content = baselineFiles[filePath] ?? "";
        changes.push({
          path: filePath,
          status: "deleted",
          diff: generateUnifiedDiff(filePath, content, null),
          oldSize: Buffer.byteLength(content, "utf8"),
        });
      } else if (inBaseline && inCurrent) {
        const oldContent = baselineFiles[filePath] ?? "";
        const newContent = currentMap.get(filePath)!;
        if (oldContent !== newContent) {
          changes.push({
            path: filePath,
            status: "modified",
            diff: generateUnifiedDiff(filePath, oldContent, newContent),
            oldSize: Buffer.byteLength(oldContent, "utf8"),
            newSize: Buffer.byteLength(newContent, "utf8"),
          });
        }
      }
    }

    const summary = {
      added: changes.filter((c) => c.status === "added").length,
      modified: changes.filter((c) => c.status === "modified").length,
      deleted: changes.filter((c) => c.status === "deleted").length,
      total: changes.length,
    };

    return { summary, changes };
  }

  /**
   * C7: remove the on-disk workspace of a project.
   *
   * Design notes that matter for safety:
   *  - It deliberately does **not** read the project record. The delete route removes the project first, so
   *    requiring a row would make the cleanup impossible exactly when it is needed; the tenant scope therefore
   *    comes from `companyId` being a validated identifier that is joined under the workspace root, which is what
   *    keeps one tenant's call from ever reaching another tenant's directory.
   *  - Every path component is checked with `lstat`: a symlink at any level makes the call **refuse** instead of
   *    following the link and deleting something outside the workspace root.
   *  - Idempotent: an already-absent directory is `removed: true, alreadyAbsent: true`.
   *  - Honest failure: if bytes survive, the answer is `removed: false` with the reason and the outstanding
   *    target — never a success message over remaining data.
   */
  async removeProjectWorkspace(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectWorkspaceRemoval> {
    if (!validId(companyId) || !validId(projectId)) throw new ProjectFileError("invalid_project", "Invalid project identifier");
    const allowed = ctx.permissions.includes("*") || ctx.permissions.includes("owner") || ctx.permissions.includes("business:manage") || ctx.permissions.includes("workspace:write");
    if (!allowed) throw new ProjectFileError("permission_denied", "Project workspace removal denied", 403);

    /**
     * C15: a mounted project has no managed directory to remove. The canonical workspace is the **user's own
     * folder**, and deleting it is precisely the data loss a workspace cleanup must never cause — so the answer
     * says so instead of reporting a deletion that did not happen: `alreadyAbsent: true` (no managed workspace
     * was ever created) with the reason naming the preserved source. The in-process bookkeeping is dropped, so
     * no lock or worktree outlives the project.
     */
    const mountedSource = await this.bases.mountedSource(ctx, companyId, projectId);
    if (mountedSource) {
      this.forgetWorkspaceState(companyId, projectId);
      return { removed: true, alreadyAbsent: true, path: mountedSource, reason: "mounted_source_preserved" };
    }

    const companyDir = path.join(this.root, companyId);
    const dir = path.join(companyDir, projectId);
    // Defence in depth: the joined path must stay strictly inside the root even though both ids are validated.
    if (dir !== path.join(this.root, companyId, projectId) || !dir.startsWith(this.root + path.sep)) {
      throw new ProjectFileError("invalid_path", "Workspace path escapes the workspace root", 403);
    }

    for (const candidate of [this.root, companyDir, dir]) {
      const entry = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!entry) continue;
      if (entry.isSymbolicLink()) throw new ProjectFileError("invalid_path", "Symlink workspace is not allowed", 403);
    }

    // `isSymbolicLink()` is not enough on Windows: a directory junction is a reparse point that `lstat` may report
    // as an ordinary directory, and `rm -rf` through one is exactly how a "delete my project" turns into "delete
    // something else". Resolving the real path and comparing it against the expected path under the real root
    // catches links, junctions and mount points alike, whatever the platform calls them.
    const realRoot = await realpath(this.root).catch(() => undefined);
    if (realRoot) {
      const expected: Array<[string, string[]]> = [[companyDir, [companyId]], [dir, [companyId, projectId]]];
      for (const [candidate, parts] of expected) {
        const real = await realpath(candidate).catch(() => undefined);
        if (real && !samePath(real, path.join(realRoot, ...parts))) {
          throw new ProjectFileError("invalid_path", "Symlink workspace is not allowed", 403);
        }
      }
    }

    const before = await lstat(dir).catch(() => undefined);
    if (!before) {
      this.forgetWorkspaceState(companyId, projectId);
      return { removed: true, alreadyAbsent: true, path: dir };
    }
    if (!before.isDirectory()) {
      // A file where a workspace directory belongs is not ours to delete, and reporting success would be a lie.
      throw new ProjectFileError("invalid_path", "Workspace path is not a directory", 409);
    }

    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      return { removed: false, alreadyAbsent: false, path: dir, reason: error instanceof Error ? error.message : "workspace_removal_failed", outstanding: ["workspace"] };
    }

    const after = await lstat(dir).catch(() => undefined);
    if (after) {
      return { removed: false, alreadyAbsent: false, path: dir, reason: "workspace_removal_incomplete", outstanding: ["workspace"] };
    }

    // The per-company directory is pruned only when it is genuinely empty (`rmdir` refuses otherwise), so a shared
    // parent can never take another project's data with it.
    await rmdir(companyDir).catch(() => undefined);
    this.forgetWorkspaceState(companyId, projectId);
    return { removed: true, alreadyAbsent: false, path: dir };
  }

  /** Drop in-process bookkeeping for a project whose directory is gone, so no lock or worktree outlives it. */
  private forgetWorkspaceState(companyId: string, projectId: string): void {
    this.locks.delete(path.join(this.root, companyId, projectId));
    for (const key of Array.from(this.activeWorktrees.keys())) {
      if (key.startsWith(`${companyId}:${projectId}:`)) this.activeWorktrees.delete(key);
    }
  }
}
