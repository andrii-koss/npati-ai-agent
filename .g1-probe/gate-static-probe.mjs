/**
 * TEMP probe (G1 item 5): runs the gate library's **pre-vitest** checks exactly as `main()` does, in-process, so
 * the two static guards (attack catalogue, mutation matrix) and the suite-file/duplicate checks are exercised in
 * this session even though vitest cannot start here (sandbox denies pipe stdio).
 *
 * Run: node .g1-probe/gate-static-probe.mjs
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { SECURITY_GATE_TESTS, findMissingSuiteFiles } from "../scripts/lib/run-security-gate.mjs";
import { loadAttackCatalogue, validateAttackCatalogue } from "../scripts/lib/attack-catalogue-check.mjs";
import { loadMutationControls, validateMutationControls } from "../scripts/lib/mutation-controls-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const results = [];
const check = (label, ok, detail = "") => results.push({ label, ok: Boolean(ok), detail });

const missingFiles = findMissingSuiteFiles(ROOT, SECURITY_GATE_TESTS);
check("every configured suite file exists", missingFiles.length === 0, missingFiles.join(","));
check("the suite list has no duplicates", new Set(SECURITY_GATE_TESTS).size === SECURITY_GATE_TESTS.length);
check("the suite list is 151 entries", SECURITY_GATE_TESTS.length === 151);
check("every entry is a tests/*.test.ts path", SECURITY_GATE_TESTS.every((suite) => /^tests\/.+\.test\.ts$/.test(suite) && existsSync(path.join(ROOT, ...suite.split("/")))));

const catalogueState = loadAttackCatalogue(ROOT);
check("the attack catalogue loads", catalogueState.error === null, catalogueState.error ?? "");
if (!catalogueState.error) {
  const verdict = validateAttackCatalogue({ root: ROOT, catalogue: catalogueState.catalogue, suites: SECURITY_GATE_TESTS });
  check(`the attack catalogue validates (rows=${catalogueState.catalogue.classes.length})`, verdict.ok && verdict.issues.length === 0, JSON.stringify(verdict.issues.slice(0, 3)));
}

const mutationState = loadMutationControls(ROOT);
check("the mutation matrix loads", mutationState.error === null, mutationState.error ?? "");
if (!mutationState.error) {
  const verdict = validateMutationControls({ root: ROOT, controls: mutationState.controls, suites: SECURITY_GATE_TESTS });
  check(`the mutation matrix validates (rows=${mutationState.controls.length}, decoy=${verdict.counts.decoy}, cosmetic=${verdict.counts.cosmetic})`, verdict.ok && verdict.issues.length === 0, JSON.stringify(verdict.issues.slice(0, 3)));
}

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`);
console.log(`\n[probe] ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
