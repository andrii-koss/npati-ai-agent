import { CryptoVault, type AuthContext, type WorkspaceStore } from "@npati/workspace";
import type { DataBackendRepository } from "./repository";
import type { DataProvider, SchemaOperation, SchemaSnapshot } from "./data-provider";
import type { ProjectMigrationEngine } from "./migration-engine";
import type { DataEnvironmentName } from "./types";
import { DataStudioError, validateIdentifier } from "./identifier";
import { ProjectApiKeyManager } from "./api-key-manager";
import type { ProjectApiGatewayService } from "./gateway-service";

const maxImportBytes = 1_000_000;
const maxImportRows = 500;

type Row = Record<string, unknown>;

function csvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ""; }
    else if (char === '\n') { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new DataStudioError(400, "import", "Unclosed CSV quote", false, "INVALID_CSV");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function safeCsvCell(value: unknown): string {
  let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function validateRows(rows: Row[], table: SchemaSnapshot["tables"][number]) {
  const fields = new Map(table.columns.map((column) => [column.name, column]));
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new DataStudioError(400, "import", "Row must be an object", false, "INVALID_ROW");
    const clean: Row = {};
    for (const [name, value] of Object.entries(row)) {
      if (name === "id" && (value === "" || value == null)) continue;
      if (name === "id" || !fields.has(name)) throw new DataStudioError(400, "import", "Unknown or managed field: " + name, false, "INVALID_FIELD");
      const type = fields.get(name)!.type;
      if (value === "" || value == null) { clean[name] = null; continue; }
      if (/^(bigint|integer|numeric)/.test(type)) {
        if (!/^-?\d+(\.\d+)?$/.test(String(value))) throw new DataStudioError(400, "import", "Invalid number in " + name, false, "INVALID_TYPE");
        clean[name] = Number(value);
      } else if (type === "boolean") {
        if (!["true", "false"].includes(String(value))) throw new DataStudioError(400, "import", "Invalid boolean in " + name, false, "INVALID_TYPE");
        clean[name] = String(value) === "true";
      } else if (type === "uuid") {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))) throw new DataStudioError(400, "import", "Invalid UUID in " + name, false, "INVALID_TYPE");
        clean[name] = value;
      } else if (type === "jsonb") {
        try { clean[name] = typeof value === "string" ? JSON.parse(value) : value; }
        catch { throw new DataStudioError(400, "import", "Invalid JSON in " + name, false, "INVALID_TYPE"); }
      } else if (type === "date" || type.includes("timestamp")) {
        if (Number.isNaN(Date.parse(String(value)))) throw new DataStudioError(400, "import", "Invalid date in " + name, false, "INVALID_TYPE");
        clean[name] = value;
      } else {
        if (typeof value !== "string") throw new DataStudioError(400, "import", "Invalid text in " + name, false, "INVALID_TYPE");
        clean[name] = value;
      }
    }
    return clean;
  });
}

const VALID_FIELD_TYPES = new Set([
  "string", "text", "integer", "decimal", "boolean", "date", "datetime", "json", "uuid", "enum", "file_reference"
]);

export function validateOperation(operation: SchemaOperation): void {
  if (!operation || typeof operation !== "object") {
    throw new DataStudioError(400, "operation", "Invalid operation", false, "INVALID_OPERATION");
  }
  validateIdentifier(operation.collection);
  switch (operation.kind) {
    case "create_collection":
      if (!Array.isArray(operation.fields)) throw new DataStudioError(400, "operation", "Fields must be an array", false, "INVALID_FIELDS");
      for (const field of operation.fields) {
        validateIdentifier(field.name);
        if (!VALID_FIELD_TYPES.has(field.type)) throw new DataStudioError(400, "operation", `Invalid field type: ${field.type}`, false, "INVALID_FIELD_TYPE");
      }
      break;
    case "rename_collection":
      validateIdentifier(operation.next);
      break;
    case "add_field":
    case "alter_field":
      validateIdentifier(operation.field.name);
      if (!VALID_FIELD_TYPES.has(operation.field.type)) throw new DataStudioError(400, "operation", `Invalid field type: ${operation.field.type}`, false, "INVALID_FIELD_TYPE");
      break;
    case "drop_field":
      validateIdentifier(operation.field);
      break;
    case "create_relation":
      validateIdentifier(operation.target);
      validateIdentifier(operation.name);
      break;
    case "drop_relation":
      validateIdentifier(operation.name);
      break;
    case "create_index":
      if (!Array.isArray(operation.fields)) throw new DataStudioError(400, "operation", "Fields must be an array", false, "INVALID_FIELDS");
      for (const field of operation.fields) validateIdentifier(field);
      break;
  }
}

