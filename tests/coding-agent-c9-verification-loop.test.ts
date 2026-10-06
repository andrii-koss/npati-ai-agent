import { describe, expect, it } from "vitest";
import { DEFAULT_CODE_AGENT_LIMITS, resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import {
  VERIFICATION_APPROVAL_REQUIRED,
  VERIFICATION_REPAIR_EXHAUSTED,
  VERIFICATION_REPORT_SCHEMA_VERSION,
  VERIFICATION_UNAVAILABLE,
  createVerificationLoop,
  formatRepairInstruction,
  summariseVerification,
} from "../apps/agent-api/src/code-verification-loop";
import type { VerificationCheckReport } from "../apps/agent-api/src/code-verification-loop";

const pass: VerificationCheckReport[] = [{ tool: "typecheck", state: "passed" }, { tool: "test", state: "passed" }];
const fail: VerificationCheckReport[] = [{ tool: "test", state: "failed", code: "verify_failed" }];

describe("security-gate: C9 verification loop — the repair budget is bounded and honest", () => {
  it("allows exactly the configured number of repair attempts, then stops", () => {
    const loop = createVerificationLoop({ maxRepairAttempts: 3, requestedTools: ["typecheck", "test"] });

    // Verification #1 fails: repair #1.
    loop.record(fail);
    expect(loop.decide()).toMatchObject({ decision: "repair", attempt: 1, maxAttempts: 3 });
    // #2 and #3 likewise.
    loop.record(fail);
    expect(loop.decide()).toMatchObject({ decision: "repair", attempt: 2 });
    loop.record(fail);
    expect(loop.decide()).toMatchObject({ decision: "repair", attempt: 3 });
    // The fourth failure has no budget left: the run stops and names the exhausted code.
    loop.record(fail);
    const decision = loop.decide();
    expect(decision).toMatchObject({ decision: "stop", code: VERIFICATION_REPAIR_EXHAUSTED, status: "failed" });
    expect(loop.attemptsUsed()).toBe(3);
    expect(loop.report().verificationRuns).toBe(4);
    expect(loop.report().failedChecks.map((check) => check.tool)).toEqual(["test"]);
  });

  it("does not spend the repair budget twice for the same failure", () => {
    const loop = createVerificationLoop({ maxRepairAttempts: 3, requestedTools: ["test"] });
    loop.record(fail);
    expect(loop.decide()).toMatchObject({ decision: "repair", attempt: 1 });
    // Asking again without a new recorded result must not consume a second attempt: the budget belongs to the
    // failure, not to the number of times somebody asked.
    expect(loop.decide()).toMatchObject({ decision: "stop", code: VERIFICATION_REPAIR_EXHAUSTED });
    expect(loop.attemptsUsed()).toBe(1);
  });

  it("completes only when every requested check actually passed", () => {
    const loop = createVerificationLoop({ maxRepairAttempts: 3, requestedTools: ["typecheck", "test"] });
    loop.record(pass);
    expect(loop.decide()).toEqual({ decision: "complete", status: "passed" });
    expect(loop.status()).toBe("passed");
  });

  it("reports a check that never ran as a failure, not as a pass", () => {
    // One check passed and one could not run: something that was asked for did not happen, so this is not a
    // verification. Treating it as a pass is how a broken deployment silently ships.
    expect(summariseVerification([{ tool: "lint", state: "passed" }, { tool: "test", state: "unavailable" }])).toBe("failed");
    // Only when *nothing* could run is the honest answer "unavailable" rather than "failed".
    expect(summariseVerification([{ tool: "lint", state: "unavailable" }])).toBe("unavailable");
    expect(summariseVerification([])).toBe("unavailable");
  });

  it("stops when verification needs a human decision instead of working around it", () => {
    const loop = createVerificationLoop({ maxRepairAttempts: 3, requestedTools: ["test"] });
    loop.record([{ tool: "test", state: "approval_required", code: "approval_required" }]);
    const decision = loop.decide();
    expect(decision).toMatchObject({ decision: "stop", code: VERIFICATION_APPROVAL_REQUIRED, status: "approval_required" });
    expect(loop.attemptsUsed()).toBe(0);
  });

  it("stops with unavailable when verification never ran at all", () => {
    const never = createVerificationLoop({ maxRepairAttempts: 3, requestedTools: ["test"] });
    expect(never.decide()).toMatchObject({ decision: "stop", code: VERIFICATION_UNAVAILABLE, status: "unavailable" });

    const unconfigured = createVerificationLoop({ maxRepairAttempts: 3, requestedTools: ["test"] });
    unconfigured.record([{ tool: "test", state: "unavailable", code: "tool_not_configured" }]);
    expect(unconfigured.decide()).toMatchObject({ decision: "stop", code: VERIFICATION_UNAVAILABLE });
  });

  it("permits no repair at all when the limit is zero", () => {
    const loop = createVerificationLoop({ maxRepairAttempts: 0, requestedTools: ["test"] });
    loop.record(fail);
    expect(loop.decide()).toMatchObject({ decision: "stop", code: VERIFICATION_REPAIR_EXHAUSTED });
  });

  it("bounds the failure message it carries and never carries raw output", () => {
    const loop = createVerificationLoop({ maxRepairAttempts: 1, requestedTools: ["test"] });
    loop.record([{ tool: "test", state: "failed", code: "verify_failed", message: "x".repeat(5_000) }]);
    const report = loop.report();
    expect(report.schemaVersion).toBe(VERIFICATION_REPORT_SCHEMA_VERSION);
    const message = report.checks[0]?.message ?? "";
    expect(message.length).toBeLessThanOrEqual(400);
    expect(message.endsWith("…")).toBe(true);
  });

  it("tells the model what failed and what it may not do about it", () => {
    const loop = createVerificationLoop({ maxRepairAttempts: 3, requestedTools: ["typecheck", "test"] });
    loop.record([{ tool: "typecheck", state: "failed", code: "typecheck_failed" }]);
    loop.decide();
    const instruction = formatRepairInstruction(loop.report());
    // The failing check is named, so the instruction is actionable...
    expect(instruction).toContain("typecheck: typecheck_failed");
    expect(instruction).toContain("repair attempt 1 of 3");
    // ...and the two prohibitions are stated, because "make it pass" alone is an invitation to delete a test.
    expect(instruction).toContain("Do not delete, skip or weaken a test");
    expect(instruction).toContain("do not");
    expect(instruction).toContain("report success while a check is failing");
  });
});

describe("security-gate: C9 verification loop — the repair limit is configuration, not a dead key", () => {
  it("reads NPATI_CODE_REPAIR_LOOP (a handle that nothing read before C9)", () => {
    expect(resolveCodeAgentLimits({ NPATI_CODE_REPAIR_LOOP: "1" }).repairLoopAttempts).toBe(1);
    expect(resolveCodeAgentLimits({ NPATI_CODE_REPAIR_LOOP: "7" }).repairLoopAttempts).toBe(7);
    expect(resolveCodeAgentLimits({}).repairLoopAttempts).toBe(DEFAULT_CODE_AGENT_LIMITS.repairLoopAttempts);
    // A meaningless value must not silently become "unlimited" or "never repair".
    expect(resolveCodeAgentLimits({ NPATI_CODE_REPAIR_LOOP: "0" }).repairLoopAttempts).toBe(DEFAULT_CODE_AGENT_LIMITS.repairLoopAttempts);
    expect(resolveCodeAgentLimits({ NPATI_CODE_REPAIR_LOOP: "abc" }).repairLoopAttempts).toBe(DEFAULT_CODE_AGENT_LIMITS.repairLoopAttempts);
  });

  it("changes behaviour when the limit changes, which is what makes it a live handle", () => {
    const one = createVerificationLoop({ maxRepairAttempts: resolveCodeAgentLimits({ NPATI_CODE_REPAIR_LOOP: "1" }).repairLoopAttempts, requestedTools: ["test"] });
    one.record(fail);
    expect(one.decide()).toMatchObject({ decision: "repair", attempt: 1 });
    one.record(fail);
    expect(one.decide()).toMatchObject({ decision: "stop" });

    const two = createVerificationLoop({ maxRepairAttempts: resolveCodeAgentLimits({ NPATI_CODE_REPAIR_LOOP: "2" }).repairLoopAttempts, requestedTools: ["test"] });
    two.record(fail);
    two.decide();
    two.record(fail);
    // The same failure sequence reaches a second repair only because the configured limit is larger.
    expect(two.decide()).toMatchObject({ decision: "repair", attempt: 2 });
  });

  it("reads the scope-guard threshold from the environment", () => {
    expect(resolveCodeAgentLimits({ NPATI_CODE_MAX_CHANGED_FILES: "3" }).maxChangedFiles).toBe(3);
    expect(resolveCodeAgentLimits({}).maxChangedFiles).toBe(DEFAULT_CODE_AGENT_LIMITS.maxChangedFiles);
  });
});
