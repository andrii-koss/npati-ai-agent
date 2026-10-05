import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { currentToolManifest } from "./code-tool-registry";
import { API_VERSION, resolveApiVersion } from "./api-versioning";
import type { CodeToolInvokeFailure, CodeToolInvokeResult, CodeToolRuntime } from "./code-tool-runtime";

/**
 * C2: the manual invocation harness for `code.*` tools.
 *
 * This is deliberately an operator/acceptance surface (authenticated, company-scoped, owner or admin)
 * rather than the model-facing API: the runner will call `CodeToolRuntime.invoke` directly once C6
 * lands. Everything here is read-only tooling; write tools only appear in C3+.
 */

const ERROR_STATUS: Record<string, number> = {
  feature_disabled: 403,
  company_access_denied: 403,
  invalid_arguments: 400,
  invalid_argument: 400,
  invalid_path: 400,
  path_outside_workspace: 400,
  symlink_escape: 400,
  null_byte: 400,
  sensitive_file_denied: 403,
  unknown_tool: 404,
  unknown_tool_version: 404,
  not_a_file: 404,
  project_not_found: 404,
  not_a_directory: 400,
  too_large: 413,
  read_failed: 502,
  search_failed: 502,
  tool_deprecated: 409,
  sandbox_unavailable: 503,
  tool_not_configured: 503,
  limit_exceeded: 429,
  workspace_error: 502,
  tool_failed: 500,
};

type CompanyParams = { companyId: string };
type ProjectParams = { companyId: string; projectId: string };

export interface CodeToolRouteDeps {
  auth: AuthProvider;
  runtime?: CodeToolRuntime;
  /** Ownership probe: the company must belong to the caller. */
  assertCompany?: (ctx: Awaited<ReturnType<AuthProvider["authenticate"]>>, companyId: string) => Promise<void>;
}

export function registerCodeToolRoutes(app: FastifyInstance, deps: CodeToolRouteDeps) {
  const { auth, runtime } = deps;

  const fail = (reply: FastifyReply, error: unknown, tool?: string) => {
    const values = error as { code?: string; status?: number; message?: string; step?: string; retryable?: boolean; tool?: string };
    if (error instanceof AuthenticationError) {
      return reply.code(error.status ?? 401).send({ error: { code: error.code ?? "UNAUTHORIZED", message: error.message, tool: null, step: "auth", retryable: false }, apiVersion: API_VERSION });
    }
    if (error instanceof WorkspaceAccessError) {
      return reply.code(403).send({ error: { code: "code_access_denied", message: error.message, tool: tool ?? null, step: "authorize", retryable: false }, apiVersion: API_VERSION });
    }
    const code = values?.code && values.code in ERROR_STATUS ? values.code : "tool_failed";
    const status = ERROR_STATUS[code] ?? 500;
    return reply.code(status).send({
      error: {
        code, status,
        message: status === 500 ? "Tool execution failed" : values?.message ?? "Tool call failed",
        tool: values?.tool ?? tool ?? null,
        step: values?.step ?? "execute",
        retryable: values?.retryable ?? false,
      },
      apiVersion: API_VERSION,
    });
  };

  const authenticate = async (request: FastifyRequest, write: boolean) => {
    resolveApiVersion(request.headers);
    const ctx = await auth.authenticate(request);
    const allowed = ctx.permissions.some((permission) => ["*", "owner", "admin:all"].includes(permission))
      || ctx.permissions.includes(write ? "business:manage" : "workspace:read");
    if (!allowed) throw new AuthenticationError("Permission denied", 403, "FORBIDDEN");
    return ctx;
  };

  const assertCompany = async (ctx: Awaited<ReturnType<AuthProvider["authenticate"]>>, companyId: string) => {
    if (deps.assertCompany) return deps.assertCompany(ctx, companyId);
    // Without an ownership checker and without a runtime there is nothing to check: the handler
    // answers 503 (feature not configured) instead of pretending this was an authorization failure.
    return undefined;
  };

  app.get<{ Params: CompanyParams; Querystring: { sessionId?: string } }>("/companies/:companyId/code/tools", async (request, reply) => {
    try {
      const ctx = await authenticate(request, false);
      await assertCompany(ctx, request.params.companyId);
      if (!runtime) return reply.code(503).send({ error: { code: "feature_disabled", message: "Coding Agent is unavailable: tool runtime is not configured", tool: null, step: "flags", retryable: false }, apiVersion: API_VERSION });
      const manifest = currentToolManifest();
      return reply.send({
        tools: runtime.listTools(),
        manifest: { version: manifest.version, checksum: manifest.checksum, tools: manifest.tools },
        reads: request.query.sessionId ? runtime.listReads(request.query.sessionId) : [],
        apiVersion: API_VERSION,
      });
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: ProjectParams; Body: { tool: string; toolVersion?: number; args?: Record<string, unknown>; sessionId?: string; toolCallId: string } }>(
    "/companies/:companyId/projects/:projectId/code/tools/invoke",
    {
      schema: {
        body: {
          type: "object",
          required: ["tool", "toolCallId"],
          properties: {
            tool: { type: "string", maxLength: 120 },
            toolVersion: { type: "integer", minimum: 1 },
            args: { type: "object" },
            sessionId: { type: "string", maxLength: 120 },
            toolCallId: { type: "string", maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const ctx = await authenticate(request, true);
        await assertCompany(ctx, request.params.companyId);
        if (!runtime) throw Object.assign(new Error("Coding Agent is unavailable"), { code: "feature_disabled", status: 503, step: "flags" });
        const outcome: CodeToolInvokeResult | CodeToolInvokeFailure = await runtime.invoke(ctx, {
          companyId: request.params.companyId,
          projectId: request.params.projectId,
          sessionId: request.body.sessionId,
          tool: request.body.tool,
          toolVersion: request.body.toolVersion,
          args: request.body.args,
          toolCallId: request.body.toolCallId,
        });
        if (!outcome.ok) return fail(reply, Object.assign(new Error(outcome.error.message), outcome.error), outcome.error.tool ?? request.body.tool);
        return reply.send({ ...outcome, apiVersion: API_VERSION });
      } catch (error) { return fail(reply, error, request.body?.tool); }
    },
  );
}
