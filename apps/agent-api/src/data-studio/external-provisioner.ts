import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import { DataStudioError, quoteIdentifier } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataEnvironmentName, DatabaseRole, ProjectDatabaseConnection, ProjectDatabaseUsage, ProjectSnapshot } from "./types";

export interface ExternalProvisionerConfig {
  snapshotDirectory: string;
}

/** Result of checking whether an external database can host managed roles and RLS. */
export interface ExternalCapabilityReport {
  mode: "managed" | "restricted";
  serverVersion: string;
  rlsSupported: boolean;
  canCreateRoles: boolean;
  ownerIsSuperuser: boolean;
  ownerBypassesRls: boolean;
  reason?: string;
}

function ownerContext(backend: DataBackend): AuthContext {
  return { userId: backend.createdBy, workspaceId: backend.workspaceId, permissions: [] };
}

function databaseNameFromConnection(connection: { database?: string }): string {
  return connection.database ?? "postgres";
}

async function runPgTool(command: "pg_dump" | "pg_restore", args: string[], secret: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, env: { ...process.env, PGPASSWORD: secret }, stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(-2000); });
    child.on("error", () => reject(new DataStudioError(503, command, "PostgreSQL backup utility unavailable", true, "BACKUP_TOOL_UNAVAILABLE")));
    child.on("close", (code) => code === 0 ? resolve() : reject(new DataStudioError(500, command, `PostgreSQL backup utility failed: ${errorText.slice(-300)}`, false, "BACKUP_FAILED")));
  });
}

function parseConnectionUrl(raw: string): { host: string; port: number; user: string; password: string; database: string; ssl: boolean } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DataStudioError(400, "external", "External connection string is not a valid URL", false, "INVALID_CONNECTION_STRING");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new DataStudioError(400, "external", "External connection string must use the postgres:// scheme", false, "INVALID_CONNECTION_STRING");
  }
  return {
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    ssl: /(?:^|[?&])sslmode=(?!disable)/.test(url.search),
  };
}

/**
 * D7 external databases: the owner brings their own Postgres (Neon, Supabase, RDS, …).
 *
 * The connection string lives in Core secret storage. Before the backend is usable NPATI
 * introspects the target and tries to create a separate migrator and a separate runtime role:
 *  - `managed`    – both roles exist, RLS is supported; behaviour matches postgres-projects;
 *  - `restricted` – roles cannot be created (managed providers); NPATI then uses the owner
 *                   credentials for migrations and data, and says so explicitly.
 * Drift detection runs before every migration and promote because such databases can be
 * changed outside NPATI.
 */
export class ExternalPostgresProvisioner implements DatabaseProvisioner {
  constructor(private readonly repository: DataBackendRepository, private readonly config: ExternalProvisionerConfig) {}

  private async connectionString(backend: DataBackend, environment: DataEnvironmentName): Promise<string> {
    return this.repository.resolveSecret(ownerContext(backend), backend.companyId, backend.id, environment, "external_owner");
  }

  private async pool(backend: DataBackend, environment: DataEnvironmentName): Promise<Pool> {
    const parsed = parseConnectionUrl(await this.connectionString(backend, environment));
    return new Pool({
      host: parsed.host, port: parsed.port, user: parsed.user, password: parsed.password, database: parsed.database,
      ssl: parsed.ssl ? { rejectUnauthorized: false } : undefined, max: 2, connectionTimeoutMillis: 5000,
    });
  }

