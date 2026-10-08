import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECURITY_GATE_TESTS } from "../scripts/run-security-gate.mjs";
import {
  LINT_RULES,
  RECORDED_ALLOWANCES,
  evaluateScan,
  loadBaseline,
  runSelfTest,
  scanLintSources,
  scanText,
} from "../scripts/lint-guard.mjs";

/**
 * C14 (hardening): the two gates this step added or repaired are themselves pinned as artifacts.
 *
 * 1. **CI blocks regressions** — the workflow was `workflow_dispatch` only, so *nothing* ran on a push or a
 *    pull request and the acceptance criterion was not true; it also never ran `typecheck:tests` and had no
 *    lint step at all. The checks below read `.github/workflows/ci.yml` as data and pin the contract: the
 *    four triggers, the two path lists being identical, every gate step being present, and **no** step being
 *    able to fail softly. A config file that is never asserted is a config file that quietly loses a step.
 *
 *    What this suite cannot do is *execute* GitHub Actions: it verifies the file statically. The runtime
 *    equivalence is the set of commands the file names, each of which is runnable locally and is exercised by
 *    the security gate (`npm run security-gate`, which runs `tests/coding-agent-c6-eval.test.ts` among its
 *    129 suites at the time C14 was written, and two more after it) — the honest statement is "CI config
 *    verified statically and by running the same commands locally; the real GitHub run was not performed here".
 *
 * 2. **`npm run lint` is not decoration** — the guard must fire on a real violation and stay silent on the
 *    current tree. Both directions are asserted, and the guard's own self-test (every rule fires on its own
 *    violation, stays silent on the neighbouring legal shape) runs inside those assertions rather than being
 *    trusted.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciPath = path.join(workspaceRoot, ".github", "workflows", "ci.yml");
const ciSource = readFileSync(ciPath, "utf8");
const ciLines = ciSource.split(/\r?\n/);

/** Comments are removed first: this file *documents* its invariants, and prose naming a key is not the key. */
function stripComment(line: string): string {
  const match = /(^|\s)#/.exec(line);
  if (!match) return line;
  return line.slice(0, match.index + (match[1] ?? "").length);
}

const ciCode = ciLines.map(stripComment);

/** The block under one top-level `key:` (everything until the next column-0 line). */
function topLevelBlock(lines: readonly string[], key: string): string {
  const start = lines.findIndex((line) => line === key);
  if (start < 0) return "";
  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\S/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/** Every job of a workflow, keyed by its name. */
function jobBlocks(lines: readonly string[]): Record<string, string> {
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  const blocks: Record<string, string> = {};
  if (jobsIndex < 0) return blocks;
  const body = lines.slice(jobsIndex + 1);
  for (let index = 0; index < body.length; index += 1) {
    const match = /^  ([a-z][a-z0-9-]*):$/.exec(body[index] ?? "");
    if (!match) continue;
    const name = match[1] ?? "";
    let end = body.length;
    for (let cursor = index + 1; cursor < body.length; cursor += 1) {
      if (/^  [a-z][a-z0-9-]*:$/.test(body[cursor] ?? "")) {
        end = cursor;
        break;
      }
    }
    blocks[name] = body.slice(index + 1, end).join("\n");
  }
  return blocks;
}

/** The `run:` commands of a workflow, in file order and comment-free. */
function runCommands(lines: readonly string[]): string[] {
  const commands: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:- )?run:\s*(\S.*)$/.exec(line);
    if (match?.[1]) commands.push(match[1].trim());
  }
  return commands;
}

