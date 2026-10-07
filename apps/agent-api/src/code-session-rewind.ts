import type { AuthContext, CodeRunTurnRecord, CodeSession } from "@npati/workspace";
import {
  actorOf,
  CodeSessionDurabilityError,
  CODE_SESSION_DURABILITY_FLAGS,
  defaultOperationKey,
  readRewindRequest,
  resolveRewindTurnTarget,
} from "./code-session-durability";

/**
 * C10 — **Rewind**: put a session back to the checkpoint of *any* turn, in three variants.
 *
 *   - `code`         — the workspace is rolled back to the checkpoint; the conversation is untouched.
 *   - `conversation` — the conversation is truncated to that turn; the workspace is untouched.
 *   - `both`         — both, as one operation with one pre-rewind checkpoint and one audit entry.
 *
 * Three decisions carry the whole design:
 *
 * 1. **A conversation rewind is a pointer, never a deletion.** The replay bundle (`code_replay_bundles`, 078)
 *    and the compaction summaries (`code_context_summaries`, 079) are append-only *in the database*: an UPDATE
 *    or a DELETE raises `insufficient_privilege`. That is not an obstacle to be worked around — it is why a
 *    truncation has to be expressed as a cursor (`code_session_heads`) that every reader applies. The record of
 *    what the model was shown therefore survives the rewind, which is what an auditor needs, while the
 *    conversation the model continues from does not.
 * 2. **Rewind takes its own pre-rewind checkpoint, and exactly one.** The checkpoint of the state *before* the
 *    rewind is what makes a rewind itself reversible. For `code`/`both` it is the one the existing
 *    `restoreCheckpoint` already takes (its backup checkpoint, surfaced as `safetyCheckpointId`); for
 *    `conversation` — which changes no file — an explicit checkpoint is taken through the same service, because
 *    "this rewind changed nothing" is still worth being able to prove. Creating it twice on a retried request is
 *    prevented by claiming the operation **before** performing it.
 * 3. **`both` is coordinated, and it reports partial success honestly.** The code is restored first (which is
 *    where the safety checkpoint comes from), then the cursor moves. If the cursor cannot move, the answer says
 *    `rewound_partial` and names the safety checkpoint, so an operator can finish or undo deliberately. Calling
 *    that outcome "rewound" would be a lie the operator cannot see through.
 *
 * The target is resolved from durable state, not from the caller's memory: a turn's checkpoint is the value the
 * runner now writes into `code_run_turns.checkpoint_id`. A turn that wrote nothing has no checkpoint, and the
 * answer is the exact turn plus the nearest **earlier** turn that does — never a silent approximation.
 */

export interface CodeRewindCheckpointPort {
  /** A checkpoint of the project, used as the pre-rewind safety checkpoint for a conversation-only rewind. */
  create(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId: string;
    label: string;
    runId?: string;
  }): Promise<{ checkpointId: string; commitHash?: string | null }>;
  /**
   * Restores the workspace. The existing implementation creates its mandatory pre-restore safety checkpoint and
   * returns it, which is why `code`/`both` never create a second one here.
   */
  restore(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    checkpointId: string;
  }): Promise<{ restoredCheckpointId: string; safetyCheckpointId?: string | null }>;
  /**
   * Resolves a checkpoint of this project. `null` for an unknown **or foreign** checkpoint, so the route cannot
   * be used to probe another tenant's checkpoint ids.
   */
  find(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    checkpointId: string;
  }): Promise<{ checkpointId: string; runId: string | null } | null>;
}

export interface CodeSessionRewindRequest {
  ctx: AuthContext;
  companyId: string;
  sessionId: string;
  body: unknown;
  /** The head revision the caller read; `0` means "no cursor yet". Absent means "use the current one". */
  expectedRevision?: number | null;
}

export interface CodeSessionRewindResultView {
  status: "rewound" | "rewound_partial" | "already_rewound" | "not_rewound";
  sessionId: string;
  projectId: string;
  target: "code" | "conversation" | "both";
  operationId: string;
  runId: string | null;
  turnIndex: number | null;
  checkpointId: string | null;
  restoredCheckpointId: string | null;
  safetyCheckpointId: string | null;
  code: { restored: boolean; reason?: string };
  conversation: { moved: boolean; previousHeadTurn: number | null; headTurn: number | null; headRevision: number | null; reason?: string };
  /** True when the request replayed an operation that had already been performed: nothing ran twice. */
  idempotentReplay: boolean;
  failureReason?: string;
}

