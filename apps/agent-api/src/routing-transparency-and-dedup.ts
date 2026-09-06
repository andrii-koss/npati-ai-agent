import { randomUUID } from "node:crypto";

export interface TenantQuotaShare {
  tenantId: string;
  tier: "starter" | "pro" | "enterprise";
  allocatedSharePercent: number; // e.g. 10%, 30%, 60%
  activeRequests: number;
}

export interface RoutingDecisionMetadata {
  requestId: string;
  strategy: string;
  provider: string;
  modelId: string;
  latencyMs: number;
  estimatedCostUsd: number;
  cacheHit: boolean;
  failoverCount: number;
  timestamp: string;
}

export interface DeduplicationResult {
  deduplicatedMessages: Array<{ role: string; content: string }>;
  originalLength: number;
  deduplicatedLength: number;
  estimatedTokensSaved: number;
}

export class QuotaShareRouter {
  private readonly shares = new Map<string, TenantQuotaShare>();

  /**
   * 1. Quota-Share Routing: Fair-share multi-tenant provider quota partitioning
   */
  setTenantShare(
    tenantId: string,
    tier: "starter" | "pro" | "enterprise",
    sharePercent: number
  ): void {
    this.shares.set(tenantId, {
      tenantId,
      tier,
      allocatedSharePercent: sharePercent,
      activeRequests: 0,
    });
  }

  isAdmitted(
    tenantId: string,
    currentGlobalRpm: number,
    maxGlobalRpm: number
  ): { admitted: boolean; reason: string } {
    const tenant = this.shares.get(tenantId);
    const globalSaturation = maxGlobalRpm > 0 ? currentGlobalRpm / maxGlobalRpm : 0;

    // Below 80% saturation -> all tenants admitted
    if (globalSaturation < 0.8) {
      return { admitted: true, reason: "Cluster is operating below 80% saturation." };
    }

    if (!tenant) {
      return {
        admitted: false,
        reason: "Tenant has no allocated quota share during peak saturation.",
      };
    }

    // When saturated, high-tier has priority
    if (tenant.tier === "enterprise") {
      return { admitted: true, reason: "Enterprise tenant guaranteed quota share." };
    }

    if (tenant.tier === "pro" && globalSaturation < 0.95) {
      return { admitted: true, reason: "Pro tenant admitted below 95% saturation." };
    }

    return {
      admitted: false,
      reason: `Tenant tier '${tenant.tier}' throttled to preserve fair share during peak saturation (${Math.round(globalSaturation * 100)}%).`,
    };
  }
}

export class RoutingTransparencyLogger {
  /**
   * 2. Routing Transparency: Attaches standard transparency headers and logs decisions
   */
  static generateTransparencyHeaders(
    decision: RoutingDecisionMetadata
  ): Record<string, string> {
    return {
      "X-NPATI-Request-ID": decision.requestId,
      "X-NPATI-Routing-Strategy": decision.strategy,
      "X-NPATI-Selected-Provider": decision.provider,
      "X-NPATI-Selected-Model": decision.modelId,
      "X-NPATI-Estimated-Cost-USD": decision.estimatedCostUsd.toFixed(6),
      "X-NPATI-Cache-Hit": decision.cacheHit ? "true" : "false",
      "X-NPATI-Failover-Count": String(decision.failoverCount),
      "X-NPATI-Latency-MS": String(decision.latencyMs),
    };
  }

  static createDecisionRecord(params: {
    strategy: string;
    provider: string;
    modelId: string;
    latencyMs: number;
    estimatedCostUsd?: number;
    cacheHit?: boolean;
    failoverCount?: number;
  }): RoutingDecisionMetadata {
    return {
      requestId: `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      strategy: params.strategy,
      provider: params.provider,
      modelId: params.modelId,
      latencyMs: params.latencyMs,
      estimatedCostUsd: params.estimatedCostUsd ?? 0.001,
      cacheHit: params.cacheHit ?? false,
      failoverCount: params.failoverCount ?? 0,
      timestamp: new Date().toISOString(),
    };
  }
}

export class SessionPromptDeduplicator {
  /**
   * 3. Session-Dedup: Detects and removes redundant system prompts / repeated prefixes
   */
  static deduplicate(
    messages: Array<{ role: string; content: string }>
  ): DeduplicationResult {
    let originalLength = 0;
    let deduplicatedLength = 0;

    const seenSystemContents = new Set<string>();
    const deduplicatedMessages: Array<{ role: string; content: string }> = [];

    for (const msg of messages) {
      originalLength += msg.content.length;

      if (msg.role === "system") {
        if (seenSystemContents.has(msg.content)) {
          // Repeated system prompt in same session -> replace with compact placeholder
          const compact = `[Inherited System Prompt: Ref #${seenSystemContents.size}]`;
          deduplicatedMessages.push({ role: "system", content: compact });
          deduplicatedLength += compact.length;
          continue;
        }
        seenSystemContents.add(msg.content);
      }

      deduplicatedMessages.push(msg);
      deduplicatedLength += msg.content.length;
    }

    const tokensSaved = Math.max(0, Math.ceil((originalLength - deduplicatedLength) / 4));

    return {
      deduplicatedMessages,
      originalLength,
      deduplicatedLength,
      estimatedTokensSaved: tokensSaved,
    };
  }
}
