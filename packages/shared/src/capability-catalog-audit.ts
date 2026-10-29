/**
 * C13 pre-work: a single, importable auditor for the **resolved** capability catalog.
 *
 * Why this module exists: `scripts/verify-capability-matrix.mjs` and `scripts/upgrade-gate.mjs` used to
 * read the capability inventory with a regex over the base array literal and `eval()` it. That literal is
 * only the inventory's seed (`306 = 42 + 264`) — the catalog grew on C9/C11/C12 through
 * `CAPABILITY_CATALOG.push(...)` / `CAPABILITY_MATRIX.push(...)`, which a regex over the literal can never
 * see. Both gates were green and blind at the same time.
 *
 * The functions below are pure reads of the exported stores (`CAPABILITY_CATALOG`, `CAPABILITY_MATRIX`,
 * `defaultCapabilityRegistry`), so a `push(...)` into any of them is visible here by construction.
 *
 * Four checks, kept separate because they fail for different reasons:
 *   1. `checkStaticCatalogIntegrity`  — exact integrity of the static catalog across its three stores;
 *   2. `checkStaticManifestParity`    — the static catalog's code tools against the published schema manifest;
 *   3. `checkRuntimeOverlayIntegrity` — the runtime provider overlay (today a safe empty stub);
 *   4. `checkCombinedInspectorView`   — the Inspector's static view combined with the runtime overlay.
 *
 * Rule 24 (dependencies forward = interface or safe stub): MCP discovery does not exist yet, so the overlay
 * is an interface plus a null provider that reports zero capabilities and a stable hash. Nothing here
 * implements MCP, discovers providers or adds runtime tools to the static counts.
 *
 * This module is bundled into the web app (`@npati/shared`), so it deliberately imports no Node builtins.
 */
import { CODE_DATA_SCHEMA_APPLY_V1 } from "./code-data-schema-apply-v1";
import { CODE_PREVIEW_SCREENSHOT_V1 } from "./code-preview-screenshot-v1";
import { CAPABILITY_CATALOG } from "./capability-catalog";
import { CAPABILITY_MATRIX, type CapabilityMatrixEntry } from "./capability-matrix";
import { defaultCapabilityRegistry, type CapabilityDefinition } from "./capabilities";
import { CapabilityInspectorService } from "./capability-inspector";
import {
  STATIC_CATALOG_BASELINE,
  TOOL_SCHEMA_MANIFEST_VERSION,
  type CapabilityAuditIssue,
  type CapabilityAuditResult,
  type PublishedToolSchemaManifest,
  type CombinedCapabilityView,
  type CapabilityCatalogAuditReport,
  type RuntimeProviderCapabilityOverlay,
  stableJson,
  duplicates,
  symmetricDifference,
  summarize,
  issueCollector,
} from "./capability-catalog-audit-types";
import {
  defaultRuntimeProviderCapabilityOverlay,
  createRuntimeOverlayProbe,
  hashRuntimeOverlayEntries,
} from "./capability-catalog-audit-overlay";

export * from "./capability-catalog-audit-types";
export * from "./capability-catalog-audit-overlay";

/**
 * The three static stores the gate compares against each other. They are authored separately (the catalog,
 * the inspector's matrix and the registry that the API serves), so parity between them is a real check and
 * not a restatement of one array.
 */
export function resolveStaticCapabilityStores(): {
  catalog: CapabilityDefinition[];
  matrix: CapabilityMatrixEntry[];
  registry: typeof defaultCapabilityRegistry;
} {
  return { catalog: CAPABILITY_CATALOG, matrix: CAPABILITY_MATRIX, registry: defaultCapabilityRegistry };
}

function staticCounts(): { total: number; agentCallable: number; runtimeOnly: number } {
  const total = CAPABILITY_CATALOG.length;
  const agentCallable = CAPABILITY_CATALOG.filter((capability) => capability.agentCallable).length;
  return { total, agentCallable, runtimeOnly: total - agentCallable };
}

