import type { CodeToolExecutionContext } from "./code-tool-runtime";
import { CodeToolError } from "./code-tool-runtime";
import type { CodeAgentControlTarget, CodeSubagentOperationService } from "./code-subagent-operations";
import { CodeAgentControlError } from "./code-subagent-operations";
import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "./auth";
import type { AuthorizeCodeActionInput } from "./code-rbac";
import { resolveApiVersion, withApiVersion } from "./api-versioning";

export type CodeAgentControlOperation = "continue" | "send_message" | "interrupt";
export async function executeCodeAgentControl(service: CodeSubagentOperationService, operation: CodeAgentControlOperation,
  target: CodeAgentControlTarget, args: Record<string, unknown>) {
  if (operation === "interrupt") return { schemaVersion: 1, childRunId: target.childRunId, status: await service.interrupt(target) };
  if (typeof args.requestId !== "string" || !args.requestId.trim() || args.requestId.length > 200) throw new CodeAgentControlError("invalid_arguments", 400);
  if (operation === "continue") return service.continueChild({ ...target, requestId: args.requestId });
  if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 8000) throw new CodeAgentControlError("invalid_arguments", 400);
  return service.sendMessage({ ...target, requestId: args.requestId, text: args.text });
}

export function canonicalCodeAgentControlExecutors(getService?: () => CodeSubagentOperationService | undefined) {
  return Object.fromEntries((["continue", "send_message", "interrupt"] as const).map((operation) => [
    `code.agent.${operation}`, async (input: CodeToolExecutionContext) => {
      const service = getService?.();
      if (!service) throw new CodeToolError("tool_not_configured", "Async agent controls are unavailable", 503, "execute", false, input.tool.name);
      if (!input.sessionId || !input.runId || typeof input.args.childRunId !== "string") throw new CodeAgentControlError("invalid_arguments", 400);
      return executeCodeAgentControl(service, operation, { ctx: input.ctx, companyId: input.companyId,
        sessionId: input.sessionId, parentRunId: input.runId, childRunId: input.args.childRunId }, input.args);
    },
  ]));
}

export function registerCodeAgentControlRoutes(app: FastifyInstance, deps: {
  service: () => CodeSubagentOperationService | undefined; auth: AuthProvider;
  authorize(ctx: Awaited<ReturnType<AuthProvider["authenticate"]>>, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
}) {
  for (const operation of ["continue", "send_message", "interrupt"] as const) app.post<{
    Params: { companyId: string; sessionId: string; parentRunId: string; childRunId: string }; Body: Record<string, unknown>;
  }>(`/companies/:companyId/code/sessions/:sessionId/runs/:parentRunId/children/:childRunId/${operation}`, {
    bodyLimit: 40_000, schema: { body: { type: "object", additionalProperties: false,
      required: operation === "interrupt" ? [] : operation === "continue" ? ["requestId"] : ["requestId", "text"],
      properties: operation === "interrupt" ? {} : { requestId: { type: "string", minLength: 1, maxLength: 200 },
        ...(operation === "send_message" ? { text: { type: "string", minLength: 1, maxLength: 8000 } } : {}) } } },
  }, async (request, reply) => {
    try {
      const ctx = await deps.auth.authenticate(request); resolveApiVersion(request.headers);
      await deps.authorize(ctx, request.params.companyId, { action: `code.agent.${operation}`, permission: "workspace:write", sessionId: request.params.sessionId });
      const service = deps.service(); if (!service) throw new CodeAgentControlError("subagent_control_unavailable", 503);
      const result = await executeCodeAgentControl(service, operation, { ctx, ...request.params }, request.body ?? {});
      return reply.code(202).send(withApiVersion(result));
    } catch (error) {
      const e = error as { code?: string; httpStatus?: number; status?: number };
      return reply.code(e.httpStatus ?? e.status ?? 500).send({ error: { code: e.code ?? "subagent_control_failed", message: e.code ?? "subagent_control_failed" } });
    }
  });
}
