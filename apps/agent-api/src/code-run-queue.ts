/**
 * C10 (ТЗ item 6) — the code-run admission queue: configured per-user/per-Company concurrency, a fair queue and
 * a state a UI can render.
 *
 * Why this exists rather than a reuse of `CompanyRunQueueProducer`/`CompanyRunQueueWorker`: that queue is a
 * Redis stream whose unit of work is a **durable Company run row** (`claimCompanyAgentRun`, `listRecoverableCompanyAgentRuns`,
 * lease/heartbeat in `company_agent_runs`). A code run has nothing equivalent — its durable record is
 * `code_run_states` with its own lease and its own recovery, and the payload the stream would have to carry is a
 * live `AuthContext`, a loaded session object and a prompt. Putting code runs on that stream would mean either a
 * second worker re-implementing the Company runtime, or a job body that no other replica can reconstruct. It is
 * also gated on `config.redisUrl`: without Redis the whole limit would silently disappear, which is exactly the
 * failure mode a limit must not have.
 *
 * So the limit lives here, in-process, and it is **fair**:
 *
 *  1. **Two independent caps.** `maxConcurrentPerUser` and `maxConcurrentPerCompany`, each configurable. A user
 *     and a Company are the two things a person can exhaust, so each gets its own counter and both must have room.
 *  2. **Round-robin across Companies, FIFO inside one.** The decisive property: a Company with a thousand queued
 *     runs cannot push a Company with one queued run to the back of the line. Companies are served in rotation
 *     (`rotateOrder`) and only then in arrival order, so a single tenant cannot starve the rest.
 *  3. **The queue is bounded.** A ticket that is never granted expires with `queue_timeout` and a queue longer than
 *     `maxQueueDepth` is refused with `queue_full` — an unbounded in-memory queue is a memory leak with a friendly
 *     name, and a client waiting forever is indistinguishable from a hang.
 *  4. **A released slot is granted synchronously to the next ticket.** The counter is decremented before the grant
 *     is resolved, so the invariant `active ≤ cap` is true at every await point and cannot be exceeded by a burst.
 */

export interface CodeRunQueueLimits {
  /** Concurrent code runs one user may hold. */
  maxConcurrentPerUser: number;
  /** Concurrent code runs one Company may hold. */
  maxConcurrentPerCompany: number;
  /** How long a ticket may wait for a slot before it is refused with `queue_timeout`. */
  queueTimeoutMs: number;
  /** How many tickets may wait at once (across all tenants). */
  maxQueueDepth: number;
}

/**
 * The R1 start values (section A, items 1 and 3). `maxConcurrentPerCompany` moved 4 → **5** and
 * `maxQueueDepth` moved 200 → **50** in R1: the first is the requirement's "5 parallel runs per Company", the
 * second is its "bounded queue length, start value 50". Both changes are explicit and both are only the
 * *default* — `NPATI_CODE_RUN_MAX_CONCURRENT_PER_COMPANY` and `NPATI_CODE_RUN_QUEUE_MAX_DEPTH` still override
 * them and every value is still clamped by the ceilings below. `maxConcurrentPerUser` now allows four chat projects;
 * `queueTimeoutMs` remains 120 seconds. Explicit operator limits still take precedence.
 */
export const DEFAULT_CODE_RUN_QUEUE_LIMITS: CodeRunQueueLimits = {
  maxConcurrentPerUser: 4,
  maxConcurrentPerCompany: 5,
  queueTimeoutMs: 120_000,
  maxQueueDepth: 50,
};

