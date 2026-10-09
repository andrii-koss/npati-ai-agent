import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import { DataStudioError, quoteIdentifier, validateIdentifier } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DataProvider, SchemaOperation, SchemaSnapshot } from "./data-provider";
import type { DatabaseProvisioner } from "./provisioner";
import type { ProjectMigrationEngine } from "./migration-engine";
import type { DataBackend, DataBackendPromotion, DataEnvironmentName, ProjectSnapshot, SnapshotKind } from "./types";
import { RlsPolicyCompiler } from "./rls-compiler";

const PROMOTE_LOCK_TTL_MS = 120_000;
const MANAGED_PREFIX = "_npati_";
const DEFAULT_MAX_DATA_ROWS = 500;

export interface PromoteOperationPreview {
  version: number;
  kind: string;
  collection?: string;
  sql: string;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
}

export interface PromoteDataPreview {
  collection: string;
  rows: number;
}

export interface PromotePreview {
  backendId: string;
  backendName: string;
  targetEnvironment: DataEnvironmentName;
  approvalRequired: true;
  destructive: boolean;
  requiresSnapshot: boolean;
  reversible: boolean;
  operations: PromoteOperationPreview[];
  pendingVersions: number[];
  alreadyApplied: number[];
  addedCollections: string[];
  removedCollections: string[];
  changedCollections: string[];
  dataPreview: PromoteDataPreview[];
  /** Rows a destructive plan would touch, labelled `<collection> (prod, affected)`. */
  affectedData: PromoteDataPreview[];
  withData: boolean;
  drift: { status: string; actual?: string; expected?: string | null };
}

export interface PromoteResult {
  promotionId: string;
  status: "applied";
  appliedOperations: number;
  fingerprint: string;
  snapshotId?: string;
  copiedRows: number;
}

interface DevMigrationRow {
  version: string;
  operation: SchemaOperation;
}

/**
 * D7 promote: replay the applied dev migrations onto prod.
 *
 * Guarantees:
 *  - prod drift must be `synced` before preview and before apply;
 *  - the Core migration lock serializes concurrent promotes per backend + environment;
 *  - a prod snapshot is always taken before applying (and recorded as `pre_promote`);
 *  - dev rows are copied only when the caller explicitly asks for it;
 *  - the prod fingerprint/expected schema is refreshed after a successful promote.
 */
export class PromoteService {
  constructor(
    private readonly repository: DataBackendRepository,
    private readonly provisioner: DatabaseProvisioner,
    private readonly engine: ProjectMigrationEngine,
    private readonly provider: DataProvider,
  ) {}

  private async history(backend: DataBackend, environment: DataEnvironmentName): Promise<Array<{ version: string; operation: SchemaOperation }>> {
    const rows = await this.repository.listAppliedMigrations(backend.id, environment);
    return rows.map((row) => ({ version: String(row.version), operation: row.operation as SchemaOperation }));
  }

  private async collectionNames(backend: DataBackend, environment: DataEnvironmentName): Promise<string[]> {
    const schema = await this.provider.introspectSchema(backend, environment);
    return schema.tables.map((table) => table.name).filter((name) => !name.startsWith(MANAGED_PREFIX)).sort();
  }

