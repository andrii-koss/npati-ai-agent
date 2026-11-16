import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError } from "@npati/workspace";
import { TEMPLATE_CATALOG } from "@npati/shared";
import type { AuthProvider } from "../auth";
import { DataStudioError } from "./identifier";
import type { DataStudioUiService } from "./studio-service";
import type { AgentDataStudioService } from "./agent-data-service";
import type { DataEnvironmentName } from "./types";
import type { SchemaOperation } from "./data-provider";
import { fail } from "./routes";

type Params = { companyId: string; projectId: string; environment: DataEnvironmentName; collection?: string; id?: string };

export function registerDataStudioRoutes(
  app: FastifyInstance,
  auth: AuthProvider,
  service?: DataStudioUiService,
  agentService?: AgentDataStudioService,
) {
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
  app.post<{ Params: Params; Body: { collections: string[] } }>(base + "/collections/counts", { schema: { body: {
    type: "object", required: ["collections"], additionalProperties: false, properties: {
      collections: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" } },
    },
  } } }, (request, reply) => run(request, reply, "workspace:read", ctx =>
    service!.countRows(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.body.collections)));
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
  app.patch<{ Params: Params; Body: { row: Record<string, unknown>; expected?: Record<string, unknown> } }>(base + "/collections/:collection/rows/:id", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.updateRow(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.params.id!, request.body.row,
      request.body.expected && typeof request.body.expected === "object" && !Array.isArray(request.body.expected) ? request.body.expected : undefined)));
  app.post<{ Params: Params; Body: { ids: string[]; confirmed: boolean } }>(base + "/collections/:collection/rows/delete", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.deleteRows(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.body.ids, request.body.confirmed)));
  app.post<{ Params: Params; Body: { format: "csv" | "json"; content: string } }>(base + "/collections/:collection/import", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.importRows(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.body.format, request.body.content)));
  app.post<{ Params: Params; Body: { format: "csv" | "json" } }>(base + "/collections/:collection/export", (request, reply) => run(request, reply, "workspace:read", (ctx) =>
    service!.exportRows(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.params.collection!, request.body.format)));

  // --- Schema templates (used by the Data Studio settings section) ---
  app.get<{ Params: Params }>(base + "/templates", (request, reply) => run(request, reply, "workspace:read", async () => ({
    templates: TEMPLATE_CATALOG.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      collections: template.collections.map((collection) => ({
        name: collection.name,
        fields: collection.fields.length,
        fieldNames: collection.fields.map((field) => field.name),
      })),
    })),
  })));

  app.post<{ Params: Params; Body: { templateId: string; seedDemoData?: boolean; approved?: boolean } }>(
    base + "/templates/apply",
    { schema: { body: { type: "object", additionalProperties: false, required: ["templateId"], properties: {
      templateId: { type: "string", minLength: 1, maxLength: 100 },
      seedDemoData: { type: "boolean" },
      approved: { type: "boolean" },
    } } } },
    (request, reply) => run(request, reply, "business:manage", async (ctx) => {
      if (request.params.environment !== "dev") {
        throw new DataStudioError(409, "template", "Templates are applied to dev; promote the schema to prod afterwards", false, "PROMOTE_REQUIRED");
      }
      if (!agentService) throw new DataStudioError(503, "template", "Schema templates are unavailable", true, "DATA_STUDIO_UNAVAILABLE");
      if (request.body.approved !== true) {
        throw new DataStudioError(409, "template", "APPROVAL_REQUIRED: applying a schema template changes the project database", false, "APPROVAL_REQUIRED");
      }
      return agentService.applyTemplate(ctx, request.params.companyId, request.params.projectId, request.body.templateId, {
        approved: true,
        seedDemoData: request.body.seedDemoData === true,
      });
    }),
  );

  // --- API & SDK Management Endpoints ---
  app.get<{ Params: Params }>(base + "/api/keys", (request, reply) => run(request, reply, "workspace:read", (ctx) =>
    service!.getApiKeys(ctx, request.params.companyId, request.params.projectId, request.params.environment)));

  app.post<{ Params: Params }>(base + "/api/keys/reveal", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.revealSecretKey(ctx, request.params.companyId, request.params.projectId, request.params.environment)));

  app.post<{ Params: Params; Body: { target?: "publishable" | "secret" | "both" } }>(base + "/api/keys/rotate", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.rotateApiKeys(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.body?.target ?? "both")));

  app.put<{ Params: Params; Body: { origins: string[] } }>(base + "/api/cors", (request, reply) => run(request, reply, "business:manage", (ctx) =>
    service!.updateCorsOrigins(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.body.origins ?? [])));

  app.get<{ Params: Params; Querystring: { limit?: string } }>(base + "/api/logs", (request, reply) => run(request, reply, "workspace:read", (ctx) =>
    service!.getApiRequestLogs(ctx, request.params.companyId, request.params.projectId, request.params.environment, request.query.limit ? Number(request.query.limit) : 50)));

  app.get<{ Params: Params }>(base + "/api/usage", (request, reply) => run(request, reply, "workspace:read", (ctx) =>
    service!.getApiUsage(ctx, request.params.companyId, request.params.projectId, request.params.environment)));

  app.get<{ Params: Params }>(base + "/api/openapi.json", (request, reply) => run(request, reply, "workspace:read", (ctx) =>
    service!.getApiDocumentation(ctx, request.params.companyId, request.params.projectId, request.params.environment)));
}
