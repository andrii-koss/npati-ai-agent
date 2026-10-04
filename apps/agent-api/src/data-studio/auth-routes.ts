import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError } from "@npati/workspace";
import type { AuthProvider } from "../auth";
import { DataStudioError } from "./identifier";
import type { ProjectAuthService } from "./auth-service";
import type { DataEnvironmentName } from "./types";
import type {
  GdprStrategy,
  ProjectAccessPolicy,
  ProjectAuthSettings,
  ProjectAuthUserStatus,
} from "@npati/shared";
import { fail } from "./routes";

interface AuthRouteParams {
  companyId: string;
  projectId: string;
  environment: DataEnvironmentName;
  id?: string;
}

export function registerProjectAuthRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  service?: ProjectAuthService,
) {
  const base = "/companies/:companyId/projects/:projectId/data-studio/:environment/auth";

  const runAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply,
    permission: "workspace:read" | "business:manage",
    action: (ctx: Awaited<ReturnType<AuthProvider["authenticate"]>>) => Promise<unknown>,
  ) => {
    try {
      const ctx = await auth.authenticate(request);
      if (!ctx.permissions.includes(permission)) {
        throw new WorkspaceAccessError("Missing permission: " + permission);
      }
      if (!service) {
        throw new DataStudioError(503, "auth", "Project Auth service is unavailable", true, "AUTH_UNAVAILABLE");
      }
      return await action(ctx);
    } catch (error) {
      return fail(reply, error);
    }
  };

  const runPublic = async (
    _request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) => {
    try {
      if (!service) {
        throw new DataStudioError(503, "auth", "Project Auth service is unavailable", true, "AUTH_UNAVAILABLE");
      }
      return await action();
    } catch (error) {
      return fail(reply, error);
    }
  };

  // =========================================================================
  // Control Plane Admin Endpoints
  // =========================================================================

  app.get<{
    Params: AuthRouteParams;
    Querystring: { limit?: string; offset?: string; search?: string; status?: ProjectAuthUserStatus };
  }>(`${base}/users`, (request, reply) =>
    runAdmin(request, reply, "workspace:read", (ctx) =>
      service!.listUsers(ctx, request.params.companyId, request.params.projectId, request.params.environment, {
        limit: request.query.limit ? Number(request.query.limit) : undefined,
        offset: request.query.offset ? Number(request.query.offset) : undefined,
        search: request.query.search,
        status: request.query.status,
      }),
    ),
  );

  app.patch<{
    Params: AuthRouteParams;
    Body: { status: ProjectAuthUserStatus };
  }>(`${base}/users/:id/status`, (request, reply) =>
    runAdmin(request, reply, "business:manage", (ctx) =>
      service!.setUserStatus(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.params.id!,
        request.body.status,
      ),
    ),
  );

  app.patch<{
    Params: AuthRouteParams;
    Body: { roles: string[] };
  }>(`${base}/users/:id/roles`, (request, reply) =>
    runAdmin(request, reply, "business:manage", (ctx) =>
      service!.setUserRoles(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.params.id!,
        request.body.roles,
      ),
    ),
  );

  app.get<{ Params: AuthRouteParams }>(`${base}/users/:id/export`, (request, reply) =>
    runAdmin(request, reply, "workspace:read", (ctx) =>
      service!.exportUserData(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.params.id!,
      ),
    ),
  );

  app.post<{
    Params: AuthRouteParams;
    Body: { strategies?: Record<string, GdprStrategy> };
  }>(`${base}/users/:id/delete/preview`, (request, reply) =>
    runAdmin(request, reply, "workspace:read", (ctx) =>
      service!.previewDeleteUser(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.params.id!,
        request.body?.strategies ?? {},
      ),
    ),
  );

  app.delete<{
    Params: AuthRouteParams;
    Body: { confirmed: boolean; strategies?: Record<string, GdprStrategy> };
  }>(`${base}/users/:id`, (request, reply) =>
    runAdmin(request, reply, "business:manage", (ctx) =>
      service!.deleteUser(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.params.id!,
        {
          confirmed: request.body?.confirmed ?? false,
          strategies: request.body?.strategies,
        },
      ),
    ),
  );

  app.get<{ Params: AuthRouteParams }>(`${base}/settings`, (request, reply) =>
    runAdmin(request, reply, "workspace:read", (ctx) =>
      service!.getAuthSettings(ctx, request.params.companyId, request.params.projectId, request.params.environment),
    ),
  );

  const updateSettingsHandler = (request: any, reply: any) =>
    runAdmin(request, reply, "business:manage", async (ctx) => {
      const updated = await service!.updateAuthSettings(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body,
      );
      return { settings: updated, ...updated };
    });

  app.patch<{
    Params: AuthRouteParams;
    Body: Partial<ProjectAuthSettings>;
  }>(`${base}/settings`, updateSettingsHandler);

  app.put<{
    Params: AuthRouteParams;
    Body: Partial<ProjectAuthSettings>;
  }>(`${base}/settings`, updateSettingsHandler);

  app.get<{ Params: AuthRouteParams }>(`${base}/policies`, (request, reply) =>
    runAdmin(request, reply, "workspace:read", (ctx) =>
      service!.getAccessPolicies(ctx, request.params.companyId, request.params.projectId, request.params.environment),
    ),
  );

  app.put<{
    Params: AuthRouteParams;
    Body: { policies: ProjectAccessPolicy[] };
  }>(`${base}/policies`, (request, reply) =>
    runAdmin(request, reply, "business:manage", (ctx) =>
      service!.applyAccessPolicies(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body.policies,
      ),
    ),
  );

  app.post<{ Params: AuthRouteParams }>(`${base}/keys/rotate`, (request, reply) =>
    runAdmin(request, reply, "business:manage", (ctx) =>
      service!.rotateSigningKey(ctx, request.params.companyId, request.params.projectId, request.params.environment),
    ),
  );

  // =========================================================================
  // Client End-User Auth Flows
  // =========================================================================

  app.post<{
    Params: AuthRouteParams;
    Body: { email: string; password: string; metadata?: Record<string, unknown> };
  }>(`${base}/register`, (request, reply) => {
    const ip = request.ip;
    return runPublic(request, reply, async () => {
      // Create guest context for registration
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      const res = await service!.register(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body,
        ip,
      );
      reply.code(201);
      return res;
    });
  });

  app.post<{
    Params: AuthRouteParams;
    Body: { email: string; password: string };
  }>(`${base}/login`, (request, reply) => {
    const ip = request.ip;
    return runPublic(request, reply, async () => {
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return service!.login(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body,
        ip,
      );
    });
  });

  app.post<{
    Params: AuthRouteParams;
    Body: { refreshToken: string };
  }>(`${base}/refresh`, (request, reply) =>
    runPublic(request, reply, async () => {
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return service!.refresh(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body,
      );
    }),
  );

  app.post<{
    Params: AuthRouteParams;
    Body: { refreshToken: string };
  }>(`${base}/logout`, (request, reply) =>
    runPublic(request, reply, async () => {
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return service!.logout(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body,
      );
    }),
  );

  app.get<{ Params: AuthRouteParams }>(`${base}/me`, (request, reply) =>
    runPublic(request, reply, async () => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        throw new DataStudioError(401, "auth", "Missing or invalid Bearer authorization header", false, "UNAUTHORIZED");
      }
      const token = authHeader.slice(7).trim();
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return service!.me(ctx, request.params.companyId, request.params.projectId, request.params.environment, token);
    }),
  );

  app.post<{
    Params: AuthRouteParams;
    Body: { token: string };
  }>(`${base}/verify-email`, (request, reply) =>
    runPublic(request, reply, async () => {
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return service!.verifyEmail(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body.token,
      );
    }),
  );

  app.post<{
    Params: AuthRouteParams;
    Body: { email: string };
  }>(`${base}/forgot-password`, (request, reply) => {
    const ip = request.ip;
    return runPublic(request, reply, async () => {
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return service!.forgotPassword(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body.email,
        ip,
      );
    });
  });

  app.post<{
    Params: AuthRouteParams;
    Body: { token: string; newPassword: string };
  }>(`${base}/reset-password`, (request, reply) => {
    const ip = request.ip;
    return runPublic(request, reply, async () => {
      const ctx = { workspaceId: "client-auth", userId: "client-guest", permissions: [] };
      return service!.resetPassword(
        ctx,
        request.params.companyId,
        request.params.projectId,
        request.params.environment,
        request.body,
        ip,
      );
    });
  });
}
