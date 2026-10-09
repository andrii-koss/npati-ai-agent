import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { DataStudioError } from "./identifier";
import type { BackupPolicy, DataBackend, DataBackendEnvironment, DataBackendPromotion, DataEnvironmentName, DataProviderKind, ProjectSnapshot, SnapshotKind, StoredDatabaseRole } from "./types";
import type { ProjectAccessPolicy } from "@npati/shared";
import type { ProjectKeyBundle } from "./auth-crypto";

const backendColumns = 'id, workspace_id AS "workspaceId", company_id AS "companyId", created_by AS "createdBy", name, provider, status, remove_after::text AS "removeAfter", created_at::text AS "createdAt", updated_at::text AS "updatedAt"';
const environmentColumns = 'id, workspace_id AS "workspaceId", company_id AS "companyId", backend_id AS "backendId", environment, provider_config AS "providerConfig", migrator_secret_ref AS "migratorSecretRef", runtime_secret_ref AS "runtimeSecretRef", signing_key_ref AS "signingKeyRef", status, schema_fingerprint AS "schemaFingerprint", expected_schema AS "expectedSchema", sync_status AS "syncStatus", limits, backup_policy AS "backupPolicy", created_at::text AS "createdAt", updated_at::text AS "updatedAt"';

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
    limits?: Record<string, number>; backupPolicy?: BackupPolicy;
  }): Promise<void> {
    await this.get(ctx, companyId, id);
    await this.pool.query(
      "UPDATE data_backend_environments SET status=COALESCE($1,status),provider_config=COALESCE($2::jsonb,provider_config)," +
      "migrator_secret_ref=COALESCE($3,migrator_secret_ref),runtime_secret_ref=COALESCE($4,runtime_secret_ref)," +
      "schema_fingerprint=COALESCE($5,schema_fingerprint),sync_status=COALESCE($6,sync_status)," +
      "limits=COALESCE($11::jsonb,limits),backup_policy=COALESCE($12::jsonb,backup_policy),updated_at=now() " +
      "WHERE backend_id=$7 AND environment=$8 AND workspace_id=$9 AND company_id=$10",
      [patch.status ?? null, patch.providerConfig ? JSON.stringify(patch.providerConfig) : null, patch.migratorSecretRef ?? null,
        patch.runtimeSecretRef ?? null, patch.schemaFingerprint ?? null, patch.syncStatus ?? null,
        id, environment, ctx.workspaceId, companyId,
        patch.limits ? JSON.stringify(patch.limits) : null, patch.backupPolicy ? JSON.stringify(patch.backupPolicy) : null],
    );
  }

  async setExpectedSchema(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName, schema: unknown, fingerprint: string): Promise<void> {
    await this.get(ctx, companyId, id);
    await this.pool.query("UPDATE data_backend_environments SET expected_schema=$1::jsonb,schema_fingerprint=$2,sync_status='synced',updated_at=now() WHERE backend_id=$3 AND environment=$4 AND workspace_id=$5 AND company_id=$6",
      [JSON.stringify(schema), fingerprint, id, environment, ctx.workspaceId, companyId]);
  }

  async putSecret(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName, role: StoredDatabaseRole, value: string): Promise<string> {
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

  async resolveSecret(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName, role: StoredDatabaseRole): Promise<string> {
    await this.get(ctx, companyId, id);
    const result = await this.pool.query<{ encryptedValue: string }>(
      'SELECT encrypted_value AS "encryptedValue" FROM data_backend_secrets WHERE backend_id=$1 AND environment=$2 AND role=$3',
      [id, environment, role],
    );
    if (!result.rowCount) throw new DataStudioError(404, "resolve_secret", "Database secret not found", false, "SECRET_NOT_FOUND");
    return this.vault.decrypt(result.rows[0]!.encryptedValue);
  }

  async getAccessPolicies(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName): Promise<ProjectAccessPolicy[]> {
    await this.get(ctx, companyId, id);
    const result = await this.pool.query<{ policyJson: ProjectAccessPolicy }>(
      'SELECT policy_json AS "policyJson" FROM data_backend_access_policies WHERE backend_id=$1 AND environment=$2 ORDER BY collection_name',
      [id, environment],
    );
    return result.rows.map((r) => r.policyJson);
  }

  async setCollectionAccessPolicies(
    ctx: AuthContext,
    companyId: string,
    id: string,
    environment: DataEnvironmentName,
    collectionName: string,
    policies: ProjectAccessPolicy[],
  ): Promise<void> {
    await this.get(ctx, companyId, id);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM data_backend_access_policies WHERE backend_id=$1 AND environment=$2 AND collection_name=$3",
        [id, environment, collectionName],
      );
      for (const policy of policies) {
        await client.query(
          "INSERT INTO data_backend_access_policies(id, backend_id, environment, collection_name, policy_json, updated_at) VALUES($1,$2,$3,$4,$5,now())",
          [randomUUID(), id, environment, collectionName, JSON.stringify(policy)],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteAccessPolicies(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName, collectionName: string): Promise<void> {
    await this.get(ctx, companyId, id);
    await this.pool.query(
      "DELETE FROM data_backend_access_policies WHERE backend_id=$1 AND environment=$2 AND collection_name=$3",
      [id, environment, collectionName],
    );
  }

  async getSigningKeys(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName): Promise<ProjectKeyBundle | null> {
    try {
      const secret = await this.resolveSecret(ctx, companyId, id, environment, "signing");
      return JSON.parse(secret) as ProjectKeyBundle;
    } catch (error) {
      if (error instanceof DataStudioError && error.code === "SECRET_NOT_FOUND") return null;
      throw error;
    }
  }

  async saveSigningKeys(ctx: AuthContext, companyId: string, id: string, environment: DataEnvironmentName, bundle: ProjectKeyBundle): Promise<string> {
    return this.putSecret(ctx, companyId, id, environment, "signing", JSON.stringify(bundle));
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
      "ON CONFLICT(backend_id,environment) DO UPDATE SET owner_token=EXCLUDED.owner_token,expires_at=EXCLUDED.expires_at,acquired_at=now() " +
      "WHERE data_backend_migration_locks.expires_at<now() RETURNING owner_token",
      [id, environment, token, ttlMs],
    );
    return Boolean(result.rowCount);
  }

  async releaseLock(id: string, environment: DataEnvironmentName, token: string): Promise<void> {
    await this.pool.query("DELETE FROM data_backend_migration_locks WHERE backend_id=$1 AND environment=$2 AND owner_token=$3", [id, environment, token]);
  }

  async ownsLock(id: string, environment: DataEnvironmentName, token: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM data_backend_migration_locks WHERE backend_id=$1 AND environment=$2 AND owner_token=$3 AND expires_at>now()", [id, environment, token]);
    return Boolean(result.rowCount);
  }

  // =========================================================================
  // D7: backups, promotions, lifecycle
  // =========================================================================

  /** Applied migrations of one environment, in version order (used by promote). */
  async listAppliedMigrations(backendId: string, environment: DataEnvironmentName): Promise<Array<{ version: number; operation: unknown }>> {
    const result = await this.pool.query<{ version: string; operation: unknown }>(
      "SELECT version::text AS version, operation FROM data_backend_migrations " +
      "WHERE backend_id=$1 AND environment=$2 AND status='applied' ORDER BY version",
      [backendId, environment],
    );
    return result.rows.map((row) => ({ version: Number(row.version), operation: row.operation }));
  }

  /** Records a snapshot taken by a provisioner (file already written). */
  async insertSnapshot(backendId: string, environment: DataEnvironmentName, snapshot: {
    id: string; path: string; kind: SnapshotKind; reason?: string; sizeBytes?: number; createdBy?: string; retentionDays?: number;
  }): Promise<void> {
    await this.pool.query(
      "INSERT INTO data_backend_snapshots(id,backend_id,environment,file_path,kind,reason,size_bytes,created_by,expires_at) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9::integer * interval '1 day')",
      [snapshot.id, backendId, environment, snapshot.path, snapshot.kind, snapshot.reason ?? null,
        snapshot.sizeBytes ?? null, snapshot.createdBy ?? null, Math.max(1, snapshot.retentionDays ?? 30)],
    );
  }

  async listSnapshots(backendId: string, environment: DataEnvironmentName, limit = 100): Promise<ProjectSnapshot[]> {
    const result = await this.pool.query<ProjectSnapshot>(
      'SELECT id, backend_id AS "backendId", environment, file_path AS path, created_at::text AS "createdAt", ' +
      'kind, reason, size_bytes AS "sizeBytes" FROM data_backend_snapshots ' +
      "WHERE backend_id=$1 AND environment=$2 ORDER BY created_at DESC LIMIT $3",
      [backendId, environment, Math.max(1, Math.min(limit, 200))],
    );
    return result.rows;
  }

  async getSnapshot(backendId: string, environment: DataEnvironmentName, snapshotId: string): Promise<ProjectSnapshot | null> {
    const result = await this.pool.query<ProjectSnapshot>(
      'SELECT id, backend_id AS "backendId", environment, file_path AS path, created_at::text AS "createdAt", ' +
      'kind, reason, size_bytes AS "sizeBytes" FROM data_backend_snapshots ' +
      "WHERE backend_id=$1 AND environment=$2 AND id=$3",
      [backendId, environment, snapshotId],
    );
    return result.rows[0] ?? null;
  }

  async deleteSnapshotRecord(snapshotId: string): Promise<void> {
    await this.pool.query("DELETE FROM data_backend_snapshots WHERE id=$1", [snapshotId]);
  }

  /** Snapshots whose retention expired, for pruning (files are removed by the caller). */
  async expiredSnapshots(limit = 100): Promise<ProjectSnapshot[]> {
    const result = await this.pool.query<ProjectSnapshot>(
      'SELECT id, backend_id AS "backendId", environment, file_path AS path, created_at::text AS "createdAt", ' +
      'kind, reason, size_bytes AS "sizeBytes" FROM data_backend_snapshots WHERE expires_at < now() ORDER BY created_at ASC LIMIT $1',
      [Math.max(1, Math.min(limit, 500))],
    );
    return result.rows;
  }

  /** Automatic snapshots beyond the configured keep count for a backend + environment. */
  async surplusScheduledSnapshots(backendId: string, environment: DataEnvironmentName, keep: number): Promise<ProjectSnapshot[]> {
    const result = await this.pool.query<ProjectSnapshot>(
      'SELECT id, backend_id AS "backendId", environment, file_path AS path, created_at::text AS "createdAt", ' +
      'kind, reason, size_bytes AS "sizeBytes" FROM data_backend_snapshots ' +
      "WHERE backend_id=$1 AND environment=$2 AND kind='scheduled' ORDER BY created_at DESC OFFSET $3",
      [backendId, environment, Math.max(0, keep)],
    );
    return result.rows;
  }

  /** Backends with their environments; used by the backup scheduler tick. */
  async allBackends(): Promise<Array<{ backend: DataBackend; environments: DataBackendEnvironment[] }>> {
    const backends = await this.pool.query<DataBackend>("SELECT " + backendColumns + " FROM data_backends ORDER BY created_at");
    const environments = await this.pool.query<DataBackendEnvironment & { backendIdValue: string }>(
      "SELECT id, workspace_id AS \"workspaceId\", company_id AS \"companyId\", backend_id AS \"backendId\", environment, " +
      "provider_config AS \"providerConfig\", status, schema_fingerprint AS \"schemaFingerprint\", sync_status AS \"syncStatus\", " +
      "limits, backup_policy AS \"backupPolicy\", created_at AS \"createdAt\", updated_at AS \"updatedAt\" FROM data_backend_environments",
    );
    return backends.rows.map((backend) => ({ backend, environments: environments.rows.filter((env) => env.backendId === backend.id) }));
  }

  async setRemovalDeadline(ctx: AuthContext, companyId: string, id: string, removeAfter: Date): Promise<void> {
    const result = await this.pool.query(
      "UPDATE data_backends SET status='deleting',remove_after=$1,updated_at=now() " +
      "WHERE id=$2 AND workspace_id=$3 AND company_id=$4 AND created_by=$5",
      [removeAfter.toISOString(), id, ctx.workspaceId, companyId, ctx.userId],
    );
    if (!result.rowCount) throw new DataStudioError(404, "delete_backend", "Data backend not found", false, "BACKEND_NOT_FOUND");
  }

  /** Backends whose retention window elapsed and can be purged now. */
  async dueRemovals(): Promise<DataBackend[]> {
    const result = await this.pool.query<DataBackend>(
      "SELECT " + backendColumns + " FROM data_backends WHERE status='deleting' AND remove_after IS NOT NULL AND remove_after <= now()",
    );
    return result.rows;
  }

  async insertPromotion(promotion: DataBackendPromotion): Promise<void> {
    await this.pool.query(
      "INSERT INTO data_backend_promotions(id,workspace_id,company_id,backend_id,target_environment,status,diff,flags,snapshot_ref,with_data,approved_by,error,applied_at) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)",
      [promotion.id, promotion.workspaceId, promotion.companyId, promotion.backendId, promotion.targetEnvironment,
        promotion.status, JSON.stringify(promotion.diff ?? []), JSON.stringify(promotion.flags ?? {}), promotion.snapshotRef ?? null,
        promotion.withData, promotion.approvedBy ?? null, promotion.error ?? null, promotion.appliedAt ?? null],
    );
  }

  async updatePromotion(id: string, patch: { status?: DataBackendPromotion["status"]; snapshotRef?: string; error?: string; approvedBy?: string; appliedAt?: string }): Promise<void> {
    await this.pool.query(
      "UPDATE data_backend_promotions SET status=COALESCE($1,status),snapshot_ref=COALESCE($2,snapshot_ref),error=COALESCE($3,error)," +
      "approved_by=COALESCE($4,approved_by),applied_at=COALESCE($5::timestamptz,applied_at) WHERE id=$6",
      [patch.status ?? null, patch.snapshotRef ?? null, patch.error ?? null, patch.approvedBy ?? null, patch.appliedAt ?? null, id],
    );
  }

  async listPromotions(backendId: string, limit = 20): Promise<DataBackendPromotion[]> {
    const result = await this.pool.query<DataBackendPromotion>(
      'SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", backend_id AS "backendId", ' +
      'target_environment AS "targetEnvironment", status, diff, flags, snapshot_ref AS "snapshotRef", ' +
      'with_data AS "withData", approved_by AS "approvedBy", error, created_at::text AS "createdAt", applied_at::text AS "appliedAt" ' +
      "FROM data_backend_promotions WHERE backend_id=$1 ORDER BY created_at DESC LIMIT $2",
      [backendId, Math.max(1, Math.min(limit, 100))],
    );
    return result.rows;
  }

  /**
   * Moves a DataBackend (its environments, keys, secrets, migrations, snapshots and promote
   * journal) to another company of the same workspace. The physical databases and roles are
   * untouched, so the data survives; Projects of the previous company are detached first, because
   * a Project can never leave its company. Parent and child rows change in a single statement so
   * the composite foreign keys are satisfied when the statement ends.
   */
  async transferToCompany(workspaceId: string, fromCompanyId: string, toCompanyId: string, backendId: string, createdBy: string) {
    const result = await this.pool.query<{ moved: number; environments: number; detachedProjects: number; promotions: number }>(
      "WITH detached AS (" +
      "  UPDATE projects SET data_backend_id=NULL, revision=revision+1, updated_at=now()" +
      "  WHERE workspace_id=$1 AND company_id=$2 AND data_backend_id=$3 RETURNING id" +
      "), environments AS (" +
      "  UPDATE data_backend_environments SET company_id=$4, updated_at=now()" +
      "  WHERE workspace_id=$1 AND company_id=$2 AND backend_id=$3 RETURNING id" +
      "), promotions AS (" +
      "  UPDATE data_backend_promotions SET company_id=$4" +
      "  WHERE workspace_id=$1 AND company_id=$2 AND backend_id=$3 RETURNING id" +
      "), moved AS (" +
      "  UPDATE data_backends SET company_id=$4, updated_at=now()" +
      "  WHERE workspace_id=$1 AND company_id=$2 AND id=$3 AND created_by=$5 RETURNING id" +
      ") " +
      "SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM environments)::int AS environments, " +
      "(SELECT count(*) FROM detached)::int AS \"detachedProjects\", (SELECT count(*) FROM promotions)::int AS promotions",
      [workspaceId, fromCompanyId, toCompanyId, backendId, createdBy],
    );
    return result.rows[0] ?? { moved: 0, environments: 0, detachedProjects: 0, promotions: 0 };
  }

  /** Removes every secret (roles and signing keys) of a backend, used by the purge step. */
  async deleteSecrets(backendId: string): Promise<void> {
    await this.pool.query("DELETE FROM data_backend_secrets WHERE backend_id=$1", [backendId]);
  }

  async deleteSnapshots(backendId: string): Promise<ProjectSnapshot[]> {
    const rows = await this.pool.query<ProjectSnapshot>(
      'SELECT id, backend_id AS "backendId", environment, file_path AS path, created_at::text AS "createdAt" FROM data_backend_snapshots WHERE backend_id=$1',
      [backendId],
    );
    await this.pool.query("DELETE FROM data_backend_snapshots WHERE backend_id=$1", [backendId]);
    return rows.rows;
  }

  async close() { await this.pool.end(); }
}
