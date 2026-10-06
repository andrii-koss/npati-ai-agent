#!/usr/bin/env node
/**
 * C4a: the mandatory `security-gate` job (SG-1).
 *
 * The rule of the project is that security-gate tests are never skipped and never weakened, so this
 * script runs a **fixed** list of suites and fails when any of them fails *or* reports a skipped test.
 * A suite that silently disappears is a failure too: the list is the contract, not a discovery scan.
 *
 * It also runs the two artifact guards that belong to the same gate:
 *   - `scripts/verify-code-tool-schemas.mjs --check` — a published tool schema may not change silently;
 *   - `scripts/sandbox-image-verify.mjs` — every sandbox image must stay digest-pinned and fresh.
 *
 * Usage: node scripts/run-security-gate.mjs [--list]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The suites that make up the gate. Adding a security-gate suite means adding it here. */
export const SECURITY_GATE_TESTS = [
  "tests/coding-agent-c1c-audit-log.test.ts",
  "tests/coding-agent-c1b-images.test.ts",
  "tests/coding-agent-c1b-image-api.test.ts",
  "tests/coding-agent-c2-read-tools.test.ts",
  "tests/coding-agent-c2-tool-runtime.test.ts",
  "tests/coding-agent-c2-schema-parity.test.ts",
  "tests/coding-agent-c3-write-engine.test.ts",
  "tests/coding-agent-c3-runtime.test.ts",
  "tests/coding-agent-c3-schema-executor-parity.test.ts",
  "tests/coding-agent-c4-classifier.test.ts",
  "tests/coding-agent-c4-shell.test.ts",
  "tests/coding-agent-c4-secret-lease.test.ts",
  "tests/coding-agent-c4-credentials-environment.test.ts",
  "tests/coding-agent-c4-policy-engine.test.ts",
  "tests/coding-agent-c4a-install-policy.test.ts",
  "tests/coding-agent-c4a-classifier.test.ts",
  "tests/coding-agent-c4a-deps-guard.test.ts",
  "tests/coding-agent-c4a-audit-and-secrets.test.ts",
  "tests/coding-agent-c4a-typosquat-dataset.test.ts",
  "tests/coding-agent-c4a-registry-allowlist.test.ts",
  "tests/coding-agent-c4a-capabilities.test.ts",
  "tests/coding-agent-c4a-security-gate.test.ts",
  // C4b: sandbox network policy — activity events, allowlist administration, SSRF client and the
  // consolidated network acceptance list.
  "tests/coding-agent-c4b-network-activity.test.ts",
  "tests/coding-agent-c4b-allowlist.test.ts",
  "tests/coding-agent-c4b-ssrf-client.test.ts",
  "tests/coding-agent-c4b-egress.test.ts",
  "tests/coding-agent-c4b-acceptance.test.ts",
  // C4b: runner readiness endpoint (probe contract, TTL cache, fail-closed) and the separate
  // destination policy applied to webhooks.
  "tests/coding-agent-c4b-readiness.test.ts",
  "tests/coding-agent-c4b-webhook-policy.test.ts",
  // C4b: the provider/runner wiring must expose the same enforcement defaults as the policy module.
  "tests/coding-agent-c4b-allowlist-wiring.test.ts",
  // C5 (SG-2): effective permissions and trust, every approval-bypass attempt, and the structured
  // decision events that make a verdict provable afterwards.
  "tests/coding-agent-c5-approval-scope.test.ts",
  "tests/coding-agent-c5-trust-and-injection.test.ts",
  "tests/coding-agent-c5-capability-groups.test.ts",
  "tests/coding-agent-c5-decision-activity.test.ts",
  "tests/coding-agent-c5-approval-bypass.test.ts",
  // C5a (SG-2): people-side authorization — the RBAC gate, company membership and invites, and the
  // escalation attempts (developer -> full_auto, reviewer -> run, protected-branch pushes).
  "tests/coding-agent-c5a-rbac-foundation.test.ts",
  "tests/coding-agent-c5a-rbac.test.ts",
  "tests/coding-agent-c5a-membership.test.ts",
  "tests/coding-agent-c5a-role-escalation.test.ts",
  // C5a: the decisions that change what a person may do — protected branches (D9), the role -> session
  // mode matrix (D6), membership (D4), project trust (D7), the privileged-permission boundary (D3) and
  // the action -> permission mapping (D11).
  "tests/coding-agent-c5a-protected-branches.test.ts",
  // C5a: production operations (code.prod.operate, step-up/two-person) and the narrow service identity
  // unattended automations run as.
  "tests/coding-agent-c5a-prod-operations.test.ts",
  "tests/coding-agent-c5a-automations-identity.test.ts",
  // C5b (SG-3): provider data policy — private code and secrets must not leave NPATI towards a provider
  // that has no permission for them, and routing must skip (or stop on) providers the policy forbids.
  "tests/coding-agent-c5b-provider-guard.test.ts",
  "tests/coding-agent-c5b-routing-eligibility.test.ts",
  "tests/coding-agent-c5b-policy-resolver.test.ts",
  "tests/coding-agent-c5b-policy-store.test.ts",
  // C6: the chat entry point must choose between chat and the coding agent deterministically (and a
  // disabled agent must not change chat), and the eval harness must prove the real tool path works while a
  // wrong transcript fails.
  "tests/coding-agent-c6-intent-routing.test.ts",
  "tests/coding-agent-c6-eval.test.ts",
  // C6: model profiles (configuration, not code) and the provider tool-call normalisation layer.
  "tests/coding-agent-c6-model-profiles.test.ts",
  "tests/coding-agent-c6-tool-call-adapter.test.ts",
  // C5b: policy administration — who may change what may leave NPATI (owner-level authority, versions,
  // audit before apply, tenant isolation, eligibility reporting).
  "tests/coding-agent-c5b-policy-management.test.ts",
  "tests/coding-agent-c5b-policy-rbac.test.ts",
  // C5b: the non-model outbound channels (web search/fetch/crawl, MCP, email, messaging, webhooks) — a
  // secret is refused for delivery channels and redacted (never sent raw) for retrieval channels, and the
  // transport is asserted never to have been called with the sensitive value.
  "tests/coding-agent-c5b-outbound-guard.test.ts",
  // C6: the agent loop itself. The first suite pins the model/tool contract (policyContext on every call,
  // read-only waves, sequential mutations, truncated arguments never executed, reminders, cancellation,
  // metadata-only Activity); the second pins every stop condition with its reason and summary.
  "tests/coding-agent-c6-runner.test.ts",
  "tests/coding-agent-c6-runner-stop-conditions.test.ts",
];

