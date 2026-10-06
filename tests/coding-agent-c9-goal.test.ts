import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CodeGoalAcceptanceUnverifiedError,
  type AuthContext,
  type CodeGoalCriterionRecord,
  type CodeGoalRecord,
  type CodeGoalStatus,
  type CodeGoalWithCriteria,
  type CodeSessionTodoRecord,
} from "@npati/workspace";
import { CodeRbac, createRoleRegistry, requiredPermissionForAction, type CodeAuthorizationAuditPort } from "../apps/agent-api/src/code-rbac";
import type { CodeAuditPort } from "../apps/agent-api/src/code-project-trust";
import {
  computeGoalProgress,
  createGoal,
  readGoal,
  setCriterionStatus,
  transitionGoal,
  CODE_GOAL_TRANSITIONS,
  type CodeGoalServiceStore,
} from "../apps/agent-api/src/code-goal-service";
import { registerCodeGoalRoutes, CODE_GOAL_ACTIONS, type CodeGoalRouteDeps, type CodeGoalRouteStore } from "../apps/agent-api/src/code-goal-routes";

/**
 * C9 security-gate: goals, acceptance criteria and the goal/plan HTTP surface.
 *
 * What this suite pins and why:
 *  - **A goal is not complete because the code was written.** Completion is a transition like any other and
 *    the store refuses it while an acceptance criterion is unverified (`goal_acceptance_unverified`). The
 *    fake store here enforces exactly the real contract, so the refusal is exercised rather than assumed.
 *  - **`blocked` is a state, not an error.** It requires the question the agent needs answered, and leaving
 *    `blocked` clears it, so the workspace cannot show a stale prompt forever.
 *  - **Progress is derived, never supplied.**
 *  - **Every mutation is journalled before it is applied**, and a failing journal means it did not happen.
 *  - **Authorization uses named actions**, so an unmapped action is refused rather than falling back to a
 *    convenient label, and a principal without the permission is refused before the store is touched.
 *  - **A foreign goal is indistinguishable from a missing one** (`goal_not_found`), so the surface is not an
 *    existence oracle for other tenants.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";
const SESSION = "session-1";

function criterion(overrides: Partial<CodeGoalCriterionRecord> = {}): CodeGoalCriterionRecord {
  return {
    id: "criterion-1",
    goalId: "goal-1",
    companyId: COMPANY,
    position: 0,
    criterion: "multiply returns the product",
    status: "pending",
    evidence: null,
    verifiedBy: null,
    verifiedAt: null,
    ...overrides,
  };
}

function goal(overrides: Partial<CodeGoalWithCriteria> = {}): CodeGoalWithCriteria {
  return {
    id: "goal-1",
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: null,
    objective: "add multiply to src/sum.ts",
    constraints: [],
    status: "planned",
    blockedReason: null,
    question: null,
    progressCompleted: 0,
    progressTotal: 1,
    revision: 1,
    createdBy: "user-owner",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    dataClassification: "confidential",
    retentionClass: "standard",
    criteria: [criterion()],
    ...overrides,
  };
}

/**
 * The store fake mirrors the real contract on purpose: the completion rule is enforced here, which is what
 * makes the "unverified criteria" test meaningful instead of tautological.
 */
