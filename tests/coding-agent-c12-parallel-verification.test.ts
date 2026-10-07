import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import {
  ProjectMultiAgentService,
  PROJECT_VERIFICATION_FAILED,
  PROJECT_VERIFICATION_KINDS,
  summariseProjectVerification,
  type ProjectVerificationPort,
} from "../apps/agent-api/src/project-multi-agent";
import {
  executeProjectTaskGraph,
  ProjectFileLeaseManager,
  taskScopesConflict,
  type ProjectTask,
} from "../apps/agent-api/src/project-task-graph";
import {
  GitConflictError,
  GitConflictEscalationError,
  type ProjectGitService,
} from "../apps/agent-api/src/project-git-service";
import { CODE_SUBAGENT_MAX_PARALLELISM } from "../apps/agent-api/src/code-subagent-limits";

/**
 * C12 security-gate suite: parallel `implement` work, the merge, and the **mandatory** verification after it.
 *
 * The point of this suite is that C12 **reuses** what already existed rather than adding a second way to do any
 * of it, and that the two failure modes the owner named are absent:
 *
 *  - **two parallel changes to different files do not conflict.** They run in the same graph turn under one
 *    `ProjectFileLeaseManager`, each in its own `ProjectGitService` worktree/branch, and each is merged into
 *    `project/main` on its own; the recorded merge calls have disjoint file sets, so nothing had to be resolved.
 *  - **a real conflict produces the structured escalation**, not a crash and not a hang: the existing
 *    `GitConflictEscalationError` (the class that carries `conflictingFiles` and the `code.ask_user` suggestion)
 *    is reported as a `project-merge-conflict` event and the run settles as failed.
 *
 * It also pins the graph's own concurrency contract (disjoint scopes overlap, overlapping scopes serialise) and
 * the final verification the owner asked for: the **existing** C9 loop over the project's configured checks, whose
 * `failed`/`approval_required` states fail the run while `unavailable` is reported and never presented as a pass.
 */

const ctx: AuthContext = { userId: "user-c12", workspaceId: "ws-c12", permissions: ["workspace:write"] };

function task(id: string, paths: string[], role: ProjectTask["role"] = "frontend"): ProjectTask {
  return { id, title: id, role, paths, dependsOn: [], status: "queued" };
}

/** A store good enough for the project service, recording every run event it is asked to persist. */
function projectStore(agentIds: string[]) {
  const events: Array<{ runId: string; event: Record<string, unknown> }> = [];
  const steps: Array<{ runId: string; steps: Array<Record<string, unknown>> }> = [];
  const runs = new Map<string, Record<string, unknown>>();
  const agents = [
    { id: "main", role: "manager", isActive: true, tools: [], modelId: "auto" },
    ...agentIds.map((id) => ({ id, role: "frontend developer", isActive: true, tools: ["project.files.read"], modelId: "auto" })),
  ];
  return {
    events,
    steps,
    runs,
    store: {
      async getCompany() { return { mainAgentId: "main" }; },
      async listCompanyAgents() { return agents; },
      async listCompanyAgentEdges() { return []; },
      async createCompanyAgentRun(_ctx: unknown, _company: string, input: Record<string, unknown>) {
        const run = { id: "run-project-1", status: "queued", result: "", ...input };
        runs.set("run-project-1", run);
        return { run, created: true };
      },
      async updateCompanyAgentRun(_ctx: unknown, _company: string, id: string, patch: Record<string, unknown>) {
        Object.assign(runs.get(id)!, patch);
        return runs.get(id);
      },
      async replaceCompanyAgentRunSteps(_ctx: unknown, _company: string, id: string, next: Array<Record<string, unknown>>) {
        steps.push({ runId: id, steps: next });
        return next;
      },
      async appendCompanyAgentRunEvent(_ctx: unknown, _company: string, id: string, event: Record<string, unknown>) {
        events.push({ runId: id, event });
        return event;
      },
      async getCompanyAgentRun(_ctx: unknown, _company: string, id: string) {
        return { run: runs.get(id), steps: [], toolAudit: [], backgroundEvents: [] };
      },
    },
  };
}

