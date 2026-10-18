import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractPlan, splitObligations, validateReview, STATUSES } from "../scripts/lib/coding-agent-plan-verification.mjs";

describe("PLAN verification integrity", () => {
  it("accounts for every source line and every nested numbered/lettered/bulleted statement", () => {
    const source = readFileSync(new URL("../docs/coding-agent/PLAN.md", import.meta.url), "utf8");
    const result = extractPlan(source);
    const lines = source.split(/\r?\n/);
    expect(result.coverage.map(row => row.line)).toEqual(lines.map((_, i) => i + 1));
    expect(new Set(result.entries.map(row => row.id)).size).toBe(result.entries.length);
    expect(result.stages).toHaveLength(27);
    for (const row of result.coverage.filter(row => row.disposition === "requirements")) {
      expect(row.ids.length).toBeGreaterThan(0);
      for (const id of row.ids) expect(result.entries.find(entry => entry.id === id)?.source).toBe(lines[row.line - 1]);
    }
    for (const needle of ["a. ", "b. ", "f. "]) {
      const row = lines.findIndex(line => line.trimStart().startsWith(needle));
      expect(result.coverage[row]?.disposition).toBe("requirements");
    }
    expect(result.entries.some(entry => entry.source.includes("all sites in this installation share ONE sandbox"))).toBe(true);
    expect(result.entries.some(entry => entry.line === 1072)).toBe(true);
  });
  it("splits independent fields without splitting quoted attack strings or parenthetical qualifiers", () => {
    const input = 'Session: id, project_id; command ("a,b; c") and output. Other requirement.';
    expect(splitObligations(input)).toEqual(["Session: id", "project_id", 'command ("a,b; c")', "output", "Other requirement."]);
  });
  it("does not accept file presence or missing checks as Verified evidence", () => {
    const entry = { id: "C1.example" };
    expect(() => validateReview(entry, { status: "Verified", observation: "Exists", implementation: [{ path: "package.json" }], checks: [] }))
      .toThrow("implementation changed or hash missing");
    expect(() => validateReview(entry, { status: "Blocked", observation: "Unable", implementation: [], checks: [] }))
      .toThrow("missing concrete blocker");
  });
});

it("distinguishes Unassessed from reviewed Not Verified without double counting", () => {
  expect(STATUSES).toContain("Unassessed");
  expect(() => validateReview({ id: "example" }, { status: "Unassessed" })).toThrow("invalid status");
});

it("keeps the saved2884-clause matrix complete and its seven statuses disjoint", () => {
  const matrix = JSON.parse(readFileSync(new URL("../docs/coding-agent/plan-verification-matrix.json", import.meta.url), "utf8"));
  const ledger = JSON.parse(readFileSync(new URL("../docs/coding-agent/plan-verification-evidence.json", import.meta.url), "utf8"));
  const source = extractPlan(readFileSync(new URL("../docs/coding-agent/PLAN.md", import.meta.url), "utf8"));
  expect(source.entries).toHaveLength(2884);
  expect(matrix.entries.map((entry: { id: string }) => entry.id)).toEqual(source.entries.map(entry => entry.id));
  expect(matrix.planSha256).toBe(source.planSha256);
  expect(ledger.planSha256).toBe(source.planSha256);
  expect(Object.keys(matrix.totals).sort()).toEqual([...STATUSES].sort());
  let reviewed = 0;
  for (const entry of matrix.entries) {
    const assessment = ledger.assessments[entry.id];
    expect(entry.status).toBe(assessment?.status ?? "Unassessed");
    expect(entry.reviewed).toBe(Boolean(assessment));
    expect(entry.assessment).toEqual(assessment ?? null);
    if (assessment) reviewed++;
  }
  for (const status of STATUSES) {
    expect(matrix.totals[status]).toBe(matrix.entries.filter((entry: { status: string }) => entry.status === status).length);
  }
  expect(Object.values(matrix.totals).reduce((sum: number, count) => sum + Number(count), 0)).toBe(2884);
  expect(matrix.reviewed).toBe(reviewed);
  expect(matrix.totals.Unassessed).toBe(2884 - reviewed);
});
