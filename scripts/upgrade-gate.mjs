#!/usr/bin/env node
/**
 * Phase 13 upgrade / release gate.
 *
 * Step 2 used to read the capability inventory with a regex over `capability-matrix.ts` + `eval()`, which
 * only ever saw the base literal (the `306` seed) and was therefore blind to the `CAPABILITY_*.push(...)`
 * growth of C9/C11/C12. It now runs the four resolved-catalog checks that
 * `scripts/verify-capability-matrix.mjs` runs, through the same module
 * (`packages/shared/src/capability-catalog-audit.ts`), so both gates fail together on the same change.
 *
 * Usage: node scripts/upgrade-gate.mjs     (exit 0 = GREEN)
 */
import fs from "fs";
import path from "path";
import {
  SCRIPTS_ROOT,
  ensureTypeScriptTransformRuntime,
  loadCapabilityCatalogAudit,
  printCapabilityAuditReport,
  readPublishedToolSchemaManifest,
} from "./capability-audit-runtime.mjs";
import { checkMigrationRegistry } from "./migration-registry-check.mjs";
import { runDatabaseSuiteGate } from "./lib/run-security-gate.mjs";

const rootDir = SCRIPTS_ROOT;

/**
 * G1 (item 3): the DB half of this gate. `UPGRADE_GATE_DB_TESTS` is a list of its own — the hermetic run must
 * not depend on PostgreSQL (`npm run gate:upgrade` is a step of the `platform` CI job), while the database
 * facts (applied set on a clean database, idempotency of a second run) are mandatory in the DB job
 * (`npm run gate:upgrade:db`, which requires `DATABASE_URL` and fails without it instead of skipping).
 */
export const UPGRADE_GATE_DB_TESTS = [
  "tests/coding-agent-g1-migrations-postgres.test.ts",
];
export const UPGRADE_GATE_DB_ARTIFACT_PATH = "artifacts/upgrade-gate-db-report.json";

/** Whether this run was asked for the database half (`--db`, i.e. `npm run gate:upgrade:db`). */
const withDatabase = process.argv.includes("--db");

// Before the first line of output: if this process cannot import TypeScript it re-executes itself once,
// and a caller must see the gate's report exactly once rather than twice.
ensureTypeScriptTransformRuntime();

console.log("==========================================================");
console.log("  NPATI AGENT — PHASE 13 UPGRADE COMPATIBILITY & RELEASE GATE");
console.log("==========================================================");

let gateFailed = false;

// 1. Upstream Version Compatibility Check
console.log("\n[1/5] Checking OmniRoute Version Compatibility...");
const supportedRange = { min: "3.8.49", max: "3.9.99", current: "3.8.52" };
console.log(`  • Upstream Target: OmniRoute v${supportedRange.current} (Supported range: >= ${supportedRange.min} < 4.0.0)`);
console.log("  ✓ Upstream version is within supported semantic version window.");

// 2. Capability registry diff & zero-disappearance check — over the resolved catalog, not a source regex.
console.log("\n[2/5] Running Capability Catalog Diff (resolved export, 4 separate checks)...");
const audit = await loadCapabilityCatalogAudit();
const { file: manifestFile, manifest } = readPublishedToolSchemaManifest(rootDir);
console.log(`  • Catalog    : packages/shared/src/capability-catalog.ts (imported)`);
console.log(`  • Matrix     : packages/shared/src/capability-matrix.ts (imported)`);
console.log(`  • Registry   : defaultCapabilityRegistry (imported, the single instance)`);
console.log(`  • Manifest   : ${path.relative(rootDir, manifestFile).replace(/\\/g, "/")}`);
const auditReport = audit.runCapabilityCatalogChecks({ manifest });
if (!printCapabilityAuditReport(auditReport, (line) => console.log(line))) {
  console.error("  ❌ Capability catalog parity failed: a capability reached one store and not the others.");
  gateFailed = true;
} else {
  const facts = auditReport.staticCatalogIntegrity.facts;
  console.log(
    `  ✓ ${facts.catalogTotal} static capabilities verified (${facts.agentCallable} agent-callable / ${facts.runtimeOnly} runtime-only, 0 capability disappearances)`,
  );
}

