import { describe, expect, it } from "vitest";
import { buildSelfReviewPrompt } from "../apps/agent-api/src/code-self-review-parser";
import { CodingAgentReviewCoordinator, type ReviewCoordinatorHost } from "../apps/agent-api/src/coding-agent-review-coordinator";

describe("non-file self-review evidence", () => {
  it("rereads unchanged consumers for review instead of using stale implementation reads", async () => {
    let evidence = "";
    const reads: string[] = [];
    const coordinator = new CodingAgentReviewCoordinator({ input: { verificationTools: [] }, summary: { toolCalls: 0 }, record: async () => {},
      ports: { toolRuntime: { invoke: async (_ctx: unknown, call: { args: { path: string } }) => {
        reads.push(call.args.path);
        return { ok: true, result: { data: { path: call.args.path, lines: [{ n: 1, text: '"backend":"node --env-file=config/test.env server/index.mjs"' }] } } };
      } } }, session: {}, toolSteps: [],
      reviewPhases: { runSelfReviewOnce: async (input: { runtimeEvidence: string }) => { evidence = input.runtimeEvidence; return null; } },
    } as unknown as ReviewCoordinatorHost);
    coordinator.recordRuntimeResult({ ok: true, tool: "code.fs.read", result: { data: { content: "stale content" } } } as never, { path: "package.json" });
    await coordinator.runSelfReview(1, "Fix backend startup");
    expect(reads).toEqual(["package.json"]);
    expect(evidence).toContain("final_source_context");
    expect(evidence).toContain("--env-file=config/test.env");
    expect(evidence).not.toContain("stale content");
  });
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
  it("passes successful shell command and cwd evidence into the reviewer and excludes failed commands", async () => {
    let evidence = "";
    const coordinator = new CodingAgentReviewCoordinator({ input: { verificationTools: [] }, ports: {}, session: {}, toolSteps: [],
      reviewPhases: { runSelfReviewOnce: async (input: { runtimeEvidence: string }) => { evidence = input.runtimeEvidence; return null; } },
    } as unknown as ReviewCoordinatorHost);
    const result = { ok: true as const, tool: "code.shell.exec", toolVersion: 1, schemaVersion: 1, truncated: false, durationMs: 10,
      result: { data: { exitCode: 0, stdout: "added 1 package", durationMs: 10 } } };
    coordinator.recordRuntimeResult(result, { command: "npm install lodash", cwd: "e2e-smoke" });
    coordinator.recordRuntimeResult({ ...result, result: { data: { exitCode: 1, stdout: "install failed", durationMs: 10 } } }, { command: "npm install missing" });
    await coordinator.runSelfReview(1, "Install package");
    const receipt = JSON.parse(evidence);
    expect(receipt.result).toMatchObject({ command: "npm install lodash", cwd: "e2e-smoke", exitCode: 0, stdout: "added 1 package" });
    expect(evidence).not.toContain("install failed");
  });
});
