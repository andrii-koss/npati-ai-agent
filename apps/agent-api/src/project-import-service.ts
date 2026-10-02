import { randomUUID } from "node:crypto";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import { safeProjectPath } from "./project-workspace";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { ProjectPreviewService } from "./project-preview-service";
import type { ProjectGitService } from "./project-git-service";
import { detectProjectStack } from "./project-preview-service";
import { extractProjectZip, ProjectImportError, type ImportedTextFile } from "./project-import-zip";
import { redactTerminalText } from "./terminal-command-policy";

export interface ProjectImportResult {
  projectId: string;
  runId: string;
  source: "repository" | "zip";
  fileCount: number;
  framework: string;
  packageManager: string;
  devCommand: string;
  previewUrl: string;
}

export interface ProjectImportLimits {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  cloneTimeoutMs: number;
}

export const defaultProjectImportLimits: ProjectImportLimits = {
  maxFiles: 500,
  maxBytes: 20 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  cloneTimeoutMs: 120_000,
};

export class ProjectImportService {
  private readonly limits: ProjectImportLimits;
  constructor(
    private readonly store: WorkspaceStore,
    private readonly projects: Pick<ProjectService, "get">,
    private readonly workspace: ProjectWorkspace,
    private readonly sandbox: ProjectSandboxService | undefined,
    private readonly preview: Pick<ProjectPreviewService, "startPreview">,
    private readonly git: Pick<ProjectGitService, "connectRepository">,
    private readonly credentials?: { resolve(ctx: AuthContext, companyId: string, id: string): Promise<Record<string, string>> },
    limits: Partial<ProjectImportLimits> = {},
  ) {
    this.limits = { ...defaultProjectImportLimits, ...limits };
  }

  private async authorize(ctx: AuthContext, companyId: string, projectId: string) {
    if (!ctx.permissions.some((permission) => ["*", "owner", "business:manage", "workspace:write"].includes(permission))) {
      throw new ProjectImportError("project_import_denied", "Project import permission denied", 403);
    }
    const project = await this.projects.get(ctx, companyId, projectId);
    if (project.companyId !== companyId || project.workspaceId !== ctx.workspaceId || project.status === "archived") {
      throw new ProjectImportError("project_import_denied", "Project import is not available", 403);
    }
    if ((await this.workspace.listFiles(ctx, companyId, projectId)).length > 0) {
      throw new ProjectImportError("project_not_empty", "Import requires an empty Project workspace", 409);
    }
    if (!this.sandbox) throw new ProjectImportError("sandbox_unavailable", "Sandbox runner is required for project import", 503);
    return project;
  }

  private validateFiles(files: ImportedTextFile[]): ImportedTextFile[] {
    let total = 0;
    const seen = new Set<string>();
    if (files.length === 0 || files.length > this.limits.maxFiles) {
      throw new ProjectImportError("repository_too_large", "Project file count exceeds the import limit", 413);
    }
    for (const file of files) {
      let safe: string;
      try { safe = safeProjectPath(file.path); }
      catch { throw new ProjectImportError("unsafe_project_path", "Project contains a protected or unsafe path"); }
      if (file.content.includes("\0") || redactTerminalText(file.content) !== file.content) {
        throw new ProjectImportError("secret_content", "Project contains protected or non-text content", 403);
      }
      const bytes = Buffer.byteLength(file.content, "utf8");
      total += bytes;
      if (seen.has(safe.toLowerCase()) || bytes > this.limits.maxFileBytes || total > this.limits.maxBytes) {
        throw new ProjectImportError("repository_too_large", "Project files exceed the import limit", 413);
      }
      seen.add(safe.toLowerCase());
    }
    return files;
  }

