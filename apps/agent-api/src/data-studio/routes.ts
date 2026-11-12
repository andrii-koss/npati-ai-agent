import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "../auth";
import { DataStudioError, normalizeDataQueryError } from "./identifier";
import type { DataBackendService } from "./service";
import type { PromoteService } from "./promote-service";
import type { BackupService } from "./backup-service";
import type { QuotaService } from "./quota-service";
import type { DataEnvironmentName } from "./types";
import type { CatalogQuery } from "./catalog";

export function fail(reply: FastifyReply, error: unknown) {
  error = normalizeDataQueryError(error);
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  if (error instanceof DataStudioError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, step: error.step, retryable: error.retryable } });
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: { code: error.code, message: error.message } });
  return reply.code(503).send({ error: { code: "DATA_STUDIO_UNAVAILABLE", message: "Data Studio is unavailable", step: "request", retryable: true } });
}

export interface DataBackendRouteServices {
  service?: DataBackendService;
  promote?: PromoteService;
  backups?: BackupService;
  quotas?: QuotaService;
}

export function registerDataBackendRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  service?: DataBackendService,
  d7: Omit<DataBackendRouteServices, "service"> = {},
) {
  const authorize = async (request: FastifyRequest, permission: "workspace:read" | "business:manage") => {
    const ctx = await auth.authenticate(request);
    if (!ctx.permissions.includes(permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
    if (!service) throw new DataStudioError(503, "request", "Data Studio is unavailable", true, "DATA_STUDIO_UNAVAILABLE");
    return { ctx, service };
  };

  app.get<{ Params: { companyId: string } }>("/companies/:companyId/data-backends", async (request, reply) => {
    try { const { ctx, service } = await authorize(request, "workspace:read"); return { backends: await service.list(ctx, request.params.companyId) }; }
    catch (error) { return fail(reply, error); }
  });

  app.get<{ Querystring: CatalogQuery }>("/data-studio/catalog", { schema: { querystring: {
    type: "object", additionalProperties: false, properties: {
      companyId: { type: "string", maxLength: 128 }, search: { type: "string", maxLength: 200 },
      status: { type: "string", enum: ["all", "ready", "attention"] },
      cursor: { type: "string", maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
  } } }, async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      reply.header("cache-control", "private, no-store");
      return await service.catalog(ctx, request.query);
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: { companyId: string; backendId: string } }>("/companies/:companyId/data-backends/:backendId/workspace", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      const { companyId, backendId } = request.params;
      const workspace = await service.workspace(ctx, companyId, backendId);
      const entries = await Promise.all((["dev", "prod"] as const).map(async environment => [environment,
        d7.quotas ? await d7.quotas.report(ctx, companyId, backendId, environment).catch(() => null) : null] as const));
      reply.header("cache-control", "private, no-store");
      return { ...workspace, quotas: Object.fromEntries(entries) };
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: { companyId: string }; Body: { name: string; provider?: "shared_postgres" | "external_postgres"; connectionString?: string } }>(
    "/companies/:companyId/data-backends",
    { schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: {
      name: { type: "string", minLength: 1, maxLength: 200 }, provider: { type: "string", enum: ["shared_postgres", "external_postgres"] },
      connectionString: { type: "string", maxLength: 2048 },
    } } } },
    async (request, reply) => {
      try { const { ctx, service } = await authorize(request, "business:manage"); return reply.code(201).send(await service.create(ctx, request.params.companyId, request.body)); }
      catch (error) { return fail(reply, error); }
    },
  );

  app.get<{ Params: { companyId: string; backendId: string } }>("/companies/:companyId/data-backends/:backendId", async (request, reply) => {
    try { const { ctx, service } = await authorize(request, "workspace:read"); return await service.get(ctx, request.params.companyId, request.params.backendId); }
    catch (error) { return fail(reply, error); }
  });

  app.patch<{ Params: { companyId: string; backendId: string }; Body: { name: string } }>(
    "/companies/:companyId/data-backends/:backendId",
    { schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => {
      try { const { ctx, service } = await authorize(request, "business:manage"); return await service.rename(ctx, request.params.companyId, request.params.backendId, request.body.name); }
      catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: { companyId: string; backendId: string } }>("/companies/:companyId/data-backends/:backendId/activate", async (request, reply) => {
    try { const { ctx, service } = await authorize(request, "business:manage"); return await service.activate(ctx, request.params.companyId, request.params.backendId); }
    catch (error) { return fail(reply, error); }
  });
  app.post<{ Params: { companyId: string; backendId: string } }>("/companies/:companyId/data-backends/:backendId/archive", async (request, reply) => {
    try { const { ctx, service } = await authorize(request, "business:manage"); return await service.archive(ctx, request.params.companyId, request.params.backendId); }
    catch (error) { return fail(reply, error); }
  });

  app.delete<{ Params: { companyId: string; backendId: string }; Body: { confirmName: string; immediate?: boolean; detachProjects?: boolean } }>(
    "/companies/:companyId/data-backends/:backendId",
    { schema: { body: { type: "object", additionalProperties: false, required: ["confirmName"], properties: { confirmName: { type: "string" }, immediate: { type: "boolean" }, detachProjects: { type: "boolean" } } } } },
    async (request, reply) => {
      try {
        const { ctx, service } = await authorize(request, "business:manage");
        return await service.remove(ctx, request.params.companyId, request.params.backendId, request.body.confirmName, { immediate: request.body.immediate, detachProjects: request.body.detachProjects });
      }
      catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: { companyId: string; backendId: string }; Body: { targetCompanyId: string; confirmName: string } }>(
    "/companies/:companyId/data-backends/:backendId/transfer",
    { schema: { body: { type: "object", additionalProperties: false, required: ["targetCompanyId", "confirmName"], properties: {
      targetCompanyId: { type: "string", minLength: 1, maxLength: 100 },
      confirmName: { type: "string", minLength: 1, maxLength: 200 },
    } } } },
    async (request, reply) => {
      try { const { ctx, service } = await authorize(request, "business:manage"); return await service.transfer(ctx, request.params.companyId, request.params.backendId, request.body); }
      catch (error) { return fail(reply, error); }
    },
  );

  app.put<{ Params: { companyId: string; projectId: string }; Body: { dataBackendId: string } }>(    "/companies/:companyId/projects/:projectId/data-backend",
    { schema: { body: { type: "object", additionalProperties: false, required: ["dataBackendId"], properties: { dataBackendId: { type: "string", format: "uuid" } } } } },
    async (request, reply) => {
      try { const { ctx, service } = await authorize(request, "business:manage"); return await service.attach(ctx, request.params.companyId, request.params.projectId, request.body.dataBackendId); }
      catch (error) { return fail(reply, error); }
    },
  );

  app.delete<{ Params: { companyId: string; projectId: string } }>("/companies/:companyId/projects/:projectId/data-backend", async (request, reply) => {
    try { const { ctx, service } = await authorize(request, "business:manage"); return await service.attach(ctx, request.params.companyId, request.params.projectId, null); }
    catch (error) { return fail(reply, error); }
  });

  // =========================================================================
  // D7: Promote dev -> prod
  // =========================================================================

  const requireD7 = <T>(value: T | undefined, name: string): T => {
    if (!value) throw new DataStudioError(503, "request", `${name} is unavailable on this installation`, true, "DATA_STUDIO_UNAVAILABLE");
    return value;
  };
  const environmentOf = (value: unknown): DataEnvironmentName => (value === "prod" ? "prod" : "dev");

  app.post<{ Params: { companyId: string; backendId: string }; Body: { withData?: boolean } }>(
    "/companies/:companyId/data-backends/:backendId/promote/preview",
    { schema: { body: { type: "object", additionalProperties: false, properties: { withData: { type: "boolean" } } } } },
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "business:manage");
        const promote = requireD7(d7.promote, "Promote");
        return await promote.preview(ctx, request.params.companyId, request.params.backendId, { withData: request.body?.withData });
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: { companyId: string; backendId: string }; Body: { approved?: boolean; withData?: boolean } }>(
    "/companies/:companyId/data-backends/:backendId/promote",
    { schema: { body: { type: "object", additionalProperties: false, properties: { approved: { type: "boolean" }, withData: { type: "boolean" } } } } },
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "business:manage");
        const promote = requireD7(d7.promote, "Promote");
        return await promote.apply(ctx, request.params.companyId, request.params.backendId, {
          approved: request.body?.approved === true,
          withData: request.body?.withData === true,
        });
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: { companyId: string; backendId: string }; Body: { reason?: string } }>(
    "/companies/:companyId/data-backends/:backendId/promote/reject",
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "business:manage");
        const promote = requireD7(d7.promote, "Promote");
        return await promote.reject(ctx, request.params.companyId, request.params.backendId, { reason: request.body?.reason });
      } catch (error) { return fail(reply, error); }
    },
  );

  app.get<{ Params: { companyId: string; backendId: string } }>("/companies/:companyId/data-backends/:backendId/promotions", async (request, reply) => {
    try {
      const { ctx } = await authorize(request, "workspace:read");
      const promote = requireD7(d7.promote, "Promote");
      return { promotions: await promote.listPromotions(ctx, request.params.companyId, request.params.backendId) };
    } catch (error) { return fail(reply, error); }
  });

  // =========================================================================
  // D7: Backups
  // =========================================================================

  app.get<{ Params: { companyId: string; backendId: string }; Querystring: { environment?: string } }>(
    "/companies/:companyId/data-backends/:backendId/backups",
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "workspace:read");
        const backups = requireD7(d7.backups, "Backups");
        const environment = environmentOf(request.query.environment);
        const [snapshots, policy] = await Promise.all([
          backups.list(ctx, request.params.companyId, request.params.backendId, environment),
          backups.policy(ctx, request.params.companyId, request.params.backendId, environment),
        ]);
        return { environment, snapshots, policy };
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: { companyId: string; backendId: string }; Body: { environment?: string; reason?: string } }>(
    "/companies/:companyId/data-backends/:backendId/backups",
    { schema: { body: { type: "object", additionalProperties: false, properties: { environment: { type: "string", enum: ["dev", "prod"] }, reason: { type: "string", maxLength: 300 } } } } },
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "business:manage");
        const backups = requireD7(d7.backups, "Backups");
        const snapshot = await backups.create(ctx, request.params.companyId, request.params.backendId, environmentOf(request.body?.environment), { kind: "manual", reason: request.body?.reason });
        return reply.code(201).send(snapshot);
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: { companyId: string; backendId: string; snapshotId: string }; Body: { environment?: string; approved?: boolean } }>(
    "/companies/:companyId/data-backends/:backendId/backups/:snapshotId/restore",
    { schema: { body: { type: "object", additionalProperties: false, properties: { environment: { type: "string", enum: ["dev", "prod"] }, approved: { type: "boolean" } } } } },
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "business:manage");
        const backups = requireD7(d7.backups, "Backups");
        return await backups.restore(
          ctx, request.params.companyId, request.params.backendId,
          environmentOf(request.body?.environment), request.params.snapshotId,
          { approved: request.body?.approved === true },
        );
      } catch (error) { return fail(reply, error); }
    },
  );

  app.put<{ Params: { companyId: string; backendId: string }; Querystring: { environment?: string }; Body: { intervalMinutes?: number; keep?: number } }>(
    "/companies/:companyId/data-backends/:backendId/backup-policy",
    { schema: { body: { type: "object", additionalProperties: false, properties: { intervalMinutes: { type: "integer", minimum: 0, maximum: 10080 }, keep: { type: "integer", minimum: 1, maximum: 100 } } } } },
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "business:manage");
        const backups = requireD7(d7.backups, "Backups");
        return await backups.updatePolicy(ctx, request.params.companyId, request.params.backendId, environmentOf(request.query.environment), request.body ?? {});
      } catch (error) { return fail(reply, error); }
    },
  );

  // =========================================================================
  // D7: Quotas / usage
  // =========================================================================

  app.get<{ Params: { companyId: string; backendId: string }; Querystring: { environment?: string } }>(
    "/companies/:companyId/data-backends/:backendId/quotas",
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "workspace:read");
        const quotas = requireD7(d7.quotas, "Quotas");
        return await quotas.report(ctx, request.params.companyId, request.params.backendId, environmentOf(request.query.environment));
      } catch (error) { return fail(reply, error); }
    },
  );

  app.put<{ Params: { companyId: string; backendId: string }; Querystring: { environment?: string }; Body: Record<string, number> }>(
    "/companies/:companyId/data-backends/:backendId/quotas",
    async (request, reply) => {
      try {
        const { ctx } = await authorize(request, "business:manage");
        const quotas = requireD7(d7.quotas, "Quotas");
        const environment = environmentOf(request.query.environment);
        const limits = quotas.resolveLimits(environment, request.body ?? {});
        await service!.setEnvironmentLimits(ctx, request.params.companyId, request.params.backendId, environment, { ...limits });
        return await quotas.report(ctx, request.params.companyId, request.params.backendId, environment);
      } catch (error) { return fail(reply, error); }
    },
  );
}
