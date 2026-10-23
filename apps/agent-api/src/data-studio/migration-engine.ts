import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { DataStudioError, bindFilter, quoteIdentifier } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DataProvider, SchemaChange, SchemaOperation, SchemaSnapshot } from "./data-provider";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataEnvironmentName, ProjectSnapshot } from "./types";
import type { AuthContext } from "@npati/workspace";
import type { ProjectAccessPolicy } from "@npati/shared";
import { RlsPolicyCompiler } from "./rls-compiler";

export interface MigrationRequest {
  expectedFingerprint?: string;
  backend: DataBackend;
  environment: DataEnvironmentName;
  operation: SchemaOperation;
  authorId: string;
  runId?: string;
  /** Internal handoff from Promote; ownership is verified against Core. */
  lockToken?: string;
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

import { transferProjectRows, type RowTransferInput } from "./row-transfer";

export class ProjectMigrationEngine {
  constructor(
    private readonly provisioner: DatabaseProvisioner,
    private readonly provider: DataProvider,
    private readonly repository: DataBackendRepository,
  ) {}

  async transferRows(ctx: AuthContext, backend: DataBackend, input: RowTransferInput) {
    return transferProjectRows(ctx, backend, input, this.provisioner, this.provider, this.repository);
  }

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

  private compileManagedChange(operation: SchemaOperation): SchemaChange {
    const change = this.provider.compileOperation(operation);
    if (operation.kind !== "create_collection" && !(operation.kind === "create_relation" && operation.cardinality === "many-to-many")) return change;
    const table = quoteIdentifier(operation.kind === "create_collection" ? operation.collection : operation.name);
    return { ...change, upSql: change.upSql + " CREATE POLICY npati_management ON " + table +
      " FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);" };
  }

  async dryRun(request: MigrationRequest): Promise<MigrationPreview> {
    const current = await this.provider.introspectSchema(request.backend, request.environment);
    const change = this.compileManagedChange(request.operation);
    return { ...change, current, diff: { operation: request.operation, beforeFingerprint: this.provider.schemaFingerprint(current), sql: change.upSql } };
  }

  async apply(ctx: AuthContext, request: MigrationRequest): Promise<MigrationResult> {
    const { backend, environment } = request;
    const change = this.compileManagedChange(request.operation);
    if (backend.workspaceId !== ctx.workspaceId || backend.createdBy !== ctx.userId || backend.companyId !== (ctx.companyId ?? backend.companyId)) {
      throw new DataStudioError(403, "migration", "Backend is outside tenant", false, "TENANT_DENIED");
    }
    const stored = await this.repository.get(ctx, backend.companyId, backend.id);
    if (stored.status !== "ready") throw new DataStudioError(409, "migration", "Backend is not ready", false, "BACKEND_NOT_READY");
    const env = await this.repository.environment(ctx, backend.companyId, backend.id, environment);
    if (env.status !== "ready" || env.syncStatus !== "synced") throw new DataStudioError(409, "migration", "Environment requires reconciliation", false, "DRIFT_BLOCKED");
    const token = request.lockToken ?? randomUUID();
    if (!(request.lockToken ? await this.repository.ownsLock(backend.id, environment, token) : await this.repository.acquireLock(backend.id, environment, token, 120_000))) {
      throw new DataStudioError(409, "migration_lock", "Migration already in progress", true, "MIGRATION_BUSY");
    }
    const pool = await this.pool(backend, environment);
    let snapshot: ProjectSnapshot | undefined;
    try {
      await this.ensureHistory(pool);
      const current = await this.provider.introspectSchema(backend, environment);
      const actual = this.provider.schemaFingerprint(current);
      if (request.expectedFingerprint && request.expectedFingerprint !== actual) {
        throw new DataStudioError(409, "migration", "Schema changed concurrently", false, "STALE_SCHEMA");
      }
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
        // A schema or constraint error (e.g. a relation on a missing column) is the caller's to fix: report the
        // database's message, which names only the identifiers of this operation, instead of an opaque failure.
        const pg = error as { code?: unknown; message?: unknown };
        if (!(error instanceof DataStudioError) && typeof pg.code === "string" && /^(42|23)/.test(pg.code) && typeof pg.message === "string") {
          throw new DataStudioError(400, "migration", "The database rejected this migration: " + pg.message.slice(0, 300), false, "MIGRATION_REJECTED");
        }
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
      if (request.operation.kind === "rename_collection") {
        await this.repository.pool.query("UPDATE data_backend_access_policies SET collection_name=$3,policy_json=jsonb_set(policy_json,'{collection}',to_jsonb($3::text)),updated_at=now() WHERE backend_id=$1 AND environment=$2 AND collection_name=$4", [backend.id, environment, request.operation.next, request.operation.collection]);
      } else if (request.operation.kind === "drop_collection") {
        await this.repository.pool.query("DELETE FROM data_backend_access_policies WHERE backend_id=$1 AND environment=$2 AND collection_name=$3", [backend.id, environment, request.operation.collection]);
      }
      await this.repository.setExpectedSchema(ctx, backend.companyId, backend.id, environment, updated, fingerprint);
      return { ...change, current, diff: { operation: request.operation, beforeFingerprint: actual, sql: change.upSql }, id, version, checksum, fingerprint, snapshot };
    } finally {
      await pool.end();
      if (!request.lockToken) await this.repository.releaseLock(backend.id, environment, token);
    }
  }

