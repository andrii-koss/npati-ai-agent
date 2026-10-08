/**
 * G1 probe: the gate-size guard's own logic, run against the edited document.
 *
 * `tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts` is a gate suite, and it reads every place
 * `docs/coding-agent/security-gate-report.md` states the size of the hermetic list. `vitest` cannot run in the
 * agent sandbox (`esbuild` → `spawn EPERM`), so the four claim shapes and the missing-shape rule are copied here
 * **verbatim from that suite** and applied to the real document and the real list. This is a probe, not a
 * substitute: the suite itself is what the owner's escalated run executes.
 */
import { readFileSync } from "node:fs";
import { SECURITY_GATE_TESTS, SECURITY_GATE_DB_TESTS } from "../scripts/run-security-gate.mjs";

const report = readFileSync("docs/coding-agent/security-gate-report.md", "utf8");

const sizeClaims = [];
const missingClaims = [];
const missingShapes = [];
const single = (shape, pattern) => {
  const match = pattern.exec(report);
  if (!match || match[1] === undefined) {
    missingShapes.push(shape);
    return;
  }
  sizeClaims.push({ shape, value: Number(match[1]) });
};
single("canonical sentence (Поточний розмір фіксованого списку гейта)", /Поточний розмір фіксованого списку гейта[^\n]*?\*\*(\d+)\*\*/);
single("`--list` row", /`node scripts\/run-security-gate\.mjs --list`[^\n]*?\*\*(\d+)\*\*/);
for (const match of report.matchAll(/→\s*\*\*(\d+)\*\*/g)) {
  if (match[1] !== undefined) sizeClaims.push({ shape: "bold number after an arrow", value: Number(match[1]) });
}
for (const match of report.matchAll(/suites=(\d+) present=(\d+) missing=(\d+)/g)) {
  if (match[1] !== undefined) sizeClaims.push({ shape: "suites=", value: Number(match[1]) });
  if (match[2] !== undefined) sizeClaims.push({ shape: "present=", value: Number(match[2]) });
  if (match[3] !== undefined) missingClaims.push({ shape: "missing=", value: Number(match[3]) });
}

const gateSize = SECURITY_GATE_TESTS.length;
console.log(`GATE_SIZE (SECURITY_GATE_TESTS) = ${gateSize}`);
console.log(`DB list (SECURITY_GATE_DB_TESTS) = ${SECURITY_GATE_DB_TESTS.length}`);
console.log(`missingShapes = ${JSON.stringify(missingShapes)}`);
console.log(`sizeClaims (${sizeClaims.length}):`);
for (const claim of sizeClaims) console.log(`  ${claim.shape} = ${claim.value}${claim.value === gateSize ? "" : "   <-- MISMATCH"}`);
console.log(`missingClaims = ${JSON.stringify(missingClaims)}`);
const bad = sizeClaims.filter((claim) => claim.value !== gateSize);
console.log(bad.length === 0 && missingShapes.length === 0 && missingClaims.every((claim) => claim.value === 0)
  ? "VERDICT: the document agrees with the hermetic list"
  : `VERDICT: FAILED (${JSON.stringify(bad)})`);
process.exit(bad.length === 0 && missingShapes.length === 0 ? 0 : 1);
