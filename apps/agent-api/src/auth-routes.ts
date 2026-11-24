import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { NpatiAuthClient } from "@npati/hub-connector";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import { AuthenticationError, createMockNpatiJwt, sessionBearer } from "./auth";
import { REFRESH_COOKIE, accessTokenFromCookie, appendSetCookies, clearSessionCookies, readCookie } from "./browser-session";
import { OidcDashboardGate, configuredOidc } from "./security-guardrails-and-tokens";

/**
 * G1 (item 4): the workspace store's lazy initialization on the registration/login path.
 *
 * Both handlers swallowed the failure in an empty `catch` block, so a store that could not be initialized — a
 * missing table, an unreachable database, a failed migration chain — left the caller with `success: true` and left
 * **nothing** anywhere saying why their next request would fail. The response contract is deliberately unchanged
 * (the account was created upstream, so failing the response would misreport a registration that really happened);
 * what the caller and the operator now get is the reason, with the workspace it belongs to.
 */
async function initializeWorkspaceFor(context: AuthContext, workspaceStore: WorkspaceStore, request: FastifyRequest): Promise<void> {
  try {
    await workspaceStore.initialize(context);
  } catch (error) {
    request.log.error(
      { err: error, workspaceId: context.workspaceId, code: "workspace_store_init_failed" },
      "Workspace store initialization failed after authentication succeeded",
    );
  }
}