/** The stored operation as this service reads it. Structural, so the store's row fits without a cast. */
export interface CodeSessionRewindRecordView {
  operationId: string;
  target: "code" | "conversation" | "both";
  runId: string | null;
  turnIndex: number | null;
  checkpointId: string | null;
  restoredCheckpointId: string | null;
  safetyCheckpointId: string | null;
  previousHeadTurn: number | null;
  headTurn: number | null;
  status: "pending" | "completed" | "partial" | "failed";
  failureReason: string | null;
  createdAt: Date;
}

export interface CodeSessionRewindDeps {
  flags: { assertEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string }): Promise<unknown> };
  sessions: { get(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> };
  store: {
    getCodeSessionHead(companyId: string, sessionId: string): Promise<{ turnIndex: number; revision: number } | null>;
    setCodeSessionHead(input: {
      companyId: string;
      projectId: string;
      sessionId: string;
      runId?: string | null;
      turnIndex: number;
      reason: "rewind";
      operationId?: string | null;
      expectedRevision: number;
      createdBy?: string | null;
    }): Promise<{ turnIndex: number; revision: number }>;
    listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]>;
    createCodeSessionRewind(input: {
      companyId: string;
      projectId: string;
      sessionId: string;
      operationId: string;
      target: "code" | "conversation" | "both";
      runId?: string | null;
      turnIndex?: number | null;
      checkpointId?: string | null;
      previousHeadTurn?: number | null;
      requestedBy?: string | null;
    }): Promise<{ record: CodeSessionRewindRecordView; replayed: boolean }>;
    reopenCodeSessionRewind(input: {
      companyId: string;
      operationId: string;
      staleMs?: number;
      now?: Date;
    }): Promise<{ record: CodeSessionRewindRecordView | null; reopened: boolean }>;
    completeCodeSessionRewind(input: {
      companyId: string;
      operationId: string;
      status: "completed" | "partial" | "failed";
      restoredCheckpointId?: string | null;
      safetyCheckpointId?: string | null;
      headTurn?: number | null;
      failureReason?: string | null;
    }): Promise<CodeSessionRewindRecordView>;
  };
  checkpoints?: CodeRewindCheckpointPort;
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
  /** How long a claim may stay `pending` before it may be reopened (a process that died inside the window). */
  staleClaimMs?: number;
  now?: () => number;
}

const DEFAULT_STALE_CLAIM_MS = 5 * 60_000;

/** The resolved target: what to restore, where the conversation moves to, and which operation kind it is. */
interface ResolvedRewindTarget {
  target: "code" | "conversation" | "both";
  runId: string | null;
  /** The turn that owns the checkpoint, or the turn the caller named. `null` for a checkpoint outside a turn. */
  turnIndex: number | null;
  checkpointId: string;
}

export class CodeSessionRewindService {
  constructor(private readonly deps: CodeSessionRewindDeps) {}

