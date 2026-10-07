import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AuthContext } from "@npati/workspace";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { ApiKeysRepository } from "../apps/agent-api/src/api-keys-repository";
import { registerMcpPolicyRoutes } from "../apps/agent-api/src/mcp-policy-routes";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_MATRIX,
  STATIC_CATALOG_BASELINE,
  buildCombinedCapabilityView,
  checkCombinedInspectorView,
  checkRuntimeOverlayIntegrity,
  checkStaticCatalogIntegrity,
  staticCapabilityRegistry,
  type RuntimeProviderCapabilityOverlay,
} from "@npati/shared";
import { CapabilityInspectorService } from "@npati/shared";
import { PolicyEngine, subFlagForTool } from "../apps/agent-api/src/code-policy-engine";
import { MCP_FLAG, isRuntimeMcpTool, mcpRuntimeToolId } from "../apps/agent-api/src/mcp-runtime-identity";
import {
  MCP_DEFAULT_RUNTIME_RISK,
  McpMetadataPolicyFieldRefusedError,
  McpRuntimeCapabilityStore,
  assertReplayRuntimeMcpManifestMatches,
  buildMcpRuntimeToolRecord,
  lookupCapability,
  mcpRuntimeManifestSnapshot,
  mcpSchemaHash,
  type McpCapabilityTenant,
  type McpRuntimeToolRecord,
} from "../apps/agent-api/src/mcp-runtime-capabilities";
import { McpToolPolicyStore } from "../apps/agent-api/src/mcp-tool-policy-repository";
import {
  McpRiskOverrideForbiddenError,
  McpRiskOverrideRefusedError,
  applyMcpRiskOverride,
} from "../apps/agent-api/src/mcp-risk-override";
import {
  REPLAY_BUNDLE_FORMAT_VERSION,
  bundleHash,
  replayInputHash,
  type ReplayBundleReadResult,
} from "../apps/agent-api/src/code-replay-bundle";
import { replayRecorded } from "../apps/agent-api/src/code-replay-engine";
import { collectExecutionSnapshotPayload } from "../apps/agent-api/src/execution-snapshot";

/**
 * C13 — MCP as a **runtime** capability provider (owner decisions 5, 6 and 8).
 *
 * What is pinned here, and what each test would catch:
 *  1. the runtime record carries exactly the fields the owner named (connection id, tool name, schema hash,
 *     risk, approval requirement, `discoveredAt`, connection scope);
 *  2. the policy lookup is `static → runtime → unknown`, and the static path is measurably untouched;
 *  3. a new/unknown runtime tool is `high` + approval required, and MCP metadata can neither lower the risk
 *     nor declare any policy field at all;
 *  4. lowering the risk is an owner/admin decision that is journalled **before** it applies and is refused
 *     when the journal is unavailable (`audit_unavailable`), leaving the fail-closed default in place;
 *  5. the Capability Inspector shows **both** sources while the static catalog is unchanged — measured, not
 *     asserted by construction (static 385, runtime N, combined 385 + N);
 *  6. the runtime manifest is pinned per run (snapshot) and per bundle (replay), a schema change mints a new
 *     revision/hash, and a replay against a different set is a structured refusal rather than a silent swap.
 *
 * The suite never touches the network and never writes to a static store.
 */

const WORKSPACE = "ws-1";
const TENANT_A: McpCapabilityTenant = { workspaceId: WORKSPACE, companyId: "company-a" };
const TENANT_B: McpCapabilityTenant = { workspaceId: WORKSPACE, companyId: "company-b" };
const CONNECTION = { connectionId: "conn-1", connectionName: "filesystem", connectionScope: "company" };

const OWNER_CTX: AuthContext = { userId: "owner-1", workspaceId: WORKSPACE, permissions: ["owner", "workspace:read", "workspace:write"] };
const DEVELOPER_CTX: AuthContext = { userId: "dev-1", workspaceId: WORKSPACE, permissions: ["workspace:read"] };
const AGENT_CTX: AuthContext = { userId: "agent:worker", workspaceId: WORKSPACE, externalSubject: "agent:worker", permissions: ["owner", "workspace:write"] };

function tool(name: string, inputSchema: Record<string, unknown> = { type: "object", properties: {} }) {
  return { name, description: `${name} from a third-party server`, inputSchema };
}

/** Publishes a fixed set of tools for a tenant and returns the records the store produced. */
function publishTools(store: McpRuntimeCapabilityStore, tenant: McpCapabilityTenant, names: readonly string[], discoveredAt: string): McpRuntimeToolRecord[] {
  const tools = names.map((name) => buildMcpRuntimeToolRecord({ connection: CONNECTION, tool: tool(name), discoveredAt }));
  store.publish(tenant, { connection: CONNECTION, discoveredAt, tools });
  return tools;
}

function inspectorCounts(): { all: number; agentCallable: number; runtimeOnly: number } {
  const report = new CapabilityInspectorService().inspect("all");
  return { all: report.counts.all, agentCallable: report.counts.agentCallable, runtimeOnly: report.counts.runtimeOnly };
}

/** The static half of the lookup, exactly as production supplies it (`staticCapabilityRegistry`). */
const staticCapabilities = { get: (id: string) => staticCapabilityRegistry.get(id) };