/**
 * Suites listed above but absent from disk. The list is the contract, so a missing file is reported
 * before vitest is even started: previously that surfaced as a confusing vitest exit code.
 */
export function findMissingSuiteFiles(root, suites) {
  return suites.filter((suite) => !existsSync(path.join(root, suite)));
}

/**
 * Decides whether a vitest JSON report passes the gate. Exported so the rule "a skipped security-gate
 * test fails the job" is unit-testable without spawning vitest.
 */
export function evaluateVitestReport(report) {
  const failures = [];
  const numFailed = Number(report?.numFailedTests ?? report?.numFailedTestSuites ?? 0);
  const numPending = Number(report?.numPendingTests ?? 0);
  const numTodo = Number(report?.numTodoTests ?? 0);
  const numPassed = Number(report?.numPassedTests ?? 0);
  if (!Number.isFinite(numPassed) || numPassed === 0) failures.push("the security-gate run reported no passing tests");
  if (numFailed > 0) failures.push(`${numFailed} security-gate test(s) failed`);
  if (numPending > 0) failures.push(`${numPending} security-gate test(s) were skipped, which rule 12 forbids`);
  if (numTodo > 0) failures.push(`${numTodo} security-gate test(s) are marked todo, which rule 12 forbids`);
  return { ok: failures.length === 0, failures, numPassed, numFailed, numPending, numTodo };
}

/**
 * Normalizes a suite path for comparison: the vitest JSON report carries absolute, Windows-style paths
 * (`D:\\repo\\tests\\x.test.ts`) while the configured list is repository-relative (`tests/x.test.ts`),
 * so both sides are reduced to the suffix starting at `tests/`.
 */
export function suiteKey(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const index = normalized.indexOf("tests/");
  return index >= 0 ? normalized.slice(index) : normalized;
}