export class DataStudioUiService {
  private readonly vault = new CryptoVault();

  constructor(
    private readonly store: Pick<WorkspaceStore, "getProject">,
    private readonly repository: DataBackendRepository,
    private readonly provider: DataProvider,
    private readonly migrations: ProjectMigrationEngine,
    private readonly gateway?: ProjectApiGatewayService,
  ) {}

  private async context(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName) {
    if (environment !== "dev" && environment !== "prod") throw new DataStudioError(400, "environment", "Invalid environment", false, "INVALID_ENVIRONMENT");
    const project = await this.store.getProject(ctx, companyId, projectId);
    if (!project.dataBackendId) throw new DataStudioError(404, "project_data", "Project has no DataBackend", false, "DATA_BACKEND_NOT_ATTACHED");
    const backend = await this.repository.get(ctx, companyId, project.dataBackendId);
    const env = await this.repository.environment(ctx, companyId, backend.id, environment);
    return { backend, env, project };
  }

  async overview(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName) {
    const { backend, env } = await this.context(ctx, companyId, projectId, environment);
    const drift = env.status === "ready" ? await this.migrations.detectDrift(ctx, backend, environment) : null;
    const history = await this.repository.pool.query(
      "SELECT id,version,operation,reversible,destructive,requires_snapshot AS \"requiresSnapshot\",author_id AS \"authorId\",run_id AS \"runId\",status,created_at AS \"createdAt\",applied_at AS \"appliedAt\" FROM data_backend_migrations WHERE backend_id=$1 AND environment=$2 ORDER BY version DESC,created_at DESC LIMIT 100",
      [backend.id, environment],
    );
    const lock = await this.repository.pool.query(
      'SELECT owner_token AS "ownerToken",acquired_at AS "createdAt",expires_at AS "expiresAt" FROM data_backend_migration_locks WHERE backend_id=$1 AND environment=$2 AND expires_at>now()',
      [backend.id, environment],
    );
    return { backend, environment: { environment, status: env.status, syncStatus: drift?.status ?? env.syncStatus, schemaFingerprint: env.schemaFingerprint },
      schema: drift?.schema ?? null, expectedSchema: env.expectedSchema ?? null,
      drift: drift ? { actual: drift.actual, expected: drift.expected, tables: schemaDiff(env.expectedSchema as SchemaSnapshot | null, drift.schema) } : null,
      lock: lock.rows[0] ? { held: true, createdAt: lock.rows[0].createdAt, expiresAt: lock.rows[0].expiresAt } : { held: false },
      migrations: history.rows };
  }

  private async writable(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName) {
    const { backend, env } = await this.context(ctx, companyId, projectId, environment);
    if (environment !== "dev") throw new DataStudioError(409, "environment", "Production schema changes require Promote", false, "PROMOTE_REQUIRED");
    if (backend.status !== "ready" || env.status !== "ready") throw new DataStudioError(409, "data_studio", "Backend is not ready", false, "BACKEND_NOT_READY");
    if (env.syncStatus !== "synced") throw new DataStudioError(409, "drift", "Schema drift blocks changes", false, "DRIFT_BLOCKED");
    return { backend, env };
  }


  async preview(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName, operation: SchemaOperation) {
    validateOperation(operation);
    const { backend } = await this.writable(ctx, companyId, projectId, environment);
    return this.migrations.dryRun({ backend, environment, operation, authorId: ctx.userId });
  }

  async apply(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName,
    input: { operation: SchemaOperation; expectedFingerprint: string; confirmDestructive?: boolean }) {
    validateOperation(input.operation);
    const { backend, env } = await this.writable(ctx, companyId, projectId, environment);
    if (env.schemaFingerprint !== input.expectedFingerprint) throw new DataStudioError(409, "apply", "Schema changed since preview", false, "STALE_SCHEMA");
    const preview = await this.migrations.dryRun({ backend, environment, operation: input.operation, authorId: ctx.userId });
    if ((preview.destructive || preview.requiresSnapshot) && !input.confirmDestructive) throw new DataStudioError(409, "apply", "Destructive change requires confirmation", false, "CONFIRMATION_REQUIRED");
    return this.migrations.apply(ctx, { backend, environment, operation: input.operation, authorId: ctx.userId });
  }

  async revert(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName, id: string) {
    const { backend } = await this.writable(ctx, companyId, projectId, environment);
    await this.migrations.rollback(ctx, backend, environment, id);
    return { reverted: true };
  }

