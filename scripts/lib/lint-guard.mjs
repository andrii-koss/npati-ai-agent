/**
 * C14: `npm run lint` — the repository's source-invariant lint gate, with **no new dependency**.
 *
 * Why this shape and not ESLint/Prettier/Biome: rule 10 of the project requires a lint step, and the project
 * has no linter configured at all (no config file, no dependency). Adding one would mean a new dependency
 * tree, a new config to maintain and a reformat of the whole repository — a decision for the owner, not a
 * side effect of C14. What can be done *today*, with the tooling the repository already has, is the class of
 * check that catches real defects rather than formatting: the four rules below are the escape hatches and
 * silencers that the project's own rules forbid (`as any`, `@ts-ignore`, `.only`/`.skip`, stray `console.log`).
 * The other half of `npm run lint` is the **existing** XSS source scan (`scripts/scan-web-xss.mjs`), reused
 * rather than re-implemented.
 *
 * Two enforcement mechanisms, because the four rules have two different histories:
 *
 *  1. **Recorded allowances** (`RECORDED_ALLOWANCES`, hand-written below): a file may contain a known number
 *     of a pattern only if an entry here names the file, the rule, the exact count and *why* it is safe. An
 *     unlisted occurrence fails, and one more occurrence than recorded fails, so a new `@ts-ignore` or a
 *     `.only(` cannot enter unnoticed. A recorded allowance that no longer matches anything is reported as
 *     STALE on every run (and does not fail the gate — the same behaviour as `scan-web-xss.mjs`, so paying
 *     down debt never turns the gate red).
 *
 *  2. **A frozen ratchet** for `as any` (`scripts/lint-baseline.json`, machine-generated): the pattern had
 *     ~180 pre-existing occurrences in the production source trees, so a hand-written allowance list
 *     would be a fiction. The baseline freezes the **current** count per file: a new file that contains one,
 *     or an existing file that grows, fails. It is deliberately not a claim that the code is clean — the
 *     ledger is visible debt, and `--update-baseline` re-freezes it while printing the delta.
 *
 * Honesty about limits (this is a line scanner, not a parser): it does not strip string literals or comments,
 * so a pattern quoted inside a fixture string is a hit (which is exactly why the three occurrences in the C9
 * suites are recorded allowances with reasons), and it cannot see through `const escape = "as " + "any"`.
 * It catches the ordinary mistake, which is the class that actually reaches a commit.
 *
 * Usage (through the executable `scripts/lint-guard.mjs`, which owns the shebang and calls `main`):
 *   node scripts/lint-guard.mjs                 # self-test + scan the repository
 *   node scripts/lint-guard.mjs --json          # machine-readable result
 *   node scripts/lint-guard.mjs --root <dir>    # scan another root (used by the suite's temp fixture)
 *   node scripts/lint-guard.mjs --update-baseline   # re-freeze the `as any` ratchet, printing the delta
 *
 * G1 (item 5): this file is the **library** half of `scripts/lint-guard.mjs` and carries no shebang, because a
 * `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to `node:vm` untransformed —
 * which made a gate suite report "no tests at all" in a git worktree.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The frozen `as any` counts. A missing file counts as "nothing is allowed". */
export const BASELINE_PATH = path.resolve(ROOT, "scripts", "lint-baseline.json");

// ---------------------------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------------------------

/** `apps/<app>/src/**` and `packages/<pkg>/src/**` — the production source the project's rules govern. */
export function isSourceFile(relPath) {
  if (typeof relPath !== "string") return false;
  const normalised = relPath.replace(/\\/g, "/");
  if (!/\.(ts|tsx)$/.test(normalised) || normalised.endsWith(".d.ts")) return false;
  if (isTestFile(normalised)) return false;
  return /^(?:apps|packages)\/[^/]+\/src\//.test(normalised);
}

