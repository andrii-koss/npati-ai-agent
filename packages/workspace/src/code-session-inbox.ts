import type { DataClassification, RetentionClass } from "./types";
import { createHash } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import type { CodeCompletionNotice } from "./code-process-store";

/** Input lifecycle only. Run execution, leases and recovery remain owned by C6a/C10. */
export interface CodeInboxMessage {
  id: string;
  requestId: string;
  /** Immutable submit identity; edits change content, never the accepted request. */
  requestFingerprint?: string;
  mode?: "queue" | "steer";
  authorId: string;
  text: string;
  target: "next-turn" | "next-step";
  status: "pending" | "claimed" | "admitted" | "discarded";
  runId: string | null;
  turnIndex: number | null;
  revision: number;
  createdAt: string;
  completion?: CodeCompletionNotice;
}
export interface CodeInboxEvent {
  seq: number;
  type: "input.accepted" | "input.claimed" | "input.admitted" | "input.discarded" | "input.updated" | "task.opened" | "task.sealed" | "task.closed" | "task.paused" | "task.interrupted" | "task.dispatch_failed";
  messageId: string | null;
  runId: string | null;
}
/**
 * N1: the run that **yielded** the session without reaching a terminal state.
 *
 * A pause (C9 question, C11 approval) and a C10 resume both leave the run's C6a lease `live` while nothing is
 * driving the loop — a pause stops the heartbeat, a resume takes the lease and hands the continuation prompt
 * back to its caller. The inbox used to read that live lease as "the session is occupied", so a continuation
 * that mints a **new** run id was refused with `session_run_held` until the lease expired. This marker is the
 * proof that the old run released the session on purpose, which is a fact no lease can express.
 */
export interface CodeInboxYield {
  runId: string;
  owner: string;
  at: string;
}
export interface CodeInboxState {
  revision: number;
  runId: string | null;
  phase: "idle" | "reserved" | "running" | "sealed" | "settled";
  messages: CodeInboxMessage[];
  events: CodeInboxEvent[];
  lastError: string | null;
  completionWakeTimes?: string[];
  /** Additive to the persisted JSON: an absent value means "no run has yielded", which is the pre-N1 behaviour. */
  yielded?: CodeInboxYield | null;
}
export interface CodeInboxScope {
  companyId: string;
  projectId: string;
  sessionId: string;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}
export type CodeInboxCommand =
  | { kind: "read" }
  | { kind: "completion-submit"; notice: CodeCompletionNotice; authorId: string }
  | { kind: "completion-consume"; eventId: string }
  | { kind: "submit"; id: string; requestId: string; authorId: string; text: string; mode: "queue" | "steer"; expectedRevision?: number }
  | { kind: "edit"; id: string; text: string; expectedRevision: number }
  | { kind: "discard"; id: string; expectedRevision: number }
  | { kind: "take-task"; authorId?: string }
  | { kind: "release-task"; runId: string }
  | { kind: "recover-interrupted-task"; runId: string }
  /**
   * N1: the run is not driving the session any more, although it has not reached a terminal state. Written by
   * the pause path (the loop stopped on a human decision) and by a resume (which takes the lease and hands the
   * continuation prompt back to its caller). It records **which** run yielded, so only that run's own claim can
   * be released and a live driver that never yielded still fences the session.
   */
  | { kind: "pause"; runId: string; owner: string }
  | { kind: "dispatch-error" }
  | { kind: "open"; runId: string; owner: string; initialMessageId?: string }
  | { kind: "drain"; runId: string; owner: string; turnIndex: number }
  | { kind: "resume-inputs"; runId: string; owner: string }
  | { kind: "collect-completions"; runId: string; owner: string }
  | { kind: "seal"; runId: string; owner: string }
  | { kind: "close"; runId: string; owner: string };
export interface CodeInboxResult {
  state: CodeInboxState;
  messages: CodeInboxMessage[];
  sealed: boolean;
}
export interface CodeInboxStore {
  /** Backend transaction locks the session and checks C6a leases before applying a command. */
  transact(scope: CodeInboxScope, command: CodeInboxCommand): Promise<CodeInboxResult>;
}
export interface CodeInboxLease {
  runId: string;
  owner: string | null;
  live: boolean;
  terminal: boolean;
  interrupted?: boolean;
}
export class CodeInboxError extends Error {
  constructor(readonly code: string, readonly httpStatus = 409) { super(code); }
}
export function emptyCodeInbox(): CodeInboxState {
  return { revision: 0, runId: null, phase: "idle", messages: [], events: [], lastError: null, yielded: null };
}