/** The `paths:` entries under one trigger of the `on:` block. */
function triggerPaths(onBlock: string, trigger: string): string[] {
  const lines = onBlock.split("\n");
  const start = lines.findIndex((line) => line === `  ${trigger}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^  \S/.test(line)) break;
    if (/^    [a-z_]+:/.test(line)) {
      if (!line.startsWith("    paths:")) break;
      continue;
    }
    const match = /^      - "(.+)"$/.exec(line);
    if (match?.[1]) out.push(match[1]);
  }
  return out;
}

const onBlock = topLevelBlock(ciCode, "on:");
const blocks = jobBlocks(ciCode);
const commands = runCommands(ciCode);

describe("[C14] [security-gate] the CI workflow runs on changes and blocks regressions", () => {
  it("runs on push, pull_request, a weekly schedule and manual dispatch", () => {
    expect(onBlock).toContain("workflow_dispatch:");
    expect(onBlock).toContain("schedule:");
    expect(onBlock).toContain("push:");
    expect(onBlock).toContain("pull_request:");
    // The weekly run is what keeps the gate honest for a week of docs-only pushes, which the path filter skips.
    expect(/\n    - cron: "\d+ \d+ \* \* \d+"/.test(onBlock)).toBe(true);
  });

  it("filters push and pull_request by the same behaviour-changing paths", () => {
    const pushPaths = triggerPaths(onBlock, "push");
    const pullPaths = triggerPaths(onBlock, "pull_request");
    expect(pushPaths.length).toBeGreaterThan(0);
    expect(pullPaths).toEqual(pushPaths);
    expect(pushPaths).toContain("apps/**");
    expect(pushPaths).toContain("packages/**");
    expect(pushPaths).toContain("tests/**");
    expect(pushPaths).toContain("scripts/**");
    expect(pushPaths).toContain(".github/workflows/**");
  });

  it("runs every gate the acceptance criterion names, including the ones that were missing", () => {
    for (const command of [
      "npm ci",
      "npm run security-gate",
      "npm run typecheck",
      "npm run typecheck:tests",
      "npm run lint",
      "npm run audit:capabilities",
      "npm run audit:sandbox-images",
      // C14 (owner decision 1): the suite is run in full by the quarantine gate, not by a bare `npm test` step —
      // the assertion below pins that this is the *only* test step, so there are not two sources of truth.
      "npm run test:known-failures",
      "npm run build",
      "npm run eval:smoke",
      "npm run gate:upgrade",
    ]) {
      expect(commands).toContain(command);
    }
  });

  it("runs the full suite through the quarantine gate, never through a second, softer step", () => {
    const platform = blocks["platform"] ?? "";
    expect(platform).toContain("run: npm run test:known-failures");
    // A bare `npm test` step beside it would be a second verdict on the same run — and the softer of the two
    // would be the one a reader believes. The quarantine script itself is what invokes vitest.
    expect(commands).not.toContain("npm test");
    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(pkg.scripts["test:known-failures"]).toContain("scripts/check-known-failures.mjs");
    expect(existsSync(path.join(workspaceRoot, "known-failures.json"))).toBe(true);
    // The known-failures step is the *only* place the suite runs: `npm test` stays the plain full-suite command it
    // always was, so a developer's run and CI's run cannot drift into two different definitions.
    expect(pkg.scripts.test).toBe("vitest run");
    // The verdict is kept as evidence even when the step fails.
    expect(platform).toContain("artifacts/known-failures-report.json");
  });

  it("has no step that may fail softly", () => {
    // Any mention in a *code* line (comments are stripped above) fails, because a `continue-on-error` is how a
    // gate becomes advisory without anyone noticing.
    expect(ciCode.filter((line) => /continue-on-error/.test(line))).toEqual([]);
  });

  it("keeps the security-gate job unconditional: no path filter, no if:, its suite list is the contract", () => {
    const gate = blocks["security-gate"] ?? "";
    expect(gate).toContain("run: npm run security-gate");
    expect(gate).not.toContain("continue-on-error");
    expect(/^\s*if:/m.test(gate)).toBe(false);
    expect(/^\s*paths:/m.test(gate)).toBe(false);
  });

  it("runs the eval smoke as its own job, keeps its report as evidence and blocks the release", () => {
    const evals = blocks["evals"] ?? "";
    expect(evals).toContain("run: npm run eval:smoke");
    expect(evals).toContain("artifacts/coding-agent-eval-smoke-report.json");
    // A run that produced no report fails: the report is the evidence, not a nicety.
    expect(evals).toContain("if-no-files-found: error");
    expect(blocks["release-gate"] ?? "").toContain("needs: [platform, docker, evals]");
  });

  it("keeps the eval smoke a hermetic reuse of the existing corpus, not a second runner", () => {
    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(pkg.scripts["eval:smoke"]).toContain("tests/coding-agent-c6-eval.test.ts");
    expect(pkg.scripts["eval:smoke"]).toContain("artifacts/coding-agent-eval-smoke-report.json");
    // No second harness: the corpus suite is still the security-gate suite it always was, and the C14 suites
    // are registered in the same fixed list (a suite that exists but is not listed is a suite nobody runs).
    expect(SECURITY_GATE_TESTS).toContain("tests/coding-agent-c6-eval.test.ts");
    expect(SECURITY_GATE_TESTS).toContain("tests/coding-agent-c14-model-profile-flags.test.ts");
    expect(SECURITY_GATE_TESTS).toContain("tests/coding-agent-c14-ci-and-lint-gates.test.ts");
    expect(new Set(SECURITY_GATE_TESTS).size).toBe(SECURITY_GATE_TESTS.length);
  });
});

describe("[C14] [security-gate] npm run lint is a real guard, not decoration", () => {
  it("is a script that runs the guard and the existing web XSS scan", () => {
    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(pkg.scripts.lint).toContain("scripts/lint-guard.mjs");
    expect(pkg.scripts.lint).toContain("scripts/scan-web-xss.mjs");
    expect(commands).toContain("npm run lint");
    expect(existsSync(path.join(workspaceRoot, "scripts", "lint-guard.mjs"))).toBe(true);
    expect(existsSync(path.join(workspaceRoot, "scripts", "lint-baseline.json"))).toBe(true);
  });

  it("proves its own detector: the self-test passes and every rule fires on its own violation", () => {
    const selfTest = runSelfTest();
    expect(selfTest.failures).toEqual([]);
    expect(selfTest.ok).toBe(true);
    expect(selfTest.checks).toBeGreaterThanOrEqual(LINT_RULES.length);
    expect(LINT_RULES.map((rule) => rule.id).sort()).toEqual([
      "as-any",
      "console-log",
      "focused-or-skipped-test",
      "ts-suppression",
    ]);

    // One real violation per rule, through the same scanner the gate uses.
    expect(scanText("apps/demo/src/new-module.ts", "const value = input as any;").map((finding) => finding.rule))
      .toEqual(["as-any"]);
    expect(scanText("apps/demo/src/new-module.ts", "// @ts-ignore sql text").map((finding) => finding.rule))
      .toEqual(["ts-suppression"]);
    expect(scanText("tests/demo.test.ts", 'describe.only("focused", () => {});').map((finding) => finding.rule))
      .toEqual(["focused-or-skipped-test"]);
    expect(scanText("apps/demo/src/new-module.ts", "console.log('debug');").map((finding) => finding.rule))
      .toEqual(["console-log"]);
    // …and the neighbouring legal shapes stay silent, which is what keeps the guard from being noise.
    expect(scanText("apps/demo/src/new-module.ts", "const value = input as string;\nlogger.log('kept');")).toEqual([]);
    expect(scanText("tests/demo.test.ts", 'it("still runs", () => {});\nconst x = it.skipLater;')).toEqual([]);
  });

  it("fails a cast the baseline does not record, and tolerates one it does", () => {
    const newFile = scanText("apps/demo/src/new-module.ts", "const value = input as any;");
    const unknown = evaluateScan(newFile, { baseline: {} });
    expect(unknown.ok).toBe(false);
    expect(unknown.violations).toHaveLength(1);
    expect(unknown.violations[0]?.detail).toContain("not in scripts/lint-baseline.json");

    // A recorded count is a cap, not a licence: exceeding it fails, staying under it passes.
    const recorded = { "apps/demo/src/new-module.ts": { "as-any": 1 } };
    expect(evaluateScan(scanText("apps/demo/src/new-module.ts", "const value = input as any;"), { baseline: recorded }).ok).toBe(true);
    const growth = evaluateScan(scanText("apps/demo/src/new-module.ts", "const a = b as any;\nconst c = d as any;"), { baseline: recorded });
    expect(growth.ok).toBe(false);
    expect(growth.violations).toHaveLength(1);

    // An unlisted occurrence of an allowance rule fails too, so `npm run lint` is not only about casts.
    const unlisted = evaluateScan(scanText("apps/demo/src/new-module.ts", "console.log('debug');"), { baseline: {} });
    expect(unlisted.ok).toBe(false);
    expect(unlisted.violations).toHaveLength(1);
  });

  it("reads real files: a temp tree with a violation fails, a clean one passes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "npati-lint-guard-"));
    try {
      mkdirSync(path.join(root, "apps", "demo", "src"), { recursive: true });
      writeFileSync(path.join(root, "apps", "demo", "src", "bad.ts"), "export const value = input as any;\n", "utf8");
      writeFileSync(path.join(root, "apps", "demo", "src", "clean.ts"), "export const value: string = String(input);\n", "utf8");
      const scan = scanLintSources(root);
      expect(scan.scannedFiles).toBe(2);
      expect(scan.findings.map((finding) => finding.file)).toEqual(["apps/demo/src/bad.ts"]);
      const verdict = evaluateScan(scan.findings, { baseline: {} });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]?.file).toBe("apps/demo/src/bad.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives no false positive on the repository it guards", () => {
    const baseline = loadBaseline();
    expect(baseline.missing).toBe(false);
    expect(Object.keys(baseline.counts).length).toBeGreaterThan(0);
    const scan = scanLintSources(workspaceRoot);
    expect(scan.scannedFiles).toBeGreaterThan(500);
    const verdict = evaluateScan(scan.findings, { baseline: baseline.counts });
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
    // Every recorded allowance must still match something: a ledger that rots into a blanket permission is how
    // a guard stops meaning anything.
    expect(verdict.allowancesChecked).toBe(RECORDED_ALLOWANCES.length);
  });
});
