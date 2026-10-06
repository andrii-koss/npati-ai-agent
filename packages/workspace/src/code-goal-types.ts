import type { DataClassification, RetentionClass } from "./types";

/**
 * C9 types: goals, plan revisions and session todos.
 *
 * They live in their own module so `types.ts` only gains an import and the store methods, which keeps that
 * (already large) file readable. Nothing here imports `types.ts` values, so there is no cycle: only the two
 * classification unions are shared.
 */

export const CODE_GOAL_STATUSES = ["planned", "running", "blocked", "verifying", "completed", "failed"] as const;
export type CodeGoalStatus = (typeof CODE_GOAL_STATUSES)[number];

export const CODE_GOAL_CRITERION_STATUSES = ["pending", "verified", "failed"] as const;
export type CodeGoalCriterionStatus = (typeof CODE_GOAL_CRITERION_STATUSES)[number];

export const CODE_SESSION_PLAN_STATUSES = ["draft", "approved", "rejected", "superseded"] as const;
export type CodeSessionPlanStatus = (typeof CODE_SESSION_PLAN_STATUSES)[number];

export const CODE_SESSION_TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type CodeSessionTodoStatus = (typeof CODE_SESSION_TODO_STATUSES)[number];

/** The modes a plan may be executed in. Canonical C5 vocabulary; nothing else is accepted. */
export const CODE_PLAN_EXECUTION_MODES = ["plan", "ask", "auto_edit", "full_auto_sandbox"] as const;
export type CodePlanExecutionMode = (typeof CODE_PLAN_EXECUTION_MODES)[number];

export function isCodePlanExecutionMode(value: unknown): value is CodePlanExecutionMode {
  return typeof value === "string" && (CODE_PLAN_EXECUTION_MODES as readonly string[]).includes(value);
}

/**
 * The structured plan the agent produces in `plan` mode. Stored as data: nothing in this shape is ever read as
 * configuration, and in particular it cannot carry a session mode (that is a separate column decided by the
 * user, see `code-plan-mode.ts`).
 */
export interface CodePlanBody {
  /** Files the plan expects to touch, so the reviewer can see the blast radius before approving. */
  files: string[];
  /** Ordered steps. They become the session todo list when the plan is approved. */
  steps: string[];
  /** Risks the agent identified. Free text, reviewed by a human. */
  risks: string[];
  /** How the change will be tested. */
  testStrategy: string;
}

export interface CodeSessionPlanRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string | null;
  revision: number;
  status: CodeSessionPlanStatus;
  plan: CodePlanBody;
  executionMode: CodePlanExecutionMode | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

export interface CreateCodeSessionPlanInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  runId?: string | null;
  plan: CodePlanBody;
  createdBy?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface DecideCodeSessionPlanInput {
  companyId: string;
  sessionId: string;
  /** The revision the caller believes is current; a stale value is refused instead of overwriting a decision. */
  expectedRevision: number;
  decision: "approve" | "reject";
  /** Required for `approve`: the mode the user chose. Never taken from the plan body. */
  executionMode?: CodePlanExecutionMode;
  note?: string | null;
  decidedBy?: string | null;
  now?: Date;
}

export interface CodeGoalCriterionRecord {
  id: string;
  goalId: string;
  companyId: string;
  position: number;
  criterion: string;
  status: CodeGoalCriterionStatus;
  evidence: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
}

export interface CodeGoalRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string | null;
  runId: string | null;
  objective: string;
  constraints: string[];
  status: CodeGoalStatus;
  blockedReason: string | null;
  /** What the agent needs from the user while `blocked` (asked through the existing user-question path). */
  question: string | null;
  progressCompleted: number;
  progressTotal: number;
  revision: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

export interface CodeGoalWithCriteria extends CodeGoalRecord {
  criteria: CodeGoalCriterionRecord[];
}

export interface CreateCodeGoalInput {
  companyId: string;
  projectId: string;
  sessionId?: string | null;
  runId?: string | null;
  objective: string;
  constraints?: string[];
  criteria: string[];
  createdBy?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
  criteriaIds?: string[];
}

export interface UpdateCodeGoalInput {
  companyId: string;
  goalId: string;
  expectedRevision: number;
  status?: CodeGoalStatus;
  blockedReason?: string | null;
  question?: string | null;
  progressCompleted?: number;
  progressTotal?: number;
  now?: Date;
}

export interface SetCodeGoalCriterionStatusInput {
  companyId: string;
  goalId: string;
  criterionId: string;
  status: CodeGoalCriterionStatus;
  evidence?: string | null;
  verifiedBy?: string | null;
  now?: Date;
}

export interface CodeSessionTodoRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  goalId: string | null;
  taskId: string;
  content: string;
  status: CodeSessionTodoStatus;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

export interface ReplaceCodeSessionTodosInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  goalId?: string | null;
  tasks: Array<{ taskId: string; content: string; status: CodeSessionTodoStatus }>;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  idFactory?: (index: number) => string;
}

/**
 * Raised by `updateCodeGoal` when a caller tries to complete a goal whose acceptance criteria are not all
 * verified, and by `createCodeGoal` when a goal is created with no criteria at all. The database enforces the
 * same rule with a trigger; this error exists so the model and the user get a structured reason instead of a
 * constraint violation.
 */
export class CodeGoalAcceptanceUnverifiedError extends Error {
  readonly code = "goal_acceptance_unverified";
  readonly httpStatus = 409;
  readonly retryable = false;
  readonly details: Record<string, unknown>;

  constructor(details: Record<string, unknown> = {}) {
    super("Goal cannot be completed while acceptance criteria are unverified");
    this.name = "CodeGoalAcceptanceUnverifiedError";
    this.details = details;
  }
}

/** Raised when a plan revision the caller expected is no longer current. */
export class CodeSessionPlanRevisionConflictError extends Error {
  readonly code = "plan_revision_conflict";
  readonly httpStatus = 409;
  readonly retryable = true;
  readonly details: Record<string, unknown>;

  constructor(details: Record<string, unknown> = {}) {
    super("Plan revision conflict");
    this.name = "CodeSessionPlanRevisionConflictError";
    this.details = details;
  }
}

/** Raised when a todo list would contain more than one `in_progress` task. */
export class CodeSessionTodosInvalidError extends Error {
  readonly code = "session_todos_invalid";
  readonly httpStatus = 400;
  readonly retryable = false;
  readonly details: Record<string, unknown>;

  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(reason);
    this.name = "CodeSessionTodosInvalidError";
    this.details = { reason, ...details };
  }
}
