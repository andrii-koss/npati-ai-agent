import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { FastifyRequest } from "fastify";
import type { NpatiAuthClient, NpatiUser } from "@npati/hub-connector";

import { ApiKeysRepository } from "./api-keys-repository";
import { OidcDashboardGate, ScopedRemoteAccessTokenManager, type OidcVerificationConfig, configuredOidc } from "./security-guardrails-and-tokens";
import { SessionRevocations } from "./session-revocation";
import { StreamTicketError, StreamTicketService } from "./stream-tickets";
import { accessTokenFromCookie, csrfFailure } from "./browser-session";

/**
 * The credential in an Authorization header. The web app's non-secret session marker (`npati-cookie-session:…`, which
 * stands in for the token in page code since the session moved into an HttpOnly cookie) is never a credential.
 */
export const SESSION_MARKER_PREFIX = "npati-cookie-session:";
export function sessionBearer(header: string | undefined): string | undefined {
  if (!header || !header.startsWith("Bearer ")) return undefined;
  const value = header.slice(7).trim();
  return value && !value.startsWith(SESSION_MARKER_PREFIX) ? value : undefined;
}

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

/** Delegated keys must explicitly grant chat access independently of workspace read access. */
export function assertChatKeyScope(auth: AuthContext): void {
  if (auth.apiKeyId && !auth.permissions.includes("chat:use")) {
    throw new AuthenticationError("API key requires chat:use scope", 403, "CHAT_SCOPE_REQUIRED");
  }
}

export interface AuthProvider {
  authenticate(request: FastifyRequest): Promise<AuthContext>;
  /** Signs out the request's session token, or every token of the person with `everywhere` (V6 step 17). */
  revokeSession?(request: FastifyRequest, everywhere: boolean): Promise<boolean>;
  /** Mints a short-lived ticket for one GET path (audit L6); providers without it cannot issue tickets. */
  mintStreamTicket?(context: AuthContext, path: string): { ticket: string; expiresAt: number; path: string };
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
  streamTickets?: StreamTicketService;
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
  private readonly revocations?: SessionRevocations;
  private readonly devFallback: LocalDevAuthProvider;
  private readonly allowDevFallback: boolean;
  private readonly apiKeysRepository?: ApiKeysRepository;
  private readonly remoteTokensManager: ScopedRemoteAccessTokenManager;
  private readonly streamTickets: StreamTicketService;
  /** Null unless an operator configured OIDC (see configuredOidc): the x-oidc-token header is then refused. */
  private readonly oidcConfig: OidcVerificationConfig | null;
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
    this.revocations = options.workspaceStore ? new SessionRevocations(options.workspaceStore) : undefined;
    this.allowDevFallback = options.allowDevFallback ?? false;
    this.apiKeysRepository = options.apiKeysRepository;
    this.remoteTokensManager = options.remoteTokensManager ?? new ScopedRemoteAccessTokenManager();
    this.streamTickets = options.streamTickets ?? new StreamTicketService();
    this.oidcConfig = configuredOidc(process.env, options.oidcConfig);
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

  /** Mints a 60-second ticket for one GET path (audit L6). Called only from a request authenticated by header. */
  mintStreamTicket(context: AuthContext, path: string) {
    return this.streamTickets.mint(context, path);
  }

  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const query = request.query as Record<string, string> | undefined;
    const rawApiKey = (request.headers["x-api-key"] as string) || (request.headers["x-npati-api-key"] as string);
    const authHeader = request.headers.authorization;
    // Audit L6: a session credential is accepted only from the Authorization header. Elements that cannot send headers
    // (downloads, images, event streams) use a short-lived ticket bound to one path (POST /stream-tickets).
    let bearerToken = sessionBearer(authHeader);
    if (!bearerToken && !rawApiKey) {
      const ticket = typeof query?.ticket === "string" ? query.ticket.trim() : "";
      if (ticket) {
        let ticketContext: AuthContext;
        try { ticketContext = this.streamTickets.verify(ticket, request.url, request.method); }
        catch (error) {
          if (error instanceof StreamTicketError) throw new AuthenticationError(error.message, error.status, error.code);
          throw error;
        }
        await this.ensureWorkspaceInitialized(ticketContext);
        return ticketContext;
      }
      if (typeof query?.token === "string" && query.token.trim()) {
        throw new AuthenticationError("Session tokens are no longer accepted in URLs; send an Authorization header or use a stream ticket", 401, "TOKEN_IN_URL_REFUSED");
      }
      // L6 stage 2: the browser session is an HttpOnly cookie. Unsafe methods must pass the CSRF check.
      const cookieToken = accessTokenFromCookie(request);
      if (cookieToken) {
        const csrf = csrfFailure(request);
        if (csrf) throw new AuthenticationError("Cross-site request refused", 403, csrf);
        bearerToken = cookieToken;
      }
    }
    const tokenOrApiKey = rawApiKey || bearerToken;

