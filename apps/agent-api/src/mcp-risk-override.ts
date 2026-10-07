import type { AuthContext } from "@npati/workspace";
import type { CapabilityRisk } from "@npati/shared";
import { hasAdminPermission } from "./code-rbac";
import { isAgentPrincipal } from "./code-policy-engine";
import {
  McpRuntimeCapabilityStore,
  type McpCapabilityTenant,
  type McpRuntimeToolRecord,
} from "./mcp-runtime-capabilities";
import { MCP_POLICY_RISKS, type McpToolPolicyRecord, type McpToolPolicyRepository } from "./mcp-tool-policy-repository";

/**
 * C13 (owner decision 5): the **only** path that may lower the risk of a runtime MCP tool.
 *
 * The owner's words: "Знизити risk може лише existing owner/admin policy flow з AuditLog." Three properties
 * make that a property of the code rather than a promise:
 *
 *  1. **Authorization runs first** and an agent/service principal is refused outright: an MCP server cannot
 *     reach this function at all (it has no `AuthContext`), and the agent that *calls* MCP tools cannot
 *     promote itself either. The permission vocabulary is the existing one (`hasAdminPermission`), not a new
 *     `mcp:admin`-style grant.
 *  2. **The journal is written first and its failure is fatal.** No audit port, or a port that throws, means
 *     the decision is not applied — `mcp_risk_override_refused` with `audit_unavailable`. That is the
 *     fail-closed half of the owner's sentence: an unprovable privileged decision does not happen.
 *  3. **The durable row is the source of truth.** The in-memory overlay is updated from the row that was
 *     just written, so a restart re-hydrates exactly the decisions that were journalled.
 *
 * A discovery never calls this. `buildMcpRuntimeToolRecord` assigns `high` + approval unconditionally, so
 * "an MCP server set its own risk to low" is not a check that can be forgotten at a call site — there is no
 * code path in which a server-supplied value reaches `risk`.
 */

/** The subset of `AuditLogService` this flow needs. Structural, so no service import is required. */
export interface McpPolicyAuditPort {
  record(input: {
    companyId: string;
    actor: string;
    actorRole: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    projectId?: string;
    decision: "allowed" | "denied";
    payload?: unknown;
    metadata?: Record<string, unknown>;
    requestId?: string;
    correlationId?: string;
    snapshotId?: string;
  }): Promise<unknown>;
}

export const MCP_RISK_OVERRIDE_ACTION = "mcp_runtime_tool_risk_override";
export const MCP_RISK_OVERRIDE_RESOURCE = "mcp_runtime_tool";

export type McpRiskOverrideRefusalReason =
  | "audit_unavailable"
  | "policy_store_unavailable"
  | "tool_not_published_in_runtime_manifest"
  | "invalid_risk";

export class McpRiskOverrideForbiddenError extends Error {
  readonly code = "mcp_risk_override_forbidden";
  readonly httpStatus = 403;
  readonly details: { reason: string };
  constructor(reason: string) {
    super(`Runtime MCP risk may only be changed by an owner or admin policy decision (${reason})`);
    this.name = "McpRiskOverrideForbiddenError";
    this.details = { reason };
  }
}

/**
 * Raised when the decision cannot be made provable or durable. Nothing is applied: the tool keeps the
 * fail-closed `high` + approval default.
 */
export class McpRiskOverrideRefusedError extends Error {
  readonly code = "mcp_risk_override_refused";
  readonly httpStatus = 503;
  readonly details: { reason: McpRiskOverrideRefusalReason };
  constructor(reason: McpRiskOverrideRefusalReason, message?: string) {
    super(message ?? `Runtime MCP risk override refused: ${reason}`);
    this.name = "McpRiskOverrideRefusedError";
    this.details = { reason };
  }
}

export interface McpRiskOverrideDeps {
  store: McpRuntimeCapabilityStore;
  policies: McpToolPolicyRepository;
  /** Absent means "this deployment cannot journal a privileged decision", which refuses the override. */
  audit?: McpPolicyAuditPort | undefined;
  now?: () => Date;
}

export interface McpRiskOverrideRequest {
  ctx: AuthContext;
  tenant: McpCapabilityTenant;
  /** The runtime tool id (`mcp:<connectionId>/<toolName>`), as the Inspector and the policy lookup report it. */
  toolId: string;
  risk: CapabilityRisk;
  approvalRequired?: boolean;
  requestId?: string;
  correlationId?: string;
  snapshotId?: string;
}

export interface McpRiskOverrideResult {
  toolId: string;
  connectionId: string;
  toolName: string;
  previousRisk: CapabilityRisk;
  risk: CapabilityRisk;
  approvalRequired: boolean;
  riskSource: "owner_policy";
  actor: string;
  at: string;
  /** The manifest hash after the override: a risk change is a new runtime revision, by construction. */
  manifestHash: string;
  journaled: true;
}

