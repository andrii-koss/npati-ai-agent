import type { AuthContext } from "@npati/workspace";
import type {
  CodeRunRuntimeCapabilitiesPort,
  CodeRunRuntimeCapabilityContext,
  CodeRunRuntimeDiscovery,
  CodeRunRuntimeToolDescriptor,
} from "./coding-agent-runner";
import type { CodeToolInvokeFailure, CodeToolInvokeResult, CodeToolErrorCode } from "./code-tool-runtime";
import {
  mcpRuntimeManifestSnapshot,
  type McpCapabilityTenant,
  type McpRuntimeCapabilityStore,
} from "./mcp-runtime-capabilities";
import { MCP_FLAG, MCP_RUNTIME_PROVIDER_ID, isRuntimeMcpTool, parseMcpRuntimeToolId } from "./mcp-runtime-identity";
import { mcpApprovalArgsHash } from "./mcp-approval";
import {
  discoverMcpRuntimeCapabilities,
  resolveConfiguredMcpEndpoint,
  type McpDiscoveryReport,
  type McpIntegrationSource,
  type McpRuntimeTransport,
} from "./mcp-runtime-transport";

/**
 * C13 (owner requirement: **fresh-process MCP acceptance**): the run-path entry point of runtime MCP
 * discovery.
 *
 * The defect this module closes, verbatim from the owner's acceptance list: discovery existed
 * (`discoverMcpRuntimeCapabilities`) but its **only** entry points were the Capability Inspector route, the
 * policy port and the snapshot/replay ports. No run ever discovered anything by itself, so on a fresh process
 * with a configured, active MCP Integration and **no** Inspector ever opened, the tenant's overlay stayed
 * empty, the MCP tools never reached the model's tool list, and the feature looked implemented while being
 * unreachable on the path that matters.
 *
 * Three properties shape this adapter:
 *
 *  1. **One discovery system.** `discover` below *is* the function the Inspector route calls — the route was
 *     re-pointed at this object rather than given a second implementation — so the two entry points cannot
 *     drift apart, and neither can become a dependency of the other. Nothing here reads the inspector, a route,
 *     a warm-up hook or a cache: the run path dials the configured Integrations itself.
 *  2. **Fail closed, never fail open, never fail the run.** The overlay of the run's tenant is either the set
 *     this pass really published or **empty**. "No integration", "`code.mcp` off", "the server could not be
 *     listed" and "the pass threw" are all an empty tool list plus a code — recorded as an Activity event
 *     (metadata only: counts, codes, the manifest hash; never an endpoint, a token or a schema body) and
 *     returned to the caller. None of them can stop a run, because a runtime provider is an *additional*
 *     capability surface.
 *  3. **The tenant is the key, at every step.** Discovery publishes under `(ctx.workspaceId, companyId)`,
 *     descriptors are read back for that same tenant, and a call is executed only for a tool that is published
 *     for that same tenant. There is no method here that takes a tenant from anywhere else.
 */

/** The engine port this adapter consults before dialling. Structurally the C5 `PolicyEngine.evaluate`. */
export interface McpRunPathPolicyPort {
  evaluate(request: {
    ctx: AuthContext;
    companyId: string;
    projectId?: string;
    sessionId?: string;
    tool: string;
    args?: Record<string, unknown>;
    toolCallId?: string;
    runId?: string;
    agentId?: string;
    readOnlyIntent?: boolean;
    /**
     * C13 (owner blocker 1): the runtime identity of this call, so the engine's approval phase binds the
     * approval to the tool's schema and to the hash of these exact arguments (see `PolicyRequest.runtimeMcp`).
     */
    runtimeMcp?: {
      providerId: string;
      connectionId: string;
      toolName: string;
      schemaHash: string;
      argsHash: string;
    };
    /** C13: the one-shot approval record this call presents. Absent means "ask for one". */
    approvalId?: string;
  }): Promise<{
    decision: "allow" | "require_approval" | "deny";
    code?: string;
    message?: string;
    status?: number;
    approvalId?: string;
    phase?: string;
  }>;
}

