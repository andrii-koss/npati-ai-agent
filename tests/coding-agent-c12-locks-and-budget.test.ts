import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { A2AQuotaManager } from "../apps/agent-api/src/a2a-protocol-extensions";
import {
  CODE_RUN_BUDGET_MAX_COST_USD,
  CODE_RUN_BUDGET_MAX_TOKENS,
  CodeRunSharedQuota,
  resolveCodeRunBudget,
} from "../apps/agent-api/src/code-run-quota";
import {
  CODE_SUBAGENT_MAX_NODE_DEPTH,
  CODE_SUBAGENT_REGISTRY_MAX_DEPTH,
} from "../apps/agent-api/src/code-subagent-limits";
import {
  CodingAgentRunner,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";
import { ProjectFileLeaseManager } from "../apps/agent-api/src/project-file-lock";
import { executeProjectTaskGraph, type ProjectTask } from "../apps/agent-api/src/project-task-graph";

/**
 * C12 security-gate suite: **one** file-lock manager and **one** budget.
 *
 * Two "second mechanisms" were removed here, and both were the kind that cannot be seen from a unit test of
 * either half:
 *
 *  - `ProjectMultiAgentService` was created with `undefined` for its lease manager, so the project task graph
 *    locked files in its own manager while `CompanyToolRuntime` locked the same files in another. Two agents
 *    could each hold "the lock" on one path and both writes would be accepted. The suite drives the real graph
 *    and the real Company file tool over one shared manager — and over two managers, as the negative control
 *    that shows what the sharing is worth — plus a source guard on the composition, because "wired correctly"
 *    is a property of `app.ts`/`project-orchestrator.ts`, not of either class.
 *  - the runner's `quota` port had call sites and no implementation in the composition, so `budget_exhausted`
 *    was unreachable in a real deployment. The suite drives the real runner over the **existing**
 *    `A2AQuotaManager` and pins that a parent and its child draw on one allowance.
 */

const ctx: AuthContext = { userId: "user-c12", workspaceId: "ws-c12", permissions: ["workspace:write"] };
const WORKSPACE = { id: "c", workspaceId: "w", userId: "u" } as never;

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "session-budget",
    workspaceId: "ws-c12",
    companyId: "company-c12",
    projectId: "project-c12",
    userId: "user-c12",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("security-gate: C12 one file-lock manager for the graph and the Company tools", () => {
  /** The real Company file tool over a minimal in-memory workspace, exactly as `app.ts` composes it. */
  function companyFileTools(leaseManager: ProjectFileLeaseManager) {
    let content = "first\n";
    const workspace = {
      async readFile() { return { path: "src/page.tsx", content, size: content.length, revision: "r1" }; },
      async writeFile(_ctx: unknown, _company: string, _project: string, filePath: string, next: string) {
        content = next;
        return { path: filePath, content, size: content.length, revision: "r2" };
      },
    };
    const agents = {
      async getCompanyAgent(_ctx: unknown, _company: string, id: string) {
        return { id, isActive: true, tools: ["project.files.read", "project.files.write"] };
      },
    };
    const runtime = new CompanyToolRuntime(
      {} as never,          // ai
      undefined,            // research
      undefined,            // attachmentDirectory
      undefined,            // attachmentReader
      undefined,            // memoryRepository
      undefined,            // execSandbox
      undefined,            // emailAgentTools
      undefined,            // browserTool
      workspace as never,   // projectWorkspace
      agents as never,      // projectAgentStore
      undefined,            // projectSandbox
      undefined,            // projectPreview
      undefined,            // projectGit
      leaseManager,         // projectFileLeaseManager — the shared instance under test
    );
    return { runtime, read: () => content };
  }

  const task = (id: string, paths: string[]): ProjectTask =>
    ({ id, title: id, role: "frontend", paths, dependsOn: [], status: "queued" });

  async function writeWhileGraphHoldsTheFile(graphManager: ProjectFileLeaseManager, toolManager: ProjectFileLeaseManager) {
    const { runtime, read } = companyFileTools(toolManager);
    let refusal = "";
    const signal = new AbortController().signal;
    await executeProjectTaskGraph([task("t1", ["src/page.tsx"])], async () => {
      // The graph holds the lease on `src/page.tsx` for exactly this window.
      try {
        await runtime.execute(ctx, WORKSPACE, "project.files.write", {
          projectId: "project-c12", path: "src/page.tsx", content: "second\n", __npatiAgentId: "company-agent",
        }, signal);
      } catch (error) {
        refusal = (error as { code?: string }).code ?? "error";
      }
      await sleep(1);
      return "done";
    }, async () => undefined, 2, graphManager, "project-c12");
    return { refusal, content: read() };
  }

  it("blocks a Company file write while the task graph holds that path", async () => {
    const shared = new ProjectFileLeaseManager();
    const blocked = await writeWhileGraphHoldsTheFile(shared, shared);
    expect(blocked.refusal).toBe("file_locked");
    expect(blocked.content).toBe("first\n");
  });

  it("shows what the old two-manager composition allowed (negative control)", async () => {
    // Two managers is what `undefined` used to produce: the graph locks in one, the tools check the other, and
    // both writes are accepted. This is the defect the shared instance removes, so it is asserted explicitly.
    const blocked = await writeWhileGraphHoldsTheFile(new ProjectFileLeaseManager(), new ProjectFileLeaseManager());
    expect(blocked.refusal).toBe("");
    expect(blocked.content).toBe("second\n");
  });

  it("pins the composition: one instance, passed through every layer", () => {
    const root = path.resolve(process.cwd());
    const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

    // `app.ts` builds the manager once and hands that instance to the Company tool runtime and the orchestrator.
    const app = read("apps/agent-api/src/app.ts") + read("apps/agent-api/src/email-automation-wiring.ts");
    expect(app).toMatch(/const projectFileLeaseManager = new ProjectFileLeaseManager\(\)/);
    expect(app).toMatch(/new ProjectOrchestrator\(/);
    /**
     * C12 added the post-merge verification port **after** the lease manager in the orchestrator's argument
     * list, so "the last argument before `)`" stopped being the property. The assertion is now scoped to the
     * argument itself, which is what it was always about: the shared instance is passed to `new
     * ProjectOrchestrator(...)` by name, at argument position, rather than a second manager being constructed
     * there.
     */
    const orchestratorArgs = app.slice(app.indexOf("new ProjectOrchestrator("));
    expect(orchestratorArgs.slice(0, orchestratorArgs.indexOf(");"))).toMatch(/^\s{4}projectFileLeaseManager,\s*$/m);
    // Strengthened in the same edit, because "passed by name" alone would not exclude a second manager: the
    // orchestrator constructs **no** lease manager of its own, so the one it forwards can only be the shared one.
    expect(read("apps/agent-api/src/project-orchestrator.ts")).not.toMatch(/new ProjectFileLeaseManager\(/);

    // The orchestrator passes it to the multi-agent service instead of `undefined`.
    const orchestrator = read("apps/agent-api/src/project-orchestrator.ts");
    const serviceCall = orchestrator.slice(orchestrator.indexOf("new ProjectMultiAgentService("));
    expect(serviceCall.slice(0, 600)).toMatch(/this\.leaseManager,\s*\n\s*this\.gitService/);
    expect(serviceCall.slice(0, 600)).not.toMatch(/this\.previewService,\s*\n\s*undefined,/);

    // And the service passes the same instance into the graph.
    const multiAgent = read("apps/agent-api/src/project-multi-agent.ts");
    expect(multiAgent).toMatch(/executeProjectTaskGraph\(tasks, execute, onStatus, this\.parallelism, this\.leaseManager, projectId\)/);
  });

  it("keeps the shared manager's own guarantees (hierarchical conflict, TTL release)", async () => {
    const manager = new ProjectFileLeaseManager({ defaultTtlMs: 5_000, defaultTimeoutMs: 60 });
    const lease = await manager.acquire("project-c12", "graph-agent", ["src"]);
    expect(manager.isLocked("project-c12", "src/page.tsx", "company-agent").locked).toBe(true);
    /**
     * The lock wait below is observable only while the process has something else pending: the manager's wait
     * timer is `unref`'d, so a process whose only work is waiting for a file lock would exit before answering
     * `lock_timeout` (the same trap `code-run-queue.ts` documents and avoids). Under the security gate vitest
     * keeps the loop alive; the harness that runs this file directly does not, so the suite holds its own handle
     * rather than depending on which runner is used. The production locking semantics are untouched.
     */
    const keepAlive = setInterval(() => undefined, 5);
    try {
      await expect(manager.acquire("project-c12", "company-agent", ["src/page.tsx"], { timeoutMs: 40 })).rejects.toThrow(/lock_timeout/);
    } finally {
      clearInterval(keepAlive);
    }
    manager.release(lease.id);
    expect(manager.isLocked("project-c12", "src/page.tsx", "company-agent").locked).toBe(false);
  });
});

describe("security-gate: C12 one shared budget for a parent run and its children", () => {
  it("draws a child's allowance from the parent's session budget instead of a second one", () => {
    const manager = new A2AQuotaManager();
    const quota = new CodeRunSharedQuota(manager, {
      limits: { maxTokens: 100, maxCostUsd: 1 },
      // The child runs in its own session in this deployment; the mapping is what makes the budget shared.
      resolveBudgetKey: (sessionId) => (sessionId === "session-child" ? "session-parent" : sessionId),
    });

    expect(quota.checkQuota("session-parent", 40, 0, 1).allowed).toBe(true);
    quota.recordUsage("session-parent", 60, 0);
    expect(manager.getBudget("session-parent")!.usedTokens).toBe(60);

    // The child asks for 50 more: 60 + 50 > 100, so the shared budget refuses it.
    const child = quota.checkQuota("session-child", 50, 0, CODE_SUBAGENT_MAX_NODE_DEPTH);
    expect(child.allowed).toBe(false);
    expect(child.error).toContain("A2A_TOKEN_QUOTA_EXCEEDED");
    expect(child.remainingTokens).toBe(40);

    // Usage recorded by the child lands on the same ledger — there is no second accounting system.
    quota.recordUsage("session-child", 10, 0);
    expect(manager.getBudget("session-parent")!.usedTokens).toBe(70);
    expect(manager.getBudget("session-child")).toBeUndefined();
  });

  it("refuses an allowance past the canonical depth and enforces the cost budget too", () => {
    const manager = new A2AQuotaManager();
    const quota = new CodeRunSharedQuota(manager, { limits: { maxTokens: 10_000, maxCostUsd: 0.05 } });

    expect(quota.checkQuota("s-depth", 10, 0, CODE_SUBAGENT_MAX_NODE_DEPTH).allowed).toBe(true);
    const tooDeep = quota.checkQuota("s-depth", 10, 0, CODE_SUBAGENT_MAX_NODE_DEPTH + 1);
    expect(tooDeep.allowed).toBe(false);
    expect(tooDeep.error).toContain("A2A_MAX_DEPTH_EXCEEDED");

    expect(quota.checkQuota("s-cost", 10, 0.04).allowed).toBe(true);
    // Cost accumulates through `recordUsage`, exactly as the runner does after every answered turn.
    quota.recordUsage("s-cost", 10, 0.04);
    const tooExpensive = quota.checkQuota("s-cost", 10, 0.04);
    expect(tooExpensive.allowed).toBe(false);
    expect(tooExpensive.error).toContain("A2A_COST_QUOTA_EXCEEDED");
  });

  it("never overwrites a budget an operator configured, and clamps the configured defaults", () => {
    const manager = new A2AQuotaManager();
    manager.setSessionBudget("s-operator", 7, 0.02, 1);
    const quota = new CodeRunSharedQuota(manager, { limits: { maxTokens: 1_000_000 } });

    const verdict = quota.checkQuota("s-operator", 8, 0, 1);
    expect(verdict.allowed).toBe(false);
    expect(manager.getBudget("s-operator")!.maxTokens).toBe(7);
    // The operator's 1 is the structural coding limit, not the adapter's default of 2.
    expect(quota.checkQuota("s-operator", 1, 0, CODE_SUBAGENT_MAX_NODE_DEPTH).error).toContain("A2A_MAX_DEPTH_EXCEEDED");

    expect(resolveCodeRunBudget({ NPATI_CODE_RUN_MAX_TOKENS: "999999999999", NPATI_CODE_RUN_MAX_COST_USD: "1e9", NPATI_CODE_RUN_MAX_DEPTH: "9" }))
      .toEqual({ maxTokens: CODE_RUN_BUDGET_MAX_TOKENS, maxCostUsd: CODE_RUN_BUDGET_MAX_COST_USD, maxDepth: CODE_SUBAGENT_REGISTRY_MAX_DEPTH });
    expect(resolveCodeRunBudget({}).maxDepth).toBe(CODE_SUBAGENT_MAX_NODE_DEPTH);
  });

  /**
   * The minimal runner harness needed to drive the loop's quota gate. The loop only reaches a second turn when
   * the model calls a tool, so the scripted answers carry one read call each (varying the path, because the
   * loop detects a repeated identical call) and the provider reports usage, which is what `recordUsage` sees.
   */
  function budgetHarness(options: {
    quota: CodingAgentRunnerPorts["quota"];
    script: Array<{ content: string; tokens: number; call?: boolean }>;
  }) {
    const tools = [{ name: "code.fs.read", version: 1, status: "active", description: "read a file", write: false }];
    const schemas = tools.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { path: { type: "string" } } } }));
    const engineCalls: string[] = [];
    const releases: string[] = [];
    const script = [...options.script];
    let callIndex = 0;
    const ports = {
      flags: { assertEnabled: async () => true },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: {
        listTools: () => tools.map((tool) => ({ ...tool })),
        invoke: async (_ctx: unknown, input: { tool: string }) => ({
          ok: true as const, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: { ok: true }, truncated: false, durationMs: 0,
        }),
      },
      engine: {
        chat: async () => {
          const next = script.shift();
          engineCalls.push(next?.content ?? "done");
          if (!next?.call) return { content: next?.content ?? "done", usage: { totalTokens: next?.tokens ?? 0 } };
          const path = `src/a${callIndex++}.ts`;
          return {
            content: next.content,
            usage: { totalTokens: next.tokens },
            toolCalls: [{ id: `call-${callIndex}`, type: "function" as const, function: { name: "code.fs.read", arguments: JSON.stringify({ path }) } }],
          };
        },
      },
      schemas,
      quota: options.quota,
      sandbox: { release: async (input: { reason: string }) => { releases.push(input.reason); } },
      limits: { maxStepsPerRun: 6, maxRunMinutes: 5 },
    } as unknown as CodingAgentRunnerPorts;
    return { runner: new CodingAgentRunner(ports), engineCalls, releases };
  }

  it("really stops a run with budget_exhausted and never lets a child spend past the shared budget", async () => {
    const manager = new A2AQuotaManager();
    const quota = new CodeRunSharedQuota(manager, {
      limits: { maxTokens: 9_000, maxCostUsd: 1 },
      resolveBudgetKey: (sessionId) => (sessionId === "session-child-run" ? "session-budget" : sessionId),
    });

    // Include the request's context in pre-flight pressure: two 3,000-token turns fit, then the
    // 6,000-token usage plus the next response estimate and context exceeds the 9,000 allowance.
    const parent = budgetHarness({
      quota,
      script: [
        { content: "first", tokens: 3_000, call: true },
        { content: "second", tokens: 3_000, call: true },
        { content: "third", tokens: 1_000 },
      ],
    });
    const parentResult = await parent.runner.run({ ctx, session: session(), prompt: "work" });
    expect(parentResult).toMatchObject({ status: "stopped", reason: "budget_exhausted" });
    expect(parentResult.summary.remaining).toContain("A2A_TOKEN_QUOTA_EXCEEDED");
    expect(parent.engineCalls).toHaveLength(2);
    expect(parent.releases).toContain("budget_exhausted");
    expect(manager.getBudget("session-budget")!.usedTokens).toBe(6_000);

    // The child run, in its own session, mapped onto the same budget: 6 000 + 4 000 > 9 000, so its very first
    // pre-flight is refused and it never calls the provider. The shared budget is what stops it — there is no
    // separate allowance a child could exhaust on its own.
    const child = budgetHarness({ quota, script: [{ content: "child", tokens: 100 }] });
    const childResult = await child.runner.run({
      ctx,
      session: session({ id: "session-child-run" }),
      prompt: "child work",
      subagentScope: { parentRunId: "run-parent", allowedTools: ["code.fs.read"] },
    });
    expect(childResult).toMatchObject({ status: "stopped", reason: "budget_exhausted" });
    expect(child.engineCalls).toEqual([]);
    expect(manager.getBudget("session-budget")!.usedTokens).toBe(6_000);
  });

  it("stops at the first pre-flight when the budget is already below one call's estimate", async () => {
    const manager = new A2AQuotaManager();
    const quota = new CodeRunSharedQuota(manager, { limits: { maxTokens: 10, maxCostUsd: 1 } });
    const harness = budgetHarness({ quota, script: [{ content: "never", tokens: 1 }] });
    const result = await harness.runner.run({ ctx, session: session({ id: "s-tiny" }), prompt: "work" });
    expect(result).toMatchObject({ status: "stopped", reason: "budget_exhausted" });
    expect(harness.engineCalls).toEqual([]);
  });
});
