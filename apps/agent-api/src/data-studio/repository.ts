import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { DataStudioError } from "./identifier";
import type { DataBackend, DataBackendEnvironment, DataEnvironmentName, DataProviderKind } from "./types";

const backendColumns = 'id, workspace_id AS "workspaceId", company_id AS "companyId", created_by AS "createdBy", name, provider, status, created_at::text AS "createdAt", updated_at::text AS "updatedAt"';
const environmentColumns = 'id, workspace_id AS "workspaceId", company_id AS "companyId", backend_id AS "backendId", environment, provider_config AS "providerConfig", migrator_secret_ref AS "migratorSecretRef", runtime_secret_ref AS "runtimeSecretRef", signing_key_ref AS "signingKeyRef", status, schema_fingerprint AS "schemaFingerprint", sync_status AS "syncStatus", created_at::text AS "createdAt", updated_at::text AS "updatedAt"';

export class DataBackendRepository {
  readonly pool: Pool;
  private readonly vault = new CryptoVault();

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  async create(ctx: AuthContext, companyId: string, name: string, provider: DataProviderKind): Promise<DataBackend> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DataBackend>(
        "INSERT INTO data_backends(id,workspace_id,company_id,created_by,name,provider) " +
        "SELECT $1,$2,$3,$4,$5,$6 FROM companies WHERE id=$3 AND workspace_id=$2 AND user_id=$4 " +
        "RETURNING " + backendColumns,
        [id, ctx.workspaceId, companyId, ctx.userId, name, provider],
      );
      if (!result.rowCount) throw new DataStudioError(404, "create_backend", "Company not found", false, "COMPANY_NOT_FOUND");
      for (const environment of ["dev", "prod"] as const) {
        await client.query(
          "INSERT INTO data_backend_environments(id,workspace_id,company_id,backend_id,environment) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), ctx.workspaceId, companyId, id, environment],
        );
      }
      await client.query("COMMIT");
      return result.rows[0]!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async list(ctx: AuthContext, companyId: string): Promise<DataBackend[]> {
    const result = await this.pool.query<DataBackend>(
      "SELECT " + backendColumns + " FROM data_backends WHERE workspace_id=$1 AND company_id=$2 AND created_by=$3 ORDER BY updated_at DESC,id",
      [ctx.workspaceId, companyId, ctx.userId],
    );
    return result.rows;
  }

  async get(ctx: AuthContext, companyId: string, id: string): Promise<DataBackend> {
    const result = await this.pool.query<DataBackend>(
      "SELECT " + backendColumns + " FROM data_backends WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4",
      [id, ctx.workspaceId, companyId, ctx.userId],
    );
    if (!result.rowCount) throw new DataStudioError(404, "get_backend", "Data backend not found", false, "BACKEND_NOT_FOUND");
    return result.rows[0]!;
  }

  async environments(ctx: AuthContext, companyId: string, id: string): Promise<DataBackendEnvironment[]> {
    await this.get(ctx, companyId, id);
    const result = await this.pool.query<DataBackendEnvironment>(
      "SELECT " + environmentColumns + " FROM data_backend_environments WHERE backend_id=$1 AND workspace_id=$2 AND company_id=$3 ORDER BY environment",
      [id, ctx.workspaceId, companyId],
    );
    return result.rows;
  }

  async environment(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName): Promise<DataBackendEnvironment> {
    const rows = await this.environments(ctx, companyId, id);
    const found = rows.find((row) => row.environment === environment);
    if (!found) throw new DataStudioError(404, "get_environment", "Environment not found", false, "ENVIRONMENT_NOT_FOUND");
    return found;
  }

  async rename(ctx: AuthContext, companyId: string, id: string, name: string): Promise<DataBackend> {
    const result = await this.pool.query<DataBackend>(
      "UPDATE data_backends SET name=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3 AND company_id=$4 AND created_by=$5 AND status<>'archived' RETURNING " + backendColumns,
      [name, id, ctx.workspaceId, companyId, ctx.userId],
    );
    if (!result.rowCount) throw new DataStudioError(404, "update_backend", "Data backend not found", false, "BACKEND_NOT_FOUND");
    return result.rows[0]!;
  }

  async setStatus(ctx: AuthContext, companyId: string, id: string, status: DataBackend["status"]): Promise<void> {
    const result = await this.pool.query(
      "UPDATE data_backends SET status=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3 AND company_id=$4 AND created_by=$5",
      [status, id, ctx.workspaceId, companyId, ctx.userId],
    );
    if (!result.rowCount) throw new DataStudioError(404, "backend_status", "Data backend not found", false, "BACKEND_NOT_FOUND");
  }

  async setEnvironment(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName, patch: {
    status?: DataBackendEnvironment["status"]; providerConfig?: Record<string, unknown>;
    migratorSecretRef?: string; runtimeSecretRef?: string; schemaFingerprint?: string; syncStatus?: DataBackendEnvironment["syncStatus"];
  }): Promise<void> {
    await this.get(ctx, companyId, id);
    await this.pool.query(
      "UPDATE data_backend_environments SET status=COALESCE($1,status),provider_config=COALESCE($2::jsonb,provider_config)," +
      "migrator_secret_ref=COALESCE($3,migrator_secret_ref),runtime_secret_ref=COALESCE($4,runtime_secret_ref)," +
      "schema_fingerprint=COALESCE($5,schema_fingerprint),sync_status=COALESCE($6,sync_status),updated_at=now() " +
      "WHERE backend_id=$7 AND environment=$8 AND workspace_id=$9 AND company_id=$10",
      [patch.status ?? null, patch.providerConfig ? JSON.stringify(patch.providerConfig) : null, patch.migratorSecretRef ?? null,
        patch.runtimeSecretRef ?? null, patch.schemaFingerprint ?? null, patch.syncStatus ?? null,
        id, environment, ctx.workspaceId, companyId],
    );
  }

