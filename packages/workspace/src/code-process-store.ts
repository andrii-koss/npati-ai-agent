import type { DataClassification, RetentionClass } from "./types";

export type DurableProcessState = "accepted" | "preparing" | "dispatching" | "running" | "interrupted" | "completed" | "failed" | "stopped" | "timed_out" | "lost" | "unknown_outcome";
export interface CodeProcessScope {
  companyId: string; projectId: string; sessionId: string;
  dataClassification: DataClassification; retentionClass: RetentionClass;
}
export interface DurableCodeProcess {
  operationId: string; executionKey: string; processId: string; companyId: string; projectId: string; sessionId: string;
  runId: string; owner: string; generation: number; payloadHash: string; agentId: string;
  sandboxId: string | null; startedRevision: number; state: DurableProcessState; exitCode: number | null;
  workspaceSnapshot?: { version?: 2; sandboxId: string; mounted: boolean; files: Array<{ path: string; revision: string; hash: string }> };
  cancelRequested: boolean; promoted: boolean; createdAt: string; startedAt: string | null; settledAt: string | null;
  output: { text: string; earliest: number; next: number; lossy: boolean };
  events: Array<{ seq: number; type: string }>; seq: number;
  completion?: CodeProcessCompletion;
  /**
   * Step 5 (detached async sub-agents): what this operation is.
   *
   * Absent means `"process"`, so every row written before this field existed keeps its meaning and no reader has
   * to migrate. `"subagent"` is a **child run of the coding agent** attached to the parent run: it uses the same
   * project transaction, the same active-operation accounting (an in-flight child blocks the sandbox cleanup the
   * parent's processes block), the same completion outbox and the same collector — which is exactly why it is an
   * additive field here rather than a second store, a second outbox or a second queue.
   */
  kind?: "process" | "subagent";
  /** For `kind: "subagent"`: the durable child run and the parent tool call that is its join key. */
  child?: { runId: string; toolCallId: string; agentType: string; sessionId?: string; owner?: string; continueRequestId?: string; continueRequestIds?: string[]; stopRequested?: boolean };
  /**
   * For `kind: "subagent"`: the delegation this operation *is* — the resolved type, the task, the approved scope
   * and the capability intersection. Recovery re-enters a child from this record, so it has to survive a restart;
   * it is one object on the operation rather than a table of its own because a delegation has no life without the
   * operation that owns its slot, its join key and its completion notice.
   */
  delegation?: Record<string, unknown>;
}
export interface CodeCompletionNotice {
  eventId: string; operationId: string; processId: string; generation: number;
  parentRunId: string; parentOwner: string; type: "process" | "subagent"; status: DurableProcessState; resultRef: string;
  /**
   * For `type: "subagent"`: the child's own run id and the parent tool call that started it. They are part of the
   * notice so the parent can join a completion to the delegation **from the notice alone**, without reading the
   * operation back.
   */
  childRunId?: string; childToolCallId?: string;
}
export interface CodeProcessCompletion {
  notice: CodeCompletionNotice;
  result: { state: DurableProcessState; exitCode: number | null; output: string; earliestOffset: number; nextOffset: number; lossy: boolean };
  deliveredAt: string | null;
  admission?: { runId: string; turnIndex: number; kind: "wait" | "inbox"; canonicalResult: string };
}
export interface CodeProcessProjectState { operations: DurableCodeProcess[]; cleanupToken: string | null }
export interface ProcessRunLease { runId: string; sessionId: string; owner: string | null; live: boolean; terminal: boolean }
export type CodeProcessCommand =
  | { kind: "read"; operationId?: string; processId?: string }
  | { kind: "reserve"; operationId: string; processId: string; executionKey: string; payloadHash: string; runId: string; owner: string; agentId: string; startedRevision: number }
  | { kind: "claim" | "adopt"; operationId: string; owner: string }
  | { kind: "update"; operationId: string; owner: string; generation: number; state?: DurableProcessState; sandboxId?: string; workspaceSnapshot?: DurableCodeProcess["workspaceSnapshot"]; exitCode?: number | null; output?: string; outputOffset?: number; lossy?: boolean; promoted?: boolean }
  | { kind: "cancel"; operationId: string; terminal?: boolean }
  | { kind: "completion-delivered"; operationId: string; eventId: string; generation: number }
  | { kind: "completion-admit"; operationId: string; eventId: string; generation: number; runId: string; owner: string; turnIndex: number; source: "wait" | "inbox"; canonicalResult: string }
  | { kind: "cleanup-acquire"; token: string; purpose?: "prepare" }
  | { kind: "idle-check" }
  | { kind: "cleanup-release"; token: string }
  /**
   * Step 5: the durable record of a **detached** sub-agent delegation, and its settlement.
   *
   * `reserve-child` is the write that makes the delegation recoverable: it records the join key
   * `(parentRunId, toolCallId) → childRunId` in the same project transaction that already owns process
   * accounting, so a restart can find the delegation without a second table. It is idempotent by the join key,
   * which is what makes a retried `code.agent.spawn` the *same* delegation instead of a second child.
   *
   * `update-child` settles it from the child's own run id — the child runner does not know its operation id —
   * and the terminal transition is fenced by the **child run's** own lease identity: while a different owner holds
   * a live lease on the child run, the settlement is refused; a child whose run has ended, or whose run row does
   * not exist at all, is settled from the durable record (see the branch below). The `accepted` → `running`
   * transition is the parent's and is fenced by the **parent run's** live lease.
   */
  | { kind: "reserve-child"; operationId: string; childRunId: string; toolCallId: string; agentType: string; runId: string; owner: string;
      delegation?: Record<string, unknown>; maxParallelism?: number }
  | { kind: "bind-child-session"; childRunId: string; childSessionId: string }
  | { kind: "continue-child"; childRunId: string; owner: string; requestId: string }
  | { kind: "update-child"; childRunId: string; owner: string; state?: "running" | "interrupted" | "completed" | "failed"; errorCode?: string | null;
      outcome?: { answer?: string | null; filesChanged?: readonly unknown[]; toolCalls?: unknown; turns?: unknown } };
