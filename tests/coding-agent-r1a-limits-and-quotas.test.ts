// Retired quota algorithms only: activation is confined to this isolated test file.
// Real release-policy and HTTP coverage: usage-quotas-disabled.test.ts.
vi.mock("../apps/agent-api/src/usage-quota-policy", () => ({ usageQuotasEnabled: () => true }));
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it , vi } from "vitest";
import {
  CODE_RUN_RATE_LIMIT_MAX_PERIOD_MS,
  CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_COMPANY,
  CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_USER,
  CodeRunRateLimitedError,
  CodeRunRateLimiter,
  DEFAULT_CODE_RUN_RATE_LIMITS,
  resolveCodeRunRateLimits,
} from "../apps/agent-api/src/code-run-rate-limit";
import {
  CODE_RUN_QUEUE_MAX_DEPTH,
  CodeRunQueue,
  CodeRunRefusedError,
  DEFAULT_CODE_RUN_QUEUE_LIMITS,
  resolveCodeRunQueueLimits,
  type CodeRunLease,
  type CodeRunTicket,
} from "../apps/agent-api/src/code-run-queue";
import { createCodeRunAdmission } from "../apps/agent-api/src/code-run-admission";
import {
  CODE_RUN_BUDGET_WARNING_RATIO,
  CODE_RUN_DAILY_MAX_COST_USD,
  CODE_RUN_DAILY_MAX_TOKENS,
  CodeRunSharedQuota,
  DEFAULT_CODE_RUN_DAILY_BUDGET,
  resolveCodeRunDailyBudget,
  type CodeRunBudgetLimits,
  type CodeRunBudgetThresholdEvent,
  type CodeRunDailyBudgetLimits,
} from "../apps/agent-api/src/code-run-quota";
import { A2AQuotaManager } from "../apps/agent-api/src/a2a-protocol-extensions";
import { buildCodeQueueStatusView, registerCodeQueueStatusRoutes } from "../apps/agent-api/src/code-queue-status-routes";
import type { AuthContext } from "@npati/workspace";

/**
 * R1 (section A, items 1, 2, 3 and 5) — the limits that bound a code run, and the proof that they are not
 * bypassed.
 *
 * The suite is hermetic: no Docker, no Postgres, no network (the one HTTP surface is driven through Fastify's
 * `inject`, which never binds a port). It is the suite the security gate runs for this step, so it carries no
 * `.skip`/`.only`/`.todo`, no `as any` and no `@ts-ignore`.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(workspaceRoot, relative), "utf8");

/**
 * R1a guards read the composition root **plus the modules that own the wiring under test**. Reading `app.ts`
 * alone stopped covering the subject once plan step 2 moved that wiring into domain modules, and reading the
 * whole composition is not an option either: the negative assertions below (no `hostAdmission`, no
 * `SandboxCompanyQuota` on these paths) would then match the sandbox provider and fail for the wrong reason.
 */
const readComposition = (): string =>
  [
    "app.ts",
    "code-route-runs.ts",
    "chat-stream-routes.ts",
    "code-queue-status-routes.ts",
    "automation-executor-wiring.ts",
    "code-route-wiring.ts",
  ]
    .map((file) => read(path.join("apps", "agent-api", "src", file)))
    .join("\n");

function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:read"], companyId: "company-1", ...overrides };
}

interface TicketOutcome {
  lease: CodeRunLease | null;
  /** The refusal code, or `null` when the ticket was granted. */
  code: string | null;
  message: string;
}

/**
 * A ticket whose outcome is captured **as a value**. An observed promise avoids the unhandled-rejection window
 * a bare `queue.acquire(...)` leaves behind when the cancellation below settles it, which is what the existing
 * C10 queue suite does for the same reason.
 */
