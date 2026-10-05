import { CAPABILITY_CATALOG } from "./capability-catalog";
import { CAPABILITY_MATRIX, type CapabilityMatrixEntry } from "./capability-matrix";
import { CODE_TOOL_FLAG_KEYS } from "./code-capabilities";
import { EffectiveCapabilityResolver, type ResolutionContext } from "./effective-capabilities";
import type { CapabilityDefinition } from "./capabilities";

export type InspectorSlice =
  | "all"
  | "agent-callable"
  | "runtime-only"
  | "user-visible"
  | "automatic"
  | "allowed"
  | "denied"
  | "unavailable"
  | "requires-approval"
  | "destructive"
  | "missing-dependency"
  | "missing-test"
  | "missing-ui";

export interface CapabilityInspectorCounts {
  all: number;
  agentCallable: number;
  runtimeOnly: number;
  userVisible: number;
  automatic: number;
  allowed: number;
  denied: number;
  unavailable: number;
  requiresApproval: number;
  destructive: number;
  missingDependency: number;
  missingTest: number;
  missingUi: number;
}

export interface InspectorReport {
  timestamp: string;
  counts: CapabilityInspectorCounts;
  activeSlice: InspectorSlice;
  items: Array<{
    id: number;
    capabilityId: string;
    name: string;
    domain: string;
    type: string;
    agentCallable: boolean;
    status: string;
    risk: string;
    reasonCode?: string;
    /** C2: feature flag that gates this capability (null for capabilities without a gate). */
    flagKey?: string | null;
    /** C2: flag state at inspection time; "unknown" when no flag source is available. */
    flagState?: "on" | "off" | "unknown" | null;
  }>;
}

/**
 * C2/C3: Coding Agent capabilities are gated by a sub-flag (C1a): the read/search tools by `code.read`,
 * the mutating tools by `code.write`. The inspector only reports the state; it never turns a flag on and
 * it degrades to "unknown" when the server has no flag source, so a missing flag service can never look
 * like an enabled feature.
 */
export const CODE_CAPABILITY_DOMAIN = "code";
export const CODE_READ_FLAG = "code.read";
export const CODE_WRITE_FLAG = "code.write";

export function flagKeyForCapability(domain: string): string | null {
  return domain === CODE_CAPABILITY_DOMAIN ? CODE_READ_FLAG : null;
}

/**
 * The flag that governs one concrete capability: `code.read` for the read/search tools, `code.write` for
 * the mutating ones. Unknown capabilities fall back to the domain default, so an unmapped tool is
 * reported as read-gated rather than ungated.
 */
export function flagKeyForCapabilityId(capabilityId: string, domain?: string): string | null {
  const direct = CODE_TOOL_FLAG_KEYS[capabilityId];
  if (direct) return direct;
  return domain === undefined ? null : flagKeyForCapability(domain);
}

export interface InspectOptions {
  /** Flag states resolved server-side, keyed by flag key. */
  flagStates?: Record<string, boolean>;
  /** True when a flag source was available at all. */
  flagSourceAvailable?: boolean;
}

export interface RunInspectorInput {
  run: {
    id: string;
    workspaceId: string;
    companyId?: string;
    businessId?: string;
    mainAgentId?: string;
    selectedAgentIds: string[];
    task: string;
    status: string;
    executionMode?: string;
    requestedMode: string;
    startedAt?: string;
    completedAt?: string;
    failedAt?: string;
    costUsd?: number;
    tokenCount?: number;
    retryCount?: number;
    contextSnapshot?: {
      contextType: string;
      businessId?: string;
      companyId?: string;
    };
  };
  steps?: Array<{
    id: string;
    stepOrder: number;
    agentId: string;
    status: string;
    toolCalls?: Array<{ toolName: string; status: string; outputPreview?: string; error?: string }>;
  }>;
  detectedIntent?: string;
  selectedSkills?: string[];
  candidateCapabilities?: string[];
  capabilitiesRemovedByPolicy?: Array<{ capabilityId: string; reasonCode: string }>;
  toolsExposedToModel?: string[];
  auditEvents?: Array<{ id: string; toolName: string; status: string; payloadHash?: string }>;
}

