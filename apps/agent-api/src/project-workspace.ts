import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthContext, Project } from "@npati/workspace";

export interface ProjectWorkspaceInfo {
  companyId: string;
  projectId: string;
  workspaceId: string;
  logicalPath: string;
  currentBranch: string;
  activeSandboxId?: string;
  currentRevision: string;
}
export interface ProjectFileEntry { path: string; name: string; type: "file" | "directory"; size?: number; revision?: string; }
export interface ProjectFileContent { path: string; content: string; size: number; revision: string; }
export interface ProjectWorkspace {
  info(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string): Promise<ProjectWorkspaceInfo>;
  listFiles(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string): Promise<ProjectFileEntry[]>;
  getFileTree(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string): Promise<ProjectFileEntry[]>;
  searchFiles(ctx: AuthContext, companyId: string, projectId: string, query: string, workspaceId?: string): Promise<ProjectFileEntry[]>;
  readFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, workspaceId?: string): Promise<ProjectFileContent>;
  createFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, content: string, workspaceId?: string): Promise<ProjectFileContent>;
  writeFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, content: string, expectedRevision: string, workspaceId?: string): Promise<ProjectFileContent>;
  editFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, find: string, replacement: string, expectedRevision: string, workspaceId?: string): Promise<ProjectFileContent>;
  deleteFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, workspaceId?: string): Promise<void>;
  moveFile(ctx: AuthContext, companyId: string, projectId: string, from: string, to: string, expectedRevision: string, workspaceId?: string): Promise<ProjectFileContent>;
}
export class ProjectFileError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly currentRevision?: string) { super(message); }
}
export function safeProjectPath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) throw new ProjectFileError("invalid_path", "Invalid project file path");
  const parts = value.split("/");
  if (parts.length > 32 || parts.some((part) => !part || part === "." || part === ".." || part.includes(":") || /[<>|?*"\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new ProjectFileError("invalid_path", "Invalid project file path");
  if (parts.some((part) => /^(?:\.npati-.*|\.env(?:\..*)?|\.npmrc|\.netrc|\.git|\.aws|\.ssh|(?:credentials?|secrets?)(?:[._-].*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/i.test(part))) throw new ProjectFileError("secret_path", "Protected file path", 403);
  return parts.join("/");
}
const revision = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
const validId = (value: string) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const fileLimit = (value: number | undefined, fallback: number) => value && Number.isSafeInteger(value) && value > 0 ? value : fallback;

export class LocalProjectWorkspace implements ProjectWorkspace {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly root: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  constructor(private readonly projects: { get(ctx: AuthContext, companyId: string, projectId: string): Promise<Pick<Project, "id" | "companyId" | "workspaceId" | "status" | "repositoryBranch" | "sandboxId" | "revision">> }, options: { root: string; maxFileBytes?: number; maxFiles?: number }) {
    this.root = path.resolve(options.root);
    this.maxFileBytes = fileLimit(options.maxFileBytes, 1024 * 1024);
    this.maxFiles = fileLimit(options.maxFiles, 2000);
  }
  private async access(ctx: AuthContext, companyId: string, projectId: string, mode: "read" | "write", workspaceId?: string) {
    if (!validId(companyId) || !validId(projectId)) throw new ProjectFileError("invalid_project", "Invalid project identifier");
    const project = await this.projects.get(ctx, companyId, projectId);
    if (project.companyId !== companyId || project.id !== projectId || project.workspaceId !== ctx.workspaceId || (workspaceId !== undefined && workspaceId !== project.workspaceId)) throw new ProjectFileError("workspace_mismatch", "Project workspace access denied", 403);
    if (project.status === "archived" && mode === "write") throw new ProjectFileError("project_archived", "Archived project is read only", 409);
    const allowed = ctx.permissions.includes("*") || ctx.permissions.includes("owner") || ctx.permissions.includes("business:manage") || ctx.permissions.includes(mode === "read" ? "workspace:read" : "workspace:write");
    if (!allowed) throw new ProjectFileError("permission_denied", "Project file access denied", 403);
    const base = path.join(this.root, companyId, projectId);
    await mkdir(this.root, { recursive: true });
    for (const candidate of [this.root, path.join(this.root, companyId), base]) {
      await mkdir(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const entry = await lstat(candidate);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ProjectFileError("invalid_path", "Symlink workspace is not allowed");
    }
    return { project, base };
  }
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
    const started = Date.now();
    let acquired = false;
    try {
      while (!acquired) {
        try { await mkdir(lockDirectory); acquired = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (Date.now() - started > 10_000) throw new ProjectFileError("workspace_busy", "Project workspace is busy", 409);
          await delay(25);
        }
      }
      return await operation();
    } finally {
      try {
        if (acquired && path.resolve(lockDirectory).startsWith(path.resolve(key) + path.sep)) await rm(lockDirectory, { recursive: true, force: true });
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
        if (entry.isSymbolicLink() || entry.name.startsWith(".npati-")) continue;
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
  async info(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string) {
    const { project, base } = await this.access(ctx, companyId, projectId, "read", workspaceId);
    const entries = await this.tree(base);
    return { companyId, projectId, workspaceId: project.workspaceId, logicalPath: `/workspaces/${companyId}/${projectId}`, currentBranch: project.repositoryBranch ?? "main", activeSandboxId: project.sandboxId, currentRevision: revision(JSON.stringify(entries)) };
  }
  async getFileTree(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string) { const { base } = await this.access(ctx, companyId, projectId, "read", workspaceId); return this.tree(base); }
  async listFiles(ctx: AuthContext, companyId: string, projectId: string, workspaceId?: string) { return (await this.getFileTree(ctx, companyId, projectId, workspaceId)).filter((entry) => entry.type === "file"); }
  async searchFiles(ctx: AuthContext, companyId: string, projectId: string, query: string, workspaceId?: string) {
    if (typeof query !== "string" || !query.trim() || query.length > 200) throw new ProjectFileError("invalid_query", "Invalid file search query");
    return (await this.listFiles(ctx, companyId, projectId, workspaceId)).filter((entry) => entry.path.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 100);
  }
  async readFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, workspaceId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "read", workspaceId);
    const { clean, absolute } = await this.target(base, filePath);
    const bytes = await this.bytes(absolute);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})\b|\b(?:[A-Za-z0-9_]*(?:api[_-]?key|password|secret|token)[A-Za-z0-9_]*)["']?\s*[:=]\s*["'][^"']{8,}["']/i.test(bytes.toString("utf8"))) throw new ProjectFileError("secret_content", "Protected file content", 403);
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
  async createFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, content: string, workspaceId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId);
    return this.lock(base, async () => {
      const { clean, absolute } = await this.target(base, filePath);
      if (await lstat(absolute).then(() => true, () => false)) throw new ProjectFileError("file_exists", "Project file already exists", 409);
      if ((await this.listFiles(ctx, companyId, projectId, workspaceId)).length >= this.maxFiles) throw new ProjectFileError("file_limit", "Project file count limit exceeded", 409);
      const bytes = await this.save(absolute, content);
      return this.content(clean, bytes);
    });
  }
  async writeFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, content: string, expectedRevision: string, workspaceId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId);
    return this.lock(base, async () => {
      const { clean, absolute } = await this.target(base, filePath);
      const current = await this.bytes(absolute);
      if (!expectedRevision || expectedRevision !== revision(current)) throw new ProjectFileError("revision_conflict", "Project file revision changed", 409, revision(current));
      return this.content(clean, await this.save(absolute, content));
    });
  }
  async editFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, find: string, replacement: string, expectedRevision: string, workspaceId?: string) {
    if (typeof find !== "string" || !find || typeof replacement !== "string") throw new ProjectFileError("invalid_edit", "Find and replacement must be text");
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId);
    return this.lock(base, async () => {
      const { clean, absolute } = await this.target(base, filePath);
      const current = await this.bytes(absolute);
      if (!expectedRevision || expectedRevision !== revision(current)) throw new ProjectFileError("revision_conflict", "Project file revision changed", 409, revision(current));
      const source = current.toString("utf8");
      if (!source.includes(find)) throw new ProjectFileError("edit_not_found", "Find text not found", 409);
      return this.content(clean, await this.save(absolute, source.replace(find, replacement)));
    });
  }
  async moveFile(ctx: AuthContext, companyId: string, projectId: string, from: string, to: string, expectedRevision: string, workspaceId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId);
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
  async deleteFile(ctx: AuthContext, companyId: string, projectId: string, filePath: string, workspaceId?: string) {
    const { base } = await this.access(ctx, companyId, projectId, "write", workspaceId);
    await this.lock(base, async () => { const { absolute } = await this.target(base, filePath); await this.bytes(absolute); await rm(absolute); });
  }
}





