#!/usr/bin/env node
/**
 * Capability catalog audit (pre-MCP) — resolves the catalog instead of parsing its source text.
 *
 * The previous version matched the base literal of `capability-matrix.ts` with a regex and `eval()`d it.
 * That literal is only the inventory's seed: the catalog grew on C9/C11/C12 through
 * `CAPABILITY_CATALOG.push(...)` / `CAPABILITY_MATRIX.push(...)`, which a regex over the literal cannot see.
 * The gate was green and blind. It now imports the real modules (see `capability-audit-runtime.mjs`) and
 * runs four separate checks:
 *
 *   1. static catalog exact integrity  — catalog ↔ matrix ↔ registry, ids, inventory ids, callable split;
 *   2. static manifest/schema parity   — catalog code tools ↔ `code-tool-schemas.published.json`;
 *   3. runtime overlay integrity       — the runtime provider overlay must be the empty safe stub;
 *   4. combined Inspector view         — Inspector output (static) + overlay, both sources shown.
 *
 * The static catalog never counts runtime overlay (MCP) capabilities: check 3 and 4 measure that
 * independence on every run.
 *
 * Usage: node scripts/verify-capability-matrix.mjs     (exit 0 = every check passed)
 */
import fs from "node:fs";
import path from "node:path";
import {
  SCRIPTS_ROOT,
  ensureTypeScriptTransformRuntime,
  loadCapabilityCatalogAudit,
  printCapabilityAuditReport,
  readPublishedToolSchemaManifest,
} from "./capability-audit-runtime.mjs";

const rootDir = SCRIPTS_ROOT;

// Before the first line of output: a process that cannot import TypeScript re-executes itself once, so the
// audit is printed exactly once by the process that actually ran it.
ensureTypeScriptTransformRuntime();

const audit = await loadCapabilityCatalogAudit();
const { file: manifestFile, manifest } = readPublishedToolSchemaManifest(rootDir);

const report = audit.runCapabilityCatalogChecks({ manifest });
const stores = audit.resolveStaticCapabilityStores();

console.log("==========================================================");
console.log(`  NPATI AGENT — ${stores.catalog.length} CAPABILITY AUDIT & REGRESSION SUITE`);
console.log("  (resolved catalog, no regex/eval of the source literal)");
console.log("==========================================================");
console.log(`  • Catalog source   : packages/shared/src/capability-catalog.ts (imported)`);
console.log(`  • Matrix source    : packages/shared/src/capability-matrix.ts (imported)`);
console.log(`  • Registry source  : defaultCapabilityRegistry (imported, the single instance)`);
console.log(`  • Manifest source  : ${path.relative(rootDir, manifestFile).replace(/\\/g, "/")}`);

console.log("\nCapability audit checks:");
const checksOk = printCapabilityAuditReport(report, (line) => console.log(line));

// 5. Test-file ownership on disk: the matrix maps every inventory row to suites that must exist.
let missingFiles = 0;
const testFileSet = new Set();
for (const entry of stores.matrix) {
  for (const testFile of entry.testFiles ?? []) {
    testFileSet.add(testFile);
    if (!fs.existsSync(path.join(rootDir, testFile))) {
      console.warn(`⚠️ Referenced test file does not exist: ${testFile} (for capability #${entry.id} ${entry.capabilityId})`);
      missingFiles++;
    }
  }
}
console.log("\nTest ownership:");
console.log(`  ✓ Unique Test Suites Mapped: ${testFileSet.size}`);
if (missingFiles > 0) {
  console.error(`  ❌ ${missingFiles} referenced test files are missing from repository!`);
} else {
  console.log("  ✓ Test File Integrity: 100% of referenced test files exist on disk");
}

function breakdown(title, values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  console.log(`\n${title}:`);
  for (const [key, count] of Object.entries(counts)) {
    console.log(`  • ${String(key).padEnd(22)}: ${count}`);
  }
}

breakdown("Capabilities by Domain", stores.matrix.map((entry) => entry.domain));
breakdown("Capabilities by Test Ownership", stores.matrix.map((entry) => entry.testType));
breakdown("Capabilities by Verified Status", stores.matrix.map((entry) => entry.status));

const ok = checksOk && missingFiles === 0;
console.log("==========================================================");
if (ok) {
  console.log("  CAPABILITY CATALOG AUDIT PASSED (4/4 checks, tests on disk)");
  console.log("==========================================================\n");
  process.exit(0);
}
console.error("  CAPABILITY CATALOG AUDIT FAILED (see issues above)");
console.log("==========================================================\n");
process.exit(1);
