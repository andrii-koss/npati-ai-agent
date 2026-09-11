import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { FastifyRequest } from "fastify";
import type { NpatiAuthClient, NpatiUser } from "@npati/hub-connector";

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
  jwtSecret?: string;
  authClient?: NpatiAuthClient;
  workspaceStore?: WorkspaceStore;
  allowDevFallback?: boolean;
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
  private readonly jwtSecret?: string;
  private readonly authClient?: NpatiAuthClient;
  private readonly workspaceStore?: WorkspaceStore;
  private readonly devFallback: LocalDevAuthProvider;
  private readonly allowDevFallback: boolean;
  private readonly initializedWorkspaces = new Set<string>();
  private readonly initializingWorkspaces = new Map<string, Promise<void>>();

  constructor(options: NpatiBackendAuthProviderOptions = {}) {
    this.jwtSecret = options.jwtSecret || process.env.NPATI_JWT_SECRET || process.env.JWT_SECRET;
    this.authClient = options.authClient;
    this.workspaceStore = options.workspaceStore;
    this.allowDevFallback = options.allowDevFallback ?? false;
    this.devFallback = new LocalDevAuthProvider();
  }

  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (this.allowDevFallback) return this.devFallback.authenticate(request);
      throw new AuthenticationError("Bearer token is required");
    }

    const token = authHeader.slice(7).trim();
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

      const workspaceId = `workspace:${userId}`;
      const authContext: AuthContext = {
        userId,
        externalSubject: `npati:${userId}`,
        workspaceId,
        permissions,
      };

      if (this.workspaceStore && !this.initializedWorkspaces.has(workspaceId)) {
        let initializing = this.initializingWorkspaces.get(workspaceId);
        if (!initializing) {
          initializing = this.workspaceStore.initialize(authContext)
            .then(() => { this.initializedWorkspaces.add(workspaceId); }).catch(() => undefined)
            .finally(() => { this.initializingWorkspaces.delete(workspaceId); });
          this.initializingWorkspaces.set(workspaceId, initializing);
        }
        await initializing;
      }

      return authContext;
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("Token verification failed", 401, "INVALID_TOKEN");
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
        throw new AuthenticationError(err.message || "Failed to verify user with NPATI backend", 401, "UNAUTHORIZED");
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
  secret = "pati-backend-jwt-secret-key-2024-min-32-chars-long",
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

