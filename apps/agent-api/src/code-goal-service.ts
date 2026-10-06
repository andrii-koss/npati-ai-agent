import type {
  CodeGoalCriterionRecord,
  CodeGoalCriterionStatus,
  CodeGoalRecord,
  CodeGoalStatus,
  CodeGoalWithCriteria,
  CodeSessionTodoRecord,
  CreateCodeGoalInput,
  SetCodeGoalCriterionStatusInput,
  UpdateCodeGoalInput,
} from "@npati/workspace";
import { MAX_GOAL_CRITERIA } from "@npati/workspace";

/**
 * C9 goal lifecycle.
 *
 * The rule this module exists to make real: **a goal is not complete because the code was written.** The
 * acceptance criteria are separate records with their own state, and the store refuses a transition to
 * `completed` while any criterion is unverified (`goal_acceptance_unverified`, also enforced by a database
 * trigger). This service never trusts a caller-supplied status for that transition — it recomputes progress
 * from the criteria and the linked todos and lets the store be the last word.
 *
 * `blocked` is a first-class state rather than an error: the agent records what it needs (`question`) and the
 * run can be resumed later (C10) without losing the goal. Two smaller decisions worth naming:
 *
 * - Progress comes from the linked todo list when the goal has one, and from the acceptance criteria otherwise.
 *   Counting todos when they exist keeps "how far along is this" aligned with what the user sees in the
 *   workspace, while criteria remain the completion gate.
 * - Transitions are a table, not a set of ifs, so an illegal jump (`planned → completed`) is refused with the
 *   same structured error everywhere instead of being allowed on one path.
 */

export type CodeGoalServiceErrorCode =
  | "goal_not_found"
  | "goal_criteria_required"
  | "goal_criteria_invalid"
  | "goal_transition_invalid"
  | "goal_question_required"
  | "goal_update_invalid";

export class CodeGoalServiceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: CodeGoalServiceErrorCode,
    message: string,
    readonly httpStatus = 400,
    readonly retryable = false,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CodeGoalServiceError";
    this.details = details;
  }
}

export interface CodeGoalServiceStore {
  createCodeGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria>;
  getCodeGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null>;
  listCodeGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]>;
  updateCodeGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria>;
  setCodeGoalCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria>;
  listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]>;
}

/**
 * Which status may follow which. `completed` is terminal; `failed` may be retried, because a failed attempt
 * is information, not a dead end, and re-opening it keeps the same goal (and its criteria) rather than
 * forcing a new goal that would lose the acceptance criteria the user already agreed to.
 */
export const CODE_GOAL_TRANSITIONS: Readonly<Record<CodeGoalStatus, readonly CodeGoalStatus[]>> = Object.freeze({
  planned: ["running", "blocked", "failed"],
  running: ["verifying", "blocked", "failed"],
  verifying: ["completed", "running", "blocked", "failed"],
  blocked: ["running", "failed"],
  failed: ["running"],
  completed: [],
});

export function assertGoalTransition(from: CodeGoalStatus, to: CodeGoalStatus): void {
  const allowed = CODE_GOAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new CodeGoalServiceError("goal_transition_invalid", `A goal cannot move from ${from} to ${to}`, 409, false, {
      from,
      to,
      allowed,
    });
  }
}

export interface GoalProgress {
  completed: number;
  total: number;
  /** Where the numbers come from, so the UI can explain them instead of guessing. */
  source: "todos" | "criteria";
}

/**
 * Progress is derived, never supplied: a caller cannot report "80% done" and have it stored.
 */
export function computeGoalProgress(
  criteria: readonly CodeGoalCriterionRecord[],
  todos: readonly CodeSessionTodoRecord[],
): GoalProgress {
  if (todos.length > 0) {
    return { completed: todos.filter((todo) => todo.status === "completed").length, total: todos.length, source: "todos" };
  }
  return { completed: criteria.filter((criterion) => criterion.status === "verified").length, total: criteria.length, source: "criteria" };
}

export interface CreateGoalRequest {
  companyId: string;
  projectId: string;
  sessionId?: string | null;
  runId?: string | null;
  objective: unknown;
  constraints?: unknown;
  criteria: unknown;
  createdBy?: string | null;
  now?: Date;
  id?: string;
}

export interface GoalView extends CodeGoalWithCriteria {
  progress: GoalProgress;
}

export async function createGoal(store: CodeGoalServiceStore, request: CreateGoalRequest): Promise<GoalView> {
  const objective = typeof request.objective === "string" ? request.objective.trim() : "";
  if (!objective) throw new CodeGoalServiceError("goal_update_invalid", "A goal needs an objective", 400, false, { field: "objective" });
  const criteria = normalizeCriteria(request.criteria);
  if (criteria.length === 0) {
    // A goal without acceptance criteria can never satisfy "completed only when criteria are verified", so it
    // is refused at creation rather than being born un-completable.
    throw new CodeGoalServiceError("goal_criteria_required", "A goal needs at least one acceptance criterion", 400, false, { field: "criteria" });
  }
  const constraints = Array.isArray(request.constraints)
    ? request.constraints.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  const goal = await store.createCodeGoal({
    companyId: request.companyId,
    projectId: request.projectId,
    sessionId: request.sessionId ?? null,
    runId: request.runId ?? null,
    objective,
    constraints,
    criteria,
    createdBy: request.createdBy ?? null,
    ...(request.now ? { now: request.now } : {}),
    ...(request.id ? { id: request.id } : {}),
  });
  return withProgress(goal, []);
}

