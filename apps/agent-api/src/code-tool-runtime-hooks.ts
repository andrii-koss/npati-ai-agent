import type { AuthContext } from "@npati/workspace";
import type { CodeToolSchema } from "./code-tool-registry";
import { extractWriteChanges, revisionConflictDetails, type CodeTurnTracker } from "./code-workspace-checkpoint";
import type { CodeToolInvokeFailure, CodeToolRuntimeOptions } from "./code-tool-runtime-ports";
import { canonicalFailure, CodeToolError } from "./code-tool-runtime-errors";
import { SandboxProviderError } from "./sandbox-provider";
import { ProjectFileError } from "./project-workspace";
import { SsrfPolicyError } from "./ssrf-policy";

export function toFailure(error: unknown, tool: string): CodeToolInvokeFailure {
  if (error instanceof CodeToolError) {
    return { ok: false, error: { code: error.code, status: error.status, message: error.message, tool: error.tool ?? tool, step: error.step, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) } };
  }
  const canonical = canonicalFailure(error);
  if (canonical) {
    const shaped = error as { details?: Record<string, unknown> };
    return { ok: false, error: { code: canonical.code, status: canonical.status, message: canonical.message, tool: canonical.tool ?? tool, step: canonical.step ?? "execute", retryable: canonical.retryable, ...(shaped?.details ? { details: shaped.details } : {}) } };
  }
  // Workspace revision control: the current revision travels back so the model can re-read and retry.
  const conflict = revisionConflictDetails(error);
  if (conflict) {
    return { ok: false, error: { code: "revision_conflict", status: conflict.status, message: "File changed on disk; re-read it and retry", tool, step: "revision", retryable: true, details: { currentRevision: conflict.currentRevision } } };
  }
  const flags = error as { code?: string; status?: number; flagKey?: string; message?: string };
  if (flags?.code === "feature_disabled") {
    return { ok: false, error: { code: "feature_disabled", status: flags.status ?? 403, message: flags.message ?? `Feature disabled: ${flags.flagKey ?? "unknown"}`, tool, step: "flags", retryable: false } };
  }
  // Sandbox and workspace errors are written for the caller; hiding them left the model nothing to act on.
  if (error instanceof SandboxProviderError || error instanceof ProjectFileError) {
    const known = error as { code: string; status?: number; step?: string; retryable?: boolean; message: string };
    return { ok: false, error: { code: known.code as never, status: known.status ?? 500, message: known.message, tool, step: known.step ?? "execute", retryable: known.retryable ?? false } };
  }
  if (error instanceof SsrfPolicyError) {
    return { ok: false, error: { code: "web_host_not_allowed" as never, status: 403, message: "This host is not in the allowed web list (NPATI_WEB_FETCH_ALLOWED_HOSTS). Tell the user the page cannot be opened; do not retry.", tool, step: "execute", retryable: false } };
  }
  if (error instanceof Error && error.name === "ShellRuntimeError") {
    const known = error as Error & { code: string; httpStatus?: number; retryable?: boolean };
    return { ok: false, error: { code: known.code as never, status: known.httpStatus ?? 500, message: known.message, tool, step: "execute", retryable: known.retryable ?? false } };
  }
  console.error("[code-tool] unexpected failure", tool, error instanceof Error ? error.name + ": " + error.message.slice(0, 300) : typeof error);
  return { ok: false, error: { code: "tool_failed", status: 500, message: "Tool execution failed", tool, step: "execute", retryable: true } };
}

export class CodeToolHooksCoordinator {
  constructor(
    private readonly options: CodeToolRuntimeOptions,
    private readonly turns: CodeTurnTracker,
    private readonly writeTools: ReadonlySet<string>,
  ) {}

