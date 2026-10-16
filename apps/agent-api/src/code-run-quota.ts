/**
 * C12 + R1 (section A, item 2): the coding agent's budget, expressed as the port the runner already calls.
 *
 * The runner has always had a `quota` port and has always called it (`checkQuota` before every model call,
 * `recordUsage` after every answered turn) — but the composition never supplied one, so `budget_exhausted`
 * could not fire in a real deployment while the whole path looked implemented. This module is that missing
 * adapter, and it is deliberately thin: **`A2AQuotaManager` remains the only accounting system**. There is no
 * second ledger here, no second counter and no separate notion of spend.
 *
 * Sharing is the point. The budget is keyed by **session id**, and a delegated coding run is a run of the same
 * session, so a parent and its children draw on one `sessionBudget`: a child cannot spend past what the parent
 * has left, because there is nothing separate for it to spend. `resolveBudgetKey` exists for a deployment that
 * really does give a child its own session — it maps that session onto the parent's budget instead of minting a
 * second one. The depth of the run is passed to `checkAllowance`, so a level past the canonical limit cannot
 * obtain an allowance at all.
 *
 * R1 adds the two scopes the per-session budget cannot express — **per day, per user** and **per day, per
 * Company** — and it adds them through the *same* manager rather than beside it: a daily budget is one more
 * key in `A2AQuotaManager`, so there is still exactly one place where spend is counted, and a run that would
 * breach the day's allowance is refused with an error the runner turns into its own `budget_exhausted` stop.
 *
 * The key carries the **date**, which is what makes the budget daily: a new day is a new, empty key, and a
 * process that runs across midnight needs no timer and no rollover job. It also means a restart cannot forget
 * the day's spend — the key is derived from the clock, not held in a counter that has to survive.
 *
 * Thresholds (R1 A.2: notification at 80 % and at 100 %) are emitted from here as events, once per key and
 * level. This module does not decide what a notification *is*: the composition root supplies `onThreshold` and
 * writes the event into the Coding Agent Activity stream, so "the user was told" is a stored record rather
 * than a log line that rotates away.
 */

import { A2AQuotaManager } from "./a2a-protocol-extensions";
import { CODE_SUBAGENT_MAX_NODE_DEPTH, clampCodeSubagentRegistryDepth } from "./code-subagent-limits";
import type { CodeRunQuotaPort } from "./coding-agent-runner";

/**
 * Defaults for a session that has no budget yet. They are the existing A2A defaults plus the same hard-ceiling
 * idiom as the run queue: an operator may configure a larger budget up to the ceiling, and a typo cannot remove
 * the cap altogether.
 */
export interface CodeRunBudgetLimits {
  maxTokens: number;
  maxCostUsd: number;
  /** The deepest run of the delegation tree that may draw on this budget (1 or 2, canonical). */
  maxDepth: number;
}

export const DEFAULT_CODE_RUN_BUDGET: CodeRunBudgetLimits = {
  maxTokens: 100_000,
  maxCostUsd: 1.0,
  maxDepth: CODE_SUBAGENT_MAX_NODE_DEPTH,
};

/** Hard ceilings: configuration may lower a budget, never raise it past what one node can serve. */
export const CODE_RUN_BUDGET_MAX_TOKENS = 10_000_000;
export const CODE_RUN_BUDGET_MAX_COST_USD = 1_000;

/**
 * R1 (section A, item 2): the daily and per-Company budgets.
 *
 * The start values are chosen so that the **daily** budget is generous for a working day and far below what a
 * runaway loop would spend: a session budget of 100 k tokens takes ten full sessions to reach the user's day,
 * and a Company of ten active users still fits inside its own day with room for a spike. They are start values,
 * not policy — every one of them is configurable and clamped by the ceilings below.
 */
export interface CodeRunDailyBudgetLimits {
  maxTokensPerUserPerDay: number;
  maxCostUsdPerUserPerDay: number;
  maxTokensPerCompanyPerDay: number;
  maxCostUsdPerCompanyPerDay: number;
}

