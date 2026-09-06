import type { CompanyAgentRun, CompanyAgentRunStep, CompanyAgentToolAudit } from "@npati/workspace";

export type ActivityEventType =
  | "run_started"
  | "step_delegated"
  | "tool_requested"
  | "tool_executed"
  | "tool_blocked"
  | "tool_failed"
  | "run_completed"
  | "run_failed"
  | "run_cancelled";

export interface ActivityTimelineItem {
  id: string;
  runId: string;
  timestamp: string;
  sequenceNumber: number;
  type: ActivityEventType;
  agentId?: string;
  agentName?: string;
  toolName?: string;
  decision?: "allowed" | "denied";
  status?: string;
  summary: string;
  latencyMs?: number;
  cost?: number;
  tokens?: number;
  reasonCode?: string;
  detail?: Record<string, unknown>;
}

export interface CompanyAccounting {
  totalRuns: number;
  totalCost: number;
  totalTokens: number;
  totalDurationMs: number;
}

export interface UserAccounting {
  totalRuns: number;
  totalCost: number;
  totalTokens: number;
}

export interface AgentAccounting {
  totalCalls: number;
  totalCost: number;
  totalTokens: number;
  totalDurationMs: number;
}

export interface RunAccounting {
  byCompany: Record<string, CompanyAccounting>;
  byUser: Record<string, UserAccounting>;
  byAgent: Record<string, AgentAccounting>;
  totalCost: number;
  totalTokens: number;
  totalRuns: number;
}

export interface TracePaginationOptions {
  limit?: number;
  cursor?: string;
}

export interface TracePage<T> {
  items: T[];
  limit: number;
  nextCursor?: string;
  totalCount: number;
}

/**
 * Builds a user-facing and developer-friendly Activity Timeline from a Run, Steps, and Tool Audits.
 * Guarantee: NO internal hidden chain-of-thought is emitted.
 * Ordering: Deterministic sort by timestamp, sequenceNumber, and id.
 */
