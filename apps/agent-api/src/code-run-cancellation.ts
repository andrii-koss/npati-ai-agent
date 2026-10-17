/**
 * C7 — cancellation registry for code runs.
 *
 * Why this exists at all: the runner already accepts a `cancelRequested` probe and an `AbortSignal`, but
 * nothing could flip either one from outside a chat stream. Stop therefore needs a place to record "this
 * session was asked to stop" that the loop can observe at its next step boundary.
 *
 * Two deliberate properties:
 *
 * 1. Cancellation is recorded **per session**, not per run. The runner learns its own `runId` only after it
 *    starts the run, so a per-run key could not be set before the loop exists; the session is the identity
 *    the caller (and the user) actually holds.
 * 2. It is **in-process** and that limit is stated rather than hidden: a Stop issued to a replica that does not
 *    own the run cannot reach the loop through this registry. That case is *not* silently lost — C6a's lease
 *    expiry plus the reconciler already move a run whose owner vanished to `interrupted`, and the route reports
 *    whether a live controller was found. A cross-replica cancel channel is a separate piece of work and is
 *    deliberately not invented here.
 */
export interface CodeRunCancellationRecord {
  sessionId: string;
  companyId: string;
  projectId: string | null;
  runId: string | null;
  requestedAt: string;
  requestedBy: string;
  reason: string;
}

export class CodeRunCancellationRegistry {
  private readonly bySession = new Map<string, CodeRunCancellationRecord>();
  /** Live aborts for runs owned by this process, so a Stop can interrupt a run that is mid-step. */
  private readonly controllers = new Map<string, Set<AbortController>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  requestSessionCancel(input: {
    sessionId: string;
    companyId: string;
    projectId?: string | null;
    requestedBy: string;
    reason?: string;
    runId?: string | null;
  }): CodeRunCancellationRecord {
    const record: CodeRunCancellationRecord = {
      sessionId: input.sessionId,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      runId: input.runId ?? null,
      requestedAt: new Date(this.now()).toISOString(),
      requestedBy: input.requestedBy,
      reason: input.reason ?? "user_stop",
    };
    this.bySession.set(input.sessionId, record);
    return record;
  }

  /** The probe the runner calls between steps. Absent entry means "not cancelled". */
  isSessionCancelled(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  getSessionCancellation(sessionId: string): CodeRunCancellationRecord | null {
    return this.bySession.get(sessionId) ?? null;
  }

  registerController(sessionId: string, controller: AbortController): void {
    const set = this.controllers.get(sessionId) ?? new Set<AbortController>();
    set.add(controller);
    this.controllers.set(sessionId, set);
  }

  unregisterController(sessionId: string, controller: AbortController): void {
    const set = this.controllers.get(sessionId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.controllers.delete(sessionId);
  }

  /**
   * Aborts every live controller for the session. Returns how many were aborted so the route can tell the
   * caller whether a run owned by this process was actually reached, instead of implying it always was.
   */
  abortLiveRuns(sessionId: string, reason?: unknown): number {
    const set = this.controllers.get(sessionId);
    if (!set || set.size === 0) return 0;
    let aborted = 0;
    for (const controller of [...set]) {
      try {
        controller.abort(reason);
        aborted += 1;
      } catch {
        // An already-aborted controller must not make Stop fail.
      }
    }
    return aborted;
  }

  hasLiveRun(sessionId: string): boolean {
    return (this.controllers.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Clears a session's cancellation. Called when a new run starts for that session, because a previous Stop
   * must not leak into the next run: a stale flag would cancel work the user never asked to stop.
   */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  size(): number {
    return this.bySession.size;
  }
}
