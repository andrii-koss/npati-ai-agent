import type { AuthContext, ProjectInput, WorkspaceStore } from "@npati/workspace";

const projectTypes = new Set(["website", "web_app", "landing_page"]);

export class ProjectService {
  constructor(private readonly store: WorkspaceStore, private readonly beforeRemove?: (context: AuthContext, project: Awaited<ReturnType<WorkspaceStore["getProject"]>>) => Promise<void>) {}

  private async company(context: AuthContext, companyId: string) {
    return this.store.getCompany(context, companyId);
  }

  async create(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) {
    await this.company(context, companyId);
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 200) throw new Error("Project name must be between 1 and 200 characters");
    if (!projectTypes.has(input?.type)) throw new Error("Invalid project type");
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 5000)) {
      throw new Error("Project description must be at most 5000 characters");
    }
    return this.store.createProject(context, companyId, {
      name, type: input.type, description: input.description?.trim() || undefined,
    }, idempotencyKey);
  }

  async list(context: AuthContext, companyId: string, includeArchived = false) {
    await this.company(context, companyId);
    return this.store.listProjects(context, companyId, includeArchived);
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
}
