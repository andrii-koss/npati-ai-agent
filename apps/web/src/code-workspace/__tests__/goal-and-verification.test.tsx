import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { AgentStreamView } from "../AgentStreamView";
import type { AgentStreamItem } from "../types";

/**
 * [C9-web] [security-gate] Goal, acceptance criteria, verification and self-review inside the Plan/Todo block.
 *
 * Rendered with `react-dom/server` (this repository has no jsdom by the owner's decision), which is enough to
 * prove what the DOM receives — and what the DOM receives is the whole point of the security assertions here:
 *
 *  - a *blank* area must never stand in for a good result. "no criteria", "not run" and "unavailable" each get
 *    explicit wording, because the failure mode we care about is a user reading an empty box as success;
 *  - everything the server sends (objective, criterion text, file paths, findings) is a text node. A model can
 *    be told to name a file `<img src=x onerror=…>`, so the payloads below are planted in exactly those fields.
 */

function render(items: readonly AgentStreamItem[], isUk = false): string {
  return renderToStaticMarkup(<AgentStreamView items={items} isUk={isUk} />);
}

const fullPlan: AgentStreamItem = {
  kind: "plan",
  title: "Add retry to the uploader",
  steps: [
    { text: "read the uploader", done: true },
    { text: "add retry", done: false },
  ],
  goal: {
    goalId: "goal-1",
    objective: "Uploads survive a transient network failure",
    status: "verifying",
    progress: 0.5,
    criteria: [
      { id: "c1", text: "retry is covered by a test", status: "verified" },
      { id: "c2", text: "no change to the public API", status: "pending" },
      { id: "c3", text: "backoff is bounded", status: "failed", note: "no upper bound" },
    ],
    tasks: [
      { taskId: "t1", content: "read the uploader", status: "completed" },
      { taskId: "t2", content: "add retry", status: "in_progress" },
      { taskId: "t3", content: "run the suite", status: "pending", blockedReason: "needs the sandbox" },
    ],
  },
  verification: {
    status: "passed_with_unjustified_test_changes",
    attemptsUsed: 2,
    maxAttempts: 3,
    checks: [
      { check: "typecheck", status: "passed" },
      { check: "test", status: "failed", errorCode: "command_failed", message: "1 test failed" },
    ],
    testIntegrityFindings: [
      { path: "src/upload.test.ts", kind: "skip_added", reason: "skip added to a failing case", justified: false },
      { path: "src/other.test.ts", kind: "case_count_reduced", reason: "two cases removed", justified: true },
    ],
  },
  selfReview: {
    status: "findings",
    iterationsUsed: 1,
    findings: [
      { severity: "error", path: "src/upload.ts", reason: "hard-coded timeout", suggestedFix: "read it from config" },
      { severity: "warning", reason: "no test for the timeout branch" },
    ],
  },
};

