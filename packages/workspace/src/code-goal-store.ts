import { randomUUID } from "node:crypto";
import {
  CODE_GOAL_STATUSES,
  CODE_SESSION_PLAN_STATUSES,
  CODE_SESSION_TODO_STATUSES,
  CodeGoalAcceptanceUnverifiedError,
  CodeSessionPlanRevisionConflictError,
  CodeSessionTodosInvalidError,
  isCodePlanExecutionMode,
  type CodeGoalCriterionRecord,
  type CodeGoalCriterionStatus,
  type CodeGoalRecord,
  type CodeGoalStatus,
  type CodeGoalWithCriteria,
  type CodePlanBody,
  type CodeSessionPlanRecord,
  type CodeSessionTodoRecord,
  type CodeSessionTodoStatus,
  type CreateCodeGoalInput,
  type CreateCodeSessionPlanInput,
  type DecideCodeSessionPlanInput,
  type ReplaceCodeSessionTodosInput,
  type SetCodeGoalCriterionStatusInput,
  type UpdateCodeGoalInput,
} from "./code-goal-types";
import { DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS } from "./types";

/**
 * C9 store logic for goals, plan revisions and session todos.
 *
 * Both backends live here on purpose. The rules that matter — a goal cannot be completed with unverified
 * criteria, a plan is revisioned and only one revision is approved, a todo list has at most one `in_progress`
 * task — must be *identical* in the Postgres store and the in-memory store, and the surest way to keep them
 * identical is to write them once and have each backend only supply persistence. The database additionally
 * enforces the first and third rules with triggers and partial unique indexes (migration 080), so a direct SQL
 * write cannot bypass them either.
 */

/** Structural view of a `pg` pool: only what these queries need, so this module never imports `pg`. */
export interface CodeGoalQueryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export const MAX_GOAL_CRITERIA = 50;
export const MAX_PLAN_STEPS = 100;
export const MAX_PLAN_FILES = 200;
export const MAX_TODO_TASKS = 100;

function assertGoalStatus(value: unknown): asserts value is CodeGoalStatus {
  if (typeof value !== "string" || !(CODE_GOAL_STATUSES as readonly string[]).includes(value)) {
    throw new CodeSessionTodosInvalidError("Unknown goal status", { status: value });
  }
}

function assertCriterionStatus(value: unknown): asserts value is CodeGoalCriterionStatus {
  if (value !== "pending" && value !== "verified" && value !== "failed") {
    throw new CodeSessionTodosInvalidError("Unknown goal criterion status", { status: value });
  }
}

function assertTodoStatus(value: unknown): asserts value is CodeSessionTodoStatus {
  if (typeof value !== "string" || !(CODE_SESSION_TODO_STATUSES as readonly string[]).includes(value)) {
    throw new CodeSessionTodosInvalidError("Unknown todo status", { status: value });
  }
}

/**
 * The plan body is data. It is validated for shape only — never interpreted as configuration. Refusing a
 * malformed body is better than storing something the UI cannot render.
 */
export function validatePlanBody(plan: unknown): CodePlanBody {
  if (plan === null || typeof plan !== "object") {
    throw new CodeSessionTodosInvalidError("Plan body must be an object", {});
  }
  const candidate = plan as Partial<CodePlanBody>;
  const files = Array.isArray(candidate.files) ? candidate.files : [];
  const steps = Array.isArray(candidate.steps) ? candidate.steps : [];
  const risks = Array.isArray(candidate.risks) ? candidate.risks : [];
  if (steps.length === 0) throw new CodeSessionTodosInvalidError("Plan must contain at least one step", {});
  if (files.length > MAX_PLAN_FILES) throw new CodeSessionTodosInvalidError("Plan lists too many files", { count: files.length, limit: MAX_PLAN_FILES });
  if (steps.length > MAX_PLAN_STEPS) throw new CodeSessionTodosInvalidError("Plan has too many steps", { count: steps.length, limit: MAX_PLAN_STEPS });
  const asStrings = (values: unknown[], label: string): string[] =>
    values.map((value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new CodeSessionTodosInvalidError(`Plan ${label} must be non-empty strings`, {});
      }
      return value;
    });
  return {
    files: asStrings(files, "files"),
    steps: asStrings(steps, "steps"),
    risks: asStrings(risks, "risks"),
    testStrategy: typeof candidate.testStrategy === "string" ? candidate.testStrategy : "",
  };
}