/** Hard ceilings: configuration may lower these, never raise them past the point a single node can serve. */
export const CODE_RUN_QUEUE_MAX_CONCURRENT_PER_USER = 16;
export const CODE_RUN_QUEUE_MAX_CONCURRENT_PER_COMPANY = 64;
export const CODE_RUN_QUEUE_MAX_DEPTH = 5_000;
export const CODE_RUN_QUEUE_MAX_TIMEOUT_MS = 15 * 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the queue limits from the environment. Every value is clamped, so a typo cannot remove the limit. */
export function resolveCodeRunQueueLimits(env: NodeJS.ProcessEnv = process.env): CodeRunQueueLimits {
  return {
    maxConcurrentPerUser: Math.min(
      positiveInt(env.NPATI_CODE_RUN_MAX_CONCURRENT_PER_USER, DEFAULT_CODE_RUN_QUEUE_LIMITS.maxConcurrentPerUser),
      CODE_RUN_QUEUE_MAX_CONCURRENT_PER_USER,
    ),
    maxConcurrentPerCompany: Math.min(
      positiveInt(env.NPATI_CODE_RUN_MAX_CONCURRENT_PER_COMPANY, DEFAULT_CODE_RUN_QUEUE_LIMITS.maxConcurrentPerCompany),
      CODE_RUN_QUEUE_MAX_CONCURRENT_PER_COMPANY,
    ),
    queueTimeoutMs: Math.min(
      positiveInt(env.NPATI_CODE_RUN_QUEUE_TIMEOUT_MS, DEFAULT_CODE_RUN_QUEUE_LIMITS.queueTimeoutMs),
      CODE_RUN_QUEUE_MAX_TIMEOUT_MS,
    ),
    maxQueueDepth: Math.min(
      positiveInt(env.NPATI_CODE_RUN_QUEUE_MAX_DEPTH, DEFAULT_CODE_RUN_QUEUE_LIMITS.maxQueueDepth),
      CODE_RUN_QUEUE_MAX_DEPTH,
    ),
  };
}

export interface CodeRunTicket {
  workspaceId: string;
  userId: string;
  companyId: string;
  sessionId: string;
}

/**
 * `rate_limited` is not a queue state: it is the **periodic** limit (R1 section A, item 1) refusing a start
 * before the queue is even consulted. It is carried by the queue's own error type so every existing caller —
 * the chat route's 429, the CLI's status table — keeps mapping a refusal without learning a second vocabulary.
 */
export type CodeRunRefusalCode = "queue_timeout" | "queue_cancelled" | "rate_limited";

export class CodeRunRefusedError extends Error {
  constructor(
    readonly code: CodeRunRefusalCode,
    message: string,
    /** True when the caller may retry the same ticket; both refusal modes are retryable later. */
    readonly retryable = true,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeRunRefusedError";
  }
}

export interface CodeRunLease {
  /** Give the slot back. Idempotent: a second call is a no-op, so a `finally` block cannot double-release. */
  release(): void;
  /** True while this lease holds its slot. */
  readonly held: boolean;
  /** How long the ticket waited before it was granted. */
  readonly waitedMs: number;
}

export interface CodeRunQueueEntry {
  sessionId: string;
  companyId: string;
  userId: string;
  position: number;
  waitedMs: number;
}

export interface CodeRunQueueState {
  limits: CodeRunQueueLimits;
  /** Runs currently executing a code run under this queue. */
  active: number;
  queued: number;
  /** Per-Company active counts, so a UI can show who is using the capacity. */
  activePerCompany: Array<{ companyId: string; active: number }>;
  activePerUser: Array<{ userId: string; active: number }>;
  /** The waiting tickets in the order they will be served. */
  queue: CodeRunQueueEntry[];
}

interface Waiter {
  ticket: CodeRunTicket;
  enqueuedAt: number;
  settled: boolean;
  grant(): void;
  refuse(error: CodeRunRefusedError): void;
}

export class CodeRunQueue {
  readonly limits: CodeRunQueueLimits;
  private active = 0;
  private readonly activePerUser = new Map<string, number>();
  private readonly activePerCompany = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  /**
   * Circular rotation of the Companies that have at least one waiting ticket: **the front of this list is the
   * Company that is next in line**, and a Company that is granted a slot goes to the back.
   *
   * That is the whole fairness mechanism. A Company with a thousand queued runs gets one slot per turn, so a
   * Company with one queued run is served after at most one other grant — which is the property a plain counter
   * (and a first-come-first-served queue) does not give.
   */
  private order: string[] = [];

  constructor(limits: Partial<CodeRunQueueLimits> = {}) {
    const merged = { ...DEFAULT_CODE_RUN_QUEUE_LIMITS, ...limits };
    this.limits = {
      maxConcurrentPerUser: Math.max(1, Math.min(Math.trunc(merged.maxConcurrentPerUser), CODE_RUN_QUEUE_MAX_CONCURRENT_PER_USER)),
      maxConcurrentPerCompany: Math.max(1, Math.min(Math.trunc(merged.maxConcurrentPerCompany), CODE_RUN_QUEUE_MAX_CONCURRENT_PER_COMPANY)),
      queueTimeoutMs: Math.max(1_000, Math.min(Math.trunc(merged.queueTimeoutMs), CODE_RUN_QUEUE_MAX_TIMEOUT_MS)),
      maxQueueDepth: Math.max(1, Math.min(Math.trunc(merged.maxQueueDepth), CODE_RUN_QUEUE_MAX_DEPTH)),
    };
  }

