import { Pool } from "pg";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import {
  DEFAULT_AUTH_SETTINGS,
  type GdprAffectedData,
  type GdprExportResult,
  type GdprStrategy,
  type ProjectAccessPolicy,
  type ProjectAuthSession,
  type ProjectAuthSettings,
  type ProjectAuthUser,
  type ProjectAuthUserStatus,
} from "@npati/shared";
import { DataStudioError } from "./identifier";
import type { DataBackendRepository } from "./repository";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataEnvironmentName } from "./types";
import {
  AuthRateLimiter,
  ProjectKeyManager,
  type ProjectKeyBundle,
} from "./auth-crypto";
import { ensureAuthTables } from "./auth-migration";
import { type EmailProvider, UnconfiguredEmailProvider } from "./email-provider";
import type { ProjectRedirectRepository } from "./redirect-repository";
import type { ProjectAuthHost } from "./auth-service-host";
import {
  getAuthUserMe,
  loginAuthUser,
  logoutAuthSession,
  refreshAuthSession,
  registerAuthUser,
} from "./auth-service-credentials";
import {
  changeAuthPassword,
  forgotAuthPassword,
  resetAuthPassword,
  verifyAuthEmail,
} from "./auth-service-password";
import {
  listAuthUsers,
  setAuthUserRoles,
  setAuthUserStatus,
} from "./auth-service-users";
import {
  applyAuthAccessPolicies,
  getAuthAccessPolicies,
  rotateAuthSigningKey,
} from "./auth-service-policies";
import {
  deleteAuthUser,
  exportAuthUserData,
  previewDeleteAuthUser,
} from "./auth-service-gdpr";

export type { ProjectAuthHost } from "./auth-service-host";
export * from "./auth-service-credentials";
export * from "./auth-service-password";
export * from "./auth-service-users";
export * from "./auth-service-policies";
export * from "./auth-service-gdpr";

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

export class ProjectAuthService implements ProjectAuthHost {
  readonly store: WorkspaceStore;
  readonly repository: DataBackendRepository;
  readonly provisioner: DatabaseProvisioner;
  readonly emailProvider: EmailProvider;
  readonly rateLimiter: AuthRateLimiter;
  readonly poolFactory?: (backend: DataBackend, environment: DataEnvironmentName, role: "migrator" | "runtime") => Promise<Pool> | Pool;
  readonly redirects?: ProjectRedirectRepository;
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

  ownerContext(backend: DataBackend): AuthContext {
    return { workspaceId: backend.workspaceId, userId: backend.createdBy, permissions: ["workspace:read", "business:manage"] };
  }

  /**
   * Validates a client-supplied redirect target against the project allowlist (D6).
   * Returns null when the client did not ask for a deep link, so the token-only flow still works.
   */
  async resolveAuthRedirect(
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

  authLink(redirectTo: string | null, token: string): string | undefined {
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

  async getBackend(ctx: AuthContext, companyId: string, projectId: string): Promise<DataBackend> {
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

  async getPool(backend: DataBackend, environment: DataEnvironmentName, role: "migrator" | "runtime"): Promise<Pool> {
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

  expectedIss(backendId: string, environment: DataEnvironmentName): string {
    return `npati-databackend:${backendId}:${environment}`;
  }

  expectedAud(backendId: string, environment: DataEnvironmentName): string {
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
    return registerAuthUser(this, ctx, companyId, projectId, environment, input, ip);
  }

  async login(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { email: string; password: string },
    ip?: string,
  ): Promise<ProjectAuthSession> {
    return loginAuthUser(this, ctx, companyId, projectId, environment, input, ip);
  }

  async refresh(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { refreshToken: string },
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    return refreshAuthSession(this, ctx, companyId, projectId, environment, input);
  }

  async logout(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { refreshToken: string },
  ): Promise<{ success: boolean }> {
    return logoutAuthSession(this, ctx, companyId, projectId, environment, input);
  }

  async me(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    accessToken: string,
  ): Promise<ProjectAuthUser> {
    return getAuthUserMe(this, ctx, companyId, projectId, environment, accessToken);
  }

  async verifyEmail(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    token: string,
  ): Promise<{ success: boolean; email: string }> {
    return verifyAuthEmail(this, ctx, companyId, projectId, environment, token);
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
    return forgotAuthPassword(this, ctx, companyId, projectId, environment, email, ip, redirectTo);
  }

  async resetPassword(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    input: { token: string; newPassword: string },
    ip?: string,
  ): Promise<{ success: boolean }> {
    return resetAuthPassword(this, ctx, companyId, projectId, environment, input, ip);
  }

  async changePassword(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ success: boolean }> {
    return changeAuthPassword(this, ctx, companyId, projectId, environment, userId, input);
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
    return listAuthUsers(this, ctx, companyId, projectId, environment, query);
  }

  async setUserStatus(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    status: ProjectAuthUserStatus,
  ): Promise<void> {
    return setAuthUserStatus(this, ctx, companyId, projectId, environment, userId, status);
  }

  async setUserRoles(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    roles: string[],
  ): Promise<void> {
    return setAuthUserRoles(this, ctx, companyId, projectId, environment, userId, roles);
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
    return getAuthAccessPolicies(this, ctx, companyId, projectId, environment);
  }

  async applyAccessPolicies(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    policies: ProjectAccessPolicy[],
  ): Promise<{ compiled: number; fingerprint: string }> {
    return applyAuthAccessPolicies(this, ctx, companyId, projectId, environment, policies);
  }

  async rotateSigningKey(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
  ): Promise<{ activeKid: string; previousKids: string[] }> {
    return rotateAuthSigningKey(this, ctx, companyId, projectId, environment);
  }

  // =========================================================================
  // GDPR: User Data Export & Deletion
  // =========================================================================

  async exportUserData(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
  ): Promise<GdprExportResult> {
    return exportAuthUserData(this, ctx, companyId, projectId, environment, userId);
  }

  async previewDeleteUser(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    customStrategies: Record<string, GdprStrategy> = {},
  ): Promise<GdprAffectedData> {
    return previewDeleteAuthUser(this, ctx, companyId, projectId, environment, userId, customStrategies);
  }

  async deleteUser(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    environment: DataEnvironmentName,
    userId: string,
    options: { confirmed: boolean; strategies?: Record<string, GdprStrategy> },
  ): Promise<{ success: boolean; deletedUserId: string }> {
    return deleteAuthUser(this, ctx, companyId, projectId, environment, userId, options);
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
  }
}
