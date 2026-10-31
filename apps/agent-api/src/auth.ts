import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { FastifyRequest } from "fastify";
import type { NpatiAuthClient, NpatiUser } from "@npati/hub-connector";

import { ApiKeysRepository } from "./api-keys-repository";
import { OidcDashboardGate, ScopedRemoteAccessTokenManager, type OidcVerificationConfig } from "./security-guardrails-and-tokens";

export class AuthenticationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 401, code = "UNAUTHORIZED") {
    super(message);
    this.name = "AuthenticationError";
    this.status = status;
    this.code = code;
  }
}

export interface AuthProvider {
  authenticate(request: FastifyRequest): Promise<AuthContext>;
}

export class LocalDevAuthProvider implements AuthProvider {
  private readonly context: AuthContext;
  constructor(input: Partial<AuthContext> = {}) {
    this.context = {
      userId: input.userId ?? "dev-user",
      externalSubject: input.externalSubject ?? "local:dev-user",
      workspaceId: input.workspaceId ?? "dev-workspace",
      permissions: input.permissions ?? ["workspace:read", "workspace:write", "business:manage", "chat:use"],
    };
  }
  async authenticate(_request: FastifyRequest) { return { ...this.context, permissions: [...this.context.permissions] }; }
}

export interface NpatiBackendAuthProviderOptions {
  isInstallationOwner?: (userId: string) => Promise<boolean>;
  jwtSecret?: string;
  authClient?: NpatiAuthClient;
  workspaceStore?: WorkspaceStore;
  allowDevFallback?: boolean;
  apiKeysRepository?: ApiKeysRepository;
  remoteTokensManager?: ScopedRemoteAccessTokenManager;
  oidcConfig?: Partial<OidcVerificationConfig>;
  /**
   * G1 (item 4): where a failed `workspaceStore.initialize()` is reported. Defaults to a structured
   * `console.error` — the one behaviour this must not have is the silence `.catch(() => undefined)` produced.
   */
  onWorkspaceInitFailure?: (failure: WorkspaceInitFailure) => void;
  /** G1 (item 4): consecutive failed attempts per workspace before the negative cache starts holding. */
  workspaceInitMaxAttempts?: number;
  /** G1 (item 4): how long the negative cache holds once that budget is spent. */
  workspaceInitRetryMs?: number;
}

/**
 * G1 (item 4): what is known about a workspace whose migration initialization failed.
 *
 * `auth.ts` is deliberately lazy — it initializes the store for a workspace on the first authenticated request
 * that names it, and several requests for the same workspace share one in-flight attempt. The defect was not the
 * laziness, it was `.catch(() => undefined)`: the failure was **invisible**, the workspace was never marked
 * initialized, and so every later request retried a migration chain that could not succeed. A transient failure
 * still retries (that contract is pinned by `tests/auth-single-flight.test.ts`); a failure that keeps happening
 * is reported once with its reason and then cached negatively until `retryAfter`, instead of being retried on
 * every request forever. The HTTP contract does not change: `authenticate` still does not throw because of this,
 * so a broken database keeps failing where it used to fail (on the query) rather than turning every route into a
 * 500 in a new place.
 */
export interface WorkspaceInitFailure {
  workspaceId: string;
  /** Failed attempts since the last success (or since the process started). */
  attempts: number;
  /** The reason the last attempt failed, verbatim. */
  message: string;
  firstFailedAt: number;
  lastFailedAt: number;
  /** When the next attempt is allowed, or `null` while the attempt budget is not yet spent. */
  retryAfter: number | null;
}

export interface NpatiJwtPayload {
  userId: string;
  email?: string;
  role?: string;
  status?: string;
  exp?: number;
  iat?: number;
  source?: string;
}