  async importRepository(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { url: string; branch?: string; credentialId?: string },
  ): Promise<ProjectImportResult> {
    await this.authorize(ctx, companyId, projectId);
    const connected = await this.git.connectRepository(ctx, companyId, projectId, { url: input.url, branch: input.branch });
    let token: string | undefined;
    if (input.credentialId) {
      if (!this.credentials) throw new ProjectImportError("credential_store_unavailable", "Company vault is unavailable", 503);
      const fields = await this.credentials.resolve(ctx, companyId, input.credentialId);
      token = fields.token;
      if (!token) throw new ProjectImportError("credential_missing", "GitHub credential has no token field", 400);
    }
    return this.executeImport(ctx, companyId, projectId, "repository", async () => {
      const files = await this.sandbox!.cloneRepository(ctx, companyId, projectId, {
        url: connected.repositoryUrl!,
        branch: connected.repositoryBranch || "main",
        token,
        timeoutMs: this.limits.cloneTimeoutMs,
      });
      return files.map(({ path, content }) => ({ path, content }));
    }, connected.repositoryUrl);
  }

  async importZip(ctx: AuthContext, companyId: string, projectId: string, archive: Buffer): Promise<ProjectImportResult> {
    await this.authorize(ctx, companyId, projectId);
    const files = extractProjectZip(archive, {
      maxFiles: this.limits.maxFiles,
      maxExpandedBytes: this.limits.maxBytes,
      maxFileBytes: this.limits.maxFileBytes,
    });
    return this.executeImport(ctx, companyId, projectId, "zip", async () => files);
  }

  private async executeImport(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    source: "repository" | "zip",
    loadFiles: () => Promise<ImportedTextFile[]>,
    repositoryUrl?: string,
  ): Promise<ProjectImportResult> {
    const { run } = await this.store.createCompanyAgentRun(ctx, companyId, {
      task: source === "zip" ? "Import project ZIP" : "Import connected repository",
      requestedMode: "single",
      projectId,
    }, `project-import-${randomUUID()}`);
    try {
      const files = this.validateFiles(await loadFiles());
      for (const file of files) await this.workspace.createFile(ctx, companyId, projectId, file.path, file.content);
      const detected = await detectProjectStack(await this.workspace.listFiles(ctx, companyId, projectId),
        async (filePath) => (await this.workspace.readFile(ctx, companyId, projectId, filePath)).content);
      if (!files.some((file) => file.path === "PROJECT.md")) {
        const context = [
          `# ${(await this.projects.get(ctx, companyId, projectId)).name}`,
          "",
          `- Source: ${source === "zip" ? "Uploaded ZIP" : "Connected GitHub repository"}`,
          ...(repositoryUrl ? [`- Repository: ${repositoryUrl}`] : []),
          `- Framework: ${detected.framework}`,
          `- Package manager: ${detected.packageManager}`,
          `- Development command: ${detected.command}`,
          "",
          "Inspect the imported source before changing files.",
          "",
        ].join("\n");
        await this.workspace.createFile(ctx, companyId, projectId, "PROJECT.md", context);
      }
      await this.workspace.setBaseline(ctx, companyId, projectId);
      await this.store.updateProjectPreview(ctx, companyId, projectId, { status: "building", framework: detected.framework });
      if (files.some((file) => file.path === "package.json")) {
        const names = new Set(files.map((file) => file.path));
        const install = detected.packageManager === "npm"
          ? names.has("package-lock.json") ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund"
          : detected.packageManager === "pnpm" ? "pnpm install --frozen-lockfile"
          : detected.packageManager === "yarn" ? "yarn install --frozen-lockfile"
          : "bun install --frozen-lockfile";
        await this.sandbox!.execute(ctx, companyId, {
          projectId, agentId: "system", command: install, approved: true, runId: run.id,
        });
      }
      const started = await this.preview.startPreview(ctx, companyId, projectId);
      await this.store.updateCompanyAgentRun(ctx, companyId, run.id, {
        status: "completed", executionMode: "single", result: "Project imported and live preview started.",
      });
      return {
        projectId, runId: run.id, source, fileCount: files.length,
        framework: detected.framework, packageManager: detected.packageManager,
        devCommand: detected.command, previewUrl: started.previewUrl,
      };
    } catch (error) {
      await this.store.updateProjectPreview(ctx, companyId, projectId, { status: "failed", lastBuildStatus: "failed" }).catch(() => undefined);
      await this.store.updateCompanyAgentRun(ctx, companyId, run.id, {
        status: "failed",
        errorCode: error instanceof ProjectImportError ? error.code : "project_import_failed",
        errorMessage: "Project import failed; inspect the structured import error.",
      }).catch(() => undefined);
      throw error;
    }
  }
}
