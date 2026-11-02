import { describe, expect, it } from "vitest";
import { verificationChecks, createVerificationLoop } from "../apps/agent-api/src/code-verification-loop";
import { CodingAgentReviewCoordinator, type ReviewCoordinatorHost } from "../apps/agent-api/src/coding-agent-review-coordinator";
import type { CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";

const outcome = (results: unknown[]): CodeToolInvokeResult => ({ ok: true, tool: "code.verify.run", toolVersion: 1, schemaVersion: 1, truncated: false,
  result: { kind: "code_tool_result", data: { results } } } as CodeToolInvokeResult);

describe("D05/D06 verification evidence and repair", () => {
  it("adds newly discovered checks without resetting the spent repair budget", () => {
    const loop = createVerificationLoop({ maxRepairAttempts: 1, requestedTools: [] });
    loop.addRequestedTools(["test", "build"]);
    loop.record([{ tool: "test", state: "failed" }]);
    expect(loop.decide().decision).toBe("repair");
    loop.addRequestedTools(["build", "test"]);
    loop.record([{ tool: "test", state: "failed" }]);
    expect(loop.decide().decision).toBe("stop");
    expect(loop.report().requestedTools).toEqual(["test", "build"]);
    expect(loop.report().attemptsUsed).toBe(1);
  });
  it("gives the reviewer the latest nested checks instead of only an aggregate pass", async () => {
    const coordinator = new CodingAgentReviewCoordinator({ input: { verificationTools: ["build", "test"] }, ports: {}, summary: {},
      reviewPhases: { verifyOnce: async (args: { verificationLoop: ReturnType<typeof createVerificationLoop> }) => {
        args.verificationLoop.record(verificationChecks(outcome([
          { tool: "build", ok: true, summary: "build passed" }, { tool: "test", ok: true, summary: "test passed (13/13 tests)" },
        ]), ["build", "test"]));
      } },
    } as unknown as ReviewCoordinatorHost);
    await coordinator.runVerification(1);
    expect(coordinator.verificationForReview()).toContain('"tool":"build","state":"passed"');
    expect(coordinator.verificationForReview()).toContain("13/13 tests");
  });
  it("retains the dependency failure diagnosis and permits a bounded repair, without inventing a pass", () => {
    const checks = verificationChecks(outcome([{ tool: "build", ok: false, code: "command_not_found", summary: "vite: not found" }]), ["build"]);
    expect(checks).toEqual([{ tool: "build", state: "failed", code: "command_not_found", message: "vite: not found" }]);
    const loop = createVerificationLoop({ maxRepairAttempts: 1, requestedTools: ["build"] });
    loop.record(checks);
    expect(loop.decide().decision).toBe("repair");
    expect(loop.report().status).toBe("failed");
    loop.record(verificationChecks(outcome([{ tool: "build", ok: true }]), ["build"]));
    expect(loop.decide().decision).toBe("complete");
  });
  it("does not turn approval requirements or missing receipts into success", () => {
    expect(verificationChecks(outcome([{ tool: "build", state: "approval_required" }]), ["build"])[0].state).toBe("approval_required");
    expect(verificationChecks(outcome([]), ["build"])[0].state).toBe("unavailable");
  });
});
