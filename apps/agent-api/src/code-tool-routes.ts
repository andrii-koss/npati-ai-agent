import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { currentToolManifest } from "./code-tool-registry";
import { API_VERSION, resolveApiVersion } from "./api-versioning";
import type { CodeToolInvokeFailure, CodeToolInvokeResult, CodeToolRuntime } from "./code-tool-runtime";
import { hasAdminPermission } from "./code-rbac";

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
  install_failed: 409,
  build_failed: 409,
  // C3: write path
  read_before_write_required: 409,
  revision_conflict: 409,
  revision_conflict_exhausted: 409,
  edit_no_match: 409,
  edit_ambiguous: 409,
  patch_conflict: 409,
  checkpoint_unavailable: 503,
  checkpoint_not_found: 409,
  approval_required: 403,
  approval_invalid: 409,
  APPROVAL_INVALID: 409,
  APPROVAL_ALREADY_USED: 409,
  approval_unavailable: 503,
  /**
   * C13: a `PreToolUse` project hook refused the call. Without this entry the route would rewrite the
   * refusal as the useless `tool_failed`/500, hiding the fact that the repository's own hook — not the
   * server — said no.
   */
  hook_blocked: 403,
  write_unavailable: 503,
  write_failed: 502,
  delete_failed: 502,
  move_failed: 502,
  // C4: sandbox execution
  command_hard_denied: 403,
  network_host_denied: 403,
  production_credential_denied: 403,
  interactive_command_not_supported: 400,
  secret_lease_inherited: 409,
  secret_lease_denied: 403,
  secret_lease_expired: 409,
  process_not_found: 404,
  process_limit_exceeded: 429,
  verify_unavailable: 503,
  verify_failed: 502,
  command_timeout: 504,
  command_failed: 409,
  command_not_found: 404,
  // C4a: dependency path. The verdict codes mirror the dependency guard; the audit codes mirror the
  // audit module so the model always gets the same code the guard produced.
  lockfile_required: 409,
  package_not_found: 404,
  typosquat_suspected: 409,
  source_requires_approval: 403,
  registry_change_requires_approval: 403,
  audit_unavailable: 503,
  audit_blocked: 409,
  install_unavailable: 503,
  secret_in_diff: 403,
  network_isolation_unavailable: 503,
  network_enforcement_unavailable: 503,
  policy_engine_unavailable: 503,
  policy_denied: 403,
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
    const values = error as { code?: string; status?: number; message?: string; step?: string; retryable?: boolean; tool?: string; details?: Record<string, unknown> };
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
        // Structured context only (revision, approval id, reason) - never file content or secrets.
        ...(values?.details ? { details: values.details } : {}),
      },
      apiVersion: API_VERSION,
    });
  };

  const authenticate = async (request: FastifyRequest, write: boolean) => {
    resolveApiVersion(request.headers);
    const ctx = await auth.authenticate(request);
    const allowed = hasAdminPermission(ctx.permissions)
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

  app.post<{ Params: ProjectParams; Body: { tool: string; toolVersion?: number; args?: Record<string, unknown>; sessionId?: string; toolCallId: string; turnId?: string; approvalId?: string; runId?: string; agentId?: string } }>(
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
            // C3: turn scoping, the approval obtained for this exact payload, and the acting run.
            turnId: { type: "string", maxLength: 120 },
            approvalId: { type: "string", maxLength: 120 },
            runId: { type: "string", maxLength: 120 },
            agentId: { type: "string", maxLength: 120 },
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
          turnId: request.body.turnId,
          approvalId: request.body.approvalId,
          runId: request.body.runId,
          agentId: request.body.agentId,
        });
        if (!outcome.ok) return fail(reply, Object.assign(new Error(outcome.error.message), outcome.error), outcome.error.tool ?? request.body.tool);
        return reply.send({ ...outcome, apiVersion: API_VERSION });
      } catch (error) { return fail(reply, error, request.body?.tool); }
    },
  );

  /**
   * C3: the turn-scoped diff. It is read-only (the change log this process kept for the turn), so it
   * needs `workspace:read`; the workspace-wide diff stays with `code.fs.diff` inside the sandbox toolset.
   */
  app.get<{ Params: ProjectParams; Querystring: { turnId: string; sessionId?: string } }>(
    "/companies/:companyId/projects/:projectId/code/diff",
    async (request, reply) => {
      try {
        const ctx = await authenticate(request, false);
        await assertCompany(ctx, request.params.companyId);
        if (!runtime) return reply.code(503).send({ error: { code: "feature_disabled", message: "Coding Agent is unavailable: tool runtime is not configured", tool: null, step: "flags", retryable: false }, apiVersion: API_VERSION });
        const sessionId = request.query.sessionId ?? `project:${request.params.projectId}`;
        const summary = runtime.turnSummary(sessionId, request.query.turnId);
        return reply.send({
          turnId: summary.turnId, sessionId: summary.sessionId, checkpointId: summary.checkpointId,
          files: summary.changes.map((change) => ({ path: change.path, tool: change.tool, sha256: change.sha256, linesAdded: change.linesAdded, linesRemoved: change.linesRemoved })),
          stats: { files: summary.files, linesAdded: summary.linesAdded, linesRemoved: summary.linesRemoved },
          diff: summary.changes.map((change) => change.diff).filter(Boolean).join("\n"),
          apiVersion: API_VERSION,
        });
      } catch (error) { return fail(reply, error); }
    },
  );

  /** C3: undo the last turn for this session (owner/admin); restores the turn checkpoint. */
  app.post<{ Params: ProjectParams; Body: { turnId?: string; sessionId?: string; runId?: string } }>(
    "/companies/:companyId/projects/:projectId/code/undo-last-turn",
    async (request, reply) => {
      try {
        const ctx = await authenticate(request, true);
        await assertCompany(ctx, request.params.companyId);
        if (!runtime) throw Object.assign(new Error("Coding Agent is unavailable"), { code: "feature_disabled", status: 503, step: "flags" });
        const outcome = await runtime.undoTurn(ctx, {
          companyId: request.params.companyId,
          projectId: request.params.projectId,
          sessionId: request.body?.sessionId,
          turnId: request.body?.turnId,
          runId: request.body?.runId,
        });
        if (!outcome.ok) return fail(reply, Object.assign(new Error(outcome.error.message), outcome.error), outcome.error.tool ?? "code.fs.undo_last_turn");
        return reply.send({ ...outcome, apiVersion: API_VERSION });
      } catch (error) { return fail(reply, error, "code.fs.undo_last_turn"); }
    },
  );
}
