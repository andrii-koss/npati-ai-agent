import { describe, expect, it } from "vitest";
import type { AuthContext, CodePlanBody, CodeSessionPlanRecord, CodeSessionTodoRecord } from "@npati/workspace";
import { PolicyEngine, PLAN_SAFE_TOOLS, isPlanSafeTool, isReadOnlyTool, isShellTool, MODE_RISK_MATRIX } from "../apps/agent-api/src/code-policy-engine";
import { CODE_RUN_READ_ONLY_TOOLS } from "../apps/agent-api/src/coding-agent-runner";
import { planToTodoTasks } from "../apps/agent-api/src/code-plan-tool";
import { decidePlan, resolveApprovedExecutionMode, type CodePlanModeStore } from "../apps/agent-api/src/code-plan-mode";

/**
 * C9 security-gate: plan mode and the plan decision.
 *
 * What this suite pins and why:
 *  - **A plan cannot raise the session mode.** The approved mode is read from the decision request — i.e. from
 *    the user — and validated against the canonical C5 vocabulary. Even a stored plan row that carries an
 *    `executionMode` key is ignored, which is the same boundary C8 draws for repository instructions: model
 *    output is data, and data does not grant permissions.
 *  - **Plan mode still blocks writes.** The mode was already enforced on three layers before C9; this suite
 *    proves the two new tools did not become an exemption while the old refusals still hold.
 *  - **A decision is a decision.** A stale revision or an already-decided revision is refused before anything
 *    is written, and a rejection changes no todo list at all.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";

const owner: AuthContext = { workspaceId: "ws-c9", userId: "user-owner", permissions: ["workspace:read", "workspace:write", "admin:all"] };

// The fake capability catalogue: a tool that is not listed here is refused at the capability phase before any
// mode rule runs, which is why the assertions below only use published tools. `code.ask_user` **is** published
// now (the C9 follow-up that added its schema, capability 373 and executor), so it is listed here as well — and
// the fail-closed check at the end uses a name nothing ever published.
const KNOWLEDGE_TOOLS = [
  "code.fs.read", "code.fs.grep", "code.fs.diff", "code.fs.tree", "code.project.info",
  "code.fs.write", "code.fs.edit", "code.fs.apply_patch", "code.fs.move", "code.fs.delete",
  "code.fs.undo_last_turn", "code.verify.run", "code.deps.add",
  "code.shell.exec", "code.plan.propose", "code.plan.update", "code.ask_user",
];

function policyEngine(): PolicyEngine {
  return new PolicyEngine({
    flags: { async assertEnabled() { return true; } },
    capabilities: { get: (id: string) => (KNOWLEDGE_TOOLS.includes(id) ? { id, status: "active", version: 1 } : undefined) },
    classifier: () => ({ risk: "safe" as const }),
    networkEnforcement: () => false,
  });
}

function planBody(overrides: Partial<CodePlanBody> = {}): CodePlanBody {
  return { files: ["src/sum.ts"], steps: ["step one", "step two"], risks: ["risk"], testStrategy: "unit", ...overrides };
}

function planRecord(overrides: Partial<CodeSessionPlanRecord> = {}): CodeSessionPlanRecord {
  return {
    id: "plan-1",
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: null,
    revision: 1,
    status: "draft",
    plan: planBody(),
    executionMode: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    createdBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    dataClassification: "confidential",
    retentionClass: "standard",
    ...overrides,
  };
}

function harness(options: { latest?: CodeSessionPlanRecord | null } = {}) {
  const state = {
    latest: options.latest === undefined ? planRecord() : options.latest,
    decisionInput: null as Record<string, unknown> | null,
    replacedTodos: 0,
    lastTasks: null as unknown,
  };
  const store: CodePlanModeStore = {
    getLatestCodeSessionPlan: async () => state.latest,
    decideCodeSessionPlan: async (input) => {
      state.decisionInput = input as unknown as Record<string, unknown>;
      const decided = planRecord({
        revision: input.expectedRevision,
        status: input.decision === "approve" ? "approved" : "rejected",
        executionMode: input.executionMode ?? null,
        decisionNote: input.note ?? null,
        decidedBy: input.decidedBy ?? null,
      });
      state.latest = decided;
      return decided;
    },
    replaceCodeSessionTodos: async (input) => {
      state.replacedTodos += 1;
      state.lastTasks = input.tasks;
      return input.tasks.map((task, index): CodeSessionTodoRecord => ({
        id: `todo-${index}`,
        companyId: COMPANY,
        projectId: PROJECT,
        sessionId: SESSION,
        goalId: input.goalId ?? null,
        taskId: task.taskId,
        content: task.content,
        status: task.status,
        position: index,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        dataClassification: "confidential",
        retentionClass: "standard",
      }));
    },
  };
  return { store, state };
}

describe("security-gate: C9 plan mode and decisions", () => {
  describe("the approved mode comes from the request, never from the plan", () => {
    it("requires a mode to approve and refuses an unknown one", () => {
      expect(() => resolveApprovedExecutionMode("approve", undefined)).toThrowError(/execution mode/i);
      expect(() => resolveApprovedExecutionMode("approve", "yolo")).toThrowError(/Unknown execution mode/);
      expect(() => resolveApprovedExecutionMode("reject", "ask")).toThrowError(/only valid for an approval/);
      expect(resolveApprovedExecutionMode("approve", "ask")).toBe("ask");
    });

    it("ignores a mode smuggled into the stored plan row", async () => {
      // Simulates a row written before the tool sanitised its input: the decision path must not read it.
      const hostile = planRecord({ plan: { ...planBody(), executionMode: "full_auto_sandbox" } as unknown as CodePlanBody });
      const { store, state } = harness({ latest: hostile });
      const result = await decidePlan(store, {
        companyId: COMPANY,
        projectId: PROJECT,
        sessionId: SESSION,
        expectedRevision: 1,
        decision: "approve",
        executionMode: "ask",
        decidedBy: "user-owner",
      });
      expect(result.executionMode).toBe("ask");
      expect(state.decisionInput).toMatchObject({ executionMode: "ask" });
      // Nothing derived from the plan body reached the decision.
      expect(JSON.stringify(state.decisionInput)).not.toContain("full_auto_sandbox");
    });

    it("refuses an approval that carries no mode instead of defaulting to one", async () => {
      const { store, state } = harness();
      await expect(decidePlan(store, {
        companyId: COMPANY,
        projectId: PROJECT,
        sessionId: SESSION,
        expectedRevision: 1,
        decision: "approve",
      })).rejects.toMatchObject({ code: "plan_execution_mode_required" });
      expect(state.decisionInput).toBeNull();
      expect(state.replacedTodos).toBe(0);
    });
  });

  describe("approve and reject", () => {
    it("turns the approved plan into a pending todo list", async () => {
      const { store, state } = harness();
      const result = await decidePlan(store, {
        companyId: COMPANY,
        projectId: PROJECT,
        sessionId: SESSION,
        expectedRevision: 1,
        decision: "approve",
        executionMode: "auto_edit",
        decidedBy: "user-owner",
      });
      expect(result.plan.status).toBe("approved");
      expect(result.todos?.map((todo) => todo.status)).toEqual(["pending", "pending"]);
      expect(state.lastTasks).toEqual(planToTodoTasks(planBody(), SESSION));
      expect(state.replacedTodos).toBe(1);
    });

    it("changes nothing but the decision when the plan is rejected", async () => {
      const { store, state } = harness();
      const result = await decidePlan(store, {
        companyId: COMPANY,
        projectId: PROJECT,
        sessionId: SESSION,
        expectedRevision: 1,
        decision: "reject",
        note: "too risky",
        decidedBy: "user-owner",
      });
      expect(result.plan.status).toBe("rejected");
      expect(result.executionMode).toBeNull();
      expect(result.todos).toBeNull();
      expect(state.replacedTodos).toBe(0);
      expect(state.decisionInput).toMatchObject({ decision: "reject", note: "too risky" });
    });

    it("refuses a stale revision, an already decided plan and a session without a plan", async () => {
      const stale = harness();
      await expect(decidePlan(stale.store, {
        companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, expectedRevision: 7, decision: "approve", executionMode: "ask",
      })).rejects.toMatchObject({ code: "plan_revision_conflict" });
      expect(stale.state.decisionInput).toBeNull();

      const decided = harness({ latest: planRecord({ status: "approved" }) });
      await expect(decidePlan(decided.store, {
        companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, expectedRevision: 1, decision: "reject",
      })).rejects.toMatchObject({ code: "plan_already_decided" });
      expect(decided.state.decisionInput).toBeNull();

      const empty = harness({ latest: null });
      await expect(decidePlan(empty.store, {
        companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, expectedRevision: 1, decision: "approve", executionMode: "ask",
      })).rejects.toMatchObject({ code: "plan_not_found" });
    });
  });

  describe("plan mode still blocks writes", () => {
    it("denies a file write in plan mode", async () => {
      const engine = policyEngine();
      expect(await engine.evaluate({ ctx: owner, companyId: COMPANY, tool: "code.fs.write", paths: ["src/a.ts"], sessionMode: "plan" }))
        .toMatchObject({ decision: "deny", code: "session_mode_denied", phase: "session_mode" });
    });

    it("keeps the documented matrix: safe commands stay allowed in plan mode, everything riskier does not", async () => {
      // This is the real contract from C5 and it is worth stating instead of assuming: plan mode is not
      // "no shell at all" — a command the classifier rates `safe` (tests, type checks) is what lets the agent
      // explore, while `controlled`/`approval`/`hard_deny` are refused. An earlier draft of this suite
      // asserted that every shell command is denied in plan mode, which the matrix contradicted; the test was
      // wrong, not the engine, and the matrix below is the single definition it now pins.
      expect(MODE_RISK_MATRIX.plan).toEqual({ safe: "allow", controlled: "deny", approval: "deny", hard_deny: "deny" });
      const engine = policyEngine();
      const safe = await engine.evaluate({ ctx: owner, companyId: COMPANY, tool: "code.shell.exec", command: "npm test", sessionMode: "plan" });
      expect(safe.decision).toBe("allow");
      // The dirtier command never comes back as an allow, whichever gate refuses it first (the probe showed
      // the network gate firing here because this engine has no egress port wired).
      const controlled = await engine.evaluate({ ctx: owner, companyId: COMPANY, tool: "code.shell.exec", command: "npm install left-pad", sessionMode: "plan" });
      expect(controlled.decision).toBe("deny");
    });

    it("lets the planning tools through in plan mode, which is the mode that produces a plan", async () => {
      const engine = policyEngine();
      for (const tool of ["code.plan.propose", "code.plan.update"]) {
        const result = await engine.evaluate({ ctx: owner, companyId: COMPANY, tool, sessionMode: "plan" });
        expect(result.decision).toBe("allow");
      }
      /**
       * `code.ask_user` is plan-safe by declaration and **is** published now, so plan mode must allow it: asking
       * is what plan mode exists to do when the requirement is ambiguous, and refusing the question would push
       * the agent to guess.
       *
       * This assertion was inverted while the tool was still unpublished ("plan-safe but not published → deny").
       * That state is gone, so the test now pins the behaviour that replaced it instead of a design that was
       * cancelled — and the fail-closed property it was really protecting is checked below, with a name that is
       * published by nothing.
       */
      const asking = await engine.evaluate({ ctx: owner, companyId: COMPANY, tool: "code.ask_user", sessionMode: "plan" });
      expect(asking.decision).toBe("allow");

      // The capability phase runs first, so a tool nobody published is refused before any mode rule — fail closed.
      const unpublished = await engine.evaluate({ ctx: owner, companyId: COMPANY, tool: "code.fs.not_published", sessionMode: "plan" });
      expect(unpublished.decision).toBe("deny");
    });

    /**
     * C9 review: the planning allowance is a **narrow name list**, not "anything read-only".
     *
     * The first implementation put the planning tools inside `READ_TOOLS`, so their plan-mode allowance was a
     * side effect of a broad class: every future read tool would have joined them, and a metadata tool that
     * actually mutates would have needed only to be mislabelled read-only to become available in the one mode
     * that must not touch anything. These assertions pin the separation itself: the planning tools are **not**
     * read-only, the read tools are **not** plan-safe, and the two sets are disjoint — which is exactly why
     * widening the read class can no longer widen plan mode.
     */
    it("keeps the planning allowance a narrow name list instead of the read-only class", () => {
      // v15: `code.finish` ends the run with a summary and touches neither workspace nor sandbox nor network.
      expect([...PLAN_SAFE_TOOLS].sort()).toEqual(["code.ask_user", "code.finish", "code.plan.propose", "code.plan.update"]);
      for (const tool of ["code.plan.propose", "code.plan.update", "code.ask_user"]) {
        expect(isReadOnlyTool(tool)).toBe(false);
        expect(CODE_RUN_READ_ONLY_TOOLS.has(tool)).toBe(false);
      }
      for (const tool of ["code.fs.read", "code.fs.grep", "code.fs.tree", "code.project.info"]) {
        expect(isReadOnlyTool(tool)).toBe(true);
        expect(isPlanSafeTool(tool)).toBe(false);
        // The runner repeats read-only calls after a crash (C6a); a planning or question tool must never be in
        // that set, because repeating it is a decision the reconciler makes without a human.
        expect(CODE_RUN_READ_ONLY_TOOLS.has(tool)).toBe(true);
      }
      // `code.fs.diff` is read-only for policy, but the runner keeps it out of its repeat/parallel set — the two
      // sets have different jobs, so membership must never be inferred from one to the other.
      expect(isReadOnlyTool("code.fs.diff")).toBe(true);
      expect(isPlanSafeTool("code.fs.diff")).toBe(false);
      expect(isPlanSafeTool("code.fs.write")).toBe(false);
      expect(isPlanSafeTool("code.shell.exec")).toBe(false);
    });

    it("refuses every workspace mutation in plan mode while still allowing reads", async () => {
      const engine = policyEngine();
      for (const tool of ["code.fs.read", "code.fs.grep", "code.fs.diff", "code.fs.tree"]) {
        const result = await engine.evaluate({ ctx: owner, companyId: COMPANY, tool, sessionMode: "plan" });
        expect(result.decision).toBe("allow");
      }
      for (const tool of [
        "code.fs.write", "code.fs.edit", "code.fs.apply_patch", "code.fs.move",
        "code.fs.delete", "code.fs.undo_last_turn", "code.verify.run", "code.deps.add",
      ]) {
        const result = await engine.evaluate({ ctx: owner, companyId: COMPANY, tool, sessionMode: "plan" });
        expect(result).toMatchObject({ decision: "deny", code: "session_mode_denied" });
      }
    });
  });
});
