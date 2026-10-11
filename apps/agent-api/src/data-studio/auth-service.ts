import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import {
  DEFAULT_AUTH_SETTINGS,
  type GdprAffectedCollection,
  type GdprAffectedData,
  type GdprExportResult,
  type GdprStrategy,
  type ProjectAccessPolicy,
  type ProjectAuthSession,
  type ProjectAuthSettings,
  type ProjectAuthUser,
  type ProjectAuthUserStatus,
} from "@npati/shared";
import { DataStudioError, quoteIdentifier, validateIdentifier } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataEnvironmentName } from "./types";
import {
  AuthRateLimiter,
  OpaqueTokenManager,
  ProjectKeyManager,
  ProjectPasswordHasher,
  type ProjectKeyBundle,
} from "./auth-crypto";
import { ensureAuthTables } from "./auth-migration";
import { RlsPolicyCompiler } from "./rls-compiler";
import { type EmailProvider, UnconfiguredEmailProvider } from "./email-provider";
import type { ProjectRedirectRepository } from "./redirect-repository";

export interface ProjectAuthServiceOptions {
  store: WorkspaceStore;
  repository: DataBackendRepository;
  provisioner: DatabaseProvisioner;
  emailProvider?: EmailProvider;
  rateLimiter?: AuthRateLimiter;
  poolFactory?: (backend: DataBackend, environment: DataEnvironmentName, role: "migrator" | "runtime") => Promise<Pool> | Pool;
  /** Per-project redirect URL allowlist used for mobile deep links (D6). */
  redirects?: ProjectRedirectRepository;
}

export class ProjectAuthService {
  readonly store: WorkspaceStore;
  readonly repository: DataBackendRepository;
  readonly provisioner: DatabaseProvisioner;
  readonly emailProvider: EmailProvider;
  readonly rateLimiter: AuthRateLimiter;
  private readonly poolFactory?: (backend: DataBackend, environment: DataEnvironmentName, role: "migrator" | "runtime") => Promise<Pool> | Pool;
  private readonly redirects?: ProjectRedirectRepository;
  private readonly pools = new Map<string, Pool>();

  constructor(options: ProjectAuthServiceOptions) {
    this.store = options.store;
    this.repository = options.repository;
    this.provisioner = options.provisioner;
    this.emailProvider = options.emailProvider ?? new UnconfiguredEmailProvider();
    this.rateLimiter = options.rateLimiter ?? new AuthRateLimiter();
    this.poolFactory = options.poolFactory;
    this.redirects = options.redirects;
  }

  private ownerContext(backend: DataBackend): AuthContext {
    return { workspaceId: backend.workspaceId, userId: backend.createdBy, permissions: ["workspace:read", "business:manage"] };
  }

  /**
   * Validates a client-supplied redirect target against the project allowlist (D6).
   * Returns null when the client did not ask for a deep link, so the token-only flow still works.
   */
  private async resolveAuthRedirect(
    backend: DataBackend,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    redirectTo?: string,
  ): Promise<string | null> {
    if (!redirectTo) return null;
    if (!this.redirects) {
      throw new DataStudioError(400, "redirect", "Redirect URL is not registered for this project", false, "REDIRECT_NOT_ALLOWED");
    }
    return this.redirects.assertAllowed(this.ownerContext(backend), companyId, projectId, environment, redirectTo);
  }

  private authLink(redirectTo: string | null, token: string): string | undefined {
    if (!redirectTo) return undefined;
    const separator = redirectTo.includes("?") ? "&" : "?";
    return `${redirectTo}${separator}token=${encodeURIComponent(token)}`;
  }

