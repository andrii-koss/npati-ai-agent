/* Chat reply telemetry headers.
 * Extracted verbatim from app.ts (step 2a of docs/refactoring/PLAN.md).
 */
import { CostTelemetry } from "./cost-telemetry";
import { AgentReply } from "@npati/shared";

export function applyChatTelemetryHeaders(reply: { header(name: string, value: string): unknown }, result: { model?: string; telemetry?: AgentReply["telemetry"] }) {
  if (!result.telemetry) return;
  const usage = result.telemetry.usage;
  const costUsd = result.telemetry.costUsd ?? (usage ? CostTelemetry.calculate(result.model ?? "auto", usage).totalCostUsd : 0);
  const headers = CostTelemetry.getRunTelemetryHeaders({
    requestId: result.telemetry.requestId ?? crypto.randomUUID(),
    modelId: result.model,
    provider: result.telemetry.provider,
    strategy: result.telemetry.routingStrategy,
    totalTokens: usage?.totalTokens,
    totalCostUsd: costUsd,
    latencyMs: result.telemetry.latencyMs,
    cacheHit: result.telemetry.cacheHit,
    cachedTokens: usage?.cachedTokens,
    cacheSavingsUsd: result.telemetry.cacheSavingsUsd,
    failoverCount: result.telemetry.failoverCount,
    costSource: result.telemetry.costSource ?? "estimated",
  });
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
}

/** Workspace used by background jobs (chain verifier, anchors) when no user context exists. */