/** The one structural todo rule, applied by both backends' callers before anything is written. */
export function validateTodoTasks(tasks: ReplaceCodeSessionTodosInput["tasks"]): ReplaceCodeSessionTodosInput["tasks"] {
  if (!Array.isArray(tasks)) throw new CodeSessionTodosInvalidError("Todo tasks must be an array", {});
  if (tasks.length > MAX_TODO_TASKS) throw new CodeSessionTodosInvalidError("Too many todo tasks", { count: tasks.length, limit: MAX_TODO_TASKS });
  const seen = new Set<string>();
  let inProgress = 0;
  for (const task of tasks) {
    if (typeof task?.taskId !== "string" || task.taskId.trim().length === 0) {
      throw new CodeSessionTodosInvalidError("Todo task is missing taskId", {});
    }
    if (typeof task.content !== "string" || task.content.trim().length === 0) {
      throw new CodeSessionTodosInvalidError("Todo task is missing content", { taskId: task.taskId });
    }
    assertTodoStatus(task.status);
    if (seen.has(task.taskId)) throw new CodeSessionTodosInvalidError("Duplicate taskId in todo list", { taskId: task.taskId });
    seen.add(task.taskId);
    if (task.status === "in_progress") inProgress += 1;
  }
  // Refused, not normalised: silently demoting a second task to `pending` would hide that the model produced
  // an inconsistent plan, and the model would keep believing both tasks are running.
  if (inProgress > 1) {
    throw new CodeSessionTodosInvalidError("At most one todo task may be in_progress", { inProgress });
  }
  return tasks;
}

function criteriaOf(goalId: string, criteria: CodeGoalCriterionRecord[]): CodeGoalCriterionRecord[] {
  return criteria.filter((criterion) => criterion.goalId === goalId).sort((a, b) => a.position - b.position);
}

function withCriteria(goal: CodeGoalRecord, criteria: CodeGoalCriterionRecord[]): CodeGoalWithCriteria {
  return { ...goal, criteria: criteriaOf(goal.id, criteria) };
}

/** The completion rule in one place, so both backends and the trigger agree on what it means. */
export function assertGoalCompletable(goalId: string, status: CodeGoalStatus, criteria: CodeGoalCriterionRecord[]): void {
  if (status !== "completed") return;
  const own = criteriaOf(goalId, criteria);
  if (own.length === 0) {
    throw new CodeGoalAcceptanceUnverifiedError({ goalId, criteria: 0, reason: "no_acceptance_criteria" });
  }
  const unverified = own.filter((criterion) => criterion.status !== "verified");
  if (unverified.length > 0) {
    throw new CodeGoalAcceptanceUnverifiedError({
      goalId,
      criteria: own.length,
      unverified: unverified.length,
      unverifiedIds: unverified.map((criterion) => criterion.id),
    });
  }
}

// --- Postgres backend ---------------------------------------------------------------------------------

const GOAL_COLUMNS = `id, company_id, project_id, session_id, run_id, objective, constraints, status,
  blocked_reason, question, progress_completed, progress_total, revision, created_by, created_at, updated_at,
  data_classification, retention_class`;

const PLAN_COLUMNS = `id, company_id, project_id, session_id, run_id, revision, status, plan, execution_mode,
  decision_note, decided_by, decided_at, created_by, created_at, data_classification, retention_class`;

const TODO_COLUMNS = `id, company_id, project_id, session_id, goal_id, task_id, content, status, position,
  created_at, updated_at, data_classification, retention_class`;

interface GoalRow {
  id: string; company_id: string; project_id: string; session_id: string | null; run_id: string | null;
  objective: string; constraints: unknown; status: string; blocked_reason: string | null; question: string | null;
  progress_completed: number; progress_total: number; revision: number; created_by: string | null;
  created_at: Date; updated_at: Date; data_classification: string; retention_class: string;
}

interface CriterionRow {
  id: string; goal_id: string; company_id: string; position: number; criterion: string; status: string;
  evidence: string | null; verified_by: string | null; verified_at: Date | null;
}

