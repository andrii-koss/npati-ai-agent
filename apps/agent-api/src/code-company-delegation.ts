import { randomUUID } from "node:crypto";
import type { AuthContext, Company } from "@npati/workspace";
import type { CodeService } from "./code-service";
import type { FeatureFlagService } from "./feature-flags";
import type { CodeSessionRunExecutor } from "./code-session-run-executor";
import type { CodeRunAdmission } from "./code-run-admission";
import { CodeExecutionModeError } from "./code-execution-mode";

/** Company agents invoke the same session executor, quotas and cancellation as chat/Workspace. */
export function createCompanyCodingDelegation(deps: {
  flags: FeatureFlagService; code: CodeService; executor: CodeSessionRunExecutor; admission: CodeRunAdmission;
}) {
  return async (ctx: AuthContext, company: Company, input: Record<string, unknown>, signal: AbortSignal) => {
    const projectId = typeof input.projectId === "string" ? input.projectId : "";
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!projectId || !task || task.length > 32_000) throw new CodeExecutionModeError("invalid_arguments", "Coding delegation requires a projectId and task (up to 32000 characters)", 400);
    const mode = await deps.flags.executionModes.get(ctx, company.id);
    if (mode.mode !== "company") throw new CodeExecutionModeError("execution_scope_denied", "Company agents may invoke Coding Agent only in Company mode");
    await deps.flags.executionModes.assertToolAllowed(ctx, company.id, projectId, "code.agent.spawn");
    await deps.flags.assertEnabled(ctx, "code.subagents", { companyId: company.id });
    const session = await deps.code.createSession(ctx, company.id, projectId, { mode: "auto", summary: task.slice(0, 4000) });
    const lease = await deps.admission.admit({ workspaceId: ctx.workspaceId, userId: ctx.userId, companyId: company.id, sessionId: session.id }, { signal });
    try {
      const runId = randomUUID();
      const outcome = await deps.executor.execute({ ctx, session, prompt: task, runId,
        cancelRequested: () => signal.aborted,
        sink: { signal, emitResult() {}, emitTerminal() {} } });
      return { routed: "code_runner", projectId, sessionId: session.id, runId,
        status: outcome.terminalStatus, needsApproval: outcome.needsApproval, run: outcome.result,
        workspaceUrl: `/settings/code/${encodeURIComponent(company.id)}/${encodeURIComponent(projectId)}?session=${encodeURIComponent(session.id)}` };
    } finally { lease.release(); }
  };
}
