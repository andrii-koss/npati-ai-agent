import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { CryptoVault, type AuthContext, type WorkspaceStore } from "@npati/workspace";
import { DataStudioError, bindFilter, quoteIdentifier, validateIdentifier } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataBackendEnvironment, DataEnvironmentName } from "./types";
import { ProjectApiKeyManager } from "./api-key-manager";
import { ProjectApiRateLimiter } from "./rate-limiter";
import { generateOpenApiSpec, generateProjectTypeScriptTypes } from "./openapi-generator";
import type { ProjectAuthService } from "./auth-service";
import type { DataProvider, SchemaSnapshot } from "./data-provider";
import type {
  ProjectApiKeyType,
  ProjectApiRequestLog,
  ProjectApiUsage,
  ProjectApiInspectResult,
} from "@npati/shared";

export interface GatewayAuthResult {
  project: any;
  backend: DataBackend;
  environment: DataEnvironmentName;
  keyType: ProjectApiKeyType;
  userId: string;
  userRole: string;
  userEmail?: string;
  corsAllowedOrigins: string[];
}

export interface GatewayListOptions {
  filter?: Record<string, unknown> | Array<{ field: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: unknown }>;
  sort?: string | Array<{ field: string; direction: "asc" | "desc" }>;
  limit?: number;
  offset?: number;
  page?: number;
  fields?: string[];
  include?: string[];
}

export class ProjectApiGatewayService {
  private readonly rateLimiter = new ProjectApiRateLimiter();
  private readonly recentLogs: ProjectApiRequestLog[] = [];
  private readonly requestCounts = new Map<string, number>();
  private readonly vault = new CryptoVault();
  private readonly runtimePools = new Map<string, Pool>();

  constructor(
    private readonly store: Pick<WorkspaceStore, "getProject">,
    private readonly repository: DataBackendRepository,
    private readonly provisioner: DatabaseProvisioner,
    private readonly authService?: ProjectAuthService,
    private readonly dataProvider?: DataProvider,
    private readonly poolFactory?: (backend: DataBackend, env: DataEnvironmentName) => Promise<Pool>,
  ) {}

  /**
   * Resolves project, verified backend and environment.
   */
  async resolveProject(projectId: string): Promise<{ project: any; backend: DataBackend }> {
    let project: any;
    const storeAny = this.store as any;

    if (storeAny.projects instanceof Map) {
      project = storeAny.projects.get(projectId);
    } else if (this.repository.pool) {
      try {
        const res = await this.repository.pool.query(
          'SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", created_by AS "createdBy", name, data_backend_id AS "dataBackendId", status FROM projects WHERE id = $1',
          [projectId],
        );
        project = res.rows[0];
      } catch {
        // ignore
      }
    }

    if (!project) {
      try {
        const systemContext: AuthContext = { workspaceId: "*", userId: "gateway", permissions: ["*"] };
        const companies = typeof storeAny.listCompanies === "function" ? (await storeAny.listCompanies(systemContext, 100)).items : [];
        for (const c of companies) {
          const p = await this.store.getProject(systemContext, c.id, projectId).catch(() => null);
          if (p) { project = p; break; }
        }
      } catch {
        // ignore
      }
    }

    if (!project || project.status === "archived") {
      throw new DataStudioError(404, "gateway", "Project not found or archived", false, "PROJECT_NOT_FOUND");
    }
    if (!project.dataBackendId) {
      throw new DataStudioError(404, "gateway", "Project has no attached DataBackend", false, "DATA_BACKEND_NOT_ATTACHED");
    }

    const backend = await this.repository.get(
      { workspaceId: project.workspaceId, userId: project.createdBy, permissions: ["*"] },
      project.companyId,
      project.dataBackendId,
    );

    if (backend.status !== "ready") {
      throw new DataStudioError(409, "gateway", "Project DataBackend is not ready", false, "BACKEND_NOT_READY");
    }

    return { project, backend };
  }