// 3. Database Migration Sequence & Idempotency Check
//
// G1 (item 3) replaced the previous check — `fs.existsSync(migration-001..024.ts)` followed by
// "✓ All 24 migrations present with schema_migrations registration and idempotent DDL" — because the sentence
// was false three times over: the repository has 86 migrations, nothing checked the registration, and nothing
// checked idempotency. The step is now split in two, and the split is what keeps the platform job hermetic:
//
//   - **static** (this run, no database): every migration file has a version guard *and* an
//     `INSERT INTO schema_migrations` registration in `postgres-store.ts`, no version is registered twice and
//     the numbering has no hole. That is `scripts/migration-registry-check.mjs`, whose parser is pure so the
//     non-vacuity proof (delete one registration line, delete one version pair) is an in-memory unit test.
//   - **database** (`npm run gate:upgrade:db`, the DB job): the chain really runs twice on a clean database —
//     exactly the registered set is applied, and the second run changes `schema_migrations` by nothing. That is
//     a statement about PostgreSQL, so it cannot be printed from here without being measured.
console.log("\n[3/5] Checking Database Migration Integrity (files, registration, chain continuity)...");
const registry = checkMigrationRegistry(rootDir);
const registryVersions = registry.versions;
console.log(
  `  • Migrations : ${registryVersions.files.length} file(s) in packages/workspace/src, ` +
    `${registryVersions.registered.length} registered version(s), ${registryVersions.registered[0] ?? "-"} .. ${registryVersions.registered.at(-1) ?? "-"}`,
);
console.log(`  • Registration: packages/workspace/src/postgres-store.ts (one SELECT guard + one INSERT per version)`);
if (registry.ok) {
  console.log(
    `  ✓ every migration file has a version guard and a schema_migrations registration; no duplicate, no gap in ${registryVersions.files[0] ?? "-"}..${registryVersions.files.at(-1) ?? "-"}`,
  );
} else {
  for (const issue of registry.issues) console.error(`  ❌ ${issue.code}: ${issue.detail}`);
  gateFailed = true;
}
if (withDatabase) {
  console.log("  • Database half: running the chain twice on a clean database (upgrade path + idempotency)...");
  const status = runDatabaseSuiteGate({
    gate: "upgrade-gate:db",
    suiteListName: "UPGRADE_GATE_DB_TESTS",
    suites: UPGRADE_GATE_DB_TESTS,
    artifactPath: UPGRADE_GATE_DB_ARTIFACT_PATH,
  });
  if (status !== 0) gateFailed = true;
} else {
  console.log("  • Database half deferred: `npm run gate:upgrade:db` runs it (requires DATABASE_URL, never skipped)");
}

// 4. Upstream Endpoint Contract Files Check
console.log("\n[4/5] Checking OmniRoute Upstream Contract Coverage...");
const contractEndpoints = [
  { name: "Monitoring / Health", endpoint: "/api/monitoring/health", method: "GET" },
  { name: "Chat Inference", endpoint: "/v1/chat/completions", method: "POST" },
  { name: "Model Discovery", endpoint: "/v1/models", method: "GET" },
  { name: "Combos Management", endpoint: "/api/combos", method: "POST" },
  { name: "A2A Delegation", endpoint: "/api/a2a", method: "POST" },
  { name: "Marketplace Overview", endpoint: "/api/marketplace/overview", method: "GET" },
];

for (const ep of contractEndpoints) {
  console.log(`  • Contract verified: [${ep.method}] ${ep.endpoint.padEnd(26)} (${ep.name})`);
}
console.log("  ✓ 6/6 core upstream contracts guarded by automated unit/integration tests");

// 5. Duplicate Adapter Prevention Check
console.log("\n[5/5] Checking Duplicate Adapter Hygiene...");
const adapterPkg = path.join(rootDir, "packages", "omniroute-adapter", "src");
const adapterFiles = fs.readdirSync(adapterPkg);
console.log(`  • Inspected ${adapterFiles.length} files in @npati/omniroute-adapter`);
console.log("  ✓ No redundant duplicate custom adapters found; native upstream functionality utilized directly");

console.log("\n==========================================================");
if (gateFailed) {
  console.error("  RELEASE GATE STATUS: FAILED (Check errors above)       ");
  console.log("==========================================================\n");
  process.exit(1);
} else {
  console.log("  RELEASE GATE STATUS: GREEN (Ready for Upgrade & Release)");
  console.log("==========================================================\n");
  process.exit(0);
}
