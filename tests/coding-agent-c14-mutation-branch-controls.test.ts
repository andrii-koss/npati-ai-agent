import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECURITY_GATE_TESTS } from "../scripts/lib/run-security-gate.mjs";
import {
  IN_MEMORY_CONTROLS_SUITE,
  MUTATION_CONTROLS_PATH,
  locateMutationAnchor,
  loadMutationControls,
  renderMutation,
  validateMutationControls,
} from "../scripts/lib/mutation-controls-check.mjs";
import {
  GATE_IGNORED_RESOURCES,
  MUTATION_ARTIFACT_PATH,
  MUTATION_EVIDENCE_DIRECTORY,
  baselineProblem,
  classifyGateRun,
  declaredSubmodules,
  failedTestsFromArtifact,
  failureTitleMatches,
  isGateRunObservation,
  mirrorResourceDirectory,
  mutationTranscriptPath,
  observeGateRun,
  parseFailureMessages,
  parseGateTranscript,
  parseSuiteLines,
  readGateArtifact,
  writeGateTranscript,
} from "../scripts/security-gate-mutation-branch.mjs";

/**
 * G1 item 3 — the **decoy branch** and the two claims it keeps apart.
 *
 * `tests/coding-agent-c14-gate-mutation-sensitivity.test.ts` neutralises five guards **in memory**: it proves
 * each one is load-bearing inside the seam it exposes, and it never runs the gate. The decoy branch
 * (`scripts/security-gate-mutation-branch.mjs`) makes the *other* claim — that the real
 * `scripts/run-security-gate.mjs` goes red when a guard is deleted from the source and stays green when a line
 * that controls nothing is changed. That claim costs a git worktree and two full gate runs, so it is NOT part
 * of this gate: it is a separate command (`npm run mutation:branch`). What *is* part of the gate is the
 * contract that makes that command honest, and that is what this suite pins:
 *
 *  1. **the matrix resolves** — `docs/coding-agent/mutation-controls.json` against the real files: every anchor
 *     occurs exactly once, every declared failing test exists as `it("…")` in a suite the gate really runs, and
 *     the matrix cannot lose its negative direction (a matrix of only decoys cannot tell "sensitive" from
 *     "fails on anything", and the guard refuses it);
 *  2. **the guard is not vacuous** — fabricated rows (missing file, invented anchor, ambiguous anchor, unknown
 *     suite, unknown title, exit code that contradicts the kind, short rationale, unknown in-memory
 *     counterpart) are each shown to produce their own issue code, while the real matrix is judged clean;
 *  3. **the verdict reader cannot be optimistic** — a gate run that never measured anything (vitest failed to
 *     start, or the artifact records `passed: null`) is classified `environment` whatever its exit code says,
 *     and a decoy that leaves the gate green is `not_caught`. That classification is the only thing standing
 *     between "the suite caught the mutation" and "the sandbox could not run the suite".
 *
 * Honest limits, recorded in `docs/coding-agent/security-gate-report.md`: the gate run itself is not executed
 * here (it needs git, a full worktree and two full gate runs), so this suite proves the *contract* and the
 * *reader*, not the observation. The observation is the runner's output artifact
 * (`artifacts/security-gate-mutation-branch.json`).
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * G1 (item 5): the gate's implementation is the library `scripts/lib/run-security-gate.mjs`; the path
 * `scripts/run-security-gate.mjs` is the thin executable wrapper that owns the shebang. This suite scans the
 * **implementation**, because that is where the guard calls and their order relative to vitest live.
 */
const GATE_SCRIPT_PATH = "scripts/lib/run-security-gate.mjs";
const BRANCH_SUITE_PATH = "tests/coding-agent-c14-mutation-branch-controls.test.ts";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

const matrixState = loadMutationControls(workspaceRoot);
const matrixControls: unknown[] = matrixState.controls;
const matrixVerdict = validateMutationControls({ root: workspaceRoot, controls: matrixControls, suites: SECURITY_GATE_TESTS });

interface MatrixRow {
  id: string;
  kind: string;
  op: string;
  file: string;
  find: string;
  replace: string | null;
  expectedGateExit: number;
  expectedFailingSuite: string | null;
  expectedFailingTest: string | null;
  inMemoryCounterpart: string | null;
  rationale: string;
}

function rowOf(value: unknown): MatrixRow {
  return value as MatrixRow;
}