  /** True when a ticket could be granted right now, without enqueuing. */
  canAdmit(ticket: Pick<CodeRunTicket, "userId" | "companyId">): boolean {
    return this.fits(ticket);
  }

  /**
   * Takes a slot or waits for one. `onQueued` is called when the ticket did not get a slot immediately, with its
   * 1-based position, so a caller can tell the user where they are in line without polling.
   */
  async acquire(
    ticket: CodeRunTicket,
    options: { signal?: AbortSignal; onQueued?: (position: number) => void; timeoutMs?: number } = {},
  ): Promise<CodeRunLease> {
    const enqueuedAt = Date.now();
    if (options.signal?.aborted) {
      throw new CodeRunRefusedError("queue_cancelled", "The queued code run was cancelled before it started.");
    }
    if (this.canAdmit(ticket)) return this.grant(ticket, enqueuedAt);

    if (this.waiters.length >= this.limits.maxQueueDepth) {
      throw new CodeRunRefusedError(
        "queue_timeout",
        `The code run queue is full (${this.limits.maxQueueDepth} waiting); the run was not started.`,
      );
    }

    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? this.limits.queueTimeoutMs, CODE_RUN_QUEUE_MAX_TIMEOUT_MS));
    return await new Promise<CodeRunLease>((resolve, reject) => {
      /**
       * The wait timer, held so both settlement paths can cancel it. It is deliberately **not** unref'd: a waiting
       * ticket is work in progress, and an unref'd timer is not an event-loop handle — a process whose only pending
       * work was this wait would exit before the timeout fired, so the ticket would never settle and the caller
       * would never learn that its run was not started.
       */
      let timer: NodeJS.Timeout | undefined;
      const settle = (): boolean => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (waiter.settled) return false;
        waiter.settled = true;
        return true;
      };
      const waiter: Waiter = {
        ticket,
        enqueuedAt,
        settled: false,
        grant: () => {
          if (!settle()) return;
          resolve(this.grant(ticket, enqueuedAt));
        },
        refuse: (error) => {
          if (!settle()) return;
          reject(error);
        },
      };
      this.waiters.push(waiter);
      if (!this.order.includes(ticket.companyId)) this.order.push(ticket.companyId);
      options.onQueued?.(this.positionOf(waiter));      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.refuse(new CodeRunRefusedError("queue_timeout", "The code run waited too long for a free slot; the run was not started."));
      }, timeoutMs);
      options.signal?.addEventListener("abort", () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.refuse(new CodeRunRefusedError("queue_cancelled", "The queued code run was cancelled."));
      }, { once: true });
    });
  }

  /**
   * Cancels every waiting ticket of a session. Returns how many were refused. A ticket that was already granted
   * is not touched: it is running, and stopping a running run is the Stop route's job, not the queue's.
   */
  cancelSession(sessionId: string): number {
    let cancelled = 0;
    for (const waiter of [...this.waiters]) {
      if (waiter.ticket.sessionId !== sessionId) continue;
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      waiter.refuse(new CodeRunRefusedError("queue_cancelled", "The queued code run was cancelled."));
      cancelled += 1;
    }
    if (cancelled > 0) this.pump();
    return cancelled;
  }

  state(): CodeRunQueueState {
    return {
      limits: { ...this.limits },
      active: this.active,
      queued: this.waiters.length,
      activePerCompany: [...this.activePerCompany.entries()]
        .map(([companyId, count]) => ({ companyId, active: count }))
        .sort((a, b) => b.active - a.active || a.companyId.localeCompare(b.companyId)),
      activePerUser: [...this.activePerUser.entries()]
        .map(([userId, count]) => ({ userId, active: count }))
        .sort((a, b) => b.active - a.active || a.userId.localeCompare(b.userId)),
      queue: this.orderedWaiters().map((waiter, index) => ({
        sessionId: waiter.ticket.sessionId,
        companyId: waiter.ticket.companyId,
        userId: waiter.ticket.userId,
        position: index + 1,
        waitedMs: Math.max(0, Date.now() - waiter.enqueuedAt),
      })),
    };
  }

  /**
   * The waiting tickets in the order they will be served: one turn per Company in rotation order, the Company's
   * first waiting ticket at each turn.
   */
  private orderedWaiters(): Waiter[] {
    const byCompany = new Map<string, Waiter[]>();
    for (const waiter of this.waiters) {
      if (waiter.settled) continue;
      const list = byCompany.get(waiter.ticket.companyId);
      if (list) list.push(waiter);
      else byCompany.set(waiter.ticket.companyId, [waiter]);
    }
    const ordered: Waiter[] = [];
    for (const companyId of this.order) {
      const list = byCompany.get(companyId);
      if (!list || list.length === 0) continue;
      ordered.push(list.shift()!);
    }
    /**
     * A waiter whose Company is not (yet) in the rotation can only exist between an `acquire` that pushed it and the
     * next `pump`/`orderedWaiters` call. Keeping it last means the queue never drops a ticket from the state it
     * reports, and it is served as soon as its Company gets its turn.
     */
    for (const list of byCompany.values()) for (const waiter of list) ordered.push(waiter);
    return ordered;
  }

  private positionOf(waiter: Waiter): number {
    const ordered = this.orderedWaiters();
    const position = ordered.indexOf(waiter);
    return position >= 0 ? position + 1 : ordered.length + 1;
  }

  private grant(ticket: CodeRunTicket, enqueuedAt: number): CodeRunLease {
    this.active += 1;
    this.activePerUser.set(ticket.userId, (this.activePerUser.get(ticket.userId) ?? 0) + 1);
    this.activePerCompany.set(ticket.companyId, (this.activePerCompany.get(ticket.companyId) ?? 0) + 1);
    let released = false;
    const lease: CodeRunLease = {
      held: true,
      waitedMs: Math.max(0, Date.now() - enqueuedAt),
      release: () => {
        if (released) return;
        released = true;
        (lease as { held: boolean }).held = false;
        this.active = Math.max(0, this.active - 1);
        const perUser = (this.activePerUser.get(ticket.userId) ?? 1) - 1;
        if (perUser <= 0) this.activePerUser.delete(ticket.userId);
        else this.activePerUser.set(ticket.userId, perUser);
        const perCompany = (this.activePerCompany.get(ticket.companyId) ?? 1) - 1;
        if (perCompany <= 0) this.activePerCompany.delete(ticket.companyId);
        else this.activePerCompany.set(ticket.companyId, perCompany);
        this.pump();
      },
    };
    return lease;
  }

  /**
   * Grants at most **one** waiting ticket. One grant per call is what makes the rotation observable and fair: the
   * Company that was just served moves to the back, and the next grant — triggered by the next release — goes to
   * the Company that is now at the front. Granting every ticket that happens to fit in one pass would let a Company
   * with a backlog take several slots at once whenever several came free together, which is the starvation the
   * rotation exists to prevent.
   */
  private pump(): void {
    this.rebuildOrder();
    for (const companyId of this.order) {
      const index = this.waiters.findIndex(
        (waiter) => !waiter.settled && waiter.ticket.companyId === companyId && this.fits(waiter.ticket),
      );
      if (index < 0) continue;
      const waiter = this.waiters[index]!;
      this.waiters.splice(index, 1);
      waiter.grant();
      this.rotateOrder(companyId);
      return;
    }
  }

  /**
   * Drops Companies with no waiting ticket and appends any Company that has one, so the rotation is exactly the set
   * of waiting Companies. Appending (rather than inserting at the front) is deliberate: a Company that queued while
   * others were being served goes to the back of the line, not ahead of them.
   */
  private rebuildOrder(): void {
    const waiting = new Set(
      this.waiters.filter((waiter) => !waiter.settled).map((waiter) => waiter.ticket.companyId),
    );
    this.order = this.order.filter((companyId) => waiting.has(companyId));
    for (const companyId of waiting) if (!this.order.includes(companyId)) this.order.push(companyId);
  }

  private fits(ticket: Pick<CodeRunTicket, "userId" | "companyId">): boolean {
    if ((this.activePerCompany.get(ticket.companyId) ?? 0) >= this.limits.maxConcurrentPerCompany) return false;
    if ((this.activePerUser.get(ticket.userId) ?? 0) >= this.limits.maxConcurrentPerUser) return false;
    return true;
  }

  /** Moves a served Company to the back of the rotation — one slot per turn, whatever its backlog is. */
  private rotateOrder(companyId: string): void {
    const index = this.order.indexOf(companyId);
    if (index < 0) return;
    this.order.splice(index, 1);
    this.order.push(companyId);
  }
}