  async rewind(request: CodeSessionRewindRequest): Promise<CodeSessionRewindResultView> {
    const { ctx, companyId, sessionId } = request;
    await this.deps.flags.assertEnabled(ctx, CODE_SESSION_DURABILITY_FLAGS.rewind, { companyId });
    const session = await this.deps.sessions.get(ctx, companyId, sessionId);
    if (session.status === "archived") {
      throw new CodeSessionDurabilityError("session_archived", "Archived sessions cannot be rewound", 409, {});
    }
    const parsed = readRewindRequest(request.body);
    const runId = parsed.runId ?? session.runId ?? null;

    // (1) Resolve the target **before** claiming the operation: the ledger row must name the checkpoint it will
    // roll back to, and a claim for a checkpoint that cannot be resolved would be a claim that never runs.
    const target = await this.resolveTarget(ctx, companyId, session, runId, parsed.turnIndex, parsed.checkpointId, parsed.target);

    const operationId = parsed.operationId ?? defaultOperationKey([
      "rewind", companyId, sessionId, target.runId, target.turnIndex, target.checkpointId, target.target,
    ]);
    const head = await this.deps.store.getCodeSessionHead(companyId, sessionId);
    const claim = await this.claim({
      companyId, projectId: session.projectId, sessionId, operationId, target, requestedBy: actorOf(ctx), head,
    });
    if (claim.replayed) return this.toView(claim.record, session, true);

    const expectedHeadRevision = parsed.expectedRevision ?? head?.revision ?? 0;
    const previousHeadTurn = head?.turnIndex ?? null;

    /**
     * (2) The journal entry is written **after the claim and before any effect**. Two facts follow, and both are
     * required by the project's rules: a replayed request never writes a second audit record (the claim already
     * existed, so this line is not reached), and an audit outage means no checkpoint is created and no file is
     * touched — the operation is closed as `failed` before it did anything, and a retry can reopen the claim
     * precisely because it provably changed nothing.
     */
    try {
      await this.audit(ctx, companyId, sessionId, {
        operationId,
        target: target.target,
        runId: target.runId,
        turnIndex: target.turnIndex,
        checkpointId: target.checkpointId,
        expectedHeadRevision,
      });
    } catch (error) {
      await this.finish(companyId, operationId, "failed", { failureReason: (error as Error).message });
      throw error;
    }

    let safetyCheckpointId: string | null = null;
    let restoredCheckpointId: string | null = null;
    let restored = false;
    let restoreReason: string | undefined;

    // (3a) The code half. `restoreCheckpoint` creates the pre-rewind safety checkpoint itself.
    if (target.target === "code" || target.target === "both") {
      if (!this.deps.checkpoints) {
        await this.finish(companyId, operationId, "failed", { failureReason: "checkpoint_service_not_configured" });
        throw new CodeSessionDurabilityError(
          "checkpoint_unavailable",
          "Rewinding the workspace requires the checkpoint service, which is not configured",
          503,
          { reason: "checkpoint_service_not_configured" },
          true,
        );
      }
      try {
        const outcome = await this.deps.checkpoints.restore({
          ctx, companyId, projectId: session.projectId, checkpointId: target.checkpointId,
        });
        restored = true;
        restoredCheckpointId = outcome.restoredCheckpointId;
        safetyCheckpointId = outcome.safetyCheckpointId ?? null;
      } catch (error) {
        const reason = (error as Error).message;
        await this.finish(companyId, operationId, "failed", { failureReason: reason });
        throw new CodeSessionDurabilityError(
          "rewind_failed",
          "The workspace could not be restored to the checkpoint",
          500,
          { reason },
          true,
        );
      }
    } else if (this.deps.checkpoints) {
      /**
       * (3b) A conversation-only rewind changes no file, and it still takes a checkpoint: the pre-rewind state is
       * what makes the rewind itself reviewable. When the deployment has no checkpoint service the rewind still
       * proceeds — refusing it would make a conversation pointer depend on git — and the response reports
       * `safetyCheckpointId: null` with the reason instead of implying one exists.
       */
      try {
        const created = await this.deps.checkpoints.create({
          ctx,
          companyId,
          projectId: session.projectId,
          sessionId,
          label: `Pre-rewind checkpoint (conversation rewind to turn ${target.turnIndex})`,
          ...(target.runId ? { runId: target.runId } : {}),
        });
        safetyCheckpointId = created.checkpointId;
      } catch (error) {
        safetyCheckpointId = null;
        restoreReason = `pre_rewind_checkpoint_failed:${(error as Error).message}`;
      }
    } else {
      restoreReason = "checkpoint_service_not_configured";
    }

    // (4) The conversation half.
    let moved = false;
    let headTurn: number | null = previousHeadTurn;
    let headRevision: number | null = head?.revision ?? null;
    let conversationReason: string | undefined;
    if (target.target === "conversation" || target.target === "both") {
      try {
        const updated = await this.deps.store.setCodeSessionHead({
          companyId,
          projectId: session.projectId,
          sessionId,
          runId: target.runId,
          turnIndex: target.turnIndex!,
          reason: "rewind",
          operationId,
          expectedRevision: expectedHeadRevision,
          createdBy: actorOf(ctx),
        });
        moved = true;
        headTurn = updated.turnIndex;
        headRevision = updated.revision;
      } catch (error) {
        conversationReason = (error as Error).message;
      }
    }

    const status: "completed" | "partial" | "failed" = (() => {
      if (target.target === "conversation") return moved ? "completed" : "failed";
      if (target.target === "code") return restored ? "completed" : "failed";
      if (restored && moved) return "completed";
      if (restored) return "partial";
      return "failed";
    })();

    await this.finish(companyId, operationId, status, {
      restoredCheckpointId,
      safetyCheckpointId,
      // A code-only rewind never moved the cursor, so it records no cursor position: a ledger row claiming one
      // would make the idempotent replay of that operation report a conversation move that never happened.
      headTurn: target.target === "code" ? null : headTurn,
      failureReason: conversationReason ?? restoreReason ?? null,
    });

    if (status === "failed" && target.target === "conversation") {
      /**
       * Nothing happened, so nothing is left half-done: the failure is reported with its real cause (usually a
       * stale head revision), and the claim is a provably effect-free failure that a retry with a fresh
       * `expectedRevision` can reopen.
       */
      throw new CodeSessionDurabilityError(
        "session_head_revision_conflict",
        "The conversation cursor changed since it was read; reload and try again",
        409,
        { reason: conversationReason ?? "head_not_moved" },
        true,
      );
    }

    return {
      status: status === "completed" ? "rewound" : status === "partial" ? "rewound_partial" : "not_rewound",
      sessionId,
      projectId: session.projectId,
      target: target.target,
      operationId,
      runId: target.runId,
      turnIndex: target.turnIndex,
      checkpointId: target.checkpointId,
      restoredCheckpointId,
      safetyCheckpointId,
      code: { restored, ...(restoreReason === undefined ? {} : { reason: restoreReason }) },
      conversation: {
        moved,
        previousHeadTurn,
        headTurn,
        headRevision,
        ...(conversationReason === undefined ? {} : { reason: conversationReason }),
      },
      idempotentReplay: false,
      ...(status === "completed" ? {} : { failureReason: conversationReason ?? restoreReason ?? "rewind_incomplete" }),
    };
  }

