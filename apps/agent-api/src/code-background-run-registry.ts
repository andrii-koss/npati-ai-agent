/**
 * C10 (ТЗ item 5) — the registry that makes a long code run outlive the tab that started it.
 *
 * The defect this closes: the chat entry point ran the agent loop **inside** the HTTP request and aborted it from
 * `reply.raw.once("close", …)`. Closing the tab therefore killed the run mid-write — the worst possible moment,
 * because the loop may be between a tool call and its result.
 *
 * Two things change, and nothing else:
 *
 *  1. **Ownership of the abort signal.** A background run no longer borrows the client's `AbortController`; the
 *     registry mints its own and hands the runner that one. The transport controller is still aborted when the
 *     client disconnects, because that controller also cancels the *streaming* (delta) work — but the run's own
 *     signal is untouched by a disconnect. Stopping a background run is consequently an explicit act
 *     (`POST /code/sessions/:sessionId/stop`, the existing C7 route), never an accident of a closing socket.
 *  2. **A replayable event buffer with a subscriber set.** Every event the run emits is appended with a
 *     monotonic `seq` and pushed to the subscribers that are attached *now*. A client that reconnects
 *     (`GET /code/runs/:runId/background-stream?expectedRunId=…&fromSeq=…`) receives the missed tail and then
 *     live events, so "return to the stream" works after a reload. The same state is reachable without SSE
 *     (`GET /code/runs/:runId/background`), which is the polling fallback a UI can use when a proxy buffers
 *     event streams.
 *
 * Bounded on purpose: the per-run event buffer and the number of runs the registry tracks both have hard caps, so
 * a process that runs for weeks cannot grow a map of finished runs without limit. The terminal event is always
 * retained even when the buffer overflows — a run whose completion notice was evicted would look like it never
 * finished.
 */

export type CodeBackgroundRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted" | "suspended_by_flag";

export interface CodeBackgroundRunEvent {
  /** Monotonic within one run, starting at 1. A subscriber's `fromSeq` filters on it. */
  seq: number;
  /** Durable ISO timestamp: the record is meant to be read after the fact, not only live. */
  at: string;
  event: "progress" | "delta" | "result" | "error" | "terminal";
  data: unknown;
}

export interface CodeBackgroundRunSnapshot {
  runId: string;
  sessionId: string;
  companyId: string;
  userId: string;
  projectId: string | null;
  status: CodeBackgroundRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  lastSeq: number;
  /** True while the run is still executing; a UI shows the spinner from this, never from a guess. */
  live: boolean;
  /** Why the run ended, when it did. */
  reason: string | null;
}

export interface CodeBackgroundRunSink {
  signal: AbortSignal;
  emit(event: "progress" | "delta" | "result" | "error", data: unknown): void;
  /** Finishes the run with its terminal status. Idempotent; the second call changes nothing. */
  finish(status: CodeBackgroundRunStatus, reason?: string | null): void;
}

export interface CodeBackgroundRunStartInput {
  runId: string;
  sessionId: string;
  companyId: string;
  userId: string;
  projectId?: string | null;
  /** Feature-flag check, evaluated once at registration so the decision is visible in the record. */
  onTerminal?: (snapshot: CodeBackgroundRunSnapshot) => void | Promise<void>;
}

export interface CodeBackgroundRunReadResult {
  kind: "live" | "finished" | "unknown";
  snapshot: CodeBackgroundRunSnapshot;
  /** Events after `fromSeq`, in order. Always includes the terminal event of a finished run. */
  events: CodeBackgroundRunEvent[];
}

/** How many events one run keeps in memory. Sized for a long run's progress/delta chatter plus its results. */
export const CODE_BACKGROUND_RUN_EVENT_LIMIT = 500;
/** How many runs are tracked. The oldest finished run is evicted first; a live run is never evicted. */
export const CODE_BACKGROUND_RUN_TRACKED_LIMIT = 200;

interface TrackedRun {
  snapshot: CodeBackgroundRunSnapshot;
  events: CodeBackgroundRunEvent[];
  nextSeq: number;
  subscribers: Set<(event: CodeBackgroundRunEvent) => void>;
  abort: AbortController;
  finished: boolean;
  onTerminal?: (snapshot: CodeBackgroundRunSnapshot) => void | Promise<void>;
}

