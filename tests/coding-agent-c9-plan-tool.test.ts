import { describe, expect, it } from "vitest";
import type { CodePlanBody, CodeSessionPlanRecord, CodeSessionTodoRecord } from "@npati/workspace";
import { MAX_TODO_TASKS } from "@npati/workspace";
import {
  CODE_TOOL_MANIFEST_VERSION,
  PUBLISHED_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V5_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V6_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V7_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V8_TOOL_SCHEMA_CHECKSUM,
  resolveManifestForSession,
  toolSchemaChecksum,
  CODE_TOOL_SCHEMAS,
} from "../apps/agent-api/src/code-tool-registry";
import { allCanonicalExecutors } from "../apps/agent-api/src/code-tool-executors";
import type { CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";
import {
  CodePlanToolError,
  planContentHash,
  planToTodoTasks,
  proposePlan,
  todoListHash,
  updateSessionTodos,
  type CodePlanToolStore,
} from "../apps/agent-api/src/code-plan-tool";

/**
 * C9 security-gate: the planning tools.
 *
 * What this suite pins and why:
 *  - **A plan is data.** The tool input is handed over whole, and `validatePlanBody` keeps only the four
 *    fields a plan may carry, so a plan that smuggles `executionMode: "full_auto_sandbox"` cannot store a mode
 *    at all. The mode a plan runs in is chosen by the user (see `coding-agent-c9-plan-mode.test.ts`).
 *  - **Refusal, not normalisation.** Two `in_progress` tasks, a duplicate task id or an oversized list are
 *    refused with a structured error; the store is not called. Silently demoting the second task would hide an
 *    inconsistent model output and let the model keep believing both tasks are running.
 *  - **Idempotency is structural**, because C6a recovery repeats read-only tool calls: an identical draft
 *    proposal returns the same revision, and an identical todo list is a no-op. A repeat can therefore never
 *    duplicate a revision or a task.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";

function planBody(overrides: Partial<CodePlanBody> = {}): CodePlanBody {
  return { files: ["src/sum.ts"], steps: ["read src/sum.ts", "add multiply"], risks: [], testStrategy: "unit", ...overrides };
}

function planRecord(revision: number, status: CodeSessionPlanRecord["status"], plan: CodePlanBody): CodeSessionPlanRecord {
  return {
    id: `plan-${revision}`,
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: null,
    revision,
    status,
    plan,
    executionMode: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    createdBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    dataClassification: "confidential",
    retentionClass: "standard",
  };
}

function todoRecord(taskId: string, content: string, status: CodeSessionTodoRecord["status"], position: number): CodeSessionTodoRecord {
  return {
    id: `todo-${position}`,
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    goalId: null,
    taskId,
    content,
    status,
    position,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    dataClassification: "confidential",
    retentionClass: "standard",
  };
}

function harness(options: { latest?: CodeSessionPlanRecord | null; todos?: CodeSessionTodoRecord[] } = {}) {
  const state = {
    latest: options.latest ?? null,
    todos: options.todos ?? ([] as CodeSessionTodoRecord[]),
    createdPlans: 0,
    replacedTodos: 0,
    lastPlan: null as CodePlanBody | null,
    lastTasks: null as unknown,
  };
  const store: CodePlanToolStore = {
    getLatestCodeSessionPlan: async () => state.latest,
    createCodeSessionPlan: async (input) => {
      state.createdPlans += 1;
      state.lastPlan = input.plan;
      const created = planRecord((state.latest?.revision ?? 0) + 1, "draft", input.plan);
      state.latest = created;
      return created;
    },
    listCodeSessionTodos: async () => state.todos,
    replaceCodeSessionTodos: async (input) => {
      state.replacedTodos += 1;
      state.lastTasks = input.tasks;
      state.todos = input.tasks.map((task, index) => todoRecord(task.taskId, task.content, task.status, index));
      return state.todos;
    },
  };
  return { store, state };
}

describe("security-gate: C9 planning tools", () => {
  describe("the published manifest", () => {
    it("publishes the planning tools in their own version and keeps the earlier versions frozen without them", () => {
      // The split this step had to close: the generated artifacts already carried 24 tools while the registry
      // still said v5, so a session resolving the manifest saw 22 tools and everything looked consistent. Both
      // halves are pinned here — the new version publishes the tools, and every older version still resolves to
      // exactly the set sessions created before it started with.
      //
      // The current version moved on to v7 when `code.ask_user` was published, to v8 when C11 published the
      // eleven `code.git.*` tools and to v9 when C12 published `code.agent.spawn`. The v6 assertions below are
      // about the frozen set v6 always was: 24 tools, and `code.ask_user` is not one of them. v7 stays frozen at
      // 25 and v8 at 36; neither may gain a later tool.
      expect(CODE_TOOL_MANIFEST_VERSION).toBe(11);
      expect(PUBLISHED_TOOL_SCHEMA_CHECKSUM).toBe(toolSchemaChecksum(CODE_TOOL_SCHEMAS));
      expect(CODE_TOOL_SCHEMAS).toHaveLength(43);

      const v5 = resolveManifestForSession(5);
      const v6 = resolveManifestForSession(6);
      const v7 = resolveManifestForSession(7);
      const v8 = resolveManifestForSession(8);
      expect(v5.tools).toHaveLength(22);
      expect(v6.tools).toHaveLength(24);
      expect(v7.tools).toHaveLength(25);
      expect(v8.tools).toHaveLength(36);
      expect(v5.checksum).toBe(PUBLISHED_V5_TOOL_SCHEMA_CHECKSUM);
      expect(v6.checksum).toBe(PUBLISHED_V6_TOOL_SCHEMA_CHECKSUM);
      expect(v7.checksum).toBe(PUBLISHED_V7_TOOL_SCHEMA_CHECKSUM);
      expect(v8.checksum).toBe(PUBLISHED_V8_TOOL_SCHEMA_CHECKSUM);
      expect(v5.tools.map((tool) => tool.name)).not.toContain("code.plan.propose");
      expect(v5.tools.map((tool) => tool.name)).not.toContain("code.plan.update");
      expect(v6.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["code.plan.propose", "code.plan.update"]));
      // v6 is frozen at the tool set it was published with: the newest tool must not leak into it.
      expect(v6.tools.map((tool) => tool.name)).not.toContain("code.ask_user");
      // C11: v7 is frozen the same way — a session created before the git tools must not see them.
      expect(v7.tools.map((tool) => tool.name)).toContain("code.ask_user");
      for (const gitTool of ["code.git.status", "code.git.push", "code.git.pr.create"]) {
        expect(v7.tools.map((tool) => tool.name), `${gitTool} must not leak into v7`).not.toContain(gitTool);
      }
      // C12: v8 is frozen the same way — a session created before the delegation tool must not see it, and it
      // must hold every git tool it was published with.
      expect(v8.tools.map((tool) => tool.name), "code.agent.spawn must not leak into v8").not.toContain("code.agent.spawn");
      expect(v8.tools.map((tool) => tool.name)).toContain("code.git.push");
      const current = resolveManifestForSession(CODE_TOOL_MANIFEST_VERSION);
      expect(current.tools).toHaveLength(43);
      expect(current.tools.map((tool) => tool.name)).toContain("code.ask_user");
      expect(current.tools.map((tool) => tool.name)).toContain("code.git.push");
      expect(current.tools.map((tool) => tool.name)).toContain("code.agent.spawn");
    });

    it("registers an executor for the planning tools, so publishing them cannot leave them dead", async () => {
      // The recurring defect this guards against: a tool published in the registry (and therefore visible in the
      // Capability Inspector) with nothing able to run it — the `runCtags` shape. Both halves are asserted.
      const executors = allCanonicalExecutors({});
      expect(typeof executors["code.plan.propose"]).toBe("function");
      expect(typeof executors["code.plan.update"]).toBe("function");

      // And with no port wired they fail closed rather than silently doing nothing.
      const context = {
        ctx: { workspaceId: "ws", userId: "u", permissions: [] },
        companyId: "c",
        projectId: "p",
        sessionId: "s",
        tool: { name: "code.plan.update", version: 1 },
        args: { tasks: [] },
        limits: {},
      } as unknown as CodeToolExecutionContext;
      await expect(executors["code.plan.update"]!(context)).rejects.toMatchObject({ code: "tool_not_configured" });
    });
  });

  describe("code.plan.propose", () => {
    it("refuses a plan with no steps and never touches the store", async () => {
      const { store, state } = harness();
      await expect(proposePlan(store, { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, plan: { steps: [] } }))
        .rejects.toMatchObject({ code: "plan_body_invalid" });
      expect(state.createdPlans).toBe(0);
    });

    it("keeps only the four fields a plan may carry, so a mode cannot be smuggled in", async () => {
      const { store, state } = harness();
      const result = await proposePlan(store, {
        companyId: COMPANY,
        projectId: PROJECT,
        sessionId: SESSION,
        // A hostile plan: a permissive mode and an invented field travel alongside the real content.
        plan: { steps: ["a"], files: [], risks: [], testStrategy: "", executionMode: "full_auto_sandbox", permissions: ["workspace:write"] },
      });
      expect(result.planRevision).toBe(1);
      expect(state.lastPlan).not.toBeNull();
      expect(Object.keys(state.lastPlan!).sort()).toEqual(["files", "risks", "steps", "testStrategy"]);
      expect(state.lastPlan).not.toHaveProperty("executionMode");
      expect(state.lastPlan).not.toHaveProperty("permissions");
      // The stored body is exactly the sanitised content: the smuggled keys are gone, not merely ignored by
      // the hash, so nothing downstream can read them back either.
      expect(state.lastPlan).toEqual({ files: [], steps: ["a"], risks: [], testStrategy: "" });
    });

    it("is idempotent: proposing the same draft twice returns the same revision and writes once", async () => {
      const { store, state } = harness();
      const plan = planBody();
      const first = await proposePlan(store, { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, plan });
      const second = await proposePlan(store, { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, plan: planBody() });
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.planRevision).toBe(first.planRevision);
      expect(state.createdPlans).toBe(1);
    });

    it("creates a new revision when the previous one was already decided", async () => {
      const { store, state } = harness({ latest: planRecord(1, "approved", planBody()) });
      const result = await proposePlan(store, { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, plan: planBody() });
      // Same content, but the previous revision is history: a new draft is a genuinely new proposal.
      expect(result.deduplicated).toBe(false);
      expect(result.planRevision).toBe(2);
      expect(state.createdPlans).toBe(1);
    });

    it("turns plan steps into pending todos with reproducible ids", () => {
      const tasks = planToTodoTasks(planBody({ steps: ["one", "two"] }), SESSION);
      expect(tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
      expect(tasks.map((task) => task.taskId)).toEqual([`${SESSION}:plan:1`, `${SESSION}:plan:2`]);
      // Reproducible: the same plan produces the same ids, so a replay cannot duplicate tasks.
      expect(planToTodoTasks(planBody({ steps: ["one", "two"] }), SESSION)).toEqual(tasks);
    });
  });

  describe("code.plan.update", () => {
    it("refuses two in_progress tasks instead of normalising them", async () => {
      const { store, state } = harness();
      await expect(updateSessionTodos(store, {
        companyId: COMPANY,
        projectId: PROJECT,
        sessionId: SESSION,
        tasks: [
          { taskId: "a", content: "one", status: "in_progress" },
          { taskId: "b", content: "two", status: "in_progress" },
        ],
      })).rejects.toMatchObject({ code: "todo_list_invalid" });
      expect(state.replacedTodos).toBe(0);
    });

    it("refuses a duplicate task id and an oversized list", async () => {
      const { store } = harness();
      await expect(updateSessionTodos(store, {
        companyId: COMPANY,
        projectId: PROJECT,
        sessionId: SESSION,
        tasks: [
          { taskId: "a", content: "one", status: "pending" },
          { taskId: "a", content: "two", status: "pending" },
        ],
      })).rejects.toMatchObject({ code: "todo_list_invalid" });

      const oversized = Array.from({ length: MAX_TODO_TASKS + 1 }, (_, index) => ({ taskId: `t${index}`, content: "x", status: "pending" as const }));
      await expect(updateSessionTodos(store, { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, tasks: oversized }))
        .rejects.toMatchObject({ code: "todo_list_invalid" });
    });

    it("is idempotent: an identical list writes once and reports the same counts", async () => {
      const { store, state } = harness();
      const tasks = [{ taskId: "a", content: "one", status: "in_progress" as const }];
      const first = await updateSessionTodos(store, { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, tasks });
      const second = await updateSessionTodos(store, { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, tasks });
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second).toMatchObject({ tasks: 1, inProgress: 1, pending: 0, completed: 0 });
      expect(state.replacedTodos).toBe(1);
    });

    it("hashes the list order-independently, so reordering alone is not a change", () => {
      const a = [{ taskId: "a", content: "one", status: "pending" as const }, { taskId: "b", content: "two", status: "pending" as const }];
      expect(todoListHash(a)).toBe(todoListHash([...a].reverse()));
      expect(todoListHash(a)).not.toBe(todoListHash([{ ...a[0]!, status: "completed" as const }, a[1]!]));
    });

    it("refuses a todo write with no session rather than inventing one", async () => {
      const { store } = harness();
      await expect(updateSessionTodos(store, { companyId: COMPANY, projectId: PROJECT, sessionId: "", tasks: [] }))
        .rejects.toBeInstanceOf(CodePlanToolError);
    });
  });
});