/** A suite, in either layout the repository uses (`tests/**` or a `__tests__` directory). */
export function isTestFile(relPath) {
  if (typeof relPath !== "string") return false;
  const normalised = relPath.replace(/\\/g, "/");
  if (!/\.(ts|tsx)$/.test(normalised) || normalised.endsWith(".d.ts")) return false;
  if (/(^|\/)__tests__\//.test(normalised)) return true;
  return /\.(?:test|spec)\.tsx?$/.test(normalised);
}

/**
 * The rules. `enforcement: "ratchet"` counts against the baseline; `"allowance"` requires a hand-written
 * entry in `RECORDED_ALLOWANCES`. Patterns are per line and non-global (a global regex carries `lastIndex`
 * state between lines, which silently drops matches).
 *
 * `stripLineComments` defaults to true, so prose that merely *names* a pattern does not fail the gate. The
 * `@ts-ignore` rule opts out and anchors on the start of the comment instead: that directive only ever exists
 * inside a comment, so stripping comments would hide the very thing being checked (and anchoring keeps a
 * sentence like `// never add @ts-ignore` from being read as one).
 */
export const LINT_RULES = [
  {
    id: "as-any",
    label: "'as any'",
    pattern: /\bas\s+any\b/,
    scope: isSourceFile,
    enforcement: "ratchet",
    stripLineComments: true,
    detail: "a cast to `any` erases the type instead of fixing it; type the value or use `unknown` plus a narrow",
  },
  {
    id: "ts-suppression",
    label: "@ts-ignore / @ts-expect-error",
    pattern: /^\s*(?:\/\/|\/\*)\s*@ts-(?:ignore|expect-error)\b/,
    scope: isSourceFile,
    enforcement: "allowance",
    stripLineComments: false,
    detail: "a type error must be fixed, not silenced; a genuine limitation needs a recorded allowance with a reason",
  },
  {
    id: "focused-or-skipped-test",
    label: ".only / .skip / .todo in a suite",
    pattern: /\b(?:it|test|describe)\.(?:only|skip|todo)\s*\(/,
    scope: isTestFile,
    enforcement: "allowance",
    stripLineComments: true,
    detail: ".only silently disables every other case in the file and .skip hides a failure; the security gate refuses both",
  },
  {
    id: "console-log",
    label: "console.log in source",
    pattern: /\bconsole\.log\s*\(/,
    scope: isSourceFile,
    enforcement: "allowance",
    stripLineComments: true,
    detail: "a stray debug print in a service is not logging; use the injected logger or delete it",
  },
];

/**
 * Hand-written allowances: file + rule + the **exact** number of matching lines + why it is safe. (A line that
 * contains two matches counts once, exactly like the count the scan reports.)
 *
 * Every entry here is pre-existing debt of the same kind the baseline freezes, but small enough (six lines in
 * four files) that a reason per entry is honest rather than a rubber stamp. Grown counts fail; a recorded
 * allowance that no longer matches anything is reported as STALE.
 */
export const RECORDED_ALLOWANCES = [
  {
    file: "packages/workspace/src/migration-001.ts",
    rule: "ts-suppression",
    occurrences: 1,
    reason: "the leading `@ts-ignore` is required for a `.sql` text import, which TypeScript cannot resolve; the SQL asset is bundled by the Agent API's tsup loader.",
  },
  {
    file: "packages/workspace/src/migration-002.ts",
    rule: "ts-suppression",
    occurrences: 1,
    reason: "same as migration-001: a `.sql` text import with no type declaration, bundled by the tsup loader.",
  },
  {
    file: "packages/workspace/src/migration-003.ts",
    rule: "ts-suppression",
    occurrences: 1,
    reason: "same as migration-001: a `.sql` text import with no type declaration, bundled by the tsup loader.",
  },
  {
    file: "tests/coding-agent-c9-runner-verification.test.ts",
    rule: "focused-or-skipped-test",
    occurrences: 1,
    reason: "the text is a fixture string asserting that the C9 test-integrity guard DETECTS `it.skip(...)`; no test in that file is skipped.",
  },
  {
    file: "tests/coding-agent-c9-test-integrity.test.ts",
    rule: "focused-or-skipped-test",
    occurrences: 2,
    reason: "both are `.replace()` fixture strings that weaken a suite on purpose, so the C9 guard can be shown to flag `.skip` and `.only`; no test in that file is skipped or focused.",
  },
  {
    file: "tests/coding-agent-c14-ci-and-lint-gates.test.ts",
    rule: "focused-or-skipped-test",
    occurrences: 1,
    reason: "the line is the fixture the C14 lint suite feeds to the scanner to prove `.only` IS detected; no test in that file is focused or skipped.",
  },
  {
    file: "apps/agent-api/src/sandbox-egress-enforcement.ts",
    rule: "console-log",
    occurrences: 6,
    reason: "all six are inside the embedded Node probe scripts (DNS/HTTP/TCP) that the sandbox runs to prove egress is blocked; the `console.log(...)` calls execute in the probe process, never on the API host.",
  },
];

// ---------------------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------------------

/** Every `.ts`/`.tsx` file the guard looks at, as repository-relative POSIX paths, sorted. */
export function lintTargets(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === "build" || entry === ".git") continue;
      const full = path.join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, "tests"));
  for (const group of ["apps", "packages"]) {
    let packages;
    try {
      packages = readdirSync(path.join(root, group));
    } catch {
      continue;
    }
    for (const name of packages) walk(path.join(root, group, name, "src"));
  }
  return files.sort();
}