  /**
   * Authenticates an incoming public Project API request.
   */
  async getSandboxEnvironment(ctx: AuthContext, companyId: string, projectId: string): Promise<Record<string, string>> {
    const publicBase = process.env.NPATI_PROJECT_API_PUBLIC_URL;
    if (!publicBase) return {};
    const parsed = new URL(publicBase);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new DataStudioError(500, "gateway", "Invalid Project API public URL", false, "INVALID_API_URL");
    }
    const authorized = await this.store.getProject(ctx, companyId, projectId);
    const { project, backend } = await this.resolveProject(projectId);
    if (project.companyId !== companyId || authorized.dataBackendId !== backend.id) throw new DataStudioError(403, "gateway", "Project access denied", false, "PROJECT_FORBIDDEN");
    const env = await this.repository.environment(ctx, companyId, backend.id, "dev");
    const keys = ProjectApiKeyManager.ensureKeys(env.providerConfig, "dev", this.vault);
    if (keys.secretKey) await this.repository.setEnvironment(ctx, companyId, backend.id, "dev", { providerConfig: keys.updatedConfig });
    return {
      PROJECT_API_URL: `${publicBase.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(projectId)}`,
      PROJECT_PUBLISHABLE_KEY: keys.publishableKey,
    };
  }
  async authenticateRequest(
    projectId: string,
    headers: Record<string, string | undefined>,
    queryKey?: string,
    ip?: string,
    origin?: string,
  ): Promise<GatewayAuthResult> {
    const { project, backend } = await this.resolveProject(projectId);

    // 1. Resolve API key from header or query or Bearer token
    let apiKey = headers["x-project-key"] || queryKey;
    const authHeader = headers["authorization"];
    let bearerToken: string | undefined;

    if (authHeader?.startsWith("Bearer ")) {
      const candidate = authHeader.slice(7).trim();
      if (candidate.startsWith("npati_pk_") || candidate.startsWith("npati_sk_")) {
        apiKey = apiKey || candidate;
      } else {
        bearerToken = candidate;
      }
    }

    if (!apiKey) {
      throw new DataStudioError(401, "gateway", "Missing Project API key (X-Project-Key)", false, "MISSING_API_KEY");
    }

    const parsedKey = ProjectApiKeyManager.parseKey(apiKey);
    if (!parsedKey) {
      throw new DataStudioError(401, "gateway", "Invalid API key format", false, "INVALID_API_KEY");
    }

    const environment = parsedKey.environment;

    // Load backend environment
    const envRecord = await this.repository.environment(
      { workspaceId: project.workspaceId, userId: project.createdBy, permissions: ["*"] },
      project.companyId,
      backend.id,
      environment,
    );

    if (envRecord.status !== "ready") {
      throw new DataStudioError(409, "gateway", `Environment ${environment} is not ready`, false, "ENVIRONMENT_NOT_READY");
    }

    // Ensure keys exist in providerConfig (generates if first run)
    const ensured = ProjectApiKeyManager.ensureKeys(envRecord.providerConfig, environment, this.vault);
    if (ensured.secretKey) {
      await this.repository.setEnvironment(
        { workspaceId: project.workspaceId, userId: project.createdBy, permissions: ["*"] },
        project.companyId,
        backend.id,
        environment,
        { providerConfig: ensured.updatedConfig },
      );
      envRecord.providerConfig = ensured.updatedConfig;
    }

    // Validate key
    const keyValidation = ProjectApiKeyManager.validateKey(apiKey, envRecord.providerConfig, environment);
    if (!keyValidation.valid || !keyValidation.keyType) {
      throw new DataStudioError(401, "gateway", "Invalid or expired Project API key", false, "INVALID_API_KEY");
    }

    const keyType = keyValidation.keyType;

    // 2. CORS check
    const byProject = envRecord.providerConfig.corsOriginsByProject as Record<string, string[]> | undefined;
    const allowedOrigins = byProject?.[projectId] ?? [];

    if (origin) {
      const isAllowed = this.isOriginAllowed(origin, allowedOrigins, projectId);
      if (!isAllowed) {
        throw new DataStudioError(403, "cors", `Origin ${origin} is not allowed by Project CORS policy`, false, "CORS_ORIGIN_NOT_ALLOWED");
      }
    }

    if (origin && keyType === "secret") {
      throw new DataStudioError(403, "gateway", "Secret keys are server-side only", false, "SECRET_KEY_IN_BROWSER");
    }


    // 3. Rate limiting
    const rateLimitConfig = (envRecord.providerConfig.rateLimit as { maxRequestsPerMinute?: number }) || {};
    const limit = keyType === "secret" ? 600 : (rateLimitConfig.maxRequestsPerMinute || 120);

    const keyCheck = this.rateLimiter.check(`key:${apiKey}`, limit);
    if (!keyCheck.allowed) {
      throw new DataStudioError(429, "rate_limit", "Project API key rate limit exceeded", true, "RATE_LIMIT_EXCEEDED");
    }

    if (ip) {
      const ipCheck = this.rateLimiter.check(`ip:${ip}`, Math.max(limit, 60));
      if (!ipCheck.allowed) {
        throw new DataStudioError(429, "rate_limit", "Client IP rate limit exceeded", true, "RATE_LIMIT_EXCEEDED");
      }
    }

    // 4. Resolve end-user identity from Bearer token
    let userId = "";
    let userRole = keyType === "secret" ? "service_role" : "anon";
    let userEmail: string | undefined;

    if (bearerToken && this.authService) {
      try {
        const verified = await this.authService.me(
          { workspaceId: "client-auth", userId: "client-guest", permissions: [] },
          project.companyId,
          projectId,
          environment,
          bearerToken,
        );
        if (verified && verified.id) {
          userId = verified.id;
          userRole = (verified.roles?.[0] as string) || (Array.isArray(verified.roles) && verified.roles[0]) || "authenticated";
          userEmail = verified.email as string;
        }
      } catch {
        // If Bearer token is invalid, reject with 401
        throw new DataStudioError(401, "auth", "Invalid or expired user access token", false, "INVALID_TOKEN");
      }
    }

    return {
      project,
      backend,
      environment,
      keyType,
      userId,
      userRole,
      userEmail,
      corsAllowedOrigins: allowedOrigins,
    };
  }

  async isPreflightOriginAllowed(projectId: string, origin: string): Promise<boolean> {
    const { project, backend } = await this.resolveProject(projectId);
    for (const environment of ["dev", "prod"] as const) {
      const record = await this.repository.environment(
        { workspaceId: project.workspaceId, userId: project.createdBy, permissions: ["*"] },
        project.companyId, backend.id, environment,
      );
      const byProject = record.providerConfig.corsOriginsByProject as Record<string, string[]> | undefined;
      if (this.isOriginAllowed(origin, byProject?.[projectId] ?? [], projectId)) return true;
    }
    return false;
  }

  isOriginAllowed(origin: string, allowedOrigins: string[], _projectId: string): boolean {
    try {
      const parsed = new URL(origin);
      return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin && allowedOrigins.includes(origin);
    } catch { return false; }
  }
  /**
   * Executes query inside runtime role connection with local session setting.
   */
  async executeRuntime<T>(
    auth: GatewayAuthResult,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = await this.getRuntimePool(auth.backend, auth.environment);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Transaction-local claims (is_local = true) are reset at COMMIT/ROLLBACK, so pooled connections never leak identity.
      await client.query("SELECT set_config('npati.auth.user_id', $1, true)", [auth.userId || ""]);
      await client.query("SELECT set_config('npati.auth.user_role', $1, true)", [auth.userRole || "anon"]);
      await client.query("SELECT set_config('npati.project_id', $1, true)", [auth.project.id]);
      await client.query("SELECT set_config('npati.user_id', $1, true)", [auth.userId || ""]);

      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async getRuntimePool(backend: DataBackend, env: DataEnvironmentName): Promise<Pool> {
    const key = `${backend.id}:${env}`;
    let pool = this.runtimePools.get(key);
    if (pool) return pool;

    if (this.poolFactory) {
      pool = await this.poolFactory(backend, env);
      this.runtimePools.set(key, pool);
      return pool;
    }

    const conn = await this.provisioner.getConnection(backend, env, "runtime");
    pool = new Pool({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    this.runtimePools.set(key, pool);
    return pool;
  }

  // =========================================================================
  // Collection CRUD Operations
  // =========================================================================

  private async validateColumns(client: PoolClient, collection: string, fields: string[]): Promise<void> {
    const result = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
      [collection],
    );
    if (!result.rows.length) throw new DataStudioError(404, "gateway", "Collection not found", false, "COLLECTION_NOT_FOUND");
    const allowed = new Set(result.rows.map((row) => row.column_name));
    for (const field of fields) {
      validateIdentifier(field);
      if (!allowed.has(field)) throw new DataStudioError(400, "gateway", `Unknown field: ${field}`, false, "UNKNOWN_FIELD");
    }
  }
  private async authorizeCollection(auth: GatewayAuthResult, collection: string, action: "select" | "insert" | "update" | "delete"): Promise<void> {
    validateIdentifier(collection);
    const policies = await this.repository.getAccessPolicies(
      { workspaceId: auth.project.workspaceId, userId: auth.project.createdBy, permissions: ["*"] },
      auth.project.companyId, auth.backend.id, auth.environment,
    );
    const allowed = policies.some((policy) => {
      if (policy.collection !== collection || !(policy.actions ?? ["all"]).some((item) => item === "all" || item === action)) return false;
      if (policy.rule === "public") return true;
      if (policy.rule === "authenticated") return Boolean(auth.userId);
      if (policy.rule === "owner") return Boolean(auth.userId);
      return policy.rule === "role" && policy.role === auth.userRole;
    });
    if (!allowed) throw new DataStudioError(403, "gateway", "Collection action is not permitted", false, "POLICY_DENIED");
  }
  async listRows(auth: GatewayAuthResult, collection: string, options: GatewayListOptions = {}) {
    await this.authorizeCollection(auth, collection, "select");

    const values: unknown[] = [];
    const filterClauses: string[] = [];

    // Parse filters
    if (options.filter) {
      if (Array.isArray(options.filter)) {
        for (const item of options.filter) {
          validateIdentifier(item.field);
          filterClauses.push(bindFilter(item.field, item.operator, item.value, values));
        }
      } else {
        for (const [key, val] of Object.entries(options.filter)) {
          validateIdentifier(key);
          filterClauses.push(bindFilter(key, "eq", val, values));
        }
      }
    }

    // Parse sort
    const orderClauses: string[] = [];
    if (options.sort) {
      const items = Array.isArray(options.sort) ? options.sort : [options.sort];
      for (const item of items) {
        if (typeof item === "string") {
          const [field, dir = "asc"] = item.split(":");
          validateIdentifier(field!);
          const direction = dir?.toLowerCase() === "desc" ? "DESC" : "ASC";
          orderClauses.push(`${quoteIdentifier(field!)} ${direction}`);
        } else {
          validateIdentifier(item.field);
          orderClauses.push(`${quoteIdentifier(item.field)} ${item.direction === "desc" ? "DESC" : "ASC"}`);
        }
      }
    }

    // Default sorting by created_at if exists or id
    if (!orderClauses.length) {
      orderClauses.push(`${quoteIdentifier("id")} ASC`);
    }

    // Parse field selection
    let selectFields = "*";
    if (options.fields && options.fields.length) {
      const fields = options.fields.map((f) => quoteIdentifier(validateIdentifier(f.trim())));
      selectFields = fields.join(", ");
    }

    if ([options.limit, options.offset, options.page].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
      throw new DataStudioError(400, "gateway", "Pagination values must be non-negative integers", false, "INVALID_PAGINATION");
    }
    const limit = Math.min(Math.max(1, options.limit ?? 20), 100);
    const offset = Math.max(0, options.offset ?? (options.page ? (options.page - 1) * limit : 0));

    values.push(limit, offset);
    const whereSql = filterClauses.length ? ` WHERE ${filterClauses.join(" AND ")}` : "";
    const orderSql = ` ORDER BY ${orderClauses.join(", ")}`;
    const limitSql = ` LIMIT $${values.length - 1} OFFSET $${values.length}`;

    const dataSql = `SELECT ${selectFields} FROM ${quoteIdentifier(collection)}${whereSql}${orderSql}${limitSql}`;
    const countSql = `SELECT count(*)::text AS total FROM ${quoteIdentifier(collection)}${whereSql}`;

    return this.executeRuntime(auth, async (client) => {
      const referenced = [
        ...(options.fields ?? []),
        ...(Array.isArray(options.filter) ? options.filter.map((item) => item.field) : Object.keys(options.filter ?? {})),
        ...(options.sort ? (Array.isArray(options.sort) ? options.sort.map((item) => item.field) : [options.sort.split(":")[0]!]) : []),
      ];
      await this.validateColumns(client, collection, referenced);
      const countValues = values.slice(0, values.length - 2);
      const [dataRes, countRes] = await Promise.all([
        client.query(dataSql, values),
        client.query<{ total: string }>(countSql, countValues),
      ]);

      let rows = dataRes.rows;
      const total = Number(countRes.rows[0]?.total || 0);

      // Handle relation expansion
      if (options.include && options.include.length && rows.length) {
        rows = await this.expandRelations(auth, client, collection, rows, options.include);
      }

      return {
        data: rows,
        meta: {
          total,
          page: options.page ?? Math.floor(offset / limit) + 1,
          limit,
          hasMore: offset + rows.length < total,
        },
      };
    });
  }

  async getRow(auth: GatewayAuthResult, collection: string, id: string, options: { fields?: string[]; include?: string[] } = {}) {
    await this.authorizeCollection(auth, collection, "select");

    let selectFields = "*";
    if (options.fields && options.fields.length) {
      selectFields = options.fields.map((f) => quoteIdentifier(validateIdentifier(f.trim()))).join(", ");
    }

    const sql = `SELECT ${selectFields} FROM ${quoteIdentifier(collection)} WHERE id = $1 LIMIT 1`;

    return this.executeRuntime(auth, async (client) => {
      await this.validateColumns(client, collection, options.fields ?? []);
      const res = await client.query(sql, [id]);
      if (!res.rowCount) {
        throw new DataStudioError(404, "gateway", `Record in '${collection}' not found`, false, "RECORD_NOT_FOUND");
      }
      let row = res.rows[0]!;

      if (options.include && options.include.length) {
        const expanded = await this.expandRelations(auth, client, collection, [row], options.include);
        row = expanded[0]!;
      }

      return { data: row };
    });
  }

  async createRow(auth: GatewayAuthResult, collection: string, values: Record<string, unknown>) {
    await this.authorizeCollection(auth, collection, "insert");

    // Prevent passing id or managed fields if not allowed
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(values)) {
      if (key === "id" || key === "created_at" || key === "updated_at") continue;
      validateIdentifier(key);
      sanitized[key] = val;
    }

    const keys = Object.keys(sanitized);
    let sql: string;
    let queryParams: unknown[];

    if (!keys.length) {
      sql = `INSERT INTO ${quoteIdentifier(collection)} DEFAULT VALUES RETURNING *`;
      queryParams = [];
    } else {
      sql = `INSERT INTO ${quoteIdentifier(collection)} (${keys.map(quoteIdentifier).join(", ")}) ` +
        `VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`;
      queryParams = Object.values(sanitized);
    }

    return this.executeRuntime(auth, async (client) => {
      await this.validateColumns(client, collection, keys);
      const res = await client.query(sql, queryParams);
      return { data: res.rows[0] };
    });
  }

  async updateRow(auth: GatewayAuthResult, collection: string, id: string, values: Record<string, unknown>) {
    await this.authorizeCollection(auth, collection, "update");

    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(values)) {
      if (key === "id" || key === "created_at" || key === "updated_at") continue;
      validateIdentifier(key);
      sanitized[key] = val;
    }

    const keys = Object.keys(sanitized);
    if (!keys.length) {
      return this.getRow(auth, collection, id);
    }

    const setClauses = keys.map((key, i) => `${quoteIdentifier(key)} = $${i + 1}`);
    const sql = `UPDATE ${quoteIdentifier(collection)} SET ${setClauses.join(", ")} WHERE id = $${keys.length + 1} RETURNING *`;
    const params = [...Object.values(sanitized), id];

    return this.executeRuntime(auth, async (client) => {
      await this.validateColumns(client, collection, keys);
      const res = await client.query(sql, params);
      if (!res.rowCount) {
        throw new DataStudioError(404, "gateway", `Record in '${collection}' not found`, false, "RECORD_NOT_FOUND");
      }
      return { data: res.rows[0] };
    });
  }

  async deleteRow(auth: GatewayAuthResult, collection: string, id: string) {
    await this.authorizeCollection(auth, collection, "delete");
    const sql = `DELETE FROM ${quoteIdentifier(collection)} WHERE id = $1`;

    return this.executeRuntime(auth, async (client) => {
      await this.validateColumns(client, collection, []);
      const res = await client.query(sql, [id]);
      if (!res.rowCount) {
        throw new DataStudioError(404, "gateway", `Record in '${collection}' not found`, false, "RECORD_NOT_FOUND");
      }
      return { success: true, id };
    });
  }

  /**
   * Expands related foreign key objects for queried rows.
   */
  private async expandRelations(
    auth: GatewayAuthResult,
    client: PoolClient,
    collection: string,
    rows: any[],
    relationNames: string[],
  ): Promise<any[]> {
    for (const rel of relationNames) {
      const targetRelation = rel.trim();
      validateIdentifier(targetRelation);

      // Check foreign key column pattern e.g. "category" -> "category_id"
      const fkCandidate = `${targetRelation}_id`;
      const hasFk = rows.some((r) => r[fkCandidate] !== undefined);

      if (hasFk) {
        // Collect target IDs
        const ids = [...new Set(rows.map((r) => r[fkCandidate]).filter((id) => id !== null && id !== undefined))];
        if (ids.length) {
          const plural = targetRelation.endsWith("s") ? targetRelation : `${targetRelation}s`;
          const targetTable = (await client.query<{ exists: boolean }>(
            "SELECT to_regclass($1) IS NOT NULL AS exists", [plural],
          )).rows[0]?.exists ? plural : targetRelation;
          await this.authorizeCollection(auth, targetTable, "select");
          const relRes = await client.query(
            `SELECT * FROM ${quoteIdentifier(targetTable)} WHERE id = ANY($1)`, [ids],
          );
          const lookup = new Map(relRes.rows.map((r) => [String(r.id), r]));
          for (const row of rows) {
            const fkVal = row[fkCandidate];
            row[targetRelation] = fkVal ? lookup.get(String(fkVal)) || null : null;
          }
        }
      }
    }
    return rows;
  }

  // =========================================================================
  // OpenAPI & Inspection
  // =========================================================================

  async getTypeScriptTypes(projectId: string, environment: DataEnvironmentName): Promise<string> {
    const { backend } = await this.resolveProject(projectId);
    if (!this.dataProvider) throw new DataStudioError(503, "gateway", "Schema provider unavailable", true, "SCHEMA_UNAVAILABLE");
    return generateProjectTypeScriptTypes(await this.dataProvider.introspectSchema(backend, environment));
  }
  async getOpenApiSpec(projectId: string, environment: DataEnvironmentName): Promise<Record<string, unknown>> {
    const { project, backend } = await this.resolveProject(projectId);
    let schema: SchemaSnapshot = { tables: [] };
    if (this.dataProvider) {
      schema = await this.dataProvider.introspectSchema(backend, environment);
    }
    return generateOpenApiSpec(
      {
        projectId,
        projectName: project.name || "Project",
        environment,
      },
      schema,
    );
  }

  async inspectApi(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName = "dev",
  ): Promise<ProjectApiInspectResult> {
    const authorizedProject = await this.store.getProject(ctx, companyId, projectId);
    const { project, backend } = await this.resolveProject(projectId);
    if (authorizedProject.dataBackendId !== backend.id || project.companyId !== companyId) throw new DataStudioError(403, "gateway", "Project access denied", false, "PROJECT_FORBIDDEN");
    let schema: SchemaSnapshot = { tables: [] };
    if (this.dataProvider) {
      schema = await this.dataProvider.introspectSchema(backend, environment);
    }

    const collections = schema.tables
      .filter((t) => !t.name.startsWith("_npati_"))
      .map((t) => ({
        name: t.name,
        fields: t.columns.map((c) => ({ name: c.name, type: c.type, required: !c.nullable })),
      }));

    const endpoints = [
      { method: "POST", path: `/v1/projects/${projectId}/auth/register`, description: "Register end-user", authRequired: false, keyRequired: "publishable" as const },
      { method: "POST", path: `/v1/projects/${projectId}/auth/login`, description: "Login end-user", authRequired: false, keyRequired: "publishable" as const },
      { method: "POST", path: `/v1/projects/${projectId}/auth/logout`, description: "Logout end-user", authRequired: false, keyRequired: "publishable" as const },
      { method: "GET", path: `/v1/projects/${projectId}/auth/me`, description: "Get current user profile", authRequired: true, keyRequired: "publishable" as const },
      { method: "POST", path: `/v1/projects/${projectId}/auth/refresh`, description: "Refresh access token", authRequired: false, keyRequired: "publishable" as const },
    ];

    for (const col of collections) {
      endpoints.push(
        { method: "GET", path: `/v1/projects/${projectId}/data/${col.name}`, description: `List ${col.name}`, authRequired: false, keyRequired: "publishable" as const },
        { method: "GET", path: `/v1/projects/${projectId}/data/${col.name}/:id`, description: `Get ${col.name} by ID`, authRequired: false, keyRequired: "publishable" as const },
        { method: "POST", path: `/v1/projects/${projectId}/data/${col.name}`, description: `Create ${col.name}`, authRequired: false, keyRequired: "publishable" as const },
        { method: "PATCH", path: `/v1/projects/${projectId}/data/${col.name}/:id`, description: `Update ${col.name}`, authRequired: false, keyRequired: "publishable" as const },
        { method: "DELETE", path: `/v1/projects/${projectId}/data/${col.name}/:id`, description: `Delete ${col.name}`, authRequired: false, keyRequired: "publishable" as const },
      );
    }

    return {
      projectId,
      environment,
      apiUrl: `/v1/projects/${projectId}`,
      openApiUrl: `/v1/projects/${projectId}/openapi.json`,
      collections,
      endpoints,
      authEnabled: Boolean(this.authService),
    };
  }

  // =========================================================================
  // Logging & Usage
  // =========================================================================

  recordLog(log: Omit<ProjectApiRequestLog, "id" | "createdAt">): void {
    const entry: ProjectApiRequestLog = {
      ...log,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.recentLogs.unshift(entry);
    if (this.recentLogs.length > 500) {
      this.recentLogs.length = 500;
    }

    if (this.repository.pool) {
      void this.repository.pool.query(
        "INSERT INTO project_api_request_logs(id, workspace_id, company_id, project_id, backend_id, environment, key_type, method, path, status_code, duration_ms, ip, created_at) SELECT $1, workspace_id, company_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 FROM projects WHERE id=$2",
        [entry.id, entry.projectId, entry.backendId, entry.environment, entry.keyType, entry.method, entry.path, entry.statusCode, entry.durationMs, entry.ip ?? null, entry.createdAt],
      ).catch(() => undefined);
    }

    // Increment counter
    const countKey = `${log.projectId}:${log.environment}`;
    this.requestCounts.set(countKey, (this.requestCounts.get(countKey) || 0) + 1);
  }

  async getLogs(projectId: string, environment: DataEnvironmentName, limit = 50): Promise<ProjectApiRequestLog[]> {
    if (this.repository.pool) {
      const result = await this.repository.pool.query(
        'SELECT id, project_id AS "projectId", backend_id AS "backendId", environment, key_type AS "keyType", method, path, status_code AS "statusCode", duration_ms AS "durationMs", ip, created_at::text AS "createdAt" FROM project_api_request_logs WHERE project_id=$1 AND environment=$2 ORDER BY created_at DESC LIMIT $3',
        [projectId, environment, Math.min(Math.max(1, limit), 100)],
      );
      return result.rows as ProjectApiRequestLog[];
    }
    return this.recentLogs.filter((log) => log.projectId === projectId && log.environment === environment).slice(0, limit);
  }
  async getUsage(projectId: string, environment: DataEnvironmentName): Promise<ProjectApiUsage> {
    const { backend } = await this.resolveProject(projectId);
    const countKey = `${projectId}:${environment}`;
    let requestCount = this.requestCounts.get(countKey) || 0;
    if (this.repository.pool) {
      const count = await this.repository.pool.query<{ total: string }>("SELECT count(*)::text AS total FROM project_api_request_logs WHERE project_id=$1 AND environment=$2", [projectId, environment]);
      requestCount = Number(count.rows[0]?.total ?? 0);
    }

    let databaseBytes = 0;
    try { databaseBytes = (await this.provisioner.getUsage(backend, environment)).bytes; } catch { /* unavailable database */ }
    let collectionsCount = 0;

    if (this.dataProvider) {
      try {
        const schema = await this.dataProvider.introspectSchema(backend, environment);
        collectionsCount = schema.tables.filter((t) => !t.name.startsWith("_npati_")).length;
      } catch {
        // Fallback
      }
    }

    return {
      requestCount,
      databaseBytes,
      collectionsCount,
      maxDatabaseBytes: 1_000_000_000,
      maxRequestsPerMinute: environment === "dev" ? 300 : 120,
    };
  }

  async close() {
    await Promise.all([...this.runtimePools.values()].map((p) => p.end().catch(() => undefined)));
    this.runtimePools.clear();
  }
}