  async putSecret(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName, role: "migrator" | "runtime" | "signing", value: string): Promise<string> {
    await this.get(ctx, companyId, id);
    const ref = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      "INSERT INTO data_backend_secrets(id,backend_id,environment,role,encrypted_value) VALUES($1,$2,$3,$4,$5) " +
      "ON CONFLICT(backend_id,environment,role) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value " +
      "RETURNING id",
      [ref, id, environment, role, this.vault.encrypt(value)],
    );
    return result.rows[0]!.id;
  }

  async resolveSecret(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName, role: "migrator" | "runtime" | "signing"): Promise<string> {
    await this.get(ctx, companyId, id);
    const result = await this.pool.query<{ encryptedValue: string }>(
      'SELECT encrypted_value AS "encryptedValue" FROM data_backend_secrets WHERE backend_id=$1 AND environment=$2 AND role=$3',
      [id, environment, role],
    );
    if (!result.rowCount) throw new DataStudioError(404, "resolve_secret", "Database secret not found", false, "SECRET_NOT_FOUND");
    return this.vault.decrypt(result.rows[0]!.encryptedValue);
  }

  async attach(ctx: AuthContext, companyId: string, projectId: string, backendId: string | null): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (backendId) {
        const backend = await client.query(
          "SELECT id FROM data_backends WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status='ready' FOR UPDATE",
          [backendId, ctx.workspaceId, companyId, ctx.userId],
        );
        if (!backend.rowCount) throw new DataStudioError(404, "attach_project", "Available backend not found", false, "ATTACH_NOT_FOUND");
      }
      const result = await client.query<{ dataBackendId: string | null }>(
        'UPDATE projects SET data_backend_id=$1,revision=revision+1,updated_at=now() ' +
        'WHERE id=$2 AND workspace_id=$3 AND company_id=$4 AND created_by=$5 AND status<>\'archived\' ' +
        'RETURNING data_backend_id AS "dataBackendId"',
        [backendId, projectId, ctx.workspaceId, companyId, ctx.userId],
      );
      if (!result.rowCount) throw new DataStudioError(404, "attach_project", "Project not found", false, "ATTACH_NOT_FOUND");
      await client.query("COMMIT");
      return result.rows[0]!.dataBackendId;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async beginRemoval(ctx: AuthContext, companyId: string, id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const backend = await client.query(
        "SELECT id FROM data_backends WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 FOR UPDATE",
        [id, ctx.workspaceId, companyId, ctx.userId],
      );
      if (!backend.rowCount) throw new DataStudioError(404, "delete_backend", "Data backend not found", false, "BACKEND_NOT_FOUND");
      const attached = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM projects WHERE workspace_id=$1 AND company_id=$2 AND data_backend_id=$3 AND status<>'archived'",
        [ctx.workspaceId, companyId, id],
      );
      if (Number(attached.rows[0]!.count)) throw new DataStudioError(409, "delete_backend", "Active projects still use this backend", false, "BACKEND_IN_USE");
      await client.query("UPDATE data_backends SET status='deleting',updated_at=now() WHERE id=$1", [id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async attachedCount(ctx: AuthContext, companyId: string, id: string): Promise<number> {
    await this.get(ctx, companyId, id);
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM projects WHERE workspace_id=$1 AND company_id=$2 AND data_backend_id=$3 AND status<>'archived'",
      [ctx.workspaceId, companyId, id],
    );
    return Number(result.rows[0]!.count);
  }

  async remove(ctx: AuthContext, companyId: string, id: string): Promise<void> {
    if (await this.attachedCount(ctx, companyId, id)) throw new DataStudioError(409, "delete_backend", "Active projects still use this backend", false, "BACKEND_IN_USE");
    const result = await this.pool.query(
      "DELETE FROM data_backends WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4",
      [id, ctx.workspaceId, companyId, ctx.userId],
    );
    if (!result.rowCount) throw new DataStudioError(404, "delete_backend", "Data backend not found", false, "BACKEND_NOT_FOUND");
  }

  async acquireLock(id: string, environment: DataEnvironmentName, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.pool.query(
      "INSERT INTO data_backend_migration_locks(backend_id,environment,owner_token,expires_at) VALUES($1,$2,$3,now()+$4::integer * interval '1 millisecond') " +
      "ON CONFLICT(backend_id,environment) DO UPDATE SET owner_token=EXCLUDED.owner_token,expires_at=EXCLUDED.expires_at " +
      "WHERE data_backend_migration_locks.expires_at<now() RETURNING owner_token",
      [id, environment, token, ttlMs],
    );
    return Boolean(result.rowCount);
  }

  async releaseLock(id: string, environment: DataEnvironmentName, token: string): Promise<void> {
    await this.pool.query("DELETE FROM data_backend_migration_locks WHERE backend_id=$1 AND environment=$2 AND owner_token=$3", [id, environment, token]);
  }

  async close() { await this.pool.end(); }
}