/**
 * One file's hits per rule, with the 1-based line numbers, so a failure names them.
 *
 * `//`-comments are stripped for the rules that opted in, so prose that *names* a forbidden pattern (a
 * comment saying "never write a bare cast" or "do not add a skipped test") is not a violation — the same
 * heuristic `scan-web-xss.mjs` uses: `//` starts a comment only after whitespace or at the start of the line,
 * so `https://` inside a string survives. Block comments and string literals are NOT parsed (documented
 * limit): a pattern quoted inside a fixture string is a hit, which is why the C9 suites' fixture strings are
 * recorded allowances.
 */
export function scanText(relPath, content) {
  const rawLines = String(content).split("\n");
  const strippedLines = rawLines.map((line) => {
    const match = /(^|\s)\/\//.exec(line);
    if (!match) return line;
    return line.slice(0, match.index + match[1].length);
  });
  const findings = [];
  for (const rule of LINT_RULES) {
    if (!rule.scope(relPath)) continue;
    const lines = rule.stripLineComments === false ? rawLines : strippedLines;
    const hitLines = [];
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) hitLines.push(index + 1);
    });
    if (hitLines.length) findings.push({ file: relPath, rule: rule.id, count: hitLines.length, lines: hitLines });
  }
  return findings;
}

export function scanLintSources(root = ROOT) {
  const targets = lintTargets(root);
  const findings = [];
  for (const relPath of targets) {
    let content;
    try {
      content = readFileSync(path.join(root, relPath), "utf8");
    } catch {
      continue;
    }
    findings.push(...scanText(relPath, content));
  }
  return { scannedFiles: targets.length, findings, targets };
}

/** The ratchet counts of a scan, in the exact shape `lint-baseline.json` stores. */
export function baselineFromFindings(findings) {
  const counts = {};
  for (const finding of findings) {
    const rule = LINT_RULES.find((entry) => entry.id === finding.rule);
    if (rule?.enforcement !== "ratchet") continue;
    counts[finding.file] = counts[finding.file] ?? {};
    counts[finding.file][finding.rule] = finding.count;
  }
  return { _readme: BASELINE_README, counts };
}

const BASELINE_README =
  "Frozen `as any` counts per file (C14 lint ratchet). Generated by `node scripts/lint-guard.mjs --update-baseline`; "
  + "a file that grows or a new file that appears fails `npm run lint`. Updating the ledger is a reviewable diff: "
  + "the command prints the delta. This is recorded debt, not a claim that the code is free of casts.";

