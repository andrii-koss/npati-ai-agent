import { expect, it } from "vitest";
import { CodingAgentReviewCoordinator } from "../apps/agent-api/src/coding-agent-review-coordinator";

// A run that only deleted a file used to stop as review_diff_unavailable: the delete has no text diff.
it("shows a deleted file to the self-review instead of an empty diff", () => {
  const changes = [{ path: "temp-check.txt", tool: "code.fs.delete", sha256: null, linesAdded: 0, linesRemoved: 1, diff: "", at: "" }];
  const coordinator = new CodingAgentReviewCoordinator({
    input: { verificationTools: [] }, sessionId: "s", toolSteps: [1], stepTurnKey: (index: number) => "turn-" + index,
    ports: { toolRuntime: { turnSummary: () => ({ changes }) } }, summary: {},
  } as never);
  const diff = coordinator.boundedDiff(10_000);
  expect(diff).toContain("--- temp-check.txt");
  expect(diff).toContain("(the file was deleted)");
});

it("adds nothing for a write whose diff is already recorded", () => {
  const changes = [{ path: "a.txt", tool: "code.fs.write", sha256: "x", linesAdded: 1, linesRemoved: 0, diff: "+hello", at: "" }];
  const coordinator = new CodingAgentReviewCoordinator({
    input: { verificationTools: [] }, sessionId: "s", toolSteps: [1], stepTurnKey: (index: number) => "turn-" + index,
    ports: { toolRuntime: { turnSummary: () => ({ changes }) } }, summary: {},
  } as never);
  const diff = coordinator.boundedDiff(10_000);
  expect(diff.match(/--- a\.txt/g)).toHaveLength(1);
  expect(diff).not.toContain("deleted");
});
