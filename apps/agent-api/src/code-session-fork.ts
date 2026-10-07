import type { AuthContext, CodePlanBody, CodeSession, CodeSessionInput } from "@npati/workspace";
import {
  actorOf,
  CodeSessionDurabilityError,
  CODE_SESSION_DURABILITY_FLAGS,
  defaultOperationKey,
} from "./code-session-durability";

/**
 * C10 — **Fork**: a new branch of the conversation from the same checkpoint.
 *
 * `code_sessions.parent_session_id` has existed since C1 (and `createCodeSession` even validates that the parent
 * belongs to the same project) but nothing read it, and `createCodeSession` mints a `randomUUID()` with no
 * idempotency whatsoever — so before C10 a repeated fork request created a second session, and a fork could not
 * be recognised as one. Both are fixed here:
 *
 *   - the fork is claimed in `code_session_forks`, keyed by `(companyId, operationId)`, **before** the session is
 *     created. A repeated request returns the session the first one created instead of creating another, and a
 *     request that arrives while the first is still pending is refused (`fork_in_progress`) rather than racing it;
 *   - the lineage is recorded with the checkpoint and the turn it branched from, so "which branch came from
 *     where" is answerable from durable state rather than from a column nobody writes.
 *
 * What is copied, and what is deliberately not:
 *
 *   - **The conversation cursor is copied.** A fork is a branch *of the same conversation*, so the new session
 *     starts where the source stood — same run, same turn. Without this the fork would be a new session with no
 *     relationship to the transcript it was branched from.
 *   - **The latest plan is copied as a new draft revision.** Copying the plan body is useful (the approach is the
 *     same work), but copying the *decision* is not: `status: approved` and its `execution_mode` were a user's
 *     decision about one session, and C9's rule is that the mode comes from the user's decision on the session it
 *     applies to. So the fork gets a draft, and approving it is a visible act somebody performs.
 *   - **The todo list is copied as-is.** It is a task list, not a permission: it says what is left to do, and a
 *     branch that continues the same work must see the same list. (`replaceCodeSessionTodos` is replace-semantics,
 *     so the copy is idempotent by construction if it is ever retried after a partial failure.)
 *   - **The goal is not copied.** A goal is an *execution record*: it carries acceptance criteria, progress and a
 *     status that can be `completed`, and C9's store refuses `completed` unless every criterion is verified. Two
 *     rows claiming the same objective would make "is this done?" depend on which row you read, and would let a
 *     branch accumulate progress against a record the other branch is still working on. The fork simply has no
 *     goal until whatever it does creates one; the response reports `copiedGoal: false` and the reason, so the
 *     omission is visible rather than accidental.
 *
 * Tenant safety is inherited from the operations that already own it: `createCodeSession` validates the project,
 * the parent session and the agent; every read is company-scoped; and a source session of another company is
 * `session_not_found`, exactly like one that never existed.
 */

export interface CodeSessionForkRequest {
  ctx: AuthContext;
  companyId: string;
  sessionId: string;
  body?: unknown;
}

export interface CodeSessionForkResultView {
  status: "forked" | "already_forked";
  sessionId: string;
  parentSessionId: string;
  projectId: string;
  operationId: string;
  runId: string | null;
  turnIndex: number | null;
  checkpointId: string | null;
  copied: { plan: boolean; planRevision: number | null; todos: boolean; todoCount: number; conversationHead: boolean; goal: boolean };
  /** Why the goal was not copied. Always present, so an absent goal is never mistaken for an oversight. */
  goalCopyReason: string;
  idempotentReplay: boolean;
  failureReason?: string;
}

/** The stored fork operation as this service reads it. Structural, so the store's row fits. */
export interface CodeSessionForkRecordView {
  operationId: string;
  parentSessionId: string;
  sessionId: string | null;
  runId: string | null;
  turnIndex: number | null;
  checkpointId: string | null;
  copiedPlan: boolean;
  copiedTodos: boolean;
  copiedHead: boolean;
  copiedGoal: boolean;
  planRevision: number | null;
  todoCount: number;
  status: "pending" | "completed" | "failed";
  failureReason: string | null;
  createdAt: Date;
}

