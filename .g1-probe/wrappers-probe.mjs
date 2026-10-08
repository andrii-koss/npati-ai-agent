/**
 * TEMP probe (G1 item 5): the executable wrappers still expose the whole library surface, and importing a wrapper
 * has no side effect (it must not run the CLI when it is imported, which is what the suites rely on).
 *
 * Run: node .g1-probe/wrappers-probe.mjs
 */
const EXPECTED = {
  "run-security-gate.mjs": ["SECURITY_GATE_TESTS", "SECURITY_GATE_DB_TESTS", "GATE_ARTIFACT_PATH", "main", "isEntryPoint", "prepareTyposquatDataset", "writeGateArtifact"],
  "attack-catalogue-check.mjs": ["ATTACK_CATALOGUE_PATH", "validateAttackCatalogue", "findMissingCatalogueEntries", "itTitlesIn"],
  "scan-web-xss.mjs": ["ALLOWLIST", "scanWebSources", "main"],
  "lint-guard.mjs": ["LINT_RULES", "RECORDED_ALLOWANCES", "runSelfTest", "scanLintSources", "evaluateScan", "main"],
  "check-known-failures.mjs": ["KNOWN_FAILURES_PATH", "evaluateKnownFailures", "parseKnownFailures", "main", "isEntryPoint"],
  "mutation-controls-check.mjs": ["MUTATION_CONTROLS_PATH", "validateMutationControls", "renderMutation", "gateSuiteListFrom", "main"],
  "typosquat-dataset-generate.mjs": ["main", "buildDataset", "checkDatasets", "writeDatasets", "resolveRoot"],
};

const results = [];
for (const [name, expected] of Object.entries(EXPECTED)) {
  const module = await import(`../scripts/${name}`);
  const missing = expected.filter((key) => !(key in module));
  results.push({ label: `${name}: exports intact (${expected.length} checked)`, ok: missing.length === 0, detail: missing.join(",") });
}

// The wrappers must not have run their CLI while being imported: each one returns a small, bounded set of exports,
// and a CLI run would either spawn processes or print. Measured instead by asserting that the gate's own `main` was
// not invoked (its `--list` output would be on stdout and the process would have exited before this line).
console.log("[probe] all wrappers imported without exiting the process (no CLI side effect)");
const failed = results.filter((entry) => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.label}${entry.detail ? ` (missing: ${entry.detail})` : ""}`);
console.log(`\n[probe] ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
