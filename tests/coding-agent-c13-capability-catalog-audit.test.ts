/**
 * C13 pre-work: the capability gates must audit the **resolved** catalog.
 *
 * `scripts/verify-capability-matrix.mjs` and `scripts/upgrade-gate.mjs` used to read the inventory with a
 * regex over the base array literal plus `eval()`. The literal is only the seed (`306 = 42 + 264`); the
 * catalog actually grew on C9/C11/C12 through `CAPABILITY_CATALOG.push(...)` / `CAPABILITY_MATRIX.push(...)`,
 * so both gates were green while blind to exactly the change they exist to catch.
 *
 * Both gates now call `runCapabilityCatalogChecks` from `@npati/shared`, and this suite holds the two
 * things that make that trustworthy:
 *   1. the numbers come from the exported arrays themselves (identity-checked, and they follow a `push`);
 *   2. a **negative control**: a temporary `push(...)` / removal through the same store must fail the very
 *      same parity check that the gate runs, and must be undone afterwards.
 *
 * No MCP feature is implemented here: the runtime overlay is the rule-24 safe stub (zero capabilities).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_MATRIX,
  STATIC_CATALOG_BASELINE,
  buildCombinedCapabilityView,
  checkCombinedInspectorView,
  checkRuntimeOverlayIntegrity,
  checkStaticCatalogIntegrity,
  checkStaticManifestParity,
  createRuntimeOverlayProbe,
  defaultRuntimeProviderCapabilityOverlay,
  hashRuntimeOverlayEntries,
  resolveStaticCapabilityStores,
  runCapabilityCatalogChecks,
  type CapabilityAuditResult,
  type CapabilityDefinition,
  type PublishedToolSchemaManifest,
  type RuntimeProviderCapabilityOverlay,
} from "@npati/shared";

const ROOT = process.cwd();
const GATE_SCRIPTS = ["scripts/verify-capability-matrix.mjs", "scripts/upgrade-gate.mjs"];

function readManifest(): PublishedToolSchemaManifest {
  return JSON.parse(readFileSync(path.join(ROOT, "apps/agent-api/src/code-tool-schemas.published.json"), "utf8")) as PublishedToolSchemaManifest;
}

function codes(result: CapabilityAuditResult): string[] {
  return result.issues.map((issue) => issue.code);
}

/**
 * `CapabilityAuditResult.facts` is `Record<string, string | number | boolean>` (hashes and verdict booleans
 * live in the same bag), so a measured count is not a `number` for the compiler and arithmetic on it is
 * rejected (TS2365/TS18048). This reader narrows by *asserting* the runtime type instead of coercing it:
 * a fact that is not a number fails the test loudly, and the `toBe` assertions below stay exact.
 */
function numericFact(result: CapabilityAuditResult, key: string): number {
  const value = result.facts[key];
  if (typeof value !== "number") throw new Error(`capability audit fact "${key}" is not a number: ${String(value)}`);
  return value;
}

/** A capability that exists nowhere on disk — it only ever lives in a test's `try`/`finally` window. */
function negativeControlCapability(id: string): CapabilityDefinition {
  return {
    id,
    inventoryIds: [9999],
    type: "tool",
    domain: "code",
    name: `C13 negative control ${id}`,
    description: "Temporary capability pushed into the resolved catalog by the C13 negative control.",
    useWhen: ["The negative control needs a capability the static store does not contain."],
    doNotUseWhen: ["Never: this object is removed again in the same test."],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: [],
    version: 1,
  };
}

describe("C13 capability catalog audit — resolved stores, not a regex over the literal", () => {
  it("reads the exported arrays themselves (identity), so a push into them is visible", () => {
    const stores = resolveStaticCapabilityStores();
    expect(stores.catalog).toBe(CAPABILITY_CATALOG);
    expect(stores.matrix).toBe(CAPABILITY_MATRIX);

    const result = checkStaticCatalogIntegrity();
    expect(result.ok).toBe(true);
    // The reported total is the array's length at call time, not a number copied out of the source text.
    expect(result.facts.catalogTotal).toBe(CAPABILITY_CATALOG.length);
    expect(CAPABILITY_CATALOG.length).toBe(STATIC_CATALOG_BASELINE.total);
    expect(result.facts.agentCallable).toBe(STATIC_CATALOG_BASELINE.agentCallable);
    expect(result.facts.runtimeOnly).toBe(STATIC_CATALOG_BASELINE.runtimeOnly);
    // The split is checked on the *measured* facts (narrowed to numbers), not on the pinned constant: a
    // catalog that grew on one side only must fail here.
    expect(numericFact(result, "catalogTotal")).toBe(numericFact(result, "agentCallable") + numericFact(result, "runtimeOnly"));
  });

  it("resolves the four separate checks the gates report", () => {
    const report = runCapabilityCatalogChecks({ manifest: readManifest() });
    expect(report.ok).toBe(true);
    expect(report.staticCatalogIntegrity.ok).toBe(true);
    expect(report.staticManifestParity.ok).toBe(true);
    expect(report.runtimeOverlayIntegrity.ok).toBe(true);
    expect(report.combinedInspectorView.ok).toBe(true);
  });

  it("pins no literal-matcher in either gate script", () => {
    for (const file of GATE_SCRIPTS) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      // The regex/eval reader these gates used; reintroducing it must fail here.
      expect(/CAPABILITY_MATRIX:\s*CapabilityMatrixEntry\[\]\s*=/.test(source)).toBe(false);
      expect(source.includes("loadCapabilityCatalogAudit")).toBe(true);
      expect(source.includes("runCapabilityCatalogChecks")).toBe(true);
    }
  });
});