export interface CodeProcessStoreResult {
  operations: DurableCodeProcess[];
  claimed: boolean;
  cleanupAcquired: boolean;
  /**
   * Step 5: true when this transaction **created** the operation it was asked to reserve, false when it already
   * existed. The caller must not start a second child for a reservation it did not make, and "the row now exists"
   * cannot answer that: the earlier reservation may still be in its `accepted` state, before any producer ran.
   */
  reserved: boolean;
}
export interface CodeProcessStore {
  transact(scope: CodeProcessScope, command: CodeProcessCommand): Promise<CodeProcessStoreResult>;
}
export class CodeProcessStoreError extends Error {
  constructor(readonly code: string, readonly httpStatus = 409) { super(code); }
}
export const activeCodeProcess = (op: DurableCodeProcess) => ["accepted", "preparing", "dispatching", "running", "interrupted", "unknown_outcome"].includes(op.state);

/**
 * The JSON a settled `subagent` operation stores in its free-text slot.
 *
 * `code-process-completions.ts` reads exactly this shape back (`parseStoredCodeSubagentChildOutcome`) and never
 * parses anything else, so writer and reader are one contract. The bound is the same 64 000 characters the
 * completion admission enforces, applied here so an oversized child answer cannot be stored at all; the digest
 * builder refuses content and credentials on top of it, so this is a size bound and not the security bound.
 */
