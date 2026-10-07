import { createHash } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import {
  hashRuntimeOverlayEntries,
  stableJson,
  type CapabilityRisk,
  type RuntimeProviderCapability,
  type RuntimeProviderCapabilityOverlay,
} from "@npati/shared";
import {
  MCP_RUNTIME_PROVIDER_ID,
  mcpRuntimeToolId,
  parseMcpRuntimeToolId,
} from "./mcp-runtime-identity";
import type { McpToolPolicyRecord, McpToolPolicyRepository } from "./mcp-tool-policy-repository";

/**
 * C13 (owner decision 5–8): the **runtime** half of the capability system.
 *
 * The owner's decision is explicit and this module is built around it:
 *
 *  - the static manifest stays versioned and immutable; a discovered MCP tool is never pushed into
 *    `CAPABILITY_CATALOG` / `CAPABILITY_MATRIX` / `defaultCapabilityRegistry` (owner decision 5, 8);
 *  - runtime MCP tools live in a `RuntimeProviderCapabilityOverlay` that the **Capability Inspector** shows
 *    beside the static matrix, never folded into it (`buildCombinedCapabilityView`);
 *  - a runtime record carries `providerId`/connection id, tool name, schema hash (and version when the
 *    server declares one), risk, the approval requirement, `discoveredAt` and the connection scope;
 *  - the **default is `high` + approval required**, and an MCP server's own metadata can neither lower the
 *    risk nor declare any policy field at all (the closed vocabulary below);
 *  - lowering the risk is an owner/admin **policy** decision that is journalled in the tamper-evident
 *    AuditLog *before* it applies and refuses when the journal is unavailable (`mcp-risk-override.ts`);
 *  - the policy lookup is `static → runtime → unknown ⇒ deny`, in one function so the order is testable;
 *  - the runtime manifest is **pinned per run** (snapshot) and per bundle (replay), and a replay whose
 *    current manifest hash differs is a structured refusal, never a silent "use whichever set is loaded".
 *
 * Nothing here writes to the static stores. `checkRuntimeOverlayIntegrity` /
 * `checkCombinedInspectorView` in `@npati/shared` measure that on every gate run.
 */

/* ---------------------------------------------------------------------------------------------------
 * Constants: the fail-closed defaults and the closed policy vocabulary
 * ------------------------------------------------------------------------------------------------- */

/**
 * Owner decision 5: "Default для нового/невідомого MCP tool: risk = high/unknown, approval required = true."
 * `high` (not `unknown`) is the value the capability vocabulary has a word for, and it is a member of the
 * `requires-approval` slice of the Inspector, so an undiscovered-until-now tool is visible as one.
 */
export const MCP_DEFAULT_RUNTIME_RISK: CapabilityRisk = "high";
export const MCP_DEFAULT_APPROVAL_REQUIRED = true;

/**
 * The closed vocabulary an MCP server's metadata may **never** declare.
 *
 * This mirrors the hooks/slash-command pattern: rather than sanitising a hostile declaration, a declaration
 * is *refused by name*, so an attempt is a loud error and the tool is not published at all. The list is
 * deliberately over-broad — every spelling of a field that could be read as a policy decision — because a
 * false refusal costs a tool listing while a missed one costs the invariant the owner asked for.
 */
export const FORBIDDEN_MCP_METADATA_KEYS: readonly string[] = [
  "risk", "risklevel", "risk_level", "riskclass", "risk_class",
  "approval", "approvals", "approvalrequired", "approval_required", "requiresapproval", "requires_approval",
  "requiresconfirmation", "requires_confirmation", "confirmation", "autapprove", "autoapprove", "auto_approve",
  "mode", "sessionmode", "session_mode", "executionmode", "execution_mode",
  "permission", "permissions", "scope", "scopes", "role", "roles", "rbac",
  "flag", "flags", "featureflag", "feature_flag", "enabled",
  "allow", "allowed", "allowlist", "deny", "denied", "blocked",
  "canchangepolicy", "can_change_policy", "cangranttools", "can_grant_tools", "cangrantcapabilities",
  "capability", "capabilities", "tool", "tools",
  "trust", "trusted", "admin", "owner", "policy", "policies", "provider", "endpoint", "url", "transport",
] as const;