/**
 * A recording stand-in for the **existing** `ProjectGitService`: only the worktree methods the service uses.
 *
 * The slug the service derives is per **task** (`<role>-<taskId>`), so the files each task touches are derived
 * from the slug's task part — which is what makes the two merges disjoint in the parallel case and one of them
 * conflicting in the escalation case.
 */
function recordingGit(options: { conflictOn?: string } = {}) {
  const calls: Array<{ method: string; agentSlug?: string; files?: string[] }> = [];
  const filesFor = (slug: string): string[] => {
    const taskId = slug.split("-").pop() ?? slug;
    return [`src/${taskId}.ts`];
  };
  const git = {
    async ensureRepository() { calls.push({ method: "ensureRepository" }); return { initialized: true }; },
    async branch(_ctx: unknown, _company: string, _project: string, input: { action: string; branch?: string }) {
      calls.push({ method: `branch.${input.action}` });
      return { branches: input.action === "list" ? ["project/main"] : [] };
    },
    async createAgentWorktree(_ctx: unknown, _company: string, _project: string, input: { agentSlug: string; baseBranch?: string }) {
      calls.push({ method: "createAgentWorktree", agentSlug: input.agentSlug, files: filesFor(input.agentSlug) });
      return { worktreePath: `/tmp/wt/${input.agentSlug}`, branch: `agent/${input.agentSlug}`, baseBranch: input.baseBranch ?? "project/main" };
    },
    async commitAgentWorktree(_ctx: unknown, _company: string, _project: string, input: { agentSlug: string }) {
      calls.push({ method: "commitAgentWorktree", agentSlug: input.agentSlug });
      return { committed: true, sha: "abc1234" };
    },
    async diffAgentWorktree(_ctx: unknown, _company: string, _project: string, input: { agentSlug: string }) {
      const files = filesFor(input.agentSlug);
      calls.push({ method: "diffAgentWorktree", agentSlug: input.agentSlug, files });
      return { files, diff: "", truncated: false };
    },
    async mergeAgentWorktree(_ctx: unknown, _company: string, _project: string, input: { agentSlug: string }) {
      calls.push({ method: "mergeAgentWorktree", agentSlug: input.agentSlug, files: filesFor(input.agentSlug) });
      if (options.conflictOn === input.agentSlug) {
        throw new GitConflictEscalationError(
          filesFor(input.agentSlug),
          "merge conflict",
          {
            attempts: 2, maxAttempts: 2, sourceBranch: `agent/${input.agentSlug}`, targetBranch: "project/main",
            suggestedTool: "code.ask_user", question: "Which change should win?",
          },
        );
      }
      return { merged: true };
    },
    async removeAgentWorktree(_ctx: unknown, _company: string, _project: string, input: { agentSlug: string }) {
      calls.push({ method: "removeAgentWorktree", agentSlug: input.agentSlug });
      return { removed: true };
    },
    async cleanupAllWorktrees() { calls.push({ method: "cleanupAllWorktrees" }); return { removed: [] }; },
  };
  return { git: git as unknown as ProjectGitService, calls };
}

const PLAN = JSON.stringify({
  tasks: [
    { id: "t1", title: "Frontend header", role: "frontend", depends_on: [], paths: ["src/frontend.tsx"] },
    { id: "t2", title: "Design tokens", role: "frontend", depends_on: [], paths: ["src/design.css"] },
  ],
});

function projectRuntime(options: { failOn?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      async execute(_ctx: unknown, _company: string, input: { task: string }, key: string) {
        calls.push(key);
        if (key.endsWith(":plan")) return { run: { status: "completed", result: PLAN } };
        const taskId = key.split(":task:")[1] ?? "";
        // The condition is the task's **own** title line: every prompt embeds the peer statuses (which name the
        // other tasks), so a substring match on a title would fail every sibling too.
        if (options.failOn && input.task.includes(`Task: ${options.failOn}`)) {
          throw new Error(`child ${taskId} exploded`);
        }
        return { run: { status: "completed", result: `did ${taskId}` } };
      },
    },
  };
}