function hold(queue: CodeRunQueue, ticket: CodeRunTicket, timeoutMs = 30_000): Promise<TicketOutcome> {
  return queue.acquire(ticket, { timeoutMs }).then(
    (lease) => ({ lease, code: null, message: "" }),
    (error: unknown) => ({
      lease: null,
      code: error instanceof CodeRunRefusedError ? error.code : "unexpected_refusal",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** The same value-capturing settlement for a promise that is not this test's own `queue.acquire` call. */
async function settle(run: Promise<CodeRunLease>): Promise<TicketOutcome & { error: unknown }> {
  try {
    const lease = await run;
    return { lease, code: null, message: "", error: null };
  } catch (error) {
    return {
      lease: null,
      code: error instanceof CodeRunRefusedError ? error.code : "unexpected_refusal",
      message: error instanceof Error ? error.message : String(error),
      error,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// A.1 — the periodic run limit
// ---------------------------------------------------------------------------------------------

describe("security-gate: R1 A.1 — the periodic run limit is configured, clamped and enforced", () => {
  it("reads the periodic limits from the environment and clamps them to the hard ceiling", () => {
    const configured = resolveCodeRunRateLimits({
      NPATI_CODE_RUN_RATE_LIMIT_PER_USER_PER_PERIOD: "7",
      NPATI_CODE_RUN_RATE_LIMIT_PER_COMPANY_PER_PERIOD: "9",
      NPATI_CODE_RUN_RATE_LIMIT_PERIOD_MS: "60000",
    } as NodeJS.ProcessEnv);
    expect(configured).toEqual({ maxRunsPerUserPerPeriod: 7, maxRunsPerCompanyPerPeriod: 9, periodMs: 60_000 });
  });

  it("falls back on nonsense and never honours a value above the ceiling", () => {
    const nonsense = resolveCodeRunRateLimits({
      NPATI_CODE_RUN_RATE_LIMIT_PER_USER_PER_PERIOD: "not-a-number",
      NPATI_CODE_RUN_RATE_LIMIT_PER_COMPANY_PER_PERIOD: "-4",
      NPATI_CODE_RUN_RATE_LIMIT_PERIOD_MS: "0",
    } as NodeJS.ProcessEnv);
    expect(nonsense).toEqual(DEFAULT_CODE_RUN_RATE_LIMITS);

    const enormous = resolveCodeRunRateLimits({
      NPATI_CODE_RUN_RATE_LIMIT_PER_USER_PER_PERIOD: "100000",
      NPATI_CODE_RUN_RATE_LIMIT_PER_COMPANY_PER_PERIOD: "100000",
      NPATI_CODE_RUN_RATE_LIMIT_PERIOD_MS: String(365 * 24 * 60 * 60_000),
    } as NodeJS.ProcessEnv);
    expect(enormous.maxRunsPerUserPerPeriod).toBe(CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_USER);
    expect(enormous.maxRunsPerCompanyPerPeriod).toBe(CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_COMPANY);
    expect(enormous.periodMs).toBe(CODE_RUN_RATE_LIMIT_MAX_PERIOD_MS);

    // A direct construction is clamped too, so the class cannot be handed an unlimited cap.
    const limiter = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 999_999, maxRunsPerCompanyPerPeriod: 999_999, periodMs: 10 ** 12 });
    expect(limiter.limits.maxRunsPerUserPerPeriod).toBe(CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_USER);
    expect(limiter.limits.maxRunsPerCompanyPerPeriod).toBe(CODE_RUN_RATE_LIMIT_MAX_RUNS_PER_COMPANY);
    expect(limiter.limits.periodMs).toBe(CODE_RUN_RATE_LIMIT_MAX_PERIOD_MS);
  });

  it("refuses the start after the user's allowance and names the window's own retry-after", () => {
    let now = 1_000_000;
    const limiter = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 2, maxRunsPerCompanyPerPeriod: 100, periodMs: 60_000 }, () => now);
    expect(limiter.check({ userId: "user-1", companyId: "company-1" }).allowed).toBe(true);
    limiter.record({ userId: "user-1", companyId: "company-1" });
    limiter.record({ userId: "user-1", companyId: "company-1" });

    const refused = limiter.check({ userId: "user-1", companyId: "company-1" });
    expect(refused).toMatchObject({ allowed: false, scope: "user", used: 2, limit: 2 });
    // The estimate is the time until the oldest counted start leaves the window, not a fixed guess.
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);

    // The other user of the same Company is untouched: the two counters are independent.
    expect(limiter.check({ userId: "user-2", companyId: "company-1" }).allowed).toBe(true);
    // And the window really moves: 60 s later the same user may start again.
    now += 60_001;
    expect(limiter.check({ userId: "user-1", companyId: "company-1" }).allowed).toBe(true);
  });

  it("refuses on the Company counter even when the user has room, and isolates Companies", () => {
    const limiter = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 100, maxRunsPerCompanyPerPeriod: 2, periodMs: 60_000 });
    limiter.record({ userId: "user-1", companyId: "company-1" });
    limiter.record({ userId: "user-1", companyId: "company-1" });
    const refused = limiter.check({ userId: "user-2", companyId: "company-1" });
    expect(refused).toMatchObject({ allowed: false, scope: "company", used: 2, limit: 2 });
    expect(limiter.check({ userId: "user-2", companyId: "company-2" }).allowed).toBe(true);
  });

  it("is not vacuous: raising only the user allowance admits the start the default refuses", () => {
    const ticket = { userId: "user-1", companyId: "company-1" };
    const strict = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 1, maxRunsPerCompanyPerPeriod: 1, periodMs: 60_000 });
    strict.record(ticket);
    expect(strict.check(ticket).allowed).toBe(false);
    // The negative control: the same two recordings, a limit that is not exhausted.
    const relaxed = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 2, maxRunsPerCompanyPerPeriod: 2, periodMs: 60_000 });
    relaxed.record(ticket);
    expect(relaxed.check(ticket).allowed).toBe(true);
    // And the guard is still live afterwards, so the neutralisation did not replace the limit.
    relaxed.record(ticket);
    expect(relaxed.check(ticket).allowed).toBe(false);
  });

  it("assertWithinLimit throws the structured refusal the HTTP and CLI surfaces map", () => {
    const limiter = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 1, maxRunsPerCompanyPerPeriod: 1, periodMs: 60_000 });
    limiter.record({ userId: "user-1", companyId: "company-1" });
    try {
      limiter.assertWithinLimit({ userId: "user-1", companyId: "company-1" });
      throw new Error("expected the periodic limit to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(CodeRunRateLimitedError);
      // The refusal is the queue's own error type, so every existing caller keeps its mapping.
      expect(error).toBeInstanceOf(CodeRunRefusedError);
      const refusal = error as CodeRunRateLimitedError;
      expect(refusal.code).toBe("rate_limited");
      expect(refusal.retryable).toBe(true);
      expect(refusal.scope).toBe("user");
    }
  });

  it("reports its window in state() and forgets an idle key in cleanup()", () => {
    let now = 5_000_000;
    const limiter = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 3, maxRunsPerCompanyPerPeriod: 3, periodMs: 60_000 }, () => now);
    limiter.record({ userId: "user-1", companyId: "company-1" });
    const state = limiter.state();
    // The rows are ordered by usage; compared sorted so the assertion is about the counters, not the ordering.
    expect(state.windows.map((row) => `${row.scope}:${row.id}:${row.used}`).sort()).toEqual(["company:company-1:1", "user:user-1:1"]);
    expect(state.windows.every((row) => row.resetAt !== null)).toBe(true);
    now += 60_001;
    limiter.cleanup();
    expect(limiter.state().windows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// A.1/A.3/A.5 — the queue, its defaults, and the single admission door
// ---------------------------------------------------------------------------------------------

describe("security-gate: R1 A.1/A.3 — the queue defaults are the R1 start values", () => {
  it("defaults to 5 parallel runs per Company and a 50-ticket queue, and both stay configurable", () => {
    expect(DEFAULT_CODE_RUN_QUEUE_LIMITS.maxConcurrentPerCompany).toBe(5);
    expect(DEFAULT_CODE_RUN_QUEUE_LIMITS.maxQueueDepth).toBe(50);
    // Current development defaults support the four concurrent projects already configured.
    expect(DEFAULT_CODE_RUN_QUEUE_LIMITS.maxConcurrentPerUser).toBe(4);
    expect(DEFAULT_CODE_RUN_QUEUE_LIMITS.queueTimeoutMs).toBe(120_000);

    // The environment still overrides them, and the clamp still applies to the new default.
    const overridden = resolveCodeRunQueueLimits({
      NPATI_CODE_RUN_MAX_CONCURRENT_PER_COMPANY: "3",
      NPATI_CODE_RUN_QUEUE_MAX_DEPTH: "7",
    } as NodeJS.ProcessEnv);
    expect(overridden.maxConcurrentPerCompany).toBe(3);
    expect(overridden.maxQueueDepth).toBe(7);
    const enormous = resolveCodeRunQueueLimits({ NPATI_CODE_RUN_QUEUE_MAX_DEPTH: "10000000" } as NodeJS.ProcessEnv);
    expect(enormous.maxQueueDepth).toBe(CODE_RUN_QUEUE_MAX_DEPTH);
  });

  it("refuses the (maxQueueDepth + 1)-th waiting ticket instead of growing without bound", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, maxQueueDepth: 2, queueTimeoutMs: 30_000 });
    const holder = await queue.acquire({ workspaceId: "ws", userId: "u0", companyId: "c1", sessionId: "s0" });
    const waiting = [
      hold(queue, { workspaceId: "ws", userId: "u1", companyId: "c1", sessionId: "s1" }),
      hold(queue, { workspaceId: "ws", userId: "u2", companyId: "c1", sessionId: "s2" }),
    ];
    expect(queue.state().queued).toBe(2);
    // The depth refusal is the queue's own refusal and its message names the configured depth.
    const refused = await hold(queue, { workspaceId: "ws", userId: "u3", companyId: "c1", sessionId: "s3" });
    expect(refused.code).toBe("queue_timeout");
    expect(refused.message).toContain("The code run queue is full (2 waiting)");
    expect(queue.state().queued).toBe(2);
    // Settle both waiters through the queue's own cancellation path, so the test leaves no timer behind.
    expect(queue.cancelSession("s1")).toBe(1);
    expect(queue.cancelSession("s2")).toBe(1);
    expect((await waiting[0]!).code).toBe("queue_cancelled");
    expect((await waiting[1]!).code).toBe("queue_cancelled");
    holder.release();
    expect(queue.state().active).toBe(0);
    expect(queue.state().queued).toBe(0);
  });
});