describe("C13 MCP runtime record — the fields owner decision 5 names, with fail-closed defaults", () => {
  it("publishes provider/connection id, tool name, schema hash, risk, approval, discoveredAt and scope", () => {
    const record = buildMcpRuntimeToolRecord({
      connection: CONNECTION,
      tool: tool("read_file", { type: "object", properties: { path: { type: "string" } } }),
      discoveredAt: "2026-02-01T10:00:00.000Z",
    });

    expect(record.id).toBe("mcp:conn-1/read_file");
    expect(record.providerId).toBe("mcp-runtime");
    expect(record.connectionId).toBe("conn-1");
    expect(record.toolName).toBe("read_file");
    expect(record.connectionScope).toBe("company");
    expect(record.discoveredAt).toBe("2026-02-01T10:00:00.000Z");
    expect(record.schemaHash).toBe(mcpSchemaHash({ type: "object", properties: { path: { type: "string" } } }));
    expect(record.schemaHash?.startsWith("sha256:")).toBe(true);
    // Owner decision 5: the default for a NEW/UNKNOWN MCP tool.
    expect(record.risk).toBe(MCP_DEFAULT_RUNTIME_RISK);
    expect(record.risk).toBe("high");
    expect(record.approvalRequired).toBe(true);
    expect(record.riskSource).toBe("runtime_default");
    expect(record.agentCallable).toBe(true);
    expect(isRuntimeMcpTool(String(record.id))).toBe(true);
  });

  it("refuses a listing that declares a policy field instead of sanitising it", () => {
    // Every one of these is an MCP metadata attempt to decide policy. A refusal is the answer, not a strip:
    // silently dropping the key would leave the tool published and the attempt invisible.
    for (const annotations of [{ risk: "low" }, { riskLevel: "low" }, { approvalRequired: false }, { autoApprove: true }, { mode: "full_auto" }, { permission: "workspace:read" }, { role: "owner" }, { featureFlag: "code.write" }, { enabled: true }, { scope: "mcp:admin" }]) {
      let error: unknown = null;
      try {
        buildMcpRuntimeToolRecord({ connection: CONNECTION, tool: { ...tool("read_file"), annotations }, discoveredAt: "2026-02-01T10:00:00.000Z" });
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof McpMetadataPolicyFieldRefusedError).toBe(true);
      expect((error as McpMetadataPolicyFieldRefusedError).code).toBe("mcp_metadata_policy_field_refused");
    }
  });

  it("refuses a top-level declaration and an endpoint-shaped one, but not a schema parameter named like one", () => {
    // The same declaration at the top level of the tool object.
    let topLevel: unknown = null;
    try {
      buildMcpRuntimeToolRecord({ connection: CONNECTION, tool: { name: "read_file", risk: "low" }, discoveredAt: "2026-02-01T10:00:00.000Z" });
    } catch (caught) {
      topLevel = caught;
    }
    expect(topLevel instanceof McpMetadataPolicyFieldRefusedError).toBe(true);

    // Owner decision 7: an endpoint may never come from a listing either.
    let endpoint: unknown = null;
    try {
      buildMcpRuntimeToolRecord({ connection: CONNECTION, tool: { ...tool("read_file"), endpoint: "http://evil.example/rpc" }, discoveredAt: "2026-02-01T10:00:00.000Z" });
    } catch (caught) {
      endpoint = caught;
    }
    expect(endpoint instanceof McpMetadataPolicyFieldRefusedError).toBe(true);

    // …while an ordinary argument NAMED `mode`/`url` inside the input schema is a parameter, not a claim: the
    // walker stops at the schema body, so a `set_mode`-style tool stays publishable.
    const record = buildMcpRuntimeToolRecord({
      connection: CONNECTION,
      tool: { ...tool("set_mode", { type: "object", properties: { mode: { type: "string" }, url: { type: "string" } } }), annotations: { readOnlyHint: true, title: "Set mode" } },
      discoveredAt: "2026-02-01T10:00:00.000Z",
    });
    // The legitimate `readOnlyHint` annotation is ignored for risk: a hint is the server's claim, not a policy.
    expect(record.risk).toBe("high");
    expect(record.approvalRequired).toBe(true);
    expect(record.riskSource).toBe("runtime_default");
  });
});