describe("security-gate: C12 two parallel changes to different files do not conflict", () => {
  it("runs them in the same graph turn under one lease manager, each in its own worktree", async () => {
    const { store, events } = projectStore(["dev1", "dev2"]);
    const { git, calls } = recordingGit();
    const { runtime } = projectRuntime();
    const service = new ProjectMultiAgentService(
      store as never, runtime as never, { async startPreview() { return {}; } } as never,
      new ProjectFileLeaseManager(), git, undefined, { worktreeMode: true },
    );
    const result = await service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-1");

    expect(result?.run.status).toBe("completed");
    // Two worktrees, two commits, two diffs, two merges — one per task, and never a second merge mechanism.
    expect(calls.filter((call) => call.method === "createAgentWorktree")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "commitAgentWorktree")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "diffAgentWorktree")).toHaveLength(2);
    const merges = calls.filter((call) => call.method === "mergeAgentWorktree");
    expect(merges).toHaveLength(2);
    /**
     * One worktree and one branch **per task**, which is the isolation this path exists to provide. Deriving the
     * slug from the role alone made two parallel tasks of one role share `agent/frontend`, and that defect is
     * pinned here: the two slugs differ, and each names its own task.
     */
    const slugs = calls.filter((call) => call.method === "createAgentWorktree").map((call) => call.agentSlug);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs.sort()).toEqual(["frontend-t1", "frontend-t2"]);
    // Disjoint file sets: nothing had to be resolved, which is what "they do not conflict" means concretely.
    const mergedFiles = merges.flatMap((call) => call.files ?? []);
    expect(new Set(mergedFiles).size).toBe(mergedFiles.length);
    expect(mergedFiles.sort()).toEqual(["src/t1.ts", "src/t2.ts"]);
    // Cleanup happens once, in the `finally`, and every worktree was removed individually first.
    expect(calls.filter((call) => call.method === "removeAgentWorktree")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "cleanupAllWorktrees")).toHaveLength(1);
    // The merges are visible on the run, with their branch and target.
    const mergeEvents = events.filter((entry) => String(entry.event.eventKey).startsWith("project-merge:"));
    expect(mergeEvents).toHaveLength(2);
    for (const entry of mergeEvents) {
      expect(entry.event).toMatchObject({ eventType: "completed", runStatus: "running" });
      expect((entry.event.details as { targetBranch: string }).targetBranch).toBe("project/main");
    }
  });

  it("serialises two tasks whose scopes overlap, and detects the overlap before starting either", () => {
    // The graph's own contract: `taskScopesConflict` is what makes "two agents own src/" impossible, and a task
    // with no declared scope conflicts with everything (fail-safe, never a silent parallel write).
    expect(taskScopesConflict(task("a", ["src/a.ts"]), task("b", ["src/b.ts"]))).toBe(false);
    expect(taskScopesConflict(task("a", ["src/a.ts"]), task("b", ["src/a.ts"]))).toBe(true);
    expect(taskScopesConflict(task("a", ["src"]), task("b", ["src/a.ts"]))).toBe(true);
    expect(taskScopesConflict(task("a", []), task("b", ["src/b.ts"]))).toBe(true);
  });

  it("really overlaps disjoint scopes and really serialises overlapping ones", async () => {
    async function peakFor(tasks: ProjectTask[]): Promise<number> {
      let active = 0;
      let peak = 0;
      await executeProjectTaskGraph(
        tasks,
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return "ok";
        },
        async () => undefined,
        CODE_SUBAGENT_MAX_PARALLELISM,
        new ProjectFileLeaseManager(),
        "project-c12",
      );
      return peak;
    }
    // Disjoint paths: the whole point of the step is that these two may run at once.
    expect(await peakFor([task("t1", ["src/a.ts"]), task("t2", ["src/b.ts"])])).toBe(2);
    // One shared path: the lease manager serialises them, so a lost update is not possible.
    expect(await peakFor([task("t1", ["src/shared.ts"]), task("t2", ["src/shared.ts"])])).toBe(1);
  });

  it("turns a merge conflict into the structured escalation and settles the run", async () => {
    const { store, events } = projectStore(["dev1", "dev2"]);
    const { git, calls } = recordingGit({ conflictOn: "frontend-t1" });
    const { runtime } = projectRuntime();
    const service = new ProjectMultiAgentService(
      store as never, runtime as never, { async startPreview() { return {}; } } as never,
      new ProjectFileLeaseManager(), git, undefined, { worktreeMode: true },
    );
    const settled = await Promise.race([
      service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-2"),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 5_000)),
    ]);
    // The run settles. A conflict is reported, never waited on.
    expect(settled).not.toBe("HUNG");
    const result = settled as { run: { status: string; errorCode?: string; errorMessage?: string } };
    expect(result.run.status).toBe("failed");

    // The escalation is the existing structured one: which files, and the tool that asks the human.
    const conflict = events.find((entry) => String(entry.event.eventKey).startsWith("project-merge-conflict:"));
    expect(conflict, "a merge conflict must be recorded as its own event").toBeTruthy();
    expect((conflict!.event.details as { conflictingFiles: string[] }).conflictingFiles).toEqual(["src/t1.ts"]);
    expect(String(conflict!.event.message)).toMatch(/Escalating to user intervention/);

    // The error class itself carries the suggestion, and this is the same instance the service caught.
    const escalation = new GitConflictEscalationError(["src/frontend.tsx"], "conflict", {
      attempts: 2, maxAttempts: 2, sourceBranch: "agent/frontend", targetBranch: "project/main",
      suggestedTool: "code.ask_user", question: "Which change should win?",
    });
    expect(escalation.escalation?.suggestedTool).toBe("code.ask_user");
    expect(escalation.code).toBe("GIT_CONFLICT_ESCALATED");
    expect(escalation.conflictingFiles).toEqual(["src/frontend.tsx"]);

    // Cleanup still ran for the conflicted worktree: the `finally` is not conditional on success.
    expect(calls.filter((call) => call.method === "removeAgentWorktree").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((call) => call.method === "cleanupAllWorktrees")).toHaveLength(1);
    // And a *merge* that fails as a plain conflict (the other error class) is caught by the same branch.
    expect(new GitConflictError(["src/b.ts"], "conflict").conflictingFiles).toEqual(["src/b.ts"]);
  });

  it("lets a failing sub-agent fail its task without hanging the parent's run", async () => {
    const { store, events } = projectStore(["dev1", "dev2"]);
    const { git } = recordingGit();
    const { runtime, calls } = projectRuntime({ failOn: "Design tokens" });
    const service = new ProjectMultiAgentService(
      store as never, runtime as never, { async startPreview() { return {}; } } as never,
      new ProjectFileLeaseManager(), git, undefined, { worktreeMode: true },
    );
    const settled = await Promise.race([
      service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-3"),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 5_000)),
    ]);
    expect(settled).not.toBe("HUNG");
    const result = settled as { run: { status: string; errorMessage?: string } };
    expect(result.run.status).toBe("failed");
    expect(result.run.errorMessage).toContain("exploded");
    // The other task still ran: one child's failure does not cancel its siblings' work, and both task keys were
    // dispatched.
    expect(calls.filter((key) => key.includes(":task:"))).toHaveLength(2);
    // The failing task is reported as failed, and the successful one as completed.
    const taskEvents = events.filter((entry) => String(entry.event.eventKey).startsWith("project-task:"));
    expect(taskEvents.some((entry) => String(entry.event.eventKey).includes(":failed"))).toBe(true);
    expect(taskEvents.some((entry) => String(entry.event.eventKey).includes(":completed"))).toBe(true);
  });

  it("survives a store outage while reporting progress instead of taking the graph down", async () => {
    const { store } = projectStore(["dev1", "dev2"]);
    // A run-event writer that is down: `onStatus` must not reject the task's promise, because that rejection is
    // what used to make `Promise.race` throw and abort the whole graph for a bookkeeping failure.
    const failingStore = {
      ...store,
      async appendCompanyAgentRunEvent() { throw new Error("the run event store is down"); },
      async replaceCompanyAgentRunSteps() { throw new Error("the steps store is down"); },
    };
    const { git } = recordingGit();
    const { runtime } = projectRuntime();
    const service = new ProjectMultiAgentService(
      failingStore as never, runtime as never, { async startPreview() { return {}; } } as never,
      new ProjectFileLeaseManager(), git, undefined, { worktreeMode: true },
    );
    const settled = await Promise.race([
      service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-4").catch((error) => ({ threw: String(error) })),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 5_000)),
    ]);
    expect(settled).not.toBe("HUNG");
    expect(settled).not.toHaveProperty("threw");
  });
});