/* ---------------------------------------------------------------------------------------------------
 * 1. Static catalog exact integrity
 * ------------------------------------------------------------------------------------------------- */

/**
 * Exact integrity of the static inventory, read from the resolved exports. Every assertion is a comparison
 * between two independently authored stores, so a capability that reaches only one of them fails:
 *   - `CAPABILITY_CATALOG` (the catalog the registry is built from),
 *   - `CAPABILITY_MATRIX` (the inventory the Capability Inspector reads),
 *   - `defaultCapabilityRegistry` (what `GET /capabilities` serves).
 */
export function checkStaticCatalogIntegrity(): CapabilityAuditResult {
  const issues: CapabilityAuditIssue[] = [];
  const fail = issueCollector(issues);
  const { catalog, matrix, registry } = resolveStaticCapabilityStores();

  const catalogIds = catalog.map((capability) => capability.id);
  const matrixIds = matrix.map((entry) => entry.capabilityId);
  const registryList = registry.list();
  const registryCallable = registry.listAgentCallable();
  const registryIds = registryList.map((capability) => capability.id);
  const validation = registry.validate();

  // Counts: three stores must agree, and they must agree with the pinned baseline.
  if (catalog.length !== matrix.length || catalog.length !== registryList.length) {
    fail("static_store_total_divergence", `catalog=${catalog.length} matrix=${matrix.length} registry=${registryList.length}`);
  }
  if (catalog.length !== STATIC_CATALOG_BASELINE.total) {
    fail("static_catalog_total_pin", `catalog=${catalog.length} pinned=${STATIC_CATALOG_BASELINE.total}`);
  }

  // Identity, not just counts: a swap that keeps the length must fail too.
  const catalogVsMatrix = symmetricDifference(catalogIds, matrixIds);
  if (catalogVsMatrix.length > 0) {
    fail("static_catalog_matrix_id_divergence", summarize(catalogVsMatrix));
  }
  const catalogVsRegistry = symmetricDifference(catalogIds, registryIds);
  if (catalogVsRegistry.length > 0) {
    fail("static_catalog_registry_id_divergence", summarize(catalogVsRegistry));
  }
  for (const [code, repeated] of [
    ["static_catalog_duplicate_capability_id", duplicates(catalogIds)],
    ["static_matrix_duplicate_capability_id", duplicates(matrixIds)],
    ["static_registry_duplicate_capability_id", duplicates(registryIds)],
  ] as const) {
    if (repeated.length > 0) fail(code, summarize(repeated));
  }

  // Agent-callable classification: the split must be identical in all three stores.
  const catalogCallable = catalog.filter((capability) => capability.agentCallable);
  const matrixCallable = matrix.filter((entry) => entry.agentCallable);
  if (catalogCallable.length !== STATIC_CATALOG_BASELINE.agentCallable) {
    fail("static_agent_callable_pin", `agentCallable=${catalogCallable.length} pinned=${STATIC_CATALOG_BASELINE.agentCallable}`);
  }
  const runtimeOnly = catalog.length - catalogCallable.length;
  if (runtimeOnly !== STATIC_CATALOG_BASELINE.runtimeOnly) {
    fail("static_runtime_only_pin", `runtimeOnly=${runtimeOnly} pinned=${STATIC_CATALOG_BASELINE.runtimeOnly}`);
  }
  if (matrixCallable.length !== catalogCallable.length) {
    fail("static_catalog_matrix_callable_divergence", `catalog=${catalogCallable.length} matrix=${matrixCallable.length}`);
  }
  if (registryCallable.length !== catalogCallable.length) {
    fail("static_catalog_registry_callable_divergence", `catalog=${catalogCallable.length} registry=${registryCallable.length}`);
  }
  const callableVsMatrix = symmetricDifference(
    catalogCallable.map((capability) => capability.id),
    matrixCallable.map((entry) => entry.capabilityId),
  );
  if (callableVsMatrix.length > 0) {
    fail("static_catalog_matrix_callable_id_divergence", summarize(callableVsMatrix));
  }

  // Safety classification re-checked from the catalog itself (not delegated to the registry result).
  const nonToolCallable = catalogCallable.filter((capability) => capability.type !== "tool");
  if (nonToolCallable.length > 0) {
    fail("static_non_tool_agent_callable", summarize(nonToolCallable.map((capability) => `${capability.id}:${capability.type}`)));
  }

  // Inventory ids: continuous 1..N, unique, in range.
  const inventoryIds = catalog.flatMap((capability) => capability.inventoryIds ?? []);
  const duplicateInventory = duplicates(inventoryIds);
  if (duplicateInventory.length > 0) {
    fail("static_inventory_id_duplicate", summarize(duplicateInventory));
  }
  const inventorySet = new Set(inventoryIds);
  const gaps: number[] = [];
  for (let id = 1; id <= catalog.length; id++) if (!inventorySet.has(id)) gaps.push(id);
  if (gaps.length > 0) {
    fail("static_inventory_id_gap", summarize(gaps));
  }
  const outOfRange = inventoryIds.filter((id) => id < 1 || id > catalog.length);
  if (outOfRange.length > 0) {
    fail("static_inventory_id_out_of_range", summarize(outOfRange));
  }

  // Inventory id <-> matrix id: the matrix entry numbered N must describe the capability that owns N.
  const ownerByInventoryId = new Map<number, string>();
  for (const capability of catalog) {
    for (const id of capability.inventoryIds ?? []) ownerByInventoryId.set(id, capability.id);
  }
  const mappedWrong: string[] = [];
  for (const entry of matrix) {
    const owner = ownerByInventoryId.get(entry.id);
    if (owner === undefined) mappedWrong.push(`#${entry.id}=unowned`);
    else if (owner !== entry.capabilityId) mappedWrong.push(`#${entry.id}: catalog=${owner} matrix=${entry.capabilityId}`);
  }
  if (mappedWrong.length > 0) {
    fail("static_inventory_matrix_id_divergence", summarize(mappedWrong));
  }

  // Every inventory row must own at least one test file (the Inspector's `missing-test` slice is empty).
  const withoutTests = matrix.filter((entry) => !entry.testFiles || entry.testFiles.length === 0);
  if (withoutTests.length > 0) {
    fail("static_missing_test_ownership", summarize(withoutTests.map((entry) => `#${entry.id}`)));
  }

  // The registry's own validator must stay clean; its verdict is part of the gate, not a side note.
  if (validation.errors.length > 0) {
    fail("static_registry_validation_error", summarize(validation.errors));
  }
  if (validation.missingInventoryIds.length > 0) {
    fail("static_registry_missing_inventory", summarize(validation.missingInventoryIds));
  }
  if (validation.duplicateInventoryIds.length > 0) {
    fail("static_registry_duplicate_inventory", summarize(validation.duplicateInventoryIds));
  }
  if (validation.runtimeCallableViolations.length > 0) {
    fail("static_registry_runtime_callable_violation", summarize(validation.runtimeCallableViolations));
  }
  if (validation.totalCapabilities !== catalog.length) {
    fail("static_registry_validation_total_divergence", `registry=${validation.totalCapabilities} catalog=${catalog.length}`);
  }
  if (validation.coveredInventoryCount !== catalog.length) {
    fail("static_registry_inventory_coverage_divergence", `covered=${validation.coveredInventoryCount} catalog=${catalog.length}`);
  }

  const uniqueTestSuites = new Set(matrix.flatMap((entry) => entry.testFiles ?? [])).size;
  return {
    ok: issues.length === 0,
    issues,
    facts: {
      catalogTotal: catalog.length,
      matrixTotal: matrix.length,
      registryTotal: registryList.length,
      agentCallable: catalogCallable.length,
      runtimeOnly,
      matrixAgentCallable: matrixCallable.length,
      registryAgentCallable: registryCallable.length,
      uniqueCapabilityIds: new Set(catalogIds).size,
      inventoryIds: inventoryIds.length,
      uniqueInventoryIds: inventorySet.size,
      uniqueTestSuites,
      registryValidationErrors: validation.errors.length,
    },
  };
}