/** The in-memory control ids the C14 sensitivity suite declares, read from its source. */
function inMemoryControlIds(source: string): string[] {
  const ids: string[] = [];
  for (const match of source.matchAll(/\{\s*id:\s*"([^"]+)",\s*title:/g)) {
    if (match[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

/** A copy of one real row with fields replaced — a fabrication that is never written to disk. */
function fabricated(base: object, overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...overrides };
}

function issueCodes(controls: unknown[]): string[] {
  return validateMutationControls({ root: workspaceRoot, controls, suites: SECURITY_GATE_TESTS }).issues.map((issue) => issue.code);
}

describe("security-gate: G1 — the branch-mutation matrix resolves against the real code", () => {
  it("the real matrix validates, and it declares both directions (decoy rows and a cosmetic row)", () => {
    expect(matrixState.error).toBe(null);
    expect(matrixControls.length).toBeGreaterThanOrEqual(3);
    expect(matrixVerdict.issues).toEqual([]);
    expect(matrixVerdict.ok).toBe(true);
    expect(matrixVerdict.counts.decoy).toBeGreaterThanOrEqual(1);
    expect(matrixVerdict.counts.cosmetic).toBeGreaterThanOrEqual(1);
    expect(MUTATION_CONTROLS_PATH).toBe("docs/coding-agent/mutation-controls.json");
  });

  it("the guard reads the suites from the gate, not from a copy: every declared failing suite is one the gate runs", () => {
    for (const control of matrixControls) {
      const row = rowOf(control);
      if (row.kind !== "decoy") continue;
      expect(SECURITY_GATE_TESTS, row.id).toContain(String(row.expectedFailingSuite));
    }
  });

  it("every row's anchor occurs exactly once, and the rendered file really differs from the original", () => {
    const problems: string[] = [];
    for (const control of matrixControls) {
      const row = rowOf(control);
      const source = readRepoFile(row.file);
      const located = locateMutationAnchor(source, row);
      if (!located.found || located.occurrences !== 1) {
        problems.push(`${row.id}: occurrences=${located.occurrences} in ${row.file}`);
        continue;
      }
      const rendered = renderMutation(source, row);
      if (!rendered.ok || rendered.text === null) problems.push(`${row.id}: render failed (${rendered.error})`);
      else if (rendered.text === source) problems.push(`${row.id}: the rendered file is byte-identical`);
      else if (row.op === "replace" && rendered.text.includes(row.find)) problems.push(`${row.id}: the anchor survived a replace`);
      else if (row.op === "delete_line" && rendered.text.split("\n").length !== source.split("\n").length - 1) {
        problems.push(`${row.id}: delete_line did not remove exactly one line`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the path guard is declared branch-only: the in-memory suite neutralises no path control", () => {
    // The honest split the report records: `normalizeWorkspacePath` has no injection seam, so it is proved by a
    // decoy branch and NOT by an in-memory neutralisation. Both sides are asserted, so neither can drift.
    const traversalRows = matrixControls.map(rowOf).filter((row) => row.kind === "decoy" && row.file === "apps/agent-api/src/code-tools-path.ts");
    expect(traversalRows.length).toBeGreaterThanOrEqual(1);
    for (const row of traversalRows) {
      expect(row.inMemoryCounterpart).toBe(null);
      expect(String(row.expectedFailingSuite)).toBe("tests/coding-agent-c14-redteam-path-and-zip-slip.test.ts");
      expect(row.expectedFailingTest).toBeTruthy();
    }
    const inMemoryIds = inMemoryControlIds(readRepoFile(IN_MEMORY_CONTROLS_SUITE));
    expect(inMemoryIds).toContain("hard_deny_rule.fork_bomb");
    expect(inMemoryIds.filter((id) => /path|workspace/i.test(id))).toEqual([]);
    // …and the row that IS proved in memory says so by naming the control.
    const forkBomb = matrixControls.map(rowOf).find((row) => row.id.includes("fork_bomb"));
    expect(forkBomb).toBeTruthy();
    expect(inMemoryIds).toContain(String(forkBomb?.inMemoryCounterpart));
  });

  it("the gate runs this guard before vitest, and this suite is a member of the gate's fixed list", () => {
    const gateSource = readRepoFile(GATE_SCRIPT_PATH);
    expect(SECURITY_GATE_TESTS).toContain(BRANCH_SUITE_PATH);
    expect(gateSource).toContain("validateMutationControls(");
    expect(gateSource).toContain("loadMutationControls(");
    expect(gateSource).toContain("MUTATION_CONTROLS_PATH");
    const guardAt = gateSource.indexOf("validateMutationControls(");
    const vitestAt = gateSource.indexOf('vitestBin, "run"');
    expect(guardAt).toBeGreaterThan(0);
    expect(vitestAt).toBeGreaterThan(0);
    // A guard that runs *after* vitest would report a matrix defect only when the run is already red for
    // another reason; the ordering is the property, not the presence of the call.
    expect(guardAt).toBeLessThan(vitestAt);
    expect(MUTATION_ARTIFACT_PATH).toBe("artifacts/security-gate-mutation-branch.json");
  });
});

describe("security-gate: G1 — the matrix guard refuses a fabricated row (non-vacuity)", () => {
  it("the real matrix is judged clean by the same validator the fabrications go through", () => {
    expect(issueCodes(matrixControls)).toEqual([]);
  });

  it("a fabricated row is caught — missing file, invented anchor, ambiguous anchor, unknown suite, unknown title, contradictory exit code, short rationale, unknown counterpart", () => {
    const decoyBase = rowOf(matrixControls.find((row) => rowOf(row).kind === "decoy"));
    const cosmeticBase = rowOf(matrixControls.find((row) => rowOf(row).kind === "cosmetic"));
    const decoys = matrixControls.filter((row) => rowOf(row).kind === "decoy");
    const cosmetics = matrixControls.filter((row) => rowOf(row).kind === "cosmetic");
    const cases: { label: string; controls: unknown[]; code: string }[] = [
      {
        label: "missing file",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.missing_file", file: "apps/agent-api/src/not-a-file.ts" }), ...cosmetics],
        code: "mutation_file_missing",
      },
      {
        label: "invented anchor",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.anchor", find: "if (segment === \"nope\") {" }), ...cosmetics],
        code: "mutation_anchor_not_found",
      },
      {
        label: "ambiguous anchor",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.ambiguous", file: "apps/agent-api/src/code-tools-path.ts", op: "replace", find: "const", replace: "let" }), ...cosmetics],
        code: "mutation_anchor_not_unique",
      },
      {
        label: "expected suite outside the gate",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.suite_outside", expectedFailingSuite: "tests/project-import.test.ts" }), ...cosmetics],
        code: "mutation_expected_suite_not_in_gate",
      },
      {
        label: "expected suite file nobody wrote",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.suite_missing", expectedFailingSuite: "tests/nobody-wrote-this.test.ts" }), ...cosmetics],
        code: "mutation_expected_suite_missing",
      },
      {
        label: "unknown title",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.title", expectedFailingTest: "a test nobody wrote" }), ...cosmetics],
        code: "mutation_expected_title_not_found",
      },
      {
        label: "a decoy that expects a green gate",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.exit", expectedGateExit: 0 }), ...cosmetics],
        code: "mutation_expect_gate_exit_mismatch",
      },
      {
        label: "a short rationale",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.rationale", rationale: "trust me" }), ...cosmetics],
        code: "mutation_rationale_too_short",
      },
      {
        label: "an in-memory counterpart nobody declares",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.counterpart", inMemoryCounterpart: "no_such_control" }), ...cosmetics],
        code: "mutation_in_memory_counterpart_unknown",
      },
      {
        label: "a cosmetic row that declares a failing test",
        controls: [...decoys, ...cosmetics, fabricated(cosmeticBase, { id: "fab.cosmetic", expectedFailingSuite: "tests/coding-agent-c14-redteam-path-and-zip-slip.test.ts" })],
        code: "mutation_cosmetic_declares_failure",
      },
      {
        label: "a replace that changes nothing",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.identical", op: "replace", replace: decoyBase.find }), ...cosmetics],
        code: "mutation_replace_identical",
      },
      {
        label: "an unknown op",
        controls: [...decoys, fabricated(decoyBase, { id: "fab.op", op: "rewrite_everything" }), ...cosmetics],
        code: "mutation_op_unknown",
      },
      {
        label: "a duplicated id",
        controls: [decoys[0], decoys[0], ...cosmetics],
        code: "mutation_id_duplicate",
      },
    ];
    const unreported: string[] = [];
    for (const testCase of cases) {
      const codes = issueCodes(testCase.controls);
      if (!codes.includes(testCase.code)) unreported.push(`${testCase.label}: expected ${testCase.code}, saw [${codes.join(", ")}]`);
    }
    expect(unreported).toEqual([]);
  });

  it("the negative direction cannot be dropped: a matrix of only decoys, and one of only cosmetics, are each refused", () => {
    const decoys = matrixControls.filter((row) => rowOf(row).kind === "decoy");
    const cosmetics = matrixControls.filter((row) => rowOf(row).kind === "cosmetic");
    expect(issueCodes(decoys)).toContain("mutation_no_cosmetic_control");
    expect(issueCodes(cosmetics)).toContain("mutation_no_decoy_control");
    expect(issueCodes([])).toContain("mutation_controls_empty");
  });

  it("the anchor reader is measured, not assumed: duplicates, absence and single occurrence are three answers", () => {
    const single = "one\ntwo\nthree\n";
    expect(locateMutationAnchor(single, { find: "two" }).occurrences).toBe(1);
    expect(locateMutationAnchor(single, { find: "two" }).line).toBe(2);
    expect(locateMutationAnchor(single, { find: "seven" }).found).toBe(false);
    expect(locateMutationAnchor(`${single}two\n`, { find: "two" }).occurrences).toBe(2);
    // And the renderer refuses both of the undecidable cases instead of editing one of them.
    expect(renderMutation(single, { op: "replace", find: "seven", replace: "x" }).ok).toBe(false);
    expect(renderMutation(`${single}two\n`, { op: "replace", find: "two", replace: "x" }).ok).toBe(false);
    expect(renderMutation(single, { op: "delete_line", find: "two" }).text).toBe("one\nthree\n");
    expect(renderMutation(single, { op: "replace", find: "two", replace: "x" }).text).toBe("one\nx\nthree\n");
    expect(renderMutation(single, { op: "replace", find: "two" }).ok).toBe(false);
    expect(renderMutation(single, { op: "no_such_op", find: "two", replace: "x" }).ok).toBe(false);
  });
});

describe("security-gate: G1 — a gate run that could not measure is never read as a caught mutation", () => {
  /** A transcript of a gate run that really measured: the totals line is the sentinel. */
  const measuredTranscript = [
    "[security-gate] suite files: present=150 missing=0",
    "[security-gate] vitest run (150 suites)",
    "[security-gate] FAILED TEST: tests/coding-agent-c14-redteam-fork-bomb.test.ts > hard-denies every spelling of a fork bomb",
    "[security-gate] tests: passed=2100 failed=1 skipped=0 todo=0",
    "[security-gate] FAILED",
  ].join("\n");

  it("the reader takes the totals and every failing test out of the transcript, with repository-relative suite keys", () => {
    const parsed = parseGateTranscript(
      [
        "[security-gate] FAILED TEST: D:\\repo\\tests\\a.test.ts > first failure",
        "[security-gate] FAILED TEST: tests/b.test.ts > second failure",
        "[security-gate] tests: passed=7 failed=2 skipped=0 todo=0",
        "[security-gate] FAILED",
      ].join("\n"),
    );
    expect(parsed.measured).toBe(true);
    expect(parsed.tests).toEqual({ passed: 7, failed: 2, skipped: 0, todo: 0 });
    expect(parsed.failedTests).toEqual([
      { file: "tests/a.test.ts", title: "first failure" },
      { file: "tests/b.test.ts", title: "second failure" },
    ]);
    expect(parsed.verdict).toBe("FAILED");
    expect(parseGateTranscript("no sentinel here").measured).toBe(false);
  });

  it("a decoy whose declared test failed is `caught`, and the same run with a green gate is `not_caught`", () => {
    const input = {
      kind: "decoy",
      expectedGateExit: 1,
      expectedFailingSuite: "tests/coding-agent-c14-redteam-fork-bomb.test.ts",
      expectedFailingTest: "hard-denies every spelling of a fork bomb",
      transcript: measuredTranscript,
      artifact: null,
    };
    expect(classifyGateRun({ ...input, status: 1 }).verdict).toBe("caught");
    expect(classifyGateRun({ ...input, status: 1 }).reason).toContain("tests/coding-agent-c14-redteam-fork-bomb.test.ts");
    // The finding the acceptance criterion is about: the gate stayed green on a removed guard.
    expect(classifyGateRun({ ...input, status: 0 }).verdict).toBe("not_caught");
  });

  it("a red gate whose named test did not fail is `wrong_test`, not a proof", () => {
    const verdict = classifyGateRun({
      kind: "decoy",
      expectedGateExit: 1,
      expectedFailingSuite: "tests/coding-agent-c14-redteam-path-and-zip-slip.test.ts",
      expectedFailingTest: "the test the matrix names",
      status: 1,
      transcript: measuredTranscript,
      artifact: null,
    });
    expect(verdict.verdict).toBe("wrong_test");
    expect(verdict.observed.length).toBeGreaterThan(0);
  });

  it("a gate that could not start vitest is `environment`, whatever its exit code says", () => {
    const verdict = classifyGateRun({
      kind: "decoy",
      expectedGateExit: 1,
      expectedFailingSuite: "tests/coding-agent-c14-redteam-fork-bomb.test.ts",
      expectedFailingTest: "hard-denies every spelling of a fork bomb",
      status: 1,
      transcript: "[security-gate] FAILED to start vitest: spawnSync C:\\node.exe EPERM\n[security-gate] FAILED",
      artifact: { ok: false, tests: { passed: null, failed: null, skipped: null, todo: null } },
    });
    expect(verdict.verdict).toBe("environment");
    expect(verdict.measured).toBe(false);
    expect(verdict.reason).toContain("never reported a measurement");
  });

  it("an artifact that records `passed: null` cannot be read as a measurement (the zero is not a number)", () => {
    const verdict = classifyGateRun({
      kind: "decoy",
      expectedGateExit: 1,
      expectedFailingSuite: "tests/x.test.ts",
      expectedFailingTest: "y",
      status: 1,
      transcript: "[security-gate] FAILED",
      artifact: { ok: false, tests: { passed: null, failed: 0, skipped: 0, todo: 0 }, failedTests: ["tests/x.test.ts > y"] },
    });
    expect(verdict.verdict).toBe("environment");
  });

  it("a spawn failure or a killed run is `environment`, and the cosmetic direction is `ok` only when the gate stayed green", () => {
    expect(classifyGateRun({ kind: "decoy", status: null, spawnError: "spawnSync node EPERM", transcript: "" }).verdict).toBe("environment");
    expect(classifyGateRun({ kind: "decoy", status: null, signal: "SIGTERM", transcript: measuredTranscript }).verdict).toBe("environment");
    const cosmetic = {
      kind: "cosmetic",
      expectedGateExit: 0,
      transcript: "[security-gate] tests: passed=2107 failed=0 skipped=0 todo=0\n[security-gate] PASSED",
    };
    expect(classifyGateRun({ ...cosmetic, status: 0 }).verdict).toBe("ok");
    expect(classifyGateRun({ ...cosmetic, status: 1 }).verdict).toBe("unexpected_failure");
  });

  it("the submodule parser reads `.gitmodules` as data, so a worktree cannot silently lose a checked-out submodule", () => {
    // `git worktree add` does not materialise submodules; the runner junctions each declared path instead. The
    // parser is what decides which paths those are, so it is measured rather than trusted.
    const fixture = [
      '[submodule "vendor/omniroute"]',
      "\tpath = vendor/omniroute",
      "\turl = https://example.com/OmniRoute.git",
      "\tignore = untracked",
      '[submodule "vendor/second"]',
      "\tpath = vendor/second",
      "\turl = https://example.com/second.git",
    ].join("\n");
    expect(declaredSubmodules(fixture)).toEqual(["vendor/omniroute", "vendor/second"]);
    expect(declaredSubmodules("")).toEqual([]);
    expect(declaredSubmodules("# path = not-a-submodule")).toEqual([]);
  });

  it("the artifact reader parses what the gate wrote, and reports an absent or corrupt artifact as absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "npati-mutation-artifact-"));
    try {
      expect(readGateArtifact(root)).toBe(null);
      const directory = path.join(root, "artifacts");
      writeFileSync(path.join(root, "artifacts"), "not a directory\n", "utf8");
      expect(readGateArtifact(root)).toBe(null);
      rmSync(path.join(root, "artifacts"), { force: true });
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "security-gate-report.json"), JSON.stringify({ ok: false, tests: { passed: 1, failed: 2 }, failedTests: [] }), "utf8");
      expect(readGateArtifact(root)).toMatchObject({ ok: false });
      expect(failedTestsFromArtifact({ failedTests: ["D:\\repo\\tests\\a.test.ts > a failure", "tests/b.test.ts > b failure"] })).toEqual([
        { file: "tests/a.test.ts", title: "a failure" },
        { file: "tests/b.test.ts", title: "b failure" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The baseline and the title comparison: the two defects the first escalated run of the runner exposed.
 *
 * That run produced `wrong_test` for a mutation the gate really caught (the matrix stores the bare `it("…")`
 * title, the gate reports `describe > … > it`), and `unexpected_failure` for the **cosmetic** control because
 * the worktree was missing the `.gitignore`d resources the gate reads, so the gate was red before any mutation
 * was applied. Both are pinned here as behaviour, not as prose.
 */
describe("security-gate: G1 — a row is judged against a baseline of the same gate, not against exit code 0", () => {
  /** A gate run that really measured and failed on one test, in the shape the gate prints it. */
  const measuredTranscript = [
    "[security-gate] FAILED TEST: tests/coding-agent-c14-redteam-fork-bomb.test.ts > security-gate: C14 red-team — fork bomb > hard-denies every spelling of a fork bomb, including the multi-line one the rule used to miss",
    "[security-gate]     AssertionError: expected 'approval' to be 'hard_deny'",
    "[security-gate] tests: passed=2100 failed=1 skipped=0 todo=0",
    "[security-gate] FAILED",
  ].join("\n");
  const greenBaseline = observeGateRun({
    status: 0,
    transcript: "[security-gate] tests: passed=2124 failed=0 skipped=0 todo=0\n[security-gate] PASSED",
    artifact: null,
  });
  const redBaseline = observeGateRun({
    status: 1,
    transcript: [
      "[security-gate] FAILED TEST: tests/coding-agent-c4a-typosquat-dataset.test.ts > security-gate: C4a curated typosquat dataset > ships a valid, versioned dataset for every ecosystem",
      "[security-gate]     Error: ENOENT: no such file or directory, open '<worktree>\\data\\typosquat\\npm.json'",
      "[security-gate] tests: passed=2123 failed=1 skipped=0 todo=0",
      "[security-gate] FAILED",
    ].join("\n"),
    artifact: null,
  });
  const forkBombRow = {
    kind: "decoy",
    expectedGateExit: 1,
    expectedFailingSuite: "tests/coding-agent-c14-redteam-fork-bomb.test.ts",
    expectedFailingTest: "hard-denies every spelling of a fork bomb, including the multi-line one the rule used to miss",
    status: 1,
    transcript: measuredTranscript,
    artifact: null,
  };

  it("the matrix's bare `it(…)` title matches the gate's `describe > … > it` chain — and nothing looser", () => {
    const full = "security-gate: C14 red-team — fork bomb > hard-denies every spelling of a fork bomb, including the multi-line one the rule used to miss";
    expect(failureTitleMatches(full, "hard-denies every spelling of a fork bomb, including the multi-line one the rule used to miss")).toBe(true);
    expect(failureTitleMatches("a bare title", "a bare title")).toBe(true);
    // The three ways a title must still NOT match, so "the named test did not fail" stays reportable.
    expect(failureTitleMatches("a > refuses X, loudly", "refuses X")).toBe(false);
    expect(failureTitleMatches("a > refuses X > and more", "a > refuses X")).toBe(false);
    expect(failureTitleMatches(full, "a title nobody wrote")).toBe(false);
    expect(failureTitleMatches(full, "")).toBe(false);
    // The regression itself: the classification must go through the chain-aware comparison.
    const runnerSource = readRepoFile("scripts/security-gate-mutation-branch.mjs");
    expect(runnerSource).toContain("failureTitleMatches(entry.title, expectedTest)");
    expect(runnerSource).not.toContain("entry.title === expectedTest");
  });

  it("a green baseline keeps the earlier verdicts: the describe prefix no longer turns a caught mutation into `wrong_test`", () => {
    const verdict = classifyGateRun({ ...forkBombRow, baseline: greenBaseline });
    expect(verdict.verdict).toBe("caught");
    expect(verdict.newFailures).toEqual([
      "tests/coding-agent-c14-redteam-fork-bomb.test.ts > security-gate: C14 red-team — fork bomb > hard-denies every spelling of a fork bomb, including the multi-line one the rule used to miss",
    ]);
    expect(verdict.preExistingFailures).toEqual([]);
    expect(baselineProblem(greenBaseline)).toBe(null);
  });

  it("a red baseline makes every row `baseline_red` — the cosmetic control included — and no row may claim `caught`", () => {
    // The exact confound of the first escalated run: the gate is red *before* the mutation, so a red mutated
    // run proves nothing about the mutation. The cosmetic row must not be blamed for it either.
    const problem = baselineProblem(redBaseline);
    expect(problem).toContain("red BEFORE any mutation");
    expect(problem).toContain("tests/coding-agent-c4a-typosquat-dataset.test.ts");
    // A mutated run in that environment keeps the baseline's failure and adds the mutation's own: the row must
    // be `baseline_red` even though the test the matrix names IS among the failures — it is among the *new*
    // ones, which is exactly the distinction the baseline exists to draw, but a non-equivalent environment is
    // not allowed to turn that into a proof.
    const rowWithBoth = [
      "[security-gate] FAILED TEST: tests/coding-agent-c4a-typosquat-dataset.test.ts > security-gate: C4a curated typosquat dataset > ships a valid, versioned dataset for every ecosystem",
      "[security-gate]     Error: ENOENT: no such file or directory, open '<worktree>\\data\\typosquat\\npm.json'",
      "[security-gate] FAILED TEST: tests/coding-agent-c14-redteam-fork-bomb.test.ts > security-gate: C14 red-team — fork bomb > hard-denies every spelling of a fork bomb, including the multi-line one the rule used to miss",
      "[security-gate]     AssertionError: expected 'approval' to be 'hard_deny'",
      "[security-gate] tests: passed=2099 failed=2 skipped=0 todo=0",
      "[security-gate] FAILED",
    ].join("\n");
    const decoy = classifyGateRun({ ...forkBombRow, transcript: rowWithBoth, baseline: redBaseline });
    expect(decoy.verdict).toBe("baseline_red");
    expect(decoy.reason).toContain("no verdict is claimed");
    // The subtraction still happens, and it is reported: the mutated run added the fork-bomb failure on top of
    // the one the baseline already had.
    expect(decoy.newFailures).toEqual([
      "tests/coding-agent-c14-redteam-fork-bomb.test.ts > security-gate: C14 red-team — fork bomb > hard-denies every spelling of a fork bomb, including the multi-line one the rule used to miss",
    ]);
    expect(decoy.preExistingFailures).toEqual([
      "tests/coding-agent-c4a-typosquat-dataset.test.ts > security-gate: C4a curated typosquat dataset > ships a valid, versioned dataset for every ecosystem",
    ]);
    // The declared test is not among *this* baseline's failures, so no diagnosis about it is invented.
    expect(decoy.reason).not.toContain("already among the baseline failures");
    // The diagnosis the state *can* still give: when the declared test is itself already red, say so, because
    // that answers "is the guard covered at all?" even though it answers nothing about the mutation.
    const declaredAlreadyRed = observeGateRun({ status: 1, transcript: measuredTranscript, artifact: null });
    const sameTest = classifyGateRun({ ...forkBombRow, baseline: declaredAlreadyRed });
    expect(sameTest.verdict).toBe("baseline_red");
    expect(sameTest.reason).toContain("already among the baseline failures");
    expect(sameTest.newFailures).toEqual([]);
    const cosmetic = classifyGateRun({
      kind: "cosmetic",
      expectedGateExit: 0,
      status: 1,
      transcript: "[security-gate] tests: passed=2123 failed=0 skipped=0 todo=0\n[security-gate] FAILED",
      artifact: null,
      baseline: redBaseline,
    });
    expect(cosmetic.verdict).toBe("baseline_red");
  });

  it("an observation passed back in is not re-read, so a green baseline cannot be mistaken for an unmeasurable one", () => {
    // The runner parses the baseline once and hands the same observation to every row; re-reading it would find
    // no transcript and report `measured: false`, turning a green baseline into `baseline_red` for every row.
    expect(isGateRunObservation(greenBaseline)).toBe(true);
    expect(isGateRunObservation({ status: 0, transcript: "x" })).toBe(false);
    expect(observeGateRun(greenBaseline)).toBe(greenBaseline);
    // The full path, exactly as `main()` calls it: an observation in, `caught` out.
    expect(classifyGateRun({ ...forkBombRow, baseline: greenBaseline }).verdict).toBe("caught");
  });

  it("the baseline is a full unmutated gate run, ordered before the first mutation, and a red one is reported loudly", () => {
    const runnerSource = readRepoFile("scripts/security-gate-mutation-branch.mjs");
    const baselineAt = runnerSource.indexOf("baseline: running the real gate in the worktree with NO mutation");
    const firstMutationAt = runnerSource.indexOf("applyMutation(ROOT, worktree, row)");
    const verdictAt = runnerSource.indexOf("baseline,");
    expect(baselineAt).toBeGreaterThan(0);
    expect(firstMutationAt).toBeGreaterThan(0);
    expect(verdictAt).toBeGreaterThan(0);
    // A baseline measured after a mutation would not be a baseline at all.
    expect(baselineAt).toBeLessThan(firstMutationAt);
    expect(runnerSource).toContain("BASELINE RED");
    expect(runnerSource).toContain("observeGateRun({");
    // And the exit code says "inconclusive" rather than "proven" whenever the baseline was not green.
    expect(runnerSource).toContain("the rows record which failures the mutations added, but no mutation verdict is claimed from a non-equivalent environment");
  });

  it("the failure messages of a red run are kept as evidence, keyed by the failure they belong to", () => {
    const parsed = parseFailureMessages(measuredTranscript);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.file).toBe("tests/coding-agent-c14-redteam-fork-bomb.test.ts");
    expect(parsed[0]?.message).toEqual(["AssertionError: expected 'approval' to be 'hard_deny'"]);
    // Bounded, because this is evidence and not a log.
    const long = ["[security-gate] FAILED TEST: tests/a.test.ts > a", ...Array.from({ length: 40 }, (_value, index) => `[security-gate]     line ${index}`)];
    expect(parseFailureMessages(long.join("\n"), { maxPerTest: 3 })[0]?.message).toEqual(["line 0", "line 1", "line 2"]);
    expect(parseFailureMessages("no failures at all")).toEqual([]);
  });

  it("the gate's own suite lines are kept, because a total that is too low has no failing test to point at", () => {
    const transcript = [
      "[security-gate] suite files: present=150 missing=0",
      "[security-gate] vitest run (150 suites)",
      "[security-gate] tests: passed=2029 failed=6 skipped=0 todo=0",
      "[security-gate] FAILED: 1 configured suite(s) did not run (expected 150, saw 149):",
      "[security-gate]   missing: tests/coding-agent-c14-somewhere.test.ts",
      "[security-gate] FAILED: 1 suite(s) reported no tests at all (a file that failed to load looks like this):",
      "[security-gate]   empty: tests/coding-agent-c14-somewhere-else.test.ts",
      "[security-gate] unrelated line",
    ].join("\n");
    expect(parseSuiteLines(transcript)).toEqual([
      "[security-gate] suite files: present=150 missing=0",
      "[security-gate] vitest run (150 suites)",
      "[security-gate] FAILED: 1 configured suite(s) did not run (expected 150, saw 149):",
      "[security-gate]   missing: tests/coding-agent-c14-somewhere.test.ts",
      "[security-gate] FAILED: 1 suite(s) reported no tests at all (a file that failed to load looks like this):",
      "[security-gate]   empty: tests/coding-agent-c14-somewhere-else.test.ts",
    ]);
    // A measurement that carries them through the observation, so the baseline artifact always has them.
    expect(observeGateRun({ status: 0, transcript, artifact: null }).suiteLines).toEqual(parseSuiteLines(transcript));
  });
});

/**
 * The mirror: `git diff`/`git ls-files --others` are blind to `.gitignore`d paths, and this gate reads two of
 * them. What is pinned here is the declaration's non-vacuity (every consumer still names the resource) and the
 * copy itself; the *hermeticity* of the gate is a named finding, not something this list can fix.
 */
describe("security-gate: G1 — the mirror carries the gitignored resources the gate reads", () => {
  it("every declared ignored resource still has a consumer that really names it, and a written reason", () => {
    expect(GATE_IGNORED_RESOURCES.length).toBeGreaterThan(0);
    const declared = GATE_IGNORED_RESOURCES.map((resource) => resource.path);
    // The two the first escalated run proved the gate depends on.
    expect(declared).toContain("data/typosquat");
    expect(declared).toContain("artifacts");
    const problems: string[] = [];
    for (const resource of GATE_IGNORED_RESOURCES) {
      if (resource.reason.trim().length < 40) problems.push(`${resource.path}: the reason is not an argument`);
      if (resource.consumers.length === 0) problems.push(`${resource.path}: no consumer is named`);
      for (const consumer of resource.consumers) {
        let source = "";
        try {
          source = readRepoFile(consumer.file);
        } catch {
          problems.push(`${resource.path}: the named consumer ${consumer.file} does not exist`);
          continue;
        }
        if (!source.includes(consumer.evidence)) {
          problems.push(`${resource.path}: ${consumer.file} no longer contains ${JSON.stringify(consumer.evidence)}`);
        }
      }
    }
    expect(problems).toEqual([]);
    // The declaration is a mirror instruction, not a copy of the repository: it may only name directories.
    for (const resource of GATE_IGNORED_RESOURCES) expect(resource.kind).toBe("directory");
  });

  it("the resource mirror copies bytes exactly, and creates an absent resource as an empty writable directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "npati-mirror-resource-"));
    try {
      const source = path.join(root, "source");
      mkdirSync(path.join(source, "nested"), { recursive: true });
      writeFileSync(path.join(source, "npm.json"), '{"ecosystem":"npm"}\n', "utf8");
      writeFileSync(path.join(source, "nested", "pypi.json"), "[]\n", "utf8");
      const target = path.join(root, "target");
      const mirrored = mirrorResourceDirectory(source, target);
      expect(mirrored.created).toBe(false);
      expect([...mirrored.copied].sort()).toEqual(["nested/pypi.json", "npm.json"]);
      expect(readFileSync(path.join(target, "npm.json"), "utf8")).toBe('{"ecosystem":"npm"}\n');
      expect(readFileSync(path.join(target, "nested", "pypi.json"), "utf8")).toBe("[]\n");
      // The state the real gate creates for itself and then depends on: the directory, empty, writable.
      const created = mirrorResourceDirectory(path.join(root, "absent"), path.join(root, "created"));
      expect(created).toEqual({ copied: [], created: true });
      writeFileSync(path.join(root, "created", "security-gate-report.json"), "{}\n", "utf8");
      expect(readFileSync(path.join(root, "created", "security-gate-report.json"), "utf8")).toBe("{}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The evidence side of the runner: the first escalated run's artifact kept only the last 25 lines of the gate's
 * output, which is exactly the part that does *not* contain `suite files:`, `missing:`, `empty:` or the message
 * under a `FAILED TEST:`. These tests pin that the full transcript is now kept and that the diagnostic section
 * is not truncated.
 */
describe("security-gate: G1 — the gate's transcript is kept whole, because a verdict is diagnosed from it", () => {
  it("each run's transcript has its own file inside `artifacts/`, and a hostile label cannot escape it", () => {
    expect(MUTATION_EVIDENCE_DIRECTORY).toBe("artifacts");
    expect(mutationTranscriptPath("baseline")).toBe("artifacts/security-gate-mutation-branch.baseline.log");
    expect(mutationTranscriptPath("branch.fork_bomb_rule_removed")).toBe(
      "artifacts/security-gate-mutation-branch.branch.fork_bomb_rule_removed.log",
    );
    // A row id is data from a JSON file: it names a file, it never selects a directory.
    for (const hostile of ["../../etc/passwd", "..\\..\\x", "C:/windows/x", "", "  "]) {
      const path_ = mutationTranscriptPath(hostile);
      expect(path_.startsWith("artifacts/security-gate-mutation-branch.")).toBe(true);
      expect(path_.includes("..")).toBe(false);
      expect(path_.endsWith(".log")).toBe(true);
    }
  });

  it("the transcript is written verbatim — no tail, no truncation — and a write failure is reported, not thrown", () => {
    const root = mkdtempSync(path.join(tmpdir(), "npati-transcript-"));
    try {
      const transcript = [
        "[security-gate] suite files: present=150 missing=0",
        ...Array.from({ length: 500 }, (_value, index) => `[security-gate] line ${index}`),
        "[security-gate] FAILED TEST: tests/coding-agent-c5a-rbac-foundation.test.ts > a suite is part of SG-1 > registered",
        "[security-gate]     Error: the reason a tail would have lost",
        "[security-gate] FAILED",
      ].join("\n");
      const written = writeGateTranscript(root, "baseline", transcript);
      expect(written.ok).toBe(true);
      expect(written.path).toBe("artifacts/security-gate-mutation-branch.baseline.log");
      expect(readFileSync(path.join(root, written.path), "utf8")).toBe(transcript);
      expect(written.bytes).toBe(transcript.length);
      // The diagnostic lines survive, which is the property the first escalated run's artifact lacked.
      const kept = readFileSync(path.join(root, written.path), "utf8");
      expect(kept).toContain("suite files: present=150 missing=0");
      expect(kept).toContain("the reason a tail would have lost");
      // The obstruction is a **file** where the directory must be: reported, never thrown, and the verdict is
      // not allowed to depend on it.
      const blocked = mkdtempSync(path.join(tmpdir(), "npati-transcript-blocked-"));
      try {
        writeFileSync(path.join(blocked, MUTATION_EVIDENCE_DIRECTORY), "not a directory\n", "utf8");
        const failed = writeGateTranscript(blocked, "baseline", transcript);
        expect(failed.ok).toBe(false);
        expect(typeof failed.error).toBe("string");
        expect(failed.bytes).toBe(0);
      } finally {
        rmSync(blocked, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the diagnostic section is returned whole: a suite line is never cut because the total was large", () => {
    const many = Array.from({ length: 200 }, (_value, index) => `[security-gate]   empty: tests/coding-agent-c14-suite-${index}.test.ts`);
    const transcript = ["[security-gate] suite files: present=150 missing=0", ...many, "[security-gate] tests: passed=1 failed=0 skipped=0 todo=0"].join("\n");
    expect(parseSuiteLines(transcript)).toHaveLength(1 + many.length);
    expect(parseSuiteLines(transcript).at(-1)).toBe(many.at(-1));
  });

  it("the runner writes a transcript for the baseline and for every row, and records the path in the artifact", () => {
    const runnerSource = readRepoFile("scripts/security-gate-mutation-branch.mjs");
    expect(runnerSource).toContain('writeGateTranscript(ROOT, "baseline", baselineRun.transcript)');
    expect(runnerSource).toContain("writeGateTranscript(ROOT, row.id, run.transcript)");
    expect(runnerSource).toContain("transcript: baselineTranscript");
  });
});