function goalStore(initial: { goal?: CodeGoalWithCriteria | null; todos?: CodeSessionTodoRecord[] } = {}) {
  const state = {
    goal: initial.goal === undefined ? goal() : initial.goal,
    todos: initial.todos ?? ([] as CodeSessionTodoRecord[]),
    updates: 0,
    criteriaUpdates: 0,
  };
  const store: CodeGoalServiceStore = {
    createCodeGoal: async (input) => {
      const created = goal({
        objective: input.objective,
        constraints: input.constraints ?? [],
        criteria: input.criteria.map((text, index) => criterion({ id: `criterion-${index + 1}`, criterion: text, position: index })),
        progressTotal: input.criteria.length,
      });
      state.goal = created;
      return created;
    },
    getCodeGoal: async (companyId) => (state.goal && state.goal.companyId === companyId ? state.goal : null),
    listCodeGoals: async (input) => (state.goal && state.goal.companyId === input.companyId ? [state.goal as CodeGoalRecord] : []),
    updateCodeGoal: async (input) => {
      state.updates += 1;
      if (!state.goal) throw new Error("missing");
      if (input.status === "completed" && state.goal.criteria.some((entry) => entry.status !== "verified")) {
        // The real store refuses this; the trigger refuses it in the database too.
        throw new CodeGoalAcceptanceUnverifiedError({
          unverified: state.goal.criteria.filter((entry) => entry.status !== "verified").map((entry) => entry.id),
        });
      }
      state.goal = {
        ...state.goal,
        status: input.status ?? state.goal.status,
        question: "question" in input ? (input.question ?? null) : state.goal.question,
        blockedReason: "blockedReason" in input ? (input.blockedReason ?? null) : state.goal.blockedReason,
        progressCompleted: input.progressCompleted ?? state.goal.progressCompleted,
        progressTotal: input.progressTotal ?? state.goal.progressTotal,
        revision: state.goal.revision + 1,
      };
      return state.goal;
    },
    setCodeGoalCriterionStatus: async (input) => {
      state.criteriaUpdates += 1;
      if (!state.goal) throw new Error("missing");
      state.goal = {
        ...state.goal,
        criteria: state.goal.criteria.map((entry) =>
          entry.id === input.criterionId
            ? { ...entry, status: input.status, evidence: input.evidence ?? null, verifiedBy: input.verifiedBy ?? null }
            : entry,
        ),
      };
      return state.goal;
    },
    listCodeSessionTodos: async (input) => (state.goal?.sessionId === input.sessionId ? state.todos : []),
  };
  return { store, state };
}

describe("security-gate: C9 goals and acceptance criteria", () => {
  describe("the completion rule is structural", () => {
    it("refuses a goal with no acceptance criteria at creation", async () => {
      const { store } = goalStore();
      await expect(createGoal(store, { companyId: COMPANY, projectId: PROJECT, objective: "do something", criteria: [] }))
        .rejects.toMatchObject({ code: "goal_criteria_required" });
      await expect(createGoal(store, { companyId: COMPANY, projectId: PROJECT, objective: "  ", criteria: ["x"] }))
        .rejects.toMatchObject({ code: "goal_update_invalid" });
    });

    it("refuses completion while a criterion is unverified", async () => {
      const { store, state } = goalStore({ goal: goal({ status: "verifying" }) });
      await expect(transitionGoal(store, { companyId: COMPANY, goalId: "goal-1", expectedRevision: 1, status: "completed" }))
        .rejects.toMatchObject({ code: "goal_acceptance_unverified" });
      // The refusal happened before the write: the goal is still where it was.
      expect(state.goal?.status).toBe("verifying");
    });

    it("allows completion once every criterion is verified", async () => {
      const { store, state } = goalStore({ goal: goal({ status: "verifying" }) });
      const verified = await setCriterionStatus(store, {
        companyId: COMPANY, goalId: "goal-1", criterionId: "criterion-1", status: "verified", evidence: "npm test", verifiedBy: "user-owner",
      });
      expect(verified.criteria[0]!.status).toBe("verified");
      const completed = await transitionGoal(store, { companyId: COMPANY, goalId: "goal-1", expectedRevision: state.goal!.revision, status: "completed" });
      expect(completed.status).toBe("completed");
      expect(completed.progress).toMatchObject({ completed: 1, total: 1, source: "criteria" });
    });

    it("has a transition table that makes illegal jumps refusals", async () => {
      expect(CODE_GOAL_TRANSITIONS.completed).toEqual([]);
      const { store } = goalStore({ goal: goal({ status: "planned" }) });
      await expect(transitionGoal(store, { companyId: COMPANY, goalId: "goal-1", expectedRevision: 1, status: "completed" }))
        .rejects.toMatchObject({ code: "goal_transition_invalid", details: { from: "planned", to: "completed" } });
    });
  });

  describe("blocked is a state with a question", () => {
    it("requires the question and clears it when the goal resumes", async () => {
      const { store, state } = goalStore({ goal: goal({ status: "running" }) });
      await expect(transitionGoal(store, { companyId: COMPANY, goalId: "goal-1", expectedRevision: 1, status: "blocked" }))
        .rejects.toMatchObject({ code: "goal_question_required" });

      const blocked = await transitionGoal(store, {
        companyId: COMPANY, goalId: "goal-1", expectedRevision: 1, status: "blocked", question: "Which module should multiply live in?",
      });
      expect(blocked.status).toBe("blocked");
      expect(blocked.question).toBe("Which module should multiply live in?");

      const resumed = await transitionGoal(store, { companyId: COMPANY, goalId: "goal-1", expectedRevision: state.goal!.revision, status: "running" });
      expect(resumed.status).toBe("running");
      expect(resumed.question).toBeNull();
      expect(resumed.blockedReason).toBeNull();
    });
  });

  describe("progress is derived", () => {
    it("counts the linked todos when the goal has them and the criteria otherwise", () => {
      const todos = [
        { status: "completed" as const },
        { status: "in_progress" as const },
        { status: "pending" as const },
      ] as unknown as CodeSessionTodoRecord[];
      expect(computeGoalProgress([criterion()], todos)).toEqual({ completed: 1, total: 3, source: "todos" });
      expect(computeGoalProgress([criterion({ status: "verified" }), criterion({ id: "c2" })], [])).toEqual({
        completed: 1,
        total: 2,
        source: "criteria",
      });
    });
  });

  describe("reads are tenant-scoped", () => {
    it("makes a foreign goal indistinguishable from a missing one", async () => {
      const { store } = goalStore({ goal: goal({ companyId: OTHER_COMPANY }) });
      await expect(readGoal(store, { companyId: COMPANY, goalId: "goal-1" })).rejects.toMatchObject({ code: "goal_not_found" });
      await expect(readGoal(store, { companyId: COMPANY, goalId: "missing" })).rejects.toMatchObject({ code: "goal_not_found" });
    });
  });
});