export class NpatiBackendAuthProvider implements AuthProvider {
  private readonly isInstallationOwner?: (userId: string) => Promise<boolean>;
  private readonly jwtSecret?: string;
  private readonly authClient?: NpatiAuthClient;
  private readonly workspaceStore?: WorkspaceStore;
  private readonly devFallback: LocalDevAuthProvider;
  private readonly allowDevFallback: boolean;
  private readonly apiKeysRepository?: ApiKeysRepository;
  private readonly remoteTokensManager: ScopedRemoteAccessTokenManager;
  private readonly oidcConfig: OidcVerificationConfig;
  private readonly initializedWorkspaces = new Set<string>();
  private readonly initializingWorkspaces = new Map<string, Promise<void>>();
  /** G1 (item 4): the negative cache of failed initializations, keyed by workspace. */
  private readonly workspaceInitFailures = new Map<string, WorkspaceInitFailure>();
  private readonly onWorkspaceInitFailure: (failure: WorkspaceInitFailure) => void;
  private readonly workspaceInitMaxAttempts: number;
  private readonly workspaceInitRetryMs: number;

  constructor(options: NpatiBackendAuthProviderOptions = {}) {
    this.isInstallationOwner = options.isInstallationOwner;
    this.jwtSecret = options.jwtSecret || process.env.NPATI_JWT_SECRET || process.env.JWT_SECRET;
    this.authClient = options.authClient;
    this.workspaceStore = options.workspaceStore;
    this.allowDevFallback = options.allowDevFallback ?? false;
    this.apiKeysRepository = options.apiKeysRepository;
    this.remoteTokensManager = options.remoteTokensManager ?? new ScopedRemoteAccessTokenManager();
    this.oidcConfig = {
      expectedIssuer: options.oidcConfig?.expectedIssuer || "https://auth.npati.ai",
      expectedAudience: options.oidcConfig?.expectedAudience || "npati-dashboard",
      jwksUri: options.oidcConfig?.jwksUri || process.env.OIDC_JWKS_URI,
      sharedSecret: options.oidcConfig?.sharedSecret || process.env.OIDC_SHARED_SECRET,
      allowedAlgorithms: options.oidcConfig?.allowedAlgorithms || (process.env.OIDC_SHARED_SECRET ? ["RS256", "HS256"] : ["RS256"]),
    };
    this.devFallback = new LocalDevAuthProvider();
    this.workspaceInitMaxAttempts = Math.max(1, options.workspaceInitMaxAttempts ?? 3);
    this.workspaceInitRetryMs = Math.max(0, options.workspaceInitRetryMs ?? 30_000);
    this.onWorkspaceInitFailure = options.onWorkspaceInitFailure ?? ((failure) => {
      const retry = failure.retryAfter === null
        ? `retrying on the next request (attempt ${failure.attempts}/${this.workspaceInitMaxAttempts})`
        : `negative cache holds until ${new Date(failure.retryAfter).toISOString()}`;
      console.error(
        `[auth] workspace store initialization failed for ${failure.workspaceId}: ${failure.message} (${retry})`,
      );
    });
  }

  private async ensureWorkspaceInitialized(authContext: AuthContext): Promise<void> {
    const workspaceId = authContext.workspaceId;
    if (!this.workspaceStore || this.initializedWorkspaces.has(workspaceId)) return;
    /**
     * G1 (item 4): while the negative cache holds, no attempt is made and nothing is logged again — the reason
     * and the attempt count are already recorded, so repeating them per request would be noise, and re-running a
     * migration chain that just failed on every request is the defect this replaced.
     */
    const failed = this.workspaceInitFailures.get(workspaceId);
    if (failed && failed.retryAfter !== null && Date.now() < failed.retryAfter) return;
    let initializing = this.initializingWorkspaces.get(workspaceId);
    if (!initializing) {
      initializing = this.workspaceStore.initialize(authContext)
        .then(() => {
          this.initializedWorkspaces.add(workspaceId);
          this.workspaceInitFailures.delete(workspaceId);
        })
        .catch((error: unknown) => {
          this.recordWorkspaceInitFailure(workspaceId, error);
        })
        .finally(() => { this.initializingWorkspaces.delete(workspaceId); });
      this.initializingWorkspaces.set(workspaceId, initializing);
    }
    await initializing;
  }