/* ---------------------------------------------------------------------------------------------------
 * 2. Static manifest / schema parity
 * ------------------------------------------------------------------------------------------------- */



/**
 * Parity between the static catalog and the **published** tool-schema manifest. The manifest is the
 * contract the model-facing tool registry serves; the catalog is the inventory the Inspector and the API
 * read. Both sides describe the same code tools, so a tool added to one and not the other must fail here.
 *
 * Scope: `agentCallable && type === "tool" && domain === "code"` — the tool schemas the manifest publishes.
 * Runtime/ops capabilities are intentionally outside it: they are not model-callable and have no schema.
 */
export function checkStaticManifestParity(
  manifest: PublishedToolSchemaManifest | undefined,
  options: { expectedManifestVersion?: number } = {},
): CapabilityAuditResult {
  const issues: CapabilityAuditIssue[] = [];
  const fail = issueCollector(issues);
  const expectedManifestVersion = options.expectedManifestVersion ?? TOOL_SCHEMA_MANIFEST_VERSION;
  const catalogCodeTools = CAPABILITY_CATALOG.filter(
    (capability) => capability.agentCallable && capability.type === "tool" && capability.domain === "code",
  );

  if (!manifest || !Array.isArray(manifest.tools)) {
    fail("manifest_absent", "the published tool-schema manifest was not provided to the parity check");
    return { ok: false, issues, facts: { catalogCodeTools: catalogCodeTools.length, manifestTools: 0, manifestVersion: 0 } };
  }

  if (manifest.manifestVersion !== expectedManifestVersion) {
    fail("manifest_version_divergence", `manifest=${manifest.manifestVersion} expected=${expectedManifestVersion}`);
  }

  const manifestNames = manifest.tools.map((tool) => tool.name ?? "");
  const duplicateNames = duplicates(manifest.tools.map(tool => `${tool.name}@${tool.version}`));
  if (duplicateNames.length > 0) {
    fail("manifest_duplicate_tool_name", summarize(duplicateNames));
  }

  const catalogByName = new Map(catalogCodeTools.map((capability) => [capability.id, capability]));
  const manifestNameSet = new Set(manifestNames);
  const missingFromCatalog = manifestNames.filter((name) => !catalogByName.has(name));
  if (missingFromCatalog.length > 0) {
    fail("manifest_tool_missing_from_catalog", summarize(missingFromCatalog));
  }
  const missingFromManifest = catalogCodeTools.filter((capability) => !manifestNameSet.has(capability.id)).map((capability) => capability.id);
  if (missingFromManifest.length > 0) {
    fail("catalog_code_tool_missing_from_manifest", summarize(missingFromManifest));
  }

  const matrixStatusByCapabilityId = new Map(CAPABILITY_MATRIX.map((entry) => [entry.capabilityId, entry.status]));
  const keyIssues: string[] = [];
  const versionIssues: string[] = catalogCodeTools
    .filter(capability => !manifest.tools.some(tool => tool.name === capability.id && tool.version === capability.version))
    .map(capability => `${capability.id}: current catalog version ${capability.version} absent from manifest`);
  const canonicalIssues: string[] = [];
  const inputSchemaIssues: string[] = [];
  const outputSchemaIssues: string[] = [];
  const statusIssues: string[] = [];

  for (const tool of manifest.tools) {
    if (tool.key !== `${tool.name}@${tool.version}`) {
      keyIssues.push(`${tool.key} != ${tool.name}@${tool.version}`);
    }
    const current = catalogByName.get(tool.name);
    if (!current) continue;
    // A legacy contract must match an explicitly retained immutable schema, never any arbitrary older version.
    const capability = current.version === tool.version ? current
      : tool.name === CODE_DATA_SCHEMA_APPLY_V1.id && tool.version === CODE_DATA_SCHEMA_APPLY_V1.version
        ? CODE_DATA_SCHEMA_APPLY_V1
        : tool.name === CODE_PREVIEW_SCREENSHOT_V1.id && tool.version === CODE_PREVIEW_SCREENSHOT_V1.version
          ? CODE_PREVIEW_SCREENSHOT_V1 : current;
    if (capability.version !== tool.version) {
      versionIssues.push(`${tool.name}: catalog=${capability.version} manifest=${tool.version}`);
    }
    let canonical: { inputSchema?: unknown; outputSchema?: unknown };
    try {
      canonical = JSON.parse(tool.canonical) as { inputSchema?: unknown; outputSchema?: unknown };
    } catch {
      canonicalIssues.push(tool.name);
      continue;
    }
    if (stableJson(capability.inputSchema) !== stableJson(canonical.inputSchema)) {
      inputSchemaIssues.push(tool.name);
    }
    if (stableJson(capability.outputSchema) !== stableJson(canonical.outputSchema)) {
      outputSchemaIssues.push(tool.name);
    }
    // A published (model-callable) tool must be a verified inventory row, not a not-implemented one.
    const matrixStatus = matrixStatusByCapabilityId.get(tool.name);
    if (matrixStatus !== "VERIFIED_EXISTING") {
      statusIssues.push(`${tool.name}=${matrixStatus ?? "absent"}`);
    }
  }

  if (keyIssues.length > 0) fail("manifest_tool_key_malformed", summarize(keyIssues));
  if (versionIssues.length > 0) fail("manifest_tool_version_divergence", summarize(versionIssues));
  if (canonicalIssues.length > 0) fail("manifest_tool_canonical_unparsable", summarize(canonicalIssues));
  if (inputSchemaIssues.length > 0) fail("manifest_input_schema_divergence", summarize(inputSchemaIssues));
  if (outputSchemaIssues.length > 0) fail("manifest_output_schema_divergence", summarize(outputSchemaIssues));
  if (statusIssues.length > 0) fail("manifest_tool_not_verified_in_matrix", summarize(statusIssues));

  return {
    ok: issues.length === 0,
    issues,
    facts: {
      manifestVersion: manifest.manifestVersion,
      manifestTools: manifest.tools.length,
      catalogCodeTools: catalogCodeTools.length,
      manifestChecksum: manifest.checksum ?? "",
    },
  };
}