/* -------------------------------------------------------------------------------------------------------
 * The HTTP surface.
 * ----------------------------------------------------------------------------------------------------- */

interface Route {
  method: string;
  url: string;
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

function fakeInstance(routes: Route[]): FastifyInstance {
  const record = (method: string) => (url: string, handler: Route["handler"]) => { routes.push({ method, url, handler }); };
  return { get: record("get"), post: record("post") } as unknown as FastifyInstance;
}

function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
  const state = { status: 200, body: undefined as unknown };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply, state };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

async function routeHarness(options: { role?: string; auditFails?: boolean; contextMissing?: boolean; goal?: CodeGoalWithCriteria | null } = {}) {
  const routes: Route[] = [];
  const order: string[] = [];
  const state = { creates: 0, updates: 0, criteriaUpdates: 0, decisions: 0 };

  const registry = createRoleRegistry({
    roles: {
      owner: ["workspace:read", "workspace:write", "business:manage"],
      developer: ["workspace:read", "workspace:write"],
      reviewer: ["workspace:read"],
    },
  });
  const rbacAudit: CodeAuthorizationAuditPort = { record: async () => {} };
  const rbac = new CodeRbac({ registry, audit: rbacAudit });

  const audit: CodeAuditPort = {
    record: async () => {
      order.push("audit");
      if (options.auditFails) throw new Error("audit_down");
    },
  };

  const baseGoal = options.goal === undefined ? goal({ status: "running" }) : options.goal;
  const store: CodeGoalRouteStore = {
    getCodeGoal: async () => baseGoal,
    listCodeGoals: async () => (baseGoal ? [baseGoal as CodeGoalRecord] : []),
    createCodeGoal: async () => { state.creates += 1; order.push("createGoal"); return goal(); },
    updateCodeGoal: async (input) => {
      state.updates += 1;
      order.push("updateGoal");
      return goal({ status: (input.status ?? "running") as CodeGoalStatus, ...(baseGoal ?? {}) });
    },
    setCodeGoalCriterionStatus: async () => { state.criteriaUpdates += 1; order.push("criterion"); return goal(); },
    listCodeSessionTodos: async () => [],
    replaceCodeSessionTodos: async () => [],
    getLatestCodeSessionPlan: async () => null,
    listCodeSessionPlans: async () => [],
    decideCodeSessionPlan: async () => { state.decisions += 1; order.push("decide"); throw new Error("unused"); },
  };

  const deps: CodeGoalRouteDeps = {
    store,
    authorize: (context, companyId, input) => rbac.authorize(context, companyId, input),
    getAuthContext: () => (options.contextMissing ? null : {
      workspaceId: "ws-c9",
      userId: "user-1",
      permissions: [],
      ...(options.role ? { role: options.role } : {}),
    } as unknown as AuthContext),
    audit,
  };

  await registerCodeGoalRoutes(fakeInstance(routes), deps);
  const call = async (method: string, url: string, request: Record<string, unknown>) => {
    const route = routes.find((entry) => entry.method === method && entry.url === url);
    if (!route) throw new Error(`route not registered: ${method} ${url}`);
    const { reply, state: replyState } = fakeReply();
    await route.handler({ params: {}, query: {}, body: {}, ...request }, reply);
    return replyState;
  };
  return { call, state, order };
}

