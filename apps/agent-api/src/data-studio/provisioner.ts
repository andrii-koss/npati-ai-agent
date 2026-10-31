import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import type { AuthContext } from "@npati/workspace";
import { DataStudioError, quoteIdentifier } from "./identifier";
import type { DataBackend, DataBackendEnvironment, DataEnvironmentName, DatabaseRole, ProjectDatabaseConnection, ProjectDatabaseUsage, ProjectSnapshot } from "./types";
import type { DataBackendRepository } from "./repository";

export interface DatabaseProvisioner {
  provisionDatabase(backend: DataBackend, environment: DataEnvironmentName): Promise<void>;
  deprovisionDatabase(backend: DataBackend, environment: DataEnvironmentName): Promise<void>;
  getConnection(backend: DataBackend, environment: DataEnvironmentName, role: DatabaseRole): Promise<ProjectDatabaseConnection>;
  rotateCredentials(backend: DataBackend, environment: DataEnvironmentName, role: DatabaseRole): Promise<void>;
  suspendRuntime(backend: DataBackend, environment: DataEnvironmentName): Promise<void>;
  /** D7: reverses `suspendRuntime` so an archived DataBackend can be activated again. */
  resumeRuntime(backend: DataBackend, environment: DataEnvironmentName): Promise<void>;
  snapshot(backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectSnapshot>;
  restoreSnapshot(backend: DataBackend, environment: DataEnvironmentName, snapshot: ProjectSnapshot): Promise<void>;
  /** Whether the environment's physical database exists. A provider that cannot tell omits it. */
  databaseExists?(backend: DataBackend, environment: DataEnvironmentName): Promise<boolean>;
  getUsage(backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectDatabaseUsage>;
}

export interface SharedPostgresConfig {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  maintenanceDatabase: string;
  snapshotDirectory: string;
}

/**
 * D7: DataBackends can live on the shared `postgres-projects` cluster or on an external
 * Postgres the owner provides. Every consumer keeps depending on `DatabaseProvisioner`;
 * this router only picks the implementation for the backend being addressed.
 */
export class ProvisionerRouter implements DatabaseProvisioner {
  constructor(
    private readonly shared?: DatabaseProvisioner,
    private readonly external?: DatabaseProvisioner,
  ) {}

  private pick(backend: DataBackend): DatabaseProvisioner {
    const provisioner = backend.provider === "external_postgres" ? this.external : this.shared;
    if (!provisioner) {
      throw new DataStudioError(
        503,
        "provision",
        backend.provider === "external_postgres"
          ? "External database support is not configured on this installation"
          : "The shared project database (postgres-projects) is not configured on this installation",
        false,
        "PROVISIONER_UNAVAILABLE",
      );
    }
    return provisioner;
  }

  provisionDatabase(backend: DataBackend, environment: DataEnvironmentName) { return this.pick(backend).provisionDatabase(backend, environment); }
  deprovisionDatabase(backend: DataBackend, environment: DataEnvironmentName) { return this.pick(backend).deprovisionDatabase(backend, environment); }
  getConnection(backend: DataBackend, environment: DataEnvironmentName, role: DatabaseRole) { return this.pick(backend).getConnection(backend, environment, role); }
  rotateCredentials(backend: DataBackend, environment: DataEnvironmentName, role: DatabaseRole) { return this.pick(backend).rotateCredentials(backend, environment, role); }
  suspendRuntime(backend: DataBackend, environment: DataEnvironmentName) { return this.pick(backend).suspendRuntime(backend, environment); }
  resumeRuntime(backend: DataBackend, environment: DataEnvironmentName) { return this.pick(backend).resumeRuntime(backend, environment); }
  snapshot(backend: DataBackend, environment: DataEnvironmentName) { return this.pick(backend).snapshot(backend, environment); }
  restoreSnapshot(backend: DataBackend, environment: DataEnvironmentName, snapshot: ProjectSnapshot) { return this.pick(backend).restoreSnapshot(backend, environment, snapshot); }
  databaseExists(backend: DataBackend, environment: DataEnvironmentName) { const provisioner = this.pick(backend); return provisioner.databaseExists ? provisioner.databaseExists(backend, environment) : Promise.resolve(true); }
  getUsage(backend: DataBackend, environment: DataEnvironmentName) { return this.pick(backend).getUsage(backend, environment); }

  async close() {
    await (this.shared as { close?: () => Promise<void> } | undefined)?.close?.().catch(() => undefined);
    await (this.external as { close?: () => Promise<void> } | undefined)?.close?.().catch(() => undefined);
  }
}

function ownerContext(backend: DataBackend): AuthContext {
  return { userId: backend.createdBy, workspaceId: backend.workspaceId, permissions: [] };
}

function objectNames(backend: DataBackend, environment: DataEnvironmentName) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(backend.id)) {
    throw new DataStudioError(400, "provision", "Invalid backend identifier", false, "INVALID_BACKEND_ID");
  }
  const stem = "db_" + backend.id.replace(/-/g, "").toLowerCase() + "_" + environment;
  return { database: stem, migrator: stem + "_m", runtime: stem + "_r" };
}

