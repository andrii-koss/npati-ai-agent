import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ApprovalCard } from "../ApprovalCard";
import { approvalDecisionPayload, approvalDecisionPlan, approvalScopeLabel } from "../actions";
import type { ApprovalCardData } from "../types";

/**
 * [C7-web] [security-gate] approval flow.
 *
 * Two halves, deliberately separated:
 *  - the **card** renders what will happen (diff, or command with cwd) and offers the four answers;
 *  - the **mapping** (`approvalDecisionPlan`) turns an answer into requests against the existing APIs.
 * The mapping is where the security property lives: `once` and `deny` must never create a standing rule,
 * a session rule must name the command shape, and a project rule must carry the project id.
 */

const card: ApprovalCardData = {
  approvalId: "appr-1",
  action: "code.shell.exec:npm:test",
  riskLevel: "medium",
  command: "npm test -- --run",
  cwd: "/workspace",
  diff: "@@ -1 +1 @@\n- a\n+ b",
  filePaths: ["src/sum.ts"],
  expiresAt: "2026-10-06T10:00:00.000Z",
};

describe("[C7-web] [security-gate] approval card and decision mapping", () => {
  it("offers exactly the four scopes with their labels", () => {
    const markup = renderToStaticMarkup(React.createElement(ApprovalCard, { data: card, onDecision: () => {} }));
    for (const scope of ["once", "session", "project", "deny"]) {
      expect(markup).toContain(`data-scope="${scope}"`);
      expect(markup).toContain(approvalScopeLabel(scope as never, false));
    }
    expect(markup).toContain("Approve once");
    expect(markup).toContain("Approve for session");
    expect(markup).toContain("Approve for project");
    expect(markup).toContain("Deny");
  });

  it("shows the command together with its working directory and the diff", () => {
    const markup = renderToStaticMarkup(React.createElement(ApprovalCard, { data: card, onDecision: () => {} }));
    expect(markup).toContain("npm test -- --run");
    expect(markup).toContain("cwd: /workspace");
    expect(markup).toContain('data-field="approval-diff"');
    expect(markup).toContain("src/sum.ts");
    expect(markup).toContain('data-approval-id="appr-1"');
  });

  it("renders read-only with a notice when the feature flag is off", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ApprovalCard, { data: card, disabled: true, onDecision: () => {} })
    );
    expect(markup).toContain('data-field="approval-disabled"');
    expect(markup).toContain("disabled");
    expect(markup).not.toContain('data-field="approval-expiry"');
  });

  it("maps 'approve once' to a decision only — never a standing rule", () => {
    const plan = approvalDecisionPlan({ companyId: "c1", approval: card, scope: "once" });
    expect(plan.decide.path).toBe("/companies/c1/approvals/appr-1/decide");
    expect(plan.decide.body).toEqual({ decision: "approved" });
    expect(plan.rule).toBeUndefined();
  });

  it("maps 'approve for session' to a decision plus a command-shaped session rule", () => {
    const plan = approvalDecisionPlan({ companyId: "c1", approval: card, scope: "session", sessionId: "s1" });
    expect(plan.decide.body).toEqual({ decision: "approved" });
    expect(plan.rule?.path).toBe("/companies/c1/code/approval-rules");
    expect(plan.rule?.body).toEqual({
      scope: "session",
      action: card.action,
      sessionId: "s1",
      command: card.command,
    });
  });

  it("maps 'approve for project' to a decision plus a project-scoped rule", () => {
    const plan = approvalDecisionPlan({ companyId: "c1", approval: card, scope: "project", projectId: "p1" });
    expect(plan.rule?.body).toEqual({
      scope: "project",
      action: card.action,
      projectId: "p1",
      command: card.command,
    });
    expect(plan.summary).toBe("approved for project");
  });

  it("maps 'deny' to a rejection carrying the comment, and creates no rule", () => {
    const plan = approvalDecisionPlan({
      companyId: "c1",
      approval: card,
      scope: "deny",
      comment: "  this command rewrites the lockfile  ",
    });
    expect(plan.decide.body).toEqual({ decision: "rejected", notes: "this command rewrites the lockfile" });
    expect(plan.rule).toBeUndefined();
  });

  it("omits the notes field when deny has no comment", () => {
    expect(approvalDecisionPayload("deny", "   ")).toEqual({ decision: "rejected" });
    expect(approvalDecisionPayload("deny", undefined)).toEqual({ decision: "rejected" });
  });

  it("never approves anything through the deny path, or vice versa", () => {
    for (const scope of ["once", "session", "project"] as const) {
      expect(approvalDecisionPayload(scope)).toEqual({ decision: "approved" });
    }
    expect(approvalDecisionPayload("deny", "no")).toMatchObject({ decision: "rejected" });
  });
});
