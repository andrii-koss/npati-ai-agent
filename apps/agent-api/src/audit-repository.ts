import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";

export interface AuditLogEntry {
  id: string;
  workspaceId: string;
  companyId: string;
  userId: string;
  action: string;
  category: "auth" | "agent" | "mcp" | "automation" | "security" | "general";
  resourceType: string;
  resourceId?: string | null;
  details: Record<string, unknown>;
  ipAddress?: string | null;
  createdAt: string;
}

export interface UsageMetricEntry {
  id: string;
  workspaceId: string;
  companyId: string;
  agentId?: string | null;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  requestId?: string | null;
  providerId?: string | null;
  routingStrategy?: string | null;
  cacheHit: boolean;
  cachedTokens: number;
  cacheSavingsUsd: number;
  failoverCount: number;
  costSource: "upstream" | "estimated";
  createdAt: string;
}

export interface UsageAnalyticsSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  totalCachedTokens: number;
  totalCacheSavingsUsd: number;
  cacheHits: number;
  totalFailovers: number;
  byModel: Record<string, { requests: number; costUsd: number; tokens: number }>;
}

export class AuditRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  // --- Audit Trail (Item 109) ---
  async log(
    ctx: AuthContext,
    companyId: string,
    entry: {
      action: string;
      category?: "auth" | "agent" | "mcp" | "automation" | "security" | "general";
      resourceType: string;
      resourceId?: string;
      details?: Record<string, unknown>;
      ipAddress?: string;
    }
  ): Promise<AuditLogEntry> {
    const id = randomUUID();
    const result = await this.pool.query<AuditLogEntry>(
      `INSERT INTO company_audit_logs(
        id, workspace_id, company_id, user_id, action, category, resource_type, resource_id, details, ip_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING
        id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
        action, category, resource_type AS "resourceType", resource_id AS "resourceId",
        details, ip_address AS "ipAddress", created_at AS "createdAt"`,
      [
        id,
        ctx.workspaceId,
        companyId,
        ctx.userId,
        entry.action,
        entry.category || "general",
        entry.resourceType,
        entry.resourceId || null,
        JSON.stringify(entry.details || {}),
        entry.ipAddress || null,
      ]
    );
    return result.rows[0]!;
  }

  async listAuditLogs(
    ctx: AuthContext,
    companyId: string,
    limit = 50
  ): Promise<AuditLogEntry[]> {
    const result = await this.pool.query<AuditLogEntry>(
      `SELECT
        id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
        action, category, resource_type AS "resourceType", resource_id AS "resourceId",
        details, ip_address AS "ipAddress", created_at AS "createdAt"
      FROM company_audit_logs
      WHERE workspace_id = $1 AND company_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
      [ctx.workspaceId, companyId, Math.min(100, Math.max(1, limit))]
    );
    return result.rows;
  }

  async listResourceLogs(
    ctx: AuthContext,
    companyId: string,
    resourceType: string,
    resourceId: string,
    limit = 100
  ): Promise<AuditLogEntry[]> {
    const result = await this.pool.query<AuditLogEntry>(
      `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
        action, category, resource_type AS "resourceType", resource_id AS "resourceId",
        details, ip_address AS "ipAddress", created_at AS "createdAt"
       FROM company_audit_logs
       WHERE workspace_id=$1 AND company_id=$2 AND resource_type=$3 AND resource_id=$4
       ORDER BY created_at ASC LIMIT $5`,
      [ctx.workspaceId, companyId, resourceType, resourceId, Math.min(200, Math.max(1, limit))]
    );
    return result.rows;
  }

  // --- Usage Analytics & Quota Tracking (Items 102 & 103) ---
  async recordUsage(
    ctx: AuthContext,
    companyId: string,
    metric: {
      agentId?: string;
      modelId: string;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      latencyMs: number;
      requestId?: string;
      providerId?: string;
      routingStrategy?: string;
      cacheHit?: boolean;
      cachedTokens?: number;
      cacheSavingsUsd?: number;
      failoverCount?: number;
      costSource?: "upstream" | "estimated";
    }
  ): Promise<UsageMetricEntry> {
    const id = randomUUID();
    const result = await this.pool.query<UsageMetricEntry>(
      `INSERT INTO company_usage_metrics(
        id, workspace_id, company_id, agent_id, model_id, prompt_tokens, completion_tokens, cost_usd, latency_ms,
        request_id, provider_id, routing_strategy, cache_hit, cached_tokens, cache_savings_usd, failover_count, cost_source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING
        id, workspace_id AS "workspaceId", company_id AS "companyId", agent_id AS "agentId",
        model_id AS "modelId", prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
        cost_usd::float AS "costUsd", latency_ms AS "latencyMs", request_id AS "requestId",
        provider_id AS "providerId", routing_strategy AS "routingStrategy", cache_hit AS "cacheHit",
        cached_tokens::float AS "cachedTokens", cache_savings_usd::float AS "cacheSavingsUsd",
        failover_count AS "failoverCount", cost_source AS "costSource", created_at AS "createdAt"`,
      [
        id,
        ctx.workspaceId,
        companyId,
        metric.agentId || null,
        metric.modelId,
        metric.promptTokens,
        metric.completionTokens,
        metric.costUsd,
        metric.latencyMs,
        metric.requestId ?? null,
        metric.providerId ?? null,
        metric.routingStrategy ?? null,
        metric.cacheHit ?? false,
        metric.cachedTokens ?? 0,
        metric.cacheSavingsUsd ?? 0,
        metric.failoverCount ?? 0,
        metric.costSource ?? "estimated",
      ]
    );
    return result.rows[0]!;
  }

  async getUsageAnalytics(
    ctx: AuthContext,
    companyId: string
  ): Promise<UsageAnalyticsSummary> {
    const result = await this.pool.query<{
      model_id: string;
      request_count: string;
      total_prompt_tokens: string;
      total_completion_tokens: string;
      total_cost_usd: string;
      avg_latency_ms: string;
      total_cached_tokens: string;
      total_cache_savings_usd: string;
      cache_hits: string;
      total_failovers: string;
    }>(
      `SELECT
        model_id,
        COUNT(*) AS request_count,
        SUM(prompt_tokens) AS total_prompt_tokens,
        SUM(completion_tokens) AS total_completion_tokens,
        SUM(cost_usd) AS total_cost_usd,
        AVG(latency_ms) AS avg_latency_ms,
        SUM(cached_tokens) AS total_cached_tokens,
        SUM(cache_savings_usd) AS total_cache_savings_usd,
        COUNT(*) FILTER (WHERE cache_hit) AS cache_hits,
        SUM(failover_count) AS total_failovers
      FROM company_usage_metrics
      WHERE workspace_id = $1 AND company_id = $2
      GROUP BY model_id`,
      [ctx.workspaceId, companyId]
    );

    let totalRequests = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCostUsd = 0;
    let sumLatency = 0;
    let totalCachedTokens = 0;
    let totalCacheSavingsUsd = 0;
    let cacheHits = 0;
    let totalFailovers = 0;
    const byModel: Record<string, { requests: number; costUsd: number; tokens: number }> = {};

    for (const row of result.rows) {
      const requests = parseInt(row.request_count, 10) || 0;
      const pTokens = parseInt(row.total_prompt_tokens, 10) || 0;
      const cTokens = parseInt(row.total_completion_tokens, 10) || 0;
      const cost = parseFloat(row.total_cost_usd) || 0;
      const latency = parseFloat(row.avg_latency_ms) || 0;
      const cachedTokens = parseInt(row.total_cached_tokens, 10) || 0;
      const cacheSavingsUsd = parseFloat(row.total_cache_savings_usd) || 0;

      totalRequests += requests;
      totalPromptTokens += pTokens;
      totalCompletionTokens += cTokens;
      totalCostUsd += cost;
      sumLatency += latency * requests;
      totalCachedTokens += cachedTokens;
      totalCacheSavingsUsd += cacheSavingsUsd;
      cacheHits += parseInt(row.cache_hits, 10) || 0;
      totalFailovers += parseInt(row.total_failovers, 10) || 0;

      byModel[row.model_id] = {
        requests,
        costUsd: Number(cost.toFixed(4)),
        tokens: pTokens + cTokens,
      };
    }

    return {
      totalRequests,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      averageLatencyMs: totalRequests > 0 ? Math.round(sumLatency / totalRequests) : 0,
      totalCachedTokens,
      totalCacheSavingsUsd: Number(totalCacheSavingsUsd.toFixed(6)),
      cacheHits,
      totalFailovers,
      byModel,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