describe("security-gate: C9 goal and plan surface", () => {
  it("maps every new action to a permission, so no action can be authorized by a label", () => {
    for (const action of Object.values(CODE_GOAL_ACTIONS)) {
      expect(requiredPermissionForAction(action)).toBeTruthy();
    }
    expect(requiredPermissionForAction("code.goal.destroy")).toBeNull();
  });

  it("refuses a principal without the required permission before touching the store", async () => {
    const { call, state } = await routeHarness({ role: "reviewer" });
    const result = await call("post", "/companies/:companyId/code/goals", {
      params: { companyId: COMPANY },
      body: { projectId: PROJECT, objective: "x", criteria: ["y"] },
    });
    expect(result.status).toBe(403);
    expect(errorCode(result.body)).toBe("permission_denied");
    expect(state.creates).toBe(0);
  });

  it("answers unauthorized when there is no authenticated context", async () => {
    const { call } = await routeHarness({ contextMissing: true });
    const result = await call("get", "/companies/:companyId/code/goals", { params: { companyId: COMPANY } });
    expect(result.status).toBe(401);
    expect(errorCode(result.body)).toBe("unauthorized");
  });

  it("journals before the mutation and applies nothing when the journal is unavailable", async () => {
    const failing = await routeHarness({ role: "owner", auditFails: true });
    const refused = await failing.call("post", "/companies/:companyId/code/goals", {
      params: { companyId: COMPANY },
      body: { projectId: PROJECT, objective: "x", criteria: ["y"] },
    });
    expect(refused.status).toBe(500);
    expect(failing.state.creates).toBe(0);
    expect(failing.order).toEqual(["audit"]);

    const ok = await routeHarness({ role: "owner" });
    await ok.call("post", "/companies/:companyId/code/goals", {
      params: { companyId: COMPANY },
      body: { projectId: PROJECT, objective: "x", criteria: ["y"] },
    });
    expect(ok.order).toEqual(["audit", "createGoal"]);
  });

  it("requires a revision and a question where the contract does", async () => {
    const { call } = await routeHarness({ role: "owner" });
    const noRevision = await call("post", "/companies/:companyId/code/goals/:goalId/status", {
      params: { companyId: COMPANY, goalId: "goal-1" },
      body: { status: "running" },
    });
    expect(noRevision.status).toBe(400);
    expect(errorCode(noRevision.body)).toBe("invalid_arguments");

    const noQuestion = await call("post", "/companies/:companyId/code/goals/:goalId/status", {
      params: { companyId: COMPANY, goalId: "goal-1" },
      body: { status: "blocked", expectedRevision: 1 },
    });
    expect(noQuestion.status).toBe(400);
    expect(errorCode(noQuestion.body)).toBe("goal_question_required");
  });

  it("reports a goal that is not there as not found, never as an empty success", async () => {
    const { call } = await routeHarness({ role: "owner", goal: null });
    const result = await call("get", "/companies/:companyId/code/goals/:goalId", {
      params: { companyId: COMPANY, goalId: "goal-1" },
    });
    expect(result.status).toBe(404);
    expect(errorCode(result.body)).toBe("goal_not_found");
  });
});