function password(): string { return randomBytes(32).toString("hex"); }

const ROLE_OPTIONS = { migrator: " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD '", runtime: " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD '" } as const;

async function runPgTool(command: "pg_dump" | "pg_restore", args: string[], secret: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, PGPASSWORD: secret },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(-2000); });
    child.on("error", () => reject(new DataStudioError(503, command, "PostgreSQL backup utility unavailable", true, "BACKUP_TOOL_UNAVAILABLE")));
    child.on("close", (code) => code === 0 ? resolve() : reject(new DataStudioError(500, command, "PostgreSQL backup utility failed", false, "BACKUP_FAILED")));
  });
}

export class SharedPostgresProvisioner implements DatabaseProvisioner {
  private readonly adminPool: Pool;

  constructor(private readonly config: SharedPostgresConfig, private readonly repository: DataBackendRepository) {
    this.adminPool = new Pool({
      host: config.host, port: config.port, user: config.adminUser, password: config.adminPassword,
      database: config.maintenanceDatabase, max: 2, connectionTimeoutMillis: 3000,
    });
  }

  private adminConnection(database: string): ProjectDatabaseConnection {
    return { host: this.config.host, port: this.config.port, database, user: this.config.adminUser, password: this.config.adminPassword };
  }

  async getConnection(backend: DataBackend, environment: DataEnvironmentName, role: DatabaseRole): Promise<ProjectDatabaseConnection> {
    const names = objectNames(backend, environment);
    if (role === "provisioner") return this.adminConnection(names.database);
    const secret = await this.repository.resolveSecret(ownerContext(backend), backend.companyId, backend.id, environment, role);
    return { host: this.config.host, port: this.config.port, database: names.database, user: names[role], password: secret };
  }