  async rows(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName, collection: string,
    query: Parameters<ProjectMigrationEngine["listOwnerRows"]>[4] = {}) {
    const { backend } = await this.context(ctx, companyId, projectId, environment);
    validateIdentifier(collection);
    return { rows: await this.migrations.listOwnerRows(ctx, backend, environment, collection, query) };
  }

  async createRow(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName, collection: string, row: Row) {
    const { backend } = await this.context(ctx, companyId, projectId, environment);
    return { row: await this.migrations.createOwnerRow(ctx, backend, environment, collection, row) };
  }

  async updateRow(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName, collection: string, id: string, row: Row) {
    const { backend } = await this.context(ctx, companyId, projectId, environment);
    return { row: await this.migrations.updateOwnerRow(ctx, backend, environment, collection, id, row) };
  }

  async deleteRows(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName, collection: string, ids: string[], confirmed: boolean) {
    if (!confirmed) throw new DataStudioError(409, "delete_rows", "Confirm row deletion", false, "CONFIRMATION_REQUIRED");
    const { backend } = await this.context(ctx, companyId, projectId, environment);
    return this.migrations.deleteOwnerRows(ctx, backend, environment, collection, ids);
  }

  async importRows(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName,
    collection: string, format: "csv" | "json", content: string) {
    const { backend } = await this.context(ctx, companyId, projectId, environment);
    validateIdentifier(collection);
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > maxImportBytes) throw new DataStudioError(413, "import", "Import exceeds 1 MB", false, "IMPORT_TOO_LARGE");
    const schema = await this.provider.introspectSchema(backend, environment);
    const table = schema.tables.find((item) => item.name === collection);
    if (!table) throw new DataStudioError(404, "import", "Collection not found", false, "COLLECTION_NOT_FOUND");
    let rows: Row[];
    if (format === "json") {
      try { rows = JSON.parse(content); } catch { throw new DataStudioError(400, "import", "Invalid JSON", false, "INVALID_JSON"); }
    } else if (format === "csv") {
      const [header, ...data] = csvRows(content);
      if (!header || new Set(header).size !== header.length || header.some((name) => !table.columns.some((column) => column.name === name))) {
        throw new DataStudioError(400, "import", "Invalid CSV header", false, "INVALID_CSV");
      }
      rows = data.filter((values) => values.some(Boolean)).map((values) => {
        if (values.length !== header.length) throw new DataStudioError(400, "import", "Invalid CSV row", false, "INVALID_CSV");
        return Object.fromEntries(header.map((name, index) => [name, values[index]]));
      });
    } else throw new DataStudioError(400, "import", "Invalid format", false, "INVALID_FORMAT");
    if (!Array.isArray(rows) || rows.length > maxImportRows) throw new DataStudioError(413, "import", "Import exceeds 500 rows", false, "IMPORT_TOO_LARGE");
    const valid = validateRows(rows, table);
    for (const row of valid) await this.migrations.createOwnerRow(ctx, backend, environment, collection, row);
    return { imported: valid.length };
  }

  async exportRows(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName, collection: string, format: "csv" | "json") {
    const { rows } = await this.rows(ctx, companyId, projectId, environment, collection, { limit: 100 });
    if (format === "json") return { filename: collection + ".json", mimeType: "application/json", content: JSON.stringify(rows, null, 2) };
    if (format !== "csv") throw new DataStudioError(400, "export", "Invalid format", false, "INVALID_FORMAT");
    const header = rows.length ? Object.keys(rows[0]!) : [];
    return { filename: collection + ".csv", mimeType: "text/csv", content: [header.map(safeCsvCell).join(","), ...rows.map((row) => header.map((key) => safeCsvCell(row[key])).join(","))].join("\r\n") };
  }

  async getApiKeys(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName) {
    const { backend, env } = await this.context(ctx, companyId, projectId, environment);
    const ensured = ProjectApiKeyManager.ensureKeys(env.providerConfig, environment, this.vault);
    if (ensured.secretKey) {
      await this.repository.setEnvironment(ctx, companyId, backend.id, environment, {
        providerConfig: ensured.updatedConfig,
      });
      env.providerConfig = ensured.updatedConfig;
    }
    const apiUrl = `/v1/projects/${projectId}`;
    return ProjectApiKeyManager.getPublicInfo({ ...env.providerConfig, corsAllowedOrigins: (env.providerConfig.corsOriginsByProject as Record<string, string[]> | undefined)?.[projectId] ?? [] }, apiUrl, environment);
  }

  async revealSecretKey(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName) {
    if (!ctx.permissions.includes("business:manage") && !ctx.permissions.includes("*") && !ctx.permissions.includes("owner")) {
      throw new DataStudioError(403, "keys", "Requires business:manage permission to view secret key", false, "PERMISSION_DENIED");
    }
    const { env } = await this.context(ctx, companyId, projectId, environment);
    const secretKey = ProjectApiKeyManager.revealSecretKey(env.providerConfig, this.vault);
    if (!secretKey) {
      throw new DataStudioError(404, "keys", "Secret key not found or not stored", false, "SECRET_KEY_NOT_FOUND");
    }
    return { secretKey };
  }

  async rotateApiKeys(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    target: "publishable" | "secret" | "both" = "both",
  ) {
    if (!ctx.permissions.includes("business:manage") && !ctx.permissions.includes("*") && !ctx.permissions.includes("owner")) {
      throw new DataStudioError(403, "keys", "Requires business:manage permission to rotate API keys", false, "PERMISSION_DENIED");
    }
    const { backend, env } = await this.context(ctx, companyId, projectId, environment);
    const rotated = ProjectApiKeyManager.rotateKeys(env.providerConfig, environment, target, this.vault);
    await this.repository.setEnvironment(ctx, companyId, backend.id, environment, {
      providerConfig: rotated.updatedConfig,
    });
    const apiUrl = `/v1/projects/${projectId}`;
    const info = ProjectApiKeyManager.getPublicInfo({ ...rotated.updatedConfig, corsAllowedOrigins: (rotated.updatedConfig.corsOriginsByProject as Record<string, string[]> | undefined)?.[projectId] ?? [] }, apiUrl, environment);
    return {
      ...info,
      newSecretKey: rotated.secretKey,
    };
  }

  async updateCorsOrigins(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    origins: string[],
  ) {
    if (!ctx.permissions.includes("business:manage") && !ctx.permissions.includes("*") && !ctx.permissions.includes("owner")) {
      throw new DataStudioError(403, "cors", "Requires business:manage permission to update CORS origins", false, "PERMISSION_DENIED");
    }
    const { backend, env } = await this.context(ctx, companyId, projectId, environment);
    const sanitized = origins.map((o) => o.trim()).filter(Boolean);
    if (sanitized.length > 50 || sanitized.some((origin) => {
      try { const url = new URL(origin); return !["http:", "https:"].includes(url.protocol) || url.origin !== origin; }
      catch { return true; }
    })) throw new DataStudioError(400, "cors", "Origins must be exact HTTP(S) origins", false, "INVALID_ORIGIN");
    const byProject = (env.providerConfig.corsOriginsByProject ?? {}) as Record<string, string[]>;
    const updatedConfig = {
      ...env.providerConfig,
      corsOriginsByProject: { ...byProject, [projectId]: sanitized },
    };
    await this.repository.setEnvironment(ctx, companyId, backend.id, environment, {
      providerConfig: updatedConfig,
    });
    return { corsAllowedOrigins: sanitized };
  }

  /** OpenAPI document for the Data Studio UI (owner-authenticated, no public key needed). */
  async getApiDocumentation(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName) {
    await this.context(ctx, companyId, projectId, environment);
    if (!this.gateway) throw new DataStudioError(503, "api", "Project API gateway is unavailable", true, "GATEWAY_UNAVAILABLE");
    return this.gateway.getOpenApiSpec(projectId, environment);
  }

  async getApiRequestLogs(ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    limit = 50,
  ) {
    await this.context(ctx, companyId, projectId, environment);
    if (this.gateway) {
      return this.gateway.getLogs(projectId, environment, limit);
    }
    return [];
  }

  async getApiUsage(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
  ) {
    await this.context(ctx, companyId, projectId, environment);
    if (this.gateway) {
      return this.gateway.getUsage(projectId, environment);
    }
    return {
      requestCount: 0,
      databaseBytes: 0,
      collectionsCount: 0,
      maxDatabaseBytes: 1_000_000_000,
      maxRequestsPerMinute: 120,
    };
  }
}

function schemaDiff(expected: SchemaSnapshot | null, actual: SchemaSnapshot) {
  if (!expected) return { added: actual.tables.map((table) => table.name), removed: [], changed: [] };
  const before = new Map(expected.tables.map((table) => [table.name, JSON.stringify(table)]));
  const after = new Map(actual.tables.map((table) => [table.name, JSON.stringify(table)]));
  return { added: [...after.keys()].filter((name) => !before.has(name)), removed: [...before.keys()].filter((name) => !after.has(name)),
    changed: [...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name)) };
}

export const dataStudioCsv = { csvRows, safeCsvCell, validateRows };