  /**
   * G1 (item 4): records a failed initialization and reports it with its reason. Deliberately not a throw: this
   * is the lazy-init path of the existing routes, and turning it into an exception would change their status
   * codes for a failure they already report on the query itself.
   */
  private recordWorkspaceInitFailure(workspaceId: string, error: unknown): void {
    const now = Date.now();
    const previous = this.workspaceInitFailures.get(workspaceId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const budgetSpent = attempts >= this.workspaceInitMaxAttempts;
    const failure: WorkspaceInitFailure = {
      workspaceId,
      attempts,
      message: error instanceof Error ? error.message : String(error),
      firstFailedAt: previous?.firstFailedAt ?? now,
      lastFailedAt: now,
      retryAfter: budgetSpent ? now + this.workspaceInitRetryMs : null,
    };
    this.workspaceInitFailures.set(workspaceId, failure);
    this.onWorkspaceInitFailure(failure);
  }

  /** G1 (item 4): the workspaces whose initialization failed, with the reason and the retry state. */
  workspaceInitializationFailures(): WorkspaceInitFailure[] {
    return [...this.workspaceInitFailures.values()];
  }

  /** G1 (item 4): whether the store is known initialized for this workspace (i.e. the failure state is gone). */
  isWorkspaceInitialized(workspaceId: string): boolean {
    return this.initializedWorkspaces.has(workspaceId);
  }

  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const query = request.query as Record<string, string> | undefined;
    const queryToken = query?.authToken || query?.token;
    const rawApiKey = (request.headers["x-api-key"] as string) || (request.headers["x-npati-api-key"] as string);
    const authHeader = request.headers.authorization;
    const bearerToken = authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : (queryToken && queryToken.trim() ? queryToken.trim() : undefined);
    const tokenOrApiKey = rawApiKey || bearerToken;

    // 1. API Key Authentication (#35 & #221)
    if (tokenOrApiKey && tokenOrApiKey.startsWith("npati_live_")) {
      if (!this.apiKeysRepository) {
        throw new AuthenticationError("API key authentication repository is not configured", 500, "CONFIGURATION_ERROR");
      }
      const ip = (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || request.ip || "127.0.0.1";
      const userAgent = (request.headers["user-agent"] as string) || "unknown-agent";
      const deviceId = (request.headers["x-device-id"] as string) || undefined;
      const platform = (request.headers["sec-ch-ua-platform"] as string)?.replace(/"/g, "") || undefined;
      const result = await this.apiKeysRepository.authenticate(tokenOrApiKey, { ip, userAgent, deviceId, platform });

      if (!result.authenticated || !result.companyId) {
        throw new AuthenticationError(result.error || "Invalid API key", 401, "INVALID_API_KEY");
      }

      // Map scopes to permissions (deny-by-default)
      const rawScopes = result.scopes ?? ["*"];
      const permissions: string[] = [];
      const isWildcard = rawScopes.includes("*") || rawScopes.includes("all");
      if (isWildcard) {
        permissions.push("workspace:read", "workspace:write", "business:manage", "chat:use", "mcp:read", "mcp:execute", "agent:exec");
      } else {
        for (const s of rawScopes) {
          if (s === "chat:use" || s === "chat:write" || s === "chat:read" || s === "chat") permissions.push("chat:use");
          if (s === "workspace:read") permissions.push("workspace:read");
          if (s === "workspace:write") permissions.push("workspace:write");
          if (s === "business:manage") permissions.push("business:manage");
          if (s === "mcp:read") permissions.push("mcp:read");
          if (s === "mcp:execute") permissions.push("mcp:execute");
          if (s === "agent:exec") permissions.push("agent:exec");
          if (s === "memory:read") permissions.push("memory:read");
          if (s === "memory:write") permissions.push("memory:write");
          if (s.startsWith("email:")) permissions.push(s);
        }
      }

      const userId = result.userId || `key:${result.keyId}`;
      const workspaceId = result.tenantId || `workspace:${result.companyId}`;
      const requestedCompanyId = String((request.params as { companyId?: string } | undefined)?.companyId || "");
      if (requestedCompanyId && requestedCompanyId !== result.companyId) {
        throw new AuthenticationError("API key is not valid for this company", 403, "API_KEY_COMPANY_SCOPE_DENIED");
      }
      const authContext: AuthContext = {
        userId,
        externalSubject: `npati:apikey:${result.keyId}`,
        workspaceId,
        permissions,
        apiKeyId: result.keyId,
        companyId: result.companyId,
      };
      await this.ensureWorkspaceInitialized(authContext);
      return authContext;
    }

    // 2. Scoped Remote Access Token (#62)
    if (tokenOrApiKey && tokenOrApiKey.startsWith("rat_")) {
      const clientIp = (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || request.ip || "127.0.0.1";
      const verifyRes = this.remoteTokensManager.verifyRemoteToken(tokenOrApiKey, clientIp);
      if (!verifyRes.isValid || !verifyRes.details) {
        throw new AuthenticationError(verifyRes.error || "Invalid remote access token", 401, "INVALID_REMOTE_TOKEN");
      }
      const details = verifyRes.details;
      const rawScopes = details.scopes || ["*"];
      const permissions: string[] = [];
      const isWildcard = rawScopes.includes("*") || rawScopes.includes("all");
      if (isWildcard) {
        permissions.push("workspace:read", "workspace:write", "business:manage", "chat:use", "mcp:read", "mcp:execute", "agent:exec");
      } else {
        for (const s of rawScopes) {
          if (s === "chat:use" || s === "chat:write" || s === "chat") permissions.push("chat:use");
          if (s === "workspace:read") permissions.push("workspace:read");
          if (s === "workspace:write") permissions.push("workspace:write");
          if (s === "business:manage") permissions.push("business:manage");
          if (s === "mcp:read") permissions.push("mcp:read");
          if (s === "mcp:execute") permissions.push("mcp:execute");
          if (s === "agent:exec") permissions.push("agent:exec");
          if (s === "memory:read") permissions.push("memory:read");
          if (s === "memory:write") permissions.push("memory:write");
          if (s === "tools:read") permissions.push("tools:read", "workspace:read");
          if (s.startsWith("email:")) permissions.push(s);
        }
      }
      const requestedCompanyId = String((request.params as { companyId?: string } | undefined)?.companyId || "");
      if (requestedCompanyId && requestedCompanyId !== details.companyId) {
        throw new AuthenticationError("Remote token is not valid for this company", 403, "REMOTE_TOKEN_COMPANY_SCOPE_DENIED");
      }
      const authContext: AuthContext = {
        userId: details.userId,
        externalSubject: `npati:remote:${details.tokenId}`,
        workspaceId: details.tenantId,
        permissions,
        companyId: details.companyId,
      };
      await this.ensureWorkspaceInitialized(authContext);
      return authContext;
    }

    // 3. OIDC Dashboard Gate Token (#61)
    const oidcHeader = request.headers["x-oidc-token"] as string;
    if (oidcHeader) {
      const oidcRes = await OidcDashboardGate.verifyOidcToken(oidcHeader, this.oidcConfig);
      if (!oidcRes.isValid || !oidcRes.claims) {
        throw new AuthenticationError(oidcRes.error || "Invalid OIDC token", 401, "INVALID_OIDC_TOKEN");
      }
      const claims = oidcRes.claims;
      const userId = claims.sub || claims.email;
      const workspaceId = claims.tenantId ? `workspace:${claims.tenantId}` : `workspace:${userId}`;
      const permissions = ["workspace:read", "workspace:write", "business:manage", "chat:use"];
      if (claims.roles?.some((r) => r === "admin" || r === "superadmin" || r === "moderator")) {
        permissions.push("admin:all", "audit:read");
      }
      const authContext: AuthContext = {
        userId,
        externalSubject: `oidc:${claims.iss}:${claims.sub}`,
        workspaceId,
        permissions,
      };
      await this.ensureWorkspaceInitialized(authContext);
      return authContext;
    }

    // 4. Standard Bearer JWT Authentication
    if (!bearerToken) {
      if (this.allowDevFallback) return this.devFallback.authenticate(request);
      throw new AuthenticationError("Bearer token is required");
    }

    const token = bearerToken;
    if (!token) {
      throw new AuthenticationError("Bearer token is empty", 401, "INVALID_TOKEN");
    }

    try {
      const payload = await this.verifyToken(token);
      const userId = payload.userId;

      const permissions = ["workspace:read", "workspace:write", "business:manage", "chat:use"];
      if (payload.role === "admin" || payload.role === "moderator") {
        permissions.push("admin:all", "audit:read");
      }

      const installationOwner = await this.isInstallationOwner?.(userId) ?? false;
      if (installationOwner) permissions.push("owner", "admin:all", "audit:read", "tools:read", "tools:execute", "code.policy.manage", "code.trust.manage", "code.rbac.manage");

      const workspaceId = userId === "dev-user" ? "dev-workspace" : `workspace:${userId}`;
      const authContext: AuthContext = {
        userId,
        externalSubject: `npati:${userId}`,
        workspaceId,
        permissions,
        ...(installationOwner ? { role: "owner" } : {}),
      };

      await this.ensureWorkspaceInitialized(authContext);
      return authContext;
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("Authentication is temporarily unavailable", 503, "AUTH_BACKEND_UNAVAILABLE");
    }
  }

  async verifyToken(token: string): Promise<NpatiJwtPayload> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new AuthenticationError("Malformed token: JWT must have 3 segments", 401, "INVALID_TOKEN");
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    let header;
    try { header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8")); } catch {
      throw new AuthenticationError("Invalid token header", 401, "INVALID_TOKEN");
    }
    if (header.alg !== "HS256" || (!this.jwtSecret && !this.authClient)) {
      throw new AuthenticationError("Token verification is not configured or algorithm is unsupported", 401, "INVALID_TOKEN");
    }

    if (this.jwtSecret) {
      const expectedSig = createHmac("sha256", this.jwtSecret)
        .update(`${headerB64}.${payloadB64}`)
        .digest("base64url");
      if (!signatureB64 || signatureB64.length !== expectedSig.length || !timingSafeEqual(Buffer.from(signatureB64), Buffer.from(expectedSig))) {
        throw new AuthenticationError("Token signature verification failed", 401, "INVALID_TOKEN");
      }
    }

    let payload: NpatiJwtPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    } catch {
      throw new AuthenticationError("Invalid token payload: JSON decoding failed", 401, "INVALID_TOKEN");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
      throw new AuthenticationError("Token has expired", 401, "TOKEN_EXPIRED");
    }

    if (this.authClient && !this.jwtSecret) {
      const user = await this.authClient.getCurrentUser(token).catch((err) => {
        const status = Number(err?.status);
        if (status === 401 || status === 403) {
          throw new AuthenticationError(err.message || "NPATI session is invalid", status, "UNAUTHORIZED");
        }
        throw new AuthenticationError("NPATI authentication service is temporarily unavailable", 503, "AUTH_BACKEND_UNAVAILABLE");
      });
      if (user.status === "banned" || user.status === "inactive") {
        throw new AuthenticationError(`Account is ${user.status}`, 403, "ACCOUNT_DISABLED");
      }
      payload.userId = user.id;
      payload.email = user.email;
      payload.role = user.role;
    }

    if (!payload.userId || typeof payload.userId !== "string") throw new AuthenticationError("Token subject is missing", 401, "INVALID_TOKEN");
    if (payload.status === "banned" || payload.status === "inactive") throw new AuthenticationError("Account is disabled", 403, "ACCOUNT_DISABLED");
    return payload;
  }
}

export function createMockNpatiJwt(
  claims: Partial<NpatiJwtPayload> & { userId: string },
  secret: string,
  expiresInSeconds?: number
): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = claims.exp !== undefined ? claims.exp : now + (expiresInSeconds ?? 3600);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      userId: claims.userId,
      email: claims.email || `${claims.userId}@npati.ai`,
      role: claims.role || "user",
      exp,
      iat: claims.iat || now,
      ...(claims.source ? { source: claims.source } : {}),
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
