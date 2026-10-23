/**
 * Types, baseline constants, and structural comparison helpers for capability catalog auditing.
 */
import type { CapabilityRisk } from "./capabilities";
import type { InspectorReport } from "./capability-inspector";

/**
 * The static baseline this gate pins. A legitimate catalog change updates this one constant (and the
 * baseline assertions in the capability suites); an accidental one — a duplicated id, a capability that
 * only reached one of the three stores — fails here instead of hiding in a printed number.
 *
 * `total = agentCallable + runtimeOnly` is asserted, not assumed: the seed literal's `42 + 264` grew to
 * this value through `push(...)` during C9/C11/C12, which is exactly the change the old gate could not see.
 */
export const STATIC_CATALOG_BASELINE = {
  total: 408,
  agentCallable: 144,
  runtimeOnly: 264,
} as const;

/**
 * Version of `apps/agent-api/src/code-tool-schemas.published.json` (the schema manifest the model-facing
 * tool registry publishes). Pinned here on purpose: a manifest bump is a reviewable event, and
 * `scripts/code-tool-schemas-generate.mjs --manifest-version N` is where it comes from.
 *
 * v14 published `code.data.backend.create` (50 tools). Reviewed before this pin moved: the runtime requires
 * `workspace:write`, evaluates the project data policy before acting, refuses without a recorded approval
 * (`approval_required`), scopes the call to `companyId` + `projectId`, and returns only public SDK identity.
 *
 * v15 published ten tools (60): code.finish, code.image.view, code.preview.screenshot, code.web.fetch,
 * code.web.search and code.data.query.read/rows.seed/migrations.list/policies.inspect/policies.apply. Reviewed:
 * the viewing and web tools reuse Browser QA and the SSRF-validated web-research provider, the data tools call the
 * existing AgentDataStudioService (dev only), and both data writes need a recorded approval unless dryRun.
 */
// v16 retains schema.apply@1 and adds the dev-only, attachment-bound FK schema.apply@2.
export const TOOL_SCHEMA_MANIFEST_VERSION = 16;

export interface CapabilityAuditIssue {
  /** Stable machine-readable code; the negative control asserts on these, never on prose. */
  code: string;
  detail: string;
}

export interface CapabilityAuditResult {
  ok: boolean;
  issues: CapabilityAuditIssue[];
  /** Measured values, so a caller can print what was actually observed instead of a restated constant. */
  facts: Record<string, string | number | boolean>;
}

/* ---------------------------------------------------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------------------------------------------------- */

/** Deterministic JSON: keys sorted, `undefined` folded into `null` so two shapes compare structurally. */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export function duplicates(values: readonly (string | number)[]): Array<string | number> {
  const seen = new Set<string | number>();
  const repeated = new Set<string | number>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/** Values present on exactly one side, sorted — used to compare two stores by identity, not by count. */
export function symmetricDifference(left: readonly string[], right: readonly string[]): string[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const only = new Set<string>();
  for (const value of leftSet) if (!rightSet.has(value)) only.add(value);
  for (const value of rightSet) if (!leftSet.has(value)) only.add(value);
  return [...only].sort();
}

export function summarize(values: readonly (string | number)[], limit = 6): string {
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit ? `${shown}, … (+${values.length - limit} more)` : shown;
}

/** Collector so every check reads as `fail("stable_code", "measured detail")` against its own list. */
export function issueCollector(issues: CapabilityAuditIssue[]): (code: string, detail: string) => void {
  return (code, detail) => {
    issues.push({ code, detail });
  };
}

/* ---------------------------------------------------------------------------------------------------
 * Manifest / Schema Types
 * ------------------------------------------------------------------------------------------------- */

/** One entry of `apps/agent-api/src/code-tool-schemas.published.json`. */
export interface PublishedToolSchemaEntry {
  key: string;
  name: string;
  version: number;
  status: string;
  checksum?: string;
  /** Canonical schema JSON, stored as a string by the generator. */
  canonical: string;
}

export interface PublishedToolSchemaManifest {
  manifestVersion: number;
  checksum?: string;
  tools: PublishedToolSchemaEntry[];
}

/* ---------------------------------------------------------------------------------------------------
 * Runtime Provider Overlay Types
 * ------------------------------------------------------------------------------------------------- */

/**
 * One capability a runtime provider (MCP server, plugin, remote tool host) offers at runtime. These are
 * **never** static catalog entries: they exist only while their provider is connected, so they must never
 * be counted as static capabilities.
 */
export interface RuntimeProviderCapability {
  /** Stable, provider-namespaced id (for example `mcp:filesystem/read_file`). */
  id: string;
  /** Provider identity, for example `mcp:filesystem`. */
  providerId: string;
  name: string;
  agentCallable: boolean;
  risk: CapabilityRisk;
  /** Optional transport/provider origin for display; never a secret and never an instruction. */
  source?: string;
  /**
   * C13 (owner decision 5): the **runtime record** an MCP discovery publishes. All of these are optional so
   * the pre-MCP probe overlay and the null stub keep their shape (and their empty-list hash), while a real
   * runtime tool carries the facts the owner named: the configured connection, the tool name, the schema
   * hash/version, the risk, the approval requirement, the discovery time and the connection scope.
   */
  connectionId?: string;
  toolName?: string;
  /** Hash of the published input schema. A schema change is a new tool contract, therefore a new revision. */
  schemaHash?: string;
  /** The schema version the provider declares, when it declares one (MCP servers usually do not). */
  schemaVersion?: string | number;
  approvalRequired?: boolean;
  /** ISO timestamp of the discovery that produced this record. */
  discoveredAt?: string;
  /** The scope the connection was configured in (for example `company`). */
  connectionScope?: string;
  /** Where `risk` came from: the fail-closed runtime default, or an owner/admin policy override. */
  riskSource?: "runtime_default" | "owner_policy";
}

/**
 * Rule 24 interface: the runtime overlay MCP discovery will implement. `list()` returns what the provider
 * currently offers (empty while nothing is connected), `hash()` is a stable change detector for exactly
 * that list.
 */
export interface RuntimeProviderCapabilityOverlay {
  readonly providerId: string;
  list(): RuntimeProviderCapability[];
  hash(): string;
}

/* ---------------------------------------------------------------------------------------------------
 * Inspector Combined View Types
 * ------------------------------------------------------------------------------------------------- */

export type CapabilitySourceKind = "static-capability-matrix" | "runtime-provider-overlay";

export interface CombinedCapabilitySource {
  kind: CapabilitySourceKind;
  /** Provider id for the overlay source, store name for the static one. */
  id: string;
  label: string;
  count: number;
  agentCallable: number;
}

export interface CombinedCapabilityView {
  counts: {
    staticTotal: number;
    staticAgentCallable: number;
    staticRuntimeOnly: number;
    overlayTotal: number;
    overlayAgentCallable: number;
    combinedTotal: number;
    combinedAgentCallable: number;
  };
  sources: CombinedCapabilitySource[];
  staticItems: InspectorReport["items"];
  overlayItems: RuntimeProviderCapability[];
}

export interface CapabilityCatalogAuditReport {
  ok: boolean;
  staticCatalogIntegrity: CapabilityAuditResult;
  staticManifestParity: CapabilityAuditResult;
  runtimeOverlayIntegrity: CapabilityAuditResult;
  combinedInspectorView: CapabilityAuditResult;
}