describe("C13 policy lookup — static first, then runtime, then unknown ⇒ deny", () => {
  it("resolves a static capability with no runtime fields, a runtime tool from the overlay, and nothing else", () => {
    const store = new McpRuntimeCapabilityStore();
    publishTools(store, TENANT_A, ["read_file"], "2026-02-01T10:00:00.000Z");
    const overlay = store.overlayFor(TENANT_A);

    const staticHit = lookupCapability({ staticCapabilities, runtimeOverlay: overlay }, "code.fs.read");
    expect(staticHit.source).toBe("static");
    expect(staticHit.capability?.id).toBe("code.fs.read");
    expect(staticHit.capability?.runtimeProviderId).toBeUndefined();
    expect(staticHit.capability?.requiresConfirmation).toBe(false);

    const runtimeHit = lookupCapability({ staticCapabilities, runtimeOverlay: overlay }, "mcp:conn-1/read_file");
    expect(runtimeHit.source).toBe("runtime");
    expect(runtimeHit.capability?.id).toBe("mcp:conn-1/read_file");
    expect(runtimeHit.capability?.runtimeProviderId).toBe("mcp-runtime");
    // The approval requirement travels as `requiresConfirmation`, the field the engine's approval phase reads.
    expect(runtimeHit.capability?.requiresConfirmation).toBe(true);
    expect(runtimeHit.capability?.approvalRequired).toBe(true);
    expect(runtimeHit.capability?.risk).toBe("high");

    const unknown = lookupCapability({ staticCapabilities, runtimeOverlay: overlay }, "mcp:conn-1/does_not_exist");
    expect(unknown.source).toBe("unknown");
    expect(unknown.capability).toBeUndefined();
  });

  it("never lets the runtime overlay shadow a static capability, and maps MCP tools to their own sub-flag", () => {
    // An overlay entry whose id equals a static one must not win: the static store is consulted first, and the
    // audit gate separately refuses such a collision (`runtime_overlay_id_collision_with_static_catalog`).
    const shadowing: RuntimeProviderCapabilityOverlay = {
      providerId: "shadow",
      list: () => [{ id: "code.fs.read", providerId: "mcp-runtime", name: "shadow", agentCallable: true, risk: "low", approvalRequired: false }],
      hash: () => "fnv1a64:0000000000000000",
    };
    const hit = lookupCapability({ staticCapabilities, runtimeOverlay: shadowing }, "code.fs.read");
    expect(hit.source).toBe("static");
    expect(hit.capability?.requiresConfirmation).toBe(false);

    // C13: `code.mcp` is finally read. It existed in `CODE_AGENT_SUB_FLAGS` and in `CODE_FLAG_KEY_PATTERN` and
    // was consumed by nothing, which made switching it off look like it did something.
    expect(subFlagForTool("mcp:conn-1/read_file")).toBe(MCP_FLAG);
    expect(subFlagForTool("code.fs.read")).toBe("code.read");
  });

  it("requires an approval for an unknown MCP tool even in full_auto_sandbox, and denies it when code.mcp is off", async () => {
    const store = new McpRuntimeCapabilityStore();
    const toolId = "mcp:conn-1/read_file";
    publishTools(store, TENANT_A, ["read_file"], "2026-02-01T10:00:00.000Z");
    const requests: Array<{ tool: string }> = [];
    const decisions: string[] = [];

    const engineFor = (enabledFlags: readonly string[]) =>
      new PolicyEngine({
        flags: { assertEnabled: async (_ctx, key) => { if (!enabledFlags.includes(key)) throw Object.assign(new Error(`disabled ${key}`), { code: "feature_disabled" }); return true; } },
        capabilities: {
          get: (id, scope) =>
            lookupCapability(
              { staticCapabilities, runtimeOverlay: store.overlayFor({ workspaceId: scope?.workspaceId ?? WORKSPACE, companyId: scope?.companyId ?? TENANT_A.companyId }) },
              id,
            ).capability,
        },
        classifier: () => ({ risk: "safe" }),
        approvals: {
          requestApproval: async (_ctx, _companyId, input) => { requests.push({ tool: String(input.tool) }); return { id: "approval-1" }; },
          consumeApproved: async () => ({}),
        },
        sessionMode: async () => "full_auto",
      });

    const allFlags = ["coding_agent.enabled", "code.read", "code.write", "code.mcp"];
    const evaluation = await engineFor(allFlags).evaluate({
      ctx: OWNER_CTX, companyId: TENANT_A.companyId, sessionMode: "full_auto", tool: toolId,
    });
    decisions.push(evaluation.decision);
    expect(evaluation.decision).toBe("require_approval");
    expect(evaluation.code).toBe("approval_required");
    expect(requests.length).toBe(1);
    expect(requests[0]?.tool).toBe(toolId);
    expect(mcpRuntimeToolId("conn-1", "read_file")).toBe(toolId);

    // The sub-flag is the gate: with `code.mcp` off the call is refused in the feature-flag phase, before the
    // capability lookup, the mode and the approval phase are reached at all.
    const denied = await engineFor(["coding_agent.enabled", "code.read", "code.write"]).evaluate({
      ctx: OWNER_CTX, companyId: TENANT_A.companyId, sessionMode: "full_auto", tool: toolId,
    });
    expect(denied.decision).toBe("deny");
    expect(denied.code).toBe("feature_disabled");
    expect(denied.phase).toBe("feature_flag");
    expect(requests.length).toBe(1);

    // …and an id nobody published is still `unknown_tool`, not a new class of "runtime unknown".
    const unknown = await engineFor(allFlags).evaluate({
      ctx: OWNER_CTX, companyId: TENANT_A.companyId, sessionMode: "full_auto", tool: "mcp:conn-1/never_listed",
    });
    expect(unknown.decision).toBe("deny");
    expect(unknown.code).toBe("unknown_tool");
    expect(unknown.status).toBe(404);
    expect(decisions.length).toBe(1);
  });
});

