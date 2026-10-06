import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  AuthContext,
  CodeGoalRecord,
  CodeSessionPlanRecord,
  CodeSessionTodoRecord,
  WorkspaceStore,
} from "@npati/workspace";
import { CodeGoalAcceptanceUnverifiedError, CodeSessionPlanRevisionConflictError, WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import type { CodeAuditPort } from "./code-project-trust";
import { decidePlan, CodePlanModeError } from "./code-plan-mode";
import { createGoal, readGoal, setCriterionStatus, transitionGoal, CodeGoalServiceError, type GoalView } from "./code-goal-service";
import type { CodeGoalStatus } from "@npati/workspace";

/**
 * C9 planning and goal surface.
 *
 * Three reads (goals, the current plan, the todo list) and four writes (create a goal, move a goal, verify a
 * criterion, decide a plan revision). Everything goes through the shared C5a gate with **named actions**, so
 * the permission is derived from the action instead of being handed in by the caller, and every mutation
 * writes the audit journal **before** the change — an audit outage refuses the change rather than applying it
 * unrecorded (rule 23, fail closed).
 *
 * Two contract details are deliberate:
 *
 * 1. Deciding a plan may also apply the approved mode to the session, through an **optional** port. When that
 *    port is absent the response reports `modeApplied: false` with a reason instead of pretending the run will
 *    continue in the new mode — a silent success here would leave the user believing execution started in a
 *    mode the session does not have.
 * 2. Nothing in this surface can complete a goal. Completion is a transition like any other and the store
 *    refuses it while acceptance criteria are unverified (`goal_acceptance_unverified`), which is the whole
 *    point of holding criteria as records rather than as text.
 *
 * Refusal codes are part of the contract because the UI explains them:
 *   unauthorized · invalid_arguments · permission_denied · action_not_mapped · permission_action_mismatch
 *   goal_not_found · goal_criteria_required · goal_criteria_invalid · goal_transition_invalid
 *   goal_question_required · goal_update_invalid · goal_acceptance_unverified
 *   plan_not_found · plan_already_decided · plan_revision_conflict
 *   plan_execution_mode_required · plan_execution_mode_invalid · plan_decision_invalid
 *   code_goal_request_failed
 */

export class CodeGoalRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeGoalRouteError";
    this.retryable = retryable;
  }
}

/** Actions this surface authorizes. Named actions keep the permission derived from the action. */
export const CODE_GOAL_ACTIONS = Object.freeze({
  goalRead: "code.goal.read",
  goalWrite: "code.goal.write",
  planRead: "code.plan.read",
  planDecide: "code.plan.decide",
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  goal_not_found: 404,
  goal_criteria_required: 400,
  goal_criteria_invalid: 400,
  goal_transition_invalid: 409,
  goal_question_required: 400,
  goal_update_invalid: 400,
  goal_acceptance_unverified: 409,
  plan_not_found: 404,
  plan_already_decided: 409,
  plan_revision_conflict: 409,
  plan_execution_mode_required: 400,
  plan_execution_mode_invalid: 400,
  plan_decision_invalid: 400,
  code_goal_request_failed: 500,
};

const GOAL_MAX_LIMIT = 100;

interface CompanyParams { companyId: string }
interface GoalParams extends CompanyParams { goalId: string }
interface CriterionParams extends GoalParams { criterionId: string }
interface SessionParams extends CompanyParams { sessionId: string }

/** The store slice this surface needs; narrow so tests inject exactly this. */
export interface CodeGoalRouteStore {
  getCodeGoal(companyId: string, goalId: string): Promise<Awaited<ReturnType<WorkspaceStore["getCodeGoal"]>>>;
  listCodeGoals(input: Parameters<WorkspaceStore["listCodeGoals"]>[0]): Promise<CodeGoalRecord[]>;
  createCodeGoal(input: Parameters<WorkspaceStore["createCodeGoal"]>[0]): Promise<Awaited<ReturnType<WorkspaceStore["createCodeGoal"]>>>;
  updateCodeGoal(input: Parameters<WorkspaceStore["updateCodeGoal"]>[0]): Promise<Awaited<ReturnType<WorkspaceStore["updateCodeGoal"]>>>;
  setCodeGoalCriterionStatus(input: Parameters<WorkspaceStore["setCodeGoalCriterionStatus"]>[0]): Promise<Awaited<ReturnType<WorkspaceStore["setCodeGoalCriterionStatus"]>>>;
  listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]>;
  replaceCodeSessionTodos(input: Parameters<WorkspaceStore["replaceCodeSessionTodos"]>[0]): Promise<CodeSessionTodoRecord[]>;
  getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null>;
  listCodeSessionPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]>;
  decideCodeSessionPlan(input: Parameters<WorkspaceStore["decideCodeSessionPlan"]>[0]): Promise<CodeSessionPlanRecord>;
}