  private async rowCount(backend: DataBackend, environment: DataEnvironmentName, collection: string): Promise<number> {
    const connection = await this.provisioner.getConnection(backend, environment, "migrator");
    const pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 3000 });
    try {
      const result = await pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM ${quoteIdentifier(validateIdentifier(collection))}`);
      return Number(result.rows[0]?.total ?? 0);
    } catch {
      return 0;
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  private summarizeSchema(schema: SchemaSnapshot) {
    return new Map(schema.tables.map((table) => [table.name, table]));
  }

  async preview(
    ctx: AuthContext,
    companyId: string,
    backendId: string,
    options: { withData?: boolean; targetEnvironment?: DataEnvironmentName } = {},
  ): Promise<PromotePreview> {
    const target = options.targetEnvironment ?? "prod";
    const withData = Boolean(options.withData);
    const backend = await this.repository.get(ctx, companyId, backendId);
    const [devEnv, prodEnv] = await Promise.all([
      this.repository.environment(ctx, companyId, backendId, "dev"),
      this.repository.environment(ctx, companyId, backendId, target),
    ]);
    if (devEnv.status !== "ready") throw new DataStudioError(409, "promote", "dev environment is not ready", false, "ENVIRONMENT_NOT_READY");
    if (prodEnv.status !== "ready") throw new DataStudioError(409, "promote", `${target} environment is not ready`, false, "ENVIRONMENT_NOT_READY");

    const drift = await this.engine.detectDrift(ctx, backend, target);
    if (drift.status !== "synced") {
      throw new DataStudioError(409, "promote", `Promote is blocked: ${target} schema drifted from NPATI metadata`, false, "DRIFT_BLOCKED");
    }

    const [devHistory, prodHistory] = await Promise.all([this.history(backend, "dev"), this.history(backend, target)]);
    const appliedVersions = new Set(prodHistory.map((row) => Number(row.version)));
    const pending = devHistory.filter((row) => !appliedVersions.has(Number(row.version)));

    const operations: PromoteOperationPreview[] = [];
    for (const row of pending) {
      try {
        const prepared = await this.engine.dryRun({ backend, environment: target, operation: row.operation, authorId: ctx.userId });
        operations.push({
          version: Number(row.version),
          kind: row.operation.kind,
          collection: (row.operation as { collection?: string }).collection,
          sql: prepared.upSql,
          reversible: prepared.reversible,
          destructive: prepared.destructive,
          requiresSnapshot: prepared.requiresSnapshot,
        });
      } catch (error) {
        throw new DataStudioError(
          409,
          "promote",
          `Migration ${row.version} cannot be applied to ${target}: ${error instanceof Error ? error.message : "unknown error"}`,
          false,
          "PROMOTE_BLOCKED",
        );
      }
    }

    const [devSchema, prodSchema] = await Promise.all([
      this.provider.introspectSchema(backend, "dev"),
      this.provider.introspectSchema(backend, target),
    ]);
    const devTables = this.summarizeSchema(devSchema);
    const prodTables = this.summarizeSchema(prodSchema);
    const addedCollections = [...devTables.keys()].filter((name) => !name.startsWith(MANAGED_PREFIX) && !prodTables.has(name)).sort();
    const removedCollections = [...prodTables.keys()].filter((name) => !name.startsWith(MANAGED_PREFIX) && !devTables.has(name)).sort();
    const changedCollections = [...devTables.keys()]
      .filter((name) => !name.startsWith(MANAGED_PREFIX) && prodTables.has(name) && JSON.stringify(devTables.get(name)) !== JSON.stringify(prodTables.get(name)))
      .sort();

    const dataPreview: PromoteDataPreview[] = [];
    if (withData) {
      const shared = [...devTables.keys()].filter((name) => !name.startsWith(MANAGED_PREFIX) && prodTables.has(name)).sort();
      for (const collection of shared) dataPreview.push({ collection, rows: await this.rowCount(backend, "dev", collection) });
    }
    // Rows a destructive plan would touch in the target environment (prod is authoritative here).
    const affected = new Set<string>([
      ...removedCollections,
      ...operations.filter((operation) => operation.destructive && operation.collection).map((operation) => operation.collection!),
    ]);
    for (const collection of [...affected].sort()) {
      if (!prodTables.has(collection)) continue;
      dataPreview.push({ collection: `${collection} (prod, affected)`, rows: await this.rowCount(backend, target, collection) });
    }

    const destructive = operations.some((operation) => operation.destructive) || removedCollections.length > 0;
    return {
      backendId: backend.id,
      backendName: backend.name,
      targetEnvironment: target,
      approvalRequired: true,
      destructive,
      requiresSnapshot: destructive || operations.some((operation) => operation.requiresSnapshot),
      reversible: operations.every((operation) => operation.reversible),
      operations,
      pendingVersions: pending.map((row) => Number(row.version)),
      alreadyApplied: prodHistory.map((row) => Number(row.version)),
      addedCollections,
      removedCollections,
      changedCollections,
      dataPreview,
      affectedData: dataPreview.filter((entry) => entry.collection.includes("(prod, affected)")),
      withData,
      drift: { status: drift.status, actual: drift.actual, expected: drift.expected },
    };
  }

  private async copyRows(backend: DataBackend, environment: DataEnvironmentName, collection: string, limit: number): Promise<number> {
    const safe = validateIdentifier(collection);
    const [source, targetConnection] = await Promise.all([
      this.provisioner.getConnection(backend, "dev", "migrator"),
      this.provisioner.getConnection(backend, environment, "migrator"),
    ]);
    const sourcePool = new Pool({ ...source, max: 1, connectionTimeoutMillis: 3000 });
    const targetPool = new Pool({ ...targetConnection, max: 1, connectionTimeoutMillis: 3000 });
    try {
      const sourceColumns = await sourcePool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [safe],
      );
      const targetColumns = await targetPool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [safe],
      );
      const targetNames = new Set(targetColumns.rows.map((row) => row.column_name));
      const columns = sourceColumns.rows.map((row) => row.column_name).filter((name) => targetNames.has(name));
      if (!columns.length) return 0;
      const rows = await sourcePool.query(`SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(safe)} LIMIT $1`, [limit]);
      let copied = 0;
      for (const row of rows.rows as Array<Record<string, unknown>>) {
        const values = columns.map((column) => row[column]);
        await targetPool.query(
          `INSERT INTO ${quoteIdentifier(safe)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map((_c, index) => `$${index + 1}`).join(", ")}) ON CONFLICT DO NOTHING`,
          values,
        );
        copied += 1;
      }
      return copied;
    } finally {
      await sourcePool.end().catch(() => undefined);
      await targetPool.end().catch(() => undefined);
    }
  }

  async apply(
    ctx: AuthContext,
    companyId: string,
    backendId: string,
    options: { approved?: boolean; withData?: boolean; targetEnvironment?: DataEnvironmentName; runId?: string; agentId?: string } = {},
  ): Promise<PromoteResult> {
    const target = options.targetEnvironment ?? "prod";
    const backend = await this.repository.get(ctx, companyId, backendId);
    const preview = await this.preview(ctx, companyId, backendId, { withData: options.withData, targetEnvironment: target });
    if (!options.approved) {
      throw new DataStudioError(
        409,
        "promote",
        `APPROVAL_REQUIRED: promoting ${preview.operations.length} migration(s) to ${target} needs human approval` +
        (preview.destructive ? " (the plan contains destructive changes)" : "") + ".",
        false,
        "APPROVAL_REQUIRED",
      );
    }

    const token = randomUUID();
    if (!await this.repository.acquireLock(backend.id, target, token, PROMOTE_LOCK_TTL_MS)) {
      throw new DataStudioError(409, "promote", "Another promotion or migration is already running for this environment", true, "PROMOTE_BUSY");
    }

    const promotion: DataBackendPromotion = {
      id: randomUUID(),
      workspaceId: backend.workspaceId,
      companyId: backend.companyId,
      backendId: backend.id,
      targetEnvironment: target,
      status: "previewed",
      diff: preview.operations.map((operation) => ({ version: operation.version, kind: operation.kind, collection: operation.collection, sql: operation.sql })),
      flags: {
        destructive: preview.destructive,
        requiresSnapshot: preview.requiresSnapshot,
        reversible: preview.reversible,
        collections: preview.addedCollections.length + preview.changedCollections.length,
        withData: preview.withData,
      },
      snapshotRef: null,
      withData: preview.withData,
      approvedBy: ctx.userId,
      error: null,
      createdAt: new Date().toISOString(),
      appliedAt: null,
    };

    let snapshot: ProjectSnapshot | undefined;
    let appliedOperations = 0;
    let copiedRows = 0;
    try {
      snapshot = await this.provisioner.snapshot(backend, target);
      await this.repository.insertSnapshot(backend.id, target, {
        id: snapshot.id,
        path: snapshot.path,
        kind: "pre_promote" as SnapshotKind,
        reason: `Promote of ${preview.operations.length} migration(s) from dev`,
        createdBy: ctx.userId,
      });
      await this.repository.insertPromotion({ ...promotion, snapshotRef: snapshot.id });

      const devHistory = await this.history(backend, "dev");
      const appliedVersions = new Set(preview.alreadyApplied);
      for (const row of devHistory) {
        const version = Number(row.version);
        if (appliedVersions.has(version)) continue;
        await this.engine.apply(ctx, {
          backend,
          environment: target,
          operation: row.operation,
          authorId: options.agentId || ctx.userId,
          runId: options.runId,
          lockToken: token,
        });
        appliedOperations += 1;
      }

      if (preview.withData) {
        const limit = Number(process.env.NPATI_PROMOTE_DATA_MAX_ROWS) || DEFAULT_MAX_DATA_ROWS;
        for (const entry of preview.dataPreview) copiedRows += await this.copyRows(backend, target, entry.collection, limit);
      }

      const policies = await this.repository.getAccessPolicies(ctx, companyId, backend.id, "dev");
      if (policies.length) {
        const connection = await this.provisioner.getConnection(backend, target, "migrator");
        const runtime = await this.provisioner.getConnection(backend, target, "runtime");
        const pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 3000 });
        const client = await pool.connect();
        const grouped = new Map<string, typeof policies>();
        for (const policy of policies) grouped.set(policy.collection, [...(grouped.get(policy.collection) ?? []), policy]);
        try {
          await client.query("BEGIN");
          for (const [collection, rules] of grouped) {
            for (const sql of RlsPolicyCompiler.compile(collection, rules).sql) await client.query(sql);
            await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${quoteIdentifier(collection)} TO ${quoteIdentifier(runtime.user)}`);
          }
          await client.query("COMMIT");
          for (const [collection, rules] of grouped) await this.repository.setCollectionAccessPolicies(ctx, companyId, backend.id, target, collection, rules);
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); await pool.end(); }
      }
      const dev = await this.repository.environment(ctx, companyId, backend.id, "dev");
      const prod = await this.repository.environment(ctx, companyId, backend.id, target);
      await this.repository.setEnvironment(ctx, companyId, backend.id, target, { providerConfig: { ...prod.providerConfig, ...(dev.providerConfig.commerce === true ? { commerce: true } : {}), ...(dev.providerConfig.gdprStrategies ? { gdprStrategies: dev.providerConfig.gdprStrategies } : {}) } });

      const schema = await this.provider.introspectSchema(backend, target);
      const fingerprint = this.provider.schemaFingerprint(schema);
      await this.repository.setExpectedSchema(ctx, companyId, backend.id, target, schema, fingerprint);
      await this.repository.updatePromotion(promotion.id, { status: "applied", appliedAt: new Date().toISOString() });
      return { promotionId: promotion.id, status: "applied", appliedOperations, fingerprint, snapshotId: snapshot.id, copiedRows };
    } catch (error) {
      await this.repository.insertPromotion({
        ...promotion,
        status: "failed",
        snapshotRef: snapshot?.id ?? null,
        error: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
      }).catch(() => undefined);
      throw error;
    } finally {
      await this.repository.releaseLock(backend.id, target, token).catch(() => undefined);
    }
  }

  async listPromotions(ctx: AuthContext, companyId: string, backendId: string, limit = 20): Promise<DataBackendPromotion[]> {
    await this.repository.get(ctx, companyId, backendId);
    return this.repository.listPromotions(backendId, limit);
  }

  /** Marks a reviewed-and-declined promote so the decision is auditable. */
  async reject(ctx: AuthContext, companyId: string, backendId: string, options: { reason?: string } = {}): Promise<DataBackendPromotion> {
    const backend = await this.repository.get(ctx, companyId, backendId);
    const promotion: DataBackendPromotion = {
      id: randomUUID(),
      workspaceId: backend.workspaceId,
      companyId: backend.companyId,
      backendId: backend.id,
      targetEnvironment: "prod",
      status: "rejected",
      diff: [],
      flags: { destructive: false, requiresSnapshot: false, reversible: true, collections: 0, withData: false },
      snapshotRef: null,
      withData: false,
      approvedBy: ctx.userId,
      error: options.reason?.slice(0, 500) ?? null,
      createdAt: new Date().toISOString(),
      appliedAt: null,
    };
    await this.repository.insertPromotion(promotion);
    return promotion;
  }
}