function toGoal(row: GoalRow): CodeGoalRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    objective: row.objective,
    constraints: Array.isArray(row.constraints) ? (row.constraints as string[]) : [],
    status: row.status as CodeGoalStatus,
    blockedReason: row.blocked_reason,
    question: row.question,
    progressCompleted: row.progress_completed,
    progressTotal: row.progress_total,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dataClassification: row.data_classification as CodeGoalRecord["dataClassification"],
    retentionClass: row.retention_class as CodeGoalRecord["retentionClass"],
  };
}

function toCriterion(row: CriterionRow): CodeGoalCriterionRecord {
  return {
    id: row.id,
    goalId: row.goal_id,
    companyId: row.company_id,
    position: row.position,
    criterion: row.criterion,
    status: row.status as CodeGoalCriterionStatus,
    evidence: row.evidence,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
  };
}

export class PostgresCodeGoalStore {
  constructor(private readonly pool: CodeGoalQueryable) {}

  private async criteriaFor(companyId: string, goalId: string): Promise<CodeGoalCriterionRecord[]> {
    const result = await this.pool.query<CriterionRow>(
      `SELECT id, goal_id, company_id, position, criterion, status, evidence, verified_by, verified_at
         FROM code_goal_criteria WHERE company_id=$1 AND goal_id=$2 ORDER BY position ASC`,
      [companyId, goalId],
    );
    return result.rows.map(toCriterion);
  }

