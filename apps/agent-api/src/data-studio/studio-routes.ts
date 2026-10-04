import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError } from "@npati/workspace";
import type { AuthProvider } from "../auth";
import { DataStudioError } from "./identifier";
import type { DataStudioUiService } from "./studio-service";
import type { DataEnvironmentName } from "./types";
import type { SchemaOperation } from "./data-provider";
import { fail } from "./routes";

type Params = { companyId: string; projectId: string; environment: DataEnvironmentName; collection?: string; id?: string };

export function registerDataStudioRoutes(app: FastifyInstance, auth: AuthProvider, service?: DataStudioUiService) {
  const base = "/companies/:companyId/projects/:projectId/data-studio/:environment";
  const run = async (request: FastifyRequest, reply: FastifyReply, permission: "workspace:read" | "business:manage",
    action: (ctx: Awaited<ReturnType<AuthProvider["authenticate"]>>) => Promise<unknown>) => {
    try {
      const ctx = await auth.authenticate(request);
      if (!ctx.permissions.includes(permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
      if (!service) throw new DataStudioError(503, "request", "Data Studio is unavailable", true, "DATA_STUDIO_UNAVAILABLE");
      return await action(ctx);
    } catch (error) { return fail(reply, error); }
  };
  app.get<{ Params: Params }>(base, (request, reply) => run(request, reply, "workspace:read", (ctx) =>
    service!.overview(ctx, request.params.companyId, request.params.projectId, request.params.environment)));
  app.post<{ Params: Params; Body: { operation: SchemaOperation } }>(base + "/schema/preview", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.preview(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.body.operation)));
  app.post<{ Params: Params; Body: { operation: SchemaOperation; expectedFingerprint: string; confirmDestructive?: boolean } }>(base + "/schema/apply", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.apply(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.body)));
  app.post<{ Params: Params; Body: { migrationId: string } }>(base + "/schema/revert", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.revert(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.body.migrationId)));
  app.post<{ Params: Params; Body: { filters?: Array<{ field: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: unknown }>;
    sort?: { field: string; direction: "asc" | "desc" }; limit?: number; offset?: number; search?: string } }>(base + "/collections/:collection/rows/query", (request, reply) => run(request, reply, "workspace:read", (ctx) =>
    service!.rows(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.body ?? {})));
  app.post<{ Params: Params; Body: { row: Record<string, unknown> } }>(base + "/collections/:collection/rows", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.createRow(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.body.row)));
  app.patch<{ Params: Params; Body: { row: Record<string, unknown> } }>(base + "/collections/:collection/rows/:id", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.updateRow(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.params.id!, request.body.row)));
  app.post<{ Params: Params; Body: { ids: string[]; confirmed: boolean } }>(base + "/collections/:collection/rows/delete", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.deleteRows(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.body.ids, request.body.confirmed)));
  app.post<{ Params: Params; Body: { format: "csv" | "json"; content: string } }>(base + "/collections/:collection/import", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.importRows(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.body.format, request.body.content)));
  app.post<{ Params: Params; Body: { format: "csv" | "json" } }>(base + "/collections/:collection/export", (request, reply) => run(request, reply, "workspace:read", (ctx) =>
    service!.exportRows(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.body.format)));
}
