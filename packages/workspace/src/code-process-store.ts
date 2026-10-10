import type { DataClassification, RetentionClass } from "./types";

export type DurableProcessState = "accepted" | "preparing" | "dispatching" | "running" | "completed" | "failed" | "stopped" | "timed_out" | "lost" | "unknown_outcome";
export interface CodeProcessScope {
  companyId: string; projectId: string; sessionId: string;
  dataClassification: DataClassification; retentionClass: RetentionClass;
}
export interface DurableCodeProcess {
  operationId: string; executionKey: string; processId: string; companyId: string; projectId: string; sessionId: string;
  runId: string; owner: string; generation: number; payloadHash: string; agentId: string;
  sandboxId: string | null; startedRevision: number; state: DurableProcessState; exitCode: number | null;
  workspaceSnapshot?: { sandboxId: string; mounted: boolean; files: Array<{ path: string; revision: string; hash: string }> };
  cancelRequested: boolean; promoted: boolean; createdAt: string; startedAt: string | null; settledAt: string | null;
  output: { text: string; earliest: number; next: number; lossy: boolean };
  events: Array<{ seq: number; type: string }>; seq: number;
  completion?: CodeProcessCompletion;
}
export interface CodeCompletionNotice {
  eventId: string; operationId: string; processId: string; generation: number;
  parentRunId: string; parentOwner: string; type: "process"; status: DurableProcessState; resultRef: string;
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
  | { kind: "cancel"; operationId: string }
  | { kind: "completion-delivered"; operationId: string; eventId: string; generation: number }
  | { kind: "completion-admit"; operationId: string; eventId: string; generation: number; runId: string; owner: string; turnIndex: number; source: "wait" | "inbox"; canonicalResult: string }
  | { kind: "cleanup-acquire"; token: string; purpose?: "prepare" }
  | { kind: "idle-check" }
  | { kind: "cleanup-release"; token: string };
export interface CodeProcessStoreResult { operations: DurableCodeProcess[]; claimed: boolean; cleanupAcquired: boolean }
export interface CodeProcessStore {
  transact(scope: CodeProcessScope, command: CodeProcessCommand): Promise<CodeProcessStoreResult>;
}
export class CodeProcessStoreError extends Error {
  constructor(readonly code: string, readonly httpStatus = 409) { super(code); }
}
export const activeCodeProcess = (op: DurableCodeProcess) => ["accepted", "preparing", "dispatching", "running", "unknown_outcome"].includes(op.state);

/** Shared synchronous transitions. The backend serializes the project and locks current C6a run rows. */
export function applyCodeProcess(state: CodeProcessProjectState, scope: CodeProcessScope, command: CodeProcessCommand, leases: ProcessRunLease[], now: Date) {
  const next = structuredClone(state);
  let claimed = false, cleanupAcquired = false;
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
      if (next.operations.filter((op) => op.sessionId === scope.sessionId && activeCodeProcess(op)).length >= 10 || next.operations.length >= 1000) throw new CodeProcessStoreError("process_limit", 429);
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
  } else if (command.kind === "cancel") {
    const op = owned(command.operationId);
    if (activeCodeProcess(op) && !op.cancelRequested) { op.cancelRequested = true; journal(op, "process.cancel_requested"); }
    if (op.state === "accepted") { op.state = "stopped"; op.settledAt = now.toISOString(); journal(op, "process.settled"); }
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
  // The classified terminal snapshot and its outbox intent commit in the SAME project transaction.
  for (const op of next.operations) {
    if (command.kind === "update" && command.operationId === op.operationId && !activeCodeProcess(op) && !op.completion && (op.startedAt || op.workspaceSnapshot)) {
      journal(op, "operation.settled");
      const eventId = `${op.operationId}:${op.generation}:${op.seq}`;
      op.completion = { notice: { eventId, operationId: op.operationId, processId: op.processId, generation: op.generation,
        parentRunId: op.runId, parentOwner: op.owner, type: "process", status: op.state, resultRef: `code-process:${eventId}` },
        result: { state: op.state, exitCode: op.exitCode, output: op.output.text, earliestOffset: op.output.earliest, nextOffset: op.output.next, lossy: op.output.lossy }, deliveredAt: null };
    }
  }
  const operations = next.operations.filter((op) => op.sessionId === scope.sessionId
    && (command.kind !== "read" || (!command.operationId || op.operationId === command.operationId) && (!command.processId || op.processId === command.processId)));
  if (command.kind === "read" && (command.operationId || command.processId) && !operations.length) throw new CodeProcessStoreError("process_not_found", 404);
  return { state: next, result: structuredClone({ operations, claimed, cleanupAcquired }) };
}