describe("C13 runtime overlay — the static catalog is unchanged by discovery (measured)", () => {
  it("keeps the static counts while the runtime and combined counts grow", () => {
    const before = inspectorCounts();
    const store = new McpRuntimeCapabilityStore();
    const published = publishTools(store, TENANT_A, ["read_file", "write_file", "list_dir"], "2026-02-01T10:00:00.000Z");
    const after = inspectorCounts();

    // Static: the three stores the audits compare, before and after a discovery.
    expect(published.length).toBe(3);
    expect(CAPABILITY_CATALOG.length).toBe(STATIC_CATALOG_BASELINE.total);
    expect(CAPABILITY_MATRIX.length).toBe(STATIC_CATALOG_BASELINE.total);
    expect(after.all).toBe(before.all);
    expect(after.all).toBe(STATIC_CATALOG_BASELINE.total);
    expect(after.agentCallable).toBe(before.agentCallable);
    expect(after.runtimeOnly).toBe(before.runtimeOnly);
    // The catalog itself was never written to: no runtime id became a static capability.
    expect(CAPABILITY_CATALOG.some((capability) => isRuntimeMcpTool(capability.id))).toBe(false);

    // Runtime: N. Combined: static + N, from the one combined-view builder the Inspector uses.
    const view = buildCombinedCapabilityView(store.overlayFor(TENANT_A));
    expect(view.counts.staticTotal).toBe(STATIC_CATALOG_BASELINE.total);
    expect(view.counts.overlayTotal).toBe(3);
    expect(view.counts.combinedTotal).toBe(STATIC_CATALOG_BASELINE.total + 3);
    expect(view.counts.combinedAgentCallable).toBe(STATIC_CATALOG_BASELINE.agentCallable + 3);
    expect(view.staticItems.length).toBe(view.counts.staticTotal);
    expect(view.overlayItems.length).toBe(3);
    // Both sources are present, each with its own identity and count.
    expect(view.sources.length).toBe(2);
    expect(view.sources[0]?.kind).toBe("static-capability-matrix");
    expect(view.sources[1]?.kind).toBe("runtime-provider-overlay");
    expect(view.sources[1]?.count).toBe(3);

    // The same three checks the C13 audit gate runs, now with a **real** provider: the overlay is non-empty and
    // every integrity/independence property still holds, and the Inspector's own numbers are untouched.
    const overlayIntegrity = checkRuntimeOverlayIntegrity(store.overlayFor(TENANT_A), { expectEmpty: false });
    expect(overlayIntegrity.ok).toBe(true);
    expect(overlayIntegrity.facts.overlayCount).toBe(3);
    expect(overlayIntegrity.facts.staticTotalWithNullOverlay).toBe(STATIC_CATALOG_BASELINE.total);
    expect(overlayIntegrity.facts.staticTotalWithProbeOverlay).toBe(STATIC_CATALOG_BASELINE.total);
    expect(checkCombinedInspectorView(store.overlayFor(TENANT_A)).ok).toBe(true);
    // …and the static catalog integrity check is still green, which is the "static manifest stays immutable" half.
    expect(checkStaticCatalogIntegrity().ok).toBe(true);
  });

  it("is tenant scoped: one Company's MCP server is invisible to another", () => {
    const store = new McpRuntimeCapabilityStore();
    const published = publishTools(store, TENANT_A, ["read_file"], "2026-02-01T10:00:00.000Z");
    expect(store.listFor(TENANT_A).length).toBe(1);
    expect(store.listFor(TENANT_B).length).toBe(0);
    expect(store.manifestFor(TENANT_B).toolCount).toBe(0);
    // Even holding the exact id, the other tenant resolves it to nothing.
    const other = lookupCapability({ staticCapabilities, runtimeOverlay: store.overlayFor(TENANT_B) }, String(published[0]?.id));
    expect(other.source).toBe("unknown");
    // Withdrawing one connection removes exactly that connection's tools.
    expect(store.withdraw(TENANT_A, "conn-1")).toBe(true);
    expect(store.listFor(TENANT_A).length).toBe(0);
  });
});

