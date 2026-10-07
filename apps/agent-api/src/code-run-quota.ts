/**
 * C12: the coding agent's budget, expressed as the port the runner already calls.
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

function positive(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the budget from the environment, clamping every value. */
export function resolveCodeRunBudget(env: NodeJS.ProcessEnv = process.env): CodeRunBudgetLimits {
  return {
    maxTokens: Math.min(positive(env.NPATI_CODE_RUN_MAX_TOKENS, DEFAULT_CODE_RUN_BUDGET.maxTokens), CODE_RUN_BUDGET_MAX_TOKENS),
    maxCostUsd: Math.min(positive(env.NPATI_CODE_RUN_MAX_COST_USD, DEFAULT_CODE_RUN_BUDGET.maxCostUsd), CODE_RUN_BUDGET_MAX_COST_USD),
    // The depth is the structural one: configuration cannot raise it past the canonical nesting limit.
    maxDepth: clampCodeSubagentRegistryDepth(env.NPATI_CODE_RUN_MAX_DEPTH ?? DEFAULT_CODE_RUN_BUDGET.maxDepth),
  };
}

export interface CodeRunSharedQuotaOptions {
  limits?: Partial<CodeRunBudgetLimits>;
  /**
   * Maps a run's session onto the session that owns the budget. Defaults to identity, which is what the coding
   * agent uses: a delegated run is a run of the parent's session, so one `sessionBudget` covers both. A
   * deployment that gives each child run its own session supplies the mapping here — and the child still draws
   * on the parent's allowance, because the alternative would be a second budget.
   */
  resolveBudgetKey?: (sessionId: string) => string;
  /** Clock injection for tests; unused by the accounting itself. */
  now?: () => number;
}

export class CodeRunSharedQuota implements CodeRunQuotaPort {
  private readonly limits: CodeRunBudgetLimits;

  constructor(
    private readonly manager: A2AQuotaManager,
    private readonly options: CodeRunSharedQuotaOptions = {},
  ) {
    const resolved = resolveCodeRunBudget();
    this.limits = {
      maxTokens: Math.min(positive(options.limits?.maxTokens, resolved.maxTokens), CODE_RUN_BUDGET_MAX_TOKENS),
      maxCostUsd: Math.min(positive(options.limits?.maxCostUsd, resolved.maxCostUsd), CODE_RUN_BUDGET_MAX_COST_USD),
      maxDepth: clampCodeSubagentRegistryDepth(options.limits?.maxDepth ?? resolved.maxDepth),
    };
  }

  /** The budget this adapter enforces for a session that has none configured yet. */
  get budget(): CodeRunBudgetLimits {
    return { ...this.limits };
  }

  private budgetKey(sessionId: string): string {
    return this.options.resolveBudgetKey ? this.options.resolveBudgetKey(sessionId) : sessionId;
  }

  /**
   * Configures the budget **once** per session, and never over an operator's own configuration: a budget set
   * through the A2A control plane stays exactly as it was set.
   */
  private ensureBudget(key: string): void {
    if (this.manager.getBudget(key)) return;
    this.manager.setSessionBudget(key, this.limits.maxTokens, this.limits.maxCostUsd, this.limits.maxDepth);
  }

  checkQuota(
    sessionId: string,
    requestedTokens: number,
    estimatedCostUsd: number,
    currentDepth = 1,
  ): { allowed: boolean; error?: string; remainingTokens?: number; remainingCostUsd?: number } {
    const key = this.budgetKey(sessionId);
    this.ensureBudget(key);
    const verdict = this.manager.checkAllowance(key, requestedTokens, estimatedCostUsd, currentDepth);
    return {
      allowed: verdict.allowed,
      ...(verdict.error ? { error: verdict.error } : {}),
      remainingTokens: verdict.remainingTokens,
      remainingCostUsd: verdict.remainingCostUsd,
    };
  }

  recordUsage(sessionId: string, tokens: number, costUsd: number): void {
    const key = this.budgetKey(sessionId);
    this.ensureBudget(key);
    this.manager.recordUsage(key, tokens, costUsd);
  }
}