export interface CodeSessionForkDeps {
  flags: { assertEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string }): Promise<unknown> };
  sessions: {
    get(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession>;
    create(ctx: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession>;
  };
  store: {
    getCodeSessionHead(companyId: string, sessionId: string): Promise<{ runId: string | null; turnIndex: number; revision: number } | null>;
    setCodeSessionHead(input: {
      companyId: string;
      projectId: string;
      sessionId: string;
      runId?: string | null;
      turnIndex: number;
      reason: "fork";
      operationId?: string | null;
      expectedRevision: number;
      createdBy?: string | null;
    }): Promise<{ turnIndex: number; revision: number }>;
    getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<{ revision: number; plan: CodePlanBody } | null>;
    createCodeSessionPlan(input: {
      companyId: string;
      projectId: string;
      sessionId: string;
      plan: CodePlanBody;
      createdBy?: string | null;
    }): Promise<{ revision: number }>;
    listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<Array<{ taskId: string; content: string; status: string }>>;
    replaceCodeSessionTodos(input: {
      companyId: string;
      projectId: string;
      sessionId: string;
      tasks: Array<{ taskId: string; content: string; status: "pending" | "in_progress" | "completed" }>;
    }): Promise<unknown>;
    createCodeSessionFork(input: {
      companyId: string;
      projectId: string;
      parentSessionId: string;
      operationId: string;
      runId?: string | null;
      turnIndex?: number | null;
      checkpointId?: string | null;
      requestedBy?: string | null;
    }): Promise<{ record: CodeSessionForkRecordView; replayed: boolean }>;
    reopenCodeSessionFork(input: {
      companyId: string;
      operationId: string;
      staleMs?: number;
      now?: Date;
    }): Promise<{ record: CodeSessionForkRecordView | null; reopened: boolean }>;
    completeCodeSessionFork(input: {
      companyId: string;
      operationId: string;
      status: "completed" | "failed";
      sessionId?: string | null;
      copiedPlan?: boolean;
      copiedTodos?: boolean;
      copiedHead?: boolean;
      copiedGoal?: boolean;
      planRevision?: number | null;
      todoCount?: number;
      failureReason?: string | null;
    }): Promise<CodeSessionForkRecordView>;
  };
  /** Validates an explicitly named checkpoint against the project, so a foreign id is `checkpoint_not_found`. */
  checkpoints?: {
    find(input: { ctx: AuthContext; companyId: string; projectId: string; checkpointId: string }): Promise<{ checkpointId: string; runId: string | null } | null>;
  };
  audit?: {
    record(input: {
      action: string;
      actor: string;
      companyId: string;
      resourceType: string;
      resourceId: string;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  staleClaimMs?: number;
  now?: () => number;
}

const DEFAULT_STALE_CLAIM_MS = 5 * 60_000;
const GOAL_COPY_REASON =
  "a goal is an execution record with acceptance criteria and progress; a branch must not open a second record "
  + "for the same objective while the original is still being worked on";

function readForkRequest(body: unknown): {
  checkpointId: string | null;
  runId: string | null;
  turnIndex: number | null;
  operationId: string | null;
  expectedRevision: number | null;
} {
  const shaped = (body ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    value === undefined || value === null || value === "" ? null : String(value);
  const turnRaw = shaped.turnIndex;
  let turnIndex: number | null = null;
  if (turnRaw !== undefined && turnRaw !== null && turnRaw !== "") {
    const numeric = Number(turnRaw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new CodeSessionDurabilityError("invalid_arguments", "turnIndex must be a non-negative number", 400, { field: "turnIndex" });
    }
    turnIndex = Math.trunc(numeric);
  }
  const revisionRaw = shaped.expectedRevision;
  let expectedRevision: number | null = null;
  if (revisionRaw !== undefined && revisionRaw !== null && revisionRaw !== "") {
    const numeric = Number(revisionRaw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new CodeSessionDurabilityError("invalid_arguments", "expectedRevision must be a non-negative number", 400, { field: "expectedRevision" });
    }
    expectedRevision = Math.trunc(numeric);
  }
  return {
    checkpointId: text(shaped.checkpointId),
    runId: text(shaped.runId),
    turnIndex,
    operationId: text(shaped.operationId),
    expectedRevision,
  };
}

export class CodeSessionForkService {
  constructor(private readonly deps: CodeSessionForkDeps) {}

  async fork(request: CodeSessionForkRequest): Promise<CodeSessionForkResultView> {
    const { ctx, companyId, sessionId } = request;
    await this.deps.flags.assertEnabled(ctx, CODE_SESSION_DURABILITY_FLAGS.fork, { companyId });
    const source = await this.deps.sessions.get(ctx, companyId, sessionId);
    const parsed = readForkRequest(request.body);
    if (parsed.expectedRevision !== null && parsed.expectedRevision !== source.revision) {
      throw new CodeSessionDurabilityError(
        "session_revision_conflict",
        "The session changed since it was read; reload and try again",
        409,
        { expectedRevision: parsed.expectedRevision, currentRevision: source.revision },
        true,
      );
    }

    const head = await this.deps.store.getCodeSessionHead(companyId, sessionId);
    const runId = parsed.runId ?? head?.runId ?? source.runId ?? null;
    const turnIndex = parsed.turnIndex ?? head?.turnIndex ?? null;
    let checkpointId = parsed.checkpointId;
    if (checkpointId) {
      if (!this.deps.checkpoints) {
        throw new CodeSessionDurabilityError(
          "checkpoint_unavailable",
          "Forking from a checkpoint requires the checkpoint service, which is not configured",
          503,
          { reason: "checkpoint_service_not_configured" },
          true,
        );
      }
      const found = await this.deps.checkpoints.find({ ctx, companyId, projectId: source.projectId, checkpointId });
      if (!found) throw new CodeSessionDurabilityError("checkpoint_not_found", "Checkpoint not found", 404, {});
      checkpointId = found.checkpointId;
    }

    const operationId = parsed.operationId ?? defaultOperationKey([
      "fork", companyId, sessionId, checkpointId, runId, turnIndex,
    ]);
    const claim = await this.claim({
      companyId, projectId: source.projectId, sessionId, operationId, runId, turnIndex, checkpointId, requestedBy: actorOf(ctx),
    });
    if (claim.replayed) {
      /**
       * A fork operation that already ran answers with the session it created — no second session, no second
       * audit entry. One that failed answers with its failure instead: pretending a failure was a success would
       * hand the caller a session id that does not exist, and pretending nothing happened would invite a retry
       * without saying why the first attempt failed.
       */
      if (claim.record.status === "completed" && claim.record.sessionId) {
        return this.toView(claim.record, source, true);
      }
      throw new CodeSessionDurabilityError(
        "fork_incomplete",
        "A previous attempt of this fork operation did not complete",
        409,
        { operationId, reason: claim.record.failureReason ?? "fork_not_completed" },
        true,
      );
    }

    try {
      await this.audit(ctx, companyId, sessionId, {
        operationId, checkpointId, runId, turnIndex, parentSessionId: sessionId,
      });
    } catch (error) {
      await this.finish(companyId, operationId, { status: "failed", failureReason: (error as Error).message });
      throw error;
    }

    /**
     * The session is created through the existing service, so every rule that already governs session creation
     * still applies: the project exists, the parent session belongs to the same project, the agent belongs to the
     * company and the classification may not be lowered. The fork passes the source's own mode and model profile,
     * because a branch that started in a different mode than the session it branched from would be a different
     * autonomy level than the user chose.
     */
    let created: CodeSession;
    try {
      created = await this.deps.sessions.create(ctx, companyId, source.projectId, {
        parentSessionId: source.id,
        mode: source.mode,
        ...(source.modelProfile ? { modelProfile: source.modelProfile } : {}),
        summary: `Forked from session ${source.id}`,
        dataClassification: source.dataClassification,
        retentionClass: source.retentionClass,
      });
    } catch (error) {
      await this.finish(companyId, operationId, { status: "failed", failureReason: (error as Error).message });
      throw new CodeSessionDurabilityError(
        "fork_failed",
        "The forked session could not be created",
        (error as { httpStatus?: number }).httpStatus ?? 500,
        { reason: (error as Error).message },
        false,
      );
    }

    /**
     * The copies. Each is best effort **and reported**: a plan that cannot be copied leaves the fork without a
     * plan (`copied.plan: false`), which is a state a reader can act on; throwing here would leave a session
     * nobody knows about, because the session row already exists.
     */
    let copiedPlan = false;
    let planRevision: number | null = null;
    try {
      const plan = await this.deps.store.getLatestCodeSessionPlan(companyId, sessionId);
      if (plan) {
        const copy = await this.deps.store.createCodeSessionPlan({
          companyId,
          projectId: source.projectId,
          sessionId: created.id,
          plan: plan.plan,
          createdBy: actorOf(ctx),
        });
        copiedPlan = true;
        planRevision = copy.revision;
      }
    } catch {
      copiedPlan = false;
    }

    let copiedTodos = false;
    let todoCount = 0;
    try {
      const todos = await this.deps.store.listCodeSessionTodos({ companyId, sessionId });
      if (todos.length) {
        await this.deps.store.replaceCodeSessionTodos({
          companyId,
          projectId: source.projectId,
          sessionId: created.id,
          tasks: todos.map((todo) => ({
            taskId: todo.taskId,
            content: todo.content,
            status: todo.status as "pending" | "in_progress" | "completed",
          })),
        });
        copiedTodos = true;
        todoCount = todos.length;
      } else {
        copiedTodos = true;
      }
    } catch {
      copiedTodos = false;
    }

    let copiedHead = false;
    if (runId !== null && turnIndex !== null) {
      try {
        await this.deps.store.setCodeSessionHead({
          companyId,
          projectId: source.projectId,
          sessionId: created.id,
          runId,
          turnIndex,
          reason: "fork",
          operationId,
          expectedRevision: 0,
          createdBy: actorOf(ctx),
        });
        copiedHead = true;
      } catch {
        copiedHead = false;
      }
    }

    const stored = await this.finish(companyId, operationId, {
      status: "completed",
      sessionId: created.id,
      copiedPlan,
      copiedTodos,
      copiedHead,
      copiedGoal: false,
      planRevision,
      todoCount,
    });

    return {
      status: "forked",
      sessionId: created.id,
      parentSessionId: source.id,
      projectId: source.projectId,
      operationId,
      runId,
      turnIndex,
      checkpointId: checkpointId ?? null,
      copied: { plan: copiedPlan, planRevision, todos: copiedTodos, todoCount, conversationHead: copiedHead, goal: false },
      goalCopyReason: GOAL_COPY_REASON,
      idempotentReplay: false,
      ...(stored.failureReason === null ? {} : { failureReason: stored.failureReason }),
    };
  }

  /** The same claim protocol as the rewind ledger: insert, then read back what the insert found. */
  private async claim(input: {
    companyId: string;
    projectId: string;
    sessionId: string;
    operationId: string;
    runId: string | null;
    turnIndex: number | null;
    checkpointId: string | null;
    requestedBy: string;
  }): Promise<{ record: CodeSessionForkRecordView; replayed: boolean }> {
    let first: { record: CodeSessionForkRecordView; replayed: boolean };
    try {
      first = await this.deps.store.createCodeSessionFork({
        companyId: input.companyId,
        projectId: input.projectId,
        parentSessionId: input.sessionId,
        operationId: input.operationId,
        runId: input.runId,
        turnIndex: input.turnIndex,
        checkpointId: input.checkpointId,
        requestedBy: input.requestedBy,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "session_operation_in_progress") {
        throw new CodeSessionDurabilityError(
          "fork_in_progress",
          "This fork operation is already running",
          409,
          { operationId: input.operationId },
          true,
        );
      }
      throw error;
    }
    if (!first.replayed) return first;
    const reopened = await this.deps.store.reopenCodeSessionFork({
      companyId: input.companyId,
      operationId: input.operationId,
      staleMs: this.deps.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS,
      ...(this.deps.now ? { now: new Date(this.deps.now()) } : {}),
    });
    if (reopened.reopened && reopened.record) return { record: reopened.record, replayed: false };
    return first;
  }

  private async finish(
    companyId: string,
    operationId: string,
    input: {
      status: "completed" | "failed";
      sessionId?: string | null;
      copiedPlan?: boolean;
      copiedTodos?: boolean;
      copiedHead?: boolean;
      copiedGoal?: boolean;
      planRevision?: number | null;
      todoCount?: number;
      failureReason?: string | null;
    },
  ): Promise<CodeSessionForkRecordView> {
    return this.deps.store.completeCodeSessionFork({ companyId, operationId, ...input });
  }

  private async audit(
    ctx: AuthContext,
    companyId: string,
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) {
      throw new CodeSessionDurabilityError(
        "audit_unavailable",
        "Forking a session requires the audit journal",
        503,
        { reason: "audit_not_configured" },
        true,
      );
    }
    try {
      await this.deps.audit.record({
        action: "code.session.fork",
        actor: actorOf(ctx),
        companyId,
        resourceType: "code_session",
        resourceId: sessionId,
        metadata,
      });
    } catch (error) {
      throw new CodeSessionDurabilityError(
        "audit_unavailable",
        "Forking a session requires the audit journal",
        503,
        { reason: (error as Error).message },
        true,
      );
    }
  }

  /** The stored outcome of a fork that already happened: returned as-is, with no second session created. */
  private toView(record: CodeSessionForkRecordView, source: CodeSession, idempotentReplay: boolean): CodeSessionForkResultView {
    return {
      status: "already_forked",
      sessionId: record.sessionId ?? "",
      parentSessionId: record.parentSessionId,
      projectId: source.projectId,
      operationId: record.operationId,
      runId: record.runId,
      turnIndex: record.turnIndex,
      checkpointId: record.checkpointId,
      copied: {
        plan: record.copiedPlan,
        planRevision: record.planRevision,
        todos: record.copiedTodos,
        todoCount: record.todoCount,
        conversationHead: record.copiedHead,
        goal: record.copiedGoal,
      },
      goalCopyReason: GOAL_COPY_REASON,
      idempotentReplay,
      ...(record.failureReason === null ? {} : { failureReason: record.failureReason }),
    };
  }
}