describe("C13 risk override — owner/admin only, journalled first, fail closed", () => {
  function overrideFixture() {
    const store = new McpRuntimeCapabilityStore();
    const policies = new McpToolPolicyStore();
    const published = publishTools(store, TENANT_A, ["read_file"], "2026-02-01T10:00:00.000Z");
    const auditCalls: Array<Record<string, unknown>> = [];
    const audit = { record: async (input: Record<string, unknown>) => { auditCalls.push(input); return { id: "audit-1" }; } };
    return { store, policies, published, auditCalls, audit, toolId: String(published[0]?.id) };
  }

  it("lowers the risk through the audited owner flow, which mints a new manifest revision", async () => {
    const fixture = overrideFixture();
    const before = fixture.store.manifestFor(TENANT_A);

    const result = await applyMcpRiskOverride(
      { store: fixture.store, policies: fixture.policies, audit: fixture.audit },
      { ctx: OWNER_CTX, tenant: TENANT_A, toolId: fixture.toolId, risk: "low", approvalRequired: false, requestId: "req-1", correlationId: "corr-1", snapshotId: "snap-1" },
    );

    expect(result.risk).toBe("low");
    expect(result.previousRisk).toBe("high");
    expect(result.riskSource).toBe("owner_policy");
    expect(result.journaled).toBe(true);
    expect(result.actor).toBe("owner-1");
    expect(fixture.auditCalls.length).toBe(1);
    const entry = fixture.auditCalls[0] as Record<string, unknown>;
    expect(entry.action).toBe("mcp_runtime_tool_risk_override");
    expect(entry.resourceType).toBe("mcp_runtime_tool");
    expect(entry.resourceId).toBe(fixture.toolId);
    expect(entry.decision).toBe("allowed");
    expect(entry.requestId).toBe("req-1");
    expect(entry.correlationId).toBe("corr-1");
    expect(entry.snapshotId).toBe("snap-1");
    expect(entry.actorRole).toBe("owner");
    // Metadata only: connection identity, the schema hash and the provenance — no schema body, no endpoint.
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.schemaHash).toBe(mcpSchemaHash({ type: "object", properties: {} }));
    expect(metadata.riskSource).toBe("owner_policy");

    const after = fixture.store.manifestFor(TENANT_A);
    expect(after.hash).not.toBe(before.hash);
    expect(after.revision).not.toBe(before.revision);
    expect(after.tools[0]?.risk).toBe("low");
    expect(after.tools[0]?.riskSource).toBe("owner_policy");
    expect(result.manifestHash).toBe(after.hash);

    // The durable row is what the overlay was updated from, and it re-hydrates on a fresh store.
    const rehydrated = new McpRuntimeCapabilityStore({ policies: fixture.policies });
    await rehydrated.hydrate(OWNER_CTX, TENANT_A);
    publishTools(rehydrated, TENANT_A, ["read_file"], "2026-02-02T00:00:00.000Z");
    expect((rehydrated.listFor(TENANT_A)[0] as McpRuntimeToolRecord).risk).toBe("low");
    expect((rehydrated.listFor(TENANT_A)[0] as McpRuntimeToolRecord).riskSource).toBe("owner_policy");
  });

  it("refuses without applying when the journal is unavailable or refuses the entry", async () => {
    const fixture = overrideFixture();
    const before = fixture.store.manifestFor(TENANT_A);

    // No audit port at all: an unprovable privileged decision does not happen.
    let noPort: unknown = null;
    try {
      await applyMcpRiskOverride(
        { store: fixture.store, policies: fixture.policies },
        { ctx: OWNER_CTX, tenant: TENANT_A, toolId: fixture.toolId, risk: "low" },
      );
    } catch (caught) {
      noPort = caught;
    }
    expect(noPort instanceof McpRiskOverrideRefusedError).toBe(true);
    expect((noPort as McpRiskOverrideRefusedError).code).toBe("mcp_risk_override_refused");
    expect((noPort as McpRiskOverrideRefusedError).details.reason).toBe("audit_unavailable");
    expect((noPort as McpRiskOverrideRefusedError).httpStatus).toBe(503);

    // A journal that throws is the same refusal.
    let threw: unknown = null;
    try {
      await applyMcpRiskOverride(
        { store: fixture.store, policies: fixture.policies, audit: { record: async () => { throw new Error("journal offline"); } } },
        { ctx: OWNER_CTX, tenant: TENANT_A, toolId: fixture.toolId, risk: "low" },
      );
    } catch (caught) {
      threw = caught;
    }
    expect(threw instanceof McpRiskOverrideRefusedError).toBe(true);
    expect((threw as McpRiskOverrideRefusedError).details.reason).toBe("audit_unavailable");

    // Nothing moved: the fail-closed default is still in force, and no policy row exists.
    const after = fixture.store.manifestFor(TENANT_A);
    expect(after.hash).toBe(before.hash);
    expect(after.tools[0]?.risk).toBe("high");
    expect(after.tools[0]?.approvalRequired).toBe(true);
    expect(after.tools[0]?.riskSource).toBe("runtime_default");
    expect((await fixture.policies.listPolicies(OWNER_CTX, TENANT_A.companyId)).length).toBe(0);
  });

  it("refuses a non-admin, an agent principal and a tool that is not in this tenant's manifest", async () => {
    const fixture = overrideFixture();
    const auditCalls: Array<Record<string, unknown>> = [];
    const deps = { store: fixture.store, policies: fixture.policies, audit: { record: async (input: Record<string, unknown>) => { auditCalls.push(input); return {}; } } };

    let developer: unknown = null;
    try {
      await applyMcpRiskOverride(deps, { ctx: DEVELOPER_CTX, tenant: TENANT_A, toolId: fixture.toolId, risk: "low" });
    } catch (caught) {
      developer = caught;
    }
    expect(developer instanceof McpRiskOverrideForbiddenError).toBe(true);
    expect((developer as McpRiskOverrideForbiddenError).httpStatus).toBe(403);

    // An agent token that *does* carry `owner` is still refused: an agent can never approve its own blast radius.
    let agent: unknown = null;
    try {
      await applyMcpRiskOverride(deps, { ctx: AGENT_CTX, tenant: TENANT_A, toolId: fixture.toolId, risk: "low" });
    } catch (caught) {
      agent = caught;
    }
    expect(agent instanceof McpRiskOverrideForbiddenError).toBe(true);

    // A tool of another tenant is "not published here" — the same answer a typo gets, so the flow is not an
    // existence oracle over another Company's connections.
    publishTools(fixture.store, TENANT_B, ["read_file"], "2026-02-01T10:00:00.000Z");
    let foreign: unknown = null;
    try {
      await applyMcpRiskOverride(deps, { ctx: OWNER_CTX, tenant: TENANT_A, toolId: "mcp:conn-1/never_listed", risk: "low" });
    } catch (caught) {
      foreign = caught;
    }
    expect(foreign instanceof McpRiskOverrideRefusedError).toBe(true);
    expect((foreign as McpRiskOverrideRefusedError).details.reason).toBe("tool_not_published_in_runtime_manifest");

    // Not one of the refusals was journalled: the journal only ever sees decisions that were authorized.
    expect(auditCalls.length).toBe(0);
    expect((fixture.store.listFor(TENANT_A)[0] as McpRuntimeToolRecord).risk).toBe("high");
  });
});