  async getRedirectUrls(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName): Promise<{ redirectUrls: string[] }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    if (!this.redirects) return { redirectUrls: [] };
    return { redirectUrls: await this.redirects.list(this.ownerContext(backend), companyId, projectId, environment) };
  }

  async updateRedirectUrls(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    urls: string[],
  ): Promise<{ redirectUrls: string[] }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    if (!this.redirects) {
      throw new DataStudioError(503, "redirect", "Redirect URL storage is unavailable", true, "REDIRECTS_UNAVAILABLE");
    }
    return { redirectUrls: await this.redirects.replace(this.ownerContext(backend), companyId, projectId, environment, urls) };
  }

  private async getBackend(ctx: AuthContext, companyId: string, projectId: string): Promise<DataBackend> {
    let effectiveCtx = ctx;
    if (ctx.userId === "client-guest" || ctx.workspaceId === "client-auth") {
      let companyInfo: { workspaceId: string; userId: string } | undefined;
      const storeAny = this.store as any;
      if (storeAny.companies?.get) {
        const c = storeAny.companies.get(companyId);
        if (c) companyInfo = { workspaceId: c.workspaceId, userId: c.userId };
      } else if (storeAny.pool?.query) {
        const res = await storeAny.pool.query("SELECT workspace_id, user_id FROM companies WHERE id = $1", [companyId]);
        if (res.rows[0]) companyInfo = { workspaceId: res.rows[0].workspace_id, userId: res.rows[0].user_id };
      }
      if (companyInfo) {
        effectiveCtx = {
          workspaceId: companyInfo.workspaceId,
          userId: companyInfo.userId,
          permissions: ["workspace:read", "business:manage"],
        };
      }
    }

    const project = await this.store.getProject(effectiveCtx, companyId, projectId);
    if (!project) throw new DataStudioError(404, "project", "Project not found", false, "PROJECT_NOT_FOUND");
    if (!project.dataBackendId) {
      throw new DataStudioError(400, "project", "Project does not have an attached DataBackend", false, "NO_DATA_BACKEND");
    }
    const backend = await this.repository.get(effectiveCtx, companyId, project.dataBackendId);
    if (backend.status !== "ready") {
      throw new DataStudioError(409, "backend", "DataBackend is not in ready status", false, "BACKEND_NOT_READY");
    }
    return backend;
  }

  private async getPool(backend: DataBackend, environment: DataEnvironmentName, role: "migrator" | "runtime"): Promise<Pool> {
    const key = `${backend.id}:${environment}:${role}`;
    let pool = this.pools.get(key);
    if (!pool) {
      if (this.poolFactory) {
        pool = await this.poolFactory(backend, environment, role);
      } else {
        const conn = await this.provisioner.getConnection(backend, environment, role);
        pool = new Pool({ ...conn, max: 5, connectionTimeoutMillis: 3000 });
      }
      // Database deletion/restart may close idle auth connections. pg removes
      // those clients; active authentication query failures still reject.
      pool.on?.("error", () => {});
      this.pools.set(key, pool);
    }
    return pool;
  }

  /**
   * Ensures auth tables and signing keys are initialized for this backend and environment.
   */
  async ensureInitialized(ctx: AuthContext, backend: DataBackend, environment: DataEnvironmentName): Promise<ProjectKeyBundle> {
    const migratorPool = await this.getPool(backend, environment, "migrator");
    const runtimeUser = this.poolFactory ? "npati_runtime" : (await this.provisioner.getConnection(backend, environment, "runtime")).user;

    const client = await migratorPool.connect();
    try {
      await ensureAuthTables(client, runtimeUser);
    } finally {
      client.release();
    }

    const ownerCtx: AuthContext = {
      workspaceId: backend.workspaceId,
      userId: backend.createdBy,
      permissions: ["workspace:read", "business:manage"],
    };

    let bundle = await this.repository.getSigningKeys(ownerCtx, backend.companyId, backend.id, environment);
    if (!bundle) {
      bundle = ProjectKeyManager.createBundle();
      await this.repository.saveSigningKeys(ownerCtx, backend.companyId, backend.id, environment, bundle);
    }
    return bundle;
  }

  async getAuthSettings(ctx: AuthContext, companyId: string, projectId: string, environment: DataEnvironmentName): Promise<ProjectAuthSettings> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const ownerCtx: AuthContext = {
      workspaceId: backend.workspaceId,
      userId: backend.createdBy,
      permissions: ["workspace:read", "business:manage"],
    };
    const env = await this.repository.environment(ownerCtx, companyId, backend.id, environment);
    const cfg = (env.providerConfig?.auth as Partial<ProjectAuthSettings>) ?? {};
    return { ...DEFAULT_AUTH_SETTINGS, ...cfg };
  }

  async updateAuthSettings(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    patch: Partial<ProjectAuthSettings>,
  ): Promise<ProjectAuthSettings> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const env = await this.repository.environment(ctx, companyId, backend.id, environment);
    const current = (env.providerConfig?.auth as Partial<ProjectAuthSettings>) ?? {};
    const updated: ProjectAuthSettings = { ...DEFAULT_AUTH_SETTINGS, ...current, ...patch };

    await this.repository.setEnvironment(ctx, companyId, backend.id, environment, {
      providerConfig: { ...env.providerConfig, auth: updated },
    });
    return updated;
  }

  private expectedIss(backendId: string, environment: DataEnvironmentName): string {
    return `npati-databackend:${backendId}:${environment}`;
  }

  private expectedAud(backendId: string, environment: DataEnvironmentName): string {
    return `npati-project-api:${backendId}:${environment}`;
  }

  // =========================================================================
  // End-User Authentication Flows
  // =========================================================================

  async register(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { email: string; password: string; metadata?: Record<string, unknown>; redirectTo?: string },
    ip?: string,
  ): Promise<{ user: ProjectAuthUser; session: ProjectAuthSession | null; message?: string }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const settings = await this.getAuthSettings(ctx, companyId, projectId, environment);
    const redirectTo = await this.resolveAuthRedirect(backend, companyId, projectId, environment, input.redirectTo);

    if (!settings.allowRegistration) {
      throw new DataStudioError(403, "auth_register", "User registration is disabled for this project", false, "REGISTRATION_DISABLED");
    }

    const emailNorm = (input.email ?? "").trim().toLowerCase();
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      throw new DataStudioError(400, "auth_register", "Invalid email address format", false, "INVALID_EMAIL");
    }

    if (ip) this.rateLimiter.check(`ip:${ip}`);
    this.rateLimiter.check(`email:${emailNorm}`);

    ProjectPasswordHasher.validatePolicy(input.password, settings);
    const bundle = await this.ensureInitialized(ctx, backend, environment);
    const passwordHash = await ProjectPasswordHasher.hash(input.password);

    const pool = await this.getPool(backend, environment, "runtime");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ id: string }>("SELECT id FROM _npati_auth_users WHERE email = $1", [emailNorm]);
      if (existing.rowCount) {
        throw new DataStudioError(409, "auth_register", "A user with this email already exists", false, "EMAIL_ALREADY_EXISTS");
      }

      const initialStatus: ProjectAuthUserStatus = settings.requireEmailVerification ? "pending" : "active";
      const userRes = await client.query<{
        id: string;
        email: string;
        email_verified: boolean;
        status: ProjectAuthUserStatus;
        created_at: string;
        last_login: string | null;
        metadata: Record<string, unknown>;
      }>(
        `INSERT INTO _npati_auth_users(email, password_hash, email_verified, status, metadata)
         VALUES($1, $2, $3, $4, $5)
         RETURNING id, email, email_verified, status, created_at, last_login, metadata`,
        [emailNorm, passwordHash, !settings.requireEmailVerification, initialStatus, JSON.stringify(input.metadata ?? {})],
      );

      const userId = userRes.rows[0]!.id;
      await client.query(
        "INSERT INTO _npati_auth_user_roles(user_id, role) VALUES($1, 'user') ON CONFLICT DO NOTHING",
        [userId],
      );

      const user: ProjectAuthUser = {
        id: userId,
        email: userRes.rows[0]!.email,
        emailVerified: userRes.rows[0]!.email_verified,
        status: userRes.rows[0]!.status,
        roles: ["user"],
        createdAt: userRes.rows[0]!.created_at,
        lastLogin: userRes.rows[0]!.last_login,
        metadata: userRes.rows[0]!.metadata,
      };

      if (settings.requireEmailVerification) {
        const verifyToken = OpaqueTokenManager.generate();
        const verifyHash = OpaqueTokenManager.hash(verifyToken);
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await client.query(
          "INSERT INTO _npati_auth_verification_tokens(token_hash, user_id, expires_at) VALUES($1, $2, $3)",
          [verifyHash, userId, expiresAt],
        );
        await client.query("COMMIT");

        // Send email (throws EMAIL_SERVICE_UNCONFIGURED if unconfigured)
        await this.emailProvider.sendVerificationEmail(emailNorm, verifyToken, emailNorm, { link: this.authLink(redirectTo, verifyToken) });

        return {
          user,
          session: null,
          message: "Registration successful. Please verify your email before logging in.",
        };
      }

      // If active immediately, issue session
      const familyId = randomUUID();
      const refreshToken = OpaqueTokenManager.generate();
      const refreshHash = OpaqueTokenManager.hash(refreshToken);
      const refreshExpiresAt = new Date(Date.now() + (settings.refreshTokenTtlDays || 30) * 24 * 60 * 60 * 1000);

      await client.query(
        "INSERT INTO _npati_auth_refresh_tokens(token_hash, family_id, user_id, expires_at) VALUES($1, $2, $3, $4)",
        [refreshHash, familyId, userId, refreshExpiresAt],
      );
      await client.query("COMMIT");

      const ttlSec = (settings.accessTokenTtlMinutes || 15) * 60;
      const accessToken = ProjectKeyManager.signJwt(
        {
          iss: this.expectedIss(backend.id, environment),
          aud: this.expectedAud(backend.id, environment),
          sub: user.id,
          role: "user",
          roles: ["user"],
          exp: Math.floor(Date.now() / 1000) + ttlSec,
        },
        bundle,
      );

      return {
        user,
        session: {
          user,
          accessToken,
          refreshToken,
          expiresIn: ttlSec,
        },
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async login(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { email: string; password: string },
    ip?: string,
  ): Promise<ProjectAuthSession> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const settings = await this.getAuthSettings(ctx, companyId, projectId, environment);
    const emailNorm = (input.email ?? "").trim().toLowerCase();

    if (ip) this.rateLimiter.check(`ip:${ip}`);
    this.rateLimiter.check(`email:${emailNorm}`);

    const bundle = await this.ensureInitialized(ctx, backend, environment);
    const pool = await this.getPool(backend, environment, "runtime");

    const userRes = await pool.query<{
      id: string;
      email: string;
      password_hash: string;
      email_verified: boolean;
      status: ProjectAuthUserStatus;
      created_at: string;
      last_login: string | null;
      metadata: Record<string, unknown>;
    }>("SELECT * FROM _npati_auth_users WHERE email = $1", [emailNorm]);

    if (!userRes.rowCount) {
      await ProjectPasswordHasher.dummyVerify();
      if (ip) this.rateLimiter.recordFailure(`ip:${ip}`);
      this.rateLimiter.recordFailure(`email:${emailNorm}`);
      throw new DataStudioError(401, "auth_login", "Invalid email or password", false, "INVALID_CREDENTIALS");
    }

    const row = userRes.rows[0]!;

    if (row.status === "suspended") {
      await ProjectPasswordHasher.dummyVerify();
      throw new DataStudioError(403, "auth_login", "Your account has been suspended", false, "ACCOUNT_SUSPENDED");
    }

    if (row.status === "pending") {
      throw new DataStudioError(403, "auth_login", "Please verify your email address before logging in", false, "EMAIL_NOT_VERIFIED");
    }

    const isValid = await ProjectPasswordHasher.verify(input.password, row.password_hash);
    if (!isValid) {
      if (ip) this.rateLimiter.recordFailure(`ip:${ip}`);
      this.rateLimiter.recordFailure(`email:${emailNorm}`);
      throw new DataStudioError(401, "auth_login", "Invalid email or password", false, "INVALID_CREDENTIALS");
    }

    // Success: clear rate limits
    if (ip) this.rateLimiter.recordSuccess(`ip:${ip}`);
    this.rateLimiter.recordSuccess(`email:${emailNorm}`);

    const rolesRes = await pool.query<{ role: string }>(
      "SELECT role FROM _npati_auth_user_roles WHERE user_id = $1",
      [row.id],
    );
    const roles = rolesRes.rows.map((r) => r.role);
    if (!roles.length) roles.push("user");

    await pool.query("UPDATE _npati_auth_users SET last_login = now() WHERE id = $1", [row.id]);

    const familyId = randomUUID();
    const refreshToken = OpaqueTokenManager.generate();
    const refreshHash = OpaqueTokenManager.hash(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + (settings.refreshTokenTtlDays || 30) * 24 * 60 * 60 * 1000);

    await pool.query(
      "INSERT INTO _npati_auth_refresh_tokens(token_hash, family_id, user_id, expires_at) VALUES($1, $2, $3, $4)",
      [refreshHash, familyId, row.id, refreshExpiresAt],
    );

    const ttlSec = (settings.accessTokenTtlMinutes || 15) * 60;
    const accessToken = ProjectKeyManager.signJwt(
      {
        iss: this.expectedIss(backend.id, environment),
        aud: this.expectedAud(backend.id, environment),
        sub: row.id,
        role: roles[0]!,
        roles,
        exp: Math.floor(Date.now() / 1000) + ttlSec,
      },
      bundle,
    );

    const user: ProjectAuthUser = {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified,
      status: row.status,
      roles,
      createdAt: row.created_at,
      lastLogin: new Date().toISOString(),
      metadata: row.metadata,
    };

    return {
      user,
      accessToken,
      refreshToken,
      expiresIn: ttlSec,
    };
  }

  async refresh(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { refreshToken: string },
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const settings = await this.getAuthSettings(ctx, companyId, projectId, environment);
    const bundle = await this.ensureInitialized(ctx, backend, environment);
    const pool = await this.getPool(backend, environment, "runtime");

    const tokenHash = OpaqueTokenManager.hash(input.refreshToken);
    const tokenRes = await pool.query<{
      id: string;
      family_id: string;
      user_id: string;
      expires_at: string;
      rotated_at: string | null;
      revoked_at: string | null;
    }>("SELECT * FROM _npati_auth_refresh_tokens WHERE token_hash = $1", [tokenHash]);

    if (!tokenRes.rowCount) {
      throw new DataStudioError(401, "auth_refresh", "Invalid refresh token", false, "INVALID_REFRESH_TOKEN");
    }

    const token = tokenRes.rows[0]!;

    if (token.revoked_at) {
      throw new DataStudioError(401, "auth_refresh", "Refresh token has been revoked", false, "TOKEN_REVOKED");
    }

    // Reuse detection: token already rotated! Revoke entire family!
    if (token.rotated_at) {
      await pool.query("UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE family_id = $1", [token.family_id]);
      throw new DataStudioError(
        401,
        "auth_refresh",
        "Refresh token reuse detected; all sessions revoked for security. Please log in again.",
        false,
        "TOKEN_REUSE_DETECTED",
      );
    }

    if (new Date(token.expires_at).getTime() < Date.now()) {
      throw new DataStudioError(401, "auth_refresh", "Refresh token has expired", false, "TOKEN_EXPIRED");
    }

    const userRes = await pool.query<{ id: string; status: ProjectAuthUserStatus }>(
      "SELECT id, status FROM _npati_auth_users WHERE id = $1",
      [token.user_id],
    );
    if (!userRes.rowCount || userRes.rows[0]!.status !== "active") {
      throw new DataStudioError(403, "auth_refresh", "User account is no longer active", false, "ACCOUNT_INACTIVE");
    }

    const rolesRes = await pool.query<{ role: string }>(
      "SELECT role FROM _npati_auth_user_roles WHERE user_id = $1",
      [token.user_id],
    );
    const roles = rolesRes.rows.map((r) => r.role);
    if (!roles.length) roles.push("user");

    // Rotate token
    await pool.query("UPDATE _npati_auth_refresh_tokens SET rotated_at = now() WHERE id = $1", [token.id]);

    const newRefreshToken = OpaqueTokenManager.generate();
    const newHash = OpaqueTokenManager.hash(newRefreshToken);
    const refreshExpiresAt = new Date(Date.now() + (settings.refreshTokenTtlDays || 30) * 24 * 60 * 60 * 1000);

    await pool.query(
      "INSERT INTO _npati_auth_refresh_tokens(token_hash, family_id, user_id, expires_at) VALUES($1, $2, $3, $4)",
      [newHash, token.family_id, token.user_id, refreshExpiresAt],
    );

    const ttlSec = (settings.accessTokenTtlMinutes || 15) * 60;
    const newAccessToken = ProjectKeyManager.signJwt(
      {
        iss: this.expectedIss(backend.id, environment),
        aud: this.expectedAud(backend.id, environment),
        sub: token.user_id,
        role: roles[0]!,
        roles,
        exp: Math.floor(Date.now() / 1000) + ttlSec,
      },
      bundle,
    );

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: ttlSec,
    };
  }

  async logout(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { refreshToken: string },
  ): Promise<{ success: boolean }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const pool = await this.getPool(backend, environment, "runtime");

    const tokenHash = OpaqueTokenManager.hash(input.refreshToken);
    const tokenRes = await pool.query<{ family_id: string }>(
      "SELECT family_id FROM _npati_auth_refresh_tokens WHERE token_hash = $1",
      [tokenHash],
    );

    if (tokenRes.rowCount) {
      await pool.query(
        "UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE family_id = $1",
        [tokenRes.rows[0]!.family_id],
      );
    }

    return { success: true };
  }

  async me(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    accessToken: string,
  ): Promise<ProjectAuthUser> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const bundle = await this.ensureInitialized(ctx, backend, environment);

    const claims = ProjectKeyManager.verifyJwt(
      accessToken,
      bundle,
      this.expectedIss(backend.id, environment),
      this.expectedAud(backend.id, environment),
    );

    const pool = await this.getPool(backend, environment, "runtime");
    const userRes = await pool.query<{
      id: string;
      email: string;
      email_verified: boolean;
      status: ProjectAuthUserStatus;
      created_at: string;
      last_login: string | null;
      metadata: Record<string, unknown>;
    }>(
      "SELECT id, email, email_verified, status, created_at, last_login, metadata FROM _npati_auth_users WHERE id = $1",
      [claims.sub],
    );

    if (!userRes.rowCount) {
      throw new DataStudioError(404, "auth_me", "User not found", false, "USER_NOT_FOUND");
    }

    const row = userRes.rows[0]!;
    const rolesRes = await pool.query<{ role: string }>(
      "SELECT role FROM _npati_auth_user_roles WHERE user_id = $1",
      [row.id],
    );
    const roles = rolesRes.rows.map((r) => r.role);

    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified,
      status: row.status,
      roles,
      createdAt: row.created_at,
      lastLogin: row.last_login,
      metadata: row.metadata,
    };
  }

  async verifyEmail(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    token: string,
  ): Promise<{ success: boolean; email: string }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const pool = await this.getPool(backend, environment, "runtime");
    const tokenHash = OpaqueTokenManager.hash(token);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tokenRes = await client.query<{
        id: string;
        user_id: string;
        expires_at: string;
        used_at: string | null;
      }>("SELECT * FROM _npati_auth_verification_tokens WHERE token_hash = $1 FOR UPDATE", [tokenHash]);

      if (!tokenRes.rowCount) {
        throw new DataStudioError(400, "verify_email", "Invalid verification token", false, "INVALID_TOKEN");
      }

      const row = tokenRes.rows[0]!;
      if (row.used_at) {
        throw new DataStudioError(400, "verify_email", "Verification token already used", false, "TOKEN_ALREADY_USED");
      }

      if (new Date(row.expires_at).getTime() < Date.now()) {
        throw new DataStudioError(400, "verify_email", "Verification token has expired", false, "TOKEN_EXPIRED");
      }

      await client.query("UPDATE _npati_auth_verification_tokens SET used_at = now() WHERE id = $1", [row.id]);
      const userRes = await client.query<{ email: string }>(
        "UPDATE _npati_auth_users SET email_verified = true, status = 'active' WHERE id = $1 RETURNING email",
        [row.user_id],
      );

      await client.query("COMMIT");
      return { success: true, email: userRes.rows[0]!.email };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async forgotPassword(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    email: string,
    ip?: string,
    redirectTo?: string,
  ): Promise<{ success: boolean; message: string }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const resolvedRedirect = await this.resolveAuthRedirect(backend, companyId, projectId, environment, redirectTo);
    const emailNorm = (email ?? "").trim().toLowerCase();

    if (ip) this.rateLimiter.check(`ip:${ip}`);
    this.rateLimiter.check(`email:${emailNorm}`);

    const pool = await this.getPool(backend, environment, "runtime");
    const userRes = await pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM _npati_auth_users WHERE email = $1",
      [emailNorm],
    );

    // Standard no-user-enumeration response
    const genericResponse = {
      success: true,
      message: "If this email is registered, password reset instructions have been sent.",
    };

    if (!userRes.rowCount) {
      await ProjectPasswordHasher.dummyVerify();
      return genericResponse;
    }

    const user = userRes.rows[0]!;
    const resetToken = OpaqueTokenManager.generate();
    const tokenHash = OpaqueTokenManager.hash(resetToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour TTL

    await pool.query(
      "INSERT INTO _npati_auth_reset_tokens(token_hash, user_id, expires_at) VALUES($1, $2, $3)",
      [tokenHash, user.id, expiresAt],
    );

    await this.emailProvider.sendPasswordResetEmail(user.email, resetToken, user.email, { link: this.authLink(resolvedRedirect, resetToken) });
    return genericResponse;
  }

  async resetPassword(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { token: string; newPassword: string },
    ip?: string,
  ): Promise<{ success: boolean }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const settings = await this.getAuthSettings(ctx, companyId, projectId, environment);

    if (ip) this.rateLimiter.check(`ip:${ip}`);

    ProjectPasswordHasher.validatePolicy(input.newPassword, settings);
    const tokenHash = OpaqueTokenManager.hash(input.token);

    const pool = await this.getPool(backend, environment, "runtime");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tokenRes = await client.query<{
        id: string;
        user_id: string;
        expires_at: string;
        used_at: string | null;
      }>("SELECT * FROM _npati_auth_reset_tokens WHERE token_hash = $1 FOR UPDATE", [tokenHash]);

      if (!tokenRes.rowCount) {
        throw new DataStudioError(400, "reset_password", "Invalid or expired reset token", false, "INVALID_TOKEN");
      }

      const row = tokenRes.rows[0]!;
      if (row.used_at) {
        throw new DataStudioError(400, "reset_password", "Reset token already used", false, "TOKEN_ALREADY_USED");
      }

      if (new Date(row.expires_at).getTime() < Date.now()) {
        throw new DataStudioError(400, "reset_password", "Reset token has expired", false, "TOKEN_EXPIRED");
      }

      const newHash = await ProjectPasswordHasher.hash(input.newPassword);
      await client.query("UPDATE _npati_auth_users SET password_hash = $1 WHERE id = $2", [newHash, row.user_id]);

      // Consume this token
      await client.query("UPDATE _npati_auth_reset_tokens SET used_at = now() WHERE id = $1", [row.id]);
      // Invalidate all other pending reset tokens for this user
      await client.query(
        "UPDATE _npati_auth_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
        [row.user_id],
      );
      // Revoke all existing sessions
      await client.query(
        "UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1",
        [row.user_id],
      );

      await client.query("COMMIT");
      return { success: true };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async changePassword(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ success: boolean }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const settings = await this.getAuthSettings(ctx, companyId, projectId, environment);
    ProjectPasswordHasher.validatePolicy(input.newPassword, settings);

    const pool = await this.getPool(backend, environment, "runtime");
    const userRes = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM _npati_auth_users WHERE id = $1",
      [userId],
    );
    if (!userRes.rowCount) {
      throw new DataStudioError(404, "change_password", "User not found", false, "USER_NOT_FOUND");
    }

    const isValid = await ProjectPasswordHasher.verify(input.currentPassword, userRes.rows[0]!.password_hash);
    if (!isValid) {
      throw new DataStudioError(401, "change_password", "Current password does not match", false, "INVALID_CREDENTIALS");
    }

    const newHash = await ProjectPasswordHasher.hash(input.newPassword);
    await pool.query("UPDATE _npati_auth_users SET password_hash = $1 WHERE id = $2", [newHash, userId]);
    // Invalidate pending reset tokens & sessions
    await pool.query(
      "UPDATE _npati_auth_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [userId],
    );
    await pool.query(
      "UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1",
      [userId],
    );

    return { success: true };
  }

  // =========================================================================
  // Control Plane Admin Operations
  // =========================================================================

  async listUsers(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    query: { limit?: number; offset?: number; search?: string; status?: ProjectAuthUserStatus } = {},
  ): Promise<{ users: ProjectAuthUser[]; total: number }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    await this.ensureInitialized(ctx, backend, environment);
    const pool = await this.getPool(backend, environment, "migrator");

    const params: unknown[] = [];
    const where: string[] = [];

    if (query.status) {
      params.push(query.status);
      where.push(`u.status = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search.toLowerCase()}%`);
      where.push(`LOWER(u.email) LIKE $${params.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text as count FROM _npati_auth_users u ${whereClause}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? 0);

    const limit = Math.min(Math.max(1, query.limit ?? 50), 100);
    const offset = Math.max(0, query.offset ?? 0);
    params.push(limit, offset);

    const sql = `
      SELECT u.id, u.email, u.email_verified, u.status, u.created_at, u.last_login, u.metadata,
             COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') as roles
      FROM _npati_auth_users u
      LEFT JOIN _npati_auth_user_roles r ON r.user_id = u.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const res = await pool.query<{
      id: string;
      email: string;
      email_verified: boolean;
      status: ProjectAuthUserStatus;
      created_at: string;
      last_login: string | null;
      metadata: Record<string, unknown>;
      roles: string[];
    }>(sql, params);

    const users: ProjectAuthUser[] = res.rows.map((row) => ({
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified,
      status: row.status,
      roles: row.roles,
      createdAt: row.created_at,
      lastLogin: row.last_login,
      metadata: row.metadata,
    }));

    return { users, total };
  }

  async setUserStatus(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    status: ProjectAuthUserStatus,
  ): Promise<void> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const pool = await this.getPool(backend, environment, "migrator");

    const res = await pool.query("UPDATE _npati_auth_users SET status = $1 WHERE id = $2", [status, userId]);
    if (!res.rowCount) {
      throw new DataStudioError(404, "admin_user", "User not found", false, "USER_NOT_FOUND");
    }

    if (status === "suspended") {
      // Revoke all refresh tokens
      await pool.query("UPDATE _npati_auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1", [userId]);
    }
  }

  async setUserRoles(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    roles: string[],
  ): Promise<void> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const pool = await this.getPool(backend, environment, "migrator");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userCheck = await client.query("SELECT id FROM _npati_auth_users WHERE id = $1", [userId]);
      if (!userCheck.rowCount) {
        throw new DataStudioError(404, "admin_user", "User not found", false, "USER_NOT_FOUND");
      }

      await client.query("DELETE FROM _npati_auth_user_roles WHERE user_id = $1", [userId]);
      for (const role of roles) {
        validateIdentifier(role);
        await client.query(
          "INSERT INTO _npati_auth_roles(name) VALUES($1) ON CONFLICT DO NOTHING",
          [role],
        );
        await client.query(
          "INSERT INTO _npati_auth_user_roles(user_id, role) VALUES($1, $2)",
          [userId, role],
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

  // =========================================================================
  // Access Policies & RLS Compiler
  // =========================================================================

  async getAccessPolicies(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
  ): Promise<ProjectAccessPolicy[]> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    return this.repository.getAccessPolicies(ctx, companyId, backend.id, environment);
  }

  async applyAccessPolicies(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    policies: ProjectAccessPolicy[],
  ): Promise<{ compiled: number; fingerprint: string }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const migratorPool = await this.getPool(backend, environment, "migrator");

    // Group policies by collection
    const byCollection = new Map<string, ProjectAccessPolicy[]>();
    for (const policy of policies) {
      RlsPolicyCompiler.validate(policy);
      const list = byCollection.get(policy.collection) ?? [];
      list.push(policy);
      byCollection.set(policy.collection, list);
    }

    const client = await migratorPool.connect();
    try {
      await client.query("BEGIN");
      for (const [col, colPolicies] of byCollection.entries()) {
        const compiled = RlsPolicyCompiler.compile(col, colPolicies);
        for (const statement of compiled.sql) {
          await client.query(statement);
        }
        const runtimeUser = this.poolFactory ? "npati_runtime" : (await this.provisioner.getConnection(backend, environment, "runtime")).user;
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdentifier(col)} TO ${quoteIdentifier(runtimeUser)}`);
        await this.repository.setCollectionAccessPolicies(ctx, companyId, backend.id, environment, col, colPolicies);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const allPolicies = await this.repository.getAccessPolicies(ctx, companyId, backend.id, environment);
    const fingerprint = RlsPolicyCompiler.computeFingerprint("all", allPolicies);
    return { compiled: byCollection.size, fingerprint };
  }

  async rotateSigningKey(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
  ): Promise<{ activeKid: string; previousKids: string[] }> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const settings = await this.getAuthSettings(ctx, companyId, projectId, environment);
    const bundle = await this.ensureInitialized(ctx, backend, environment);

    const ttlSec = (settings.accessTokenTtlMinutes || 15) * 60;
    const rotated = ProjectKeyManager.rotateBundle(bundle, ttlSec);
    await this.repository.saveSigningKeys(ctx, companyId, backend.id, environment, rotated);

    return {
      activeKid: rotated.activeKey.kid,
      previousKids: rotated.previousKeys.map((k) => k.kid),
    };
  }

  // =========================================================================
  // GDPR: User Data Export & Deletion
  // =========================================================================

  private async findUserReferenceCollections(
    pool: Pool,
  ): Promise<Array<{ collection: string; field: string }>> {
    // Find all public tables (not starting with _npati_) that have a column owner_id or user_id
    const colsRes = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name NOT LIKE '_npati_%'
         AND column_name IN ('owner_id', 'user_id', 'author_id', 'account_id', 'created_by')
       ORDER BY table_name`,
    );

    return colsRes.rows.map((r) => ({ collection: r.table_name, field: r.column_name }));
  }

  async exportUserData(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
  ): Promise<GdprExportResult> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const pool = await this.getPool(backend, environment, "migrator");

    const userRes = await pool.query<{
      id: string;
      email: string;
      email_verified: boolean;
      status: ProjectAuthUserStatus;
      created_at: string;
      last_login: string | null;
      metadata: Record<string, unknown>;
    }>(
      "SELECT id, email, email_verified, status, created_at, last_login, metadata FROM _npati_auth_users WHERE id = $1",
      [userId],
    );

    if (!userRes.rowCount) {
      throw new DataStudioError(404, "gdpr_export", "User not found", false, "USER_NOT_FOUND");
    }

    const row = userRes.rows[0]!;
    const rolesRes = await pool.query<{ role: string }>(
      "SELECT role FROM _npati_auth_user_roles WHERE user_id = $1",
      [userId],
    );

    const user: ProjectAuthUser = {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified,
      status: row.status,
      roles: rolesRes.rows.map((r) => r.role),
      createdAt: row.created_at,
      lastLogin: row.last_login,
      metadata: row.metadata,
    };

    const collections = await this.findUserReferenceCollections(pool);
    const data: Record<string, Record<string, unknown>[]> = {};

    for (const ref of collections) {
      const qRes = await pool.query<Record<string, unknown>>(
        `SELECT * FROM ${quoteIdentifier(ref.collection)} WHERE ${quoteIdentifier(ref.field)} = $1`,
        [userId],
      );
      data[ref.collection] = qRes.rows;
    }

    return {
      user,
      data,
      exportedAt: new Date().toISOString(),
    };
  }

  async previewDeleteUser(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    customStrategies: Record<string, GdprStrategy> = {},
  ): Promise<GdprAffectedData> {
    const backend = await this.getBackend(ctx, companyId, projectId);
    const settings = await this.repository.environment(ctx, companyId, backend.id, environment);
    customStrategies = { ...(settings.providerConfig.gdprStrategies as Record<string, GdprStrategy> ?? {}), ...customStrategies };
    const pool = await this.getPool(backend, environment, "migrator");

    const userRes = await pool.query("SELECT id FROM _npati_auth_users WHERE id = $1", [userId]);
    if (!userRes.rowCount) {
      throw new DataStudioError(404, "gdpr_delete", "User not found", false, "USER_NOT_FOUND");
    }

    const refs = await this.findUserReferenceCollections(pool);
    const affected: GdprAffectedCollection[] = [];
    let total = 0;

    for (const ref of refs) {
      // Default strategies for known patterns
      let strategy: GdprStrategy = customStrategies[ref.collection] ?? "delete";
      if (["orders", "order_items", "payments", "invoices"].includes(ref.collection)) {
        strategy = customStrategies[ref.collection] ?? "anonymize";
      }

      const countRes = await pool.query<{ count: string }>(
        `SELECT count(*)::text as count FROM ${quoteIdentifier(ref.collection)} WHERE ${quoteIdentifier(ref.field)} = $1`,
        [userId],
      );
      const count = Number(countRes.rows[0]?.count ?? 0);
      if (count > 0) {
        affected.push({
          collection: ref.collection,
          strategy,
          affectedRows: count,
        });
        total += count;
      }
    }

    return {
      userId,
      collections: affected,
      totalAffectedRows: total,
    };
  }

  async deleteUser(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    options: { confirmed: boolean; strategies?: Record<string, GdprStrategy> },
  ): Promise<{ success: boolean; deletedUserId: string }> {
    if (!options.confirmed) {
      throw new DataStudioError(400, "gdpr_delete", "CONFIRMATION_REQUIRED: User deletion requires explicit confirmation", false, "CONFIRMATION_REQUIRED");
    }

    const backend = await this.getBackend(ctx, companyId, projectId);
    const pool = await this.getPool(backend, environment, "migrator");
    const refs = await this.findUserReferenceCollections(pool);

    const env = await this.repository.environment(ctx, companyId, backend.id, environment);
    const strategies = { ...(env.providerConfig.gdprStrategies as Record<string, GdprStrategy> ?? {}), ...options.strategies };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const ref of refs) {
        const strat = strategies[ref.collection] ?? (
          ["orders", "order_items", "payments", "invoices"].includes(ref.collection) ? "anonymize" : "delete"
        );

        const tbl = quoteIdentifier(ref.collection);
        const col = quoteIdentifier(ref.field);

        switch (strat) {
          case "delete":
            await client.query(`DELETE FROM ${tbl} WHERE ${col} = $1`, [userId]);
            break;
          case "detach":
            await client.query(`UPDATE ${tbl} SET ${col} = NULL WHERE ${col} = $1`, [userId]);
            break;
          case "anonymize": {
            const columns = await client.query<{ column_name: string; data_type: string }>(
              "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
              [ref.collection],
            );
            const personalFields = new Set(["email", "phone", "name", "first_name", "last_name", "recipient_name", "city", "street", "postal_code", "address", "shipping_address"]);
            const assignments = [`${col} = NULL`];
            for (const field of columns.rows) {
              if (!personalFields.has(field.column_name) || field.column_name === ref.field) continue;
              if (["text", "character varying", "character"].includes(field.data_type)) assignments.push(`${quoteIdentifier(field.column_name)} = '[deleted]'`);
              else if (["json", "jsonb"].includes(field.data_type)) assignments.push(`${quoteIdentifier(field.column_name)} = '{}'`);
            }
            await client.query(`UPDATE ${tbl} SET ${assignments.join(", ")} WHERE ${col} = $1`, [userId]);
            break;
          }
          case "retain":
            // Keep rows as-is (audit requirement)
            break;
        }
      }

      await client.query("DELETE FROM _npati_auth_users WHERE id = $1", [userId]);
      await client.query("COMMIT");
      return { success: true, deletedUserId: userId };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
  }
}
