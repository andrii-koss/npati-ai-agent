import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";
import {
  executeProjectTaskGraph,
  mergeProjectText,
  parseProjectTaskPlan,
  ProjectFileLeaseManager,
  ProjectFileLockError,
  pathsConflict,
  type ProjectTask,
} from "../apps/agent-api/src/project-task-graph";
import { ProjectMultiAgentService } from "../apps/agent-api/src/project-multi-agent";

const task = (id: string, paths: string[], dependsOn: string[] = []): ProjectTask =>
  ({ id, title: id, role: "frontend", paths, dependsOn, status: "queued" });

describe("project task graph", () => {
  it("runs independent file scopes in parallel and waits for dependencies", async () => {
    const tasks = [task("design", ["design"]), task("frontend", ["src/page.tsx"], ["design"]), task("seo", ["public/robots.txt"], ["design"])];
    let active = 0, peak = 0;
    await executeProjectTaskGraph(tasks, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return item.id;
    }, async () => undefined);
    expect(peak).toBe(2);
    expect(tasks.map((item) => item.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("serializes conflicting paths and does not hang after one agent fails", async () => {
    const tasks = [task("a", ["src/page.tsx"]), task("b", ["src"]), task("after", ["other"], ["a"])];
    let active = 0, peak = 0;
    await executeProjectTaskGraph(tasks, async (item) => {
      active++; peak = Math.max(active, peak);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      if (item.id === "a") throw new Error("agent crashed");
      return item.id;
    }, async () => undefined);
    expect(peak).toBe(1);
    expect(tasks.map((item) => item.status)).toEqual(["failed", "completed", "waiting"]);
  });

  it("rejects dependency cycles and path traversal", () => {
    expect(() => parseProjectTaskPlan('{"tasks":[{"id":"a","role":"frontend","depends_on":["b"]},{"id":"b","role":"qa","depends_on":["a"]}]}', "site")).toThrow(/cycle/);
    expect(() => parseProjectTaskPlan('{"tasks":[{"id":"a","role":"frontend","paths":["../secret"]}]}', "site")).toThrow(/scope/);
  });

  it("merges disjoint lines and rejects overlapping edits", () => {
    const base = "first\nsecond\nthird\n";
    expect(mergeProjectText(base, "first\nSECOND\nthird\n", "first\nsecond\nTHIRD\n")).toBe("first\nSECOND\nTHIRD\n");
    expect(mergeProjectText(base, "first\nOTHER\nthird\n", "first\nSECOND\nthird\n")).toBeUndefined();
  });
});

describe("project file locking and leases", () => {
  it("detects hierarchical conflicts between directory and nested files", () => {
    expect(pathsConflict("src", "src/components/Header.tsx")).toBe(true);
    expect(pathsConflict("src/components/Header.tsx", "src")).toBe(true);
    expect(pathsConflict("src/Header.tsx", "src/Footer.tsx")).toBe(false);
    expect(pathsConflict("public/robots.txt", "src/page.tsx")).toBe(false);
  });

  it("allows disjoint file locks concurrently and serializes conflicting paths", async () => {
    const manager = new ProjectFileLeaseManager({ defaultTtlMs: 2000, defaultTimeoutMs: 150 });
    const lease1 = await manager.acquire("proj-1", "agent-a", ["src/header.tsx"]);
    const lease2 = await manager.acquire("proj-1", "agent-b", ["src/footer.tsx"]);
    expect(lease1.id).toBeDefined();
    expect(lease2.id).toBeDefined();

    // Conflicting acquisition times out
    await expect(manager.acquire("proj-1", "agent-c", ["src"], { timeoutMs: 80 }))
      .rejects.toThrow(/lock_timeout/);

    manager.release(lease1.id);
    manager.release(lease2.id);
  });

  it("detects deadlock and circular wait between agents", async () => {
    const manager = new ProjectFileLeaseManager({ defaultTtlMs: 2000, defaultTimeoutMs: 500 });
    // Agent A locks file1
    const leaseA = await manager.acquire("proj-1", "agent-a", ["file1.ts"]);
    // Agent B locks file2
    const leaseB = await manager.acquire("proj-1", "agent-b", ["file2.ts"]);

    // Agent A waits for file2 (held by Agent B) in background
    let aFailedWith = "";
    manager.acquire("proj-1", "agent-a", ["file2.ts"]).catch((err) => { aFailedWith = err.code || err.message; });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Agent B tries to acquire file1 (held by Agent A), creating circular wait: A -> B -> A
    await expect(manager.acquire("proj-1", "agent-b", ["file1.ts"]))
      .rejects.toThrow(/deadlock_detected/);

    manager.release(leaseA.id);
    manager.release(leaseB.id);
  });

  it("releases locks immediately when an agent crashes", async () => {
    const manager = new ProjectFileLeaseManager({ defaultTtlMs: 5000, defaultTimeoutMs: 200 });
    await manager.acquire("proj-1", "agent-crash", ["src/shared.ts"]);
    expect(manager.isLocked("proj-1", "src/shared.ts").locked).toBe(true);

    // Simulate agent crash release
    manager.releaseAgentLeases("proj-1", "agent-crash");
    expect(manager.isLocked("proj-1", "src/shared.ts").locked).toBe(false);

    // Another agent can now acquire immediately
    const nextLease = await manager.acquire("proj-1", "agent-survivor", ["src/shared.ts"]);
    expect(nextLease.id).toBeDefined();
    manager.release(nextLease.id);
  });

  it("purges expired leases automatically after TTL", async () => {
    const manager = new ProjectFileLeaseManager({ defaultTtlMs: 40, defaultTimeoutMs: 100 });
    await manager.acquire("proj-1", "agent-stale", ["src/stale.ts"], { ttlMs: 40 });
    expect(manager.isLocked("proj-1", "src/stale.ts").locked).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.isLocked("proj-1", "src/stale.ts").locked).toBe(false);

    const fresh = await manager.acquire("proj-1", "agent-new", ["src/stale.ts"]);
    expect(fresh.id).toBeDefined();
    manager.release(fresh.id);
  });
});

describe("project file revision retry", () => {
  it("preserves both agents' edits to different lines of one file", async () => {
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    let content = "first\nsecond\nthird\n";
    const workspace = {
      async readFile() { return { path: "src/page.tsx", content, size: content.length, revision: digest(content) }; },
      async writeFile(_ctx: unknown, _company: string, _project: string, path: string, next: string, revision: string) {
        if (revision !== digest(content)) throw Object.assign(new Error("revision_conflict"), { code: "revision_conflict" });
        content = next;
        return { path, content, size: content.length, revision: digest(content) };
      },
    };
    const agents = { async getCompanyAgent(_ctx: unknown, _company: string, id: string) {
      return { id, isActive: true, tools: ["project.files.read", "project.files.write"] };
    } };
    const runtime = new CompanyToolRuntime({} as never, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, workspace as never, agents as never);
    const ctx = { workspaceId: "w", userId: "u", permissions: ["workspace:write"] } as never;
    const company = { id: "c", workspaceId: "w", userId: "u" } as never;
    const signal = new AbortController().signal;
    const baseRevision = digest(content);
    for (const agent of ["a", "b"]) {
      await runtime.execute(ctx, company, "project.files.read", { projectId: "p", path: "src/page.tsx", __npatiAgentId: agent, __npatiTaskRunId: agent }, signal);
    }
    await Promise.all([
      runtime.execute(ctx, company, "project.files.write", { projectId: "p", path: "src/page.tsx", content: "first\nSECOND\nthird\n", expectedRevision: baseRevision, __npatiAgentId: "a", __npatiTaskRunId: "a" }, signal),
      runtime.execute(ctx, company, "project.files.write", { projectId: "p", path: "src/page.tsx", content: "first\nsecond\nTHIRD\n", expectedRevision: baseRevision, __npatiAgentId: "b", __npatiTaskRunId: "b" }, signal),
    ]);
    expect(content).toBe("first\nSECOND\nTHIRD\n");
  });

  it("escalates to Main Agent when edits overlap on identical lines", async () => {
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    let content = "line 1\nline 2\nline 3\n";
    const workspace = {
      async readFile() { return { path: "src/page.tsx", content, size: content.length, revision: digest(content) }; },
      async writeFile(_ctx: unknown, _company: string, _project: string, path: string, next: string, revision: string) {
        if (revision !== digest(content)) throw Object.assign(new Error("revision_conflict"), { code: "revision_conflict" });
        content = next;
        return { path, content, size: content.length, revision: digest(content) };
      },
    };
    const agents = { async getCompanyAgent(_ctx: unknown, _company: string, id: string) {
      return { id, isActive: true, tools: ["project.files.read", "project.files.write"] };
    } };
    const runtime = new CompanyToolRuntime({} as never, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, workspace as never, agents as never);
    const ctx = { workspaceId: "w", userId: "u", permissions: ["workspace:write"] } as never;
    const company = { id: "c", workspaceId: "w", userId: "u" } as never;
    const signal = new AbortController().signal;
    const baseRevision = digest(content);

    await runtime.execute(ctx, company, "project.files.read", { projectId: "p", path: "src/page.tsx", __npatiAgentId: "a", __npatiTaskRunId: "a" }, signal);
    await runtime.execute(ctx, company, "project.files.read", { projectId: "p", path: "src/page.tsx", __npatiAgentId: "b", __npatiTaskRunId: "b" }, signal);

    // Agent A writes new line 2
    await runtime.execute(ctx, company, "project.files.write", { projectId: "p", path: "src/page.tsx", content: "line 1\nLINE 2 BY A\nline 3\n", expectedRevision: baseRevision, __npatiAgentId: "a", __npatiTaskRunId: "a" }, signal);

    // Agent B also modifies line 2 -> overlapping edit conflict
    await expect(runtime.execute(ctx, company, "project.files.write", { projectId: "p", path: "src/page.tsx", content: "line 1\nLINE 2 BY B\nline 3\n", expectedRevision: baseRevision, __npatiAgentId: "b", __npatiTaskRunId: "b" }, signal))
      .rejects.toThrow(/revision_conflict: overlapping changes; escalate to Main Agent/);
  });
});

describe("project QA loop", () => {
  it("stops after two QA reviews and returns open issues", async () => {
    const agents = [
      { id: "main", role: "manager", isActive: true, tools: [], modelId: "auto" },
      { id: "dev", role: "frontend developer", isActive: true, tools: ["project.files.read", "project.files.write"], modelId: "auto" },
      { id: "qa", role: "QA tester", isActive: true, tools: ["project.preview.status"], modelId: "auto" },
      { id: "seo", role: "SEO", isActive: true, tools: ["project.files.read"], modelId: "auto" },
    ] as never[];
    const events: Array<{ eventKey: string; details: Record<string, unknown> }> = [];
    const parent = { id: "parent", status: "queued", requestedMode: "pipeline", result: "" };
    const store = {
      async getCompany() { return { mainAgentId: "main" }; },
      async listCompanyAgents() { return agents; },
      async listCompanyAgentEdges() { return []; },
      async createCompanyAgentRun() { return { run: parent, created: true }; },
      async updateCompanyAgentRun(_ctx: unknown, _company: string, _id: string, patch: Record<string, unknown>) { Object.assign(parent, patch); return parent; },
      async replaceCompanyAgentRunSteps() { return []; },
      async appendCompanyAgentRunEvent(_ctx: unknown, _company: string, _id: string, event: { eventKey: string; details: Record<string, unknown> }) { events.push(event); return event; },
      async getCompanyAgentRun() { return { run: parent, steps: [], toolAudit: [], backgroundEvents: events }; },
    };
    let qaCalls = 0, repairCalls = 0;
    const runtime = { async execute(_ctx: unknown, _company: string, input: { callBudget?: { remaining: number } }, key: string) {
      if (input.callBudget && --input.callBudget.remaining < 0) return { run: { status: "failed", errorMessage: "budget" } };
      if (key.endsWith(":plan")) return { run: { status: "completed", result: '{"tasks":[{"id":"frontend","title":"Build page","role":"frontend","depends_on":[],"paths":["src/page.tsx"]},{"id":"qa","title":"Review","role":"qa","depends_on":["frontend"],"paths":[]}]}' } };
      if (key.includes(":qa-repair:")) { repairCalls++; return { run: { status: "completed", result: "fixed" } }; }
      if (key.includes(":qa:")) { qaCalls++; return { run: { status: "completed", result: '{"issues":["still broken"]}' } }; }
      return { run: { status: "completed", result: "implemented" } };
    } };
    const preview = { async startPreview() { return { previewUrl: "https://preview.example" }; } };
    const service = new ProjectMultiAgentService(store as never, runtime as never, preview as never);
    const result = await service.execute({ workspaceId: "w", userId: "u" } as never, "c", "p", "Build site", "context", "key");
    expect(result?.run.status).toBe("completed");
    expect(result?.run.result).toContain("open issues");
    expect(qaCalls).toBe(2);
    expect(repairCalls).toBe(1);
  });
});

describe("project model call budget", () => {
  it("stops execution and records failure when call budget is exhausted", async () => {
    const agents = [
      { id: "main", role: "manager", isActive: true, tools: [], modelId: "auto" },
      { id: "dev", role: "frontend developer", isActive: true, tools: ["project.files.read"], modelId: "auto" },
      { id: "qa", role: "QA tester", isActive: true, tools: ["project.preview.status"], modelId: "auto" },
    ] as never[];
    const parent = { id: "parent-budget", status: "queued", requestedMode: "pipeline", result: "" };
    const store = {
      async getCompany() { return { mainAgentId: "main" }; },
      async listCompanyAgents() { return agents; },
      async listCompanyAgentEdges() { return []; },
      async createCompanyAgentRun() { return { run: parent, created: true }; },
      async updateCompanyAgentRun(_ctx: unknown, _company: string, _id: string, patch: Record<string, unknown>) { Object.assign(parent, patch); return parent; },
      async replaceCompanyAgentRunSteps() { return []; },
      async appendCompanyAgentRunEvent() { return {}; },
      async getCompanyAgentRun() { return { run: parent, steps: [], toolAudit: [], backgroundEvents: [] }; },
    };
    const runtime = { async execute(_ctx: unknown, _company: string, input: { callBudget?: { remaining: number } }, key: string) {
      if (input.callBudget) {
        input.callBudget.remaining = 0; // Exhaust budget immediately
      }
      if (key.endsWith(":plan")) {
        return { run: { status: "completed", result: '{"tasks":[{"id":"frontend","title":"Task 1","role":"frontend","depends_on":[],"paths":["a.ts"]}]}' } };
      }
      throw Object.assign(new Error("Project model call limit reached"), { code: "MODEL_CALL_BUDGET_EXCEEDED" });
    } };
    const service = new ProjectMultiAgentService(store as never, runtime as never, { async startPreview() { return {}; } } as never);
    const result = await service.execute({ workspaceId: "w", userId: "u" } as never, "c", "p", "Create site", undefined, "budget-key");
    expect(result?.run.status).toBe("failed");
    expect(result?.run.errorCode).toBe("MODEL_CALL_BUDGET_EXCEEDED");
  });
});

describe("IMPROVE_PROJECT multi-agent workflow", () => {
  it("runs specialists in analysis mode without tool execution and creates plan", async () => {
    const agents = [
      { id: "main", role: "coordinator", isActive: true, tools: [], modelId: "auto" },
      { id: "designer", role: "designer UX UI", isActive: true, tools: ["project.files.read"], modelId: "auto" },
      { id: "dev", role: "frontend developer", isActive: true, tools: ["project.files.read"], modelId: "auto" },
      { id: "seo", role: "SEO specialist", isActive: true, tools: ["project.files.read"], modelId: "auto" },
      { id: "qa", role: "QA tester", isActive: true, tools: ["project.preview.status"], modelId: "auto" },
      { id: "sec", role: "security auditor", isActive: true, tools: ["project.git.status"], modelId: "auto" },
    ] as never[];
    const parent = { id: "parent-improve", status: "queued", requestedMode: "pipeline", result: "" };
    const store = {
      async getCompany() { return { mainAgentId: "main" }; },
      async listCompanyAgents() { return agents; },
      async listCompanyAgentEdges() { return []; },
      async createCompanyAgentRun() { return { run: parent, created: true }; },
      async updateCompanyAgentRun(_ctx: unknown, _company: string, _id: string, patch: Record<string, unknown>) { Object.assign(parent, patch); return parent; },
      async replaceCompanyAgentRunSteps() { return []; },
      async appendCompanyAgentRunEvent() { return {}; },
      async getCompanyAgentRun() { return { run: parent, steps: [], toolAudit: [], backgroundEvents: [] }; },
    };
    const executedToolsSuppressed: boolean[] = [];
    const runtime = { async execute(_ctx: unknown, _company: string, input: { suppressTools?: boolean; task: string }, key: string) {
      if (input.suppressTools !== undefined) executedToolsSuppressed.push(input.suppressTools);
      if (key.endsWith(":improve-plan")) {
        return { run: { status: "completed", result: "1. Optimize typography\n2. Add security headers\n3. Improve mobile layout" } };
      }
      return { run: { status: "completed", result: "Audit finding for " + key } };
    } };
    const service = new ProjectMultiAgentService(store as never, runtime as never, { async startPreview() { return {}; } } as never);
    const result = await service.execute({ workspaceId: "w", userId: "u" } as never, "c", "p", "Improve site", "context", "improve-key", true);
    expect(result?.run.status).toBe("completed");
    expect(result?.run.result).toContain("Optimize typography");
    // All 5 specialist analysis calls plus the final synthesis plan suppress write tools
    expect(executedToolsSuppressed.every((v) => v === true)).toBe(true);
  });
});

describe("project peer task status visibility and context isolation", () => {
  it("passes task statuses of all peers and isolates raw conversation", async () => {
    const agents = [
      { id: "main", role: "manager", isActive: true, tools: [], modelId: "auto" },
      { id: "dev", role: "frontend developer", isActive: true, tools: ["project.files.read", "project.files.write"], modelId: "auto" },
      { id: "qa", role: "QA tester", isActive: true, tools: ["project.preview.status"], modelId: "auto" },
    ] as never[];
    const parent = { id: "parent-status", status: "queued", requestedMode: "pipeline", result: "" };
    const store = {
      async getCompany() { return { mainAgentId: "main" }; },
      async listCompanyAgents() { return agents; },
      async listCompanyAgentEdges() { return []; },
      async createCompanyAgentRun() { return { run: parent, created: true }; },
      async updateCompanyAgentRun(_ctx: unknown, _company: string, _id: string, patch: Record<string, unknown>) { Object.assign(parent, patch); return parent; },
      async replaceCompanyAgentRunSteps() { return []; },
      async appendCompanyAgentRunEvent() { return {}; },
      async getCompanyAgentRun() { return { run: parent, steps: [], toolAudit: [], backgroundEvents: [] }; },
    };
    const executedInputs: Array<{ task: string; noMemory?: boolean }> = [];
    const runtime = { async execute(_ctx: unknown, _company: string, input: { task: string; noMemory?: boolean }, key: string) {
      if (!key.endsWith(":plan")) executedInputs.push(input);
      if (key.endsWith(":plan")) {
        return { run: { status: "completed", result: '{"tasks":[{"id":"frontend","title":"Build UI","role":"frontend","depends_on":[],"paths":["ui.tsx"]},{"id":"qa","title":"Verify UI","role":"qa","depends_on":["frontend"],"paths":[]}]}' } };
      }
      return { run: { status: "completed", result: "ok" } };
    } };
    const service = new ProjectMultiAgentService(store as never, runtime as never, { async startPreview() { return {}; } } as never);
    await service.execute({ workspaceId: "w", userId: "u" } as never, "c", "p", "Build UI", "Context for UI", "status-key");

    expect(executedInputs.length).toBeGreaterThanOrEqual(2);
    for (const item of executedInputs) {
      // Must not pass raw conversation
      expect(item.noMemory).toBe(true);
      // Must include Task Statuses section
      expect(item.task).toContain("Task Statuses:");
      // Must include role and project ID
      expect(item.task).toContain("Project ID: p");
    }
  });
});

describe("Run Company modes regression", () => {
  it("verifies pipeline, fusion, and single delegation plans are parsed correctly", () => {
    const planPipeline = parseProjectTaskPlan(
      '{"tasks":[{"id":"t1","title":"Design","role":"design","depends_on":[],"paths":["d.md"]},{"id":"t2","title":"Code","role":"frontend","depends_on":["t1"],"paths":["app.ts"]}]}',
      "prompt"
    );
    expect(planPipeline).toHaveLength(2);
    expect(planPipeline[1].dependsOn).toEqual(["t1"]);

    const planParallel = parseProjectTaskPlan(
      '{"tasks":[{"id":"fe","title":"Frontend","role":"frontend","depends_on":[],"paths":["ui.tsx"]},{"id":"seo","title":"SEO","role":"seo","depends_on":[],"paths":["robots.txt"]}]}',
      "prompt"
    );
    expect(planParallel).toHaveLength(2);
    expect(planParallel[0].dependsOn).toEqual([]);
    expect(planParallel[1].dependsOn).toEqual([]);
  });
});
