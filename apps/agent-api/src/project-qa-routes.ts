import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceNotFoundError, type AuthContext } from "@npati/workspace";
import { SandboxProviderError } from "./sandbox-provider";
import { AuthenticationError, type AuthProvider } from "./auth";
import { BrowserQaError, ProjectBrowserQaService, type BrowserQaInspectOptions } from "./project-browser-qa-service";

interface ProjectParams {
  companyId: string;
  projectId: string;
}

interface ReportParams extends ProjectParams {
  reportId: string;
}

export function registerProjectQaRoutes(
  app: FastifyInstance,
  qaService: ProjectBrowserQaService,
  auth: AuthProvider,
) {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> => {
    try {
      return await auth.authenticate(request);
    } catch (error) {
      const known = error instanceof AuthenticationError ? error : new AuthenticationError("Unauthorized", 401, "UNAUTHORIZED");
      reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      return null;
    }
  };

  const handleError = (error: unknown, reply: FastifyReply) => {
    if (error instanceof BrowserQaError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    if (error instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (error instanceof SandboxProviderError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Browser QA request failed" } });
  };

  // POST /companies/:companyId/projects/:projectId/qa/inspect
  app.post<{ Params: ProjectParams; Body: Partial<BrowserQaInspectOptions> }>(
    "/companies/:companyId/projects/:projectId/qa/inspect",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      if (!ctx.permissions.includes("workspace:read")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      }

      try {
        const body = request.body || {};
        const result = await qaService.inspect(ctx, request.params.companyId, {
          path: body.path,
          actions: body.actions,
          viewport: body.viewport,
          checks: body.checks,
          timeoutMs: body.timeoutMs,
          maxScreenshotBytes: body.maxScreenshotBytes,
          maxBrokenLinksToCheck: body.maxBrokenLinksToCheck,
          projectId: request.params.projectId,
        });
        return reply.code(200).send({ report: result.report, issues: result.issues, metrics: result.metrics, success: result.success });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // GET /companies/:companyId/projects/:projectId/qa/reports
  app.get<{ Params: ProjectParams; Querystring: { limit?: string } }>(
    "/companies/:companyId/projects/:projectId/qa/reports",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      if (!ctx.permissions.includes("workspace:read")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      }

      try {
        const limit = Number(request.query.limit) || 20;
        const reports = await qaService.listReports(ctx, request.params.companyId, request.params.projectId, limit);
        return reply.code(200).send({ reports });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // GET /companies/:companyId/projects/:projectId/qa/latest
  app.get<{ Params: ProjectParams }>(
    "/companies/:companyId/projects/:projectId/qa/latest",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      if (!ctx.permissions.includes("workspace:read")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      }

      try {
        const report = await qaService.getLatestReport(ctx, request.params.companyId, request.params.projectId);
        if (!report) {
          return reply.code(404).send({ error: { code: "REPORT_NOT_FOUND", message: "No QA reports found for this project" } });
        }
        return reply.code(200).send({ report });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // GET /companies/:companyId/projects/:projectId/qa/reports/:reportId
  app.get<{ Params: ReportParams }>(
    "/companies/:companyId/projects/:projectId/qa/reports/:reportId",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      if (!ctx.permissions.includes("workspace:read")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      }

      try {
        const report = await qaService.getReport(ctx, request.params.companyId, request.params.projectId, request.params.reportId);
        if (!report) {
          return reply.code(404).send({ error: { code: "REPORT_NOT_FOUND", message: "QA report not found" } });
        }
        return reply.code(200).send({ report });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
