import {
  canonicalJson,
  sha256,
  validatePlanBody,
  validateTodoTasks,
  type CodePlanBody,
  type CodeSessionPlanRecord,
  type CodeSessionTodoRecord,
  type CodeSessionTodoStatus,
  type DataClassification,
  type ReplaceCodeSessionTodosInput,
  type RetentionClass,
} from "@npati/workspace";

/**
 * C9 planning tools: `code.plan.propose` and `code.plan.update`.
 *
 * Both tools change **session metadata** (a plan draft, the todo list) and never the workspace. That is what
 * makes them read-only for policy purposes, and it is also why they must be **idempotent**: C6a recovery
 * repeats read-only tool calls after a crash, so a repeated call must not create a second plan revision or a
 * duplicated todo list. Idempotency is structural here rather than best-effort:
 *
 * - `code.plan.propose` de-duplicates by content hash against the current **draft**: proposing the same plan
 *   twice returns the same revision instead of appending one. A new revision is only created when the content
 *   actually differs, or when the previous revision was already decided (a draft that follows an approved plan
 *   is a genuinely new proposal).
 * - `code.plan.update` replaces the whole list, and a call whose canonical list equals the stored one is a
 *   no-op. Sending the complete list every time is the contract from the tool schema, so a repeat cannot
 *   duplicate tasks.
 *
 * A plan is **data**: the tool input carries no execution mode, the stored body type has no field for one, and
 * `validatePlanBody` keeps only `files`/`steps`/`risks`/`testStrategy`. The mode a plan is executed in is
 * chosen by the user when they approve a revision (see `code-plan-mode.ts`), never read out of the plan — the
 * same boundary that keeps repository instructions from becoming policy in C8.
 */

/** Structured refusal codes this module can produce; the tool layer maps them onto `CodeToolError`. */
export type CodePlanToolErrorCode =
  | "plan_body_invalid"
  | "todo_list_invalid"
  | "session_missing";

export class CodePlanToolError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: CodePlanToolErrorCode,
    message: string,
    readonly httpStatus = 400,
    readonly retryable = false,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CodePlanToolError";
    this.details = details;
  }
}

/** The slice of the workspace store these tools need; narrow on purpose so tests inject exactly this. */
export interface CodePlanToolStore {
  getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null>;
  createCodeSessionPlan(input: {
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
  }): Promise<CodeSessionPlanRecord>;
  listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]>;
  replaceCodeSessionTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]>;
}

/** Canonical hash of a plan body: key order and formatting can never change it. */
export function planContentHash(plan: CodePlanBody): string {
  return sha256(canonicalJson({ files: plan.files, steps: plan.steps, risks: plan.risks, testStrategy: plan.testStrategy }));
}

