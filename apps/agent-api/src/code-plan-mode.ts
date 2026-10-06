import {
  isCodePlanExecutionMode,
  type CodePlanExecutionMode,
  type CodeSessionPlanRecord,
  type CodeSessionTodoRecord,
  type DecideCodeSessionPlanInput,
  type ReplaceCodeSessionTodosInput,
} from "@npati/workspace";
import { planToTodoTasks } from "./code-plan-tool";

/**
 * C9 plan mode: a plan is a **draft produced by the model**, and only the user's decision turns it into work.
 *
 * The one property this module exists to guarantee: **the plan cannot choose the mode it is executed in.** The
 * approved mode comes from the decision request (i.e. from the user), is validated against the canonical C5
 * vocabulary, and is stored on the *decision* (`executionMode` on the plan record) — never read out of the
 * plan body. That is the same boundary C8 draws for repository instructions: model-produced text is data, and
 * data does not raise permissions. A plan body that carries an `executionMode` key is dropped by
 * `validatePlanBody` before it is ever stored, and this module reads the mode only from its own request.
 *
 * Approving a revision materialises the plan's steps as the session todo list (all `pending`: nothing has
 * started yet). Rejecting changes nothing but the decision, so a rejected plan leaves the workspace untouched.
 */

export type CodePlanModeErrorCode =
  | "plan_not_found"
  | "plan_already_decided"
  | "plan_revision_conflict"
  | "plan_execution_mode_required"
  | "plan_execution_mode_invalid"
  | "plan_decision_invalid";

export class CodePlanModeError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: CodePlanModeErrorCode,
    message: string,
    readonly httpStatus = 400,
    readonly retryable = false,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CodePlanModeError";
    this.details = details;
  }
}

export interface CodePlanModeStore {
  getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null>;
  decideCodeSessionPlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord>;
  replaceCodeSessionTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]>;
}

export interface DecidePlanRequest {
  companyId: string;
  projectId: string;
  sessionId: string;
  /** The revision the user saw; a stale value is refused instead of deciding something they did not read. */
  expectedRevision: number;
  decision: "approve" | "reject";
  /** Required to approve. Comes from the request (the user), never from the plan body. */
  executionMode?: unknown;
  note?: string | null;
  decidedBy?: string | null;
  dataClassification?: ReplaceCodeSessionTodosInput["dataClassification"];
  retentionClass?: ReplaceCodeSessionTodosInput["retentionClass"];
  now?: Date;
}

export interface DecidePlanResult {
  plan: CodeSessionPlanRecord;
  /** The mode the user approved, or `null` for a rejection. Never derived from the plan. */
  executionMode: CodePlanExecutionMode | null;
  todos: CodeSessionTodoRecord[] | null;
}

/**
 * The only reader of the execution mode. Exported so the guarantee is testable in isolation: it takes the
 * request value, validates it, and has no access to the plan body at all.
 */
export function resolveApprovedExecutionMode(decision: "approve" | "reject", value: unknown): CodePlanExecutionMode {
  if (decision !== "approve") throw new CodePlanModeError("plan_decision_invalid", "executionMode is only valid for an approval");
  if (value === undefined || value === null || value === "") {
    throw new CodePlanModeError(
      "plan_execution_mode_required",
      "Approving a plan requires the execution mode chosen by the user",
      400,
      false,
      { field: "executionMode" },
    );
  }
  if (!isCodePlanExecutionMode(value)) {
    throw new CodePlanModeError("plan_execution_mode_invalid", `Unknown execution mode: ${String(value)}`, 400, false, { field: "executionMode" });
  }
  return value;
}

export async function decidePlan(store: CodePlanModeStore, request: DecidePlanRequest): Promise<DecidePlanResult> {
  if (request.decision !== "approve" && request.decision !== "reject") {
    throw new CodePlanModeError("plan_decision_invalid", `Unknown decision: ${String(request.decision)}`, 400, false, { field: "decision" });
  }

  const latest = await store.getLatestCodeSessionPlan(request.companyId, request.sessionId);
  if (!latest) {
    throw new CodePlanModeError("plan_not_found", "This session has no plan to decide", 404, false, { sessionId: request.sessionId });
  }
  if (latest.status !== "draft") {
    // A decided revision is history: deciding it again would rewrite what the user already approved.
    throw new CodePlanModeError("plan_already_decided", `Plan revision ${latest.revision} is already ${latest.status}`, 409, false, {
      planRevision: latest.revision,
      status: latest.status,
    });
  }
  if (latest.revision !== request.expectedRevision) {
    throw new CodePlanModeError("plan_revision_conflict", "The plan changed since it was read", 409, true, {
      expectedRevision: request.expectedRevision,
      currentRevision: latest.revision,
    });
  }

  if (request.decision === "reject") {
    const decided = await store.decideCodeSessionPlan({
      companyId: request.companyId,
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      decision: "reject",
      note: request.note ?? null,
      decidedBy: request.decidedBy ?? null,
      ...(request.now ? { now: request.now } : {}),
    });
    return { plan: decided, executionMode: null, todos: null };
  }

  const executionMode = resolveApprovedExecutionMode("approve", request.executionMode);
  const decided = await store.decideCodeSessionPlan({
    companyId: request.companyId,
    sessionId: request.sessionId,
    expectedRevision: request.expectedRevision,
    decision: "approve",
    executionMode,
    note: request.note ?? null,
    decidedBy: request.decidedBy ?? null,
    ...(request.now ? { now: request.now } : {}),
  });
  const todos = await store.replaceCodeSessionTodos({
    companyId: request.companyId,
    projectId: request.projectId,
    sessionId: request.sessionId,
    goalId: null,
    tasks: planToTodoTasks(decided.plan, request.sessionId),
    ...(request.dataClassification ? { dataClassification: request.dataClassification } : {}),
    ...(request.retentionClass ? { retentionClass: request.retentionClass } : {}),
    ...(request.now ? { now: request.now } : {}),
  });
  return { plan: decided, executionMode, todos };
}
