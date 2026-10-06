import { describe, expect, it } from "vitest";
import { evaluateScopeGuard } from "../apps/agent-api/src/code-scope-guard";

describe("security-gate: C9 scope guard — a warning that is actionable, never a silent block", () => {
  it("stays quiet while the change set is inside the limit and the focus", () => {
    const result = evaluateScopeGuard({
      changedPaths: ["src/billing/invoice.ts", "src/billing/totals.ts"],
      plannedPaths: ["src/billing/invoice.ts"],
      maxChangedFiles: 25,
    });
    expect(result.exceeded).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.unrelatedPaths).toEqual([]);
    expect(result.relatednessUnknown).toBe(false);
  });

  it("warns when the change set exceeds the configured limit", () => {
    const result = evaluateScopeGuard({
      changedPaths: Array.from({ length: 6 }, (_, index) => `src/file-${index}.ts`),
      maxChangedFiles: 5,
    });
    expect(result.exceeded).toBe(true);
    expect(result.severity).toBe("warn");
    const warning = result.warnings.find((item) => item.code === "scope_exceeded");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("6 files");
    expect(warning?.message).toContain("limit of 5");
  });

  it("escalates a gross overrun instead of tolerating it quietly", () => {
    const result = evaluateScopeGuard({
      changedPaths: Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`),
      maxChangedFiles: 5,
    });
    expect(result.severity).toBe("critical");
    expect(result.warnings.map((warning) => warning.code)).toContain("scope_grossly_exceeded");
  });

  it("names files outside the stated focus, and says which focus it used", () => {
    const result = evaluateScopeGuard({
      changedPaths: [
        "src/billing/invoice.ts",
        "src/billing/totals.ts",
        "infra/terraform/main.tf",
        "docs/readme.md",
      ],
      plannedPaths: ["src/billing/invoice.ts"],
      maxChangedFiles: 25,
    });
    // The unrelated file is reported...
    expect(result.unrelatedPaths).toEqual(["infra/terraform/main.tf"]);
    const warning = result.warnings.find((item) => item.code === "scope_unrelated_files");
    expect(warning?.message).toContain("src/billing");
    // ...while the docs file is not: manifests, configs and docs legitimately move with many tasks, and
    // flagging them is how a guard becomes noise.
    expect(result.unrelatedPaths).not.toContain("docs/readme.md");
  });

  it("takes its focus from the request when there is no plan", () => {
    const result = evaluateScopeGuard({
      changedPaths: ["src/billing/invoice.ts", "infra/terraform/main.tf"],
      requestText: "fix the rounding bug in src/billing/invoice.ts",
      maxChangedFiles: 25,
    });
    expect(result.relatednessUnknown).toBe(false);
    expect(result.unrelatedPaths).toEqual(["infra/terraform/main.tf"]);
  });

  it("admits it cannot judge relatedness instead of guessing", () => {
    // With no plan and no path-like token in the request there is nothing to compare against; inventing a
    // finding here would produce a warning nobody can act on.
    const result = evaluateScopeGuard({
      changedPaths: ["src/a.ts", "src/b.ts"],
      requestText: "make the tests pass",
      maxChangedFiles: 25,
    });
    expect(result.relatednessUnknown).toBe(true);
    expect(result.unrelatedPaths).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("bounds the path list it reports, because a summary is not a file dump", () => {
    const result = evaluateScopeGuard({
      changedPaths: Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`),
      maxChangedFiles: 5,
      unrelatedSampleLimit: 3,
    });
    for (const warning of result.warnings) {
      expect(warning.paths.length).toBeLessThanOrEqual(3);
    }
  });

  it("uses the configured limit rather than a literal", () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    expect(evaluateScopeGuard({ changedPaths: paths, maxChangedFiles: 3 }).exceeded).toBe(false);
    expect(evaluateScopeGuard({ changedPaths: paths, maxChangedFiles: 2 }).exceeded).toBe(true);
  });

  it("deduplicates the change set before counting it", () => {
    const result = evaluateScopeGuard({ changedPaths: ["src/a.ts", "src/a.ts"], maxChangedFiles: 1 });
    expect(result.changedFiles).toBe(1);
    expect(result.exceeded).toBe(false);
  });
});
