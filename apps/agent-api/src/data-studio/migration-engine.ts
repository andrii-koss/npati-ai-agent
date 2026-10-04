import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { DataStudioError } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DataProvider, SchemaChange, SchemaOperation, SchemaSnapshot } from "./data-provider";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataEnvironmentName, ProjectSnapshot } from "./types";
import type { AuthContext } from "@npati/workspace";

export interface MigrationRequest {
  backend: DataBackend;
  environment: DataEnvironmentName;
  operation: SchemaOperation;
  authorId: string;
  runId?: string;
}
export interface MigrationPreview {
  operation: string;
  upSql: string;
  downSql?: string;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
  current: SchemaSnapshot;
  diff: { operation: SchemaOperation; beforeFingerprint: string; sql: string };
}
export interface MigrationResult extends MigrationPreview {
  id: string;
  version: number;
  checksum: string;
  fingerprint: string;
  snapshot?: ProjectSnapshot;
}

export class ProjectMigrationEngine {
  constructor(
    private readonly provisioner: DatabaseProvisioner,
    private readonly provider: DataProvider,
    private readonly repository: DataBackendRepository,
  ) {}

  private async pool(backend: DataBackend, environment: DataEnvironmentName): Promise<Pool> {
    const connection = await this.provisioner.getConnection(backend, environment, "migrator");
    return new Pool({ ...connection, max: 1, connectionTimeoutMillis: 3000 });
  }

  private async ensureHistory(pool: Pool): Promise<void> {
    await pool.query([
      "CREATE TABLE IF NOT EXISTS _npati_migrations(",
      "id text PRIMARY KEY, version bigint NOT NULL UNIQUE, operation jsonb NOT NULL,",
      "reversible boolean NOT NULL, destructive boolean NOT NULL, requires_snapshot boolean NOT NULL,",
      "up_sql text NOT NULL, down_sql text, author_id text NOT NULL, run_id text,",
      "checksum text NOT NULL, status text NOT NULL CHECK(status IN ('applied','rolled_back')),",
      "snapshot_ref text, applied_at timestamptz NOT NULL DEFAULT now(), rolled_back_at timestamptz",
      ")",
    ].join(" "));
  }

  async dryRun(request: MigrationRequest): Promise<MigrationPreview> {
    const current = await this.provider.introspectSchema(request.backend, request.environment);
    const change = this.provider.compileOperation(request.operation);
    return { ...change, current, diff: { operation: request.operation, beforeFingerprint: this.provider.schemaFingerprint(current), sql: change.upSql } };
  }