/** Canonical hash of a todo list: order-independent, so reordering alone is not a "change" to dedupe on. */
export function todoListHash(tasks: readonly { taskId: string; content: string; status: CodeSessionTodoStatus }[]): string {
  const parts = tasks
    .map((task) => `${task.taskId}:${task.status}:${task.content}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(parts.join("\n"));
}

export interface ProposePlanRequest {
  companyId: string;
  projectId: string;
  sessionId: string;
  runId?: string | null;
  /** Raw tool arguments: validated here, never trusted. */
  plan: unknown;
  createdBy?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface ProposePlanResult {
  planId: string;
  planRevision: number;
  status: string;
  steps: number;
  files: number;
  /** True when an identical draft already existed and nothing was written. */
  deduplicated: boolean;
}

export async function proposePlan(store: CodePlanToolStore, request: ProposePlanRequest): Promise<ProposePlanResult> {
  if (!request.sessionId) throw new CodePlanToolError("session_missing", "A plan needs a session", 400, false, { field: "sessionId" });
  let plan: CodePlanBody;
  try {
    plan = validatePlanBody(request.plan);
  } catch (error) {
    // The validator's message is the reason; the code stays in this module's vocabulary so callers do not
    // have to know the store's error classes.
    throw new CodePlanToolError("plan_body_invalid", (error as Error).message, 400, false, {
      limit: (error as { details?: Record<string, unknown> }).details ?? {},
    });
  }

  const hash = planContentHash(plan);
  const latest = await store.getLatestCodeSessionPlan(request.companyId, request.sessionId);
  if (latest && latest.status === "draft" && planContentHash(latest.plan) === hash) {
    // Same content, still an undecided draft: returning the existing revision keeps a repeated tool call
    // (C6a recovery replays read-only calls) from appending a duplicate revision.
    return {
      planId: latest.id,
      planRevision: latest.revision,
      status: latest.status,
      steps: latest.plan.steps.length,
      files: latest.plan.files.length,
      deduplicated: true,
    };
  }

  const created = await store.createCodeSessionPlan({
    companyId: request.companyId,
    projectId: request.projectId,
    sessionId: request.sessionId,
    runId: request.runId ?? null,
    plan,
    createdBy: request.createdBy ?? null,
    ...(request.dataClassification ? { dataClassification: request.dataClassification } : {}),
    ...(request.retentionClass ? { retentionClass: request.retentionClass } : {}),
    ...(request.now ? { now: request.now } : {}),
    ...(request.id ? { id: request.id } : {}),
  });
  return {
    planId: created.id,
    planRevision: created.revision,
    status: created.status,
    steps: plan.steps.length,
    files: plan.files.length,
    deduplicated: false,
  };
}

export interface UpdateTodosRequest {
  companyId: string;
  projectId: string;
  sessionId: string;
  goalId?: string | null;
  /** Raw tool arguments: validated here, never trusted. */
  tasks: unknown;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
}

export interface UpdateTodosResult {
  tasks: number;
  pending: number;
  inProgress: number;
  completed: number;
  /** True when the stored list already matched and nothing was written. */
  deduplicated: boolean;
}

export async function updateSessionTodos(store: CodePlanToolStore, request: UpdateTodosRequest): Promise<UpdateTodosResult> {
  if (!request.sessionId) throw new CodePlanToolError("session_missing", "A todo list needs a session", 400, false, { field: "sessionId" });
  let tasks: ReplaceCodeSessionTodosInput["tasks"];
  try {
    tasks = validateTodoTasks(request.tasks as ReplaceCodeSessionTodosInput["tasks"]);
  } catch (error) {
    throw new CodePlanToolError("todo_list_invalid", (error as Error).message, 400, false, {
      reason: (error as { details?: Record<string, unknown> }).details ?? {},
    });
  }

  const current = await store.listCodeSessionTodos({ companyId: request.companyId, sessionId: request.sessionId });
  const currentHash = todoListHash(current);
  const incomingHash = todoListHash(tasks);
  if (current.length > 0 && currentHash === incomingHash) {
    return { ...countTodos(tasks), deduplicated: true };
  }

  const stored = await store.replaceCodeSessionTodos({
    companyId: request.companyId,
    projectId: request.projectId,
    sessionId: request.sessionId,
    goalId: request.goalId ?? null,
    tasks,
    ...(request.dataClassification ? { dataClassification: request.dataClassification } : {}),
    ...(request.retentionClass ? { retentionClass: request.retentionClass } : {}),
    ...(request.now ? { now: request.now } : {}),
  });
  return { ...countTodos(stored), deduplicated: false };
}

function countTodos(tasks: readonly { status: CodeSessionTodoStatus }[]): { tasks: number; pending: number; inProgress: number; completed: number } {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const task of tasks) {
    if (task.status === "pending") pending += 1;
    else if (task.status === "in_progress") inProgress += 1;
    else completed += 1;
  }
  return { tasks: tasks.length, pending, inProgress, completed };
}

/**
 * Plan steps become the session todo list when the user approves a revision. Every task starts `pending`:
 * nothing has been started at approval time, and starting one would be a claim the run has not made yet.
 */
export function planToTodoTasks(plan: CodePlanBody, sessionId: string): ReplaceCodeSessionTodosInput["tasks"] {
  return plan.steps.map((step, index) => ({
    // Stable ids derived from the session and the step position, so a re-approval cannot produce duplicates
    // for the same plan and the id is reproducible in a replay.
    taskId: `${sessionId}:plan:${index + 1}`,
    content: step,
    status: "pending" as CodeSessionTodoStatus,
  }));
}