    // 1. API Key Authentication (#35 & #221)
    if (tokenOrApiKey && tokenOrApiKey.startsWith("npati_live_")) {
      if (!this.apiKeysRepository) {
        throw new AuthenticationError("API key authentication repository is not configured", 500, "CONFIGURATION_ERROR");
      }
      const ip = request.ip || "127.0.0.1" /* audit L2: X-Forwarded-For is honoured only via Fastify trustProxy (NPATI_TRUST_PROXY) */;
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
      const clientIp = request.ip || "127.0.0.1" /* audit L2: X-Forwarded-For is honoured only via Fastify trustProxy (NPATI_TRUST_PROXY) */;
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
      if (!this.oidcConfig) throw new AuthenticationError("OIDC sign-in is not configured on this installation", 401, "OIDC_NOT_CONFIGURED");
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
      // Sign-outs are stored in the workspace; one that could not be initialized holds none, and reading it would retry the
      // initialization outside its own retry budget (security gate G1).
      if (this.isWorkspaceInitialized(workspaceId) && await this.revocations?.isRevoked(authContext, token, (payload as { iat?: number }).iat)) {
        throw new AuthenticationError("This session was signed out", 401, "TOKEN_REVOKED");
      }
      return authContext;
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("Authentication is temporarily unavailable", 503, "AUTH_BACKEND_UNAVAILABLE");
    }
  }

  /**
   * Signs out the token of this request (or, with `everywhere`, every token of the person issued so far). Returns false
   * when the request carries no valid session token, which a sign-out of an already expired page is.
   */
  async revokeSession(request: FastifyRequest, everywhere: boolean): Promise<boolean> {
    const token = sessionBearer(request.headers.authorization) || accessTokenFromCookie(request) || "";
    if (!token || !this.revocations || token.startsWith("npati_live_") || token.startsWith("rat_")) return false;
    let context: AuthContext;
    try { context = await this.authenticate(request); } catch { return false; }
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    await this.revocations.revoke(context, token, Number(payload.exp) || Math.floor(Date.now() / 1000) + 3600, everywhere);
    return true;
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

/**
 * Query-string credentials kept out of request logs. Browser media and event streams pass `?token=` because they
 * cannot send an Authorization header, and Fastify logs every request URL, so a session or preview token in the URL
 * would otherwise be written to the log in full.
 */
const SECRET_QUERY = /([?&](?:token|ticket|authToken|access_token|api_key|apiKey|key)=)[^&#]*/giu;

/**
 * Inbound webhook and channel URLs carry their secret as a path segment; every delivery wrote it to the request log in
 * plain text (V6 step 17).
 */
const SECRET_PATH = /(\/v1\/(?:webhooks|integrations\/telegram|integrations\/slack\/http|integrations\/whatsapp\/cloud)\/)[^/?#]+/giu;

export function redactUrlSecrets(url: string | undefined): string | undefined {
  return url?.replace(SECRET_QUERY, "$1[REDACTED]").replace(SECRET_PATH, "$1[REDACTED]");
}

/** Fastify's default request serializer with the URL's credentials redacted. */
export function redactedRequestSerializer(request: { method?: string; url?: string; version?: string; host?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) {
  return {
    method: request.method,
    url: redactUrlSecrets(request.url),
    version: request.version,
    host: request.host ?? request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