describe("security-gate: C12 the verification after the merge reuses the C9 loop", () => {
  function serviceWithVerification(port: ProjectVerificationPort | undefined, tools?: string[]) {
    const { store, events } = projectStore(["dev1", "dev2"]);
    const { git } = recordingGit();
    const { runtime } = projectRuntime();
    const service = new ProjectMultiAgentService(
      store as never, runtime as never, { async startPreview() { return {}; } } as never,
      new ProjectFileLeaseManager(), git,
      undefined,
      { worktreeMode: true, ...(port ? { verification: port } : {}), ...(tools ? { verificationTools: tools } : {}) },
    );
    return { service, events };
  }

  it("fails the run when a check fails, naming the check and its code", async () => {
    const calls: Array<{ tools: string[]; changedOnly: boolean }> = [];
    const { service, events } = serviceWithVerification({
      async run(input) {
        calls.push({ tools: [...input.tools], changedOnly: input.changedOnly });
        return {
          results: input.tools.map((tool) => ({
            tool, ok: tool !== "typecheck", summary: tool === "typecheck" ? "2 type errors" : `${tool} passed`, findings: [],
          })),
          stats: { tools: input.tools.length, passed: input.tools.length - 1, failed: 1, durationMs: 12 },
        };
      },
    }, ["typecheck", "test"]);
    const result = await service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-v1");

    // The whole project is verified, not just the changed files: a merge can break a file nobody touched.
    expect(calls).toEqual([{ tools: ["typecheck", "test"], changedOnly: false }]);
    expect(result?.run.status).toBe("failed");
    expect(result?.run.errorCode).toBe(PROJECT_VERIFICATION_FAILED);
    expect(result?.run.errorMessage).toContain("typecheck");
    expect(result?.run.result).toContain("Final verification:");
    const event = events.find((entry) => String(entry.event.eventKey).startsWith("project-verification:"));
    expect(event).toBeTruthy();
    expect(event!.event).toMatchObject({ eventType: "failed", runStatus: "failed" });
    expect((event!.event.details as { checks: unknown[] }).checks).toEqual([
      { tool: "typecheck", state: "failed", code: "verification_check_failed" },
      { tool: "test", state: "passed", code: null },
    ]);
  });

  it("completes the run when every check passes, and never asks for a repair of its own", async () => {
    const { service } = serviceWithVerification({
      async run(input) {
        return {
          results: input.tools.map((tool) => ({ tool, ok: true, summary: `${tool} passed`, findings: [] })),
          stats: { tools: input.tools.length, passed: input.tools.length, failed: 0, durationMs: 8 },
        };
      },
    }, ["typecheck", "test"]);
    const result = await service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-v2");
    expect(result?.run.status).toBe("completed");
    expect(result?.run.errorCode).toBeUndefined();
    expect(result?.run.result).toContain("Final verification: passed");
  });

  it("reports an unconfigured verification as unavailable and never as a pass", async () => {
    const { service, events } = serviceWithVerification(undefined, ["typecheck", "test"]);
    const result = await service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-v3");
    // No runner: the change is not reported as failed either — C9's `unavailable` is "not a failure of the change"
    // — but the run **says so** instead of quietly claiming a pass.
    expect(result?.run.status).toBe("completed");
    expect(result?.run.result).toContain("Final verification: unavailable");
    const event = events.find((entry) => String(entry.event.eventKey).startsWith("project-verification:"));
    expect((event!.event.details as { status: string }).status).toBe("unavailable");
    expect((event!.event.details as { code?: string }).code).toBe("verification_unavailable");
  });

  it("treats a check that never ran as unavailable rather than as a pass", async () => {
    // The runner answers with only one of the two checks: the missing one is not silently dropped.
    const { service } = serviceWithVerification({
      async run() {
        return { results: [{ tool: "typecheck", ok: true, summary: "typecheck passed", findings: [] }], stats: { tools: 1, passed: 1, failed: 0, durationMs: 5 } };
      },
    }, ["typecheck", "test"]);
    const result = await service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-v4");
    // One unavailable check among passing ones makes the whole verification `failed` — C9's own rule, reused
    // rather than re-derived.
    expect(result?.run.status).toBe("failed");
  });

  it("refuses an unknown check name instead of dropping it, and survives a runner that throws", async () => {
    const { service } = serviceWithVerification({ async run() { throw new Error("the sandbox is gone"); } }, ["typecheck", "deploy"]);
    const result = await service.execute(ctx, "company-c12", "project-c12", "Build the page", "ctx", "idem-v5");
    // A throwing runner is reported; an unknown check name is not silently ignored. Neither hangs the run.
    expect(result).toBeTruthy();
    expect(PROJECT_VERIFICATION_KINDS).toEqual(["lint", "typecheck", "test", "build"]);
    expect(summariseProjectVerification({
      schemaVersion: 1, status: "failed", attemptsUsed: 0, maxAttempts: 0, verificationRuns: 1, requestedTools: ["typecheck"],
      checks: [{ tool: "typecheck", state: "failed", code: "verification_check_failed" }],
      failedChecks: [{ tool: "typecheck", state: "failed", code: "verification_check_failed" }],
    })).toBe("failed (1 check(s)) — typecheck:verification_check_failed");
  });

  it("reuses the existing decomposition and merge surface rather than a second one", () => {
    const source = readFileSync("apps/agent-api/src/project-multi-agent.ts", "utf8");
    // The graph, the plan parser and the agent selector are the ones that already existed.
    expect(source).toMatch(/executeProjectTaskGraph\(tasks, execute, onStatus, this\.parallelism, this\.leaseManager, projectId\)/);
    expect(source).toMatch(/parseProjectTaskPlan\(planResult, prompt\)/);
    expect(source).toMatch(/selectProjectTaskAgent\(task\.role, taskAgents, edges, company\.mainAgentId\)/);
    // Isolation is exclusively the worktree methods of the existing service, and cleanup is in the `finally`.
    for (const method of ["createAgentWorktree", "commitAgentWorktree", "diffAgentWorktree", "mergeAgentWorktree", "removeAgentWorktree", "cleanupAllWorktrees"]) {
      expect(source, `${method} must be used through ProjectGitService`).toContain(`this.gitService.${method}`);
    }
    expect(source).toMatch(/\} finally \{/);
    expect(source).toMatch(/await this\.gitService\.cleanupAllWorktrees\(ctx, companyId, projectId\)\.catch\(\(\) => undefined\)/);
    /**
     * The isolation defect this step found and fixed: a slug derived from the **role** alone gave two parallel
     * tasks of one role one worktree and one branch, so "parallel implement" was not isolated at all. The guard is
     * on the derivation, because that is where the isolation comes from.
     */
    expect(source).toMatch(/const agentSlug = `\$\{task\.role\}-\$\{task\.id\}`;/);
    expect(source).not.toMatch(/const agentSlug = task\.role \|\| task\.id;/);
    // The verification is the C9 loop over the C9 vocabulary.
    expect(source).toMatch(/createVerificationLoop\(\{ maxRepairAttempts: 0, requestedTools: tools \}\)/);
    expect(source).toMatch(/DEFAULT_PROJECT_VERIFICATION_TOOLS/);
    // And no second engine or scheduler: a plan, a graph and a git service are the whole orchestration surface.
    expect(source).not.toMatch(/new CodeRunQueue|new NestedSubagentManager|new CodingAgentRunner/);
  });
});