/** Same transition rules in both backends. No asynchronous gap inside a transition. */
export function applyCodeInbox(
  original: CodeInboxState,
  command: CodeInboxCommand,
  leases: readonly CodeInboxLease[],
  now: Date,
): CodeInboxResult {
  const state = structuredClone(original);
  if (command.kind === "submit" || command.kind === "edit") assertNoSecrets(command.text);
  const delivered: CodeInboxMessage[] = [];
  const live = (runId: string | null) => leases.find((lease) => lease.runId === runId && lease.live);
  const event = (type: CodeInboxEvent["type"], messageId: string | null = null, runId: string | null = state.runId) => {
    state.revision++;
    state.events.push({ seq: state.revision, type, messageId, runId });
  };
  const fence = (runId: string, owner: string) => {
    if (state.runId !== runId || live(runId)?.owner !== owner) throw new CodeInboxError("inbox_lease_lost");
  };
  const pending = (target: CodeInboxMessage["target"]) => state.messages.filter((m) => m.status === "pending" && m.target === target);
  const admit = (message: CodeInboxMessage, runId: string, turnIndex: number) => {
    message.status = "admitted";
    message.runId = runId;
    message.turnIndex = turnIndex;
    message.revision++;
    event("input.admitted", message.id);
    delivered.push(message);
  };
  if (command.kind === "completion-submit") {
    const notice = command.notice;
    const existing = state.messages.find((m) => m.completion?.eventId === notice.eventId);
    if (existing) delivered.push(existing);
    else {
      if (pending("next-turn").length + pending("next-step").length >= 100) throw new CodeInboxError("inbox_full", 429);
      const target = state.phase === "running" && state.runId === notice.parentRunId && live(state.runId)?.owner === notice.parentOwner ? "next-step" : "next-turn";
      const message: CodeInboxMessage = { id: `completion-${notice.eventId}`, requestId: `completion-${notice.eventId}`, authorId: command.authorId,
        text: `Process ${notice.processId} settled: ${notice.status}. Result: ${notice.resultRef}`, completion: structuredClone(notice),
        target, status: "pending", runId: null, turnIndex: null, revision: 1, createdAt: now.toISOString() };
      state.messages.push(message); event("input.accepted", message.id, target === "next-step" ? state.runId : null); delivered.push(message);
    }
  } else if (command.kind === "completion-consume") {
    const message = state.messages.find((m) => m.completion?.eventId === command.eventId && m.status === "pending");
    if (message) { message.status = "discarded"; message.revision++; event("input.discarded", message.id); }
  } else if (command.kind === "submit") {
    const requestFingerprint = createHash("sha256").update(JSON.stringify([command.authorId, command.text, command.mode])).digest("hex");
    const duplicate = state.messages.find((m) => m.requestId === command.requestId);
    if (duplicate) {
      if (duplicate.authorId !== command.authorId || (duplicate.requestFingerprint
        ? duplicate.requestFingerprint !== requestFingerprint : duplicate.text !== command.text)) throw new CodeInboxError("inbox_request_conflict");
      delivered.push(duplicate);
    } else {
      if (command.expectedRevision !== undefined && command.expectedRevision !== state.revision) throw new CodeInboxError("inbox_revision_conflict");
      if (!command.text.trim() || command.text.length > 16_000 || !command.requestId || command.requestId.length > 128) throw new CodeInboxError("invalid_arguments", 400);
      if (pending("next-turn").length + pending("next-step").length >= 100
        || state.messages.filter(m => m.status === "pending" || m.status === "claimed").reduce((size, m) => size + m.text.length, command.text.length) > 2_000_000) throw new CodeInboxError("inbox_full", 429);
      const target = command.mode === "steer" && state.phase === "running" && live(state.runId) ? "next-step" : "next-turn";
      const message: CodeInboxMessage = { id: command.id, requestId: command.requestId, requestFingerprint, authorId: command.authorId, mode: command.mode,
        text: command.text, target, status: "pending", runId: null, turnIndex: null, revision: 1, createdAt: now.toISOString() };
      state.messages.push(message);
      event("input.accepted", message.id, target === "next-step" ? state.runId : null);
      delivered.push(message);
    }
  } else if (command.kind === "edit" || command.kind === "discard") {
    const message = state.messages.find((m) => m.id === command.id);
    if (!message || message.completion || message.status !== "pending") throw new CodeInboxError("inbox_message_not_pending");
    if (message.revision !== command.expectedRevision) throw new CodeInboxError("inbox_revision_conflict");
    if (command.kind === "edit") {
      if (!command.text.trim() || command.text.length > 16_000) throw new CodeInboxError("invalid_arguments", 400);
      if (state.messages.filter(m => m.status === "pending" || m.status === "claimed").reduce((size, m) => size + (m.id === message.id ? command.text.length : m.text.length), 0) > 2_000_000) throw new CodeInboxError("inbox_full", 429);
      message.text = command.text;
      event("input.updated", message.id);
    } else {
      message.status = "discarded";
      event("input.discarded", message.id);
    }
    message.revision++;
    delivered.push(message);
  } else if (command.kind === "dispatch-error") {
    state.lastError = "inbox_dispatch_failed";
    event("task.dispatch_failed");
  } else if (command.kind === "take-task") {
    if (state.phase === "reserved" && state.runId && !leases.some((l) => l.runId === state.runId)) {
      // Crash before C6a created the run: no tool dispatch is possible; retry the SAME id.
      delivered.push(...state.messages.filter((m) => m.status === "claimed" && m.runId === state.runId
        && (command.authorId === undefined || m.authorId === command.authorId)));
    } else if (state.phase === "idle" && !leases.some((l) => l.live)) {
      const times = (state.completionWakeTimes ?? []).filter((at) => now.getTime() - Date.parse(at) < 3600000);
      const message = pending("next-turn").find((m) => !m.completion || times.length < 10);
      if (message && (command.authorId === undefined || message.authorId === command.authorId)) {
        if (message.completion) {
          state.completionWakeTimes = [...times, now.toISOString()];
        }
        state.runId = `code-inbox-${message.id}`;
        state.phase = "reserved";
        message.status = "claimed";
        message.runId = state.runId;
        message.revision++;
        event("input.claimed", message.id);
        delivered.push(message);
      }
    }
  } else if (command.kind === "release-task") {
    if (state.runId === command.runId && leases.some((l) => l.runId === command.runId && l.terminal) && !live(command.runId)) {
      state.phase = "idle";
      state.yielded = null;
      event("task.closed");
    }
  } else if (command.kind === "recover-interrupted-task") {
    // A crash leaves no transport to close the inbox. The transaction rechecks the durable run under the
    // same lock as admission: a resumed/live run must never be released by a stale recovery read.
    const lease = leases.find(entry => entry.runId === command.runId);
    if (state.runId === command.runId && state.phase !== "idle" && lease?.interrupted && !lease.live) {
      state.phase = "idle";
      state.yielded = null;
      // Retain runId and every input: the same interrupted run can still resume its admitted messages.
      event("task.interrupted");
    }
  } else if (command.kind === "pause") {
    /**
     * N1: the run holds its task but is not driving it. The phase deliberately stays `running` because the task is
     * still this run's — its admitted messages must remain recoverable by a resume of the **same** run id — and
     * only `open` reads the marker, to let a continuation proceed.
     *
     * The fence is the **identity on the run's lease**, not its liveness, and that is the whole point of the
     * command: the runner marks the run `waiting_for_user` and a release marks it `interrupted` *before* this
     * write, and neither state is `running` — so a `live` test would refuse exactly the transition this command
     * exists for, and N1's marker would never be recorded. `state.runId === command.runId` keeps the marker on the
     * task's own run, `lease.owner === command.owner` keeps it to the worker that owns that run (a stranger is
     * still refused, so the marker cannot be forged), and a run that already reached a terminal state is refused
     * because it is not yielding anything. A marker can only ever *permit* a takeover (`open`), never deny one, so
     * this widening does not weaken the `session_run_held` fence that `open` applies to a live driver.
     */
    if (state.runId === command.runId) {
      const lease = leases.find((entry) => entry.runId === command.runId);
      if (!lease || lease.owner !== command.owner || lease.terminal) throw new CodeInboxError("inbox_lease_lost");
      if (state.yielded?.runId !== command.runId) {
        state.yielded = { runId: command.runId, owner: command.owner, at: now.toISOString() };
        event("task.paused");
      }
    }
  } else if (command.kind === "open") {
    if (live(command.runId)?.owner !== command.owner) throw new CodeInboxError("inbox_lease_lost");
    // A sealed or settled epoch holds the session until its cleanup releases it (`release-task`, terminal runs only).
    // An interrupted run whose lease expired is neither live nor terminal, so nothing would ever release it: its
    // closed epoch must not block every later run of the session.
    const prior = leases.find((lease) => lease.runId === state.runId);
    const abandoned = state.phase === "settled" && prior !== undefined && !prior.live && !prior.terminal;
    if (["reserved", "sealed", "settled"].includes(state.phase) && state.runId !== command.runId && !abandoned) throw new CodeInboxError("session_run_held");
    /**
     * N1: the fence refuses a second driver of one session — a run that is live and has **not** yielded. A run
     * that yielded (the pause path, a resume that only rebuilt the continuation prompt) is not driving anything,
     * so the continuation the user just asked for may take the session. The check stays in front of the ordinary
     * case: two live runs of one session, neither of which yielded, still conflict exactly as before.
     */
    const priorRunYielded = state.yielded?.runId === state.runId && state.runId !== command.runId;
    if (state.phase !== "idle" && state.runId !== command.runId && live(state.runId) && !priorRunYielded) throw new CodeInboxError("session_run_held");
    state.runId = command.runId;
    state.phase = "running";
    state.yielded = null;
    state.lastError = null;
    event("task.opened");
    if (command.initialMessageId) {
      const message = state.messages.find((m) => m.id === command.initialMessageId);
      if (!message || message.runId !== command.runId || !["claimed", "admitted"].includes(message.status) || message.target !== "next-turn") throw new CodeInboxError("inbox_message_not_pending");
      if (message.status === "claimed") admit(message, command.runId, 0);
      else if (message.completion) delivered.push(message);
    }
    // Inputs admitted before a crash are recoverable independently of a terminal replay bundle.
    delivered.push(...state.messages.filter((m) => m.runId === command.runId && m.status === "admitted" && m.turnIndex !== 0 && m.id !== command.initialMessageId));
  } else if (command.kind === "resume-inputs") {
    if (live(command.runId)?.owner !== command.owner || (state.runId && state.runId !== command.runId)) throw new CodeInboxError("inbox_lease_lost");
    for (const message of pending("next-turn").filter((m) => m.mode === "steer")) { message.target = "next-step"; event("input.updated", message.id); }
  } else if (command.kind === "collect-completions") {
    // Step 7: a completion delivered while its parent was paused (or before C10 changed owner)
    // still belongs to that same run. Only its current lease can move it across the cutoff.
    fence(command.runId, command.owner);
    if (state.phase !== "running") throw new CodeInboxError("inbox_task_sealed");
    for (const message of pending("next-turn").filter(m => m.completion?.parentRunId === command.runId)) {
      message.target = "next-step";
      event("input.updated", message.id);
    }
  } else if (command.kind === "drain") {
    fence(command.runId, command.owner);
    if (state.phase !== "running") throw new CodeInboxError("inbox_task_sealed");
    for (const message of pending("next-step")) admit(message, command.runId, command.turnIndex);
  } else if (command.kind === "seal") {
    fence(command.runId, command.owner);
    if (pending("next-step").length === 0) {
      state.phase = "sealed";
      event("task.sealed");
    }
  } else if (command.kind === "close") {
    // Closing a failed/interrupted epoch must never clear a replacement's inbox.
    if (state.runId === command.runId && live(command.runId)?.owner === command.owner) {
      state.phase = "settled";
      for (const message of pending("next-step")) message.target = "next-turn";
      event("task.closed");
    }
  }
  return structuredClone({ state, messages: delivered, sealed: state.phase === "sealed" });
}
