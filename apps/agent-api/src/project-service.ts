import { PROJECT_KINDS, PROJECT_TYPES, type AuthContext, type ProjectCodeSettings, type ProjectInput, type ProjectStatus, type WorkspaceStore } from "@npati/workspace";
import { defaultAppScheme, isValidAppScheme } from "@npati/shared";

const projectTypes = new Set<string>(PROJECT_TYPES);

export class ProjectService {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly beforeRemove?: (context: AuthContext, project: Awaited<ReturnType<WorkspaceStore["getProject"]>>) => Promise<void>,
    /**
     * Legacy explicit opt-in attachment hook. The default creation path leaves the
     * Project without a database; coding sessions can provision one through Data Studio.
     */
    private readonly attachDataBackend?: (context: AuthContext, companyId: string, projectId: string) => Promise<string | undefined>,
  ) {}

  private async company(context: AuthContext, companyId: string) {
    return this.store.getCompany(context, companyId);
  }

  async create(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string, options: { attachDataBackend?: boolean } = {}) {
    await this.company(context, companyId);
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 200) throw new Error("Project name must be between 1 and 200 characters");
    if (!projectTypes.has(input?.type)) throw new Error("Invalid project type");
    if (input.kind !== undefined && !PROJECT_KINDS.includes(input.kind)) throw new Error("Invalid project kind");
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 5000)) {
      throw new Error("Project description must be at most 5000 characters");
    }
    // Mobile projects carry their deep link scheme (D6); an explicit scheme must be valid.
    let appScheme: string | undefined;
    if (input.type === "mobile_app") {
      if (input.appScheme !== undefined && !isValidAppScheme(String(input.appScheme))) throw new Error("Invalid app scheme");
      appScheme = input.appScheme ? String(input.appScheme) : defaultAppScheme(name);
    } else if (input.appScheme !== undefined) {
      throw new Error("App scheme is only supported for mobile_app projects");
    }
    const created = await this.store.createProject(context, companyId, {
      name, type: input.type, kind: input.kind, description: input.description?.trim() || undefined,
      dataBackendId: input.dataBackendId, appScheme,
      toolchain: input.toolchain, defaultBranch: input.defaultBranch,
      dataClassification: input.dataClassification, retentionClass: input.retentionClass,
    }, idempotencyKey);
    // Provisioning is opt-in. Creating a website alone never creates a database.
    if (!created.project.dataBackendId && this.attachDataBackend && options.attachDataBackend === true) {
      const attached = await this.attachDataBackend(context, companyId, created.project.id).catch(() => undefined);
      if (attached) {
        const project = await this.store.getProject(context, companyId, created.project.id).catch(() => created.project);
        return { ...created, project };
      }
    }
    return created;
  }

  async list(context: AuthContext, companyId: string, includeArchived = false) {
    await this.company(context, companyId);
    return this.store.listProjects(context, companyId, includeArchived);
  }

  async catalog(context: AuthContext, input: import("@npati/workspace").ProjectCatalogInput) {
    return this.store.listProjectCatalog(context, input);
  }

  async get(context: AuthContext, companyId: string, projectId: string) {
    await this.company(context, companyId);
    return this.store.getProject(context, companyId, projectId);
  }

  async rename(context: AuthContext, companyId: string, projectId: string, name: string, expectedRevision: number) {
    await this.get(context, companyId, projectId);
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean || clean.length > 200) throw new Error("Project name must be between 1 and 200 characters");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Invalid expectedRevision");
    return this.store.updateProject(context, companyId, projectId, { name: clean, expectedRevision });
  }

  /**
   * C1: persists code-specific project metadata (toolchain, default branch, classification,
   * retention). Permission checks live in CodeService; this is the store-facing write path shared by
   * detection and user edits.
   */
  async updateCodeSettings(context: AuthContext, companyId: string, projectId: string, expectedRevision: number, code: ProjectCodeSettings) {
    await this.get(context, companyId, projectId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Invalid expectedRevision");
    return this.store.updateProject(context, companyId, projectId, { expectedRevision, code });
  }

  async archive(context: AuthContext, companyId: string, projectId: string, expectedRevision: number) {
    const project = await this.get(context, companyId, projectId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("Invalid expectedRevision");
    if (project.revision !== expectedRevision) throw new Error("Project changed by another request");
    if (this.beforeRemove) await this.beforeRemove(context, project);
    const current = this.beforeRemove ? await this.get(context, companyId, projectId) : project;
    if (current.revision !== expectedRevision + (project.sandboxId ? 1 : 0)) throw new Error("Project changed by another request");
    return this.store.archiveProject(context, companyId, projectId, current.revision);
  }

  async delete(context: AuthContext, companyId: string, projectId: string) {
    const project = await this.get(context, companyId, projectId);
    if (this.beforeRemove) await this.beforeRemove(context, project);
    return this.store.deleteProject(context, companyId, projectId);
  }

  async updatePreview(context: AuthContext, companyId: string, projectId: string, patch: {
    status?: ProjectStatus;
    previewUrl?: string | null;
    previewPort?: number | null;
    framework?: string | null;
    runtime?: string | null;
    lastBuildStatus?: string | null;
  }) {
    await this.get(context, companyId, projectId);
    return this.store.updateProjectPreview(context, companyId, projectId, patch);
  }
}
