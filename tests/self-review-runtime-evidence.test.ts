import { describe, expect, it } from "vitest";
import { buildSelfReviewPrompt } from "../apps/agent-api/src/code-self-review-parser";

describe("non-file self-review evidence", () => {
  it("includes canonical policy receipts as fenced evidence without changing file verification", () => {
    const input = { originalGoal: "Create the catalog and apply its approved SELECT policy", approvedPlan: null,
      finalDiff: "+catalog implementation", changedFiles: [{ path: "src/catalog.ts", tool: "code.fs.edit" }],
      verification: "build PASS", testIntegrity: "unchanged", runtimeEvidence: JSON.stringify({ tool: "code.data.policies.apply", result: { applied: true } }) };
    const prompt = buildSelfReviewPrompt(input);
    expect(prompt).toContain("source: runtime_tool_receipts");
    expect(prompt).toContain(input.runtimeEvidence);
    expect(prompt).toContain("source: final_diff");
    expect(prompt).toContain("source: verification");
    expect(buildSelfReviewPrompt({ ...input, runtimeEvidence: undefined })).not.toContain("source: runtime_tool_receipts");
  });
});