export const DEFAULT_CODE_RUN_DAILY_BUDGET: CodeRunDailyBudgetLimits = {
  maxTokensPerUserPerDay: 2_000_000,
  maxCostUsdPerUserPerDay: 20,
  maxTokensPerCompanyPerDay: 10_000_000,
  maxCostUsdPerCompanyPerDay: 100,
};

export const CODE_RUN_DAILY_MAX_TOKENS = 1_000_000_000;
export const CODE_RUN_DAILY_MAX_COST_USD = 100_000;

function positive(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the budget from the environment, clamping every value. */
export function resolveCodeRunBudget(env: NodeJS.ProcessEnv = process.env): CodeRunBudgetLimits {
  // Total tokens include the input context on every tool round trip. A website
  // build needs more than the legacy 100k allowance, and multi-turn continuations
  // in the same conversation require budget across both turns. Align self_hosted/local
  // default with the daily user allowance (2M tokens).
  const defaultTokens = env.NPATI_DEPLOYMENT_TYPE === "self_hosted" || env.NPATI_SANDBOX_RUNNER_MODE === "local"
    ? 2_000_000 : DEFAULT_CODE_RUN_BUDGET.maxTokens;
  return {
    maxTokens: Math.min(positive(env.NPATI_CODE_RUN_MAX_TOKENS, defaultTokens), CODE_RUN_BUDGET_MAX_TOKENS),
    maxCostUsd: Math.min(positive(env.NPATI_CODE_RUN_MAX_COST_USD, DEFAULT_CODE_RUN_BUDGET.maxCostUsd), CODE_RUN_BUDGET_MAX_COST_USD),
    // The depth is the structural one: configuration cannot raise it past the canonical nesting limit.
    maxDepth: clampCodeSubagentRegistryDepth(env.NPATI_CODE_RUN_MAX_DEPTH ?? DEFAULT_CODE_RUN_BUDGET.maxDepth),
  };
}

/** Reads the daily budgets from the environment, clamping every value the same way. */
export function resolveCodeRunDailyBudget(env: NodeJS.ProcessEnv = process.env): CodeRunDailyBudgetLimits {
  return {
    maxTokensPerUserPerDay: Math.min(
      positive(env.NPATI_CODE_RUN_DAILY_MAX_TOKENS_PER_USER, DEFAULT_CODE_RUN_DAILY_BUDGET.maxTokensPerUserPerDay),
      CODE_RUN_DAILY_MAX_TOKENS,
    ),
    maxCostUsdPerUserPerDay: Math.min(
      positive(env.NPATI_CODE_RUN_DAILY_MAX_COST_USD_PER_USER, DEFAULT_CODE_RUN_DAILY_BUDGET.maxCostUsdPerUserPerDay),
      CODE_RUN_DAILY_MAX_COST_USD,
    ),
    maxTokensPerCompanyPerDay: Math.min(
      positive(env.NPATI_CODE_RUN_DAILY_MAX_TOKENS_PER_COMPANY, DEFAULT_CODE_RUN_DAILY_BUDGET.maxTokensPerCompanyPerDay),
      CODE_RUN_DAILY_MAX_TOKENS,
    ),
    maxCostUsdPerCompanyPerDay: Math.min(
      positive(env.NPATI_CODE_RUN_DAILY_MAX_COST_USD_PER_COMPANY, DEFAULT_CODE_RUN_DAILY_BUDGET.maxCostUsdPerCompanyPerDay),
      CODE_RUN_DAILY_MAX_COST_USD,
    ),
  };
}

/** Which allowance a threshold event is about. `session` is the per-run/session budget; the other two are daily. */
export type CodeRunBudgetScope = "session" | "user_daily" | "company_daily";

export interface CodeRunBudgetThresholdEvent {
  scope: CodeRunBudgetScope;
  /** `warning` at 80 % of the configured limit, `exhausted` at 100 %. */
  level: "warning" | "exhausted";
  /** The `A2AQuotaManager` key the allowance lives under. Carries the date for the two daily scopes. */
  budgetKey: string;
  /** The user or Company the daily scopes belong to; absent for the session scope. */
  subjectId?: string;
  /**
   * R1: the tenant the allowance belongs to, so a listener can route or persist the notice without re-deriving
   * it. Absent when the caller did not name one — the pre-R1 contract — in which case a listener that needs a
   * tenant must decline rather than guess.
   */
  userId?: string;
  companyId?: string;
  usedTokens: number;
  maxTokens: number;
  usedCostUsd: number;
  maxCostUsd: number;
}

/** The ratio at which R1 asks for a warning. One constant, named, so the two call sites cannot drift. */
export const CODE_RUN_BUDGET_WARNING_RATIO = 0.8;

export interface CodeRunSharedQuotaOptions {
  limits?: Partial<CodeRunBudgetLimits>;
  /** R1: the daily and per-Company budgets. Defaults to `resolveCodeRunDailyBudget()`. */
  dailyLimits?: Partial<CodeRunDailyBudgetLimits>;
  /**
   * Maps a run's session onto the session that owns the budget. Defaults to identity, which is what the coding
   * agent uses: a delegated run is a run of the parent's session, so one `sessionBudget` covers both. A
   * deployment that gives each child run its own session supplies the mapping here — and the child still draws
   * on the parent's allowance, because the alternative would be a second budget.
   */
  resolveBudgetKey?: (sessionId: string) => string;
  /** Clock injection for tests and for the day the daily keys are derived from. */
  now?: () => number;
  /**
   * R1 A.2: called once per budget key and level when the allowance crosses 80 % or reaches 100 %. A throwing
   * listener must never change a run, so every call is wrapped and its failure swallowed.
   */
  onThreshold?: (event: CodeRunBudgetThresholdEvent) => void;
}

export class CodeRunSharedQuota implements CodeRunQuotaPort {
  private readonly limits: CodeRunBudgetLimits;
  private readonly daily: CodeRunDailyBudgetLimits;
  private readonly now: () => number;
  /** The keys whose threshold was already reported, so a 200-turn run cannot emit 200 identical warnings. */
  private readonly notified = new Set<string>();
  private lastDay: string;

  constructor(
    private readonly manager: A2AQuotaManager,
    private readonly options: CodeRunSharedQuotaOptions = {},
  ) {
    const resolved = resolveCodeRunBudget();
    const resolvedDaily = resolveCodeRunDailyBudget();
    this.now = options.now ?? (() => Date.now());
    this.limits = {
      maxTokens: Math.min(positive(options.limits?.maxTokens, resolved.maxTokens), CODE_RUN_BUDGET_MAX_TOKENS),
      maxCostUsd: Math.min(positive(options.limits?.maxCostUsd, resolved.maxCostUsd), CODE_RUN_BUDGET_MAX_COST_USD),
      maxDepth: clampCodeSubagentRegistryDepth(options.limits?.maxDepth ?? resolved.maxDepth),
    };
    this.daily = {
      maxTokensPerUserPerDay: Math.min(
        positive(options.dailyLimits?.maxTokensPerUserPerDay, resolvedDaily.maxTokensPerUserPerDay),
        CODE_RUN_DAILY_MAX_TOKENS,
      ),
      maxCostUsdPerUserPerDay: Math.min(
        positive(options.dailyLimits?.maxCostUsdPerUserPerDay, resolvedDaily.maxCostUsdPerUserPerDay),
        CODE_RUN_DAILY_MAX_COST_USD,
      ),
      maxTokensPerCompanyPerDay: Math.min(
        positive(options.dailyLimits?.maxTokensPerCompanyPerDay, resolvedDaily.maxTokensPerCompanyPerDay),
        CODE_RUN_DAILY_MAX_TOKENS,
      ),
      maxCostUsdPerCompanyPerDay: Math.min(
        positive(options.dailyLimits?.maxCostUsdPerCompanyPerDay, resolvedDaily.maxCostUsdPerCompanyPerDay),
        CODE_RUN_DAILY_MAX_COST_USD,
      ),
    };
    this.lastDay = this.dayKey();
  }

  /** The budget this adapter enforces for a session that has none configured yet. */
  get budget(): CodeRunBudgetLimits {
    return { ...this.limits };
  }

  /** R1: the daily/Company budgets in force, so a status surface can render them without re-reading the env. */
  get dailyBudget(): CodeRunDailyBudgetLimits {
    return { ...this.daily };
  }

  private budgetKey(sessionId: string): string {
    return this.options.resolveBudgetKey ? this.options.resolveBudgetKey(sessionId) : sessionId;
  }

  /** The UTC date the daily budgets are keyed by. UTC, so two replicas in different zones agree on "today". */
  private dayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private dailyKey(scope: "user" | "company", id: string): string {
    return `code-run-daily:${this.dayKey()}:${scope}:${id}`;
  }

  /**
   * Configures the budget **once** per session, and never over an operator's own configuration: a budget set
   * through the A2A control plane stays exactly as it was set. The daily keys use the same rule.
   */
  private ensureBudget(key: string): void {
    if (this.manager.getBudget(key)) return;
    this.manager.setSessionBudget(key, this.limits.maxTokens, this.limits.maxCostUsd, this.limits.maxDepth);
  }

  private ensureDailyBudget(key: string, maxTokens: number, maxCostUsd: number): void {
    if (this.manager.getBudget(key)) return;
    // The depth bound is the canonical one: a daily allowance is not a delegation level, so `1` at check time
    // must never be refused by it.
    this.manager.setSessionBudget(key, maxTokens, maxCostUsd, CODE_SUBAGENT_MAX_NODE_DEPTH);
  }

  checkQuota(
    sessionId: string,
    requestedTokens: number,
    estimatedCostUsd: number,
    currentDepth = 1,
    /**
     * R1 A.2: who is spending. The runner passes the run's user and Company, so the two daily allowances can be
     * enforced here. They are **optional**: a caller that names neither (the pre-R1 contract, and every test of
     * it) gets exactly the per-session behaviour, because a daily limit that refuses everything whenever the
     * caller forgot a parameter would be a worse failure than a missing limit.
     */
    scope: { userId?: string; companyId?: string } = {},
  ): { allowed: boolean; error?: string; remainingTokens?: number; remainingCostUsd?: number } {
    this.rollover();
    const key = this.budgetKey(sessionId);
    this.ensureBudget(key);
    const verdict = this.manager.checkAllowance(key, requestedTokens, estimatedCostUsd, currentDepth);
    if (!verdict.allowed) {
      this.reportThreshold(key, "session", undefined, scope);
      return {
        allowed: false,
        ...(verdict.error ? { error: verdict.error } : {}),
        remainingTokens: verdict.remainingTokens,
        remainingCostUsd: verdict.remainingCostUsd,
      };
    }

    const dailyScopes: Array<{ scope: "user_daily" | "company_daily"; key: string; subjectId: string; label: string }> = [];
    if (scope.userId) {
      dailyScopes.push({
        scope: "user_daily",
        key: this.dailyKey("user", scope.userId),
        subjectId: scope.userId,
        label: "user",
      });
    }
    if (scope.companyId) {
      dailyScopes.push({
        scope: "company_daily",
        key: this.dailyKey("company", scope.companyId),
        subjectId: scope.companyId,
        label: "Company",
      });
    }
    for (const entry of dailyScopes) {
      const maxTokens = entry.scope === "user_daily" ? this.daily.maxTokensPerUserPerDay : this.daily.maxTokensPerCompanyPerDay;
      const maxCostUsd = entry.scope === "user_daily" ? this.daily.maxCostUsdPerUserPerDay : this.daily.maxCostUsdPerCompanyPerDay;
      this.ensureDailyBudget(entry.key, maxTokens, maxCostUsd);
      const dailyVerdict = this.manager.checkAllowance(entry.key, requestedTokens, estimatedCostUsd, 1);
      if (dailyVerdict.allowed) continue;
      this.reportThreshold(entry.key, entry.scope, entry.subjectId, scope);
      const budget = this.manager.getBudget(entry.key);
      const usedTokens = budget?.usedTokens ?? 0;
      const usedCostUsd = budget?.usedCostUsd ?? 0;
      return {
        allowed: false,
        error:
          `A2A_DAILY_QUOTA_EXCEEDED: the daily code-run budget for this ${entry.label} is exhausted ` +
          `(${usedTokens}/${maxTokens} tokens, $${usedCostUsd.toFixed(4)}/$${maxCostUsd.toFixed(2)}). ` +
          `The day's allowance resets at 00:00 UTC; a larger allowance is configured with the ` +
          `NPATI_CODE_RUN_DAILY_* settings.`,
        remainingTokens: dailyVerdict.remainingTokens,
        remainingCostUsd: dailyVerdict.remainingCostUsd,
      };
    }
    return {
      allowed: true,
      remainingTokens: verdict.remainingTokens,
      remainingCostUsd: verdict.remainingCostUsd,
    };
  }

  recordUsage(
    sessionId: string,
    tokens: number,
    costUsd: number,
    scope: { userId?: string; companyId?: string } = {},
  ): void {
    this.rollover();
    const key = this.budgetKey(sessionId);
    this.ensureBudget(key);
    this.manager.recordUsage(key, tokens, costUsd);
    this.reportThreshold(key, "session", undefined, scope);
    if (scope.userId) {
      const userKey = this.dailyKey("user", scope.userId);
      this.ensureDailyBudget(userKey, this.daily.maxTokensPerUserPerDay, this.daily.maxCostUsdPerUserPerDay);
      this.manager.recordUsage(userKey, tokens, costUsd);
      this.reportThreshold(userKey, "user_daily", scope.userId, scope);
    }
    if (scope.companyId) {
      const companyKey = this.dailyKey("company", scope.companyId);
      this.ensureDailyBudget(companyKey, this.daily.maxTokensPerCompanyPerDay, this.daily.maxCostUsdPerCompanyPerDay);
      this.manager.recordUsage(companyKey, tokens, costUsd);
      this.reportThreshold(companyKey, "company_daily", scope.companyId, scope);
    }
  }

  /**
   * A new UTC day is a new set of keys, so the "already told them" bookkeeping must be dropped rather than
   * carried: otherwise the second day's warning would be suppressed by the first day's record, and the set
   * would grow by a key per user per Company per day for the life of the process.
   */
  private rollover(): void {
    const day = this.dayKey();
    if (day === this.lastDay) return;
    this.lastDay = day;
    this.notified.clear();
  }

  private reportThreshold(key: string, scope: CodeRunBudgetScope, subjectId?: string, tenant: { userId?: string; companyId?: string } = {}): void {
    const listener = this.options.onThreshold;
    if (!listener) return;
    const budget = this.manager.getBudget(key);
    if (!budget) return;
    const ratio = Math.max(
      budget.maxTokens > 0 ? budget.usedTokens / budget.maxTokens : 0,
      budget.maxCostUsd > 0 ? budget.usedCostUsd / budget.maxCostUsd : 0,
    );
    const level: "warning" | "exhausted" | null = ratio >= 1 ? "exhausted" : ratio >= CODE_RUN_BUDGET_WARNING_RATIO ? "warning" : null;
    if (!level) return;
    const marker = `${key}:${level}`;
    if (this.notified.has(marker)) return;
    this.notified.add(marker);
    try {
      listener({
        scope,
        level,
        budgetKey: key,
        ...(subjectId ? { subjectId } : {}),
        ...(tenant.userId ? { userId: tenant.userId } : {}),
        ...(tenant.companyId ? { companyId: tenant.companyId } : {}),
        usedTokens: budget.usedTokens,
        maxTokens: budget.maxTokens,
        usedCostUsd: budget.usedCostUsd,
        maxCostUsd: budget.maxCostUsd,
      });
    } catch {
      // A notification is bookkeeping: it must never change a run's outcome. The accounting already happened.
    }
  }
}