function actorRoleFor(ctx: AuthContext): string {
  return ctx.permissions?.includes("owner") || ctx.permissions?.includes("*") ? "owner" : "admin";
}

/**
 * Applies an owner/admin risk decision for one runtime MCP tool, journal-first.
 *
 * Order, and why: authorize → require the tool to exist **in the runtime manifest of this tenant** (so a
 * foreign Company's connection id cannot be touched and a typo is not silently persisted) → journal → persist
 * the row → apply to the overlay. Every early return leaves the published tool exactly as the discovery
 * published it.
 */
export async function applyMcpRiskOverride(deps: McpRiskOverrideDeps, request: McpRiskOverrideRequest): Promise<McpRiskOverrideResult> {
  // 1. Authorization: an agent/service principal can never be the approver of its own blast radius.
  if (isAgentPrincipal(request.ctx)) {
    throw new McpRiskOverrideForbiddenError("agent_principal");
  }
  if (!hasAdminPermission(request.ctx.permissions)) {
    throw new McpRiskOverrideForbiddenError("not_owner_or_admin");
  }
  if (!MCP_POLICY_RISKS.includes(request.risk)) {
    throw new McpRiskOverrideRefusedError("invalid_risk", `Unknown risk class: ${String(request.risk)}`);
  }

  // 2. The tool must be part of this tenant's runtime manifest. Tenant scoping is the store's own key, so a
  //    connection id belonging to another Company resolves to "not published" rather than to its record.
  const published = (deps.store.listFor(request.tenant) as McpRuntimeToolRecord[]).find((tool) => tool.id === request.toolId);
  if (!published) {
    throw new McpRiskOverrideRefusedError("tool_not_published_in_runtime_manifest", `No runtime MCP tool ${request.toolId} is published for this tenant`);
  }

  const now = deps.now?.() ?? new Date();
  const actor = request.ctx.userId ?? request.ctx.externalSubject ?? "unknown";
  const approvalRequired = request.approvalRequired ?? published.approvalRequired;

  // 3. Journal before apply. Fail closed: no port, or a failing write, means no decision.
  if (!deps.audit) throw new McpRiskOverrideRefusedError("audit_unavailable");
  try {
    await deps.audit.record({
      companyId: request.tenant.companyId,
      actor,
      actorRole: actorRoleFor(request.ctx),
      action: MCP_RISK_OVERRIDE_ACTION,
      resourceType: MCP_RISK_OVERRIDE_RESOURCE,
      resourceId: request.toolId,
      decision: "allowed",
      // The payload is stored as a canonical hash by AuditLogService; the values here are the facts that make
      // the decision reviewable (which tool, which risk, from what).
      payload: {
        toolId: request.toolId,
        connectionId: published.connectionId,
        toolName: published.toolName,
        previousRisk: published.risk,
        risk: request.risk,
        approvalRequired,
        schemaHash: published.schemaHash,
      },
      // Metadata only: connection identity, the schema hash and the provenance of the decision. No schema
      // body, no tool argument, no endpoint.
      metadata: {
        connectionId: published.connectionId,
        toolName: published.toolName,
        schemaHash: published.schemaHash,
        previousRiskSource: published.riskSource,
        riskSource: "owner_policy",
      },
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.correlationId ? { correlationId: request.correlationId } : {}),
      ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
    });
  } catch (error) {
    throw new McpRiskOverrideRefusedError(
      "audit_unavailable",
      error instanceof Error ? `The audit journal refused the decision: ${error.message}` : "The audit journal refused the decision",
    );
  }

  // 4. The durable row. A store that cannot write is also a refusal: an unprovable-in-practice decision that a
  //    restart would forget is exactly the state this flow exists to prevent.
  const record: McpToolPolicyRecord = {
    connectionId: published.connectionId,
    toolName: published.toolName,
    risk: request.risk,
    approvalRequired,
    riskSource: "owner_policy",
    actor,
    updatedAt: now.toISOString(),
  };
  let stored: McpToolPolicyRecord;
  try {
    stored = await deps.policies.upsertPolicy(request.ctx, request.tenant.companyId, record);
  } catch {
    throw new McpRiskOverrideRefusedError("policy_store_unavailable");
  }

  // 5. Apply. The runtime manifest hash changes here, which is what mints a new runtime revision.
  deps.store.applyOverride(request.tenant, stored);
  return {
    toolId: published.id,
    connectionId: published.connectionId,
    toolName: published.toolName,
    previousRisk: published.risk,
    risk: stored.risk,
    approvalRequired: stored.approvalRequired,
    riskSource: "owner_policy",
    actor,
    at: stored.updatedAt,
    manifestHash: deps.store.manifestFor(request.tenant).hash,
    journaled: true,
  };
}
