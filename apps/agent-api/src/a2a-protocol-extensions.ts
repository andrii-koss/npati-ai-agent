import { usageQuotasEnabled } from "./usage-quota-policy";
import {
  CODE_SUBAGENT_MAX_NODE_DEPTH,
  clampCodeSubagentRegistryDepth,
} from "./code-subagent-limits";

export interface AgentQuotaBudget {
  sessionId: string;
  maxTokens: number;
  usedTokens: number;
  maxCostUsd: number;
  usedCostUsd: number;
  maxRecursionDepth: number;
}

export interface DiscoveredAgentProfile {
  agentId: string;
  name: string;
  capabilities: string[];
  preferredModel: string;
  healthScore: number; // 0.0 to 1.0
  avgLatencyMs: number;
  isAvailable: boolean;
}

export interface AgentDelegationCostItem {
  traceId: string;
  agentId: string;
  parentAgentId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  timestamp: string;
}

export interface TreeCostSummary {
  traceId: string;
  totalTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  agentBreakdown: Record<string, { tokens: number; costUsd: number; callsCount: number }>;
}

export class A2AQuotaManager {
  private readonly budgets = new Map<string, AgentQuotaBudget>();

  /**
   * 1. A2A Quota Management: Tracks & enforces sub-agent token and cost allowances
   *
   * C12: the depth bound is no longer this class's own literal (it was 5, while the registry used 4 and the
   * coding config said 1). It now defaults to the canonical subagent limit — expressed as the node depth, so
   * "one level of delegation" is 2 here because the root counts as 1 — and an explicit value is clamped to the
   * declared registry ceiling, so a caller can no longer hand this budget an unbounded depth.
   */
  setSessionBudget(sessionId: string, maxTokens = 100_000, maxCostUsd = 1.0, maxDepth = CODE_SUBAGENT_MAX_NODE_DEPTH): AgentQuotaBudget {
    const budget: AgentQuotaBudget = {
      sessionId,
      maxTokens,
      usedTokens: 0,
      maxCostUsd,
      usedCostUsd: 0,
      maxRecursionDepth: clampCodeSubagentRegistryDepth(maxDepth),
    };
    this.budgets.set(sessionId, budget);
    return budget;
  }

  /**
   * C12: read-only access to a session's budget, so a caller can tell "an operator configured this" from
   * "this manager will invent a default on the next check". `checkAllowance` keeps its auto-create behaviour
   * for compatibility, but the coding runner's adapter now configures the budget explicitly first instead of
   * relying on a default it does not own.
   */
  getBudget(sessionId: string): AgentQuotaBudget | undefined {
    return this.budgets.get(sessionId);
  }

  checkAllowance(
    sessionId: string,
    requestedTokens: number,
    estimatedCostUsd: number,
    currentDepth = 1
  ): { allowed: boolean; remainingTokens: number; remainingCostUsd: number; error?: string } {
    const budget = this.budgets.get(sessionId) || this.setSessionBudget(sessionId);

    if (currentDepth > budget.maxRecursionDepth) {
      return {
        allowed: false,
        remainingTokens: Math.max(0, budget.maxTokens - budget.usedTokens),
        remainingCostUsd: Math.max(0, budget.maxCostUsd - budget.usedCostUsd),
        error: `A2A_MAX_DEPTH_EXCEEDED: Sub-agent recursion depth ${currentDepth} exceeds limit ${budget.maxRecursionDepth}.`,
      };
    }

    if (usageQuotasEnabled() && budget.usedTokens + requestedTokens > budget.maxTokens) {
      return {
        allowed: false,
        remainingTokens: Math.max(0, budget.maxTokens - budget.usedTokens),
        remainingCostUsd: Math.max(0, budget.maxCostUsd - budget.usedCostUsd),
        error: `A2A_TOKEN_QUOTA_EXCEEDED: Session budget exhausted (${budget.usedTokens}/${budget.maxTokens} tokens).`,
      };
    }

    if (usageQuotasEnabled() && budget.usedCostUsd + estimatedCostUsd > budget.maxCostUsd) {
      return {
        allowed: false,
        remainingTokens: Math.max(0, budget.maxTokens - budget.usedTokens),
        remainingCostUsd: Math.max(0, budget.maxCostUsd - budget.usedCostUsd),
        error: `A2A_COST_QUOTA_EXCEEDED: Session spend budget exceeded ($${budget.usedCostUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(2)}).`,
      };
    }

    return {
      allowed: true,
      remainingTokens: budget.maxTokens - budget.usedTokens - requestedTokens,
      remainingCostUsd: budget.maxCostUsd - budget.usedCostUsd - estimatedCostUsd,
    };
  }

  recordUsage(sessionId: string, tokens: number, costUsd: number): void {
    const budget = this.budgets.get(sessionId) || this.setSessionBudget(sessionId);
    budget.usedTokens += tokens;
    budget.usedCostUsd += costUsd;
  }
}

export class A2AProviderDiscovery {
  private readonly registry = new Map<string, DiscoveredAgentProfile>();

  /**
   * 2. A2A Provider Discovery: Registers & discovers peer agents by capability
   */
  registerAgent(profile: DiscoveredAgentProfile): void {
    this.registry.set(profile.agentId, profile);
  }

  discoverAgents(
    capability: string,
    options: { minHealth?: number; limit?: number } = {}
  ): DiscoveredAgentProfile[] {
    const minHealth = options.minHealth ?? 0.5;
    const limit = options.limit ?? 5;
    const capLower = capability.toLowerCase();

    const matching = Array.from(this.registry.values()).filter(
      (a) =>
        a.isAvailable &&
        a.healthScore >= minHealth &&
        a.capabilities.some((c) => c.toLowerCase().includes(capLower))
    );

    // Rank by healthScore descending and latency ascending
    matching.sort((a, b) => b.healthScore - a.healthScore || a.avgLatencyMs - b.avgLatencyMs);

    return matching.slice(0, limit);
  }
}

export class A2ACostAnalyzer {
  private readonly records = new Map<string, AgentDelegationCostItem[]>();

  /**
   * 3. A2A Cost Analysis: Tracks and analyzes multi-agent delegation cost trees
   */
  recordDelegation(item: AgentDelegationCostItem): void {
    const list = this.records.get(item.traceId) || [];
    list.push(item);
    this.records.set(item.traceId, list);
  }

  analyzeTraceCosts(traceId: string): TreeCostSummary {
    const list = this.records.get(traceId) || [];

    let totalTokens = 0;
    let totalCostUsd = 0;
    let totalDurationMs = 0;
    const agentBreakdown: Record<string, { tokens: number; costUsd: number; callsCount: number }> = {};

    for (const rec of list) {
      totalTokens += rec.inputTokens + rec.outputTokens;
      totalCostUsd += rec.costUsd;
      totalDurationMs += rec.durationMs;

      if (!agentBreakdown[rec.agentId]) {
        agentBreakdown[rec.agentId] = { tokens: 0, costUsd: 0, callsCount: 0 };
      }

      agentBreakdown[rec.agentId]!.tokens += rec.inputTokens + rec.outputTokens;
      agentBreakdown[rec.agentId]!.costUsd += rec.costUsd;
      agentBreakdown[rec.agentId]!.callsCount += 1;
    }

    return {
      traceId,
      totalTokens,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalDurationMs,
      agentBreakdown,
    };
  }
}