export interface ApplyExecutionModeInput {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId: string;
  mode: string;
}

export interface CodeGoalRouteDeps {
  store: CodeGoalRouteStore;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  /** Fail-closed journal. It is awaited before every mutation. */
  audit?: CodeAuditPort;
  /**
   * Applies an approved plan's mode to the session through the existing mode service. Optional so this module
   * can ship before the wiring exists — and when it is absent the response says so instead of faking success.
   */
  applyExecutionMode?: (input: ApplyExecutionModeInput) => Promise<void>;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeGoalRouteError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof CodePlanModeError) return error.code;
  if (error instanceof CodeGoalServiceError) return error.code;
  if (error instanceof CodeGoalAcceptanceUnverifiedError) return error.code;
  if (error instanceof CodeSessionPlanRevisionConflictError) return error.code;
  if (error instanceof WorkspaceAccessError) return "permission_denied";
  if (error instanceof WorkspaceNotFoundError) return "goal_not_found";
  return "code_goal_request_failed";
}

function resolveErrorStatus(error: unknown, code: string): number {
  // The code is the contract, so the table wins over the error's own status.
  const fromCode = ROUTE_ERROR_STATUS[code];
  if (fromCode !== undefined) return fromCode;
  const shaped = error as { httpStatus?: unknown; status?: unknown } | null;
  const explicit = Number(shaped?.httpStatus ?? shaped?.status ?? Number.NaN);
  if (Number.isFinite(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  return 500;
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) {
    return reply.code(error.status ?? 401).send({
      ...withApiVersion({}),
      error: { code: error.code ?? "unauthorized", message: error.message, retryable: false },
    });
  }
  const code = resolveErrorCode(error);
  const status = resolveErrorStatus(error, code);
  const details = (error as { details?: unknown } | null)?.details;
  const message = code === "code_goal_request_failed"
    ? "Code goal request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code goal request failed");
  return reply.code(status).send({
    ...withApiVersion({}),
    error: {
      code,
      message,
      retryable: (error as { retryable?: unknown } | null)?.retryable === true,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function badRequest(message: string, details: Record<string, unknown> = {}): CodeGoalRouteError {
  return new CodeGoalRouteError("invalid_arguments", message, 400, details);
}

function readLimit(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw badRequest("limit must be a positive number", { field: "limit" });
  return Math.min(Math.trunc(parsed), GOAL_MAX_LIMIT);
}

function readExpectedRevision(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest("expectedRevision is required and must be a positive integer", { field: "expectedRevision" });
  }
  return parsed;
}

function goalView(goal: GoalView) {
  return {
    goalId: goal.id,
    projectId: goal.projectId,
    sessionId: goal.sessionId,
    runId: goal.runId,
    objective: goal.objective,
    constraints: goal.constraints,
    status: goal.status,
    blockedReason: goal.blockedReason,
    question: goal.question,
    revision: goal.revision,
    progress: goal.progress,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    criteria: goal.criteria.map((criterion) => ({
      criterionId: criterion.id,
      position: criterion.position,
      criterion: criterion.criterion,
      status: criterion.status,
      evidence: criterion.evidence,
      verifiedBy: criterion.verifiedBy,
      verifiedAt: criterion.verifiedAt,
    })),
  };
}

function todoView(todo: CodeSessionTodoRecord) {
  return { taskId: todo.taskId, content: todo.content, status: todo.status, position: todo.position, goalId: todo.goalId };
}

function planView(plan: CodeSessionPlanRecord) {
  return {
    planId: plan.id,
    revision: plan.revision,
    status: plan.status,
    plan: plan.plan,
    // The mode is recorded on the decision, never read out of the plan body: the plan is model output.
    executionMode: plan.executionMode,
    decisionNote: plan.decisionNote,
    decidedBy: plan.decidedBy,
    decidedAt: plan.decidedAt,
    createdBy: plan.createdBy,
    createdAt: plan.createdAt,
  };
}

export async function registerCodeGoalRoutes(instance: FastifyInstance, deps: CodeGoalRouteDeps) {
  const contextOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    return context;
  };

  const authorize = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = contextOrFail(request);
    // Deny by default: an action the gate does not know stays `""` and is refused as `action_not_mapped`.
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  /**
   * The journal entry is written before the change and a failure propagates, so an audit outage refuses the
   * mutation instead of applying it without a record.
   */
  const auditBefore = async (ctx: AuthContext, input: {
    action: string;
    companyId: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    if (!deps.audit) return;
    await deps.audit.record({
      action: input.action,
      actor: ctx.userId,
      companyId: input.companyId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      decision: "allow",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  };

  const serviceStore = {
    createCodeGoal: (input: Parameters<CodeGoalRouteStore["createCodeGoal"]>[0]) => deps.store.createCodeGoal(input),
    getCodeGoal: (companyId: string, goalId: string) => deps.store.getCodeGoal(companyId, goalId),
    listCodeGoals: (input: Parameters<CodeGoalRouteStore["listCodeGoals"]>[0]) => deps.store.listCodeGoals(input),
    updateCodeGoal: (input: Parameters<CodeGoalRouteStore["updateCodeGoal"]>[0]) => deps.store.updateCodeGoal(input),
    setCodeGoalCriterionStatus: (input: Parameters<CodeGoalRouteStore["setCodeGoalCriterionStatus"]>[0]) => deps.store.setCodeGoalCriterionStatus(input),
    listCodeSessionTodos: (input: { companyId: string; sessionId: string }) => deps.store.listCodeSessionTodos(input),
  };

  /** Read-only: the goals of a session or a project, with the acceptance state the workspace shows. */
  instance.get<{ Params: CompanyParams; Querystring: { sessionId?: string; projectId?: string; limit?: string } }>(
    "/companies/:companyId/code/goals",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        await authorize(request, companyId, CODE_GOAL_ACTIONS.goalRead);
        const sessionId = request.query?.sessionId ? String(request.query.sessionId) : undefined;
        const projectId = request.query?.projectId ? String(request.query.projectId) : undefined;
        const goals = await deps.store.listCodeGoals({
          companyId,
          ...(sessionId ? { sessionId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(readLimit(request.query?.limit) !== undefined ? { limit: readLimit(request.query?.limit) } : {}),
        });
        return reply.send(withApiVersion({ status: "ok", goals: goals.map((goal) => ({
          goalId: goal.id,
          projectId: goal.projectId,
          sessionId: goal.sessionId,
          runId: goal.runId,
          objective: goal.objective,
          status: goal.status,
          blockedReason: goal.blockedReason,
          question: goal.question,
          revision: goal.revision,
          progressCompleted: goal.progressCompleted,
          progressTotal: goal.progressTotal,
          updatedAt: goal.updatedAt,
        })) }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  instance.get<{ Params: GoalParams }>("/companies/:companyId/code/goals/:goalId", async (request, reply) => {
    try {
      const { companyId, goalId } = request.params;
      await authorize(request, companyId, CODE_GOAL_ACTIONS.goalRead);
      const goal = await readGoal(serviceStore, { companyId, goalId });
      return reply.send(withApiVersion({ status: "ok", goal: goalView(goal) }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Create a goal. Acceptance criteria are required: a goal that cannot be verified cannot be completed. */
  instance.post<{ Params: CompanyParams; Body: { projectId?: string; sessionId?: string; runId?: string; objective?: string; constraints?: string[]; criteria?: string[] } }>(
    "/companies/:companyId/code/goals",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        const ctx = await authorize(request, companyId, CODE_GOAL_ACTIONS.goalWrite);
        const body = request.body ?? {};
        if (typeof body.projectId !== "string" || !body.projectId.trim()) throw badRequest("projectId is required", { field: "projectId" });
        await auditBefore(ctx, {
          action: "code.goal.create",
          companyId,
          resourceType: "code_goal",
          resourceId: String(body.projectId),
          metadata: { hasSession: typeof body.sessionId === "string" },
        });
        const goal = await createGoal(serviceStore, {
          companyId,
          projectId: body.projectId,
          sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
          runId: typeof body.runId === "string" ? body.runId : null,
          objective: body.objective,
          constraints: body.constraints,
          criteria: body.criteria,
          createdBy: ctx.userId,
        });
        return reply.code(201).send(withApiVersion({ status: "created", goal: goalView(goal) }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Move a goal. `completed` is refused by the store while any acceptance criterion is unverified. */
  instance.post<{ Params: GoalParams; Body: { status?: string; expectedRevision?: number; question?: string; blockedReason?: string } }>(
    "/companies/:companyId/code/goals/:goalId/status",
    async (request, reply) => {
      try {
        const { companyId, goalId } = request.params;
        const ctx = await authorize(request, companyId, CODE_GOAL_ACTIONS.goalWrite);
        const body = request.body ?? {};
        const status = body.status as CodeGoalStatus;
        if (typeof status !== "string" || !status) throw badRequest("status is required", { field: "status" });
        const expectedRevision = readExpectedRevision(body.expectedRevision);
        await auditBefore(ctx, {
          action: "code.goal.transition",
          companyId,
          resourceType: "code_goal",
          resourceId: goalId,
          metadata: { status, expectedRevision },
        });
        const goal = await transitionGoal(serviceStore, {
          companyId,
          goalId,
          expectedRevision,
          status,
          ...(typeof body.question === "string" ? { question: body.question } : {}),
          ...(typeof body.blockedReason === "string" ? { blockedReason: body.blockedReason } : {}),
        });
        return reply.send(withApiVersion({ status: "ok", goal: goalView(goal) }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** Verify (or fail) one acceptance criterion. This is the only path that unlocks completion. */
  instance.post<{ Params: CriterionParams; Body: { status?: string; evidence?: string } }>(
    "/companies/:companyId/code/goals/:goalId/criteria/:criterionId",
    async (request, reply) => {
      try {
        const { companyId, goalId, criterionId } = request.params;
        const ctx = await authorize(request, companyId, CODE_GOAL_ACTIONS.goalWrite);
        const body = request.body ?? {};
        if (typeof body.status !== "string" || !body.status) throw badRequest("status is required", { field: "status" });
        await auditBefore(ctx, {
          action: "code.goal.criterion",
          companyId,
          resourceType: "code_goal_criterion",
          resourceId: criterionId,
          metadata: { goalId, status: body.status },
        });
        const goal = await setCriterionStatus(serviceStore, {
          companyId,
          goalId,
          criterionId,
          status: body.status as "pending" | "verified" | "failed",
          ...(typeof body.evidence === "string" ? { evidence: body.evidence } : {}),
          verifiedBy: ctx.userId,
        });
        return reply.send(withApiVersion({ status: "ok", goal: goalView(goal) }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** The current plan revision and its decision state, plus the todo list the workspace renders. */
  instance.get<{ Params: SessionParams }>("/companies/:companyId/code/sessions/:sessionId/plan", async (request, reply) => {
    try {
      const { companyId, sessionId } = request.params;
      await authorize(request, companyId, CODE_GOAL_ACTIONS.planRead);
      const [latest, revisions] = await Promise.all([
        deps.store.getLatestCodeSessionPlan(companyId, sessionId),
        deps.store.listCodeSessionPlans({ companyId, sessionId, limit: GOAL_MAX_LIMIT }),
      ]);
      return reply.send(withApiVersion({
        status: latest ? "ok" : "no_plan",
        plan: latest ? planView(latest) : null,
        revisionCount: revisions.length,
      }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.get<{ Params: SessionParams }>("/companies/:companyId/code/sessions/:sessionId/todos", async (request, reply) => {
    try {
      const { companyId, sessionId } = request.params;
      await authorize(request, companyId, CODE_GOAL_ACTIONS.planRead);
      const todos = await deps.store.listCodeSessionTodos({ companyId, sessionId });
      return reply.send(withApiVersion({ status: "ok", todos: todos.map(todoView) }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Approve or reject a plan revision. The execution mode comes from this request — from the user — and is
   * never read out of the plan body, so a plan cannot promote itself to a more permissive mode.
   */
  instance.post<{ Params: SessionParams; Body: { projectId?: string; expectedRevision?: number; decision?: string; executionMode?: string; note?: string } }>(
    "/companies/:companyId/code/sessions/:sessionId/plan/decide",
    async (request, reply) => {
      try {
        const { companyId, sessionId } = request.params;
        const ctx = await authorize(request, companyId, CODE_GOAL_ACTIONS.planDecide);
        const body = request.body ?? {};
        if (typeof body.projectId !== "string" || !body.projectId.trim()) throw badRequest("projectId is required", { field: "projectId" });
        const decision = body.decision;
        if (decision !== "approve" && decision !== "reject") throw badRequest("decision must be approve or reject", { field: "decision" });
        const expectedRevision = readExpectedRevision(body.expectedRevision);
        await auditBefore(ctx, {
          action: "code.plan.decide",
          companyId,
          resourceType: "code_session_plan",
          resourceId: sessionId,
          metadata: { decision, expectedRevision, hasExecutionMode: typeof body.executionMode === "string" },
        });

        const decided = await decidePlan(
          {
            getLatestCodeSessionPlan: (id, session) => deps.store.getLatestCodeSessionPlan(id, session),
            decideCodeSessionPlan: (input) => deps.store.decideCodeSessionPlan(input),
            replaceCodeSessionTodos: (input) => deps.store.replaceCodeSessionTodos(input),
          },
          {
            companyId,
            projectId: body.projectId,
            sessionId,
            expectedRevision,
            decision,
            executionMode: body.executionMode,
            note: typeof body.note === "string" ? body.note : null,
            decidedBy: ctx.userId,
          },
        );

        // Applying the mode is reported honestly: without the port the plan is still decided, but the session
        // keeps its previous mode and the response says so instead of implying execution continues elsewhere.
        let modeApplied = false;
        let modeApplyReason: string | null = null;
        if (decision === "approve" && decided.executionMode) {
          if (!deps.applyExecutionMode) {
            modeApplyReason = "session_mode_port_not_configured";
          } else {
            try {
              await deps.applyExecutionMode({
                ctx,
                companyId,
                projectId: body.projectId,
                sessionId,
                mode: decided.executionMode,
              });
              modeApplied = true;
            } catch (error) {
              modeApplyReason = (error as { code?: string } | null)?.code ?? "session_mode_apply_failed";
              deps.logger?.warn({ sessionId, mode: decided.executionMode, error }, "code plan approved but the session mode was not applied");
            }
          }
        }

        return reply.send(withApiVersion({
          status: decision === "approve" ? "approved" : "rejected",
          plan: planView(decided.plan),
          executionMode: decided.executionMode,
          modeApplied,
          ...(modeApplyReason ? { modeApplyReason } : {}),
          todos: decided.todos ? decided.todos.map(todoView) : null,
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