  /**
   * C13: asks the executor's own policy engine whether this call will be allowed, so the PreToolUse hook is
   * withheld when it will not be.
   */
  async preToolPolicyAllows(
    ctx: AuthContext,
    input: { companyId: string; projectId: string; sessionId?: string; toolCallId: string; runId?: string; agentId?: string; leaseOwner?: string; approvalId?: string },
    tool: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const port = this.options.preToolPolicy;
    if (!port) return true;
    try {
      const decision = await port.evaluate({
        ctx, companyId: input.companyId, projectId: input.projectId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        tool, args, toolCallId: input.toolCallId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      });
      return decision.decision === "allow";
    } catch {
      return false;
    }
  }

  /** Formatter/syntax hooks: warnings only, never a failure and never a silent content change. */
  async runPostWriteHooks(ctx: AuthContext, input: { companyId: string; projectId: string }, tool: string, raw: unknown): Promise<string[]> {
    const hooks = this.options.postWriteHooks;
    if (!hooks || (!hooks.format && !hooks.checkSyntax)) return [];
    const changes = extractWriteChanges(tool, raw);
    const paths = [...new Set(changes.map((change) => change.path))];
    if (!paths.length) return [];
    const warnings: string[] = [];
    for (const [name, hook] of [["format", hooks.format], ["checkSyntax", hooks.checkSyntax]] as const) {
      if (!hook) continue;
      try {
        const result = await hook({ ctx, companyId: input.companyId, projectId: input.projectId, paths });
        if (Array.isArray(result)) warnings.push(...result.map((line) => `${name}: ${line}`));
      } catch (error) {
        warnings.push(`${name}: ${error instanceof Error ? error.message : "hook failed"}`);
      }
    }
    return warnings;
  }

  async recordActivity(input: { companyId: string; projectId: string; sessionId?: string; runId?: string; snapshotId?: string; toolCallId?: string; turnId?: string; tool: string; toolVersion: number; durationMs: number; bytes: number; truncated: boolean; ok: boolean; errorCode?: string }): Promise<void> {
    if (!this.options.activity) return;
    try {
      await this.options.activity.record({
        companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId,
        runId: input.runId, snapshotId: input.snapshotId, toolCallId: input.toolCallId, turnId: input.turnId,
        tool: input.tool, toolVersion: input.toolVersion, schemaVersion: input.toolVersion,
        durationMs: input.durationMs, bytes: input.bytes, truncated: input.truncated, ok: input.ok, errorCode: input.errorCode,
      });
    } catch {
      // Activity must never break a tool call; the audit journal below is the compliance record.
    }
  }

  async recordAudit(
    ctx: AuthContext,
    input: { companyId: string; projectId: string; sessionId?: string; tool: string; toolCallId: string },
    tool: CodeToolSchema | undefined,
    decision: "allowed" | "denied",
    errorCode?: string,
    extra?: { checkpointId?: string | null; turnId?: string; changes?: number; action?: string; strict?: boolean; snapshotId?: string },
  ): Promise<void> {
    if (!this.options.audit) return;
    try {
      const turn = extra?.turnId ? this.turns.summary(input.sessionId ?? `project:${input.projectId}`, extra.turnId) : null;
      await this.options.audit.record(ctx, {
        companyId: input.companyId, actor: ctx.userId, actorRole: "agent",
        action: decision === "allowed" ? (this.writeTools.has(input.tool) ? input.tool : "code.tool.invoke") : "code.tool.denied",
        resourceType: "code_tool", resourceId: input.tool, projectId: input.projectId,
        decision,
        ...(extra?.snapshotId ? { snapshotId: extra.snapshotId } : {}),
        payload: { tool: input.tool, toolVersion: tool?.version ?? null, toolCallId: input.toolCallId, errorCode: errorCode ?? null },
        metadata: {
          sessionId: input.sessionId ?? null, errorCode: errorCode ?? null,
          checkpointId: extra?.checkpointId ?? null, turnId: extra?.turnId ?? null,
          action: extra?.action ?? null,
          files: turn?.files ?? extra?.changes ?? 0,
          linesAdded: turn?.linesAdded ?? 0, linesRemoved: turn?.linesRemoved ?? 0,
          paths: turn?.changes.slice(0, 20).map((change) => change.path) ?? [],
        },
      });
    } catch (error) {
      if (extra?.strict) throw error;
    }
  }
}
