import { usageQuotasEnabled } from "./usage-quota-policy";
/**
 * R1 (section A, item 1) — the **periodic** rate limit on code-run starts, per user and per Company.
 *
 * Why this is a separate limiter and not a reuse of `RouteGuardTiers`. `route-guard-tiers.ts` is the HTTP
 * request limiter for the Company/Chat API: its unit is "one HTTP request against a client's tier", its window
 * is a fixed one minute, and its keys are client ids the caller derives from an API key. A code run is none of
 * those things: it is admitted inside a route that may also serve plain chat, it is paid for by the Company
 * that owns the project, and the interesting abuse is a burst of *starts* (each of which holds a sandbox and a
 * model budget), not a burst of requests. Reusing that limiter would either have made chat refuse because runs
 * were started, or made the run limit disappear whenever the tier configuration changed — a limit that moves
 * with an unrelated setting is not a limit. It is also explicitly outside the R1 scope of this step: that file
 * keeps serving Company/Chat unchanged.
 *
 * The shape deliberately copies the **idiom** of `code-run-queue.ts` — configurable value, documented start
 * value, hard ceiling, "nonsense falls back rather than becoming unlimited" — because an operator who has read
 * one of these modules should be able to read the other. The accounting itself is a sliding window of start
 * timestamps per key, the same honest mechanism the existing tiers use: a fixed-window counter lets a client
 * spend the whole allowance twice around a boundary.
 *
 * Honest limit, stated because it is real: the window lives in this process, so `N` replicas of the API admit
 * up to `N × limit` starts in a window. The same is true of `CodeRunQueue`'s caps, and it is the reason the
 * queue's own header says the limit is a property of the deployment. A shared counter would need the Redis
 * stream the queue deliberately does not use; what this step can promise is that **no path inside one
 * deployment** admits a run without passing this check.
 */

import { CodeRunRefusedError } from "./code-run-queue";

export interface CodeRunRateLimitConfig {
  /** Code-run starts one user may trigger within `periodMs`. */
  maxRunsPerUserPerPeriod: number;
  /** Code-run starts one Company may trigger within `periodMs`, across all of its users. */
  maxRunsPerCompanyPerPeriod: number;
  /** The length of the sliding window. */
  periodMs: number;
}

/**
 * R1 start values. The period is an hour because the requirement is "runs per period" and an hour is the
 * shortest window in which "a person cannot spend a day's work in a minute" and "a normal session is never
 * throttled" are both true; the counts are deliberately far above what a human starts by hand and far below
 * what a script would need to be useful.
 */
export const DEFAULT_CODE_RUN_RATE_LIMITS: CodeRunRateLimitConfig = {
  maxRunsPerUserPerPeriod: 30,
  maxRunsPerCompanyPerPeriod: 120,
  periodMs: 60 * 60_000,
};

/** Hard ceilings: configuration may lower these, never raise them past the point one node can serve. */
export const CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_USER = 1_000;
export const CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_COMPANY = 10_000;
export const CODE_RUN_RATE_LIMIT_MAX_PERIOD_MS = 24 * 60 * 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the limits from the environment. Every value is clamped, so a typo cannot remove the limit. */
export function resolveCodeRunRateLimits(env: NodeJS.ProcessEnv = process.env): CodeRunRateLimitConfig {
  return {
    maxRunsPerUserPerPeriod: Math.min(
      positiveInt(env.NPATI_CODE_RUN_RATE_LIMIT_PER_USER_PER_PERIOD, DEFAULT_CODE_RUN_RATE_LIMITS.maxRunsPerUserPerPeriod),
      CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_USER,
    ),
    maxRunsPerCompanyPerPeriod: Math.min(
      positiveInt(env.NPATI_CODE_RUN_RATE_LIMIT_PER_COMPANY_PER_PERIOD, DEFAULT_CODE_RUN_RATE_LIMITS.maxRunsPerCompanyPerPeriod),
      CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_COMPANY,
    ),
    periodMs: Math.min(
      positiveInt(env.NPATI_CODE_RUN_RATE_LIMIT_PERIOD_MS, DEFAULT_CODE_RUN_RATE_LIMITS.periodMs),
      CODE_RUN_RATE_LIMIT_MAX_PERIOD_MS,
    ),
  };
}

export type CodeRunRateLimitScope = "user" | "company";

/**
 * A refusal of the **periodic** limit. It extends the queue's own refusal error on purpose: every caller that
 * already maps `CodeRunRefusedError` onto "come back later" (the chat route's 429, the CLI's status table)
 * keeps working, and the extra `retryAfterMs` is the estimate the window itself can compute — which is more
 * honest than the fixed `queueTimeoutMs` the older paths report.
 */
export class CodeRunRateLimitedError extends CodeRunRefusedError {
  constructor(
    readonly scope: CodeRunRateLimitScope,
    readonly limit: number,
    readonly used: number,
    readonly retryAfterMs: number,
  ) {
    super(
      "rate_limited",
      `The code-run rate limit for this ${scope} is reached (${used}/${limit} runs in the current period); the run was not started.`,
      true,
    );
    this.name = "CodeRunRateLimitedError";
  }
}

export interface CodeRunRateLimitVerdict {
  allowed: boolean;
  /** Which of the two counters refused, when the verdict is a refusal. */
  scope?: CodeRunRateLimitScope;
  limit?: number;
  used?: number;
  /** How long until the oldest start of the refusing window falls out of it. */
  retryAfterMs?: number;
}