  /** Introspects the external database and decides between managed and restricted mode. */
  async inspectCapabilities(backend: DataBackend, environment: DataEnvironmentName): Promise<ExternalCapabilityReport> {
    const connectionUrl = await this.connectionString(backend, environment);
    const parsed = parseConnectionUrl(connectionUrl);
    const pool = await this.pool(backend, environment);
    try {
      const version = await pool.query<{ version: string }>("SHOW server_version");
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
        "SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user",
      );
      const serverVersion = version.rows[0]?.version ?? "unknown";
      const rlsSupported = Number(serverVersion.split(".")[0]) >= 9;
      const owner = role.rows[0];
      const canCreateRoles = Boolean(owner?.rolsuper || owner?.rolcreaterole);
      const reasons: string[] = [];
      if (!canCreateRoles) reasons.push("the owner role cannot create roles");
      if (!rlsSupported) reasons.push("server version does not report RLS support");
      const mode = canCreateRoles && rlsSupported ? "managed" : "restricted";
      if (owner?.rolbypassrls) reasons.push("the owner role bypasses RLS");
      const report: ExternalCapabilityReport = {
        mode,
        serverVersion,
        rlsSupported,
        canCreateRoles,
        ownerIsSuperuser: Boolean(owner?.rolsuper),
        ownerBypassesRls: Boolean(owner?.rolbypassrls),
        reason: reasons.length ? reasons.join("; ") : undefined,
      };
      return report;
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  async provisionDatabase(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    if (backend.provider !== "external_postgres") throw new DataStudioError(400, "provision", "Backend is not an external database", false, "UNSUPPORTED_PROVIDER");
    const parsed = parseConnectionUrl(await this.connectionString(backend, environment));
    const report = await this.inspectCapabilities(backend, environment);
    const ctx = ownerContext(backend);
    const stem = "npati_" + backend.id.replace(/-/g, "").slice(0, 20) + "_" + environment;
    let providerConfig: Record<string, unknown> = {
      external: { host: parsed.host, port: parsed.port, database: parsed.database, mode: report.mode, reason: report.reason, serverVersion: report.serverVersion },
    };
    if (report.mode === "managed") {
      const migratorPassword = randomBytes(32).toString("hex");
      const runtimePassword = randomBytes(32).toString("hex");
      const pool = await this.pool(backend, environment);
      try {
        await pool.query(`CREATE ROLE ${quoteIdentifier(stem + "_m")} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD '${migratorPassword}'`);
        await pool.query(`CREATE ROLE ${quoteIdentifier(stem + "_r")} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD '${runtimePassword}'`);
        await pool.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(stem + "_r")}`);
        await pool.query(`GRANT ALL ON SCHEMA public TO ${quoteIdentifier(stem + "_m")}`);
      } catch (error) {
        // Managed providers can refuse role creation at any point: fall back explicitly.
        providerConfig = {
          external: { ...(providerConfig.external as Record<string, unknown>), mode: "restricted", reason: error instanceof Error ? error.message.slice(0, 300) : "role creation refused" },
        };
        await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, {
          status: "ready", providerConfig,
        });
        return;
      } finally {
        await pool.end().catch(() => undefined);
      }
      const migratorRef = await this.repository.putSecret(ctx, backend.companyId, backend.id, environment, "migrator", migratorPassword);
      const runtimeRef = await this.repository.putSecret(ctx, backend.companyId, backend.id, environment, "runtime", runtimePassword);
      await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, {
        status: "ready", providerConfig, migratorSecretRef: migratorRef, runtimeSecretRef: runtimeRef,
      });
      return;
    }
    await this.repository.setEnvironment(ctx, backend.companyId, backend.id, environment, { status: "ready", providerConfig });
  }

  async deprovisionDatabase(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    // External databases are never dropped: only the NPATI-managed roles are removed.
    const env = await this.repository.environment(ownerContext(backend), backend.companyId, backend.id, environment).catch(() => null);
    const mode = (env?.providerConfig?.external as { mode?: string } | undefined)?.mode;
    if (mode !== "managed") return;
    const stem = "npati_" + backend.id.replace(/-/g, "").slice(0, 20) + "_" + environment;
    const pool = await this.pool(backend, environment).catch(() => null);
    if (!pool) return;
    try {
      await pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(stem + "_r")}`).catch(() => undefined);
      await pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(stem + "_m")}`).catch(() => undefined);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  async getConnection(backend: DataBackend, environment: DataEnvironmentName, role: DatabaseRole): Promise<ProjectDatabaseConnection> {
    const parsed = parseConnectionUrl(await this.connectionString(backend, environment));
    const env = await this.repository.environment(ownerContext(backend), backend.companyId, backend.id, environment);
    const mode = (env.providerConfig?.external as { mode?: string } | undefined)?.mode;
    const base: ProjectDatabaseConnection = { host: parsed.host, port: parsed.port, database: parsed.database, user: parsed.user, password: parsed.password, ssl: parsed.ssl };
    if (mode !== "managed" || role === "provisioner") return base;
    const stem = "npati_" + backend.id.replace(/-/g, "").slice(0, 20) + "_" + environment;
    const secretRole = role === "migrator" ? "migrator" : "runtime";
    const secret = await this.repository.resolveSecret(ownerContext(backend), backend.companyId, backend.id, environment, secretRole);
    return { ...base, user: stem + (role === "migrator" ? "_m" : "_r"), password: secret };
  }

  async rotateCredentials(backend: DataBackend, environment: DataEnvironmentName, role: DatabaseRole): Promise<void> {
    if (role === "provisioner") throw new DataStudioError(400, "rotate", "External owner credentials are rotated by the provider", false, "UNSUPPORTED_ROTATION");
    const env = await this.repository.environment(ownerContext(backend), backend.companyId, backend.id, environment);
    const mode = (env.providerConfig?.external as { mode?: string } | undefined)?.mode;
    if (mode !== "managed") throw new DataStudioError(409, "rotate", "Rotate credentials in the external provider; NPATI manages no roles here", false, "EXTERNAL_RESTRICTED_MODE");
    const stem = "npati_" + backend.id.replace(/-/g, "").slice(0, 20) + "_" + environment;
    const next = randomBytes(32).toString("hex");
    const pool = await this.pool(backend, environment);
    try {
      await pool.query(`ALTER ROLE ${quoteIdentifier(stem + (role === "migrator" ? "_m" : "_r"))} PASSWORD '${next}'`);
      await this.repository.putSecret(ownerContext(backend), backend.companyId, backend.id, environment, role === "migrator" ? "migrator" : "runtime", next);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  async suspendRuntime(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    const env = await this.repository.environment(ownerContext(backend), backend.companyId, backend.id, environment).catch(() => null);
    const mode = (env?.providerConfig?.external as { mode?: string } | undefined)?.mode;
    if (mode !== "managed") return;
    const stem = "npati_" + backend.id.replace(/-/g, "").slice(0, 20) + "_" + environment;
    const pool = await this.pool(backend, environment).catch(() => null);
    if (!pool) return;
    try {
      await pool.query(`ALTER ROLE ${quoteIdentifier(stem + "_r")} NOLOGIN`);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  async resumeRuntime(backend: DataBackend, environment: DataEnvironmentName): Promise<void> {
    const env = await this.repository.environment(ownerContext(backend), backend.companyId, backend.id, environment).catch(() => null);
    const mode = (env?.providerConfig?.external as { mode?: string } | undefined)?.mode;
    if (mode !== "managed") return;
    const stem = "npati_" + backend.id.replace(/-/g, "").slice(0, 20) + "_" + environment;
    const pool = await this.pool(backend, environment).catch(() => null);
    if (!pool) return;
    try {
      await pool.query(`ALTER ROLE ${quoteIdentifier(stem + "_r")} LOGIN`);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  async snapshot(backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectSnapshot> {
    const parsed = parseConnectionUrl(await this.connectionString(backend, environment));
    await mkdir(this.config.snapshotDirectory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const filePath = path.join(this.config.snapshotDirectory, id + ".dump");
    await runPgTool("pg_dump", ["-h", parsed.host, "-p", String(parsed.port), "-U", parsed.user, "-d", databaseNameFromConnection(parsed), "-Fc", "-f", filePath], parsed.password);
    await chmod(filePath, 0o600);
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
    const parsed = parseConnectionUrl(await this.connectionString(backend, environment));
    const migrator = await this.getConnection(backend, environment, "migrator");
    await runPgTool("pg_restore", ["-h", parsed.host, "-p", String(parsed.port), "-U", migrator.user,
      "-d", parsed.database, "--clean", "--if-exists", "--no-owner", snapshot.path], migrator.password);
  }

  async getUsage(backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectDatabaseUsage> {
    const pool = await this.pool(backend, environment);
    try {
      const result = await pool.query<{ bytes: string; connections: string }>(
        "SELECT pg_database_size(current_database())::text AS bytes, (SELECT count(*)::text FROM pg_stat_activity WHERE datname=current_database()) AS connections",
      );
      return { bytes: Number(result.rows[0]!.bytes), connections: Number(result.rows[0]!.connections) };
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
}