export interface CodeBackgroundRunRegistryOptions {
  /** Hard cap on tracked runs; a live run is never evicted to make room. */
  trackedLimit?: number;
  /** Hard cap on retained events per run. */
  eventLimit?: number;
  now?: () => number;
  logger?: { warn(payload: unknown, message?: string): void };
}

export class CodeBackgroundRunRegistry {
  private readonly runs = new Map<string, TrackedRun>();
  private readonly trackedLimit: number;
  private readonly eventLimit: number;
  private readonly now: () => number;
  private readonly logger?: CodeBackgroundRunRegistryOptions["logger"];

  constructor(options: CodeBackgroundRunRegistryOptions = {}) {
    this.trackedLimit = Math.max(1, Math.trunc(options.trackedLimit ?? CODE_BACKGROUND_RUN_TRACKED_LIMIT));
    this.eventLimit = Math.max(2, Math.trunc(options.eventLimit ?? CODE_BACKGROUND_RUN_EVENT_LIMIT));
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
  }

  /**
   * Registers a run and returns the sink the loop writes to. Registration happens **before** the first model call,
   * so a disconnect at any point after admission leaves a run the registry can describe and a client can rejoin.
   */
  start(input: CodeBackgroundRunStartInput): CodeBackgroundRunSink {
    this.evictFinished();
    const at = new Date(this.now()).toISOString();
    const tracked: TrackedRun = {
      snapshot: {
        runId: input.runId,
        sessionId: input.sessionId,
        companyId: input.companyId,
        userId: input.userId,
        projectId: input.projectId ?? null,
        status: "running",
        startedAt: at,
        updatedAt: at,
        finishedAt: null,
        lastSeq: 0,
        live: true,
        reason: null,
      },
      events: [],
      nextSeq: 1,
      subscribers: new Set(),
      abort: new AbortController(),
      finished: false,
      ...(input.onTerminal ? { onTerminal: input.onTerminal } : {}),
    };
    this.runs.set(input.runId, tracked);
    return {
      signal: tracked.abort.signal,
      emit: (event, data) => this.append(tracked, event, data),
      finish: (status, reason) => { void this.finish(tracked, status, reason ?? null); },
    };
  }

  /** The abort signal of a live background run, so the existing Stop route can reach it. `null` when unknown. */
  signalFor(runId: string): AbortSignal | null {
    const tracked = this.runs.get(runId);
    return tracked && !tracked.finished ? tracked.abort.signal : null;
  }

  /** Session id of a live background run, or `null`. Used by the Stop route to find what to abort. */
  sessionFor(runId: string): string | null {
    const tracked = this.runs.get(runId);
    return tracked && !tracked.finished ? tracked.snapshot.sessionId : null;
  }

  isLive(runId: string): boolean {
    return this.runs.get(runId)?.finished === false;
  }
  /** Operation hints share the existing progress stream; they never finish the whole run. */
  operationProgress(scope: { companyId: string; sessionId: string; userId: string }, data: unknown) {
    for (const tracked of this.runs.values()) {
      if (!tracked.finished && tracked.snapshot.companyId === scope.companyId && tracked.snapshot.sessionId === scope.sessionId && tracked.snapshot.userId === scope.userId) this.append(tracked, "progress", data);
    }
  }

  startSnapshot(runId: string): CodeBackgroundRunSnapshot | null {
    const tracked = this.runs.get(runId);
    return tracked ? { ...tracked.snapshot } : null;
  }

  /**
   * Aborts a live background run. The run's own `finally` records the terminal status, so this only signals; it
   * never writes the state itself (two writers of one terminal status is how a run ends up described twice).
   */
  abort(runId: string, reason = "Cancelled by an explicit request"): boolean {
    const tracked = this.runs.get(runId);
    if (!tracked || tracked.finished) return false;
    tracked.abort.abort(new Error(reason));
    return true;
  }

  /**
   * Reads a run's state and the events after `fromSeq`. An unknown run answers `unknown` with a snapshot that has
   * no ids in it, so the route can return one identical 404 for a foreign run and a nonexistent one.
   */
  read(runId: string, fromSeq = 0): CodeBackgroundRunReadResult {
    const tracked = this.runs.get(runId);
    if (!tracked) {
      return {
        kind: "unknown",
        snapshot: {
          runId: "",
          sessionId: "",
          companyId: "",
          userId: "",
          projectId: null,
          status: "interrupted",
          startedAt: new Date(this.now()).toISOString(),
          updatedAt: new Date(this.now()).toISOString(),
          finishedAt: null,
          lastSeq: 0,
          live: false,
          reason: null,
        },
        events: [],
      };
    }
    return {
      kind: tracked.finished ? "finished" : "live",
      snapshot: { ...tracked.snapshot },
      events: tracked.events.filter((event) => event.seq > fromSeq).map((event) => ({ ...event })),
    };
  }