/** The Activity sink, wired exactly like every other family in `app.ts` (`activitySinkForKind`). */
export interface McpRunPathActivityPort {
  record(event: Record<string, unknown>): Promise<unknown>;
}

export interface McpRunPathDeps {
  store: McpRuntimeCapabilityStore;
  transport: McpRuntimeTransport;
  /**
   * The configured Integrations, late bound because the repository is composed after this adapter: `null`
   * means "this deployment has no Integration source", which is reported (`mcp_integration_source_unavailable`)
   * rather than dialled around.
   */
  source: () => McpIntegrationSource | null;
  /** The feature-flag service; `code.mcp` is read from it before anything is dialled. */
  flags?: {
    assertEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<unknown>;
  };
  /** The existing policy engine. Absent means no runtime tool call can be authorised (fail closed). */
  policy?: McpRunPathPolicyPort;
  activity?: McpRunPathActivityPort;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  now?: () => number;
}

export interface McpRuntimeRunPath extends CodeRunRuntimeCapabilitiesPort {
  /**
   * The single discovery pass, as the Capability Inspector's `includeRuntime=true` asks for it: the report, or
   * the structured "this deployment is not wired" answer. It is the same call the run path makes.
   */
  discover(
    ctx: AuthContext,
    companyId: string,
  ): Promise<McpDiscoveryReport | { error: { code: string; message: string } }>;
}

/** The Activity payload of one discovery, built only from counts, codes and hashes. */
interface McpDiscoveryActivity {
  action: "mcp_runtime_discovery";
  result: "published" | "empty" | "skipped" | "failed";
  flag: string;
  code?: string;
  toolCount: number;
  connectionCount: number;
  refusedConnections: number;
  unreachableConnections: number;
  manifestHash?: string;
  manifestRevision?: string;
}

function failure(
  tool: string,
  code: CodeToolErrorCode,
  status: number,
  message: string,
  step: string,
  details?: Record<string, unknown>,
): CodeToolInvokeFailure {
  return {
    ok: false,
    error: {
      code,
      status,
      message,
      tool,
      step,
      retryable: false,
      ...(details ? { details } : {}),
    },
  };
}

/**
 * Maps the engine's own verdict code onto the canonical tool-failure vocabulary.
 *
 * The point is that a refusal keeps its **meaning** for the model and the operator (`feature_disabled` for
 * `code.mcp` off, `unknown_tool` for a tool nobody published, `approval_required` for the fail-closed default)
 * while the engine's exact code, phase and reasons travel in `details`, so nothing is lost by the mapping and
 * no new failure semantics are invented for the run path.
 *
 * C13 (owner blocker 1): the durable approval store's own codes are preserved **verbatim**, exactly as the git
 * boundary preserves them (C11). `APPROVAL_ALREADY_USED` (the one-shot record was already spent) and
 * `APPROVAL_INVALID` (this record does not authorise this call: another tool, another schema, other arguments,
 * another run or agent, expired) must reach the model as what they are instead of as a generic policy denial.
 */
function engineFailureCode(code: string | undefined, decision: "allow" | "require_approval" | "deny"): CodeToolErrorCode {
  switch (code) {
    case "feature_disabled":
    case "unknown_tool":
    case "unknown_tool_version":
    case "tool_deprecated":
    case "approval_required":
    case "approval_unavailable":
    case "approval_denied":
    case "approval_invalid":
    case "review_code_read_only":
    case "policy_engine_unavailable":
      return code;
    case "APPROVAL_ALREADY_USED":
    case "APPROVAL_INVALID":
      return code;
    default:
      // Any other code the durable approval store emits is "this record does not authorise this call", which is
      // exactly what `approval_invalid` means; the store's own spelling stays in `details.engineCode`.
      if (code?.startsWith("APPROVAL_")) return "approval_invalid";
      return decision === "require_approval" ? "approval_required" : "policy_denied";
  }
}