  async apply(ctx: AuthContext, request: MigrationRequest): Promise<MigrationResult> {
    const { backend, environment } = request;
    const change = this.provider.compileOperation(request.operation);
    if (backend.workspaceId !== ctx.workspaceId || backend.createdBy !== ctx.userId || backend.companyId !== (ctx.companyId ?? backend.companyId)) {
      throw new DataStudioError(403, "migration", "Backend is outside tenant", false, "TENANT_DENIED");
    }
    const stored = await this.repository.get(ctx, backend.companyId, backend.id);
    if (stored.status !== "ready") throw new DataStudioError(409, "migration", "Backend is not ready", false, "BACKEND_NOT_READY");
    const env = await this.repository.environment(ctx, backend.companyId, backend.id, environment);
    if (env.status !== "ready" || env.syncStatus !== "synced") throw new DataStudioError(409, "migration", "Environment requires reconciliation", false, "DRIFT_BLOCKED");
    const token = randomUUID();
    if (!await this.repository.acquireLock(backend.id, environment, token, 120_000)) {
      throw new DataStudioError(409, "migration_lock", "Migration already in progress", true, "MIGRATION_BUSY");
    }
    const pool = await this.pool(backend, environment);
    let snapshot: ProjectSnapshot | undefined;
    try {
      await this.ensureHistory(pool);
      const current = await this.provider.introspectSchema(backend, environment);
      const actual = this.provider.schemaFingerprint(current);
      if (env.schemaFingerprint && env.schemaFingerprint !== actual) {
        await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { syncStatus: "drift_detected" });
        throw new DataStudioError(409, "drift", "Project schema changed outside NPATI", false, "SCHEMA_DRIFT");
      }
      const usage = await this.provisioner.getUsage(backend, environment);
      this.provider.assertLimits(change.operation, current, usage.bytes, request.operation.collection);
      if (change.destructive || change.requiresSnapshot) snapshot = await this.provisioner.snapshot(backend, environment);
      const client = await pool.connect();
      let version = 0;
      const id = randomUUID();
      const checksum = createHash("sha256").update(JSON.stringify(request.operation) + "\n" + change.upSql + "\n" + (change.downSql ?? "")).digest("hex");
      try {
        await client.query("BEGIN");
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [backend.id + ":" + environment],
        );
        if (!lock.rows[0]?.locked) throw new DataStudioError(409, "migration_lock", "Database migration lock busy", true, "MIGRATION_BUSY");
        const next = await client.query<{ version: string }>("SELECT coalesce(max(version),0)::text AS version FROM _npati_migrations");
        version = Number(next.rows[0]!.version) + 1;
        await client.query(change.upSql);
        await client.query(
          "INSERT INTO _npati_migrations(id,version,operation,reversible,destructive,requires_snapshot,up_sql,down_sql,author_id,run_id,checksum,status,snapshot_ref) " +
          "VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,'applied',$12)",
          [id, version, JSON.stringify(request.operation), change.reversible, change.destructive, change.requiresSnapshot,
            change.upSql, change.downSql ?? null, request.authorId, request.runId ?? null, checksum, snapshot?.id ?? null],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        if (version > 0) await this.repository.pool.query(
          "INSERT INTO data_backend_migrations(id,backend_id,environment,version,operation,reversible,destructive,requires_snapshot,up_sql,down_sql,author_id,run_id,checksum,status,snapshot_ref) " +
          "VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,'failed',$14) ON CONFLICT DO NOTHING",
          [id, backend.id, environment, version, JSON.stringify(request.operation), change.reversible, change.destructive,
            change.requiresSnapshot, change.upSql, change.downSql ?? null, request.authorId, request.runId ?? null, checksum, snapshot?.id ?? null],
        ).catch(() => undefined);
        throw error;
      } finally { client.release(); }
      const updated = await this.provider.introspectSchema(backend, environment);
      const fingerprint = this.provider.schemaFingerprint(updated);
      await this.repository.pool.query(
        "INSERT INTO data_backend_migrations(id,backend_id,environment,version,operation,reversible,destructive,requires_snapshot,up_sql,down_sql,author_id,run_id,checksum,status,snapshot_ref,applied_at) " +
        "VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,'applied',$14,now())",
        [id, backend.id, environment, version, JSON.stringify(request.operation), change.reversible, change.destructive,
          change.requiresSnapshot, change.upSql, change.downSql ?? null, request.authorId, request.runId ?? null, checksum, snapshot?.id ?? null],
      );
      await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { schemaFingerprint: fingerprint, syncStatus: "synced" });
      return { ...change, current, diff: { operation: request.operation, beforeFingerprint: actual, sql: change.upSql }, id, version, checksum, fingerprint, snapshot };
    } finally {
      await pool.end();
      await this.repository.releaseLock(backend.id, environment, token);
    }
  }

  async rollback(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName, id: string): Promise<void> {
    await this.repository.get(ctx, backend.companyId, backend.id);
    const env = await this.repository.environment(ctx, backend.companyId, backend.id, environment);
    if (env.syncStatus !== "synced") throw new DataStudioError(409, "rollback", "Environment requires reconciliation", false, "DRIFT_BLOCKED");
    const row = await this.repository.pool.query<{ downSql: string | null; reversible: boolean; destructive: boolean }>(
      'SELECT down_sql AS "downSql",reversible,destructive FROM data_backend_migrations WHERE id=$1 AND backend_id=$2 AND environment=$3 AND status=\'applied\'',
      [id, backend.id, environment],
    );
    if (!row.rowCount || !row.rows[0]!.reversible || row.rows[0]!.destructive || !row.rows[0]!.downSql) {
      throw new DataStudioError(409, "rollback", "Migration requires snapshot restore", false, "SNAPSHOT_REQUIRED");
    }
    const token = randomUUID();
    if (!await this.repository.acquireLock(backend.id, environment, token, 120_000)) throw new DataStudioError(409, "migration_lock", "Migration already in progress", true, "MIGRATION_BUSY");
    const pool = await this.pool(backend, environment);
    try {
      const actual = this.provider.schemaFingerprint(await this.provider.introspectSchema(backend, environment));
      if (env.schemaFingerprint !== actual) {
        await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { syncStatus: "drift_detected" });
        throw new DataStudioError(409, "drift", "Project schema changed outside NPATI", false, "SCHEMA_DRIFT");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [backend.id + ":" + environment]);
        if (!lock.rows[0]?.locked) throw new DataStudioError(409, "migration_lock", "Database migration lock busy", true, "MIGRATION_BUSY");
        await client.query(row.rows[0]!.downSql!);
        await client.query("UPDATE _npati_migrations SET status='rolled_back',rolled_back_at=now() WHERE id=$1 AND status='applied'", [id]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      await this.repository.pool.query("UPDATE data_backend_migrations SET status='rolled_back' WHERE id=$1", [id]);
      const schema = await this.provider.introspectSchema(backend, environment);
      await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { schemaFingerprint: this.provider.schemaFingerprint(schema), syncStatus: "synced" });
    } finally {
      await pool.end();
      await this.repository.releaseLock(backend.id, environment, token);
    }
  }

  async detectDrift(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName) {
    const env = await this.repository.environment(ctx, backend.companyId, backend.id, environment);
    const schema = await this.provider.introspectSchema(backend, environment);
    const actual = this.provider.schemaFingerprint(schema);
    const status = env.schemaFingerprint === actual ? "synced" : "drift_detected";
    await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { syncStatus: status });
    return { status, actual, expected: env.schemaFingerprint, schema };
  }
}