export interface RunInspectorReport {
  runId: string;
  activeContext: {
    contextType: string;
    workspaceId: string;
    companyId?: string;
    businessId?: string;
  };
  selectedCompanyId?: string;
  selectedBusinessId?: string;
  selectedAgent?: { id: string };
  detectedIntent?: string;
  selectedSkills: string[];
  candidateCapabilities: string[];
  capabilitiesRemovedByPolicy: Array<{ capabilityId: string; reasonCode: string }>;
  toolsExposedToModel: string[];
  toolsActuallyCalled: Array<{ toolName: string; status: string }>;
  agentDelegations: Array<{ stepOrder: number; agentId: string; status: string }>;
  toolResults: Array<{ toolName: string; status: string; outputPreview?: string; error?: string }>;
  tokenCostRuntime: {
    tokenCount: number;
    costUsd: number;
    durationMs: number;
    retries: number;
  };
  auditEvents: Array<{ id: string; toolName: string; status: string; payloadHash?: string }>;
  status: string;
}

export class CapabilityInspectorService {
  private readonly resolver: EffectiveCapabilityResolver;

  constructor(resolver = new EffectiveCapabilityResolver()) {
    this.resolver = resolver;
  }

  inspect(slice: InspectorSlice = "all", resolutionContext?: ResolutionContext, options: InspectOptions = {}): InspectorReport {
    const matrix = CAPABILITY_MATRIX;

    let evaluatedDetails: Record<string, { status: string; reasonCode?: string }> = {};
    if (resolutionContext) {
      const res = this.resolver.resolve(resolutionContext);
      evaluatedDetails = res.details;
    }

    const flagStateFor = (capabilityId: string, domain: string): { flagKey: string | null; flagState: "on" | "off" | "unknown" | null } => {
      const flagKey = flagKeyForCapabilityId(capabilityId, domain);
      if (!flagKey) return { flagKey: null, flagState: null };
      const value = options.flagStates?.[flagKey];
      if (value === true) return { flagKey, flagState: "on" };
      if (value === false) return { flagKey, flagState: "off" };
      return { flagKey, flagState: "unknown" };
    };

    const allItems = matrix.map((m) => {
      const detail = evaluatedDetails[m.capabilityId];
      return {
        id: m.id,
        capabilityId: m.capabilityId,
        name: m.name,
        domain: m.domain,
        type: m.type,
        agentCallable: m.agentCallable,
        status: m.status,
        risk: m.risk,
        reasonCode: detail?.reasonCode,
        ...flagStateFor(m.capabilityId, m.domain),
      };
    });

    const counts: CapabilityInspectorCounts = {
      all: allItems.length,
      agentCallable: allItems.filter((i) => i.agentCallable).length,
      runtimeOnly: allItems.filter((i) => !i.agentCallable).length,
      userVisible: allItems.filter((i) => i.agentCallable).length,
      automatic: allItems.filter((i) => i.domain === "orchestration" || i.domain === "system" || i.type === "runtime").length,
      allowed: allItems.filter((i) => !evaluatedDetails[i.capabilityId] || evaluatedDetails[i.capabilityId]?.status === "allowed").length,
      denied: allItems.filter((i) => evaluatedDetails[i.capabilityId]?.status === "denied").length,
      unavailable: allItems.filter((i) => evaluatedDetails[i.capabilityId]?.status === "unavailable").length,
      requiresApproval: allItems.filter((i) => i.risk === "high" || i.risk === "critical").length,
      destructive: allItems.filter((i) => i.risk === "critical" || /delete|drop|wipe|purge|remove/i.test(i.capabilityId)).length,
      missingDependency: allItems.filter((i) => evaluatedDetails[i.capabilityId]?.reasonCode === "missing_connection").length,
      missingTest: matrix.filter((m) => !m.testFiles || m.testFiles.length === 0).length,
      missingUi: allItems.filter((i) => !i.agentCallable).length,
    };

    let filteredItems = allItems;
    switch (slice) {
      case "agent-callable":
        filteredItems = allItems.filter((i) => i.agentCallable);
        break;
      case "runtime-only":
        filteredItems = allItems.filter((i) => !i.agentCallable);
        break;
      case "user-visible":
        filteredItems = allItems.filter((i) => i.agentCallable);
        break;
      case "automatic":
        filteredItems = allItems.filter((i) => i.domain === "orchestration" || i.domain === "system" || i.type === "runtime");
        break;
      case "allowed":
        filteredItems = allItems.filter((i) => !evaluatedDetails[i.capabilityId] || evaluatedDetails[i.capabilityId]?.status === "allowed");
        break;
      case "denied":
        filteredItems = allItems.filter((i) => evaluatedDetails[i.capabilityId]?.status === "denied");
        break;
      case "unavailable":
        filteredItems = allItems.filter((i) => evaluatedDetails[i.capabilityId]?.status === "unavailable");
        break;
      case "requires-approval":
        filteredItems = allItems.filter((i) => i.risk === "high" || i.risk === "critical");
        break;
      case "destructive":
        filteredItems = allItems.filter((i) => i.risk === "critical" || /delete|drop|wipe|purge|remove/i.test(i.capabilityId));
        break;
      case "missing-dependency":
        filteredItems = allItems.filter((i) => evaluatedDetails[i.capabilityId]?.reasonCode === "missing_connection");
        break;
      case "missing-test":
        filteredItems = allItems.filter((i) => {
          const m = matrix.find((entry) => entry.id === i.id);
          return !m?.testFiles || m.testFiles.length === 0;
        });
        break;
      case "missing-ui":
        filteredItems = allItems.filter((i) => !i.agentCallable);
        break;
      case "all":
      default:
        filteredItems = allItems;
        break;
    }

    return {
      timestamp: new Date().toISOString(),
      counts,
      activeSlice: slice,
      items: filteredItems,
    };
  }