const FORBIDDEN_METADATA_SET = new Set<string>(FORBIDDEN_MCP_METADATA_KEYS);

/** Raised when MCP metadata tries to declare a policy decision; the tool is not published. */
export class McpMetadataPolicyFieldRefusedError extends Error {
  readonly code = "mcp_metadata_policy_field_refused";
  readonly httpStatus = 400;
  readonly details: { provider: string; connectionId: string; field: string };
  constructor(connectionId: string, field: string) {
    super(`MCP metadata must not declare the policy field "${field}"; an MCP server cannot set its own risk, approval, mode, permission, role or flag`);
    this.name = "McpMetadataPolicyFieldRefusedError";
    this.details = { provider: MCP_RUNTIME_PROVIDER_ID, connectionId, field };
  }
}

/** Raised when a discovered tool name or connection is unusable; the tool is not published. */
export class McpRuntimeToolInvalidError extends Error {
  readonly code = "mcp_runtime_tool_invalid";
  readonly httpStatus = 400;
  readonly details: { connectionId: string; field: string };
  constructor(connectionId: string, field: string) {
    super(`MCP tool listing is not usable: ${field}`);
    this.name = "McpRuntimeToolInvalidError";
    this.details = { connectionId, field };
  }
}

/* ---------------------------------------------------------------------------------------------------
 * The runtime record
 * ------------------------------------------------------------------------------------------------- */

/** One configured MCP connection, as it exists in the product's own `company_mcp_servers` row. */
export interface McpConnectionRef {
  connectionId: string;
  connectionName: string;
  /** The scope the connection was configured in. Recorded, never inferred from server metadata. */
  connectionScope: string;
}

/**
 * What an MCP `tools/list` answer is allowed to contribute: a tool name, a description and an input schema.
 * Everything else — including `annotations` — is untrusted and inspected for the closed vocabulary above.
 */
export interface McpDiscoveredTool {
  name: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
  [key: string]: unknown;
}

/** The runtime record of owner decision 5. It is a `RuntimeProviderCapability`, so the Inspector can render it. */
export interface McpRuntimeToolRecord extends RuntimeProviderCapability {
  connectionId: string;
  toolName: string;
  schemaHash: string;
  approvalRequired: boolean;
  discoveredAt: string;
  connectionScope: string;
  riskSource: "runtime_default" | "owner_policy";
}

