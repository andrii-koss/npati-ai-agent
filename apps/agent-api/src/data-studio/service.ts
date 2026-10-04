import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { DataStudioError } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataProvider } from "./data-provider";
import type { DataBackend, DataProviderKind } from "./types";

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

  async create(ctx: AuthContext, companyId: string, input: { name: string; provider?: DataProviderKind }): Promise<DataBackend> {
    await this.store.getCompany(ctx, companyId);
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 200) throw new DataStudioError(400, "create_backend", "Name must be 1-200 characters", false, "INVALID_NAME");
    const provider = input.provider ?? "shared_postgres";
    if (provider !== "shared_postgres") throw new DataStudioError(400, "create_backend", "Provider is not available in D1", false, "UNSUPPORTED_PROVIDER");
    const provisioner = this.available();
    const backend = await this.repository.create(ctx, companyId, name, provider);
    try {
      for (const environment of ["dev", "prod"] as const) {
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
    if (backend.status === "archived" || backend.status === "deleting") throw new DataStudioError(409, "activate_backend", "Backend cannot be activated", false, "BACKEND_INACTIVE");
    const provisioner = this.available();
    for (const environment of ["dev", "prod"] as const) {
      const current = await this.repository.environment(ctx, companyId, id, environment);
      if (current.status === "ready") continue;
      await provisioner.provisionDatabase(backend, environment);
      if (this.dataProvider) {
        const schema = await this.dataProvider.introspectSchema(backend, environment);
        await this.repository.setExpectedSchema(ctx, companyId, id, environment, schema, this.dataProvider.schemaFingerprint(schema));
      }
    }
    await this.repository.setStatus(ctx, companyId, id, "ready");
    return this.repository.get(ctx, companyId, id);
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

  async attach(ctx: AuthContext, companyId: string, projectId: string, backendId: string | null) {
    await this.store.getProject(ctx, companyId, projectId);
    if (backendId) await this.repository.get(ctx, companyId, backendId);
    const dataBackendId = await this.repository.attach(ctx, companyId, projectId, backendId);
    return { projectId, dataBackendId };
  }

  async remove(ctx: AuthContext, companyId: string, id: string, confirmation: string) {
    await this.store.getCompany(ctx, companyId);
    const backend = await this.repository.get(ctx, companyId, id);
    if (confirmation !== backend.name) throw new DataStudioError(400, "delete_backend", "Confirmation name does not match", false, "CONFIRMATION_REQUIRED");
    const provisioner = this.available();
    await this.repository.beginRemoval(ctx, companyId, id);
    for (const environment of ["dev", "prod"] as const) {
      const env = await this.repository.environment(ctx, companyId, id, environment);
      if (env.status === "ready" || env.status === "archived") {
        await provisioner.snapshot(backend, environment);
        await provisioner.deprovisionDatabase(backend, environment);
        await this.repository.setEnvironment(ctx, companyId, id, environment, { status: "unavailable" });
      }
    }
    await this.repository.remove(ctx, companyId, id);
    return { id, deleted: true };
  }
}