/**
 * The mandatory negative control. Each case mutates a real store through the documented API
 * (`push` / `pop`), calls the *same* function the gate calls, asserts that it fails for the parity reason
 * (a stable issue code, never prose), and restores the store in `finally`.
 */
describe("C13 negative control — a temporary mutation must fail the same parity check", () => {
  it("fails when a capability is pushed into CAPABILITY_CATALOG and restored afterwards", () => {
    const pushed = negativeControlCapability("c13.audit.negative_control.push");
    CAPABILITY_CATALOG.push(pushed);
    try {
      const result = checkStaticCatalogIntegrity();
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("static_catalog_matrix_id_divergence");
      expect(codes(result)).toContain("static_store_total_divergence");
      // The measured total follows the array: 385 -> 386. A regex over the literal would still say 306/385.
      expect(numericFact(result, "catalogTotal")).toBe(STATIC_CATALOG_BASELINE.total + 1);
      expect(result.facts.catalogTotal).toBe(CAPABILITY_CATALOG.length);

      // The manifest parity check sees the same push, by a different route.
      const parity = checkStaticManifestParity(readManifest());
      expect(parity.ok).toBe(false);
      expect(codes(parity)).toContain("catalog_code_tool_missing_from_manifest");

      // And the aggregate the gates run is red, not a subset of checks.
      expect(runCapabilityCatalogChecks({ manifest: readManifest() }).ok).toBe(false);
    } finally {
      CAPABILITY_CATALOG.pop();
    }
    expect(checkStaticCatalogIntegrity().ok).toBe(true);
    expect(CAPABILITY_CATALOG.length).toBe(STATIC_CATALOG_BASELINE.total);
  });

  it("fails when a capability is temporarily removed from CAPABILITY_CATALOG", () => {
    const removed = CAPABILITY_CATALOG.pop();
    try {
      expect(removed).toBeDefined();
      const result = checkStaticCatalogIntegrity();
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("static_catalog_matrix_id_divergence");
      expect(result.facts.catalogTotal).toBe(STATIC_CATALOG_BASELINE.total - 1);
    } finally {
      if (removed) CAPABILITY_CATALOG.push(removed);
    }
    expect(checkStaticCatalogIntegrity().ok).toBe(true);
    // Restored in place: the same object is back at the same position.
    expect(CAPABILITY_CATALOG.length).toBe(STATIC_CATALOG_BASELINE.total);
  });

  it("fails when a capability is pushed into CAPABILITY_MATRIX and restored afterwards", () => {
    const template = CAPABILITY_MATRIX[CAPABILITY_MATRIX.length - 1];
    expect(template).toBeDefined();
    const pushed = {
      ...(template as (typeof CAPABILITY_MATRIX)[number]),
      id: 9999,
      capabilityId: "c13.audit.negative_control.matrix",
    };
    CAPABILITY_MATRIX.push(pushed);
    try {
      const result = checkStaticCatalogIntegrity();
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("static_catalog_matrix_id_divergence");
      expect(result.facts.matrixTotal).toBe(STATIC_CATALOG_BASELINE.total + 1);
    } finally {
      CAPABILITY_MATRIX.pop();
    }
    expect(checkStaticCatalogIntegrity().ok).toBe(true);
    expect(CAPABILITY_MATRIX.length).toBe(STATIC_CATALOG_BASELINE.total);
  });

  it("fails the combined Inspector view when the matrix it reads grows", () => {
    const template = CAPABILITY_MATRIX[CAPABILITY_MATRIX.length - 1];
    expect(template).toBeDefined();
    CAPABILITY_MATRIX.push({
      ...(template as (typeof CAPABILITY_MATRIX)[number]),
      id: 9999,
      capabilityId: "c13.audit.negative_control.inspector",
    });
    try {
      const result = checkCombinedInspectorView();
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("inspector_total_divergence");
      expect(result.facts.inspectorAll).toBe(STATIC_CATALOG_BASELINE.total + 1);
    } finally {
      CAPABILITY_MATRIX.pop();
    }
    expect(checkCombinedInspectorView().ok).toBe(true);
  });
});