/* ---------------------------------------------------------------------------------------------------
 * 3. Runtime provider overlay (interface + safe empty stub)
 * ------------------------------------------------------------------------------------------------- */



/**
 * Integrity of the runtime overlay. Today the overlay must be empty (MCP discovery has not landed), its
 * hash must be stable and recomputable, and the static counts must not depend on it in any way.
 *
 * The static-independence part is measured, not asserted by construction:
 *   - `static_count_changed_by_overlay_read` — reading `list()`/`hash()` must not move the static counts
 *     (an overlay that registered its findings into the static catalog fails here);
 *   - `static_count_reads_overlay` — the combined view's static part must stay identical when a synthetic
 *     probe overlay is injected, so a static count that leaked overlay entries fails here;
 *   - `combined_view_ignores_overlay` — and, symmetrically, the combined total *must* grow by exactly the
 *     probe size, which is what makes the two checks above meaningful rather than vacuous.
 */
export function checkRuntimeOverlayIntegrity(
  overlay: RuntimeProviderCapabilityOverlay = defaultRuntimeProviderCapabilityOverlay,
  options: { expectEmpty?: boolean } = {},
): CapabilityAuditResult {
  const expectEmpty = options.expectEmpty ?? true;
  const issues: CapabilityAuditIssue[] = [];
  const fail = issueCollector(issues);

  const listed = overlay.list();
  const declaredHash = overlay.hash();
  const secondHash = overlay.hash();
  const recomputedHash = hashRuntimeOverlayEntries(listed);

  if (typeof declaredHash !== "string" || declaredHash.trim() === "") {
    fail("runtime_overlay_hash_missing", `provider=${overlay.providerId} hash=${JSON.stringify(declaredHash)}`);
  }
  if (declaredHash !== secondHash) {
    fail("runtime_overlay_hash_unstable", `provider=${overlay.providerId} ${declaredHash} != ${secondHash}`);
  }
  if (declaredHash !== recomputedHash) {
    fail("runtime_overlay_hash_divergence", `declared=${declaredHash} recomputed=${recomputedHash}`);
  }

  const duplicateIds = duplicates(listed.map((entry) => entry.id));
  if (duplicateIds.length > 0) {
    fail("runtime_overlay_duplicate_id", summarize(duplicateIds));
  }

  // An overlay entry may never shadow a static capability id: the two stores stay disjoint.
  const staticIds = new Set(CAPABILITY_CATALOG.map((capability) => capability.id));
  const collisions = listed.filter((entry) => staticIds.has(entry.id)).map((entry) => entry.id);
  if (collisions.length > 0) {
    fail("runtime_overlay_id_collision_with_static_catalog", summarize(collisions));
  }

  if (expectEmpty && listed.length > 0) {
    fail(
      "runtime_overlay_not_empty",
      `provider=${overlay.providerId} reported ${listed.length} runtime capability(ies); MCP discovery is not implemented yet`,
    );
  }

  const before = staticCounts();
  overlay.list();
  overlay.hash();
  const after = staticCounts();
  if (before.total !== after.total || before.agentCallable !== after.agentCallable) {
    fail(
      "static_count_changed_by_overlay_read",
      `before=${before.total}/${before.agentCallable} after=${after.total}/${after.agentCallable}`,
    );
  }

  const probe = createRuntimeOverlayProbe();
  const staticWithOverlay = buildCombinedCapabilityView(overlay).counts;
  const staticWithProbe = buildCombinedCapabilityView(probe).counts;
  if (staticWithOverlay.staticTotal !== staticWithProbe.staticTotal || staticWithOverlay.staticAgentCallable !== staticWithProbe.staticAgentCallable) {
    fail(
      "static_count_reads_overlay",
      `static=${staticWithOverlay.staticTotal}/${staticWithOverlay.staticAgentCallable} with probe overlay=${staticWithProbe.staticTotal}/${staticWithProbe.staticAgentCallable}`,
    );
  }
  const probeSize = probe.list().length;
  if (staticWithProbe.combinedTotal !== staticWithProbe.staticTotal + probeSize) {
    fail(
      "combined_view_ignores_overlay",
      `combined=${staticWithProbe.combinedTotal} static=${staticWithProbe.staticTotal} probe=${probeSize}`,
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    facts: {
      overlayProviderId: overlay.providerId,
      overlayCount: listed.length,
      overlayAgentCallable: listed.filter((entry) => entry.agentCallable).length,
      overlayHash: declaredHash,
      overlayHashStable: declaredHash === secondHash,
      overlayHashRecomputes: declaredHash === recomputedHash,
      overlayExpectedEmpty: expectEmpty,
      staticTotalWithNullOverlay: staticWithOverlay.staticTotal,
      staticTotalWithProbeOverlay: staticWithProbe.staticTotal,
      combinedTotalWithProbeOverlay: staticWithProbe.combinedTotal,
      probeOverlaySize: probeSize,
    },
  };
}

/* ---------------------------------------------------------------------------------------------------
 * 4. Combined Capability Inspector view
 * ------------------------------------------------------------------------------------------------- */



/**
 * Builds the combined view = static Inspector report + runtime overlay. The static items are the real
 * Inspector output, so this cannot drift into a second, hand-rolled inventory.
 */
export function buildCombinedCapabilityView(
  overlay: RuntimeProviderCapabilityOverlay = defaultRuntimeProviderCapabilityOverlay,
  inspector: CapabilityInspectorService = new CapabilityInspectorService(),
): CombinedCapabilityView {
  const report = inspector.inspect("all");
  const staticTotal = report.counts.all;
  const staticAgentCallable = report.counts.agentCallable;
  const overlayItems = overlay.list();
  const overlayAgentCallable = overlayItems.filter((entry) => entry.agentCallable).length;

  return {
    counts: {
      staticTotal,
      staticAgentCallable,
      staticRuntimeOnly: report.counts.runtimeOnly,
      overlayTotal: overlayItems.length,
      overlayAgentCallable,
      combinedTotal: staticTotal + overlayItems.length,
      combinedAgentCallable: staticAgentCallable + overlayAgentCallable,
    },
    sources: [
      {
        kind: "static-capability-matrix",
        id: "capability-matrix",
        label: "Static capability matrix (Capability Inspector)",
        count: staticTotal,
        agentCallable: staticAgentCallable,
      },
      {
        kind: "runtime-provider-overlay",
        id: overlay.providerId,
        label: `Runtime provider overlay (${overlay.providerId})`,
        count: overlayItems.length,
        agentCallable: overlayAgentCallable,
      },
    ],
    staticItems: report.items,
    overlayItems,
  };
}

/**
 * Combined-view check. Asserts that the Inspector still reports the static counts, that the combined view
 * structurally carries **both** sources with their own counts, and that combined == static while the
 * overlay is empty. The probe overlay is what keeps the empty case honest: with it injected, the combined
 * total must grow by exactly the probe size while the Inspector's own counts stay put.
 */
export function checkCombinedInspectorView(
  overlay: RuntimeProviderCapabilityOverlay = defaultRuntimeProviderCapabilityOverlay,
  options: { inspector?: CapabilityInspectorService } = {},
): CapabilityAuditResult {
  const issues: CapabilityAuditIssue[] = [];
  const fail = issueCollector(issues);
  const inspector = options.inspector ?? new CapabilityInspectorService();

  const report = inspector.inspect("all");
  const view = buildCombinedCapabilityView(overlay, inspector);
  const probe = createRuntimeOverlayProbe();
  const probeView = buildCombinedCapabilityView(probe, inspector);
  const probeSize = probe.list().length;

  if (report.counts.all !== STATIC_CATALOG_BASELINE.total) {
    fail("inspector_total_divergence", `inspector=${report.counts.all} pinned=${STATIC_CATALOG_BASELINE.total}`);
  }
  if (report.counts.all !== view.counts.staticTotal) {
    fail("inspector_total_not_combined_static", `inspector=${report.counts.all} combinedStatic=${view.counts.staticTotal}`);
  }
  if (report.counts.agentCallable !== STATIC_CATALOG_BASELINE.agentCallable) {
    fail("inspector_callable_divergence", `inspector=${report.counts.agentCallable} pinned=${STATIC_CATALOG_BASELINE.agentCallable}`);
  }
  if (report.counts.runtimeOnly !== STATIC_CATALOG_BASELINE.runtimeOnly) {
    fail("inspector_runtime_only_divergence", `inspector=${report.counts.runtimeOnly} pinned=${STATIC_CATALOG_BASELINE.runtimeOnly}`);
  }

  // Structural requirement: both sources are present and separately counted.
  const staticSource = view.sources.find((source) => source.kind === "static-capability-matrix");
  const overlaySource = view.sources.find((source) => source.kind === "runtime-provider-overlay");
  if (!staticSource) fail("combined_view_missing_static_source", `sources=${view.sources.map((source) => source.kind).join(",") || "none"}`);
  if (!overlaySource) fail("combined_view_missing_overlay_source", `sources=${view.sources.map((source) => source.kind).join(",") || "none"}`);
  if (view.staticItems.length !== view.counts.staticTotal) {
    fail("combined_view_static_items_truncated", `items=${view.staticItems.length} count=${view.counts.staticTotal}`);
  }
  if (view.overlayItems.length !== view.counts.overlayTotal) {
    fail("combined_view_overlay_items_truncated", `items=${view.overlayItems.length} count=${view.counts.overlayTotal}`);
  }

  // With an empty overlay the combined view must equal the static view.
  if (view.counts.overlayTotal === 0 && view.counts.combinedTotal !== view.counts.staticTotal) {
    fail("combined_total_divergence_on_empty_overlay", `combined=${view.counts.combinedTotal} static=${view.counts.staticTotal}`);
  }
  if (view.counts.combinedTotal !== view.counts.staticTotal + view.counts.overlayTotal) {
    fail("combined_total_divergence", `combined=${view.counts.combinedTotal} static=${view.counts.staticTotal} overlay=${view.counts.overlayTotal}`);
  }
  if (view.counts.combinedAgentCallable !== view.counts.staticAgentCallable + view.counts.overlayAgentCallable) {
    fail(
      "combined_agent_callable_divergence",
      `combined=${view.counts.combinedAgentCallable} static=${view.counts.staticAgentCallable} overlay=${view.counts.overlayAgentCallable}`,
    );
  }

  // Non-vacuity: the overlay is really consumed by the combined view and really ignored by the Inspector.
  if (probeView.counts.combinedTotal !== view.counts.staticTotal + probeSize) {
    fail("combined_view_ignores_overlay", `combined=${probeView.counts.combinedTotal} static=${view.counts.staticTotal} probe=${probeSize}`);
  }
  const probeReport = inspector.inspect("all");
  if (probeReport.counts.all !== report.counts.all || probeReport.counts.agentCallable !== report.counts.agentCallable) {
    fail("inspector_absorbed_overlay", `inspector=${probeReport.counts.all}/${probeReport.counts.agentCallable} vs ${report.counts.all}/${report.counts.agentCallable}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    facts: {
      inspectorAll: report.counts.all,
      inspectorAgentCallable: report.counts.agentCallable,
      inspectorRuntimeOnly: report.counts.runtimeOnly,
      combinedTotal: view.counts.combinedTotal,
      combinedAgentCallable: view.counts.combinedAgentCallable,
      combinedOverlayTotal: view.counts.overlayTotal,
      combinedSources: view.sources.map((source) => `${source.kind}:${source.count}`).join(" | "),
      probeOverlaySize: probeSize,
      combinedTotalWithProbeOverlay: probeView.counts.combinedTotal,
      inspectorAllWithProbeOverlay: probeReport.counts.all,
    },
  };
}

/* ---------------------------------------------------------------------------------------------------
 * Aggregate
 * ------------------------------------------------------------------------------------------------- */



/**
 * Runs the four checks in one call so both gates (`scripts/verify-capability-matrix.mjs` and
 * `scripts/upgrade-gate.mjs`) enforce exactly the same rules. Each check stays individually callable —
 * the negative control in `tests/coding-agent-c13-capability-catalog-audit.test.ts` calls the very same
 * functions while a capability is temporarily pushed into / removed from a store.
 */
export function runCapabilityCatalogChecks(input: {
  manifest: PublishedToolSchemaManifest | undefined;
  overlay?: RuntimeProviderCapabilityOverlay;
  inspector?: CapabilityInspectorService;
  expectedManifestVersion?: number;
  expectOverlayEmpty?: boolean;
}): CapabilityCatalogAuditReport {
  const overlay = input.overlay ?? defaultRuntimeProviderCapabilityOverlay;
  const staticCatalogIntegrity = checkStaticCatalogIntegrity();
  const staticManifestParity = checkStaticManifestParity(input.manifest, {
    ...(input.expectedManifestVersion === undefined ? {} : { expectedManifestVersion: input.expectedManifestVersion }),
  });
  const runtimeOverlayIntegrity = checkRuntimeOverlayIntegrity(overlay, {
    ...(input.expectOverlayEmpty === undefined ? {} : { expectEmpty: input.expectOverlayEmpty }),
  });
  const combinedInspectorView = checkCombinedInspectorView(
    overlay,
    input.inspector === undefined ? {} : { inspector: input.inspector },
  );
  return {
    ok: staticCatalogIntegrity.ok && staticManifestParity.ok && runtimeOverlayIntegrity.ok && combinedInspectorView.ok,
    staticCatalogIntegrity,
    staticManifestParity,
    runtimeOverlayIntegrity,
    combinedInspectorView,
  };
}
