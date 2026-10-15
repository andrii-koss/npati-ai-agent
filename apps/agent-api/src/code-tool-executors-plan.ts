import { CodePlanToolError, type ProposePlanResult, type UpdateTodosResult } from "./code-plan-tool";
import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import type { CanonicalDepsExecutorOptions } from "./code-tool-executors-deps";
import { toolNotConfigured } from "./code-tool-executors-common";

/**
 * C9: planning tools. They are dispatch-only adapters: validation, idempotency and the "at most one
 * in_progress" rule live in `code-plan-tool.ts`, and the structured refusal keeps its own reason so the model
 * learns what was wrong instead of seeing a generic argument error.
 */
export interface CodePlanToolPort {
  propose(request: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId: string;
    plan: unknown;
    createdBy?: string | null;
  }): Promise<ProposePlanResult>;
  updateTodos(request: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId: string;
    tasks: unknown;
  }): Promise<UpdateTodosResult>;
}

export interface CanonicalPlanExecutorOptions extends CanonicalDepsExecutorOptions {
  /** Planning service; absent → both planning tools fail closed with `tool_not_configured`. */
  planTool?: CodePlanToolPort;
}

function rethrowPlan(error: unknown, tool: string): never {
  if (error instanceof CodePlanToolError) {
    throw new CodeToolError(
      "invalid_arguments",
      error.message,
      error.httpStatus,
      "validate_arguments",
      error.retryable,
      tool,
      { reason: error.code, ...error.details },
    );
  }
  throw error;
}

export function canonicalPlanExecutors(options: CanonicalPlanExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  const plan = (tool: string): CodePlanToolPort => {
    if (!options.planTool) toolNotConfigured(tool, "the planning service wiring");
    return options.planTool;
  };
  const sessionOrFail = (input: CodeToolExecutionContext): string => {
    if (!input.sessionId) {
      throw new CodeToolError("invalid_arguments", `${input.tool.name} requires a session`, 400, "validate_arguments", false, input.tool.name);
    }
    return input.sessionId;
  };

  return {
    "code.plan.propose": async (input) => {
      const port = plan(input.tool.name);
      const sessionId = sessionOrFail(input);
      try {
        return await port.propose({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId,
          // The whole argument object is handed over: the service validates it and keeps only the four fields a
          // plan may carry, so an unexpected key (a mode, for instance) never reaches storage.
          plan: input.args,
          createdBy: input.ctx.userId,
        });
      } catch (error) { rethrowPlan(error, input.tool.name); }
    },

    "code.plan.update": async (input) => {
      const port = plan(input.tool.name);
      const sessionId = sessionOrFail(input);
      try {
        return await port.updateTodos({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId,
          tasks: input.args.tasks,
        });
      } catch (error) { rethrowPlan(error, input.tool.name); }
    },
  };
}