describe("C13 runtime overlay — rule 24 stub, empty today, and never counted as static", () => {
  it("reports zero capabilities with a stable, recomputable hash", () => {
    expect(defaultRuntimeProviderCapabilityOverlay.list().length).toBe(0);
    expect(defaultRuntimeProviderCapabilityOverlay.hash()).toBe(hashRuntimeOverlayEntries([]));
    expect(defaultRuntimeProviderCapabilityOverlay.hash()).toBe(defaultRuntimeProviderCapabilityOverlay.hash());

    const result = checkRuntimeOverlayIntegrity();
    expect(result.ok).toBe(true);
    expect(result.facts.overlayCount).toBe(0);
    expect(result.facts.overlayHashStable).toBe(true);
    expect(result.facts.overlayHashRecomputes).toBe(true);
  });

  it("keeps the static count independent of the overlay, measured with a 3-entry probe overlay", () => {
    const result = checkRuntimeOverlayIntegrity();
    // Same static total with the (empty) runtime overlay and with a synthetic 3-entry overlay injected.
    expect(result.facts.staticTotalWithNullOverlay).toBe(STATIC_CATALOG_BASELINE.total);
    expect(result.facts.staticTotalWithProbeOverlay).toBe(STATIC_CATALOG_BASELINE.total);
    // …while the combined view does grow: the probe is really consumed, so the equality above is not vacuous.
    expect(result.facts.combinedTotalWithProbeOverlay).toBe(STATIC_CATALOG_BASELINE.total + 3);
    expect(result.facts.probeOverlaySize).toBe(3);
  });

  it("is not a pass-by-default check: an empty overlay is required, and integrity is judged separately", () => {
    const probe = createRuntimeOverlayProbe(3);
    // Today's contract (MCP discovery is not implemented): a non-empty overlay fails.
    const strict = checkRuntimeOverlayIntegrity(probe);
    expect(strict.ok).toBe(false);
    expect(codes(strict)).toContain("runtime_overlay_not_empty");
    // The same overlay passes the integrity part when non-emptiness is tolerated — so the two verdicts are
    // genuinely different checks rather than one boolean repeated.
    const tolerated = checkRuntimeOverlayIntegrity(probe, { expectEmpty: false });
    expect(tolerated.ok).toBe(true);
    expect(tolerated.facts.overlayCount).toBe(3);
  });

  it("fails on a divergent hash and on an overlay id that would shadow a static capability", () => {
    const corrupt: RuntimeProviderCapabilityOverlay = {
      providerId: "corrupt-provider",
      list: () => [{ id: "mcp:corrupt/read", providerId: "mcp:corrupt", name: "read", agentCallable: true, risk: "low" }],
      hash: () => "fnv1a64:deadbeefdeadbeef",
    };
    const corrupted = checkRuntimeOverlayIntegrity(corrupt, { expectEmpty: false });
    expect(corrupted.ok).toBe(false);
    expect(codes(corrupted)).toContain("runtime_overlay_hash_divergence");

    const staticId = CAPABILITY_CATALOG[0]?.id ?? "ai.352_ai_providers";
    const shadow: RuntimeProviderCapabilityOverlay = {
      providerId: "shadow-provider",
      list: () => [{ id: staticId, providerId: "shadow-provider", name: "shadow", agentCallable: false, risk: "low" }],
      hash: () => hashRuntimeOverlayEntries([{ id: staticId, providerId: "shadow-provider", name: "shadow", agentCallable: false, risk: "low" }]),
    };
    const shadowed = checkRuntimeOverlayIntegrity(shadow, { expectEmpty: false });
    expect(shadowed.ok).toBe(false);
    expect(codes(shadowed)).toContain("runtime_overlay_id_collision_with_static_catalog");
  });
});