  async provisionDatabase(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    if (backend.provider !== "shared_postgres") throw new DataStudioError(400, "provision", "Unsupported provider", false, "UNSUPPORTED_PROVIDER");
    const names = objectNames(backend, environment);
    const migratorPassword = password();
    const runtimePassword = password();
    const client = await this.adminPool.connect().catch(() => { throw new DataStudioError(503, "provision", "Project database unavailable", true, "PROJECT_DATABASE_UNAVAILABLE"); });
    const lockKey = "npati:" + names.database;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockKey]);
      const existing = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [names.database]);
      if (existing.rowCount) throw new DataStudioError(409, "provision", "Project database already exists", false, "DATABASE_EXISTS");
      await client.query("CREATE ROLE " + quoteIdentifier(names.migrator) + ROLE_OPTIONS.migrator + migratorPassword + "'");
      await client.query("CREATE ROLE " + quoteIdentifier(names.runtime) + ROLE_OPTIONS.runtime + runtimePassword + "'");
      await this.createDatabaseObjects(client, names);
      const ctx = ownerContext(backend);
      const migratorRef = await this.repository.putSecret(ctx, backend.companyId, backend.id, environment, "migrator", migratorPassword);
      const runtimeRef = await this.repository.putSecret(ctx, backend.companyId, backend.id, environment, "runtime", runtimePassword);
      await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, {
        status: "ready", providerConfig: { database: names.database, host: this.config.host, port: this.config.port },
        migratorSecretRef: migratorRef, runtimeSecretRef: runtimeRef,
      });
    } catch (error) {
      if (!(error instanceof DataStudioError && error.code === "DATABASE_EXISTS")) {
        await client.query("DROP DATABASE IF EXISTS " + quoteIdentifier(names.database) + " WITH (FORCE)").catch(() => undefined);
        await client.query("DROP ROLE IF EXISTS " + quoteIdentifier(names.runtime)).catch(() => undefined);
        await client.query("DROP ROLE IF EXISTS " + quoteIdentifier(names.migrator)).catch(() => undefined);
        const ctx = ownerContext(backend);
        await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { status: "unavailable" }).catch(() => undefined);
      }
      throw error;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  /** The database, its grants and per-role limits, as provisioned. Shared by provisioning and the recovery of a lost database. */
  private async createDatabaseObjects(client: PoolClient, names: ReturnType<typeof objectNames>): Promise<void> {
    await client.query("CREATE DATABASE " + quoteIdentifier(names.database) + " OWNER " + quoteIdentifier(names.migrator));
    await client.query("REVOKE ALL ON DATABASE " + quoteIdentifier(names.database) + " FROM PUBLIC");
    await client.query("GRANT CONNECT ON DATABASE " + quoteIdentifier(names.database) + " TO " + quoteIdentifier(names.migrator) + ", " + quoteIdentifier(names.runtime));
    await client.query("ALTER ROLE " + quoteIdentifier(names.migrator) + " IN DATABASE " + quoteIdentifier(names.database) + " SET statement_timeout = '30s'");
    await client.query("ALTER ROLE " + quoteIdentifier(names.runtime) + " IN DATABASE " + quoteIdentifier(names.database) + " SET statement_timeout = '5s'");
    await client.query("ALTER ROLE " + quoteIdentifier(names.migrator) + " IN DATABASE " + quoteIdentifier(names.database) + " SET idle_in_transaction_session_timeout = '30s'");
    await client.query("ALTER ROLE " + quoteIdentifier(names.runtime) + " IN DATABASE " + quoteIdentifier(names.database) + " SET idle_in_transaction_session_timeout = '5s'");
    const projectPool = new Pool({ ...this.adminConnection(names.database), max: 1 });
    try {
      await projectPool.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await projectPool.query("GRANT USAGE ON SCHEMA public TO " + quoteIdentifier(names.runtime));
      await projectPool.query("GRANT ALL ON SCHEMA public TO " + quoteIdentifier(names.migrator));
    } finally { await projectPool.end(); }
  }

  /** Recreates a lost environment database under the provisioning lock, so a snapshot can be restored into it.
   * Cluster roles normally survive; a missing role is recreated with its stored secret, so credentials stay valid. */
  private async recreateLostDatabase(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    const names = objectNames(backend, environment);
    const client = await this.adminPool.connect().catch(() => { throw new DataStudioError(503, "restore", "Project database unavailable", true, "PROJECT_DATABASE_UNAVAILABLE"); });
    const lockKey = "npati:" + names.database;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockKey]);
      if ((await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [names.database])).rowCount) return;
      for (const role of ["migrator", "runtime"] as const) {
        if ((await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [names[role]])).rowCount) continue;
        const secret = await this.repository.resolveSecret(ownerContext(backend), backend.companyId, backend.id, environment, role);
        if (!/^[0-9a-f]{64}$/.test(secret)) throw new DataStudioError(409, "restore", "Stored credential cannot recreate the database role", false, "ROLE_RECOVERY_UNAVAILABLE");
        await client.query("CREATE ROLE " + quoteIdentifier(names[role]) + ROLE_OPTIONS[role] + secret + "'");
      }
      await this.createDatabaseObjects(client, names);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async databaseExists(backend: DataBackend, environment: DataEnvironmentName): Promise<boolean> {
    return Boolean((await this.adminPool.query("SELECT 1 FROM pg_database WHERE datname=$1", [objectNames(backend, environment).database])).rowCount);
  }

  async deprovisionDatabase(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    const names = objectNames(backend, environment);
    const client = await this.adminPool.connect();
    try {
      await client.query("DROP DATABASE IF EXISTS " + quoteIdentifier(names.database) + " WITH (FORCE)");
      await client.query("DROP ROLE IF EXISTS " + quoteIdentifier(names.runtime));
      await client.query("DROP ROLE IF EXISTS " + quoteIdentifier(names.migrator));
    } finally { client.release(); }
  }

  async rotateCredentials(backend: DataBackend, environment: DataEnvironmentName, role: DatabaseRole): Promise<void> {
    if (role === "provisioner") throw new DataStudioError(400, "rotate", "Admin rotation is cluster configuration", false, "UNSUPPORTED_ROTATION");
    const names = objectNames(backend, environment);
    const next = password();
    const client = await this.adminPool.connect();
    try {
      await client.query("ALTER ROLE " + quoteIdentifier(names[role]) + " PASSWORD '" + next + "'");
      await this.repository.putSecret(ownerContext(backend), backend.companyId, backend.id, environment, role, next);
    } finally { client.release(); }
  }

  async suspendRuntime(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    const names = objectNames(backend, environment);
    await this.adminPool.query("ALTER ROLE " + quoteIdentifier(names.runtime) + " NOLOGIN");
    await this.adminPool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND datname=$2 AND pid<>pg_backend_pid()",
      [names.runtime, names.database]);
  }

  async resumeRuntime(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    const names = objectNames(backend, environment);
    await this.adminPool.query("ALTER ROLE " + quoteIdentifier(names.runtime) + " LOGIN");
  }

  async snapshot(backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectSnapshot> {
    const names = objectNames(backend, environment);
    await mkdir(this.config.snapshotDirectory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const filePath = path.join(this.config.snapshotDirectory, id + ".dump");
    await runPgTool("pg_dump", ["-h", this.config.host, "-p", String(this.config.port), "-U", this.config.adminUser,
      "-d", names.database, "-Fc", "-f", filePath], this.config.adminPassword);
    await chmod(filePath, 0o600);
    await this.repository.pool.query(
      "INSERT INTO data_backend_snapshots(id,backend_id,environment,file_path,expires_at) VALUES($1,$2,$3,$4,now()+$5::integer * interval '1 day')",
      [id, backend.id, environment, filePath, Math.max(1, Number(process.env.NPATI_PROJECTS_SNAPSHOT_RETENTION_DAYS) || 30)],
    );
    return { id, backendId: backend.id, environment, path: filePath, createdAt: new Date().toISOString() };
  }

  async restoreSnapshot(backend: DataBackend, environment: DataEnvironmentName, snapshot: ProjectSnapshot): Promise<void> {
    if (snapshot.backendId !== backend.id || snapshot.environment !== environment ||
      !/^[0-9a-f-]{36}\.dump$/i.test(path.basename(snapshot.path)) ||
      path.dirname(path.resolve(snapshot.path)) !== path.resolve(this.config.snapshotDirectory)) {
      throw new DataStudioError(400, "restore", "Snapshot does not belong to environment", false, "INVALID_SNAPSHOT");
    }
    const record = await this.repository.pool.query("SELECT 1 FROM data_backend_snapshots WHERE id=$1 AND backend_id=$2 AND environment=$3 AND file_path=$4",
      [snapshot.id, backend.id, environment, snapshot.path]);
    if (!record.rowCount) throw new DataStudioError(404, "restore", "Snapshot reference not found", false, "SNAPSHOT_NOT_FOUND");
    await stat(snapshot.path);
    // A lost database is recreated first; pg_restore then rebuilds its schema and rows from the snapshot.
    if (!await this.databaseExists(backend, environment)) await this.recreateLostDatabase(backend, environment);
    const names = objectNames(backend, environment);
    const migrator = await this.getConnection(backend, environment, "migrator");
    await runPgTool("pg_restore", ["-h", this.config.host, "-p", String(this.config.port), "-U", migrator.user,
      "-d", names.database, "--clean", "--if-exists", "--no-owner", snapshot.path], migrator.password);
  }

  async getUsage(backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectDatabaseUsage> {
    const names = objectNames(backend, environment);
    const result = await this.adminPool.query<{ bytes: string; connections: string }>(
      "SELECT pg_database_size($1)::text AS bytes, (SELECT count(*)::text FROM pg_stat_activity WHERE datname=$1) AS connections",
      [names.database],
    );
    return { bytes: Number(result.rows[0]!.bytes), connections: Number(result.rows[0]!.connections) };
  }

  async close() { await this.adminPool.end(); }
}