describe("[C9-web] goal, criteria and progress", () => {
  it("renders the goal, its status, progress and every criterion with its own status", () => {
    const markup = render([fullPlan]);
    expect(markup).toContain('data-kind="goal"');
    expect(markup).toContain("Uploads survive a transient network failure");
    expect(markup).toContain("verifying");
    expect(markup).toContain('data-progress-percent="50"');
    expect(markup).toContain("50% (1/3 criteria verified)");
    expect(markup).toContain('data-criterion-id="c1"');
    expect(markup).toContain('data-criterion-status="verified"');
    expect(markup).toContain('data-criterion-status="failed"');
    expect(markup).toContain("✗ backoff is bounded");
  });

  it("keeps the C7 plan contract (data-kind, ✓/• steps) while adding the C9 fields", () => {
    const markup = render([fullPlan]);
    expect(markup).toContain('data-kind="plan"');
    expect(markup).toContain("✓ read the uploader");
    expect(markup).toContain("• add retry");
  });

  it("shows current, completed and blocked tasks, with the reason for each blocked one", () => {
    const markup = render([fullPlan]);
    expect(markup).toContain("Current: add retry");
    expect(markup).toContain('data-completed-count="1"');
    expect(markup).toContain("blocked-task-id=\"t3\"");
    expect(markup).toContain("needs the sandbox");
  });

  it("says that completion cannot be certified when a goal has no acceptance criteria", () => {
    const markup = render([
      {
        kind: "plan",
        steps: [],
        goal: { goalId: "g", objective: "Do something", status: "running", progress: 0, criteria: [], tasks: [] },
      },
    ]);
    // An empty criteria list would read as "nothing outstanding"; the block must refuse that reading.
    expect(markup).toContain('data-kind="goal-criteria-missing"');
    expect(markup).toContain("No acceptance criteria are defined");
  });

  it("distinguishes a goal blocked on a question from one blocked for a technical reason", () => {
    const base = {
      kind: "plan" as const,
      steps: [],
      goal: {
        goalId: "g",
        objective: "x",
        status: "blocked" as const,
        progress: 0,
        criteria: [{ id: "c", text: "y", status: "pending" as const }],
        tasks: [],
      },
    };
    const awaiting = render([{ ...base, goal: { ...base.goal, awaitingAnswer: true } }]);
    const technical = render([{ ...base, goal: { ...base.goal, blockedReason: "sandbox unavailable" } }]);
    expect(awaiting).toContain('data-kind="goal-blocked-awaiting-answer"');
    expect(technical).toContain('data-kind="goal-blocked"');
    expect(technical).toContain("sandbox unavailable");
    expect(awaiting).not.toContain('data-kind="goal-blocked"');
  });

  it("renders no goal section at all for a C1–C8 session that has none", () => {
    const markup = render([{ kind: "plan", title: "Plan", steps: [{ text: "step" }] }]);
    expect(markup).toContain('data-kind="plan"');
    expect(markup).not.toContain('data-kind="goal"');
    expect(markup).not.toContain('data-kind="verification"');
  });
});

describe("[C9-web] verification, repair attempts and test integrity", () => {
  it("renders the verification status, the repair attempts used against the limit, and each check", () => {
    const markup = render([fullPlan]);
    expect(markup).toContain('data-verification-status="passed_with_unjustified_test_changes"');
    expect(markup).toContain("Repair attempts: 2/3");
    expect(markup).toContain('data-attempts-used="2"');
    expect(markup).toContain('data-check="typecheck"');
    expect(markup).toContain('data-check-status="failed"');
    expect(markup).toContain("command_failed");
  });

  it("marks test changes as justified or unjustified instead of hiding them", () => {
    const markup = render([fullPlan]);
    expect(markup).toContain('data-kind="test-integrity-findings"');
    expect(markup).toContain('data-integrity-kind="skip_added"');
    expect(markup).toContain("(unjustified)");
    expect(markup).toContain("(justified)");
  });

  it("shows 'not run' rather than nothing when verification never ran", () => {
    const markup = render([
      {
        kind: "plan",
        steps: [],
        verification: { status: "not_run", checks: [], attemptsUsed: 0, maxAttempts: 3 },
        selfReview: { status: "not_run", findings: [] },
      },
    ]);
    expect(markup).toContain('data-verification-status="not_run"');
    expect(markup).toContain("Status: not run");
    expect(markup).toContain('data-self-review-status="not_run"');
  });

  it("shows the server's reason when verification is unavailable instead of a substitute status", () => {
    const markup = render([
      {
        kind: "plan",
        steps: [],
        verification: {
          status: "unavailable",
          checks: [],
          attemptsUsed: 0,
          maxAttempts: null,
          unavailable: "verify_runner_not_configured",
        },
      },
    ]);
    expect(markup).toContain('data-kind="verification-unavailable"');
    expect(markup).toContain("verify_runner_not_configured");
    expect(markup).toContain("Repair attempts: 0");
  });

  it("renders self-review findings with severity, path and suggested fix", () => {
    const markup = render([fullPlan]);
    expect(markup).toContain('data-self-review-status="findings"');
    expect(markup).toContain('data-severity="error"');
    expect(markup).toContain("[error] src/upload.ts: hard-coded timeout");
    expect(markup).toContain("read it from config");
    expect(markup).toContain("[warning] no test for the timeout branch");
  });
});