export function createMcpRuntimeRunPath(deps: McpRunPathDeps): McpRuntimeRunPath {
  const now = deps.now ?? (() => Date.now());

  /** One Activity event per discovery. Never throws: bookkeeping must not change a run's outcome. */
  const record = async (
    input: { ctx: AuthContext; companyId: string; projectId?: string; sessionId?: string; runId?: string },
    payload: McpDiscoveryActivity,
  ): Promise<void> => {
    if (!deps.activity) return;
    try {
      await deps.activity.record({
        ...payload,
        companyId: input.companyId,
        workspaceId: input.ctx.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        // Discovery necessarily happens **before** the ExecutionSnapshot it describes exists, so there is no
        // snapshot id to reference yet. Recorded as absent rather than fabricated.
        snapshotId: null,
      });
    } catch (error) {
      deps.logger?.warn("mcp_runtime_discovery_activity_failed", {
        companyId: input.companyId,
        code: (error as { code?: string }).code ?? "activity_failed",
      });
    }
  };

  const empty = (code: string): CodeRunRuntimeDiscovery => ({
    discovered: false,
    code,
    tools: [],
    toolCount: 0,
    connectionCount: 0,
    manifestHash: null,
    manifestRevision: null,
  });

  /**
   * The discovered tools of one tenant as **model-visible descriptors**: the tenant's overlay (risk and
   * approval already applied by the store's read), plus the declared input schema of each tool, which is the
   * one thing the metadata-only overlay deliberately does not carry.
   *
   * Read back from the store rather than returned from the listing, so what the model is offered is exactly
   * what is published for this tenant at this moment — including an owner/admin risk decision that hydrates
   * during the pass, and including the empty case (a pass that published nothing offers nothing).
   */
  const discoveredTools = (tenant: McpCapabilityTenant): CodeRunRuntimeToolDescriptor[] =>
    deps.store.listFor(tenant).map((tool) => {
      const connectionId = String(tool.connectionId ?? "");
      const toolName = String(tool.toolName ?? "");
      return {
        name: String(tool.id),
        version: 1,
        status: "active",
        description: typeof tool.name === "string" && tool.name.length > 0 ? tool.name : String(tool.id),
        // An absent schema is an empty, unconstrained one — never a guessed contract.
        inputSchema: deps.store.inputSchemaFor(tenant, connectionId, toolName) ?? {},
        // A third-party off-box call is never read-only: "read-only" would be the server's claim, and a claim
        // is not a policy. This is what makes a read-only intent and `plan` mode drop the tool.
        write: true as const,
        risk: String(tool.risk),
        approvalRequired: tool.approvalRequired === true,
      };
    });

  const discover = async (
    ctx: AuthContext,
    companyId: string,
  ): Promise<McpDiscoveryReport | { error: { code: string; message: string } }> => {
    const source = deps.source();
    if (!source) {
      return {
        error: {
          code: "mcp_integration_source_unavailable",
          message: "The configured MCP integrations are not wired in this deployment",
        },
      };
    }
    const tenant: McpCapabilityTenant = { workspaceId: ctx.workspaceId, companyId };
    return discoverMcpRuntimeCapabilities({
      store: deps.store,
      source,
      transport: deps.transport,
      ctx,
      tenant,
    });
  };

  return {
    discover,

    /**
     * Discovery for one run, **before the first model call** and before the snapshot that pins the manifest.
     *
     * Never throws, never fails open: every refusal path leaves the tenant's overlay **empty** (so an MCP tool
     * is neither offered nor executable) and reports a code that is recorded as Activity and logged.
     */
    async prepareForRun(input) {
      const tenant: McpCapabilityTenant = { workspaceId: input.ctx.workspaceId, companyId: input.companyId };
      const activityInput = {
        ctx: input.ctx,
        companyId: input.companyId,
        projectId: input.projectId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
      };
      // (1) `code.mcp` is the sub-flag of the whole runtime MCP surface. Off means no dial at all and an empty
      // overlay: a tool discovered under a flag that was disabled would be a capability the operator removed.
      if (deps.flags) {
        try {
          await deps.flags.assertEnabled(input.ctx, MCP_FLAG, { companyId: input.companyId, userId: input.ctx.userId });
        } catch {
          deps.store.clear(tenant);
          await record(activityInput, {
            action: "mcp_runtime_discovery", result: "skipped", flag: MCP_FLAG, code: "feature_disabled",
            toolCount: 0, connectionCount: 0, refusedConnections: 0, unreachableConnections: 0,
          });
          return empty("feature_disabled");
        }
      }
      // (2) No Integration source: the honest answer, and an empty overlay rather than a stale one.
      const source = deps.source();
      if (!source) {
        deps.store.clear(tenant);
        await record(activityInput, {
          action: "mcp_runtime_discovery", result: "skipped", flag: MCP_FLAG,
          code: "mcp_integration_source_unavailable",
          toolCount: 0, connectionCount: 0, refusedConnections: 0, unreachableConnections: 0,
        });
        return empty("mcp_integration_source_unavailable");
      }
      // (3) The one discovery pass. A throw here is reported, recorded, and removes runtime tools only.
      let report: McpDiscoveryReport;
      try {
        report = await discoverMcpRuntimeCapabilities({
          store: deps.store,
          source,
          transport: deps.transport,
          ctx: input.ctx,
          tenant,
        });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "mcp_discovery_failed";
        // The failed pass may have cleared (or half-filled) the tenant's listing: make the outcome unambiguous.
        deps.store.clear(tenant);
        await record(activityInput, {
          action: "mcp_runtime_discovery", result: "failed", flag: MCP_FLAG, code,
          toolCount: 0, connectionCount: 0, refusedConnections: 0, unreachableConnections: 0,
        });
        deps.logger?.warn("mcp_runtime_discovery_failed", { companyId: input.companyId, code });
        return empty(code);
      }
      const tools = discoveredTools(tenant);
      const refusedConnections = report.connections.filter((connection) => connection.state === "refused").length;
      const unreachableConnections = report.connections.filter((connection) => connection.state === "unreachable").length;
      await record(activityInput, {
        action: "mcp_runtime_discovery",
        result: tools.length > 0 ? "published" : "empty",
        flag: MCP_FLAG,
        toolCount: tools.length,
        connectionCount: report.connections.length,
        refusedConnections,
        unreachableConnections,
        manifestHash: report.manifestHash,
        manifestRevision: report.manifestRevision,
      });
      return {
        discovered: true,
        tools,
        toolCount: tools.length,
        connectionCount: report.connections.length,
        manifestHash: report.manifestHash,
        manifestRevision: report.manifestRevision,
      };
    },

    /**
     * Executes one discovered tool through the **existing** transport.
     *
     * The order is the security contract, and every step can only refuse:
     *
     *   1. the id must be a runtime provider id, and the tool must be **published for this tenant right now**
     *      (`static → runtime → unknown ⇒ deny`: an id nobody published is `unknown_tool`, never a new class of
     *      "runtime unknown");
     *   2. the **engine** decides the call — `code.mcp`, the session mode, the permission, the capability lookup
     *      and the fail-closed `high` + approval-required default all live there, and this adapter authorises
     *      nothing by itself. A missing engine port is a refusal, never a bypass;
     *   3. the endpoint is **re-resolved from the configured Integrations** for this call (a listing can never
     *      move the next dial), through the same SSRF-safe client as every other outbound call;
     *   4. the response passes the existing guard (secret → refused, not redacted → bounded → injection
     *      classification → canonical `untrusted_data` envelope) inside the transport, and only then becomes
     *      the tool result.
     */
    async invoke(input) {
      const started = now();
      const tool = input.tool;
      if (!isRuntimeMcpTool(tool)) {
        return failure(tool, "unknown_tool", 404, `Unknown tool: ${tool}`, "resolve");
      }
      const parsed = parseMcpRuntimeToolId(tool);
      if (!parsed) return failure(tool, "unknown_tool", 404, `Unknown tool: ${tool}`, "resolve");
      const tenant: McpCapabilityTenant = { workspaceId: input.ctx.workspaceId, companyId: input.companyId };
      const published = deps.store.publishedRecord(tenant, parsed.connectionId, parsed.toolName);
      if (!published) {
        // The same answer a typo gets, and the same answer a tool of another Company gets: no existence oracle.
        return failure(tool, "unknown_tool", 404, `Unknown tool: ${tool}`, "resolve");
      }
      if (!deps.policy) {
        return failure(tool, "policy_engine_unavailable", 503, "The policy engine is not configured, so the call is refused", "policy");
      }
      /**
       * C13 (owner blocker 1): what this call is approved **for**.
       *
       * `schemaHash` comes from the published record — the schema the server really declared, as the manifest
       * pinned it — and `argsHash` from the model's own arguments. Both travel into the policy request, so the
       * engine's approval payload (and therefore the durable approval row) is bound to this exact call, and the
       * same two values are recomputed here when the record is redeemed. Nothing about them comes from the
       * model, the server's metadata or a caller-supplied claim.
       */
      const runtimeMcp = {
        providerId: MCP_RUNTIME_PROVIDER_ID,
        connectionId: parsed.connectionId,
        toolName: parsed.toolName,
        schemaHash: String(published.schemaHash),
        argsHash: mcpApprovalArgsHash(input.args),
      };
      let decision: Awaited<ReturnType<McpRunPathPolicyPort["evaluate"]>>;
      try {
        decision = await deps.policy.evaluate({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
          tool,
          args: input.args,
          toolCallId: input.toolCallId,
          runtimeMcp,
          // The record the resumed run presents for this exact call; absent means "ask a human for one".
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        });
      } catch (error) {
        // A policy engine that cannot answer is not an allow.
        return failure(
          tool,
          "policy_engine_unavailable",
          503,
          error instanceof Error ? error.message : "The policy engine could not answer",
          "policy",
          { engineCode: (error as { code?: string }).code ?? null },
        );
      }
      if (decision.decision !== "allow") {
        /**
         * C13 (owner blocker 1): `approval_required` is not an ordinary refusal for a runtime MCP tool — it is
         * the **pause** signal. The engine has just created exactly one durable approval record for this call
         * (there is no second request anywhere on this path), and the facts the runner needs to pause and the
         * resumed run needs to redeem it travel in `details`: the record id, the tool's schema hash and the
         * argument hash. `pauseForApproval` is what tells the runner "stop this run and ask a human", exactly
         * like a `code.ask_user` result stops it.
         *
         * If the engine could not create a record (no approval gateway, or a rejected/expired record), the
         * decision is not `require_approval` and this branch is the ordinary refusal — so a deployment without
         * an approval system never gets a pause it could not resolve, and nothing is executed either way.
         */
        const requiresApproval = decision.decision === "require_approval";
        return failure(
          tool,
          engineFailureCode(decision.code, decision.decision),
          decision.status ?? 403,
          decision.message ?? `The runtime MCP tool ${tool} is refused by policy (${decision.code ?? "policy_denied"})`,
          "policy",
          {
            // The engine's own verdict, unaltered, so nothing about the refusal is lost in the mapping.
            engineCode: decision.code ?? null,
            enginePhase: decision.phase ?? null,
            engineDecision: decision.decision,
            ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
            reason: requiresApproval ? "approval_required" : "policy_denied",
            // The binding of the call the human is being asked about, so a pause is auditable and a resumed run
            // can prove it is redeeming the same call.
            schemaHash: runtimeMcp.schemaHash,
            argsHash: runtimeMcp.argsHash,
            connectionId: runtimeMcp.connectionId,
            toolName: runtimeMcp.toolName,
            ...(requiresApproval && decision.approvalId ? { pauseForApproval: true } : {}),
          },
        );
      }
      const source = deps.source();
      if (!source) {
        return failure(tool, "tool_not_configured", 503, "The configured MCP integrations are not wired in this deployment", "configure");
      }
      let integration;
      try {
        const configured = await source.listConfigured(input.ctx, input.companyId);
        // Endpoint by configuration only: the id is the only thing the caller contributed, and a value the
        // caller *thinks* is the endpoint is refused by name inside `resolveConfiguredMcpEndpoint`.
        integration = resolveConfiguredMcpEndpoint(configured, parsed.connectionId);
      } catch (error) {
        return failure(
          tool,
          "tool_not_configured",
          409,
          error instanceof Error ? error.message : `The configured MCP connection ${parsed.connectionId} is not available`,
          "configure",
          { upstreamCode: (error as { code?: string }).code ?? null },
        );
      }
      try {
        const answer = await deps.transport.callTool({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          integration,
          toolName: parsed.toolName,
          ...(input.signal ? { signal: input.signal } : {}),
          toolArguments: input.args,
        });
        const result: CodeToolInvokeResult = {
          ok: true,
          tool,
          toolVersion: 1,
          schemaVersion: 1,
          // The canonical envelope the transport's guard produced: `untrusted_data`, bounded, injection
          // classified, and with a closed key vocabulary that has no policy field to reach.
          result: answer.guarded.envelope,
          truncated: answer.guarded.truncated,
          durationMs: Math.max(0, now() - started),
        };
        return result;
      } catch (error) {
        const shaped = error as { code?: string; httpStatus?: number; message?: string; details?: Record<string, unknown> };
        const upstream = shaped.code ?? "mcp_tool_failed";
        // The MCP codes are the transport's own vocabulary (`mcp_response_secret_detected`,
        // `mcp_server_unreachable`, …). They are preserved verbatim in `details.upstreamCode` and mapped onto
        // the canonical tool-failure vocabulary so the model and the Activity event see a code they already
        // understand, without inventing a second set of failure semantics for MCP.
        const code: CodeToolErrorCode = upstream === "mcp_response_secret_detected"
          ? "secret_in_diff"
          : upstream === "mcp_server_unreachable" || upstream === "mcp_server_error"
            ? "tool_failed"
            : upstream === "mcp_endpoint_not_from_integration" || upstream === "mcp_transport_unsupported"
              ? "policy_denied"
              : "tool_failed";
        return failure(
          tool,
          code,
          shaped.httpStatus ?? 502,
          shaped.message ?? `The MCP tool ${tool} failed`,
          "execute",
          { upstreamCode: upstream, ...(shaped.details ? { upstream: shaped.details } : {}) },
        );
      }
    },
  };
}

/**
 * The runtime MCP manifest of one tenant, in the metadata-only shape the ExecutionSnapshot and the replay
 * bundle pin (`mcpRuntimeManifestSnapshot`).
 *
 * Deliberately **synchronous**: the manifest is derived from the in-memory published listing, so every reader
 * that needs it in a synchronous position (the replay recorder's context, which is built while the run starts)
 * gets the same value as an asynchronous one — one definition, no second copy and no `await` that would force
 * a port signature to change.
 */
export function readMcpRuntimeManifest(
  store: McpRuntimeCapabilityStore,
  tenant: { workspaceId: string; companyId: string },
): Record<string, unknown> | null {
  const manifest = store.manifestFor(tenant);
  // The honest absence: a tenant with no runtime tools records `null` rather than an empty manifest.
  return manifest.toolCount === 0 ? null : mcpRuntimeManifestSnapshot(manifest);
}