  /**
   * The claim, with the one concession a durable ledger needs: an operation that failed **without touching
   * anything**, or a `pending` claim older than the staleness window (the process died between claiming and
   * acting), may be reopened. Without that, a crash would brick the operation id forever; with it, a retry still
   * cannot create a second safety checkpoint, because a reopened claim is the same row.
   */
  private async claim(input: {
    companyId: string;
    projectId: string;
    sessionId: string;
    operationId: string;
    target: ResolvedRewindTarget;
    requestedBy: string;
    head: { turnIndex: number; revision: number } | null;
  }): Promise<{ record: CodeSessionRewindRecordView; replayed: boolean }> {
    let first: { record: CodeSessionRewindRecordView; replayed: boolean };
    try {
      first = await this.deps.store.createCodeSessionRewind({
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        operationId: input.operationId,
        target: input.target.target,
        runId: input.target.runId,
        turnIndex: input.target.turnIndex,
        checkpointId: input.target.checkpointId,
        previousHeadTurn: input.head?.turnIndex ?? null,
        requestedBy: input.requestedBy,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "session_operation_in_progress") {
        throw new CodeSessionDurabilityError(
          "rewind_in_progress",
          "This rewind operation is already running",
          409,
          { operationId: input.operationId },
          true,
        );
      }
      throw error;
    }
    if (!first.replayed) return first;
    const reopened = await this.deps.store.reopenCodeSessionRewind({
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
    status: "completed" | "partial" | "failed",
    extra: {
      restoredCheckpointId?: string | null;
      safetyCheckpointId?: string | null;
      headTurn?: number | null;
      failureReason?: string | null;
    },
  ): Promise<void> {
    await this.deps.store.completeCodeSessionRewind({
      companyId,
      operationId,
      status,
      restoredCheckpointId: extra.restoredCheckpointId ?? null,
      safetyCheckpointId: extra.safetyCheckpointId ?? null,
      headTurn: extra.headTurn ?? null,
      failureReason: extra.failureReason ?? null,
    });
  }

  /**
   * Resolves the checkpoint a rewind targets and the turn it belongs to. Both directions are supported because
   * both are what a caller actually holds: a turn from the transcript ("go back to before turn 5") and a
   * checkpoint from the checkpoint list.
   */
  private async resolveTarget(
    ctx: AuthContext,
    companyId: string,
    session: CodeSession,
    runId: string | null,
    turnIndex: number | null,
    checkpointId: string | null,
    target: "code" | "conversation" | "both",
  ): Promise<ResolvedRewindTarget> {
    if (checkpointId) {
      if (!this.deps.checkpoints) {
        throw new CodeSessionDurabilityError(
          "checkpoint_unavailable",
          "Rewinding to a checkpoint requires the checkpoint service, which is not configured",
          503,
          { reason: "checkpoint_service_not_configured" },
          true,
        );
      }
      const found = await this.deps.checkpoints.find({ ctx, companyId, projectId: session.projectId, checkpointId });
      // Unknown and foreign are the same answer: the checkpoint service is tenant- and project-scoped, so `null`
      // covers both and the route cannot be used to probe another tenant's checkpoint ids.
      if (!found) throw new CodeSessionDurabilityError("checkpoint_not_found", "Checkpoint not found", 404, {});
      const effectiveRunId = runId ?? found.runId ?? null;
      const owner = effectiveRunId ? await this.turnOwningCheckpoint(companyId, effectiveRunId, found.checkpointId) : null;
      const resolvedTurn = turnIndex ?? owner;
      if (target !== "code" && resolvedTurn === null) {
        /**
         * A conversation rewind needs a turn to move the cursor to. A checkpoint that no recorded turn owns has no
         * position in the conversation, and inventing one would truncate the transcript at an arbitrary place.
         */
        throw new CodeSessionDurabilityError(
          "turn_index_required",
          "A conversation rewind needs the turn to rewind to; this checkpoint is not attached to a recorded turn",
          400,
          { checkpointId: found.checkpointId },
        );
      }
      return { target, runId: effectiveRunId, turnIndex: resolvedTurn, checkpointId: found.checkpointId };
    }
    if (!runId) {
      throw new CodeSessionDurabilityError(
        "run_not_found",
        "This session has no run to rewind to, and no checkpoint was named",
        404,
        { reason: "session_has_no_run" },
      );
    }
    const turns = await this.deps.store.listCodeRunTurns(companyId, runId);
    const resolved = resolveRewindTurnTarget(turns, turnIndex!);
    if (!resolved.checkpointId) {
      throw new CodeSessionDurabilityError(
        "turn_has_no_checkpoint",
        "That turn has no checkpoint of its own; rewind to the nearest earlier turn that does, or name a checkpoint explicitly",
        409,
        {
          runId,
          turnIndex: resolved.turnIndex,
          nearestEarlierTurn: resolved.nearestEarlierTurn,
        },
      );
    }
    return { target, runId, turnIndex: resolved.turnIndex, checkpointId: resolved.checkpointId };
  }

  private async turnOwningCheckpoint(companyId: string, runId: string, checkpointId: string): Promise<number | null> {
    try {
      const turns = await this.deps.store.listCodeRunTurns(companyId, runId);
      return turns.find((turn) => turn.checkpointId === checkpointId)?.turnIndex ?? null;
    } catch {
      return null;
    }
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
        "Rewinding a session requires the audit journal",
        503,
        { reason: "audit_not_configured" },
        true,
      );
    }
    try {
      await this.deps.audit.record({
        action: "code.rewind",
        actor: actorOf(ctx),
        companyId,
        resourceType: "code_session",
        resourceId: sessionId,
        metadata,
      });
    } catch (error) {
      throw new CodeSessionDurabilityError(
        "audit_unavailable",
        "Rewinding a session requires the audit journal",
        503,
        { reason: (error as Error).message },
        true,
      );
    }
  }

  /** The stored outcome of an operation that already ran: returned as-is, with nothing performed twice. */
  private toView(record: CodeSessionRewindRecordView, session: CodeSession, idempotentReplay: boolean): CodeSessionRewindResultView {
    return {
      status: record.status === "completed" ? "already_rewound" : record.status === "partial" ? "rewound_partial" : "not_rewound",
      sessionId: session.id,
      projectId: session.projectId,
      target: record.target,
      operationId: record.operationId,
      runId: record.runId,
      turnIndex: record.turnIndex,
      checkpointId: record.checkpointId,
      restoredCheckpointId: record.restoredCheckpointId,
      safetyCheckpointId: record.safetyCheckpointId,
      code: { restored: record.restoredCheckpointId !== null },
      conversation: {
        moved: record.target !== "code" && record.headTurn !== null,
        previousHeadTurn: record.previousHeadTurn,
        headTurn: record.headTurn,
        headRevision: null,
      },
      idempotentReplay,
      ...(record.failureReason === null ? {} : { failureReason: record.failureReason }),
    };
  }
}