  /**
   * Attaches a live subscriber. The returned detach function is idempotent. Events emitted before the call are not
   * replayed here — the caller reads `fromSeq` first and then subscribes, and the buffer fan-out below guarantees
   * no event can slip between the two.
   */
  subscribe(runId: string, listener: (event: CodeBackgroundRunEvent) => void): (() => void) | null {
    const tracked = this.runs.get(runId);
    if (!tracked) return null;
    tracked.subscribers.add(listener);
    return () => { tracked.subscribers.delete(listener); };
  }

  /** Every tracked run, newest first. Powers an operator/UI "background runs" list. */
  list(): CodeBackgroundRunSnapshot[] {
    return [...this.runs.values()]
      .map((tracked) => ({ ...tracked.snapshot }))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  /** Forgets a finished run. Refuses a live one: dropping a live record would hide work that is still running. */
  forget(runId: string): boolean {
    const tracked = this.runs.get(runId);
    if (!tracked || !tracked.finished) return false;
    this.runs.delete(runId);
    return true;
  }

  private append(tracked: TrackedRun, event: CodeBackgroundRunEvent["event"], data: unknown): void {
    if (tracked.finished) return;
    const entry: CodeBackgroundRunEvent = {
      seq: tracked.nextSeq,
      at: new Date(this.now()).toISOString(),
      event,
      data,
    };
    tracked.nextSeq += 1;
    tracked.snapshot = { ...tracked.snapshot, lastSeq: entry.seq, updatedAt: entry.at };
    tracked.events.push(entry);
    // A finished run keeps its terminal event even when the buffer is full; a live run drops the oldest first.
    while (tracked.events.length > this.eventLimit) tracked.events.shift();
    for (const subscriber of [...tracked.subscribers]) {
      try {
        subscriber(entry);
      } catch (error) {
        this.logger?.warn({ err: error, runId: tracked.snapshot.runId }, "code_background_run_subscriber_failed");
      }
    }
  }

  private async finish(tracked: TrackedRun, status: CodeBackgroundRunStatus, reason: string | null): Promise<void> {
    if (tracked.finished) return;
    tracked.finished = true;
    const at = new Date(this.now()).toISOString();
    tracked.snapshot = { ...tracked.snapshot, status, reason, finishedAt: at, updatedAt: at, live: false };
    const terminal: CodeBackgroundRunEvent = {
      seq: tracked.nextSeq,
      at,
      event: "terminal",
      data: { runId: tracked.snapshot.runId, sessionId: tracked.snapshot.sessionId, status, reason },
    };
    tracked.nextSeq += 1;
    tracked.snapshot = { ...tracked.snapshot, lastSeq: terminal.seq };
    tracked.events.push(terminal);
    while (tracked.events.length > this.eventLimit) tracked.events.shift();
    for (const subscriber of [...tracked.subscribers]) {
      try {
        subscriber(terminal);
      } catch (error) {
        this.logger?.warn({ err: error, runId: tracked.snapshot.runId }, "code_background_run_subscriber_failed");
      }
    }
    tracked.subscribers.clear();
    if (tracked.onTerminal) {
      try {
        await tracked.onTerminal({ ...tracked.snapshot });
      } catch (error) {
        // A notification failure must never change what the run did.
        this.logger?.warn({ err: error, runId: tracked.snapshot.runId }, "code_background_run_terminal_hook_failed");
      }
    }
  }

  /**
   * Evicts finished runs when the tracked cap is reached. The oldest finished run goes first; if every tracked run
   * is live, the cap is exceeded rather than a live run being dropped — losing a live record would silently turn a
   * running job into an invisible one.
   */
  private evictFinished(): void {
    if (this.runs.size < this.trackedLimit) return;
    const finished = [...this.runs.values()].filter((tracked) => tracked.finished);
    if (finished.length === 0) return;
    finished.sort((a, b) => (a.snapshot.startedAt < b.snapshot.startedAt ? -1 : 1));
    while (this.runs.size >= this.trackedLimit && finished.length > 0) {
      const oldest = finished.shift()!;
      this.runs.delete(oldest.snapshot.runId);
    }
  }
}
