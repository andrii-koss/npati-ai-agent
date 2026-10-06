import { describe, expect, it } from "vitest";
import {
  analyzeTestIntegrity,
  describeTestIntegrity,
  isTestPath,
  splitDiffLines,
} from "../apps/agent-api/src/code-test-integrity-guard";

const beforeTwoCases = [
  'import { describe, it, expect } from "vitest";',
  'describe("sum", () => {',
  '  it("adds", () => { expect(sum(1, 2)).toBe(3); });',
  '  it("subtracts", () => { expect(sum(2, 1)).toBe(1); });',
  "});",
].join("\n");

describe("security-gate: C9 test integrity — weakening the suite to go green is detected", () => {
  it("flags a deleted test file", () => {
    const verdict = analyzeTestIntegrity([{ path: "tests/sum.test.ts", status: "deleted" }]);
    expect(verdict.flagged).toBe(true);
    expect(verdict.requiresJustification).toBe(true);
    expect(verdict.testFilesDeleted).toEqual(["tests/sum.test.ts"]);
    expect(verdict.findings.map((finding) => finding.kind)).toContain("test_file_deleted");
  });

  it("flags a removed test case", () => {
    const after = [
      'import { describe, it, expect } from "vitest";',
      'describe("sum", () => {',
      '  it("adds", () => { expect(sum(1, 2)).toBe(3); });',
      "});",
    ].join("\n");
    const verdict = analyzeTestIntegrity([{ path: "tests/sum.test.ts", status: "modified", before: beforeTwoCases, after }]);
    expect(verdict.flagged).toBe(true);
    expect(verdict.findings.map((finding) => finding.kind)).toContain("test_cases_reduced");
    expect(verdict.findings.find((finding) => finding.kind === "test_cases_reduced")?.removed).toBe(1);
  });

  it("flags a skipped test", () => {
    const after = beforeTwoCases.replace('it("subtracts"', 'it.skip("subtracts"');
    const verdict = analyzeTestIntegrity([{ path: "tests/sum.test.ts", status: "modified", before: beforeTwoCases, after }]);
    expect(verdict.flagged).toBe(true);
    expect(verdict.findings.map((finding) => finding.kind)).toContain("test_skipped");
  });

  it("flags a focused test, which is worse than a skip because it disables the rest", () => {
    const after = beforeTwoCases.replace('it("adds"', 'it.only("adds"');
    const verdict = analyzeTestIntegrity([{ path: "tests/sum.test.ts", status: "modified", before: beforeTwoCases, after }]);
    expect(verdict.flagged).toBe(true);
    expect(verdict.findings.map((finding) => finding.kind)).toContain("test_focused");
  });

  it("flags a specific assertion replaced by a weaker existence check", () => {
    const before = 'it("x", () => { expect(result).toEqual({ a: 1 }); });';
    const after = 'it("x", () => { expect(result).toBeDefined(); });';
    const verdict = analyzeTestIntegrity([{ path: "tests/x.test.ts", status: "modified", before, after }]);
    expect(verdict.flagged).toBe(true);
    expect(verdict.findings.map((finding) => finding.kind)).toContain("assert_weakened");
  });

  it("flags removed assertions even when the case count is unchanged", () => {
    const before = 'it("x", () => { expect(a).toBe(1); expect(b).toBe(2); });';
    const after = 'it("x", () => { expect(a).toBe(1); });';
    const verdict = analyzeTestIntegrity([{ path: "tests/x.test.ts", status: "modified", before, after }]);
    expect(verdict.findings.map((finding) => finding.kind)).toContain("assert_weakened");
  });

  it("flags a removed table-driven block", () => {
    const before = 'it.each([1, 2, 3])("case %i", (n) => { expect(n).toBeGreaterThan(0); });';
    const after = "";
    const verdict = analyzeTestIntegrity([{ path: "tests/each.test.ts", status: "modified", before, after }]);
    expect(verdict.findings.map((finding) => finding.kind)).toContain("test_matrix_reduced");
  });

  it("works from a unified diff when the full contents are unavailable", () => {
    const diff = [
      "--- a/tests/sum.test.ts",
      "+++ b/tests/sum.test.ts",
      "@@ -1,5 +1,3 @@",
      ' describe("sum", () => {',
      '-  it("subtracts", () => { expect(sum(2, 1)).toBe(1); });',
      "-  expect(true).toBe(true);",
      " });",
    ].join("\n");
    const verdict = analyzeTestIntegrity([{ path: "tests/sum.test.ts", status: "modified", diff }]);
    expect(verdict.flagged).toBe(true);
    const kinds = verdict.findings.map((finding) => finding.kind);
    expect(kinds).toContain("test_cases_reduced");
    // The header lines must not be counted as added content: `+++`/`---` are not test code.
    expect(splitDiffLines(diff).added).not.toContain("+++ b/tests/sum.test.ts");
  });

  it("does not flag a new test file: adding tests is the behaviour we want", () => {
    const verdict = analyzeTestIntegrity([
      { path: "tests/new.test.ts", status: "added", after: 'it("new", () => { expect(1).toBe(1); });' },
    ]);
    expect(verdict.flagged).toBe(false);
    expect(verdict.requiresJustification).toBe(false);
    // It is still recorded as touched, so the summary can say the suite grew.
    expect(verdict.testFilesTouched).toEqual(["tests/new.test.ts"]);
  });

  it("ignores non-test files even when they lose assertions", () => {
    const verdict = analyzeTestIntegrity([
      { path: "src/assert-helper.ts", status: "modified", before: "expect(a); expect(b);", after: "expect(a);" },
    ]);
    expect(verdict.flagged).toBe(false);
  });

  it("stays silent when there is nothing to inspect, instead of guessing from the path", () => {
    // A finding that cannot be justified is noise, and noise is what makes people ignore a guard.
    const verdict = analyzeTestIntegrity([{ path: "tests/unknown.test.ts", status: "modified" }]);
    expect(verdict.flagged).toBe(false);
    expect(verdict.findings).toEqual([]);
  });

  it("recognises test paths across the conventions this repository uses", () => {
    expect(isTestPath("tests/a.test.ts")).toBe(true);
    expect(isTestPath("apps/web/src/__tests__/a.tsx")).toBe(true);
    expect(isTestPath("src/a.spec.ts")).toBe(true);
    expect(isTestPath("pkg/handler_test.go")).toBe(true);
    expect(isTestPath("service/TestUser.java")).toBe(true);
    expect(isTestPath("src/index.ts")).toBe(false);
    expect(isTestPath("src/latest.ts")).toBe(false);
  });

  it("summarises a verdict without leaking the diff", () => {
    const verdict = analyzeTestIntegrity([{ path: "tests/sum.test.ts", status: "deleted" }]);
    const text = describeTestIntegrity(verdict);
    expect(text).toContain("test integrity");
    expect(text).toContain("test_file_deleted");
    expect(text).not.toContain("expect(");
    expect(describeTestIntegrity({ flagged: false, requiresJustification: false, findings: [], testFilesTouched: [], testFilesDeleted: [] }))
      .toBe("test integrity: no reduction detected");
  });
});
