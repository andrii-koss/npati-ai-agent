import { registerProjectApiControlClient } from "../project-api-control-channel";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DataStudioError, normalizeDataQueryError } from "./identifier";
import type { ProjectApiGatewayService, GatewayAuthResult } from "./gateway-service";
import type { ProjectAuthService } from "./auth-service";

interface ProjectRouteParams {
  projectId: string;
  collection?: string;
  id?: string;
}

/** Maximum JSON body size for public Project API write routes. */
export const PROJECT_API_BODY_LIMIT = 1024 * 1024;

/**
 * Public Project API routes enforce their own per-Project CORS allowlist, so the
 * application-wide CORS plugin must not answer or decorate these requests.
 */
const PUBLIC_ROUTE = { config: { cors: false } } as const;
const PUBLIC_WRITE_ROUTE = { ...PUBLIC_ROUTE, bodyLimit: PROJECT_API_BODY_LIMIT };

export function registerProjectApiGatewayRoutes(
  app: FastifyInstance,
  gateway?: ProjectApiGatewayService,
  authService?: ProjectAuthService,
) {
  const base = "/v1/projects/:projectId";
  if (gateway) registerProjectApiControlClient(app);

  const runWithGateway = async (
    request: FastifyRequest<{ Params: ProjectRouteParams }>,
    reply: FastifyReply,
    handler: (auth: GatewayAuthResult) => Promise<unknown>,
  ) => {
    const started = Date.now();
    let authResult: GatewayAuthResult | undefined;
    let statusCode = 200;

    try {
      if (!gateway) {
        throw new DataStudioError(503, "gateway", "Project API Gateway is unavailable", true, "GATEWAY_UNAVAILABLE");
      }

      const projectId = request.params.projectId;
      const headers = request.headers as Record<string, string | undefined>;
      const queryKey = undefined;
      const ip = request.ip;
      const origin = request.headers.origin;

      authResult = await gateway.authenticateRequest(projectId, headers, queryKey, ip, origin);

      // Set CORS response headers
      if (origin) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Access-Control-Allow-Credentials", "true");
        reply.header("Vary", "Origin");
      }

      const result = await handler(authResult);
      statusCode = reply.statusCode || 200;
      return result;
    } catch (error: any) {
      error = normalizeDataQueryError(error);
      const status = error instanceof DataStudioError ? error.status : error.statusCode || 500;
      const code = error instanceof DataStudioError ? error.code : error.code || "INTERNAL_ERROR";
      const message = error instanceof DataStudioError ? error.message : "Internal Server Error";
      statusCode = status;

      // Handle CORS headers on error if origin was verified
      if (request.headers.origin && authResult) {
        reply.header("Access-Control-Allow-Origin", request.headers.origin);
        reply.header("Access-Control-Allow-Credentials", "true");
        reply.header("Vary", "Origin");
      }

      return reply.code(status).send({
        error: { code, message, status },
      });
    } finally {
      const durationMs = Date.now() - started;
      if (gateway && authResult) {
        gateway.recordLog({
          projectId: request.params.projectId,
          backendId: authResult.backend.id,
          environment: authResult.environment,
          keyType: authResult.keyType,
          method: request.method,
          path: request.url.split("?")[0] || request.url,
          statusCode,
          durationMs,
          ip: request.ip,
        });
      }
    }
  };

  // =========================================================================
  // CORS Preflight Options
  // =========================================================================

  app.options(`${base}/*`, PUBLIC_ROUTE, async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return reply.code(204).send();

    if (!gateway) return reply.code(503).send();
    try {
      const projectId = (request.params as any).projectId;
      if (!await gateway.isPreflightOriginAllowed(projectId, origin)) throw new Error("Origin denied");
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Project-Key, X-User-Token");
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Max-Age", "86400");
      reply.header("Vary", "Origin");
      return reply.code(204).send();
    } catch {
      return reply.code(403).send({ error: { code: "CORS_FORBIDDEN", message: "Origin not allowed", status: 403 } });
    }
  });

  // =========================================================================
  // OpenAPI & Docs
  // =========================================================================

  // Schema documents require a valid Project API key; the environment comes from the key.
  app.get<{ Params: ProjectRouteParams }>(`${base}/openapi.json`, PUBLIC_ROUTE, (request, reply) =>
    runWithGateway(request, reply, (auth) => gateway!.getOpenApiSpec(request.params.projectId, auth.environment)),
  );

  app.get<{ Params: ProjectRouteParams }>(`${base}/types.ts`, PUBLIC_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) =>
      reply.type("text/plain; charset=utf-8").send(await gateway!.getTypeScriptTypes(request.params.projectId, auth.environment)),
    ),
  );
  app.get<{ Params: ProjectRouteParams }>(
    `${base}/docs`,
    PUBLIC_ROUTE,
    (request, reply) => runWithGateway(request, reply, async (auth) => {
      const projectId = request.params.projectId;
      const spec = await gateway!.getOpenApiSpec(projectId, auth.environment);
      return reply.code(200).type("text/html").send(`
<!DOCTYPE html>
<html>
<head>
  <title>Project API Documentation</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body { margin: 0; background: #0f172a; } .swagger-ui { filter: invert(88%) hue-rotate(180deg); }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        spec: ${JSON.stringify(spec).replace(/</g, "\\u003c")},
        dom_id: '#swagger-ui',
      });
    };
  </script>
</body>
</html>
      `);
    }),
  );

  // =========================================================================
  // Auth Endpoints
  // =========================================================================

  const handleRegister = (request: FastifyRequest<{ Params: ProjectRouteParams; Body: { email: string; password: string; name?: string; redirectTo?: string } }>, reply: FastifyReply) =>
    runWithGateway(request, reply, async (auth) => {
      if (!authService) throw new DataStudioError(503, "auth", "Project Auth service unavailable", true, "AUTH_UNAVAILABLE");
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      const registered = await authService.register(
        ctx, auth.project.companyId, auth.project.id, auth.environment, request.body,
      );
      return reply.code(201).send({
        user: registered.user,
        token: registered.session?.accessToken,
        refreshToken: registered.session?.refreshToken,
        expiresIn: registered.session?.expiresIn,
        message: registered.message,
      });
    });

  app.post<{ Params: ProjectRouteParams; Body: { email: string; password: string; name?: string; redirectTo?: string } }>(`${base}/auth/register`, PUBLIC_WRITE_ROUTE, handleRegister);
  app.post<{ Params: ProjectRouteParams; Body: { email: string; password: string; name?: string; redirectTo?: string } }>(`${base}/auth/signup`, PUBLIC_WRITE_ROUTE, handleRegister);

  const handleLogin = (request: FastifyRequest<{ Params: ProjectRouteParams; Body: { email: string; password: string } }>, reply: FastifyReply) =>
    runWithGateway(request, reply, async (auth) => {
      if (!authService) throw new DataStudioError(503, "auth", "Project Auth service unavailable", true, "AUTH_UNAVAILABLE");
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      const session = await authService.login(
        ctx,
        auth.project.companyId,
        auth.project.id,
        auth.environment,
        request.body,
        request.ip,
      );
      return { user: session.user, token: session.accessToken, refreshToken: session.refreshToken, expiresIn: session.expiresIn };
    });

  app.post<{ Params: ProjectRouteParams; Body: { email: string; password: string } }>(`${base}/auth/login`, PUBLIC_WRITE_ROUTE, handleLogin);
  app.post<{ Params: ProjectRouteParams; Body: { email: string; password: string } }>(`${base}/auth/signin`, PUBLIC_WRITE_ROUTE, handleLogin);

  const handleLogout = (request: FastifyRequest<{ Params: ProjectRouteParams; Body: { refreshToken?: string } }>, reply: FastifyReply) =>
    runWithGateway(request, reply, async (auth) => {
      if (!authService) throw new DataStudioError(503, "auth", "Project Auth service unavailable", true, "AUTH_UNAVAILABLE");
      if (request.body?.refreshToken) {
        const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
        await authService.logout(
          ctx,
          auth.project.companyId,
          auth.project.id,
          auth.environment,
          { refreshToken: request.body.refreshToken },
        );
      }
      return reply.code(200).send({ success: true });
    });

  app.post<{ Params: ProjectRouteParams; Body: { refreshToken?: string } }>(`${base}/auth/logout`, PUBLIC_WRITE_ROUTE, handleLogout);
  app.post<{ Params: ProjectRouteParams; Body: { refreshToken?: string } }>(`${base}/auth/signout`, PUBLIC_WRITE_ROUTE, handleLogout);

  app.post<{ Params: ProjectRouteParams; Body: { refreshToken: string } }>(`${base}/auth/refresh`, PUBLIC_WRITE_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      if (!authService) throw new DataStudioError(503, "auth", "Project Auth service unavailable", true, "AUTH_UNAVAILABLE");
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      const refreshed = await authService.refresh(ctx, auth.project.companyId, auth.project.id, auth.environment, request.body);
      return { token: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresIn: refreshed.expiresIn };
    }),
  );

  app.get<{ Params: ProjectRouteParams }>(`${base}/auth/me`, PUBLIC_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      if (!auth.userId) {
        throw new DataStudioError(401, "auth", "Unauthorized. Bearer token required.", false, "UNAUTHORIZED");
      }
      return {
        user: {
          id: auth.userId,
          email: auth.userEmail || "",
          roles: auth.userRoles ?? [auth.userRole],
          role: auth.userRole,
          status: "active",
        },
      };
    }),
  );

  app.post<{ Params: ProjectRouteParams; Body: { token: string } }>(`${base}/auth/verify-email`, PUBLIC_WRITE_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      if (!authService) throw new DataStudioError(503, "auth", "Project Auth service unavailable", true, "AUTH_UNAVAILABLE");
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return authService.verifyEmail(
        ctx,
        auth.project.companyId,
        auth.project.id,
        auth.environment,
        request.body.token,
      );
    }),
  );

  app.post<{ Params: ProjectRouteParams; Body: { email: string; redirectTo?: string } }>(`${base}/auth/forgot-password`, PUBLIC_WRITE_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      if (!authService) throw new DataStudioError(503, "auth", "Project Auth service unavailable", true, "AUTH_UNAVAILABLE");
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return authService.forgotPassword(
        ctx,
        auth.project.companyId,
        auth.project.id,
        auth.environment,
        request.body.email,
        request.ip,
        request.body.redirectTo,
      );
    }),
  );

  app.post<{ Params: ProjectRouteParams; Body: { token: string; newPassword: string } }>(`${base}/auth/reset-password`, PUBLIC_WRITE_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      if (!authService) throw new DataStudioError(503, "auth", "Project Auth service unavailable", true, "AUTH_UNAVAILABLE");
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return authService.resetPassword(
        ctx,
        auth.project.companyId,
        auth.project.id,
        auth.environment,
        request.body,
        request.ip,
      );
    }),
  );

  // =========================================================================
  // Collection CRUD Endpoints
  // =========================================================================

  app.post<{ Params: ProjectRouteParams; Body: Record<string, unknown> }>(`${base}/forms/:collection/submit`, PUBLIC_WRITE_ROUTE, (request, reply) =>
    runWithGateway(request, reply, auth => gateway!.submitForm(auth, request.params.collection!, request.body)),
  );

  app.post<{ Params: ProjectRouteParams; Body: { cartId: string } }>(`${base}/commerce/checkout`, PUBLIC_WRITE_ROUTE, (request, reply) =>
    runWithGateway(request, reply, auth => gateway!.checkout(auth, request.body?.cartId)),
  );

  app.get<{
    Params: ProjectRouteParams;
    Querystring: {
      limit?: string;
      offset?: string;
      page?: string;
      sort?: string;
      fields?: string;
      include?: string;
      filter?: string;
      [key: `filter[${string}]`]: string | undefined;
    };
  }>(`${base}/data/:collection`, PUBLIC_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      const q = request.query;
      let filterObj: Record<string, unknown> | undefined;

      // Extract filter query params
      if (q.filter) {
        try {
          filterObj = JSON.parse(q.filter);
        } catch {
          filterObj = undefined;
        }
        if (!filterObj || typeof filterObj !== "object" || Array.isArray(filterObj)) {
          throw new DataStudioError(400, "validation", "filter must be a JSON object", false, "INVALID_FILTER");
        }
      }

      for (const [key, val] of Object.entries(q)) {
        const match = /^filter\[(.+)\]$/.exec(key);
        if (match && val !== undefined) {
          if (!filterObj) filterObj = {};
          filterObj[match[1]!] = val;
        }
      }

      return gateway!.listRows(auth, request.params.collection!, {
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
        page: q.page ? Number(q.page) : undefined,
        sort: q.sort,
        fields: q.fields ? q.fields.split(",").map((s) => s.trim()) : undefined,
        include: q.include ? q.include.split(",").map((s) => s.trim()) : undefined,
        filter: filterObj,
      });
    }),
  );

  app.get<{
    Params: ProjectRouteParams;
    Querystring: { fields?: string; include?: string };
  }>(`${base}/data/:collection/:id`, PUBLIC_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      const q = request.query;
      return gateway!.getRow(auth, request.params.collection!, request.params.id!, {
        fields: q.fields ? q.fields.split(",").map((s) => s.trim()) : undefined,
        include: q.include ? q.include.split(",").map((s) => s.trim()) : undefined,
      });
    }),
  );

  app.post<{
    Params: ProjectRouteParams;
    Body: Record<string, unknown>;
  }>(`${base}/data/:collection`, PUBLIC_WRITE_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      const created = await gateway!.createRow(auth, request.params.collection!, request.body);
      return reply.code(201).send(created);
    }),
  );

  app.patch<{
    Params: ProjectRouteParams;
    Body: Record<string, unknown>;
  }>(`${base}/data/:collection/:id`, PUBLIC_WRITE_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      return gateway!.updateRow(auth, request.params.collection!, request.params.id!, request.body);
    }),
  );

  app.delete<{
    Params: ProjectRouteParams;
  }>(`${base}/data/:collection/:id`, PUBLIC_ROUTE, (request, reply) =>
    runWithGateway(request, reply, async (auth) => {
      return gateway!.deleteRow(auth, request.params.collection!, request.params.id!);
    }),
  );
}