export interface ReadGoalRequest {
  companyId: string;
  goalId: string;
}

export async function readGoal(store: CodeGoalServiceStore, request: ReadGoalRequest): Promise<GoalView> {
  const goal = await store.getCodeGoal(request.companyId, request.goalId);
  if (!goal) throw new CodeGoalServiceError("goal_not_found", "Goal not found", 404, false, { goalId: request.goalId });
  const todos = goal.sessionId ? await store.listCodeSessionTodos({ companyId: request.companyId, sessionId: goal.sessionId }) : [];
  return withProgress(goal, todos);
}

export async function listGoals(
  store: CodeGoalServiceStore,
  request: { companyId: string; sessionId?: string; projectId?: string; limit?: number },
): Promise<CodeGoalRecord[]> {
  return store.listCodeGoals(request);
}

export interface TransitionGoalRequest {
  companyId: string;
  goalId: string;
  expectedRevision: number;
  status: CodeGoalStatus;
  /** Required when moving to `blocked`: what the agent needs from the user. */
  question?: string | null;
  blockedReason?: string | null;
  now?: Date;
}

/**
 * The only way a goal's status changes. Refusals happen **before** the write, so a rejected transition leaves
 * the stored goal exactly as it was.
 */
export async function transitionGoal(store: CodeGoalServiceStore, request: TransitionGoalRequest): Promise<GoalView> {
  const goal = await store.getCodeGoal(request.companyId, request.goalId);
  if (!goal) throw new CodeGoalServiceError("goal_not_found", "Goal not found", 404, false, { goalId: request.goalId });
  assertGoalTransition(goal.status, request.status);

  const question = typeof request.question === "string" ? request.question.trim() : "";
  if (request.status === "blocked" && !question) {
    throw new CodeGoalServiceError(
      "goal_question_required",
      "Blocking a goal requires the question the agent needs answered",
      400,
      false,
      { field: "question" },
    );
  }

  const todos = goal.sessionId ? await store.listCodeSessionTodos({ companyId: request.companyId, sessionId: goal.sessionId }) : [];
  const progress = computeGoalProgress(goal.criteria, todos);

  const updated = await store.updateCodeGoal({
    companyId: request.companyId,
    goalId: request.goalId,
    expectedRevision: request.expectedRevision,
    status: request.status,
    // Leaving `blocked` clears the question: an answered question is not a standing request, and keeping it
    // would make the workspace show a stale prompt forever.
    question: request.status === "blocked" ? question : null,
    blockedReason: request.status === "blocked" ? (request.blockedReason ?? null) : null,
    progressCompleted: progress.completed,
    progressTotal: progress.total,
    ...(request.now ? { now: request.now } : {}),
  });
  return withProgress(updated, todos);
}

export interface SetCriterionRequest {
  companyId: string;
  goalId: string;
  criterionId: string;
  status: CodeGoalCriterionStatus;
  evidence?: string | null;
  verifiedBy?: string | null;
  now?: Date;
}

/**
 * Verifying a criterion is the only path to completion. The store refuses to *un*-verify a criterion of a
 * completed goal, so a finished goal cannot be quietly downgraded after the fact.
 */
export async function setCriterionStatus(store: CodeGoalServiceStore, request: SetCriterionRequest): Promise<GoalView> {
  if (!["pending", "verified", "failed"].includes(request.status)) {
    throw new CodeGoalServiceError("goal_criteria_invalid", `Unknown criterion status: ${String(request.status)}`, 400, false, { field: "status" });
  }
  const updated = await store.setCodeGoalCriterionStatus({
    companyId: request.companyId,
    goalId: request.goalId,
    criterionId: request.criterionId,
    status: request.status,
    evidence: request.evidence ?? null,
    verifiedBy: request.verifiedBy ?? null,
    ...(request.now ? { now: request.now } : {}),
  });
  const todos = updated.sessionId ? await store.listCodeSessionTodos({ companyId: request.companyId, sessionId: updated.sessionId }) : [];
  return withProgress(updated, todos);
}

function withProgress(goal: CodeGoalWithCriteria, todos: readonly CodeSessionTodoRecord[]): GoalView {
  return { ...goal, progress: computeGoalProgress(goal.criteria, todos) };
}

function normalizeCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const criteria = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (criteria.length > MAX_GOAL_CRITERIA) {
    throw new CodeGoalServiceError("goal_criteria_invalid", "Too many acceptance criteria", 400, false, {
      count: criteria.length,
      limit: MAX_GOAL_CRITERIA,
    });
  }
  return criteria;
}