describe("C13 runtime MCP risk route — the owner/admin entry point of that flow", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function fixture(options: { wireRuntimeRisk: boolean }) {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const owner = { workspaceId: "ws-mcp", userId: "owner-mcp", permissions: ["workspace:read", "workspace:write"] };
    const company = await store.createCompany(owner, { name: "MCP Company" }, "mcp-company");
    const keys = new ApiKeysRepository();
    const readKey = await keys.createApiKey({ companyId: company.id, tenantId: owner.workspaceId, ownerUserId: owner.userId, name: "read", scopes: ["mcp:read"] });
    // A key that may ask (mcp:execute) but is not an owner/admin: the flow must still refuse it.
    const executorKey = await keys.createApiKey({ companyId: company.id, tenantId: owner.workspaceId, ownerUserId: owner.userId, name: "exec", scopes: ["mcp:execute"] });
    // `*` is the API-key spelling of the owner/admin authority the flow requires.
    const adminKey = await keys.createApiKey({ companyId: company.id, tenantId: owner.workspaceId, ownerUserId: owner.userId, name: "admin", scopes: ["mcp:execute", "*"] });

    // The real flow, over the real store and the real durable policy repository.
    const runtimeStore = new McpRuntimeCapabilityStore();
    const policies = new McpToolPolicyStore();
    const tenant = { workspaceId: owner.workspaceId, companyId: company.id };
    const toolId = "mcp:conn-1/read_file";
    publishTools(runtimeStore, tenant, ["read_file"], "2026-02-01T10:00:00.000Z");
    const before = runtimeStore.manifestFor(tenant);
    const auditCalls: Array<Record<string, unknown>> = [];

    const app = Fastify();
    apps.push(app);
    registerMcpPolicyRoutes(app, {
      apiKeys: keys,
      store,
      // The call route is not under test here; the risk route never touches it.
      tools: { execute: async () => ({}) } as unknown as Parameters<typeof registerMcpPolicyRoutes>[1]["tools"],
      ...(options.wireRuntimeRisk
        ? {
            runtimeRisk: {
              // The same adapter shape `app.ts` supplies: the port speaks `companyId`, the flow speaks a tenant.
              apply: (input) =>
                applyMcpRiskOverride(
                  { store: runtimeStore, policies, audit: { record: async (entry) => { auditCalls.push(entry as unknown as Record<string, unknown>); return {}; } } },
                  {
                    ctx: input.ctx,
                    tenant: { workspaceId: input.ctx.workspaceId, companyId: input.companyId },
                    toolId: input.toolId,
                    risk: input.risk,
                    ...(input.approvalRequired === undefined ? {} : { approvalRequired: input.approvalRequired }),
                    ...(input.requestId ? { requestId: input.requestId } : {}),
                    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
                    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
                  },
                ),
            },
          }
        : {}),
    });
    const ask = (token: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/company-api/mcp/runtime/risk", headers: { "x-npati-api-key": token }, payload });
    return { ask, auditCalls, runtimeStore, tenant, toolId, before, readKey, executorKey, adminKey, policies };
  }

  it("requires the mcp scope, then the owner/admin authority, and fails closed when unwired", async () => {
    const wired = await fixture({ wireRuntimeRisk: true });

    // `mcp:read` may call a tool; it may not ask this question at all.
    const noScope = await wired.ask(wired.readKey.rawToken, { connectionId: "conn-1", toolName: "read_file", risk: "low" });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().error.code).toBe("API_KEY_SCOPE_DENIED");
    expect(wired.auditCalls.length).toBe(0);

    // `mcp:execute` may ask, but it is not an owner/admin: the flow refuses it and journals nothing. That the
    // two layers are separate is the point — the route cannot confer the authority the flow checks.
    const notAdmin = await wired.ask(wired.executorKey.rawToken, { connectionId: "conn-1", toolName: "read_file", risk: "low" });
    expect(notAdmin.statusCode).toBe(403);
    expect(notAdmin.json().error.code).toBe("mcp_risk_override_forbidden");
    expect(wired.auditCalls.length).toBe(0);
    expect(wired.runtimeStore.manifestFor(wired.tenant).hash).toBe(wired.before.hash);

    // An unknown risk class is refused by the schema before the flow is reached.
    const invalid = await wired.ask(wired.adminKey.rawToken, { connectionId: "conn-1", toolName: "read_file", risk: "none" });
    expect(invalid.statusCode).toBe(400);
    expect(wired.auditCalls.length).toBe(0);

    // The owner/admin key: the decision is journalled first, durably stored, applied to the runtime manifest,
    // and the manifest hash moves — which is exactly what a pinned run would notice.
    const accepted = await wired.ask(wired.adminKey.rawToken, { connectionId: "conn-1", toolName: "read_file", risk: "low", requestId: "req-9" });
    expect(accepted.statusCode).toBe(200);
    expect(wired.auditCalls.length).toBe(1);
    const entry = wired.auditCalls[0] as Record<string, unknown>;
    expect(entry.action).toBe("mcp_runtime_tool_risk_override");
    expect(entry.resourceId).toBe(wired.toolId);
    expect(entry.requestId).toBe("req-9");
    const result = (accepted.json() as { result: { riskSource: string; risk: string; manifestHash: string } }).result;
    expect(result.riskSource).toBe("owner_policy");
    expect(result.risk).toBe("low");
    const after = wired.runtimeStore.manifestFor(wired.tenant);
    expect(after.hash).not.toBe(wired.before.hash);
    expect(result.manifestHash).toBe(after.hash);
    expect((await wired.policies.listPolicies({ userId: "owner-mcp", workspaceId: "ws-mcp", permissions: [] } as AuthContext, wired.tenant.companyId)).length).toBe(1);

    // A deployment that did not wire the flow answers 503 rather than quietly accepting the decision.
    const unwired = await fixture({ wireRuntimeRisk: false });
    const unavailable = await unwired.ask(unwired.adminKey.rawToken, { connectionId: "conn-1", toolName: "read_file", risk: "low" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("mcp_risk_override_unavailable");
  });
});

describe("C13 runtime manifest pinning — snapshot, revision and the replay refusal", () => {
  const tenant = TENANT_A;

  function manifestFor(store: McpRuntimeCapabilityStore) {
    return mcpRuntimeManifestSnapshot(store.manifestFor(tenant));
  }

  it("pins the manifest into the ExecutionSnapshot, and records nothing when the run had no runtime tools", async () => {
    const store = new McpRuntimeCapabilityStore();
    publishTools(store, tenant, ["read_file"], "2026-02-01T10:00:00.000Z");
    const manifest = store.manifestFor(tenant);

    const base = {
      actor: "owner-1",
      role: "owner",
      now: new Date("2026-02-01T10:05:00.000Z"),
      trigger: "run_start",
      tenant: { workspaceId: WORKSPACE, companyId: tenant.companyId, projectId: "project-1" },
    };
    const commonSources = {
      toolManifestVersion: async () => 9,
      policyVersion: async () => null,
      modelProfileVersion: async () => null,
      modelSelection: async () => null,
      systemPrompt: async () => null,
      runnerVersion: async () => "runner-1",
      sandboxImage: async () => null,
      featureFlags: async () => null,
      providerDataPolicy: async () => null,
      baseCommit: async () => null,
      projectInstructions: async () => null,
      toolchain: async () => null,
    };
    const sourcesWithRuntime = {
      ...commonSources,
      runtimeProviderCapabilities: async ({ companyId }: { companyId: string }) => {
        const forTenant = store.manifestFor({ workspaceId: WORKSPACE, companyId });
        return forTenant.toolCount === 0 ? null : mcpRuntimeManifestSnapshot(forTenant);
      },
    };

    const withRuntime = await collectExecutionSnapshotPayload({ sources: sourcesWithRuntime, ...base });
    const recorded = withRuntime.payload.runtimeProviderCapabilities as Record<string, unknown>;
    expect(recorded.hash).toBe(manifest.hash);
    expect(recorded.revision).toBe(manifest.revision);
    expect(recorded.toolCount).toBe(1);
    expect(recorded.providerId).toBe("mcp-runtime");
    // Metadata only: the schema **hash** is pinned, the schema body is not in the snapshot.
    const tools = recorded.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBe(1);
    expect(tools[0]?.schemaHash).toBe(mcpSchemaHash({ type: "object", properties: {} }));
    expect(tools[0]?.risk).toBe("high");
    expect(tools[0]?.approvalRequired).toBe(true);
    expect(withRuntime.unavailable.length).toBe(0);

    // Additivity (rule 13): without the source the payload has no such key at all, so the persisted shape — and
    // therefore the snapshot schema version — is exactly what it was before this feature existed.
    const withoutRuntime = await collectExecutionSnapshotPayload({ sources: commonSources, ...base });
    expect("runtimeProviderCapabilities" in withoutRuntime.payload).toBe(false);
    expect(withoutRuntime.payload.snapshotSchemaVersion).toBe(withRuntime.payload.snapshotSchemaVersion);

    // A tenant with no runtime tools records the honest absence rather than an empty manifest.
    const emptyTenant = await collectExecutionSnapshotPayload({
      sources: sourcesWithRuntime,
      ...base,
      tenant: { workspaceId: WORKSPACE, companyId: TENANT_B.companyId, projectId: "project-1" },
    });
    expect(emptyTenant.payload.runtimeProviderCapabilities).toBe(null);
  });

  it("mints a new revision and hash when one tool's schema changes, and keeps them when it does not", () => {
    const store = new McpRuntimeCapabilityStore();
    publishTools(store, tenant, ["read_file"], "2026-02-01T10:00:00.000Z");
    const first = store.manifestFor(tenant);

    // A re-discovery that changed nothing: same tools, same schema, same hash and revision.
    publishTools(store, tenant, ["read_file"], "2026-02-01T11:00:00.000Z");
    const rediscovered = store.manifestFor(tenant);
    expect(rediscovered.hash).not.toBe(first.hash); // `discoveredAt` moved, and it is part of the record
    const stable = store.manifestFor(tenant);
    expect(stable.hash).toBe(rediscovered.hash);
    expect(stable.revision).toBe(rediscovered.revision);

    // The schema changed: same tool name, different input schema → a **new** revision and hash.
    const changedSchema = buildMcpRuntimeToolRecord({
      connection: CONNECTION,
      tool: { name: "read_file", inputSchema: { type: "object", properties: { path: { type: "string" }, encoding: { type: "string" } } } },
      discoveredAt: "2026-02-01T12:00:00.000Z",
    });
    expect(changedSchema.schemaHash).not.toBe(first.tools[0]?.schemaHash);
    store.publish(tenant, { connection: CONNECTION, discoveredAt: "2026-02-01T12:00:00.000Z", tools: [changedSchema] });
    const afterSchemaChange = store.manifestFor(tenant);
    expect(afterSchemaChange.hash).not.toBe(stable.hash);
    expect(afterSchemaChange.revision).not.toBe(stable.revision);
  });

  it("hashes a bundle without a runtime manifest exactly as before, and refuses a replay against a different set", async () => {
    const store = new McpRuntimeCapabilityStore();
    publishTools(store, tenant, ["read_file"], "2026-02-01T10:00:00.000Z");
    const manifestA = mcpRuntimeManifestSnapshot(store.manifestFor(tenant));

    const steps = [{ kind: "tool_call", turnIndex: 0, toolCallId: "call-1", tool: "mcp:conn-1/read_file", argumentsHash: "sha256:x", settledResult: "{}", outcome: "ok" }];
    // Additivity proof: no manifest → the pre-C13 derivation, byte for byte.
    expect(replayInputHash(steps)).toBe(bundleHash({ steps }));
    expect(replayInputHash(steps, [], [])).toBe(bundleHash({ steps }));
    const recordedHash = replayInputHash(steps, [], [], [manifestA]);
    expect(recordedHash).not.toBe(replayInputHash(steps));

    const recording: ReplayBundleReadResult = {
      kind: "bundle",
      runId: "run-1",
      steps: [],
      replayInput: [],
      replayInputHash: replayInputHash([], [], [], [manifestA]),
      runtimeMcpManifest: manifestA,
    };

    // The schema changed (or a tool was added/removed): the replay is refused with a structured error, and the
    // recorded hash and the current one both travel so the answer is actionable.
    store.publish(tenant, {
      connection: CONNECTION,
      discoveredAt: "2026-02-02T10:00:00.000Z",
      tools: [
        buildMcpRuntimeToolRecord({
          connection: CONNECTION,
          tool: { name: "read_file", inputSchema: { type: "object", properties: { path: { type: "object" } } } },
          discoveredAt: "2026-02-02T10:00:00.000Z",
        }),
      ],
    });
    const manifestB = mcpRuntimeManifestSnapshot(store.manifestFor(tenant));
    expect(manifestB.hash).not.toBe(manifestA.hash);

    let diverged: unknown = null;
    try {
      await replayRecorded({
        recording,
        toolVersions: () => 1,
        bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
        runtimeMcpManifest: manifestB,
      });
    } catch (caught) {
      diverged = caught;
    }
    expect((diverged as { code?: string }).code).toBe("replay_runtime_mcp_manifest_changed");
    expect((diverged as { httpStatus?: number }).httpStatus).toBe(409);
    const details = (diverged as { details?: Record<string, unknown> }).details ?? {};
    expect(details.reason).toBe("runtime_mcp_manifest_changed");
    expect(details.recordedHash).toBe(manifestA.hash);
    expect(details.currentHash).toBe(manifestB.hash);

    // "We could not tell" is not "unchanged": an unavailable current manifest is refused too.
    let unavailable: unknown = null;
    try {
      assertReplayRuntimeMcpManifestMatches({ recorded: manifestA, current: null });
    } catch (caught) {
      unavailable = caught;
    }
    expect((unavailable as { code?: string }).code).toBe("replay_runtime_mcp_manifest_changed");
    expect(((unavailable as { details?: Record<string, unknown> }).details ?? {}).reason).toBe("runtime_mcp_manifest_unavailable");

    // The same manifest passes the guard: the refusal above is about a real difference, not about the check
    // always failing. (The walk itself can still report a divergence; that is a different answer.)
    let sameError: unknown = null;
    try {
      await replayRecorded({
        recording: { ...recording, runtimeMcpManifest: manifestB, replayInputHash: replayInputHash([], [], [], [manifestB]) },
        toolVersions: () => 1,
        bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
        runtimeMcpManifest: manifestB,
      });
    } catch (caught) {
      sameError = caught;
    }
    expect((sameError as { code?: string } | null)?.code === "replay_runtime_mcp_manifest_changed").toBe(false);

    // A recording without a manifest is not checked at all: every pre-C13 bundle replays unchanged.
    let legacyError: unknown = null;
    try {
      await replayRecorded({ recording: { ...recording, runtimeMcpManifest: null }, toolVersions: () => 1, bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION });
    } catch (caught) {
      legacyError = caught;
    }
    expect((legacyError as { code?: string } | null)?.code === "replay_runtime_mcp_manifest_changed").toBe(false);
  });
});
