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
import { PROJECT_SDK_FILE_NAME, PROJECT_SDK_IMPORT_PATH, ensureProjectSdkFile } from "./project-sdk-file";
import type { ProjectAuthService } from "./auth-service";
import type { ProjectWorkspace } from "../project-workspace";
import type { DataProvider, SchemaSnapshot } from "./data-provider";
import type {
  ProjectApiKeyType,
  ProjectApiRequestLog,
  ProjectApiUsage,
  ProjectApiInspectResult,
} from "@npati/shared";
export * from "./gateway-types";
export {
  MAX_FILTER_CLAUSES,
  MAX_SORT_CLAUSES,
  MAX_SELECT_FIELDS,
  MAX_RELATION_INCLUDES,
} from "./gateway-query";
import {
  type GatewayAuthResult,
  type GatewayListOptions,
} from "./gateway-types";
import {
  assertQueryBounds,
  buildFilterClauses,
  buildOrderClauses,
  expandRelations,
} from "./gateway-query";
import {
  extractApiCollections,
  buildApiEndpoints,
} from "./gateway-inspection";

export class ProjectApiGatewayService {
  private readonly rateLimiter = new ProjectApiRateLimiter();  private readonly recentLogs: ProjectApiRequestLog[] = [];
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
    private readonly workspace?: Pick<ProjectWorkspace, "readFile" | "createFile" | "writeFile">,
    /** D7: blocks writes when the environment exceeded its hard database quota. */
    private readonly quotas?: { assertWritesAllowed(backend: DataBackend, environment: DataEnvironmentName): Promise<void> },
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
    const authorized = await this.store.getProject(ctx, companyId, projectId);
    const { project, backend } = await this.resolveProject(projectId);
    if (project.companyId !== companyId || authorized.dataBackendId !== backend.id) throw new DataStudioError(403, "gateway", "Project access denied", false, "PROJECT_FORBIDDEN");
    const publicBase = process.env.NPATI_PROJECT_API_PUBLIC_URL || process.env.NPATI_AGENT_PUBLIC_DOMAIN || process.env.NPATI_WEB_ORIGIN;
    if (!publicBase) return {};
    const parsed = new URL(publicBase);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new DataStudioError(500, "gateway", "Invalid Project API public URL", false, "INVALID_API_URL");
    }
    // The sandbox cannot install the private SDK package, so the Project workspace carries it.
    await this.syncProjectSdkFile(ctx, companyId, projectId);
    const env = await this.repository.environment(ctx, companyId, backend.id, "dev");
    const keys = ProjectApiKeyManager.ensureKeys(env.providerConfig, "dev", this.vault);
    if (keys.secretKey) await this.repository.setEnvironment(ctx, companyId, backend.id, "dev", { providerConfig: keys.updatedConfig });
    return {
      PROJECT_API_URL: `${publicBase.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(projectId)}`,
      PROJECT_PUBLISHABLE_KEY: keys.publishableKey,
    };
  }
  /** Vendors the Project API client into the Project workspace (idempotent). */
  private async syncProjectSdkFile(ctx: AuthContext, companyId: string, projectId: string): Promise<string> {
    try {
      const result = await ensureProjectSdkFile(ctx, companyId, projectId, this.workspace);
      return result === "unavailable" ? "unavailable" : "available";
    } catch {
      return "unavailable";
    }
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
      // pg removes failed idle clients itself. An unhandled pool error would
      // crash the entire API when a project database is removed/restarted.
      pool.on?.("error", () => {});
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
    pool.on("error", () => {});
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
  private assertQueryBounds(options: { filter?: unknown; sort?: unknown; fields?: string[]; include?: string[] }): void {
    assertQueryBounds(options);
  }

  private async assertCommerceMutation(auth: GatewayAuthResult, collection: string): Promise<void> {
    if (!["orders", "order_items"].includes(collection)) return;
    const ctx = { workspaceId: auth.project.workspaceId, userId: auth.project.createdBy, permissions: ["business:manage"] };
    const env = await this.repository.environment(ctx, auth.project.companyId, auth.backend.id, auth.environment);
    if (env.providerConfig.commerce === true && auth.keyType !== "secret") throw new DataStudioError(403, "checkout", "Orders must be created through checkout; clients cannot change prices or order status", false, "CHECKOUT_REQUIRED");
  }

  async checkout(auth: GatewayAuthResult, cartId: string) {
    if (!auth.userId) throw new DataStudioError(401, "checkout", "Sign in before checkout", false, "AUTH_REQUIRED");
    if (typeof cartId !== "string" || !/^[0-9a-f-]{36}$/i.test(cartId)) throw new DataStudioError(400, "checkout", "Invalid cart ID", false, "INVALID_CART");
    const ctx = { workspaceId: auth.project.workspaceId, userId: auth.project.createdBy, permissions: ["business:manage"] };
    const env = await this.repository.environment(ctx, auth.project.companyId, auth.backend.id, auth.environment);
    if (env.providerConfig.commerce !== true) throw new DataStudioError(404, "checkout", "Store checkout is unavailable", false, "CHECKOUT_UNAVAILABLE");
    await this.authorizeCollection(auth, "orders", "insert");
    await this.authorizeCollection(auth, "order_items", "insert");
    await this.quotas?.assertWritesAllowed(auth.backend, auth.environment);
    return this.executeRuntime(auth, async client => {
      const cart = await client.query("SELECT id FROM carts WHERE id=$1 AND owner_id=$2 AND status='active' FOR UPDATE", [cartId, auth.userId]);
      if (!cart.rowCount) throw new DataStudioError(409, "checkout", "Cart not found or already checked out", false, "INVALID_CART");
      const items = await client.query<{ id: string; quantity: string }>("SELECT id,quantity::text AS quantity FROM cart_items WHERE cart_id=$1 AND owner_id=$2 FOR UPDATE", [cartId, auth.userId]);
      if (!items.rows.length || items.rows.length > 100 || items.rows.some(item => !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 100)) throw new DataStudioError(400, "checkout", "Cart quantities are invalid or cart is empty", false, "INVALID_CART_ITEMS");
      const available = await client.query("SELECT ci.id FROM cart_items ci JOIN product_variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id WHERE ci.cart_id=$1 AND ci.owner_id=$2 AND p.is_active=true AND v.price>=0 AND v.inventory_count>=ci.quantity", [cartId, auth.userId]);
      if (available.rowCount !== items.rows.length) throw new DataStudioError(409, "checkout", "A product is unavailable", false, "PRODUCT_UNAVAILABLE");
      const orderNumber = "NP-" + randomUUID();
      const order = await client.query<Record<string, unknown>>("INSERT INTO orders(owner_id,order_number,status,total_amount,currency) SELECT $2,$3,'pending',sum(v.price*ci.quantity),'UAH' FROM cart_items ci JOIN product_variants v ON v.id=ci.variant_id WHERE ci.cart_id=$1 AND ci.owner_id=$2 RETURNING *", [cartId, auth.userId, orderNumber]);
      await client.query("INSERT INTO order_items(order_id,product_id,variant_id,quantity,unit_price,owner_id) SELECT $3,v.product_id,v.id,ci.quantity,v.price,$2 FROM cart_items ci JOIN product_variants v ON v.id=ci.variant_id WHERE ci.cart_id=$1 AND ci.owner_id=$2", [cartId, auth.userId, order.rows[0]!.id]);
      await client.query("UPDATE carts SET status='ordered' WHERE id=$1 AND owner_id=$2", [cartId, auth.userId]);
      return { order: order.rows[0] };
    });
  }

  async listRows(auth: GatewayAuthResult, collection: string, options: GatewayListOptions = {}) {
    await this.authorizeCollection(auth, collection, "select");
    this.assertQueryBounds(options);

    const values: unknown[] = [];
    const filterClauses = buildFilterClauses(options.filter, values);
    const orderClauses = buildOrderClauses(options.sort);

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
    this.assertQueryBounds(options);

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

  /** Append-only forms do not need SELECT permission or expose submitted records. */
  async submitForm(auth: GatewayAuthResult, collection: string, values: Record<string, unknown>) {
    if (collection !== "contact_messages" && collection !== "form_submissions") {
      throw new DataStudioError(400, "gateway", "Unsupported form collection", false, "INVALID_FORM_COLLECTION");
    }
    await this.authorizeCollection(auth, collection, "insert");
    await this.quotas?.assertWritesAllowed(auth.backend, auth.environment);
    const allowed = collection === "contact_messages" ? ["name", "email", "message"] : ["form_name", "payload"];
    if (!values || typeof values !== "object" || Array.isArray(values) || allowed.some(key => values[key] === undefined) || Object.keys(values).some(key => !allowed.includes(key))) {
      throw new DataStudioError(400, "gateway", "Invalid form fields", false, "INVALID_FORM_FIELDS");
    }
    return this.executeRuntime(auth, async client => {
      await this.validateColumns(client, collection, allowed);
      // RETURNING requires a SELECT policy, which would disclose other submissions.
      await client.query(`INSERT INTO ${quoteIdentifier(collection)} (${allowed.map(quoteIdentifier).join(", ")}) VALUES (${allowed.map((_, index) => `$${index + 1}`).join(", ")})`, allowed.map(key => values[key]));
      return { success: true };
    });
  }

  async createRow(auth: GatewayAuthResult, collection: string, values: Record<string, unknown>) {
    await this.assertCommerceMutation(auth, collection);
    await this.authorizeCollection(auth, collection, "insert");
    await this.quotas?.assertWritesAllowed(auth.backend, auth.environment);

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
    await this.assertCommerceMutation(auth, collection);
    await this.authorizeCollection(auth, collection, "update");
    await this.quotas?.assertWritesAllowed(auth.backend, auth.environment);

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
    await this.assertCommerceMutation(auth, collection);
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
    return expandRelations(auth, client, collection, rows, relationNames, (a, t, act) => this.authorizeCollection(a, t, act));
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
    const sdkStatus = await this.syncProjectSdkFile(ctx, companyId, projectId);
    let schema: SchemaSnapshot = { tables: [] };
    if (this.dataProvider) {
      schema = await this.dataProvider.introspectSchema(backend, environment);
    }

    const collections = extractApiCollections(schema);
    const endpoints = buildApiEndpoints(projectId, collections);

    return {
      projectId,
      environment,
      apiUrl: `/v1/projects/${projectId}`,
      openApiUrl: `/v1/projects/${projectId}/openapi.json`,
      collections,
      endpoints,
      authEnabled: Boolean(this.authService),
      sdk: { file: PROJECT_SDK_FILE_NAME, importPath: PROJECT_SDK_IMPORT_PATH, available: sdkStatus === "available" },
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

    const quota = await Promise.resolve(this.quotas?.assertWritesAllowed ? undefined : undefined).catch(() => undefined);

    return {
      requestCount,
      databaseBytes,
      collectionsCount,
      maxDatabaseBytes: quota ?? 1_000_000_000,
      maxRequestsPerMinute: environment === "dev" ? 300 : 120,
    };
  }

  async close() {
    await Promise.all([...this.runtimePools.values()].map((p) => p.end().catch(() => undefined)));
    this.runtimePools.clear();
  }
}