describe("security-gate: R1 A.1/A.5 — one admission door for every entry point", () => {
  it("checks the periodic limit before the queue, so a refused start cannot occupy a slot", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 10, maxConcurrentPerUser: 10, maxQueueDepth: 10, queueTimeoutMs: 5_000 });
    const limiter = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 1, maxRunsPerCompanyPerPeriod: 1, periodMs: 60_000 });
    const admission = createCodeRunAdmission(queue, limiter);
    const ticket = { workspaceId: "ws", userId: "u1", companyId: "c1", sessionId: "s1" };

    const lease = await admission.admit(ticket);
    expect(queue.state().active).toBe(1);

    // The periodic refusal: the ticket never reaches the queue, so no waiter is left behind.
    const refused = await settle(admission.admit({ ...ticket, sessionId: "s2" }));
    expect(refused.error).toBeInstanceOf(CodeRunRateLimitedError);
    expect(refused.code).toBe("rate_limited");
    expect(refused.message).toContain("rate limit for this user");
    expect(queue.state().queued).toBe(0);
    expect(queue.state().active).toBe(1);
    // `canAdmit` reports the same two limits, so a caller past the point of an honest HTTP refusal refuses too.
    expect(admission.canAdmit({ userId: "u1", companyId: "c1" })).toBe(false);
    lease.release();
    expect(queue.state().active).toBe(0);
  });

  it("counts a start only once the slot was really granted", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, maxQueueDepth: 5, queueTimeoutMs: 200 });
    const limiter = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 5, maxRunsPerCompanyPerPeriod: 5, periodMs: 60_000 });
    const admission = createCodeRunAdmission(queue, limiter);
    const holder = await admission.admit({ workspaceId: "ws", userId: "u1", companyId: "c1", sessionId: "s1" });
    // A ticket that times out in the queue spends nothing.
    const queued = await settle(admission.admit({ workspaceId: "ws", userId: "u2", companyId: "c1", sessionId: "s2" }));
    expect(queued.error).toBeInstanceOf(CodeRunRefusedError);
    expect(queued.code).toBe("queue_timeout");
    expect(limiter.state().windows.find((row) => row.id === "u2")).toBeUndefined();
    holder.release();
  });

  it("keeps the admission door single: no code-run entry point calls queue.acquire itself", () => {
    const app = readComposition();
    /**
     * The structural half of "not bypassed". The queue was already correct; what R1 had to fix is that two
     * call sites each called `acquire` and would each have had to remember the new periodic limit. The
     * assertion is exact-count, in both directions: zero direct calls (so a third surface cannot be added
     * without failing here) and at least three uses of the shared door (the chat pre-hijack admission, the
     * post-hijack fallback and the CLI/IDE `admit` port), so deleting the door fails too.
     */
    expect(app.match(/codeRunQueue\.acquire\(/g) ?? []).toHaveLength(0);
    expect((app.match(/codeRunAdmission\.(?:admit|canAdmit)\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(app).toContain("const codeRunAdmission = createCodeRunAdmission(codeRunQueue, codeRunRateLimiter);");
    expect(app).toContain("admit: async (ctx, companyId, sessionId) => codeRunAdmission.admit({");
    expect(app).toContain("registerCodeQueueStatusRoutes(app, {");
    // The periodic refusal has its own HTTP answer with the window's own retry-after.
    expect(app).toContain("error instanceof CodeRunRateLimitedError");
    expect(app).toContain('code: "CODE_RUN_RATE_LIMITED"');
  });

  it("maps the periodic refusal on the CLI surface without a second vocabulary", () => {
    const cli = read(path.join("apps", "agent-api", "src", "code-cli-run-routes.ts"));
    expect(cli).toContain("rate_limited: 429");
    expect(cli).toContain('const ERROR_RETRYABLE = new Set(["queue_timeout", "queue_cancelled", "rate_limited"]);');
  });

  it("is not reachable from the Company-run path or from a sub-agent", () => {
    /**
     * The other half of A.5: a quota is only a quota if the paths that could dodge it cannot. A **sub-agent**
     * draws on the parent run's session budget (`code-run-quota.ts`) and does not mint a second slot; an
     * **Automation** executes a Company run (`companyRuntime.execute`), which is a different limit with a
     * different gate (`AdmissionError`/`admissionGate`). Both claims are checked structurally here: the
     * admission door and the queue are imported by the composition root and by nothing else on those paths.
     */
    const app = readComposition();
    const companyRuntime = read(path.join("apps", "agent-api", "src", "company-runtime.ts"));
    const subagent = read(path.join("apps", "agent-api", "src", "code-subagent-child-runner.ts"));
    for (const source of [companyRuntime, subagent]) {
      expect(source).not.toContain("code-run-admission");
      expect(source).not.toContain("CodeRunQueue");
      expect(source).not.toContain("codeRunQueue");
    }
    // The Automation path really is the Company runtime, so the assertion above covers it by construction.
    expect(app).toContain("await companyRuntime.execute(");
    // And the host/Company quotas of A.4 are not wired into the Company-run admission gate either.
    expect(app).toContain("admissionGate: { isRefusingNewRuns: () => codeReaper.isRefusingNewRuns() },");
    expect(app).not.toContain("hostAdmission");
    expect(app).not.toContain("SandboxCompanyQuota");
  });
});

// ---------------------------------------------------------------------------------------------
// A.2 — daily and per-Company budgets, and the 80 %/100 % notifications
// ---------------------------------------------------------------------------------------------

describe("security-gate: R1 A.2 — daily budgets go through the one accounting system", () => {
  const scope = { userId: "user-1", companyId: "company-1" };

  function quota(overrides: {
    daily?: Partial<CodeRunDailyBudgetLimits>;
    session?: Partial<CodeRunBudgetLimits>;
    onThreshold?: (event: CodeRunBudgetThresholdEvent) => void;
    now?: () => number;
  } = {}) {
    const manager = new A2AQuotaManager();
    const instance = new CodeRunSharedQuota(manager, {
      limits: overrides.session ?? { maxTokens: 1_000_000, maxCostUsd: 1_000 },
      dailyLimits: overrides.daily ?? { maxTokensPerUserPerDay: 100, maxCostUsdPerUserPerDay: 1, maxTokensPerCompanyPerDay: 100, maxCostUsdPerCompanyPerDay: 1 },
      ...(overrides.onThreshold ? { onThreshold: overrides.onThreshold } : {}),
      ...(overrides.now ? { now: overrides.now } : {}),
    });
    return { manager, instance };
  }

  it("reads the daily budgets from the environment, clamps them, and defaults to the documented start values", () => {
    const nonsense = resolveCodeRunDailyBudget({ NPATI_CODE_RUN_DAILY_MAX_TOKENS_PER_USER: "nope", NPATI_CODE_RUN_DAILY_MAX_COST_USD_PER_COMPANY: "-1" } as NodeJS.ProcessEnv);
    expect(nonsense).toEqual(DEFAULT_CODE_RUN_DAILY_BUDGET);
    const enormous = resolveCodeRunDailyBudget({
      NPATI_CODE_RUN_DAILY_MAX_TOKENS_PER_USER: "999999999999",
      NPATI_CODE_RUN_DAILY_MAX_COST_USD_PER_USER: "999999999999",
    } as NodeJS.ProcessEnv);
    expect(enormous.maxTokensPerUserPerDay).toBe(CODE_RUN_DAILY_MAX_TOKENS);
    expect(enormous.maxCostUsdPerUserPerDay).toBe(CODE_RUN_DAILY_MAX_COST_USD);
    expect(DEFAULT_CODE_RUN_DAILY_BUDGET.maxTokensPerCompanyPerDay).toBe(10_000_000);
  });

  it("refuses a run when the user's day is spent, names the scope, and leaves another user untouched", () => {
    const { instance } = quota();
    instance.recordUsage("session-1", 100, 0, scope);
    const refused = instance.checkQuota("session-2", 1, 0, 1, scope);
    expect(refused.allowed).toBe(false);
    expect(refused.error).toContain("A2A_DAILY_QUOTA_EXCEEDED");
    expect(refused.error).toContain("daily code-run budget for this user");
    expect(refused.error).toContain("resets at 00:00 UTC");
    // Tenant isolation: another user of the same Company has its own day, and the Company's own day is not
    // what refused here (it is the same 100-token limit, so prove the user key moved by naming a new company).
    const otherUser = instance.checkQuota("session-3", 1, 0, 1, { userId: "user-2", companyId: "company-2" });
    expect(otherUser.allowed).toBe(true);
  });

  it("refuses on the Company's day when several users share it", () => {
    const { instance } = quota({ daily: { maxTokensPerUserPerDay: 1_000, maxTokensPerCompanyPerDay: 100 } });
    instance.recordUsage("session-1", 100, 0, { userId: "user-1", companyId: "company-1" });
    const refused = instance.checkQuota("session-2", 1, 0, 1, { userId: "user-2", companyId: "company-1" });
    expect(refused.allowed).toBe(false);
    expect(refused.error).toContain("daily code-run budget for this Company");
    // Another Company is unaffected: the aggregate is per tenant.
    expect(instance.checkQuota("session-3", 1, 0, 1, { userId: "user-2", companyId: "company-2" }).allowed).toBe(true);
  });

  it("keeps the pre-R1 behaviour when the caller names no scope", () => {
    const { instance } = quota({ daily: { maxTokensPerUserPerDay: 1, maxTokensPerCompanyPerDay: 1 } });
    instance.recordUsage("session-1", 50, 0);
    expect(instance.checkQuota("session-1", 1, 0, 1).allowed).toBe(true);
    expect(instance.checkQuota("session-1", 2_000_000, 0, 1).allowed).toBe(false);
  });

  it("is not vacuous: raising only the daily allowance admits the run the default refuses", () => {
    const strict = quota();
    strict.instance.recordUsage("session-1", 100, 0, scope);
    expect(strict.instance.checkQuota("session-2", 1, 0, 1, scope).allowed).toBe(false);

    const relaxed = quota({ daily: { maxTokensPerUserPerDay: 200 } });
    relaxed.instance.recordUsage("session-1", 100, 0, scope);
    expect(relaxed.instance.checkQuota("session-2", 1, 0, 1, scope).allowed).toBe(true);
  });

  it("notifies at 80 % and at 100 %, once each, for every scope that crossed", () => {
    const events: CodeRunBudgetThresholdEvent[] = [];
    const { instance } = quota({
      daily: { maxTokensPerUserPerDay: 100, maxTokensPerCompanyPerDay: 100 },
      onThreshold: (event) => events.push(event),
    });
    // 80 tokens of 100 is exactly the warning ratio; the session scope has a 1M allowance and does not cross.
    instance.recordUsage("session-1", 80, 0, scope);
    expect(events.map((event) => `${event.scope}:${event.level}`)).toEqual(["user_daily:warning", "company_daily:warning"]);
    expect(events[0]!.usedTokens).toBe(80);
    expect(events[0]!.maxTokens).toBe(100);
    expect(events[0]!.companyId).toBe("company-1");

    // A second turn inside the warning band must not repeat the notice.
    instance.recordUsage("session-1", 5, 0, scope);
    expect(events).toHaveLength(2);

    // Crossing 100 % reports the exhausted level, once, in addition to the warning.
    instance.recordUsage("session-1", 50, 0, scope);
    expect(events.map((event) => `${event.scope}:${event.level}`)).toEqual([
      "user_daily:warning", "company_daily:warning", "user_daily:exhausted", "company_daily:exhausted",
    ]);
    instance.recordUsage("session-1", 1, 0, scope);
    expect(events).toHaveLength(4);
  });

  it("re-arms the notifications on the next UTC day", () => {
    const events: CodeRunBudgetThresholdEvent[] = [];
    let now = Date.parse("2026-03-01T10:00:00.000Z");
    const { instance } = quota({
      daily: { maxTokensPerUserPerDay: 100, maxTokensPerCompanyPerDay: 100 },
      onThreshold: (event) => events.push(event),
      now: () => now,
    });
    instance.recordUsage("session-1", 100, 0, scope);
    expect(events.filter((event) => event.level === "exhausted")).toHaveLength(2);

    now = Date.parse("2026-03-02T00:30:00.000Z");
    // A new day is a new key: the refused user is not carried over and the day's allowance is genuinely fresh.
    expect(instance.checkQuota("session-2", 1, 0, 1, scope).allowed).toBe(true);
    instance.recordUsage("session-2", 100, 0, scope);
    expect(events.filter((event) => event.level === "exhausted")).toHaveLength(4);
  });

  it("reports a pre-flight that is refused because the day was already spent elsewhere", () => {
    /**
     * The budget can be spent through the A2A control plane as well as through a run, and in that case no
     * `recordUsage` of this adapter saw the crossing. The refused pre-flight itself must then be the notice.
     */
    const day = new Date().toISOString().slice(0, 10);
    const userKey = `code-run-daily:${day}:user:user-1`;
    const manager = new A2AQuotaManager();
    const collected: CodeRunBudgetThresholdEvent[] = [];
    const instance = new CodeRunSharedQuota(manager, {
      limits: { maxTokens: 1_000_000, maxCostUsd: 1_000 },
      dailyLimits: { maxTokensPerUserPerDay: 10, maxCostUsdPerUserPerDay: 1, maxTokensPerCompanyPerDay: 10, maxCostUsdPerCompanyPerDay: 1 },
      onThreshold: (event) => collected.push(event),
    });
    manager.setSessionBudget(userKey, 10, 1, 2);
    manager.recordUsage(userKey, 10, 0);
    const refused = instance.checkQuota("session-4", 1, 0, 1, scope);
    expect(refused.allowed).toBe(false);
    expect(collected.map((event) => `${event.scope}:${event.level}`)).toEqual(["user_daily:exhausted"]);
    expect(collected[0]!.usedTokens).toBe(10);
  });

  it("never lets a throwing notification change the accounting or the verdict", () => {
    const { instance } = quota({
      daily: { maxTokensPerUserPerDay: 100, maxTokensPerCompanyPerDay: 100 },
      onThreshold: () => { throw new Error("notification channel is down"); },
    });
    expect(() => instance.recordUsage("session-1", 100, 0, scope)).not.toThrow();
    expect(instance.checkQuota("session-2", 1, 0, 1, scope).allowed).toBe(false);
  });

  it("shares the parent's session budget with a delegated run, so a child cannot mint an allowance", () => {
    /**
     * A.5 by measurement rather than by inspection: the budget key maps the child's session onto the parent's,
     * which is the documented C12 wiring. The child's first pre-flight is refused because the parent already
     * spent the allowance — and the daily user budget is keyed by the user, so a child cannot reset that either.
     */
    const manager = new A2AQuotaManager();
    const instance = new CodeRunSharedQuota(manager, {
      limits: { maxTokens: 100, maxCostUsd: 1_000 },
      dailyLimits: { maxTokensPerUserPerDay: 1_000, maxTokensPerCompanyPerDay: 1_000 },
      resolveBudgetKey: (sessionId) => (sessionId.startsWith("child-") ? "parent-session" : sessionId),
    });
    instance.recordUsage("parent-session", 100, 0, scope);
    const child = instance.checkQuota("child-run-1", 10, 0, 2, scope);
    expect(child.allowed).toBe(false);
    expect(child.error).toContain("A2A_TOKEN_QUOTA_EXCEEDED");
    // The daily aggregate saw the parent's spend, so the child is bounded by it as well.
    expect(instance.dailyBudget.maxTokensPerUserPerDay).toBe(1_000);
    expect(manager.getBudget("code-run-daily:" + new Date().toISOString().slice(0, 10) + ":user:user-1")?.usedTokens).toBe(100);
  });

  it("publishes the warning ratio as one named constant rather than two literals", () => {
    expect(CODE_RUN_BUDGET_WARNING_RATIO).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------------------------
// A.3 — the queue's state is exposed, tenant-scoped and read-only
// ---------------------------------------------------------------------------------------------

describe("security-gate: R1 A.3 — the queue state is visible and tenant-scoped", () => {
  it("projects the deployment-wide state onto one Company and never leaks another tenant's sessions", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, maxQueueDepth: 10, queueTimeoutMs: 30_000 });
    const holderA = await queue.acquire({ workspaceId: "ws", userId: "user-a", companyId: "company-a", sessionId: "session-a0" });
    const holderB = await queue.acquire({ workspaceId: "ws", userId: "user-b", companyId: "company-b", sessionId: "session-b0" });
    // Both Companies are at their cap, so both of the following tickets really wait: the filter below is then
    // tested against a queue that contains another tenant's entry.
    const waitingA = queue.acquire({ workspaceId: "ws", userId: "user-a2", companyId: "company-a", sessionId: "session-a1" });
    const waitingB = queue.acquire({ workspaceId: "ws", userId: "user-b2", companyId: "company-b", sessionId: "session-b1" });
    const limiter = new CodeRunRateLimiter({ maxRunsPerUserPerPeriod: 10, maxRunsPerCompanyPerPeriod: 10, periodMs: 60_000 });
    limiter.record({ userId: "user-a", companyId: "company-a" });

    const view = buildCodeQueueStatusView(queue.state(), limiter.state(), { userId: "user-a", companyId: "company-a" });
    expect(view.active).toBe(2);
    expect(view.queued).toBe(2);
    expect(view.companyId).toBe("company-a");
    expect(view.queue.map((entry) => entry.sessionId)).toEqual(["session-a1"]);
    expect(JSON.stringify(view)).not.toContain("session-b1");
    expect(view.companyActive).toBe(1);
    expect(view.userActive).toBe(1);
    expect(view.rateLimits.user.used).toBe(1);
    expect(view.rateLimits.company.used).toBe(1);
    expect(view.rateLimits.limits.maxRunsPerUserPerPeriod).toBe(10);

    holderA.release();
    const grantedA = await waitingA;
    grantedA.release();
    holderB.release();
    const grantedB = await waitingB;
    grantedB.release();
    expect(queue.state().active).toBe(0);
    expect(queue.state().queued).toBe(0);
  });

  it("serves the state over HTTP, read-only, and refuses without the read permission", async () => {
    const queue = new CodeRunQueue({ maxConcurrentPerCompany: 1, maxConcurrentPerUser: 1, maxQueueDepth: 5, queueTimeoutMs: 30_000 });
    const limiter = new CodeRunRateLimiter();
    /**
     * The route's own `state()` has no caller-supplied value, so "it read the live queue" is observed by hand
     * rather than by a spy: the wrapper counts the reads and delegates, which is also what makes the assertion
     * about the route and not about the queue.
     */
    let stateReads = 0;
    const queueView = { state: () => { stateReads += 1; return queue.state(); } };
    const lease = await queue.acquire({ workspaceId: "ws", userId: "user-1", companyId: "company-1", sessionId: "session-1" });
    limiter.record({ userId: "user-1", companyId: "company-1" });

    const app = Fastify();
    registerCodeQueueStatusRoutes(app, {
      auth: { authenticate: async () => authContext() },
      queue: queueView,
      rateLimits: limiter,
    });
    const response = await app.inject({ method: "GET", url: "/companies/company-1/code/runs/queue" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { active: number; limits: { maxConcurrentPerCompany: number }; rateLimits: { user: { used: number } } };
    expect(body.active).toBe(1);
    expect(body.limits.maxConcurrentPerCompany).toBe(1);
    expect(body.rateLimits.user.used).toBe(1);
    // The route reads the live queue: the exposure is not a constant.
    expect(stateReads).toBeGreaterThan(0);
    // Read-only in the strong sense: no slot was taken and nothing was queued by the request.
    expect(queue.state().active).toBe(1);
    expect(queue.state().queued).toBe(0);

    const forbidden = Fastify();
    registerCodeQueueStatusRoutes(forbidden, {
      auth: { authenticate: async () => authContext({ permissions: ["business:manage"] }) },
      queue: queueView,
      rateLimits: limiter,
    });
    const denied = await forbidden.inject({ method: "GET", url: "/companies/company-1/code/runs/queue" });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe("ACCESS_DENIED");

    lease.release();
    await app.close();
    await forbidden.close();
  });
});