  private async loaded(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> {
    const result = await this.pool.query<GoalRow>(
      `SELECT ${GOAL_COLUMNS} FROM code_goals WHERE company_id=$1 AND id=$2`, [companyId, goalId]);
    const row = result.rows[0];
    if (!row) return null;
    return withCriteria(toGoal(row), await this.criteriaFor(companyId, goalId));
  }

  async createGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
      throw new CodeGoalAcceptanceUnverifiedError({ reason: "no_acceptance_criteria" });
    }
    if (input.criteria.length > MAX_GOAL_CRITERIA) {
      throw new CodeSessionTodosInvalidError("Too many acceptance criteria", { count: input.criteria.length, limit: MAX_GOAL_CRITERIA });
    }
    const now = input.now ?? new Date();
    const goalId = input.id ?? randomUUID();
    await this.pool.query(
      `INSERT INTO code_goals (id, company_id, project_id, session_id, run_id, objective, constraints, status,
         progress_completed, progress_total, revision, created_by, created_at, updated_at,
         data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'planned',0,$8,1,$9,$10,$10,$11,$12)`,
      [goalId, input.companyId, input.projectId, input.sessionId ?? null, input.runId ?? null, input.objective,
        JSON.stringify(input.constraints ?? []), input.criteria.length, input.createdBy ?? null, now,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION, input.retentionClass ?? DEFAULT_RETENTION_CLASS],
    );
    for (let index = 0; index < input.criteria.length; index += 1) {
      await this.pool.query(
        `INSERT INTO code_goal_criteria (id, goal_id, company_id, position, criterion, status)
         VALUES ($1,$2,$3,$4,$5,'pending')`,
        [input.criteriaIds?.[index] ?? randomUUID(), goalId, input.companyId, index, input.criteria[index]],
      );
    }
    const created = await this.loaded(input.companyId, goalId);
    if (!created) throw new CodeSessionTodosInvalidError("Goal was not persisted", { goalId });
    return created;
  }

  async getGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> {
    return this.loaded(companyId, goalId);
  }

  async listGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const clauses = ["company_id=$1"];
    const values: unknown[] = [input.companyId];
    if (input.sessionId) { values.push(input.sessionId); clauses.push(`session_id=$${values.length}`); }
    if (input.projectId) { values.push(input.projectId); clauses.push(`project_id=$${values.length}`); }
    values.push(limit);
    const result = await this.pool.query<GoalRow>(
      `SELECT ${GOAL_COLUMNS} FROM code_goals WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC LIMIT $${values.length}`, values);
    return result.rows.map(toGoal);
  }

  async updateGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    const existing = await this.loaded(input.companyId, input.goalId);
    if (!existing) throw new CodeSessionTodosInvalidError("Goal not found", { goalId: input.goalId });
    if (existing.revision !== input.expectedRevision) {
      throw new CodeSessionPlanRevisionConflictError({ expected: input.expectedRevision, actual: existing.revision });
    }
    const status = input.status ?? existing.status;
    assertGoalStatus(status);
    assertGoalCompletable(input.goalId, status, existing.criteria);
    const now = input.now ?? new Date();
    const progressTotal = input.progressTotal ?? existing.progressTotal;
    // Progress is derived when the caller does not supply it, so "progress" cannot drift from the todo list.
    const completed = input.progressCompleted
      ?? Math.min(existing.criteria.filter((criterion) => criterion.status === "verified").length, progressTotal || existing.criteria.length);
    await this.pool.query(
      `UPDATE code_goals SET status=$3, blocked_reason=$4, question=$5, progress_completed=$6,
         progress_total=$7, revision=revision+1, updated_at=$8
       WHERE company_id=$1 AND id=$2 AND revision=$9`,
      [input.companyId, input.goalId, status, input.blockedReason ?? null, input.question ?? null,
        completed, progressTotal, now, input.expectedRevision],
    );
    const updated = await this.loaded(input.companyId, input.goalId);
    if (!updated) throw new CodeSessionTodosInvalidError("Goal not found after update", { goalId: input.goalId });
    return updated;
  }

  async setCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria> {
    assertCriterionStatus(input.status);
    const goal = await this.loaded(input.companyId, input.goalId);
    if (!goal) throw new CodeSessionTodosInvalidError("Goal not found", { goalId: input.goalId });
    if (!goal.criteria.some((criterion) => criterion.id === input.criterionId)) {
      throw new CodeSessionTodosInvalidError("Criterion does not belong to this goal", { criterionId: input.criterionId });
    }
    // The reverse hole the migration also closes: a completed goal cannot have a criterion un-verified later.
    if (goal.status === "completed" && input.status !== "verified") {
      throw new CodeGoalAcceptanceUnverifiedError({ goalId: input.goalId, criterionId: input.criterionId, reason: "completed_goal_criterion_immutable" });
    }
    const now = input.now ?? new Date();
    await this.pool.query(
      `UPDATE code_goal_criteria SET status=$4, evidence=$5, verified_by=$6, verified_at=$7
        WHERE company_id=$1 AND goal_id=$2 AND id=$3`,
      [input.companyId, input.goalId, input.criterionId, input.status, input.evidence ?? null,
        input.verifiedBy ?? null, input.status === "verified" ? now : null],
    );
    const updated = await this.loaded(input.companyId, input.goalId);
    if (!updated) throw new CodeSessionTodosInvalidError("Goal not found after criterion update", { goalId: input.goalId });
    return updated;
  }

  private async nextPlanRevision(companyId: string, sessionId: string): Promise<number> {
    const result = await this.pool.query<{ revision: number | null }>(
      `SELECT max(revision) AS revision FROM code_session_plans WHERE company_id=$1 AND session_id=$2`,
      [companyId, sessionId]);
    return (result.rows[0]?.revision ?? 0) + 1;
  }

  async createPlan(input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    const plan = validatePlanBody(input.plan);
    const revision = await this.nextPlanRevision(input.companyId, input.sessionId);
    const now = input.now ?? new Date();
    const id = input.id ?? randomUUID();
    await this.pool.query(
      `INSERT INTO code_session_plans (id, company_id, project_id, session_id, run_id, revision, status, plan,
         created_by, created_at, data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7::jsonb,$8,$9,$10,$11)`,
      [id, input.companyId, input.projectId, input.sessionId, input.runId ?? null, revision,
        JSON.stringify(plan), input.createdBy ?? null, now,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION, input.retentionClass ?? DEFAULT_RETENTION_CLASS],
    );
    const latest = await this.getLatestPlan(input.companyId, input.sessionId);
    if (!latest) throw new CodeSessionTodosInvalidError("Plan was not persisted", { sessionId: input.sessionId });
    return latest;
  }

  async getLatestPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${PLAN_COLUMNS} FROM code_session_plans WHERE company_id=$1 AND session_id=$2
        ORDER BY revision DESC LIMIT 1`, [companyId, sessionId]);
    return result.rows[0] ? toPlan(result.rows[0]) : null;
  }

  async listPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${PLAN_COLUMNS} FROM code_session_plans WHERE company_id=$1 AND session_id=$2
        ORDER BY revision DESC LIMIT $3`, [input.companyId, input.sessionId, limit]);
    return result.rows.map(toPlan);
  }

  async decidePlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    const latest = await this.getLatestPlan(input.companyId, input.sessionId);
    if (!latest) throw new CodeSessionTodosInvalidError("Plan not found", { sessionId: input.sessionId });
    if (latest.revision !== input.expectedRevision) {
      throw new CodeSessionPlanRevisionConflictError({ expected: input.expectedRevision, actual: latest.revision });
    }
    if (input.decision === "approve") {
      if (!isCodePlanExecutionMode(input.executionMode)) {
        throw new CodeSessionTodosInvalidError("Approve requires a canonical execution mode", { mode: input.executionMode });
      }
    }
    const now = input.now ?? new Date();
    // Supersede any previously approved revision first: the partial unique index allows exactly one approved
    // plan per session, so approving a new one must retire the old one in the same transaction.
    await this.pool.query(
      `UPDATE code_session_plans SET status='superseded' WHERE company_id=$1 AND session_id=$2 AND status='approved'`,
      [input.companyId, input.sessionId]);
    await this.pool.query(
      `UPDATE code_session_plans SET status=$3, execution_mode=$4, decision_note=$5, decided_by=$6, decided_at=$7
        WHERE company_id=$1 AND session_id=$2 AND revision=$8`,
      [input.companyId, input.sessionId, input.decision === "approve" ? "approved" : "rejected",
        input.decision === "approve" ? input.executionMode : null, input.note ?? null, input.decidedBy ?? null,
        now, input.expectedRevision]);
    const decided = await this.getLatestPlan(input.companyId, input.sessionId);
    if (!decided) throw new CodeSessionTodosInvalidError("Plan not found after decision", { sessionId: input.sessionId });
    return decided;
  }

  async replaceTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]> {
    const tasks = validateTodoTasks(input.tasks);
    const now = input.now ?? new Date();
    // One transaction: a partially replaced list would show the user a mixture of two plans.
    await this.pool.query("BEGIN");
    try {
      await this.pool.query(`DELETE FROM code_session_todos WHERE company_id=$1 AND session_id=$2`,
        [input.companyId, input.sessionId]);
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index]!;
        await this.pool.query(
          `INSERT INTO code_session_todos (id, company_id, project_id, session_id, goal_id, task_id, content,
             status, position, created_at, updated_at, data_classification, retention_class)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12)`,
          [input.idFactory?.(index) ?? randomUUID(), input.companyId, input.projectId, input.sessionId,
            input.goalId ?? null, task.taskId, task.content, task.status, index, now,
            input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION, input.retentionClass ?? DEFAULT_RETENTION_CLASS],
        );
      }
      await this.pool.query("COMMIT");
    } catch (error) {
      await this.pool.query("ROLLBACK");
      throw error;
    }
    return this.listTodos(input.companyId, input.sessionId);
  }

  async listTodos(companyId: string, sessionId: string): Promise<CodeSessionTodoRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${TODO_COLUMNS} FROM code_session_todos WHERE company_id=$1 AND session_id=$2 ORDER BY position ASC`,
      [companyId, sessionId]);
    return result.rows.map(toTodo);
  }
}

function toPlan(row: Record<string, unknown>): CodeSessionPlanRecord {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    runId: (row.run_id as string | null) ?? null,
    revision: row.revision as number,
    status: row.status as CodeSessionPlanRecord["status"],
    plan: row.plan as CodePlanBody,
    executionMode: (row.execution_mode as CodeSessionPlanRecord["executionMode"]) ?? null,
    decisionNote: (row.decision_note as string | null) ?? null,
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: (row.decided_at as Date | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as Date,
    dataClassification: row.data_classification as CodeSessionPlanRecord["dataClassification"],
    retentionClass: row.retention_class as CodeSessionPlanRecord["retentionClass"],
  };
}

function toTodo(row: Record<string, unknown>): CodeSessionTodoRecord {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    goalId: (row.goal_id as string | null) ?? null,
    taskId: row.task_id as string,
    content: row.content as string,
    status: row.status as CodeSessionTodoStatus,
    position: row.position as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    dataClassification: row.data_classification as CodeSessionTodoRecord["dataClassification"],
    retentionClass: row.retention_class as CodeSessionTodoRecord["retentionClass"],
  };
}

// --- In-memory backend --------------------------------------------------------------------------------

/**
 * The same rules, in memory. This is the backend the unit tests and the local API run against, so a rule that
 * only existed in SQL would silently not hold in the fastest-moving path — which is exactly how "the database
 * enforces it" turns into "nothing enforces it".
 */
export class InMemoryCodeGoalStore {
  private readonly goals = new Map<string, CodeGoalRecord>();
  private readonly criteria = new Map<string, CodeGoalCriterionRecord>();
  private readonly plans = new Map<string, CodeSessionPlanRecord>();
  private readonly todos = new Map<string, CodeSessionTodoRecord>();

  private criteriaFor(companyId: string, goalId: string): CodeGoalCriterionRecord[] {
    return [...this.criteria.values()]
      .filter((criterion) => criterion.companyId === companyId && criterion.goalId === goalId)
      .sort((a, b) => a.position - b.position);
  }

  private loaded(companyId: string, goalId: string): CodeGoalWithCriteria | null {
    const goal = this.goals.get(goalId);
    if (!goal || goal.companyId !== companyId) return null;
    return { ...goal, criteria: this.criteriaFor(companyId, goalId) };
  }

  async createGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
      throw new CodeGoalAcceptanceUnverifiedError({ reason: "no_acceptance_criteria" });
    }
    if (input.criteria.length > MAX_GOAL_CRITERIA) {
      throw new CodeSessionTodosInvalidError("Too many acceptance criteria", { count: input.criteria.length, limit: MAX_GOAL_CRITERIA });
    }
    const now = input.now ?? new Date();
    const id = input.id ?? randomUUID();
    const goal: CodeGoalRecord = {
      id, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId ?? null,
      runId: input.runId ?? null, objective: input.objective, constraints: input.constraints ?? [],
      status: "planned", blockedReason: null, question: null, progressCompleted: 0,
      progressTotal: input.criteria.length, revision: 1, createdBy: input.createdBy ?? null,
      createdAt: now, updatedAt: now,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
    };
    this.goals.set(id, goal);
    input.criteria.forEach((criterion, index) => {
      const criterionId = input.criteriaIds?.[index] ?? randomUUID();
      this.criteria.set(criterionId, {
        id: criterionId, goalId: id, companyId: input.companyId, position: index, criterion,
        status: "pending", evidence: null, verifiedBy: null, verifiedAt: null,
      });
    });
    return this.loaded(input.companyId, id)!;
  }

  async getGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> {
    return this.loaded(companyId, goalId);
  }

  async listGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    return [...this.goals.values()]
      .filter((goal) => goal.companyId === input.companyId)
      .filter((goal) => (input.sessionId ? goal.sessionId === input.sessionId : true))
      .filter((goal) => (input.projectId ? goal.projectId === input.projectId : true))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  async updateGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    const existing = this.loaded(input.companyId, input.goalId);
    if (!existing) throw new CodeSessionTodosInvalidError("Goal not found", { goalId: input.goalId });
    if (existing.revision !== input.expectedRevision) {
      throw new CodeSessionPlanRevisionConflictError({ expected: input.expectedRevision, actual: existing.revision });
    }
    const status = input.status ?? existing.status;
    assertGoalStatus(status);
    assertGoalCompletable(input.goalId, status, existing.criteria);
    const criteria = this.criteriaFor(input.companyId, input.goalId);
    const progressTotal = input.progressTotal ?? existing.progressTotal;
    const completed = input.progressCompleted
      ?? Math.min(criteria.filter((criterion) => criterion.status === "verified").length, progressTotal || criteria.length);
    const updated: CodeGoalRecord = {
      ...existing, status, blockedReason: input.blockedReason ?? null, question: input.question ?? null,
      progressCompleted: completed, progressTotal, revision: existing.revision + 1,
      updatedAt: input.now ?? new Date(),
    };
    delete (updated as Partial<CodeGoalWithCriteria>).criteria;
    this.goals.set(input.goalId, updated);
    return this.loaded(input.companyId, input.goalId)!;
  }

  async setCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria> {
    assertCriterionStatus(input.status);
    const goal = this.loaded(input.companyId, input.goalId);
    if (!goal) throw new CodeSessionTodosInvalidError("Goal not found", { goalId: input.goalId });
    const criterion = this.criteria.get(input.criterionId);
    if (!criterion || criterion.companyId !== input.companyId || criterion.goalId !== input.goalId) {
      throw new CodeSessionTodosInvalidError("Criterion does not belong to this goal", { criterionId: input.criterionId });
    }
    if (goal.status === "completed" && input.status !== "verified") {
      throw new CodeGoalAcceptanceUnverifiedError({ goalId: input.goalId, criterionId: input.criterionId, reason: "completed_goal_criterion_immutable" });
    }
    this.criteria.set(input.criterionId, {
      ...criterion, status: input.status, evidence: input.evidence ?? null,
      verifiedBy: input.verifiedBy ?? null,
      verifiedAt: input.status === "verified" ? (input.now ?? new Date()) : null,
    });
    return this.loaded(input.companyId, input.goalId)!;
  }

  private plansFor(companyId: string, sessionId: string): CodeSessionPlanRecord[] {
    return [...this.plans.values()]
      .filter((plan) => plan.companyId === companyId && plan.sessionId === sessionId)
      .sort((a, b) => b.revision - a.revision);
  }

  async createPlan(input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    const plan = validatePlanBody(input.plan);
    const revision = (this.plansFor(input.companyId, input.sessionId)[0]?.revision ?? 0) + 1;
    const now = input.now ?? new Date();
    const record: CodeSessionPlanRecord = {
      id: input.id ?? randomUUID(), companyId: input.companyId, projectId: input.projectId,
      sessionId: input.sessionId, runId: input.runId ?? null, revision, status: "draft", plan,
      executionMode: null, decisionNote: null, decidedBy: null, decidedAt: null,
      createdBy: input.createdBy ?? null, createdAt: now,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
    };
    this.plans.set(record.id, record);
    return record;
  }

  async getLatestPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null> {
    return this.plansFor(companyId, sessionId)[0] ?? null;
  }

  async listPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    return this.plansFor(input.companyId, input.sessionId).slice(0, limit);
  }

  async decidePlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    const latest = this.plansFor(input.companyId, input.sessionId)[0];
    if (!latest) throw new CodeSessionTodosInvalidError("Plan not found", { sessionId: input.sessionId });
    if (latest.revision !== input.expectedRevision) {
      throw new CodeSessionPlanRevisionConflictError({ expected: input.expectedRevision, actual: latest.revision });
    }
    if (input.decision === "approve" && !isCodePlanExecutionMode(input.executionMode)) {
      throw new CodeSessionTodosInvalidError("Approve requires a canonical execution mode", { mode: input.executionMode });
    }
    for (const plan of this.plansFor(input.companyId, input.sessionId)) {
      if (plan.status === "approved") this.plans.set(plan.id, { ...plan, status: "superseded" });
    }
    const decided: CodeSessionPlanRecord = {
      ...latest,
      status: input.decision === "approve" ? "approved" : "rejected",
      executionMode: input.decision === "approve" ? input.executionMode! : null,
      decisionNote: input.note ?? null,
      decidedBy: input.decidedBy ?? null,
      decidedAt: input.now ?? new Date(),
    };
    this.plans.set(decided.id, decided);
    return decided;
  }

  async replaceTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]> {
    const tasks = validateTodoTasks(input.tasks);
    const now = input.now ?? new Date();
    for (const [id, todo] of [...this.todos.entries()]) {
      if (todo.companyId === input.companyId && todo.sessionId === input.sessionId) this.todos.delete(id);
    }
    tasks.forEach((task, index) => {
      const record: CodeSessionTodoRecord = {
        id: input.idFactory?.(index) ?? randomUUID(), companyId: input.companyId, projectId: input.projectId,
        sessionId: input.sessionId, goalId: input.goalId ?? null, taskId: task.taskId, content: task.content,
        status: task.status, position: index, createdAt: now, updatedAt: now,
        dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
        retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      };
      this.todos.set(record.id, record);
    });
    return this.listTodos(input.companyId, input.sessionId);
  }

  async listTodos(companyId: string, sessionId: string): Promise<CodeSessionTodoRecord[]> {
    return [...this.todos.values()]
      .filter((todo) => todo.companyId === companyId && todo.sessionId === sessionId)
      .sort((a, b) => a.position - b.position);
  }
}

/** Exported for the migration/verify tests: the set of statuses the CHECK constraints must accept. */
export const C9_STATUS_VOCABULARY = {
  goals: CODE_GOAL_STATUSES,
  plans: CODE_SESSION_PLAN_STATUSES,
  todos: CODE_SESSION_TODO_STATUSES,
} as const;