export interface CodeRunRateLimitStateRow {
  scope: CodeRunRateLimitScope;
  id: string;
  used: number;
  limit: number;
  /** When the oldest counted start leaves the window; `null` when nothing is counted. */
  resetAt: string | null;
}

export interface CodeRunRateLimitState {
  enabled?: boolean;
  limits: CodeRunRateLimitConfig;
  windows: CodeRunRateLimitStateRow[];
}

/**
 * The sliding-window counter. Two independent keys per start (the user and the Company), because they are the
 * two things a person can exhaust and both must have room — the same reason the queue keeps two counters.
 */
export class CodeRunRateLimiter {
  readonly limits: CodeRunRateLimitConfig;
  private readonly userWindows = new Map<string, number[]>();
  private readonly companyWindows = new Map<string, number[]>();

  constructor(config: Partial<CodeRunRateLimitConfig> = {}, private readonly now: () => number = () => Date.now()) {
    const merged = { ...DEFAULT_CODE_RUN_RATE_LIMITS, ...config };
    this.limits = {
      maxRunsPerUserPerPeriod: Math.max(
        1,
        Math.min(Math.trunc(merged.maxRunsPerUserPerPeriod), CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_USER),
      ),
      maxRunsPerCompanyPerPeriod: Math.max(
        1,
        Math.min(Math.trunc(merged.maxRunsPerCompanyPerPeriod), CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_COMPANY),
      ),
      periodMs: Math.max(1_000, Math.min(Math.trunc(merged.periodMs), CODE_RUN_RATE_LIMIT_MAX_PERIOD_MS)),
    };
  }

  /** The counters as they stand, without recording anything. Never throws. */
  check(ticket: { userId: string; companyId: string }): CodeRunRateLimitVerdict {
    if (!usageQuotasEnabled()) return { allowed: true };
    const now = this.now();
    const userRefusal = this.refusalFor(this.userWindows.get(ticket.userId), this.limits.maxRunsPerUserPerPeriod, now);
    if (userRefusal) return { allowed: false, scope: "user", limit: this.limits.maxRunsPerUserPerPeriod, ...userRefusal };
    const companyRefusal = this.refusalFor(this.companyWindows.get(ticket.companyId), this.limits.maxRunsPerCompanyPerPeriod, now);
    if (companyRefusal) return { allowed: false, scope: "company", limit: this.limits.maxRunsPerCompanyPerPeriod, ...companyRefusal };
    return { allowed: true };
  }

  /** Throws the structured refusal when the ticket is over either counter. */
  assertWithinLimit(ticket: { userId: string; companyId: string }): void {
    const verdict = this.check(ticket);
    if (verdict.allowed) return;
    throw new CodeRunRateLimitedError(verdict.scope ?? "user", verdict.limit ?? 1, verdict.used ?? 0, verdict.retryAfterMs ?? this.limits.periodMs);
  }

  /**
   * Counts one start against both counters. Called when a slot was really **granted**, not when it was
   * requested: a run that never started (queue full, client disconnected while waiting) must not spend the
   * user's allowance for the period.
   */
  record(ticket: { userId: string; companyId: string }): void {
    if (!usageQuotasEnabled()) return;
    const now = this.now();
    this.push(this.userWindows, ticket.userId, now);
    this.push(this.companyWindows, ticket.companyId, now);
  }

  /** The counters a status surface renders. Read-only; pruning happens on the way out. */
  state(): CodeRunRateLimitState {
    const now = this.now();
    const rows: CodeRunRateLimitStateRow[] = [];
    const collect = (
      windows: Map<string, number[]>,
      scope: CodeRunRateLimitScope,
      limit: number,
    ): void => {
      for (const [id, timestamps] of windows) {
        const active = this.active(timestamps, now);
        if (active.length === 0) continue;
        rows.push({ scope, id, used: active.length, limit, resetAt: new Date(active[0]! + this.limits.periodMs).toISOString() });
      }
    };
    collect(this.userWindows, "user", this.limits.maxRunsPerUserPerPeriod);
    collect(this.companyWindows, "company", this.limits.maxRunsPerCompanyPerPeriod);
    rows.sort((a, b) => b.used - a.used || a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
    return { enabled: usageQuotasEnabled(), limits: { ...this.limits }, windows: rows };
  }

  /** Drops empty keys and expired timestamps. Idempotent; a limit that nobody is near costs no memory. */
  cleanup(): void {
    const now = this.now();
    for (const windows of [this.userWindows, this.companyWindows]) {
      for (const [id, timestamps] of windows) {
        const active = this.active(timestamps, now);
        if (active.length === 0) windows.delete(id);
        else windows.set(id, active);
      }
    }
  }

  private active(timestamps: number[] | undefined, now: number): number[] {
    return (timestamps ?? []).filter((at) => at > now - this.limits.periodMs);
  }

  private push(windows: Map<string, number[]>, key: string, now: number): void {
    const active = this.active(windows.get(key), now);
    active.push(now);
    windows.set(key, active);
  }

  private refusalFor(timestamps: number[] | undefined, limit: number, now: number): { used: number; retryAfterMs: number } | null {
    const active = this.active(timestamps, now);
    if (active.length < limit) return null;
    const oldest = active[0] ?? now;
    return { used: active.length, retryAfterMs: Math.max(1, oldest + this.limits.periodMs - now) };
  }
}
