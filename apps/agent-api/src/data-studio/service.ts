import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { DataStudioError } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataProvider } from "./data-provider";
import type { DataBackend, DataEnvironmentName, DataProviderKind } from "./types";

export class DataBackendService {
  constructor(
    private readonly store: Pick<WorkspaceStore, "getCompany" | "getProject">,
    private readonly repository: DataBackendRepository,
    private readonly provisioner?: DatabaseProvisioner,
    private readonly dataProvider?: DataProvider,
  ) {}

  private available(): DatabaseProvisioner {
    if (!this.provisioner) throw new DataStudioError(503, "provision", "Project database service unavailable", true, "PROJECT_DATABASE_UNAVAILABLE");
    return this.provisioner;
  }

  async create(ctx: AuthContext, companyId: string, input: { name: string; provider?: DataProviderKind; connectionString?: string }): Promise<DataBackend> {
    await this.store.getCompany(ctx, companyId);
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 200) throw new DataStudioError(400, "create_backend", "Name must be 1-200 characters", false, "INVALID_NAME");
    const provider = input.provider ?? "shared_postgres";
    if (!["shared_postgres", "external_postgres"].includes(provider)) {
      throw new DataStudioError(400, "create_backend", "Unsupported provider", false, "UNSUPPORTED_PROVIDER");
    }
    if (provider === "external_postgres" && !/^postgres(?:ql)?:\/\//i.test(input.connectionString ?? "")) {
      throw new DataStudioError(400, "create_backend", "An external backend needs a postgres:// connection string", false, "INVALID_CONNECTION_STRING");
    }
    const provisioner = this.available();
    const backend = await this.repository.create(ctx, companyId, name, provider);
    try {
      for (const environment of ["dev", "prod"] as const) {
        if (provider === "external_postgres") {
          // The owner connection string never leaves Core secret storage; only a reference is kept.
          await this.repository.putSecret(ctx, companyId, backend.id, environment, "external_owner", input.connectionString!);
        }
        await provisioner.provisionDatabase(backend, environment);
        if (this.dataProvider) {
          const schema = await this.dataProvider.introspectSchema(backend, environment);
          await this.repository.setExpectedSchema(ctx, companyId, backend.id, environment, schema, this.dataProvider.schemaFingerprint(schema));
        }
      }
      await this.repository.setStatus(ctx, companyId, backend.id, "ready");
      return this.repository.get(ctx, companyId, backend.id);
    } catch (error) {
      await this.repository.setStatus(ctx, companyId, backend.id, "unavailable").catch(() => undefined);
      if (error instanceof DataStudioError) throw error;
      throw new DataStudioError(503, "provision", "Project database provisioning failed", true, "PROJECT_DATABASE_UNAVAILABLE");
    }
  }

  async activate(ctx: AuthContext, companyId: string, id: string) {
    await this.store.getCompany(ctx, companyId);
    const backend = await this.repository.get(ctx, companyId, id);
    if (backend.status === "deleting") throw new DataStudioError(409, "activate_backend", "Backend is being deleted", false, "BACKEND_INACTIVE");
    const provisioner = this.available();
    for (const environment of ["dev", "prod"] as const) {
      const current = await this.repository.environment(ctx, companyId, id, environment);
      if (current.status === "ready") {
        // D7: an archived backend only had its runtime role suspended, the database still exists.
        await provisioner.resumeRuntime(backend, environment).catch(() => undefined);
        await this.repository.setEnvironment(ctx, companyId, id, environment, { status: "ready" });
        continue;
      }
      if (current.status === "archived") {
        await provisioner.resumeRuntime(backend, environment).catch(() => undefined);
        await this.repository.setEnvironment(ctx, companyId, id, environment, { status: "ready" });
        continue;
      }
      await provisioner.provisionDatabase(backend, environment);
      if (this.dataProvider) {
        const schema = await this.dataProvider.introspectSchema(backend, environment);
        await this.repository.setExpectedSchema(ctx, companyId, id, environment, schema, this.dataProvider.schemaFingerprint(schema));
      }
    }
    await this.repository.setStatus(ctx, companyId, id, "ready");
    return this.repository.get(ctx, companyId, id);
  }
  /**
   * Hands an existing DataBackend over to another company of the same workspace. The databases and
   * their rows stay where they are (only Core metadata changes ownership), so the owner can delete
   * the old company and attach the transferred database to the new company's projects. Projects of
   * the previous company are detached, because a Project cannot move between companies.
   */
  async transfer(ctx: AuthContext, companyId: string, id: string, input: { targetCompanyId?: string; confirmName?: string }) {
    const backend = await this.repository.get(ctx, companyId, id);
    const targetCompanyId = typeof input?.targetCompanyId === "string" ? input.targetCompanyId.trim() : "";
    if (!targetCompanyId) throw new DataStudioError(400, "transfer", "A target company is required", false, "INVALID_TARGET_COMPANY");
    if (targetCompanyId === companyId) throw new DataStudioError(400, "transfer", "The target company must be different from the current one", false, "INVALID_TARGET_COMPANY");
    if (input?.confirmName !== backend.name) {
      throw new DataStudioError(409, "transfer", "Type the DataBackend name to confirm the transfer", false, "CONFIRMATION_REQUIRED");
    }
    const target = await this.store.getCompany(ctx, targetCompanyId);
    if (target.userId !== ctx.userId) {
      throw new DataStudioError(403, "transfer", "The target company belongs to another user", false, "TARGET_COMPANY_NOT_OWNED");
    }
    const result = await this.repository.transferToCompany(ctx.workspaceId, companyId, targetCompanyId, id, ctx.userId);
    if (!result.moved) throw new DataStudioError(404, "transfer", "DataBackend not found", false, "DATA_BACKEND_NOT_FOUND");
    return {
      transferred: true,
      backendId: id,
      backendName: backend.name,
      targetCompanyId,
      targetCompanyName: target.name,
      detachedProjects: result.detachedProjects,
      environments: result.environments,
    };
  }

  async list(ctx: AuthContext, companyId: string) {
    await this.store.getCompany(ctx, companyId);
    return this.repository.list(ctx, companyId);
  }

  async get(ctx: AuthContext, companyId: string, id: string) {
    await this.store.getCompany(ctx, companyId);
    const backend = await this.repository.get(ctx, companyId, id);
    const environments = await this.repository.environments(ctx, companyId, id);
    return { backend, environments: environments.map(({ migratorSecretRef: _m, runtimeSecretRef: _r, signingKeyRef: _s, ...safe }) => safe) };
  }

  async rename(ctx: AuthContext, companyId: string, id: string, name: string) {
    await this.store.getCompany(ctx, companyId);
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean || clean.length > 200) throw new DataStudioError(400, "update_backend", "Name must be 1-200 characters", false, "INVALID_NAME");
    return this.repository.rename(ctx, companyId, id, clean);
  }

  async archive(ctx: AuthContext, companyId: string, id: string) {
    await this.store.getCompany(ctx, companyId);
    const backend = await this.repository.get(ctx, companyId, id);
    if (backend.status === "deleting") throw new DataStudioError(409, "archive_backend", "Backend is being deleted", false, "BACKEND_INACTIVE");
    if (backend.status === "archived") return backend;
    const provisioner = this.available();
    for (const environment of ["dev", "prod"] as const) {
      const current = await this.repository.environment(ctx, companyId, id, environment);
      if (current.status === "ready") await provisioner.suspendRuntime(backend, environment);
    }
    await this.repository.setStatus(ctx, companyId, id, "archived");
    for (const environment of ["dev", "prod"] as const) {
      await this.repository.setEnvironment(ctx, companyId, id, environment, { status: "archived" });
    }
    return this.repository.get(ctx, companyId, id);
  }

  /** D7: quota overrides for one environment (values are validated by QuotaService). */
  async setEnvironmentLimits(
    ctx: AuthContext,
    companyId: string,
    backendId: string,
    environment: DataEnvironmentName,
    limits: Record<string, number>,
  ): Promise<Record<string, number>> {
    await this.store.getCompany(ctx, companyId);
    await this.repository.get(ctx, companyId, backendId);
    await this.repository.setEnvironment(ctx, companyId, backendId, environment, { limits });
    const updated = await this.repository.environment(ctx, companyId, backendId, environment);
    return updated.limits ?? {};
  }

  async attach(ctx: AuthContext, companyId: string, projectId: string, backendId: string | null) {    await this.store.getProject(ctx, companyId, projectId);
    if (backendId) await this.repository.get(ctx, companyId, backendId);
    const dataBackendId = await this.repository.attach(ctx, companyId, projectId, backendId);
    return { projectId, dataBackendId };
  }

  /**
   * D7 two-phase removal. The backend is detached from every project first; its databases, roles,
   * keys and secrets are then purged only after the configured snapshot retention window, so a
   * mistaken removal is still recoverable. `immediate` skips the wait (used by tooling and tests).
   */
  async remove(ctx: AuthContext, companyId: string, id: string, confirmation: string, options: { immediate?: boolean } = {}) {
    await this.store.getCompany(ctx, companyId);
    const backend = await this.repository.get(ctx, companyId, id);
    if (confirmation !== backend.name) throw new DataStudioError(400, "delete_backend", "Confirmation name does not match", false, "CONFIRMATION_REQUIRED");
    const provisioner = this.available();
    await this.repository.beginRemoval(ctx, companyId, id);
    for (const environment of ["dev", "prod"] as const) {
      const env = await this.repository.environment(ctx, companyId, id, environment).catch(() => null);
      if (env && (env.status === "ready" || env.status === "archived")) {
        await provisioner.snapshot(backend, environment).catch(() => undefined);
        if (options.immediate) {
          await provisioner.deprovisionDatabase(backend, environment);
          await this.repository.setEnvironment(ctx, companyId, id, environment, { status: "unavailable" });
        } else {
          await provisioner.suspendRuntime(backend, environment).catch(() => undefined);
        }
      }
    }
    if (options.immediate) {
      await this.repository.deleteSecrets(id).catch(() => undefined);
      await this.repository.remove(ctx, companyId, id);
      return { id, deleted: true, deferred: false };
    }
    const retentionDays = Math.max(1, Number(process.env.NPATI_PROJECTS_SNAPSHOT_RETENTION_DAYS) || 30);
    const removeAfter = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
    await this.repository.setRemovalDeadline(ctx, companyId, id, removeAfter);
    return { id, deleted: false, deferred: true, removeAfter: removeAfter.toISOString(), retentionDays };
  }

  /**
   * D7 cleanup when a Project disappears: the DataBackend stays, but everything bound to that
   * project is removed — its CORS origins, its API request logs and its auth redirect URLs.
   */
  async detachProjectArtifacts(ctx: AuthContext, companyId: string, projectId: string): Promise<{ detached: boolean; cleanedOrigins: number; cleanedRedirects: number }> {
    const project = await this.store.getProject(ctx, companyId, projectId).catch(() => null);
    const backendId = project?.dataBackendId;
    if (!backendId) return { detached: false, cleanedOrigins: 0, cleanedRedirects: 0 };
    let cleanedOrigins = 0;
    for (const environment of ["dev", "prod"] as const) {
      const env = await this.repository.environment(ctx, companyId, backendId, environment).catch(() => null);
      if (!env) continue;
      const byProject = (env.providerConfig?.corsOriginsByProject ?? {}) as Record<string, string[]>;
      if (!(projectId in byProject)) continue;
      const next = { ...byProject };
      delete next[projectId];
      await this.repository.setEnvironment(ctx, companyId, backendId, environment, {
        providerConfig: { ...env.providerConfig, corsOriginsByProject: next },
      }).catch(() => undefined);
      cleanedOrigins += 1;
    }
    const redirects = await this.repository.pool.query("DELETE FROM project_redirect_urls WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3",
      [ctx.workspaceId, companyId, projectId]).catch(() => null);
    await this.repository.pool.query("DELETE FROM project_api_request_logs WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3",
      [ctx.workspaceId, companyId, projectId]).catch(() => undefined);
    await this.repository.attach(ctx, companyId, projectId, null).catch(() => undefined);
    return { detached: true, cleanedOrigins, cleanedRedirects: redirects?.rowCount ?? 0 };
  }
}