describe("C13 combined Capability Inspector view", () => {
  it("shows both sources, equals the static view while the overlay is empty, and grows with a probe", () => {
    const view = buildCombinedCapabilityView(defaultRuntimeProviderCapabilityOverlay);
    expect(view.counts.staticTotal).toBe(STATIC_CATALOG_BASELINE.total);
    expect(view.counts.combinedTotal).toBe(view.counts.staticTotal);
    expect(view.counts.overlayTotal).toBe(0);
    // Structural: both sources are present with their own identity and count — not one folded into the other.
    expect(view.sources.length).toBe(2);
    const kinds = view.sources.map((source) => source.kind);
    expect(kinds).toContain("static-capability-matrix");
    expect(kinds).toContain("runtime-provider-overlay");
    const overlaySource = view.sources.find((source) => source.kind === "runtime-provider-overlay");
    expect(overlaySource?.count).toBe(0);
    expect(overlaySource?.id).toBe(defaultRuntimeProviderCapabilityOverlay.providerId);
    // The static items are the real Inspector output (all of them), not a second hand-rolled inventory.
    expect(view.staticItems.length).toBe(STATIC_CATALOG_BASELINE.total);
    expect(view.staticItems.length).toBe(view.counts.staticTotal);
    expect(checkCombinedInspectorView().ok).toBe(true);

    // Non-vacuity on a non-empty overlay: combined grows, static does not, the Inspector does not.
    const probeView = buildCombinedCapabilityView(createRuntimeOverlayProbe(4));
    expect(probeView.counts.staticTotal).toBe(STATIC_CATALOG_BASELINE.total);
    expect(probeView.counts.overlayTotal).toBe(4);
    expect(probeView.counts.combinedTotal).toBe(STATIC_CATALOG_BASELINE.total + 4);
    expect(probeView.counts.combinedAgentCallable).toBe(STATIC_CATALOG_BASELINE.agentCallable + 4);
    expect(checkCombinedInspectorView(createRuntimeOverlayProbe(4)).ok).toBe(true);
  });

  it("keeps the checks separate: a catalog-only change fails check 1 while the Inspector check stays green", () => {
    // The Inspector reads `CAPABILITY_MATRIX` (`packages/shared/src/capability-inspector.ts`), so a change
    // that only touches the catalog must fail the static integrity check and *not* be absorbed here. This is
    // the difference between the four checks; a single merged boolean could not tell them apart.
    const last = CAPABILITY_CATALOG.pop();
    try {
      expect(checkStaticCatalogIntegrity().ok).toBe(false);
      expect(checkCombinedInspectorView().ok).toBe(true);
      expect(runCapabilityCatalogChecks({ manifest: readManifest() }).ok).toBe(false);
    } finally {
      if (last) CAPABILITY_CATALOG.push(last);
    }
    expect(checkStaticCatalogIntegrity().ok).toBe(true);
    expect(checkCombinedInspectorView().ok).toBe(true);
  });
});

describe("C13 static manifest / schema parity", () => {
  it("matches the published manifest v9 and its 37 code tools, schema by schema", () => {
    const result = checkStaticManifestParity(readManifest());
    expect(result.ok).toBe(true);
    expect(result.facts.manifestVersion).toBe(13);
    expect(result.facts.manifestTools).toBe(49);
    expect(result.facts.catalogCodeTools).toBe(49);
    expect(result.issues.length).toBe(0);
  });

  it("fails on a manifest version bump that the pinned constant does not know about", () => {
    const manifest = readManifest();
    manifest.manifestVersion = 12;
    const result = checkStaticManifestParity(manifest);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("manifest_version_divergence");
  });

  it("fails when a manifest tool has no catalog entry, and when a published schema is tampered with", () => {
    const ghost = readManifest();
    ghost.tools.push({ key: "code.audit.ghost@1", name: "code.audit.ghost", version: 1, status: "active", canonical: "{}" });
    const ghostResult = checkStaticManifestParity(ghost);
    expect(ghostResult.ok).toBe(false);
    expect(codes(ghostResult)).toContain("manifest_tool_missing_from_catalog");

    const tampered = readManifest();
    const first = tampered.tools[0];
    expect(first).toBeDefined();
    const canonical = JSON.parse((first as { canonical: string }).canonical) as Record<string, unknown>;
    (first as { canonical: string }).canonical = JSON.stringify({ ...canonical, inputSchema: { type: "object", properties: { tampered: { type: "string" } } } });
    const tamperedResult = checkStaticManifestParity(tampered);
    expect(tamperedResult.ok).toBe(false);
    expect(codes(tamperedResult)).toContain("manifest_input_schema_divergence");
  });

  it("fails when the manifest is absent instead of silently passing", () => {
    const result = checkStaticManifestParity(undefined);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("manifest_absent");
  });

  it("negative control: a pushed code tool is missing from the manifest and fails the parity check", () => {
    const pushed = negativeControlCapability("c13.audit.negative_control.manifest");
    CAPABILITY_CATALOG.push(pushed);
    try {
      const result = checkStaticManifestParity(readManifest());
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("catalog_code_tool_missing_from_manifest");
      expect(result.facts.catalogCodeTools).toBe(50);
    } finally {
      CAPABILITY_CATALOG.pop();
    }
    expect(checkStaticManifestParity(readManifest()).ok).toBe(true);
    expect(checkStaticManifestParity(readManifest()).facts.catalogCodeTools).toBe(49);
  });
});