export function loadBaseline(baselinePath = BASELINE_PATH) {
  if (!existsSync(baselinePath)) return { counts: {}, missing: true };
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
    return { counts: parsed?.counts && typeof parsed.counts === "object" ? parsed.counts : {}, missing: false };
  } catch (error) {
    return { counts: {}, missing: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The verdict. Growth fails; an unlisted occurrence fails; paying debt down is reported as STALE and does not
 * fail (the same choice `scan-web-xss.mjs` made, so a cleanup is never punished by the gate).
 */
export function evaluateScan(findings, options = {}) {
  const baseline = options.baseline ?? {};
  const allowances = options.allowances ?? RECORDED_ALLOWANCES;
  const violations = [];
  const stale = [];
  const checkedAllowances = new Set();

  for (const finding of findings) {
    const rule = LINT_RULES.find((entry) => entry.id === finding.rule);
    if (!rule) continue;
    if (rule.enforcement === "ratchet") {
      const recorded = Number(baseline[finding.file]?.[finding.rule] ?? 0);
      if (finding.count > recorded) {
        const line = finding.lines[recorded] ?? finding.lines[0];
        violations.push({
          file: finding.file,
          line,
          rule: finding.rule,
          detail: recorded === 0
            ? `${rule.label}: not in scripts/lint-baseline.json (${finding.count} occurrence(s)) — ${rule.detail}`
            : `${rule.label}: ${finding.count} occurrence(s) but only ${recorded} recorded — ${rule.detail}`,
        });
        continue;
      }
      if (finding.count < recorded) {
        stale.push({ file: finding.file, rule: finding.rule, recorded, actual: finding.count });
      }
      continue;
    }

    const allowance = allowances.find((entry) => entry.file === finding.file && entry.rule === finding.rule);
    if (!allowance) {
      for (const line of finding.lines) {
        violations.push({
          file: finding.file,
          line,
          rule: finding.rule,
          detail: `${rule.label}: no recorded allowance — ${rule.detail}`,
        });
      }
      continue;
    }
    checkedAllowances.add(`${allowance.file}::${allowance.rule}`);
    if (finding.count > allowance.occurrences) {
      for (const line of finding.lines.slice(allowance.occurrences)) {
        violations.push({
          file: finding.file,
          line,
          rule: finding.rule,
          detail: `${rule.label}: ${finding.count} occurrence(s) but only ${allowance.occurrences} recorded (${allowance.reason})`,
        });
      }
    }
  }

  for (const allowance of allowances) {
    if (!checkedAllowances.has(`${allowance.file}::${allowance.rule}`)) {
      stale.push({ file: allowance.file, rule: allowance.rule, recorded: allowance.occurrences, actual: 0 });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    stale,
    allowancesChecked: checkedAllowances.size,
    allowanceTotal: allowances.length,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------------------------------------

/**
 * Proves the detector is not vacuous: every rule must fire on a line that violates it, and must stay silent
 * on the neighbouring legal shapes (a typed cast, a plain `it(`, a `console.log` inside a suite, a pattern in
 * a file outside the rule's scope). Run on every invocation, so a rule that silently stopped matching — the
 * defect that makes a lint step decorative — cannot pass as green.
 */
export function runSelfTest() {
  const cases = [
    { label: "as any fires", file: "apps/demo/src/a.ts", text: "const value = input as any;", expect: ["as-any"] },
    { label: "as any in a nested cast fires", file: "packages/demo/src/a.ts", text: "return (x as any).y;", expect: ["as-any"] },
    { label: "a typed cast stays silent", file: "apps/demo/src/a.ts", text: "const value = input as unknown as Foo;", expect: [] },
    { label: "a cast split by a block comment is a documented miss", file: "apps/demo/src/a.ts", text: "  const x = y as /* keep */ any;", expect: [] },
    { label: "a hit before a trailing comment still fires", file: "apps/demo/src/a.ts", text: "const x = y as any; // legacy", expect: ["as-any"] },
    { label: "as any in a suite is out of the rule's scope", file: "tests/demo.test.ts", text: "const value = input as any;", expect: [] },
    { label: "@ts-ignore fires", file: "apps/demo/src/a.ts", text: "// @ts-ignore: sql text import", expect: ["ts-suppression"] },
    { label: "@ts-expect-error fires", file: "apps/demo/src/a.ts", text: "/* @ts-expect-error reason */", expect: ["ts-suppression"] },
    { label: "a sentence naming the directive in a comment stays silent", file: "apps/demo/src/a.ts", text: "const x = 1; // never add @ts-ignore here, fix the type", expect: [] },
    { label: "a leading comment that merely mentions it stays silent", file: "apps/demo/src/a.ts", text: "// note: do not silence this with a suppression comment", expect: [] },
    { label: "a suite helper named it.skipLater stays silent", file: "tests/demo.test.ts", text: "const x = it.skipLater;", expect: [] },
    { label: "a skipped case named in a comment stays silent", file: "tests/demo.test.ts", text: "// it.skip('later') would hide this failure", expect: [] },
    { label: "it.skip fires", file: "tests/demo.test.ts", text: 'it.skip("later", () => {});', expect: ["focused-or-skipped-test"] },
    { label: "describe.only fires", file: "tests/demo.test.ts", text: 'describe.only("focus", () => {});', expect: ["focused-or-skipped-test"] },
    { label: "a plain it() stays silent", file: "tests/demo.test.ts", text: 'it("runs", () => {});', expect: [] },
    { label: "a suite helper named it.skipLater stays silent", file: "tests/demo.test.ts", text: "const x = it.skipLater;", expect: [] },
    { label: "console.log in source fires", file: "apps/demo/src/a.ts", text: "console.log(JSON.stringify(value));", expect: ["console-log"] },
    { label: "console.log inside a suite is out of the rule's scope", file: "tests/demo.test.ts", text: "console.log('debug');", expect: [] },
    { label: "a logger call stays silent", file: "apps/demo/src/a.ts", text: "logger.log('kept');", expect: [] },
  ];
  const failures = [];
  for (const testCase of cases) {
    const found = scanText(testCase.file, testCase.text).map((finding) => finding.rule).sort();
    const expected = [...testCase.expect].sort();
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      failures.push(`${testCase.label}: expected [${expected.join(", ") || "nothing"}], found [${found.join(", ") || "nothing"}]`);
    }
  }
  // The rule table itself is part of the contract: an empty or renamed rule list would make the scan vacuous.
  for (const required of ["as-any", "ts-suppression", "focused-or-skipped-test", "console-log"]) {
    if (!LINT_RULES.some((rule) => rule.id === required)) failures.push(`rule '${required}' is missing from LINT_RULES`);
  }
  return { ok: failures.length === 0, checks: cases.length, failures };
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

function formatViolation(violation) {
  return `${violation.file}:${violation.line}: ${violation.rule} — ${violation.detail}`;
}

export function main(argv = process.argv.slice(2)) {
  const selfTest = runSelfTest();
  if (!selfTest.ok) {
    for (const failure of selfTest.failures) process.stdout.write(`[lint] SELF-TEST FAILED: ${failure}\n`);
    process.stdout.write("[lint] the detector itself is broken, so its verdict is not evidence\n");
    return 1;
  }

  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 && argv[rootIndex + 1] ? path.resolve(argv[rootIndex + 1]) : ROOT;
  const baseline = loadBaseline();
  const scan = scanLintSources(root);
  const verdict = evaluateScan(scan.findings, { baseline: baseline.counts });

  if (argv.includes("--update-baseline") || argv.includes("--print-baseline") || argv.includes("--baseline-out")) {
    if (root !== ROOT) {
      process.stdout.write("[lint] --update-baseline only applies to the repository root\n");
      return 1;
    }
    const next = baselineFromFindings(scan.findings);
    if (argv.includes("--print-baseline")) {
      // The same content, without touching the file: a sandboxed or read-only checkout can still see exactly
      // what the ledger would become.
      process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
      return 0;
    }
    const outIndex = argv.indexOf("--baseline-out");
    if (outIndex >= 0) {
      // Writes the ledger somewhere writable (e.g. a sandboxed checkout where `scripts/` is read-only), so the
      // file can be moved into place by the editor that owns the repository.
      const target = argv[outIndex + 1];
      if (!target) {
        process.stdout.write("[lint] --baseline-out needs a path\n");
        return 1;
      }
      writeFileSync(path.resolve(target), `${JSON.stringify(next, null, 2)}\n`, "utf8");
      process.stdout.write(`[lint] baseline written to ${path.resolve(target)} (${Object.keys(next.counts).length} file(s))\n`);
      return 0;
    }
    const delta = [];
    const files = new Set([...Object.keys(baseline.counts), ...Object.keys(next.counts)]);
    for (const file of [...files].sort()) {
      const before = Object.values(baseline.counts[file] ?? {}).reduce((sum, value) => sum + Number(value), 0);
      const after = Object.values(next.counts[file] ?? {}).reduce((sum, value) => sum + Number(value), 0);
      if (before !== after) delta.push(`  ${file}: ${before} -> ${after}`);
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    process.stdout.write(`[lint] baseline rewritten: ${Object.keys(next.counts).length} file(s)\n`);
    for (const line of delta) process.stdout.write(`${line}\n`);
    return 0;
  }

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      ok: verdict.ok,
      root,
      scannedFiles: scan.scannedFiles,
      selfTest: { checks: selfTest.checks, ok: selfTest.ok },
      violations: verdict.violations,
      stale: verdict.stale,
      allowancesChecked: verdict.allowancesChecked,
      allowanceTotal: verdict.allowanceTotal,
      baselineMissing: baseline.missing === true,
    }, null, 2)}\n`);
    return verdict.ok ? 0 : 1;
  }

  process.stdout.write(`[lint] self-test: ${selfTest.checks}/${selfTest.checks} detector case(s) passed\n`);
  process.stdout.write(`[lint] scanned files: ${scan.scannedFiles}\n`);
  process.stdout.write(`[lint] recorded allowances matched: ${verdict.allowancesChecked}/${verdict.allowanceTotal}\n`);
  if (baseline.missing) process.stdout.write("[lint] note: scripts/lint-baseline.json is missing, so every `as any` counts as new\n");
  if (baseline.error) process.stdout.write(`[lint] note: scripts/lint-baseline.json could not be read (${baseline.error}), so every 'as any' counts as new\n`);
  for (const entry of verdict.stale) {
    process.stdout.write(`[lint] STALE: ${entry.file} records ${entry.recorded} ${entry.rule} but ${entry.actual} exist(s) — re-freeze with --update-baseline\n`);
  }
  for (const violation of verdict.violations) process.stdout.write(`[lint] ${formatViolation(violation)}\n`);
  process.stdout.write(verdict.ok ? "[lint] OK\n" : `[lint] FAILED: ${verdict.violations.length} violation(s)\n`);
  return verdict.ok ? 0 : 1;
}