function serializeChildOutcome(
  outcome: { answer?: string | null; filesChanged?: readonly unknown[]; toolCalls?: unknown; turns?: unknown } | undefined,
  errorCode: string | null | undefined,
): string {
  const payload = {
    ...(typeof outcome?.answer === "string" && outcome.answer.length <= 64_000 ? { answer: outcome.answer } : {}),
    ...(outcome?.filesChanged ? { filesChanged: outcome.filesChanged.filter((entry) => typeof entry === "string").slice(0, 200) } : {}),
    toolCalls: typeof outcome?.toolCalls === "number" && Number.isFinite(outcome.toolCalls) ? Math.trunc(outcome.toolCalls) : 0,
    turns: typeof outcome?.turns === "number" && Number.isFinite(outcome.turns) ? Math.trunc(outcome.turns) : 0,
    ...(errorCode ? { errorCode: String(errorCode).slice(0, 120) } : {}),
  };
  const serialized = JSON.stringify(payload);
  return serialized.length <= 64_000 ? serialized : JSON.stringify({ ...payload, answer: undefined });
}

/** Shared synchronous transitions. The backend serializes the project and locks current C6a run rows. */
export function applyCodeProcess(state: CodeProcessProjectState, scope: CodeProcessScope, command: CodeProcessCommand, leases: ProcessRunLease[], now: Date) {
  const next = structuredClone(state);
  let claimed = false, cleanupAcquired = false, reserved = false;
  const journal = (op: DurableCodeProcess, type: string) => {
    op.seq++; op.events.push({ seq: op.seq, type });
    if (op.events.length > 4096) op.events.splice(0, op.events.length - 4096);
  };
  const owned = (operationId: string) => {
    const op = next.operations.find((op) => op.operationId === operationId && op.sessionId === scope.sessionId);
    if (!op) throw new CodeProcessStoreError("process_not_found", 404);
    return op;
  };
  const live = (runId: string, owner: string) => {
    if (!leases.some((lease) => lease.runId === runId && lease.sessionId === scope.sessionId && lease.owner === owner && lease.live)) throw new CodeProcessStoreError("process_lease_lost");
  };
  if (command.kind === "reserve") {
    live(command.runId, command.owner);
    const key = JSON.stringify([scope.companyId, scope.projectId, scope.sessionId, command.runId]);
    if (!command.executionKey.startsWith(key.slice(0, -1) + ",") || command.executionKey.length > 1024) throw new CodeProcessStoreError("invalid_execution_key", 400);
    const existing = next.operations.find((op) => op.executionKey === command.executionKey);
    if (existing) {
      if (existing.payloadHash !== command.payloadHash || existing.runId !== command.runId || existing.sessionId !== scope.sessionId) throw new CodeProcessStoreError("process_request_conflict");
    } else {
      if (next.cleanupToken) throw new CodeProcessStoreError("sandbox_cleanup_in_progress");
      if (next.operations.filter((op) => op.sessionId === scope.sessionId && activeCodeProcess(op)).length >= 10) throw new CodeProcessStoreError("process_limit", 429);
      const op: DurableCodeProcess = {
        ...scope, operationId: command.operationId, processId: command.processId, executionKey: command.executionKey,
        runId: command.runId, owner: command.owner, generation: 1, payloadHash: command.payloadHash, agentId: command.agentId,
        sandboxId: null, startedRevision: command.startedRevision, state: "accepted", exitCode: null,
        cancelRequested: false, promoted: false, createdAt: now.toISOString(), startedAt: null, settledAt: null,
        output: { text: "", earliest: 0, next: 0, lossy: false }, events: [], seq: 0,
      };
      next.operations.push(op); journal(op, "process.accepted");
    }
  } else if (command.kind === "claim" || command.kind === "adopt") {
    const op = owned(command.operationId); live(op.runId, command.owner);
    if (command.kind === "adopt" && activeCodeProcess(op) && op.owner !== command.owner) { op.owner = command.owner; op.generation++; journal(op, "process.owner_replaced"); }
    if (command.kind === "claim" && op.state === "accepted" && op.owner === command.owner && !op.cancelRequested) {
      // Canonical upload must not overwrite another producer's workspace while it is still running.
      if (next.operations.some((other) => other.operationId !== op.operationId && activeCodeProcess(other) && other.state !== "accepted")) throw new CodeProcessStoreError("process_workspace_busy");
      op.state = "preparing"; claimed = true; journal(op, "process.preparing");
    }
  } else if (command.kind === "update") {
    const op = owned(command.operationId);
    if (op.owner !== command.owner || op.generation !== command.generation) throw new CodeProcessStoreError("process_lease_lost");
    // A terminal parent permits observation/settlement of an existing producer, never a new dispatch.
    if (command.state === "dispatching") live(op.runId, command.owner);
    const lease = leases.find((l) => l.runId === op.runId);
    const cancelledSettlement = op.cancelRequested && (!command.state || ["stopped", "completed", "failed", "timed_out"].includes(command.state));
    if (!cancelledSettlement && (!lease || (!lease.terminal && (!lease.live || lease.owner !== command.owner)))) throw new CodeProcessStoreError("process_lease_lost");
    if (!activeCodeProcess(op) && command.state && command.state !== op.state) throw new CodeProcessStoreError("process_already_settled");
    if (command.sandboxId !== undefined) {
      if (op.sandboxId && op.sandboxId !== command.sandboxId) throw new CodeProcessStoreError("process_sandbox_mismatch");
      op.sandboxId = command.sandboxId;
    }
    if (command.workspaceSnapshot) op.workspaceSnapshot = command.workspaceSnapshot;
    if (command.state) {
      if (command.state === "dispatching" && (op.state !== "preparing" || op.cancelRequested || !op.sandboxId)) throw new CodeProcessStoreError("process_dispatch_refused");
      if (command.state === "completed" && command.exitCode !== 0) throw new CodeProcessStoreError("process_outcome_unknown");
      if (["failed", "timed_out"].includes(command.state) && !Number.isInteger(command.exitCode)) throw new CodeProcessStoreError("process_outcome_unknown");
      op.state = command.state;
      if (command.state === "running") { op.startedAt ??= now.toISOString(); journal(op, "process.started"); }
      else if (!activeCodeProcess(op)) { op.settledAt = now.toISOString(); journal(op, "process.settled"); }
    }
    if (command.exitCode !== undefined) op.exitCode = command.exitCode;
    if (command.output) {
      if (command.outputOffset !== undefined && command.outputOffset > op.output.next) { op.output.next = command.outputOffset; op.output.text = ""; op.output.lossy = true; }
      if (command.outputOffset !== undefined && command.outputOffset < op.output.next) throw new CodeProcessStoreError("process_output_conflict");
      op.output.next += command.output.length;
      op.output.text = (op.output.text + command.output).slice(-64000);
      op.output.earliest = op.output.next - op.output.text.length;
      journal(op, "process.output");
    }
    if (command.lossy) op.output.lossy = true;
    if (command.promoted && !op.promoted) { op.promoted = true; journal(op, "process.promoted"); }
  } else if (command.kind === "reserve-child") {
    /**
     * Step 5: the delegation record. Idempotent by the join key `(parentRunId, toolCallId)` — expressed as the
     * deterministic child run id — so a retried tool call re-reads the delegation it already created instead of
     * starting a second child. The parent's run lease must be live: a detached child started by a run nobody owns
     * would be work with no owner and no terminal path.
     */
    live(command.runId, command.owner);
    const existing = next.operations.find((op) => op.kind === "subagent" && op.child?.runId === command.childRunId);
    if (existing) {
      if (existing.runId !== command.runId || existing.sessionId !== scope.sessionId || existing.child?.toolCallId !== command.toolCallId) {
        throw new CodeProcessStoreError("subagent_child_conflict");
      }
    } else {
      if (next.cleanupToken) throw new CodeProcessStoreError("sandbox_cleanup_in_progress");
      const siblings = next.operations.filter((op) => op.kind === "subagent" && op.runId === command.runId
        && op.sessionId === scope.sessionId && activeCodeProcess(op));
      const limit = Math.max(1, Math.min(4, Math.floor(command.maxParallelism ?? 4)));
      if (!Number.isFinite(limit) || siblings.length >= limit) throw new CodeProcessStoreError("subagent_parallelism_exceeded", 429);
      if (command.delegation?.readOnly === false) {
        const paths = command.delegation.paths;
        if (!Array.isArray(paths) || !paths.length || paths.some((path) => typeof path !== "string" || !path)) {
          throw new CodeProcessStoreError("subagent_write_scope_conflict");
        }
        for (const sibling of siblings) {
          if (sibling.delegation?.readOnly !== false) continue;
          const other = sibling.delegation.paths;
          if (!Array.isArray(other) || !other.length || other.some((left) => typeof left !== "string"
            || paths.some((right) => left === right || left.startsWith(`${right}/`) || String(right).startsWith(`${left}/`)))) {
            throw new CodeProcessStoreError("subagent_write_scope_conflict");
          }
        }
      }
      if (next.operations.filter((op) => op.sessionId === scope.sessionId && activeCodeProcess(op)).length >= 10) {
        throw new CodeProcessStoreError("process_limit", 429);
      }
      const op: DurableCodeProcess = {
        ...scope, operationId: command.operationId, processId: `subagent:${command.childRunId}`, executionKey: `subagent:${scope.companyId}:${scope.projectId}:${scope.sessionId}:${command.runId}:${command.toolCallId}`,
        runId: command.runId, owner: command.owner, generation: 1, payloadHash: command.toolCallId, agentId: command.agentType,
        sandboxId: null, startedRevision: 0, state: "accepted", exitCode: null,
        cancelRequested: false, promoted: false, createdAt: now.toISOString(), startedAt: null, settledAt: null,
        output: { text: "", earliest: 0, next: 0, lossy: false }, events: [], seq: 0,
        kind: "subagent", child: { runId: command.childRunId, toolCallId: command.toolCallId, agentType: command.agentType },
        ...(command.delegation ? { delegation: command.delegation } : {}),
      };
      next.operations.push(op); journal(op, "subagent.accepted");
      reserved = true;
    }
  } else if (command.kind === "bind-child-session" || command.kind === "continue-child") {
    const op = next.operations.find((candidate) => candidate.kind === "subagent" && candidate.child?.runId === command.childRunId && candidate.sessionId === scope.sessionId);
    if (!op?.child) throw new CodeProcessStoreError("process_not_found", 404);
    if (command.kind === "bind-child-session") {
      if (op.child.sessionId && op.child.sessionId !== command.childSessionId) throw new CodeProcessStoreError("subagent_child_conflict");
      if (op.state !== "accepted" && !op.child.sessionId) throw new CodeProcessStoreError("subagent_child_conflict");
      op.child.sessionId = command.childSessionId;
    } else {
      if (op.child.continueRequestId === command.requestId || op.child.continueRequestIds?.includes(command.requestId)) return { state: next, result: { operations: [structuredClone(op)], claimed: false, cleanupAcquired: false, reserved: false } };
      const lease = leases.find((l) => l.runId === command.childRunId && l.sessionId === (op.child?.sessionId ?? scope.sessionId) && l.live && l.owner === command.owner);
      if (!lease || op.completion || op.child.stopRequested || !["interrupted", "running", "unknown_outcome"].includes(op.state)) throw new CodeProcessStoreError("process_lease_lost");
      const previousRequests = op.child.continueRequestIds ?? (op.child.continueRequestId ? [op.child.continueRequestId] : []);
      op.child.owner = command.owner; op.child.continueRequestId = command.requestId;
      op.child.continueRequestIds = [...previousRequests, command.requestId];
      op.cancelRequested = false; op.state = "running"; claimed = true; journal(op, "subagent.continued");
    }
  } else if (command.kind === "update-child") {
    /**
     * The child's own runner does not know its operation id, so the settlement is keyed by the child run id.
     *
     * Two different leases fence two different transitions, and that is deliberate. In both, `command.owner` is
     * **the owner that transition has to hold**, which is why one command carries two identities depending on the
     * state it moves to:
     *
     *  - **`accepted` → `running`** belongs to the **parent**: the operation was created by the parent's tool call,
     *    and the child's run row may not exist yet at the moment the delegation is recorded. So `command.owner` is
     *    the parent run's owner, checked against the parent run's lease — the one that certainly exists.
     *  - **terminal** belongs to the **child run**: `command.owner` is the identity the child run was started
     *    under (its own `runStateOwner`, derived from the child run id by the delegation). A child run whose lease
     *    is **live** under any other owner is still being driven by somebody else, so the settlement is refused;
     *    a child with no run row at all, or one whose run has already ended, is settled from the durable operation
     *    — which is the honest reading of "the child produced no run of its own" and of "its run is over", and is
     *    exactly what a recovery after a crash has to be able to write.
     */
    const op = next.operations.find((candidate) => candidate.kind === "subagent" && candidate.child?.runId === command.childRunId && candidate.sessionId === scope.sessionId);
    if (!op) throw new CodeProcessStoreError("process_not_found", 404);
    if (command.state === "running") {
      const startLease = leases.find((entry) => entry.runId === op.runId && entry.sessionId === scope.sessionId && entry.live && entry.owner === command.owner);
      if (!startLease) throw new CodeProcessStoreError("process_lease_lost");
      if (op.cancelRequested) throw new CodeProcessStoreError("process_cancel_requested");
      if (op.state === "accepted") {
        op.state = "running"; op.startedAt = now.toISOString(); op.cancelRequested = false; journal(op, "subagent.started");
        claimed = true;
      }
    } else if (command.state) {
      if (op.child?.owner && op.child.owner !== command.owner) throw new CodeProcessStoreError("process_lease_lost");
      const childLease = leases.find((entry) => entry.runId === command.childRunId && entry.sessionId === (op.child?.sessionId ?? scope.sessionId));
      if (childLease?.live && childLease.owner !== command.owner) throw new CodeProcessStoreError("process_lease_lost");
      if (activeCodeProcess(op)) {
        op.state = command.state;
        op.exitCode = command.state === "interrupted" ? null : command.state === "completed" ? 0 : 1;
        op.settledAt = command.state === "interrupted" ? null : now.toISOString();
        /**
         * The child's **outcome** goes into the operation's free-text slot. For a sub-agent that slot is metadata
         * by construction: the answer the handoff digest builder parses (findings, paths, symbols, counts) plus the
         * failure code — never a transcript, a file body or tool output, which the child runner never produces for
         * a delegation in the first place. The collector rebuilds the parent's digest from it through the same
         * builder the blocking path uses, so the two paths cannot disagree about what a handoff may contain.
         */
        op.output.text = serializeChildOutcome(command.outcome, command.errorCode);
        op.output.next = op.output.text.length;
        op.output.earliest = 0;
        op.output.lossy = false;
        journal(op, "subagent.settled");
      }
    }
  } else if (command.kind === "cancel") {
    const op = owned(command.operationId);
    if (command.terminal && op.child && !op.child.stopRequested) { op.child.stopRequested = true; journal(op, "subagent.stop_requested"); }
    if (activeCodeProcess(op) && !op.cancelRequested) { op.cancelRequested = true; journal(op, "process.cancel_requested"); }
    if (op.state === "accepted" && op.kind !== "subagent") { op.state = "stopped"; op.settledAt = now.toISOString(); journal(op, "process.settled"); }
  } else if (command.kind === "idle-check") {
    cleanupAcquired = !next.cleanupToken && !next.operations.some(activeCodeProcess);
  } else if (command.kind === "cleanup-acquire") {
    if (!next.cleanupToken && !next.operations.some(activeCodeProcess) && (command.purpose === "prepare" || !leases.some((lease) => lease.live))) { next.cleanupToken = command.token; cleanupAcquired = true; }
  } else if (command.kind === "cleanup-release") {
    if (next.cleanupToken !== command.token) throw new CodeProcessStoreError("sandbox_cleanup_fence_lost");
    next.cleanupToken = null;
  } else if (command.kind === "completion-delivered" || command.kind === "completion-admit") {
    const op = owned(command.operationId), completion = op.completion;
    if (!completion || completion.notice.eventId !== command.eventId || completion.notice.generation !== command.generation || op.generation !== command.generation) throw new CodeProcessStoreError("completion_stale");
    if (command.kind === "completion-delivered") {
      if (!completion.deliveredAt) { completion.deliveredAt = now.toISOString(); journal(op, "completion.delivered"); }
    } else {
      live(command.runId, command.owner);
      if (command.canonicalResult.length > 64000) throw new CodeProcessStoreError("completion_result_too_large", 400);
      if (completion.admission) {
        if (completion.admission.runId !== command.runId || completion.admission.canonicalResult !== command.canonicalResult) throw new CodeProcessStoreError("completion_already_admitted");
      } else {
        completion.admission = { runId: command.runId, turnIndex: command.turnIndex, kind: command.source, canonicalResult: command.canonicalResult };
        journal(op, "result.admitted");
      }
    }
  }
  // The classified terminal snapshot and its outbox intent commit in the SAME project transaction. A sub-agent
  // delegation settles through the same block, so it uses the same outbox, the same delivery flag and the same
  // inbox identity as a process completion; only the notice's `type` and, for a child, its run ids differ.
  const settledNow = (op: DurableCodeProcess): boolean => {
    if (op.kind === "subagent") {
      return command.kind === "update-child" && command.state !== undefined && command.state !== "running"
        && command.childRunId === op.child?.runId;
    }
    return command.kind === "update" && command.operationId === op.operationId;
  };
  for (const op of next.operations) {
    if (settledNow(op) && !activeCodeProcess(op) && !op.completion && (op.kind === "subagent" || op.startedAt || op.workspaceSnapshot)) {
      journal(op, "operation.settled");
      const eventId = `${op.operationId}:${op.generation}:${op.seq}`;
      const isChild = op.kind === "subagent" && !!op.child;
      op.completion = {
        notice: {
          eventId, operationId: op.operationId, processId: op.processId, generation: op.generation,
          parentRunId: op.runId, parentOwner: op.owner, type: isChild ? "subagent" : "process", status: op.state,
          resultRef: `code-process:${eventId}`,
          ...(op.child ? { childRunId: op.child.runId, childToolCallId: op.child.toolCallId } : {}),
        },
        result: {
          state: op.state, exitCode: op.exitCode,
          /**
           * The free-text slot carries the child's settled outcome as JSON (`serializeChildOutcome`), which is
           * metadata by construction: the answer the digest builder parses, the changed paths, the counts and the
           * failure code. Copying it into the completion is what lets the parent's collector rebuild the handoff
           * from the completion record alone; leaving it empty made every settled child read as "produced nothing".
           * A process keeps its own stream output and cursors.
           */
          output: op.output.text,
          earliestOffset: op.output.earliest, nextOffset: op.output.next, lossy: op.output.lossy,
        },
        deliveredAt: null,
      };
    }
  }
  const operations = next.operations.filter((op) => op.sessionId === scope.sessionId
    && (command.kind !== "read" || (!command.operationId || op.operationId === command.operationId) && (!command.processId || op.processId === command.processId)));
  if (command.kind === "read" && (command.operationId || command.processId) && !operations.length) throw new CodeProcessStoreError("process_not_found", 404);
  return { state: next, result: structuredClone({ operations, claimed, cleanupAcquired, reserved }) };
}