export interface AuthRoutesOptions {
  authClient?: NpatiAuthClient;
  workspaceStore: WorkspaceStore;
  authProvider: AuthProvider;
  allowLegacyPasswordAuth?: boolean;
  localJwtSigningSecret?: string;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions
) {
  const { authClient, workspaceStore, authProvider } = options;

  const rejectDisabledLegacyAuth = (reply: FastifyReply) =>
    reply.code(410).send({
      success: false,
      error: {
        code: "CENTRAL_ACCOUNT_CONNECTION_REQUIRED",
        message: "Connect your NPATI account through the official authorization flow.",
      },
    });

  const handleRegister = async (request: FastifyRequest<{
    Body: {
      email?: string;
      password?: string;
      username?: string;
      displayName?: string;
      name?: string;
      country?: string;
    };
  }>, reply: FastifyReply) => {
    if (!options.allowLegacyPasswordAuth) return rejectDisabledLegacyAuth(reply);

    if (!authClient) {
      return reply.code(503).send({
        success: false,
        error: { code: "NPATI_BACKEND_UNAVAILABLE", message: "NPATI main backend is not configured or unavailable." },
      });
    }

    const { email, password, username, displayName, name, country } = (request.body || {}) as {
      email?: string;
      password?: string;
      username?: string;
      displayName?: string;
      name?: string;
      country?: string;
    };

    if (!email || !email.includes("@")) {
      return reply.code(400).send({
        success: false,
        error: { code: "INVALID_EMAIL", message: "A valid email address is required." },
      });
    }

    if (!password || password.length < 8) {
      return reply.code(400).send({
        success: false,
        error: { code: "INVALID_PASSWORD", message: "Password must be at least 8 characters." },
      });
    }

    let resolvedUsername = (username?.trim() || (email.split("@")[0] ?? "").replace(/[^a-zA-Z0-9_]/g, "_")).slice(0, 30);
    if (resolvedUsername.length < 3) {
      resolvedUsername = `${resolvedUsername}_usr`;
    }
    const resolvedDisplayName = displayName?.trim() || name?.trim() || resolvedUsername;

    try {
      const authResult = await authClient.register({
        email: email.trim().toLowerCase(),
        password,
        username: resolvedUsername,
        displayName: resolvedDisplayName,
        country: country && country.length === 2 ? country.toUpperCase() : undefined,
      });

      const { user, tokens } = authResult;
      const authContext = {
        userId: user.id,
        externalSubject: `npati:${user.id}`,
        workspaceId: `workspace:${user.id}`,
        permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"],
      };

      await initializeWorkspaceFor(authContext, workspaceStore, request);

      const userPayload = {
        id: user.id,
        email: user.email,
        username: user.username || resolvedUsername,
        displayName: user.displayName || resolvedDisplayName,
        name: user.name || user.displayName || resolvedDisplayName,
        role: user.role || "user",
      };

      return reply.code(200).send({
        success: true,
        tokens,
        user: userPayload,
        data: {
          user: userPayload,
          tokens,
        },
      });
    } catch (err: any) {
      const status = err.status || 400;
      return reply.code(status).send({
        success: false,
        error: {
          code: err.code || (status === 409 ? "USER_EXISTS" : "REGISTRATION_FAILED"),
          message: err.message || "Registration failed.",
        },
      });
    }
  };

  const handleLogin = async (request: FastifyRequest<{
    Body: {
      email?: string;
      password?: string;
    };
  }>, reply: FastifyReply) => {
    if (!options.allowLegacyPasswordAuth) return rejectDisabledLegacyAuth(reply);

    const { email, password } = request.body || {};

    if (!email || !password) {
      return reply.code(400).send({
        success: false,
        error: { code: "CREDENTIALS_REQUIRED", message: "Email and password are required." },
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!authClient) {
      return reply.code(503).send({
        success: false,
        error: { code: "NPATI_BACKEND_UNAVAILABLE", message: "NPATI main backend is not configured or unavailable." },
      });
    }

    try {
      const authResult = await authClient.login({
        email: normalizedEmail,
        password,
      });

      const { user, tokens } = authResult;
      const authContext = {
        userId: user.id,
        externalSubject: `npati:${user.id}`,
        workspaceId: `workspace:${user.id}`,
        permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"],
      };

      await initializeWorkspaceFor(authContext, workspaceStore, request);

      const userPayload = {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName || user.username || user.name,
        name: user.name || user.displayName || user.username,
        role: user.role || "user",
      };

      return reply.code(200).send({
        success: true,
        tokens,
        user: userPayload,
        data: {
          user: userPayload,
          tokens,
        },
      });
    } catch (err: any) {
      const status = err.status || 401;
      return reply.code(status).send({
        success: false,
        error: {
          code: err.code || (status === 401 ? "INVALID_CREDENTIALS" : "LOGIN_FAILED"),
          message: err.message || "Invalid credentials.",
        },
      });
    }
  };

  const handleRefresh = async (request: FastifyRequest<{
    Body: {
      refreshToken?: string;
    };
  }>, reply: FastifyReply) => {
    // L6 stage 2: a browser keeps its refresh token in an HttpOnly cookie (Path=/api/auth).
    const refreshToken = request.body?.refreshToken || readCookie(request.headers.cookie, REFRESH_COOKIE);
    if (!refreshToken) {
      return reply.code(400).send({
        success: false,
        error: { code: "REFRESH_TOKEN_REQUIRED", message: "Refresh token is required." },
      });
    }

    if (!options.allowLegacyPasswordAuth) return rejectDisabledLegacyAuth(reply);

    if (!authClient) {
      return reply.code(503).send({
        success: false,
        error: { code: "NPATI_BACKEND_UNAVAILABLE", message: "NPATI main backend is not configured or unavailable." },
      });
    }

    try {
      const result = await authClient.refresh(refreshToken);
      return reply.code(200).send({
        success: true,
        tokens: result.tokens || result,
        data: result,
      });
    } catch (err: any) {
      const status = err.status || 401;
      return reply.code(status).send({
        success: false,
        error: {
          code: err.code || "REFRESH_FAILED",
          message: err.message || "Token refresh failed.",
        },
      });
    }
  };

  const handleLogout = async (request: FastifyRequest<{
    Body: {
      refreshToken?: string;
      everywhere?: boolean;
    };
  }>, reply: FastifyReply) => {
    // L6 stage 2: a browser signs out with its session cookies; they are cleared whatever happens below.
    const refreshToken = request.body?.refreshToken || readCookie(request.headers.cookie, REFRESH_COOKIE);
    if (request.headers.cookie) appendSetCookies(reply, clearSessionCookies(request));
    // The access token of this request stops working now, not when it expires (V6 step 17: it kept opening the API for
    // up to 15 minutes after "Sign out" answered "Successfully logged out").
    let revoked = false;
    try {
      revoked = await authProvider.revokeSession?.(request, request.body?.everywhere === true) ?? false;
    } catch {
      return reply.code(503).send({ success: false, error: { code: "SIGN_OUT_NOT_SAVED", message: "Sign-out could not be saved. Please try again." } });
    }
    if (authClient && refreshToken) {
      try {
        const result = await authClient.logout(refreshToken);
        return reply.code(200).send({ success: true, revoked, message: result.message || "Logged out successfully." });
      } catch {
        return reply.code(200).send({ success: true, revoked, message: "Logged out." });
      }
    }
    return reply.code(200).send({ success: true, revoked, message: "Logged out." });
  };

  const handleMe = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const auth = await authProvider.authenticate(request);
      const overview = await workspaceStore.overview(auth);
      const bearerToken = sessionBearer(request.headers.authorization) || accessTokenFromCookie(request);
      const centralUser = bearerToken && authClient && !bearerToken.startsWith("npati_live_") && !bearerToken.startsWith("rat_")
        ? await authClient.getCurrentUser(bearerToken).catch(() => null)
        : null;
      const profile = centralUser?.id === auth.userId ? centralUser : null;
      return reply.code(200).send({
        success: true,
        data: {
          user: profile ? {
            id: profile.id,
            email: profile.email,
            username: profile.username,
            displayName: profile.displayName,
            firstName: profile.firstName,
            lastName: profile.lastName,
            avatar: profile.avatar,
            role: profile.role,
          } : overview.user,
          workspace: overview.workspace,
          permissions: auth.permissions,
        },
      });
    } catch (err: any) {
      if (err instanceof AuthenticationError) {
        return reply.code(err.status).send({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      request.log.error({ err }, "Could not load authenticated profile");
      return reply.code(503).send({
        success: false,
        error: { code: "AUTH_BACKEND_UNAVAILABLE", message: "Authentication is temporarily unavailable." },
      });
    }
  };

  const handleOidcLogin = async (
    request: FastifyRequest<{ Body: { idToken?: string; token?: string } }>,
    reply: FastifyReply
  ) => {
    if (!options.allowLegacyPasswordAuth) return rejectDisabledLegacyAuth(reply);

    const rawToken = request.body?.idToken || request.body?.token;
    if (!rawToken) {
      return reply.code(400).send({
        success: false,
        error: { code: "OIDC_TOKEN_REQUIRED", message: "OIDC ID token is required." },
      });
    }

    const configured = configuredOidc();
    if (!configured) return reply.code(404).send({ success: false, error: { code: "OIDC_NOT_CONFIGURED", message: "OIDC sign-in is not configured on this installation." } });
    const config = {
      ...configured,
    };

    const verification = await OidcDashboardGate.verifyOidcToken(rawToken, config);
    if (!verification.isValid || !verification.claims) {
      return reply.code(401).send({
        success: false,
        error: { code: "INVALID_OIDC_TOKEN", message: verification.error || "OIDC verification failed." },
      });
    }

    const claims = verification.claims;
    const userId = claims.sub || claims.email;
    const email = claims.email;
    const role = claims.roles?.includes("admin") || claims.roles?.includes("superadmin") ? "admin" : "user";
    const tenantId = claims.tenantId || `comp-${userId}`;

    if (!options.localJwtSigningSecret) {
      return reply.code(503).send({
        success: false,
        error: { code: "JWT_SIGNING_SECRET_REQUIRED", message: "OIDC token exchange is not configured." },
      });
    }
    const accessToken = createMockNpatiJwt(
      { userId, email, role, source: "oidc" },
      options.localJwtSigningSecret
    );

    return reply.code(200).send({
      success: true,
      authenticated: true,
      user: {
        id: userId,
        email,
        name: claims.name || email,
        role,
        tenantId,
      },
      tokens: {
        accessToken,
        tokenType: "Bearer",
        expiresIn: 3600,
      },
    });
  };

  // Register on both /auth/* and /api/auth/* for direct and proxied calls
  app.post("/auth/register", handleRegister);
  app.post("/api/auth/register", handleRegister);

  app.post("/auth/login", handleLogin);
  app.post("/api/auth/login", handleLogin);

  app.post("/auth/oidc/login", handleOidcLogin);
  app.post("/api/auth/oidc/login", handleOidcLogin);

  app.post("/auth/refresh", handleRefresh);
  app.post("/api/auth/refresh", handleRefresh);

  app.post("/auth/logout", handleLogout);
  app.post("/api/auth/logout", handleLogout);

  app.get("/auth/me", handleMe);
  app.get("/api/auth/me", handleMe);
}
