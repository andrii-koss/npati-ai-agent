import type { FastifyInstance } from "fastify";
import { CodeInboxError } from "@npati/workspace";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import type { AuthProvider } from "./auth";
import { AuthenticationError } from "./auth";
import { resolveApiVersion, withApiVersion } from "./api-versioning";
import type { CodeSessionInboxService } from "./code-session-inbox";

export function registerCodeSessionInboxRoutes(app: FastifyInstance, deps: {
  service: CodeSessionInboxService; auth: AuthProvider;
  authorize(ctx: Awaited<ReturnType<AuthProvider["authenticate"]>>, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
}) {
  type Params = { companyId: string; sessionId: string; messageId?: string };
  const path = "/companies/:companyId/code/sessions/:sessionId/messages";
  for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
    app.route<{ Params: Params; Body: Record<string, unknown> }>({ method, url: method === "PUT" || method === "DELETE" ? `${path}/:messageId` : path,
      bodyLimit: 80_000,
      handler: async (request, reply) => {
        try {
          const ctx = await deps.auth.authenticate(request);
          resolveApiVersion(request.headers);
          const { companyId, sessionId, messageId } = request.params;
          const action = method === "GET" ? "code.session.inbox.read" : "code.session.inbox.write";
          await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action)!, sessionId });
          const body = request.body ?? {};
          let result;
          if (method === "GET") {
            result = await deps.service.execute(ctx, companyId, sessionId, { kind: "read" });
            if (result.state.messages.some((m) => m.completion && m.status === "pending" && m.target === "next-turn")) void deps.service.wake(ctx, companyId, sessionId).catch(() => undefined);
          }
          else if (method === "POST") {
            if (typeof body.requestId !== "string" || typeof body.text !== "string" || !["queue", "steer"].includes(String(body.mode))) throw new CodeInboxError("invalid_arguments", 400);
            if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)) throw new CodeInboxError("invalid_arguments", 400);
            result = await deps.service.submit(ctx, companyId, sessionId, { requestId: body.requestId, text: body.text, mode: body.mode as "queue" | "steer",
              ...(body.expectedRevision !== undefined ? { expectedRevision: Number(body.expectedRevision) } : {}) });
            void deps.service.wake(ctx, companyId, sessionId).catch(() => undefined);
          } else {
            if (!messageId || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new CodeInboxError("invalid_arguments", 400);
            if (method === "PUT" && typeof body.text !== "string") throw new CodeInboxError("invalid_arguments", 400);
            result = await deps.service.execute(ctx, companyId, sessionId, method === "PUT"
              ? { kind: "edit", id: messageId, text: body.text as string, expectedRevision: Number(body.expectedRevision) }
              : { kind: "discard", id: messageId, expectedRevision: Number(body.expectedRevision) });
          }
          return reply.code(method === "POST" ? 202 : 200).send(withApiVersion({
            revision: result.state.revision, runId: result.state.runId, phase: result.state.phase, lastError: result.state.lastError,
            messages: result.state.messages.filter((m) => m.status === "pending" || m.status === "claimed"), receipt: result.messages[0] ?? null,
          }));
        } catch (error) {
          const status = error instanceof CodeInboxError ? error.httpStatus : error instanceof AuthenticationError ? error.status
            : error instanceof CodeRbacError ? error.httpStatus : (error as { status?: number }).status ?? 500;
          const code = (error as { code?: string }).code ?? "inbox_request_failed";
          return reply.code(status ?? 500).send(withApiVersion({ error: { code, message: code, retryable: status === 409 || status === 503 } }));
        }
      },
    });
  }
}