  inspectRun(input: RunInspectorInput): RunInspectorReport {
    const {
      run,
      steps = [],
      detectedIntent,
      selectedSkills = [],
      candidateCapabilities = [],
      capabilitiesRemovedByPolicy = [],
      toolsExposedToModel = [],
      auditEvents = [],
    } = input;

    const start = run.startedAt ? new Date(run.startedAt).getTime() : 0;
    const end = (run.completedAt || run.failedAt) ? new Date((run.completedAt || run.failedAt)!).getTime() : start;
    const durationMs = Math.max(0, end - start);

    const toolsActuallyCalled: Array<{ toolName: string; status: string }> = [];
    const toolResults: Array<{ toolName: string; status: string; outputPreview?: string; error?: string }> = [];
    const agentDelegations: Array<{ stepOrder: number; agentId: string; status: string }> = [];

    for (const s of steps) {
      agentDelegations.push({
        stepOrder: s.stepOrder,
        agentId: s.agentId,
        status: s.status,
      });
      if (s.toolCalls) {
        for (const tc of s.toolCalls) {
          toolsActuallyCalled.push({ toolName: tc.toolName, status: tc.status });
          toolResults.push({
            toolName: tc.toolName,
            status: tc.status,
            outputPreview: tc.outputPreview,
            error: tc.error,
          });
        }
      }
    }

    return {
      runId: run.id,
      activeContext: {
        contextType: run.contextSnapshot?.contextType ?? (run.companyId ? "company" : run.businessId ? "business" : "none"),
        workspaceId: run.workspaceId,
        companyId: run.companyId,
        businessId: run.businessId,
      },
      selectedCompanyId: run.companyId,
      selectedBusinessId: run.businessId,
      selectedAgent: run.mainAgentId ? { id: run.mainAgentId } : undefined,
      detectedIntent,
      selectedSkills,
      candidateCapabilities,
      capabilitiesRemovedByPolicy,
      toolsExposedToModel,
      toolsActuallyCalled,
      agentDelegations,
      toolResults,
      tokenCostRuntime: {
        tokenCount: run.tokenCount ?? 0,
        costUsd: run.costUsd ?? 0,
        durationMs,
        retries: run.retryCount ?? 0,
      },
      auditEvents,
      status: run.status,
    };
  }
}