export function buildRunTimeline(
  run: CompanyAgentRun,
  steps: CompanyAgentRunStep[],
  toolAudits: CompanyAgentToolAudit[],
  agentsMap?: Map<string, string>
): ActivityTimelineItem[] {
  const items: ActivityTimelineItem[] = [];
  let seq = 0;

  const agentName = (id?: string) => (id ? agentsMap?.get(id) ?? id : undefined);

  // 1. Run Started Event
  items.push({
    id: `tl-start-${run.id}`,
    runId: run.id,
    timestamp: run.startedAt ?? run.createdAt,
    sequenceNumber: seq++,
    type: "run_started",
    agentId: run.mainAgentId,
    agentName: agentName(run.mainAgentId),
    summary: `Run started in ${run.executionMode ?? run.requestedMode} mode: "${run.task.slice(0, 100)}"`,
    detail: {
      requestedMode: run.requestedMode,
      executionMode: run.executionMode,
      contextType: run.contextSnapshot?.contextType,
      agentConfigRevision: run.agentConfigRevision,
      capabilitySetRevision: run.capabilitySetRevision,
    },
  });

  // 2. Step Delegation Events
  for (const step of steps) {
    items.push({
      id: `tl-step-${step.id}`,
      runId: run.id,
      timestamp: step.createdAt,
      sequenceNumber: seq++,
      type: "step_delegated",
      agentId: step.agentId,
      agentName: agentName(step.agentId),
      summary: `Delegated to ${agentName(step.agentId) ?? step.agentId} as ${step.role} (order: ${step.stepOrder}, lane: ${step.lane})`,
      detail: {
        stepOrder: step.stepOrder,
        lane: step.lane,
        role: step.role,
        status: step.status,
        modelId: step.modelId,
      },
    });
  }

  // 3. Tool Audit Events (without chain-of-thought leak)
  for (const audit of toolAudits) {
    let type: ActivityEventType = "tool_executed";
    if (audit.status === "blocked" || audit.decision === "denied") {
      type = "tool_blocked";
    } else if (audit.status === "failed") {
      type = "tool_failed";
    } else if (audit.status === "requested") {
      type = "tool_requested";
    }

    const sanitizedSummary = Object.keys(audit.inputSummary || {}).length > 0
      ? JSON.stringify(audit.inputSummary).slice(0, 200)
      : "No parameters";

    items.push({
      id: `tl-audit-${audit.id}`,
      runId: run.id,
      timestamp: audit.createdAt,
      sequenceNumber: audit.sequenceNumber ?? seq++,
      type,
      agentId: audit.agentId,
      agentName: agentName(audit.agentId),
      toolName: audit.toolName,
      decision: audit.decision,
      status: audit.status,
      summary: type === "tool_blocked"
        ? `Blocked ${audit.toolName}: ${audit.errorMessage ?? "Security or policy constraint"}`
        : `${audit.toolName} ${audit.status}: ${sanitizedSummary}`,
      latencyMs: audit.latencyMs,
      cost: audit.cost,
      tokens: audit.tokens,
      reasonCode: audit.reasonCode,
      detail: {
        errorMessage: audit.errorMessage,
        inputSummary: audit.inputSummary,
        completedAt: audit.completedAt,
      },
    });
  }

  // 4. Terminal Run Status Event
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    const termType: ActivityEventType =
      run.status === "completed" ? "run_completed" : run.status === "cancelled" ? "run_cancelled" : "run_failed";

    items.push({
      id: `tl-end-${run.id}`,
      runId: run.id,
      timestamp: run.completedAt ?? run.updatedAt,
      sequenceNumber: seq++,
      type: termType,
      agentId: run.mainAgentId,
      agentName: agentName(run.mainAgentId),
      summary: run.status === "completed"
        ? `Run completed successfully (${run.selectedAgentIds.length} agents delegated)`
        : `Run ${run.status}: ${run.errorCode ? `[${run.errorCode}] ` : ""}${run.errorMessage ?? "Operation terminated"}`,
      detail: {
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
        totalCost: run.totalCost,
        totalTokens: run.totalTokens,
        totalDurationMs: run.totalDurationMs,
      },
    });
  }

  // Deterministic stable sort: timestamp -> sequenceNumber -> id
  return items.sort((a, b) => {
    const timeCompare = a.timestamp.localeCompare(b.timestamp);
    if (timeCompare !== 0) return timeCompare;
    const seqCompare = a.sequenceNumber - b.sequenceNumber;
    if (seqCompare !== 0) return seqCompare;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Aggregates cost, tokens, duration across runs and tool audits by Company, User, and Agent.
 */
export function aggregateRunAccounting(
  runs: CompanyAgentRun[],
  toolAudits: CompanyAgentToolAudit[]
): RunAccounting {
  const byCompany: Record<string, CompanyAccounting> = {};
  const byUser: Record<string, UserAccounting> = {};
  const byAgent: Record<string, AgentAccounting> = {};

  let totalCost = 0;
  let totalTokens = 0;

  for (const run of runs) {
    const runCost = run.totalCost ?? 0;
    const runTokens = run.totalTokens ?? 0;
    const duration = run.totalDurationMs ?? (
      run.startedAt && run.completedAt
        ? Math.max(0, new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime())
        : 0
    );

    totalCost += runCost;
    totalTokens += runTokens;

    // Company aggregation
    if (!byCompany[run.companyId]) {
      byCompany[run.companyId] = { totalRuns: 0, totalCost: 0, totalTokens: 0, totalDurationMs: 0 };
    }
    const c = byCompany[run.companyId]!;
    c.totalRuns += 1;
    c.totalCost += runCost;
    c.totalTokens += runTokens;
    c.totalDurationMs += duration;

    // User aggregation
    if (!byUser[run.userId]) {
      byUser[run.userId] = { totalRuns: 0, totalCost: 0, totalTokens: 0 };
    }
    const u = byUser[run.userId]!;
    u.totalRuns += 1;
    u.totalCost += runCost;
    u.totalTokens += runTokens;
  }

  // Agent aggregation from tool audits
  for (const audit of toolAudits) {
    const auditCost = audit.cost ?? 0;
    const auditTokens = audit.tokens ?? 0;
    const duration = audit.latencyMs ?? 0;

    if (!byAgent[audit.agentId]) {
      byAgent[audit.agentId] = { totalCalls: 0, totalCost: 0, totalTokens: 0, totalDurationMs: 0 };
    }
    const a = byAgent[audit.agentId]!;
    a.totalCalls += 1;
    a.totalCost += auditCost;
    a.totalTokens += auditTokens;
    a.totalDurationMs += duration;
  }

  return {
    byCompany,
    byUser,
    byAgent,
    totalCost,
    totalTokens,
    totalRuns: runs.length,
  };
}

/**
 * Paginate items using stable cursor-based pagination.
 */
export function paginateTraceEvents<T extends { id: string }>(
  items: T[],
  options?: TracePaginationOptions
): TracePage<T> {
  const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
  let startIndex = 0;

  if (options?.cursor) {
    const found = items.findIndex((item) => item.id === options.cursor);
    if (found !== -1) {
      startIndex = found + 1;
    }
  }

  const pageItems = items.slice(startIndex, startIndex + limit);
  const nextItem = items[startIndex + limit];
  const nextCursor = nextItem ? pageItems[pageItems.length - 1]?.id : undefined;

  return {
    items: pageItems,
    limit,
    nextCursor,
    totalCount: items.length,
  };
}

/**
 * Evaluates whether an item exceeds the data retention period.
 */
export function isEligibleForRetention(
  createdAt: string,
  retentionDays: number,
  nowMs = Date.now()
): boolean {
  if (retentionDays <= 0) return false;
  const createdMs = new Date(createdAt).getTime();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  return nowMs - createdMs > maxAgeMs;
}
