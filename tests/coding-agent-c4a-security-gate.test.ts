import { describe, expect, it } from "vitest";
import { evaluateVitestReport, findEmptySuites, findMissingSuites, suiteKey, SECURITY_GATE_TESTS } from "../scripts/lib/run-security-gate.mjs";
import { runWithCleanup } from "./support/run-with-cleanup";

/**
 * C4a: the mandatory security-gate job must be strict about the rule "security-gate tests are never
 * skipped and never weakened". These checks pin the verdict logic itself (the job is what fails CI, so a
 * bug here would silently disable the gate), and pin the fixed suite list so a suite cannot be dropped.
 */
describe("security-gate: C4a gate verdict", () => {
  it("passes only when tests ran, none failed and none were skipped", () => {
    expect(evaluateVitestReport({ numPassedTests: 10, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }))
      .toMatchObject({ ok: true, numPassed: 10 });
  });

  it("fails when a security-gate test failed", () => {
    const verdict = evaluateVitestReport({ numPassedTests: 9, numFailedTests: 1, numPendingTests: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toContain("failed");
  });

  it("fails when a security-gate test was skipped or marked todo, even if everything else passed", () => {
    const skipped = evaluateVitestReport({ numPassedTests: 10, numFailedTests: 0, numPendingTests: 2 });
    expect(skipped.ok).toBe(false);
    expect(skipped.failures.join(" ")).toMatch(/skipped/i);
    const todo = evaluateVitestReport({ numPassedTests: 10, numFailedTests: 0, numTodoTests: 1 });
    expect(todo.ok).toBe(false);
    expect(todo.failures.join(" ")).toMatch(/todo/i);
  });

  it("fails when the report is empty, so a missing run cannot look like a pass", () => {
    expect(evaluateVitestReport({}).ok).toBe(false);
    expect(evaluateVitestReport(null).ok).toBe(false);
  });

  it("keeps the fixed suite list covering every coding-agent security-gate area", () => {
    for (const required of [
      "tests/coding-agent-c1c-audit-log.test.ts",
      "tests/coding-agent-c1b-images.test.ts",
      "tests/coding-agent-c2-read-tools.test.ts",
      "tests/coding-agent-c3-runtime.test.ts",
      "tests/coding-agent-c4-policy-engine.test.ts",
      "tests/coding-agent-c4a-deps-guard.test.ts",
      "tests/coding-agent-c4a-capabilities.test.ts",
    ]) {
      expect(SECURITY_GATE_TESTS).toContain(required);
    }
    expect(new Set(SECURITY_GATE_TESTS).size).toBe(SECURITY_GATE_TESTS.length);
  });

  it("compares suite paths in the report against the configured list regardless of path shape", () => {
    // The vitest JSON report carries absolute, Windows-style paths while the list is repository-relative:
    // this regression guard keeps a green run from being reported as "22 configured suite(s) did not run".
    const backslash = String.fromCharCode(92);
    const absolute = `D:${backslash}npati${backslash}NPATI Agent${backslash}tests${backslash}coding-agent-c4a-deps-guard.test.ts`;
    expect(suiteKey(absolute)).toBe("tests/coding-agent-c4a-deps-guard.test.ts");
    expect(suiteKey("./tests/coding-agent-c4a-deps-guard.test.ts")).toBe("tests/coding-agent-c4a-deps-guard.test.ts");

    const fullReport = { testResults: SECURITY_GATE_TESTS.map((suite) => ({ name: `D:${backslash}npati${backslash}NPATI Agent${backslash}${suite.replace(/\//g, backslash)}` })) };
    expect(findMissingSuites(fullReport, SECURITY_GATE_TESTS)).toEqual([]);

    // A suite that genuinely did not run must still be reported, so the check is not weakened.
    const partial = { testResults: [{ name: absolute }] };
    expect(findMissingSuites(partial, ["tests/coding-agent-c4a-deps-guard.test.ts", "tests/coding-agent-c1-foundation.test.ts"])).toEqual(["tests/coding-agent-c1-foundation.test.ts"]);
  });

  it("names a suite that did not run and one that reported no tests, but cannot see a suite that ran fewer tests", () => {
    // Both silent-looking failure modes are in fact loud, and this is where that is pinned rather than assumed:
    // a suite that never ran is named by `findMissingSuites`, and a suite whose import failed reports zero
    // assertions and is named by `findEmptySuites` — the gate prints both as `FAILED: …` lines with the file.
    //
    // What the gate does **not** pin is the number of tests a suite defines. A suite that loads and generates
    // fewer cases than it names (a data-driven loop over a fixture that shrank, a `describe` behind a
    // condition) passes every reader here. That is a recorded limitation, and it is where the 95-test deficit
    // of the first G1 item-3 escalated run (2029 tests in the mirrored worktree against 2124 in the repository,
    // report § 7.5.1) could hide without a named file. The fix would be a per-suite expected count, which this
    // repository does not declare anywhere.
    const configured = ["tests/a.test.ts", "tests/b.test.ts"];
    const assertion = (title: string) => ({ status: "passed", title, ancestorTitles: [] });

    const didNotRun = { testResults: [{ name: "tests/a.test.ts", assertionResults: [assertion("one")] }] };
    expect(findMissingSuites(didNotRun, configured)).toEqual(["tests/b.test.ts"]);

    const reportedNoTests = {
      testResults: [
        { name: "tests/a.test.ts", assertionResults: [assertion("one")] },
        { name: "tests/b.test.ts", assertionResults: [] },
      ],
    };
    expect(findEmptySuites(reportedNoTests)).toEqual(["tests/b.test.ts"]);
    expect(findMissingSuites(reportedNoTests, configured)).toEqual([]);

    // The hole: two cases where thirty were written is neither "did not run" nor "no tests at all".
    const fewerTests = {
      testResults: [
        { name: "tests/a.test.ts", assertionResults: [assertion("one")] },
        { name: "tests/b.test.ts", assertionResults: [assertion("one"), assertion("two")] },
      ],
    };
    expect(evaluateVitestReport({ numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 })).toMatchObject({ ok: true });
    expect(findMissingSuites(fewerTests, configured)).toEqual([]);
    expect(findEmptySuites(fewerTests)).toEqual([]);
  });
});

/**
 * G1 (item 2): the gate's own evidence. A `finally` that throws replaces the exception propagating out of `try`,
 * so a broken teardown in a DB-backed suite reported **itself** instead of the assertion that had just failed —
 * `tests/coding-agent-c1c-audit-postgres.test.ts` was read for nine escalated runs as
 * `TypeError: store.close is not a function`, the teardown, while the real defect stayed invisible.
 *
 * `runWithCleanup` is what that suite now uses. These two cases pin the property hermetically, so it is asserted
 * on every `npm run security-gate` run — including one with no database at all, where the suite it protects is
 * skipped.
 */
describe("security-gate: G1 the teardown cannot replace the verdict", () => {
  it("throws the body's error when the cleanup fails too, and names both", async () => {
    const bodyFailure = new Error("the assertion that explains the test");
    const cleanupFailure = new Error("store.close is not a function");
    const thrown: unknown = await runWithCleanup(
      async () => { throw bodyFailure; },
      async () => { throw cleanupFailure; },
    ).then(() => null, (error: unknown) => error);

    // Identity, not a message match: the error the reader sees is the body's own error object.
    expect(thrown).toBe(bodyFailure);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("the assertion that explains the test");
    // …and the cleanup failure is appended rather than dropped, so the second defect is still visible.
    expect(message).toContain("store.close is not a function");
  });

  it("returns the body's value when both succeed, and reports a cleanup-only failure", async () => {
    expect(await runWithCleanup(async () => 7, async () => undefined)).toBe(7);
    const cleanupOnly: unknown = await runWithCleanup(async () => "ok", async () => { throw new Error("pool.end failed"); })
      .then(() => null, (error: unknown) => error);
    expect(String(cleanupOnly)).toContain("pool.end failed");
  });
});