  /** All template DDL, history and runtime policies share one PostgreSQL transaction. */
  async applyBatch(ctx: AuthContext, request: Omit<MigrationRequest, "operation"> & { operations: SchemaOperation[]; policies?: ProjectAccessPolicy[] }): Promise<MigrationResult[]> {
    const { backend, environment, operations } = request;
    if (!operations.length || operations.length > 50) throw new DataStudioError(400, "migration", "Invalid migration batch size", false, "INVALID_OPERATION");
    if (backend.workspaceId !== ctx.workspaceId || backend.createdBy !== ctx.userId) throw new DataStudioError(403, "migration", "Backend is outside tenant", false, "TENANT_DENIED");
    const stored = await this.repository.get(ctx, backend.companyId, backend.id);
    const env = await this.repository.environment(ctx, backend.companyId, backend.id, environment);
    if (stored.status !== "ready" || env.status !== "ready" || env.syncStatus !== "synced") throw new DataStudioError(409, "migration", "Environment is not ready or requires reconciliation", false, "DRIFT_BLOCKED");
    const changes = operations.map(operation => this.compileManagedChange(operation));
    for (const policy of request.policies ?? []) RlsPolicyCompiler.validate(policy);
    const token = request.lockToken ?? randomUUID();
    if (!(request.lockToken ? await this.repository.ownsLock(backend.id, environment, token) : await this.repository.acquireLock(backend.id, environment, token, 120_000))) throw new DataStudioError(409, "migration_lock", "Migration already in progress", true, "MIGRATION_BUSY");
    let pool: Pool | undefined;
    try {
      pool = await this.pool(backend, environment);
      await this.ensureHistory(pool);
      const current = await this.provider.introspectSchema(backend, environment);
      const actual = this.provider.schemaFingerprint(current);
      if (env.schemaFingerprint && env.schemaFingerprint !== actual) {
        await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { syncStatus: "drift_detected" });
        throw new DataStudioError(409, "drift", "Project schema changed outside NPATI", false, "SCHEMA_DRIFT");
      }
      const usage = await this.provisioner.getUsage(backend, environment);
      const pending = { tables: [...current.tables] };
      operations.forEach((operation, index) => {
        this.provider.assertLimits(changes[index]!.operation, pending, usage.bytes, operation.collection);
        if (operation.kind === "create_collection") pending.tables.push({ name: operation.collection, columns: [], constraints: [], indexes: [], policies: [], rlsEnabled: true, rlsForced: true });
      });
      const snapshot = changes.some(change => change.destructive || change.requiresSnapshot) ? await this.provisioner.snapshot(backend, environment) : undefined;
      const client = await pool.connect();
      const records: Array<{ id: string; version: number; checksum: string; change: SchemaChange; operation: SchemaOperation }> = [];
      try {
        await client.query("BEGIN");
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [backend.id + ":" + environment]);
        if (!lock.rows[0]?.locked) throw new DataStudioError(409, "migration_lock", "Database migration lock busy", true, "MIGRATION_BUSY");
        const next = await client.query<{ version: string }>("SELECT coalesce(max(version),0)::text AS version FROM _npati_migrations");
        let version = Number(next.rows[0]!.version);
        for (let index = 0; index < operations.length; index++) {
          const operation = operations[index]!;
          const change = changes[index]!;
          const id = randomUUID();
          const checksum = createHash("sha256").update(JSON.stringify(operation) + "\n" + change.upSql + "\n" + (change.downSql ?? "")).digest("hex");
          await client.query(change.upSql);
          await client.query("INSERT INTO _npati_migrations(id,version,operation,reversible,destructive,requires_snapshot,up_sql,down_sql,author_id,run_id,checksum,status,snapshot_ref) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,'applied',$12)", [id, ++version, JSON.stringify(operation), change.reversible, change.destructive, change.requiresSnapshot, change.upSql, change.downSql ?? null, request.authorId, request.runId ?? null, checksum, snapshot?.id ?? null]);
          records.push({ id, version, checksum, change, operation });
        }
        const grouped = new Map<string, ProjectAccessPolicy[]>();
        for (const policy of request.policies ?? []) grouped.set(policy.collection, [...(grouped.get(policy.collection) ?? []), policy]);
        if (grouped.size) {
          const runtime = await this.provisioner.getConnection(backend, environment, "runtime");
          for (const [collection, policies] of grouped) {
            for (const sql of RlsPolicyCompiler.compile(collection, policies).sql) await client.query(sql);
            await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdentifier(collection)} TO ${quoteIdentifier(runtime.user)}`);
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
      try {
        for (const record of records) await this.repository.pool.query("INSERT INTO data_backend_migrations(id,backend_id,environment,version,operation,reversible,destructive,requires_snapshot,up_sql,down_sql,author_id,run_id,checksum,status,snapshot_ref,applied_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,'applied',$14,now())", [record.id, backend.id, environment, record.version, JSON.stringify(record.operation), record.change.reversible, record.change.destructive, record.change.requiresSnapshot, record.change.upSql, record.change.downSql ?? null, request.authorId, request.runId ?? null, record.checksum, snapshot?.id ?? null]);
        const grouped = new Map<string, ProjectAccessPolicy[]>();
        for (const policy of request.policies ?? []) grouped.set(policy.collection, [...(grouped.get(policy.collection) ?? []), policy]);
        for (const [collection, policies] of grouped) await this.repository.setCollectionAccessPolicies(ctx, backend.companyId, backend.id, environment, collection, policies);
        const updated = await this.provider.introspectSchema(backend, environment);
        const fingerprint = this.provider.schemaFingerprint(updated);
        await this.repository.setExpectedSchema(ctx, backend.companyId, backend.id, environment, updated, fingerprint);
        return records.map(record => ({ ...record.change, id: record.id, version: record.version, checksum: record.checksum, fingerprint, snapshot, current, diff: { operation: record.operation, beforeFingerprint: actual, sql: record.change.upSql } }));
      } catch (error) {
        await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { syncStatus: "reconciliation_required" }).catch(() => undefined);
        throw error;
      }
    } finally {
      await pool?.end();
      if (!request.lockToken) await this.repository.releaseLock(backend.id, environment, token);
    }
  }

  async rollback(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName, id: string): Promise<void> {
    await this.repository.get(ctx, backend.companyId, backend.id);
    const env = await this.repository.environment(ctx, backend.companyId, backend.id, environment);
    if (env.syncStatus !== "synced") throw new DataStudioError(409, "rollback", "Environment requires reconciliation", false, "DRIFT_BLOCKED");
    const row = await this.repository.pool.query<{ downSql: string | null; reversible: boolean; destructive: boolean; operation: SchemaOperation }>(
      'SELECT down_sql AS "downSql",reversible,destructive,operation FROM data_backend_migrations WHERE id=$1 AND backend_id=$2 AND environment=$3 AND status=\'applied\'',
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
      const operation = row.rows[0]!.operation;
      if (operation.kind === "rename_collection") {
        await this.repository.pool.query("UPDATE data_backend_access_policies SET collection_name=$3,policy_json=jsonb_set(policy_json,'{collection}',to_jsonb($3::text)),updated_at=now() WHERE backend_id=$1 AND environment=$2 AND collection_name=$4", [backend.id, environment, operation.collection, operation.next]);
      }
      const schema = await this.provider.introspectSchema(backend, environment);
      await this.repository.setExpectedSchema(ctx, backend.companyId, backend.id, environment, schema, this.provider.schemaFingerprint(schema));
    } finally {
      await pool.end();
      await this.repository.releaseLock(backend.id, environment, token);
    }
  }

  private async ownerQuery<T extends QueryResultRow = QueryResultRow>(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName, sql: string, values: unknown[]): Promise<T[]> {
    const stored = await this.repository.get(ctx, backend.companyId, backend.id);
    const env = await this.repository.environment(ctx, stored.companyId, stored.id, environment);
    if (stored.status !== "ready" || env.status !== "ready") throw new DataStudioError(409, "owner_data", "Backend is not ready", false, "BACKEND_NOT_READY");
    if (env.syncStatus !== "synced") throw new DataStudioError(409, "owner_data", "Environment requires reconciliation", false, "DRIFT_BLOCKED");
    const pool = await this.pool(stored, environment);
    try { return (await pool.query<T>(sql, values)).rows; }
    finally { await pool.end(); }
  }

  async listOwnerRows(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName, collection: string,
    input: { filters?: Array<{ field: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: unknown }>;
      sort?: { field: string; direction: "asc" | "desc" }; limit?: number; offset?: number; search?: string } = {}) {
    const table = quoteIdentifier(collection);
    const values: unknown[] = [];
    if ((input.filters?.length ?? 0) > 10) throw new DataStudioError(400, "owner_data", "Too many filters", false, "QUERY_LIMIT");
    const conditions = (input.filters ?? []).map((filter) => bindFilter(filter.field, filter.operator, filter.value, values));
    if (input.search) {
      if (input.search.length > 200) throw new DataStudioError(400, "owner_data", "Search is too long", false, "INVALID_SEARCH");
      values.push("%" + input.search.replace(/[\\%_]/g, "\\$&") + "%");
      conditions.push("EXISTS (SELECT 1 FROM jsonb_each_text(to_jsonb(" + table + ")) AS search_value WHERE search_value.value ILIKE $" + values.length + " ESCAPE '\\')");
    }
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
    const offset = Number(input.offset) || 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new DataStudioError(400, "owner_data", "Invalid offset", false, "INVALID_OFFSET");
    const sort = input.sort ? " ORDER BY " + quoteIdentifier(input.sort.field) + (input.sort.direction === "desc" ? " DESC" : input.sort.direction === "asc" ? " ASC" : (() => { throw new DataStudioError(400, "owner_data", "Invalid sort", false, "INVALID_SORT"); })()) : " ORDER BY id";
    values.push(limit, offset);
    return this.ownerQuery<Record<string, unknown>>(ctx, backend, environment,
      "SELECT * FROM " + table + (conditions.length ? " WHERE " + conditions.join(" AND ") : "") + sort + " LIMIT $" + (values.length - 1) + " OFFSET $" + values.length, values);
  }

  async createOwnerRow(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName, collection: string, row: Record<string, unknown>) {
    const fields = Object.keys(row).filter((f) => row[f] !== undefined);
    if (fields.length > 100 || fields.includes("id")) throw new DataStudioError(400, "owner_data", "Invalid row", false, "INVALID_ROW");
    const sql = fields.length === 0
      ? "INSERT INTO " + quoteIdentifier(collection) + " DEFAULT VALUES RETURNING *"
      : "INSERT INTO " + quoteIdentifier(collection) + " (" + fields.map(quoteIdentifier).join(",") + ") VALUES (" + fields.map((_, index) => "$" + (index + 1)).join(",") + ") RETURNING *";
    const values = fields.map((f) => row[f] === undefined ? null : row[f]);
    return (await this.ownerQuery<Record<string, unknown>>(ctx, backend, environment, sql, values))[0];
  }

  async updateOwnerRow(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName, collection: string, id: string, row: Record<string, unknown>) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DataStudioError(400, "owner_data", "Invalid row ID", false, "INVALID_ROW_ID");
    const fields = Object.keys(row).filter((f) => row[f] !== undefined);
    if (!fields.length || fields.length > 100 || fields.includes("id")) throw new DataStudioError(400, "owner_data", "Invalid row", false, "INVALID_ROW");
    const values = fields.map((f) => row[f] === undefined ? null : row[f]);
    const sql = "UPDATE " + quoteIdentifier(collection) + " SET " + fields.map((field, index) => quoteIdentifier(field) + "=$" + (index + 1)).join(",") +
      " WHERE id=$" + (fields.length + 1) + " RETURNING *";
    return (await this.ownerQuery<Record<string, unknown>>(ctx, backend, environment, sql, [...values, id]))[0] ?? null;
  }

  async deleteOwnerRows(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName, collection: string, ids: string[]) {
    if (!ids.length || ids.length > 100 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new DataStudioError(400, "owner_data", "Invalid row IDs", false, "INVALID_ROW_IDS");
    const rows = await this.ownerQuery<{ id: string }>(ctx, backend, environment,
      "DELETE FROM " + quoteIdentifier(collection) + " WHERE id = ANY($1::uuid[]) RETURNING id", [ids]);
    return { deleted: rows.length };
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