/** The canonical schema hash of one tool's input schema: a schema change mints a new manifest revision. */
export function mcpSchemaHash(inputSchema: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(inputSchema ?? {}), "utf8").digest("hex")}`;
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Keys whose value is **opaque data**, not metadata: an input schema describes the arguments a tool accepts,
 * so a property legitimately named `mode` or `url` inside it is a parameter name and not a policy claim. The
 * walker therefore stops at these keys instead of recursing (refusing them would make an ordinary
 * `set_mode`-style tool unpublishable, which is a false refusal on the safe side of nothing).
 */
const OPAQUE_SCHEMA_KEYS = new Set(["inputschema", "outputschema", "input_schema", "output_schema", "schema", "parameters"]);

/**
 * Refuses a policy declaration anywhere in a tool's **metadata**, at any depth. Arrays are walked, and the
 * walk stops at the schema bodies above, because a hostile listing nests a declaration inside `annotations`
 * or `_meta` rather than at the top level.
 */
export function assertNoMcpPolicyMetadata(connectionId: string, value: unknown, depth = 0, trail: string[] = []): void {
  if (value === null || value === undefined) return;
  if (depth > 6) return;
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item, index) => assertNoMcpPolicyMetadata(connectionId, item, depth + 1, [...trail, String(index)]));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_METADATA_SET.has(lowered)) {
      throw new McpMetadataPolicyFieldRefusedError(connectionId, [...trail, key].join("."));
    }
    if (OPAQUE_SCHEMA_KEYS.has(lowered)) continue;
    assertNoMcpPolicyMetadata(connectionId, item, depth + 1, [...trail, key]);
  }
}

/**
 * Builds the runtime record of one discovered tool.
 *
 * The fail-closed part is structural, not a check: `risk` and `approvalRequired` are **assigned the
 * constants**, never read from the listing, and the listing is refused outright if it names any policy field.
 * So even a listing that carries `{"readOnlyHint": true}` — a legitimate MCP annotation — publishes a `high`,
 * approval-required tool, because a hint is a *claim by the server* and a claim is not a policy.
 */
export function buildMcpRuntimeToolRecord(input: {
  connection: McpConnectionRef;
  tool: McpDiscoveredTool;
  discoveredAt: string;
}): McpRuntimeToolRecord {
  const connectionId = String(input.connection.connectionId ?? "");
  if (!CONNECTION_ID_PATTERN.test(connectionId)) {
    throw new McpRuntimeToolInvalidError(connectionId, "connectionId");
  }
  const toolName = typeof input.tool.name === "string" ? input.tool.name.trim() : "";
  if (!TOOL_NAME_PATTERN.test(toolName)) {
    throw new McpRuntimeToolInvalidError(connectionId, "tool.name");
  }
  // The whole listing is inspected, not only `annotations`: a server that puts `risk` at the top level of a
  // tool object is making the same declaration as one that nests it.
  assertNoMcpPolicyMetadata(connectionId, input.tool);

  const schemaHash = mcpSchemaHash(input.tool.inputSchema);
  const description = typeof input.tool.description === "string" ? input.tool.description.slice(0, 500) : "";
  return {
    id: mcpRuntimeToolId(connectionId, toolName),
    providerId: MCP_RUNTIME_PROVIDER_ID,
    name: description || toolName,
    agentCallable: true,
    // Assigned, never read from the listing (owner decision 5).
    risk: MCP_DEFAULT_RUNTIME_RISK,
    approvalRequired: MCP_DEFAULT_APPROVAL_REQUIRED,
    source: `mcp:${input.connection.connectionName}`,
    connectionId,
    toolName,
    schemaHash,
    discoveredAt: input.discoveredAt,
    connectionScope: input.connection.connectionScope,
    riskSource: "runtime_default",
  };
}

/* ---------------------------------------------------------------------------------------------------
 * The manifest and the overlay
 * ------------------------------------------------------------------------------------------------- */

/** A metadata-only view of one connection inside the runtime manifest. No schema body, no tool arguments. */
export interface McpRuntimeManifestConnection {
  connectionId: string;
  connectionName: string;
  connectionScope: string;
  discoveredAt: string;
  toolCount: number;
  schemaHashes: string[];
}

/**
 * The **runtime MCP manifest** the owner asked for (decision 6): the fact a snapshot and a replay bundle pin.
 * `revision` is derived from `hash`, so "the schema changed" and "the revision changed" are the same event —
 * a revision counter that could stay put while the hash moved would be a second, weaker source of truth.
 */
export interface McpRuntimeManifest {
  providerId: string;
  revision: string;
  hash: string;
  toolCount: number;
  connectionCount: number;
  connections: McpRuntimeManifestConnection[];
  tools: Array<Pick<McpRuntimeToolRecord, "id" | "connectionId" | "toolName" | "schemaHash" | "risk" | "approvalRequired" | "discoveredAt" | "connectionScope" | "riskSource">>;
}

export interface McpCapabilityTenant {
  workspaceId: string;
  companyId: string;
}

function tenantKey(tenant: McpCapabilityTenant): string {
  return `${tenant.workspaceId}\u0000${tenant.companyId}`;
}

/** One connection's published tool set, as discovered from the configured integration. */
export interface McpConnectionToolSet {
  connection: McpConnectionRef;
  discoveredAt: string;
  tools: McpRuntimeToolRecord[];
  /**
   * The declared input schema of each published tool, keyed by tool name.
   *
   * It is kept **beside** the records, never inside them, and that separation is the whole point: a runtime
   * record is a metadata view (id, schema *hash*, risk, approval, discovery time), so the manifest, the
   * ExecutionSnapshot and every Activity event derived from it carry hashes and never a schema body. The model
   * still has to be told which arguments a tool accepts, so the schema has exactly one home — here, in the
   * published listing — and one reader: the run path that builds the model's tool definitions.
   */
  schemas?: Record<string, unknown>;
}

export interface McpRuntimeCapabilityStoreOptions {
  /** Durable owner/admin risk overrides; absent means "no override can ever be loaded" (never "allow"). */
  policies?: McpToolPolicyRepository;
  now?: () => Date;
}

/**
 * The runtime capability store.
 *
 * It is **tenant keyed**: `listFor(tenant)` answers with that Company's tools only, so one Company's MCP
 * server is invisible to another (no shared list an Inspector could leak through). `overlayFor(tenant)`
 * returns the `RuntimeProviderCapabilityOverlay` the Inspector and the audit gates consume.
 */
export class McpRuntimeCapabilityStore {
  private readonly connections = new Map<string, Map<string, McpConnectionToolSet>>();
  /** Key: `tenant\0connectionId\0toolName`. Loaded from the policy store, applied to the published risk. */
  private readonly overrides = new Map<string, McpToolPolicyRecord>();
  private readonly now: () => Date;

  constructor(private readonly options: McpRuntimeCapabilityStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Loads the durable owner/admin overrides for one tenant. A failing store leaves the defaults in place. */
  async hydrate(ctx: AuthContext, tenant: McpCapabilityTenant): Promise<number> {
    if (!this.options.policies) return 0;
    let records: McpToolPolicyRecord[];
    try {
      records = await this.options.policies.listPolicies(ctx, tenant.companyId);
    } catch {
      return 0;
    }
    for (const record of records) {
      if (record.riskSource !== "owner_policy") continue;
      this.overrides.set(`${tenantKey(tenant)}\u0000${record.connectionId}\u0000${record.toolName}`, record);
    }
    return records.length;
  }

  /** Publishes one connection's listing, replacing whatever that connection offered before. */
  publish(tenant: McpCapabilityTenant, toolSet: McpConnectionToolSet): void {
    const key = tenantKey(tenant);
    const byConnection = this.connections.get(key) ?? new Map<string, McpConnectionToolSet>();
    const ids = new Set<string>();
    for (const tool of toolSet.tools) {
      if (parseMcpRuntimeToolId(tool.id) === null) {
        throw new McpRuntimeToolInvalidError(toolSet.connection.connectionId, "tool.id");
      }
      if (ids.has(tool.id)) {
        throw new McpRuntimeToolInvalidError(toolSet.connection.connectionId, `duplicate tool id ${tool.id}`);
      }
      ids.add(tool.id);
    }
    byConnection.set(toolSet.connection.connectionId, toolSet);
    this.connections.set(key, byConnection);
  }

  /** Removes one connection (a deleted or disabled integration). Returns whether anything was removed. */
  withdraw(tenant: McpCapabilityTenant, connectionId: string): boolean {
    const byConnection = this.connections.get(tenantKey(tenant));
    if (!byConnection) return false;
    return byConnection.delete(connectionId);
  }

  /** Forgets everything for one tenant (integration list replaced by a fresh discovery). */
  clear(tenant: McpCapabilityTenant): void {
    this.connections.delete(tenantKey(tenant));
  }

  /** Records one owner/admin risk override in memory (the durable write happened in the audit-first flow). */
  applyOverride(tenant: McpCapabilityTenant, record: McpToolPolicyRecord): void {
    this.overrides.set(`${tenantKey(tenant)}\u0000${record.connectionId}\u0000${record.toolName}`, record);
  }

  /** The override in force for one tool, or `null`. */
  overrideFor(tenant: McpCapabilityTenant, connectionId: string, toolName: string): McpToolPolicyRecord | null {
    return this.overrides.get(`${tenantKey(tenant)}\u0000${connectionId}\u0000${toolName}`) ?? null;
  }

  /**
   * The **published** record of one tool — exactly what the server's listing produced, with no owner/admin
   * override applied (contrast `listFor`, whose result is the reader's view).
   *
   * A discovery pass reads this to answer one question: is this tool, as the server just listed it, the same
   * tool that is already published? If it is (same description, same schema hash), the record keeps its
   * original `discoveredAt`, because the tool's identity did not change — see the note in
   * `discoverMcpRuntimeCapabilities` for why the manifest hash must not move for a re-listing that changed
   * nothing (a snapshot/replay guard that moved with the clock would refuse every replay).
   */
  publishedRecord(tenant: McpCapabilityTenant, connectionId: string, toolName: string): McpRuntimeToolRecord | null {
    const toolSet = this.connections.get(tenantKey(tenant))?.get(connectionId);
    if (!toolSet) return null;
    return toolSet.tools.find((tool) => tool.toolName === toolName) ?? null;
  }

  /** Every **published** record of one tenant (no override applied, ordered as `publish` stored them). */
  publishedFor(tenant: McpCapabilityTenant): McpRuntimeToolRecord[] {
    const byConnection = this.connections.get(tenantKey(tenant));
    if (!byConnection) return [];
    return [...byConnection.values()].flatMap((toolSet) => [...toolSet.tools]);
  }

  /**
   * The declared input schema of one published tool, or `null` when this store has none.
   *
   * `null` is "unknown", never "no arguments": a caller that needs the schema (the model's tool definition)
   * must treat the absence as an empty, unconstrained schema rather than inventing one, and a caller that only
   * needs the contract uses `publishedRecord(...).schemaHash`.
   */
  inputSchemaFor(tenant: McpCapabilityTenant, connectionId: string, toolName: string): Record<string, unknown> | null {
    const schemas = this.connections.get(tenantKey(tenant))?.get(connectionId)?.schemas;
    const schema = schemas?.[toolName];
    return schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>) : null;
  }

  /**
   * The runtime capabilities of one tenant, with the owner/admin overrides applied.
   *
   * Applied at read time on purpose: the published listing stays exactly what the server said, so a reader can
   * always see that a risk was **raised or lowered by policy** (`riskSource: "owner_policy"`) rather than by
   * the server, and withdrawing an override needs no re-discovery.
   */
  listFor(tenant: McpCapabilityTenant): RuntimeProviderCapability[] {
    const byConnection = this.connections.get(tenantKey(tenant));
    if (!byConnection) return [];
    const out: RuntimeProviderCapability[] = [];
    for (const toolSet of [...byConnection.values()].sort((a, b) => (a.connection.connectionId < b.connection.connectionId ? -1 : 1))) {
      for (const tool of [...toolSet.tools].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const override = this.overrideFor(tenant, tool.connectionId, tool.toolName);
        out.push(
          override
            ? {
                ...tool,
                risk: override.risk,
                approvalRequired: override.approvalRequired,
                riskSource: "owner_policy",
              }
            : { ...tool },
        );
      }
    }
    return out;
  }

  /** The `RuntimeProviderCapabilityOverlay` of one tenant — the same shape the C13 audit gates consume. */
  overlayFor(tenant: McpCapabilityTenant): McpRuntimeCapabilityOverlay {
    return new McpRuntimeCapabilityOverlay(this, tenant);
  }

  /** The runtime manifest of one tenant. `hash` is the overlay's own hash, so the two cannot disagree. */
  manifestFor(tenant: McpCapabilityTenant): McpRuntimeManifest {
    const tools = this.listFor(tenant) as McpRuntimeToolRecord[];
    const hash = hashRuntimeOverlayEntries(tools);
    const byConnection = new Map<string, McpRuntimeManifestConnection>();
    for (const tool of tools) {
      const existing = byConnection.get(tool.connectionId);
      if (existing) {
        existing.toolCount += 1;
        existing.schemaHashes.push(tool.schemaHash);
        continue;
      }
      byConnection.set(tool.connectionId, {
        connectionId: tool.connectionId,
        connectionName: tool.source?.startsWith("mcp:") ? tool.source.slice(4) : tool.connectionId,
        connectionScope: tool.connectionScope,
        discoveredAt: tool.discoveredAt,
        toolCount: 1,
        schemaHashes: [tool.schemaHash],
      });
    }
    const connections = [...byConnection.values()].sort((a, b) => (a.connectionId < b.connectionId ? -1 : 1));
    return {
      providerId: MCP_RUNTIME_PROVIDER_ID,
      revision: `${MCP_RUNTIME_PROVIDER_ID}/${hash}`,
      hash,
      toolCount: tools.length,
      connectionCount: connections.length,
      connections,
      tools: tools.map((tool) => ({
        id: tool.id,
        connectionId: tool.connectionId,
        toolName: tool.toolName,
        schemaHash: tool.schemaHash,
        risk: tool.risk,
        approvalRequired: tool.approvalRequired,
        discoveredAt: tool.discoveredAt,
        connectionScope: tool.connectionScope,
        riskSource: tool.riskSource,
      })),
    };
  }

  /** `discoveredAt` for a fresh discovery, from the injected clock. */
  timestamp(): string {
    return this.now().toISOString();
  }
}

/**
 * The overlay of one tenant. It is a **read-only view** over the store: there is no `publish` here, so a
 * consumer of the `RuntimeProviderCapabilityOverlay` interface (the Inspector, the audit gates) structurally
 * cannot change what the runtime offers.
 */
export class McpRuntimeCapabilityOverlay implements RuntimeProviderCapabilityOverlay {
  readonly providerId = MCP_RUNTIME_PROVIDER_ID;

  constructor(
    private readonly store: McpRuntimeCapabilityStore,
    private readonly tenant: McpCapabilityTenant,
  ) {}

  list(): RuntimeProviderCapability[] {
    return this.store.listFor(this.tenant);
  }

  hash(): string {
    return hashRuntimeOverlayEntries(this.list());
  }
}

/* ---------------------------------------------------------------------------------------------------
 * The policy lookup: static -> runtime -> unknown
 * ------------------------------------------------------------------------------------------------- */

/** What the policy engine reads from one resolved capability. Structural, so no service import is needed. */
export interface ResolvedCapability {
  id: string;
  status?: string;
  version?: number;
  requiresConfirmation?: boolean;
  /** Set only for a runtime provider capability; absent for a static catalog one. */
  runtimeProviderId?: string;
  risk?: CapabilityRisk;
  approvalRequired?: boolean;
  schemaHash?: string;
}

export interface CapabilityLookupDeps {
  /** The **static** registry — `staticCapabilityRegistry` in production. Read first, never written. */
  staticCapabilities: { get(id: string): ResolvedCapability | undefined };
  /** The tenant's runtime provider overlay. Read second. */
  runtimeOverlay: RuntimeProviderCapabilityOverlay;
}

export type CapabilityLookupSource = "static" | "runtime" | "unknown";

export interface CapabilityLookupResult {
  capability: ResolvedCapability | undefined;
  source: CapabilityLookupSource;
}

/**
 * The single capability lookup the policy port uses (owner decision 5: `static → runtime → unknown ⇒ deny`).
 *
 * It is one function rather than two call sites because the *order* is the security property: a runtime tool
 * may never shadow a static capability, and an id nobody published resolves to `undefined`, which the engine
 * turns into `unknown_tool` (HTTP 404). Returning the source as well makes both halves assertable in a test.
 */
export function lookupCapability(deps: CapabilityLookupDeps, id: string): CapabilityLookupResult {
  const staticCapability = deps.staticCapabilities.get(id);
  if (staticCapability) return { capability: staticCapability, source: "static" };

  const runtime = (deps.runtimeOverlay.list() as RuntimeProviderCapability[]).find((entry) => entry.id === id);
  if (!runtime) return { capability: undefined, source: "unknown" };

  return {
    capability: {
      id: runtime.id,
      status: "active",
      version: 1,
      // The approval requirement travels as the capability's own `requiresConfirmation`, which is the field
      // the engine already reads for a static tool — so a runtime tool needs no second approval mechanism.
      requiresConfirmation: runtime.approvalRequired === true,
      runtimeProviderId: runtime.providerId,
      risk: runtime.risk,
      approvalRequired: runtime.approvalRequired === true,
      ...(runtime.schemaHash ? { schemaHash: runtime.schemaHash } : {}),
    },
    source: "runtime",
  };
}

/* ---------------------------------------------------------------------------------------------------
 * Snapshot pinning and the replay guard (owner decision 6)
 * ------------------------------------------------------------------------------------------------- */

/**
 * The ExecutionSnapshot source for the runtime manifest. A metadata-only object: hashes, ids, risks and
 * counts — never a schema body, never a tool argument and never a connection endpoint.
 */
export function mcpRuntimeManifestSnapshot(manifest: McpRuntimeManifest): Record<string, unknown> {
  return {
    providerId: manifest.providerId,
    revision: manifest.revision,
    hash: manifest.hash,
    toolCount: manifest.toolCount,
    connectionCount: manifest.connectionCount,
    connections: manifest.connections.map((connection) => ({
      connectionId: connection.connectionId,
      connectionScope: connection.connectionScope,
      toolCount: connection.toolCount,
      schemaHashes: [...connection.schemaHashes].sort(),
    })),
    tools: manifest.tools
      .map((tool) => ({
        id: tool.id,
        schemaHash: tool.schemaHash,
        risk: tool.risk,
        approvalRequired: tool.approvalRequired,
        riskSource: tool.riskSource,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/** Raised when a replay would run against a different runtime MCP tool set than the run recorded. */
export class ReplayRuntimeMcpManifestChangedError extends Error {
  readonly code = "replay_runtime_mcp_manifest_changed";
  readonly httpStatus = 409;
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("Replay refused: the runtime MCP tool set or one of its schemas changed since this run was recorded");
    this.name = "ReplayRuntimeMcpManifestChangedError";
    this.details = details;
  }
}

/**
 * The replay guard. A recorded run pinned a runtime manifest; a replay must run against *that* set, and
 * "the set is different now" has to be a refusal rather than a quiet substitution — otherwise the replay
 * would reproduce a conversation against tools the run never had, and the recording would be evidence of
 * something that never happened.
 *
 * `current === null` means the deployment cannot state the current manifest at all, which is also a refusal:
 * "we could not tell" is not "unchanged" (the same rule the resume-environment check follows).
 */
export function assertReplayRuntimeMcpManifestMatches(input: {
  recorded: Record<string, unknown> | null | undefined;
  current: Record<string, unknown> | null | undefined;
}): { checked: boolean; recordedHash: string | null; currentHash: string | null } {
  const recordedHash = typeof input.recorded?.hash === "string" ? input.recorded.hash : null;
  if (!input.recorded || recordedHash === null) return { checked: false, recordedHash: null, currentHash: null };
  const currentHash = typeof input.current?.hash === "string" ? input.current.hash : null;
  if (currentHash === null) {
    throw new ReplayRuntimeMcpManifestChangedError({
      reason: "runtime_mcp_manifest_unavailable",
      recordedHash,
      recordedRevision: input.recorded.revision ?? null,
    });
  }
  if (currentHash !== recordedHash) {
    throw new ReplayRuntimeMcpManifestChangedError({
      reason: "runtime_mcp_manifest_changed",
      recordedHash,
      currentHash,
      recordedRevision: input.recorded.revision ?? null,
      currentRevision: input.current?.revision ?? null,
      recordedToolCount: input.recorded.toolCount ?? null,
      currentToolCount: input.current?.toolCount ?? null,
    });
  }
  return { checked: true, recordedHash, currentHash };
}
