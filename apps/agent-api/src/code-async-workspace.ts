import type { FastifyInstance } from "fastify";
import { WorkspaceAccessError, WorkspaceNotFoundError, CodeProcessStoreError, type AuthContext, type CodeProcessStore, type CodeSession } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { AuthorizeCodeActionInput } from "./code-rbac";
import type { FeatureFlagService } from "./feature-flags";
import { resolveApiVersion, withApiVersion } from "./api-versioning";

/** A projection of the existing durable operations. Reading never claims, delivers or resumes work. */
export class CodeAsyncWorkspaceService {
  constructor(private readonly deps: {
    store: CodeProcessStore;
    flags: Pick<FeatureFlagService, "assertEnabled" | "isEnabled">;
    session(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession>;
  }) {}
  async read(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string }) {
    await this.deps.flags.assertEnabled(ctx, "code.async_workspace", { companyId: input.companyId });
    const session = await this.deps.session(ctx, input.companyId, input.sessionId);
    if (session.id !== input.sessionId || session.companyId !== input.companyId || session.projectId !== input.projectId || session.userId !== ctx.userId || session.workspaceId !== ctx.workspaceId) {
      throw new CodeProcessStoreError("session_not_found", 404);
    }
    const { operations } = await this.deps.store.transact({ ...input, dataClassification: session.dataClassification,
      retentionClass: session.retentionClass }, { kind: "read" });
    const enabled = (key: string) => this.deps.flags.isEnabled(ctx, key, { companyId: input.companyId });
    const [inbox, controls, resume, processes, shell] = await Promise.all([enabled("code.async_inbox"), enabled("code.async_agent_control"), enabled("code.session_resume"), enabled("code.async_processes"), enabled("code.shell")]);
    return { schemaVersion: 1 as const, ...input, capabilities: { inbox, controls, resume, processes: processes && shell },
      operations: operations.filter(op => op.companyId === input.companyId && op.projectId === input.projectId && op.sessionId === input.sessionId).map(op => ({
        operationId: op.operationId, processId: op.processId, runId: op.runId, generation: op.generation,
        kind: op.kind ?? "process", state: op.state, exitCode: op.exitCode, cancelRequested: op.cancelRequested,
        collected: !!op.completion?.admission, delivered: !!op.completion?.deliveredAt,
        ...(op.child ? { childRunId: op.child.runId, childSessionId: op.child.sessionId, agentType: op.child.agentType, stopRequested: !!op.child.stopRequested } : {}),
      })) };
  }
}

export function registerCodeAsyncWorkspaceRoutes(app: FastifyInstance, deps: {
  service: CodeAsyncWorkspaceService; auth: AuthProvider;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
}) {
  app.get<{ Params: { companyId: string; projectId: string; sessionId: string } }>(
    "/companies/:companyId/projects/:projectId/code/sessions/:sessionId/async-workspace", async (request, reply) => {
      try {
        const ctx = await deps.auth.authenticate(request); resolveApiVersion(request.headers);
        await deps.authorize(ctx, request.params.companyId, { action: "code.changes.read", permission: "workspace:read", sessionId: request.params.sessionId });
        return reply.header("cache-control", "no-store").send(withApiVersion(await deps.service.read(ctx, request.params)));
      } catch (error) {
        const e = error as { code?: string; status?: number; httpStatus?: number };
        // No exception messages, producer arguments, lease identities or results cross this projection.
        const hidden = error instanceof WorkspaceAccessError || error instanceof WorkspaceNotFoundError;
        const code = hidden ? "session_not_found" : e.code ?? "async_workspace_unavailable";
        return reply.code(hidden ? 404 : e.httpStatus ?? e.status ?? 500).send(withApiVersion({ error: { code, message: code } }));
      }
    });
}