/**
 * Every configured suite must actually appear in the report: a mistyped path makes vitest exit non-zero
 * while the remaining suites still pass, which used to end as a bare `FAILED` with no explanation.
 */
export function findMissingSuites(report, expected) {
  const seen = new Set((report?.testResults ?? []).map((entry) => suiteKey(entry?.name ?? entry?.file ?? "")));
  return expected.filter((suite) => !seen.has(suiteKey(suite)));
}

/**
 * Detects suites that appear in the report but ran no assertion at all — the signature of a file that
 * failed to load (an import error surfaces as a suite with zero tests and a non-zero vitest exit).
 */
export function findEmptySuites(report) {
  return (report?.testResults ?? [])
    .filter((entry) => Array.isArray(entry?.assertionResults) && entry.assertionResults.length === 0)
    .map((entry) => suiteKey(entry?.name ?? entry?.file ?? ""));
}

function tail(value, lines = 40) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parts = text.split(/\r?\n/);
  return parts.slice(-lines).join("\n");
}

function runStep(title, scriptRelativePath, args = []) {
  const scriptPath = path.resolve(ROOT, scriptRelativePath);
  process.stdout.write(`\n[security-gate] ${title}: node ${scriptRelativePath} ${args.join(" ")}\n`);
  // Never through a shell: the Node executable path may contain spaces ("C:\Program Files\nodejs"),
  // and a shell would split it, which made the guards look red while they pass when run by hand.
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: ROOT, shell: false, encoding: "utf8", env: process.env });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output) process.stdout.write(`${output}\n`);
  if (result.error) {
    process.stdout.write(`[security-gate] FAILED to start ${scriptRelativePath}: ${result.error.message}\n`);
    return false;
  }
  if (result.status !== 0) {
    process.stdout.write(`[security-gate] FAILED: ${title} exited with ${result.status}\n`);
    return false;
  }
  process.stdout.write(`[security-gate] OK: ${title}\n`);
  return true;
}

/** Prints every failed test with its message, so a red CI run is actionable without a second run. */
export function formatFailedTests(report) {
  const lines = [];
  for (const file of report?.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      if (assertion?.status !== "failed") continue;
      const name = [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean).join(" > ");
      lines.push(`[security-gate] FAILED TEST: ${path.relative(ROOT, String(file.name ?? ""))} > ${name}`);
      for (const message of assertion.failureMessages ?? []) {
        for (const messageLine of String(message).split("\n").slice(0, 12)) {
          lines.push(`[security-gate]     ${messageLine.trim()}`);
        }
      }
    }
  }
  return lines;
}

function main() {
  if (process.argv.includes("--list")) {
    process.stdout.write(`${SECURITY_GATE_TESTS.join("\n")}\n`);
    return 0;
  }

  const reportDir = mkdtempSync(path.join(tmpdir(), "npati-security-gate-"));
  const reportPath = path.join(reportDir, "vitest-report.json");
  const vitestBin = path.resolve(ROOT, "node_modules", "vitest", "vitest.mjs");
  let ok = true;
  // Every configured suite must exist before vitest starts. The list is a contract, so a deleted,
  // renamed or mistyped path fails here with its own message instead of as a bare vitest exit code.
  const missingFiles = findMissingSuiteFiles(ROOT, SECURITY_GATE_TESTS);
  process.stdout.write(
    `\n[security-gate] suite files: present=${SECURITY_GATE_TESTS.length - missingFiles.length} missing=${missingFiles.length}\n`,
  );
  if (missingFiles.length) {
    process.stdout.write(`[security-gate] FAILED: ${missingFiles.length} configured suite file(s) do not exist:\n`);
    for (const suite of missingFiles) process.stdout.write(`[security-gate]   missing file: ${suite}\n`);
    ok = false;
  }
  try {
    process.stdout.write(`\n[security-gate] vitest run (${SECURITY_GATE_TESTS.length} suites)\n`);
    // The local vitest entry point is invoked through the Node binary, so no shell and no `npx`
    // resolution is involved (both were fragile on Windows).
    const vitest = spawnSync(
      process.execPath,
      [vitestBin, "run", ...SECURITY_GATE_TESTS, "--reporter=json", `--outputFile=${reportPath}`],
      { cwd: ROOT, shell: false, encoding: "utf8", env: process.env },
    );
    if (vitest.error) {
      process.stdout.write(`[security-gate] FAILED to start vitest: ${vitest.error.message}\n`);
      ok = false;
    } else {
      const vitestOutput = `${vitest.stdout ?? ""}${vitest.stderr ?? ""}`.trim();
      if (vitestOutput) process.stdout.write(`${vitestOutput}\n`);
      let report = null;
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch (error) {
        process.stdout.write(`[security-gate] FAILED to read the vitest report: ${error instanceof Error ? error.message : String(error)}\n`);
        ok = false;
      }
      if (report) {
        const verdict = evaluateVitestReport(report);
        for (const line of formatFailedTests(report)) process.stdout.write(`${line}\n`);
        for (const failure of verdict.failures) process.stdout.write(`[security-gate] ${failure}\n`);
        process.stdout.write(`[security-gate] tests: passed=${verdict.numPassed} failed=${verdict.numFailed} skipped=${verdict.numPending} todo=${verdict.numTodo}\n`);
        const missing = findMissingSuites(report, SECURITY_GATE_TESTS);
        if (missing.length) {
          process.stdout.write(`[security-gate] FAILED: ${missing.length} configured suite(s) did not run (expected ${SECURITY_GATE_TESTS.length}, saw ${SECURITY_GATE_TESTS.length - missing.length}):\n`);
          for (const suite of missing) process.stdout.write(`[security-gate]   missing: ${suite}\n`);
        }
        if (!verdict.ok || missing.length) ok = false;
        const empty = findEmptySuites(report);
        if (empty.length) {
          process.stdout.write(`[security-gate] FAILED: ${empty.length} suite(s) reported no tests at all (a file that failed to load looks like this):\n`);
          for (const suite of empty) process.stdout.write(`[security-gate]   empty: ${suite}\n`);
          ok = false;
        }
        if (vitest.status !== 0) {
          process.stdout.write(`[security-gate] FAILED: vitest exited with ${vitest.status}${verdict.ok && !missing.length && !empty.length ? " although the report shows no failures (a suite may have failed to load)" : ""}\n`);
          // The raw tail is printed unconditionally so the real cause is visible instead of hypothetical:
          // vitest reports worker load errors on stdout/stderr without counting them as failed tests.
          const rawTail = tail(vitestOutput);
          if (rawTail) {
            process.stdout.write(`[security-gate] vitest output (tail):\n${rawTail}\n`);
          } else {
            process.stdout.write("[security-gate] vitest produced no output at all\n");
          }
          if (vitest.signal) process.stdout.write(`[security-gate] vitest was terminated by signal ${vitest.signal}\n`);
          ok = false;
        }
      }
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }

  // The artifact guards the gate owns, invoked exactly as documented in the runbook.
  ok = runStep("tool schema guard", "scripts/verify-code-tool-schemas.mjs", ["--check"]) && ok;
  ok = runStep("sandbox image guard", "scripts/sandbox-image-verify.mjs") && ok;
  // A stale curated typosquat dataset must fail CI here: otherwise every `code.deps.add` would silently
  // become an approval forever instead of the check being refreshed.
  ok = runStep("typosquat dataset guard", "scripts/typosquat-dataset-generate.mjs", ["--check"]) && ok;

  process.stdout.write(ok ? "\n[security-gate] PASSED\n" : "\n[security-gate] FAILED\n");
  return ok ? 0 : 1;
}

/**
 * The module is imported by `tests/coding-agent-c4a-security-gate.test.ts`, so it must stay free of
 * import-time side effects: nothing but definitions runs at module scope, and `main()` is invoked only
 * when this file is the actual entry point. The comparison is case- and separator-insensitive because
 * Windows paths differ in both, and a mistaken match would recursively run the whole gate from a test.
 */
export function isEntryPoint(argv = process.argv, moduleUrl = import.meta.url) {
  const invoked = argv?.[1];
  if (!invoked) return false;
  try {
    const invokedPath = path.resolve(invoked).replace(/\\/g, "/").toLowerCase();
    const modulePath = path.resolve(fileURLToPath(moduleUrl)).replace(/\\/g, "/").toLowerCase();
    return invokedPath === modulePath;
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exit(main());
