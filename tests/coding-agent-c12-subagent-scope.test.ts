import { describe, expect, it } from "vitest";
import type { AuthContext, CodeSession } from "@npati/workspace";
import {
  CODE_AGENT_SPAWN_TOOL,
  CODE_SUBAGENT_MAX_DEPTH,
  CODE_SUBAGENT_MAX_NODE_DEPTH,
  CODE_SUBAGENT_MAX_PARALLELISM,
  CODE_SUBAGENT_REGISTRY_MAX_CHILDREN,
  CODE_SUBAGENT_REGISTRY_MAX_DEPTH,
  resolveCodeRunCapabilityScope,
  resolveCodeSubagentLimits,
  resolveEffectiveToolSet,
  subagentDepthForRun,
} from "../apps/agent-api/src/code-subagent-limits";
import { resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import { SubagentToolPolicyGuard } from "../apps/agent-api/src/subagent-tool-policy";
import { NestedSubagentManager } from "../apps/agent-api/src/context-and-subagent-lifecycle";
import { A2AQuotaManager } from "../apps/agent-api/src/a2a-protocol-extensions";
import {
  CodingAgentRunner,
  type CodeRunToolDescriptor,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";
import {
  CodeToolRuntime,
  type CodeReadPort,
  type CodeToolSchema,
} from "../apps/agent-api/src/code-tool-runtime";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import { canonicalExecutors } from "../apps/agent-api/src/code-tool-executors";
import { executeProjectTaskGraph, type ProjectTask } from "../apps/agent-api/src/project-task-graph";
import { ProjectMultiAgentService } from "../apps/agent-api/src/project-multi-agent";

/**
 * C12 security-gate suite: a coding sub-agent is a **normal agent with a narrowed capability set**.
 *
 * Two escalation holes existed and are pinned shut here:
 *  1. the child node stored `requestedTools ?? ["*"]` — the *request*, not the intersection the guard had just
 *     computed — so asking for more produced more and asking for nothing produced everything;
 *  2. `parentSet.has("*")` short-circuited the escalation invariant, so any parent holding a wildcard was an
 *     unlimited parent whose real surface was never consulted.
 *
 * The suite also pins the structural half — depth 1 is unreachable from a child run (the tool is not offered,
 * and the runtime refuses the name before the sub-flag, the approval and the executor) — and the parallelism
 * hard ceiling, where configuration may only lower the fan-out.
 */

const ctx: AuthContext = { userId: "user-c12", workspaceId: "ws-c12", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "session-c12",
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

function descriptor(name: string, write = false): CodeRunToolDescriptor {
  return { name, version: 1, status: "active", description: name, write };
}

/** A runner whose published tool set is exactly `tools`; enough for the descriptor-level assertions. */
function runnerWithTools(tools: CodeRunToolDescriptor[], limits: Partial<{ subagentDepth: number }> = {}): CodingAgentRunner {
  const ports = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => tools.map((tool) => ({ ...tool })),
      invoke: async () => ({ ok: true, tool: "code.fs.read", toolVersion: 1, schemaVersion: 1, result: {}, truncated: false, durationMs: 0 }),
    },
    engine: { chat: async () => ({ content: "done" }) },
    ...(Object.keys(limits).length ? { limits } : {}),
  } as unknown as CodingAgentRunnerPorts;
  return new CodingAgentRunner(ports);
}

const READ_PORT_FILES: Record<string, string> = { "src/index.ts": "export const ready = true;\n" };

function fakeReadPort(): CodeReadPort {
  return {
    async listDir({ path }) {
      const entries = Object.keys(READ_PORT_FILES)
        .filter((file) => file.startsWith(path === "." ? "" : `${path}/`))
        .map((file) => ({ path: file, type: "file" as const }));
      return { entries };
    },
    async readFile({ path, maxLines }) {
      const content = READ_PORT_FILES[path];
      if (content === undefined) throw new Error("file not found");
      const lines = content.split("\n");
      return {
        path,
        content: lines.slice(0, maxLines).join("\n"),
        revision: "r1",
        sha256: "0".repeat(64),
        totalLines: lines.length,
        truncated: false,
      };
    },
    async runSearch() {
      return { matches: [], truncated: false };
    },
  };
}

const allowAllFlags = { assertEnabled: async () => true, isEnabled: async () => true } as never;

/**
 * The published registry **plus** `code.agent.spawn`. The spawn tool is added by another workstream; adding it
 * to this test-local runtime is what makes the delegation refusal reachable today, and it never touches
 * `CODE_TOOL_SCHEMAS`, the manifest or its checksum.
 */
const SPAWN_SCHEMA: CodeToolSchema = {
  name: CODE_AGENT_SPAWN_TOOL,
  version: 1,
  status: "active",
  description: "Delegate a bounded piece of work to a coding sub-agent",
  inputSchema: { type: "object", properties: { task: { type: "string" } } },
  outputSchema: { type: "object" },
};

function runtimeWithSpawnTool() {
  const project = {
    id: "project-c12", name: "C12 project", type: "code_project", description: null, status: "active",
    repositoryUrl: "https://github.com/example/repo", defaultBranch: "main",
    dataClassification: "confidential", retentionClass: "standard",
    toolchain: {
      languages: ["node", "typescript"], packageManagers: ["npm"],
      verifyCommands: { test: "npm test", lint: "npm run lint" }, source: "detected",
      detectedAt: "2025-01-01T00:00:00.000Z", evidence: ["package.json"],
    },
  };
  const schemas: CodeToolSchema[] = [...CODE_TOOL_SCHEMAS, SPAWN_SCHEMA];
  return new CodeToolRuntime({
    flags: allowAllFlags,
    schemas,
    toPort: () => fakeReadPort(),
    executors: canonicalExecutors({ projectLoader: async () => project as never }),
    limits: { readFileLines: 100, toolOutputChars: 5_000 },
  });
}

describe("security-gate: C12 canonical subagent limits", () => {
  it("keeps depth 1 and parallelism 4 as hard ceilings that configuration can only lower", () => {
    expect(CODE_SUBAGENT_MAX_DEPTH).toBe(1);
    expect(CODE_SUBAGENT_MAX_NODE_DEPTH).toBe(2);
    expect(CODE_SUBAGENT_MAX_PARALLELISM).toBe(4);

    // The clamps, directly.
    expect(resolveCodeSubagentLimits({ subagentDepth: 9, subagentParallelism: 99 }))
      .toMatchObject({ maxDepth: 1, maxParallelism: 4, delegationAllowed: true });
    expect(resolveCodeSubagentLimits({ subagentDepth: 0 }))
      .toMatchObject({ maxDepth: 0, delegationAllowed: false });
    expect(resolveCodeSubagentLimits({ subagentDepth: -3, subagentParallelism: 0 }))
      .toMatchObject({ maxDepth: 0, maxParallelism: 1 });

    // The environment is where the values actually arrive: a typo may lower them, never raise them.
    expect(resolveCodeAgentLimits({ NPATI_CODE_SUBAGENT_DEPTH: "12", NPATI_CODE_SUBAGENT_PARALLELISM: "64" }))
      .toMatchObject({ subagentDepth: 1, subagentParallelism: 4 });
    expect(resolveCodeAgentLimits({ NPATI_CODE_SUBAGENT_DEPTH: "0", NPATI_CODE_SUBAGENT_PARALLELISM: "2" }))
      .toMatchObject({ subagentDepth: 0, subagentParallelism: 2 });
    // Nonsense is not silently "no limit": it falls back to the canonical value.
    expect(resolveCodeAgentLimits({ NPATI_CODE_SUBAGENT_DEPTH: "deep", NPATI_CODE_SUBAGENT_PARALLELISM: "many" }))
      .toMatchObject({ subagentDepth: 1, subagentParallelism: 4 });
  });

  it("gives the two generic A2A registries the canonical bounds instead of their own literals", () => {
    const manager = new NestedSubagentManager();
    expect(manager.limits).toEqual({ maxDepth: CODE_SUBAGENT_MAX_NODE_DEPTH, maxChildrenPerAgent: CODE_SUBAGENT_MAX_PARALLELISM });

    // An explicit, larger request is clamped to the declared registry ceiling rather than accepted.
    const widened = new NestedSubagentManager({ maxDepth: 99, maxChildrenPerAgent: 99 });
    expect(widened.limits).toEqual({ maxDepth: CODE_SUBAGENT_REGISTRY_MAX_DEPTH, maxChildrenPerAgent: CODE_SUBAGENT_REGISTRY_MAX_CHILDREN });

    const quota = new A2AQuotaManager();
    expect(quota.setSessionBudget("s-default").maxRecursionDepth).toBe(CODE_SUBAGENT_MAX_NODE_DEPTH);
    expect(quota.setSessionBudget("s-widened", 1_000, 1, 99).maxRecursionDepth).toBe(CODE_SUBAGENT_REGISTRY_MAX_DEPTH);
    // The canonical node depth really is the coding limit expressed the registry's way: root = 1, child = 2.
    expect(subagentDepthForRun(null)).toBe(1);
    expect(subagentDepthForRun("run-parent")).toBe(CODE_SUBAGENT_MAX_NODE_DEPTH);
  });
});

describe("security-gate: C12 depth 1 is structural, not a check", () => {
  const published = [descriptor("code.fs.read"), descriptor(CODE_AGENT_SPAWN_TOOL), descriptor("code.fs.edit", true)];

  it("never offers the delegation tool to a run that already has a parent", () => {
    const runner = runnerWithTools(published);
    // Control: the tool is published and a main run may delegate at the canonical depth.
    expect(runner.toolDescriptors(session()).map((tool) => tool.name)).toContain(CODE_AGENT_SPAWN_TOOL);

    const child = runner.toolDescriptors(session(), {
      capabilityScope: resolveCodeRunCapabilityScope({
        parentRunId: "run-parent",
        allowedTools: [CODE_AGENT_SPAWN_TOOL, "code.fs.read"],
        canonicalTools: published.map((tool) => tool.name),
      }),
    });
    expect(child.map((tool) => tool.name)).not.toContain(CODE_AGENT_SPAWN_TOOL);

    // Configuration may turn delegation off for everyone: depth 0 removes it from the main run too.
    const noDelegation = runnerWithTools(published, { subagentDepth: 0 });
    expect(noDelegation.toolDescriptors(session()).map((tool) => tool.name)).not.toContain(CODE_AGENT_SPAWN_TOOL);
  });

  it("refuses the delegation tool inside the tool runtime for a run that has a parent", async () => {
    const runtime = runtimeWithSpawnTool();
    const base = { companyId: "company-c12", projectId: "project-c12", toolCallId: "call-1", tool: CODE_AGENT_SPAWN_TOOL, args: { task: "delegate this" } };

    // A main run is not refused by this gate (it gets past it and fails later for its own reasons).
    const root = await runtime.invoke(ctx, { ...base });
    expect((root as { error?: { code?: string } }).error?.code).not.toBe("subagent_depth_exceeded");

    const child = await runtime.invoke(ctx, { ...base, parentRunId: "run-parent" });
    expect(child).toMatchObject({ ok: false, error: { code: "subagent_depth_exceeded", status: 403, step: "policy" } });
  });

  it("stops a child run with no recorded scope instead of inheriting the parent's tools", async () => {
    const runner = runnerWithTools(published);
    // The refusal happens before any model call, so an engine that records being reached is the strongest
    // available assertion: a run that never called the provider cannot have executed anything.
    const engineCalls: string[] = [];
    const ports = (runner as unknown as { ports: CodingAgentRunnerPorts }).ports;
    ports.engine = { chat: async () => { engineCalls.push("chat"); return { content: "should not run" }; } };

    const refused = await runner.run({ ctx, session: session(), prompt: "work", subagentScope: { parentRunId: "run-parent" } });
    expect(refused).toMatchObject({ status: "failed", reason: "refused" });
    expect((refused as { message: string }).message).toContain("no capability scope was recorded");
    expect(engineCalls).toEqual([]);
  });
});

describe("security-gate: C12 capability narrowing is an intersection", () => {
  const canonical = ["code.fs.read", "code.fs.edit", "code.git.push", CODE_AGENT_SPAWN_TOOL];

  it("gives a child the parent's effective set intersected with its own profile — never the requested set", () => {
    const guard = new SubagentToolPolicyGuard();
    const result = guard.evaluateSubagentTools({
      parentAgentId: "agent-parent",
      parentAllowedTools: ["code.fs.read", "code.fs.edit"],
      childAgentId: "agent-child",
      // The child's type profile names a tool the parent does not hold: a profile is not a grant.
      childBaseTools: ["code.fs.read", "code.fs.edit", "code.git.push"],
      // The delegation record asks for the same three: a request is not a grant either.
      delegationAllowedTools: ["code.fs.read", "code.fs.edit", "code.git.push"],
      canonicalTools: canonical,
    });

    expect(result.effectiveParentTools).toEqual(["code.fs.read", "code.fs.edit"]);
    expect(result.permittedTools).toEqual(["code.fs.read", "code.fs.edit"]);
    expect(result.escalationAttempts).toEqual(["code.git.push"]);
    expect(result.wildcardUnresolved).toBe(false);
  });

  it("narrows the delegation record inside the parent's set and inside the child type profile", () => {
    const guard = new SubagentToolPolicyGuard();
    const result = guard.evaluateSubagentTools({
      parentAgentId: "agent-parent",
      parentAllowedTools: ["code.fs.read", "code.fs.edit", CODE_AGENT_SPAWN_TOOL],
      childAgentId: "agent-child",
      // The child type may read and delegate, but not edit.
      childBaseTools: ["code.fs.read", CODE_AGENT_SPAWN_TOOL],
      delegationAllowedTools: ["code.fs.read", "code.fs.edit", CODE_AGENT_SPAWN_TOOL],
      canonicalTools: canonical,
    });

    expect(result.permittedTools).toEqual(["code.fs.read", CODE_AGENT_SPAWN_TOOL]);
    expect(result.escalationAttempts).toEqual([]);
    expect(result.deniedTools.map((entry) => entry.tool)).toEqual(["code.fs.edit"]);
    expect(result.deniedTools[0]!.reason).toContain("CHILD_TYPE_PROFILE_EXCLUDES");
  });

  it("expands a wildcard only against the canonical universe, and to nothing without one", () => {
    const guard = new SubagentToolPolicyGuard();
    const withUniverse = guard.evaluateSubagentTools({
      parentAgentId: "agent-parent",
      parentAllowedTools: ["*"],
      childAgentId: "agent-child",
      childBaseTools: ["code.fs.read", "code.fs.edit"],
      canonicalTools: canonical,
    });
    expect(withUniverse.permittedTools).toEqual(["code.fs.read", "code.fs.edit"]);
    expect(withUniverse.effectiveParentTools).toEqual(canonical);
    expect(withUniverse.wildcardUnresolved).toBe(false);

    const withoutUniverse = guard.evaluateSubagentTools({
      parentAgentId: "agent-parent",
      parentAllowedTools: ["all"],
      childAgentId: "agent-child",
      childBaseTools: ["code.fs.read", "code.fs.edit"],
    });
    expect(withoutUniverse.wildcardUnresolved).toBe(true);
    expect(withoutUniverse.permittedTools).toEqual([]);
    expect(withoutUniverse.effectiveParentTools).toEqual([]);
  });

  it("does not grant a tool that only exists in the general set", () => {
    // A tool added to the published set tomorrow: the child's recorded scope does not name it, so it is not
    // granted, not offered and not executable — "it exists" is never a reason for a delegation to widen.
    const published = [...canonical, "code.fs.brand_new"];
    expect(resolveEffectiveToolSet(["code.fs.read", CODE_AGENT_SPAWN_TOOL], published).tools)
      .toEqual(["code.fs.read", CODE_AGENT_SPAWN_TOOL]);

    const scope = resolveCodeRunCapabilityScope({
      parentRunId: "run-parent",
      allowedTools: ["code.fs.read"],
      canonicalTools: published,
    });
    expect(scope.tools).toEqual(["code.fs.read"]);
    expect(scope.mayDelegate).toBe(false);

    const runner = runnerWithTools(published.map((name) => descriptor(name)));
    expect(runner.toolDescriptors(session(), { capabilityScope: scope }).map((tool) => tool.name)).toEqual(["code.fs.read"]);
  });

  it("stops storing a wildcard in a child node and reports an unresolvable grant instead", () => {
    const manager = new NestedSubagentManager({ maxDepth: 3 });
    // `*` with no canonical universe is not "everything": the node's grant is empty and says it is unresolved.
    const root = manager.spawnSubagent({ agentId: "root", name: "Root", requestedTools: ["*"] });
    expect(root.allowedTools).toEqual([]);
    expect(root.capabilityScopeResolved).toBe(false);

    // A child of that node inherits an empty set — never `["*"]` — and is resolved (it is empty, not unknown).
    const child = manager.spawnSubagent({ agentId: "child", name: "Child", parentAgentId: "root" });
    expect(child.allowedTools).toEqual([]);
    expect(child.capabilityScopeResolved).toBe(true);

    // And nothing can be obtained from a grant that was never resolved: the request is refused, fail closed.
    expect(() => manager.spawnSubagent({ agentId: "ambitious", name: "Ambitious", parentAgentId: "root", requestedTools: ["code.fs.read"] }))
      .toThrow(/PRIVILEGE_ESCALATION_BLOCKED/);
  });

  it("stores the intersection in the child node and refuses an escalation request outright", () => {
    const manager = new NestedSubagentManager({ maxDepth: 3 });
    const root = manager.spawnSubagent({
      agentId: "root",
      name: "Root",
      requestedTools: ["code.fs.read", "code.fs.edit"],
      canonicalTools: ["code.fs.read", "code.fs.edit", "code.git.push"],
    });
    expect(root.allowedTools).toEqual(["code.fs.read", "code.fs.edit"]);

    const child = manager.spawnSubagent({
      agentId: "child",
      name: "Child",
      parentAgentId: "root",
      requestedTools: ["code.fs.edit"],
      childTypeTools: ["code.fs.read", "code.fs.edit"],
      canonicalTools: ["code.fs.read", "code.fs.edit", "code.git.push"],
    });
    // Exactly the request, because it is a subset of the parent's effective set and of the child type profile.
    expect(child.allowedTools).toEqual(["code.fs.edit"]);

    // Asking for more than the parent holds is refused — it is never stored and never reported as granted.
    expect(() => manager.spawnSubagent({
      agentId: "greedy",
      name: "Greedy",
      parentAgentId: "root",
      requestedTools: ["code.git.push"],
      canonicalTools: ["code.fs.read", "code.fs.edit", "code.git.push"],
    })).toThrow(/PRIVILEGE_ESCALATION_BLOCKED/);
    expect(manager.getNode("greedy")).toBeUndefined();

    // A wildcard grant with a canonical universe resolves to the universe; the child is then narrowed by it.
    const wildcardRoot = manager.spawnSubagent({
      agentId: "wildcard-root",
      name: "Wildcard root",
      requestedTools: ["*"],
      canonicalTools: ["code.fs.read", "code.fs.edit"],
    });
    expect(wildcardRoot.allowedTools).toEqual(["code.fs.read", "code.fs.edit"]);
    expect(wildcardRoot.capabilityScopeResolved).toBe(true);
    const wildcardChild = manager.spawnSubagent({ agentId: "wildcard-child", name: "Wildcard child", parentAgentId: "wildcard-root" });
    expect(wildcardChild.allowedTools).toEqual(["code.fs.read", "code.fs.edit"]);
  });
});

describe("security-gate: C12 the tool runtime enforces the recorded scope", () => {
  it("refuses a tool outside the recorded scope before the sub-flag, the approval and the executor", async () => {
    const runtime = runtimeWithSpawnTool();
    const base = { companyId: "company-c12", projectId: "project-c12", toolCallId: "call-scope", tool: "code.fs.read", args: { path: "src/index.ts" } };

    const outside = await runtime.invoke(ctx, { ...base, capabilityScope: ["code.fs.edit"] });
    expect(outside).toMatchObject({ ok: false, error: { code: "subagent_tool_scope_denied", status: 403, step: "policy" } });

    // Control: the same call inside its scope really executes, so the refusal is the scope and nothing else.
    const inside = await runtime.invoke(ctx, { ...base, capabilityScope: ["code.fs.read"] });
    expect(inside).toMatchObject({ ok: true, tool: "code.fs.read" });

    // An ordinary run (no scope recorded) is unaffected: the field narrows, it is not a new requirement.
    const ordinary = await runtime.invoke(ctx, { ...base, toolCallId: "call-plain" });
    expect(ordinary).toMatchObject({ ok: true });
  });

  it("carries the same object into the descriptor list and into the runtime", () => {
    const published = [descriptor("code.fs.read"), descriptor("code.fs.edit"), descriptor(CODE_AGENT_SPAWN_TOOL)];
    const scope = resolveCodeRunCapabilityScope({
      parentRunId: "run-parent",
      allowedTools: ["code.fs.read", CODE_AGENT_SPAWN_TOOL, "code.fs.unpublished"],
      canonicalTools: published.map((tool) => tool.name),
    });
    // The published universe bounds the record: an unpublished name is dropped and reported. The delegation
    // tool may still appear *in the record* — what removes it is the structural rule, applied by the runner
    // (below) and by the tool runtime (the `parentRunId` refusal), not a second filter here.
    expect(scope.tools).toEqual(["code.fs.read", CODE_AGENT_SPAWN_TOOL]);
    expect(scope.unknownTools).toEqual(["code.fs.unpublished"]);
    expect(scope.mayDelegate).toBe(false);

    const runner = runnerWithTools(published);
    expect(runner.toolDescriptors(session(), { capabilityScope: scope }).map((tool) => tool.name)).toEqual(["code.fs.read"]);
  });
});

describe("security-gate: C12 parallelism is a hard ceiling", () => {
  const independentTasks = (count: number): ProjectTask[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `t${index}`,
      title: `Task ${index}`,
      role: "frontend" as const,
      dependsOn: [],
      paths: [`src/file-${index}.ts`],
      status: "queued" as const,
    }));

  it("clamps the graph's fan-out to the canonical ceiling however large the caller's number is", async () => {
    const tasks = independentTasks(8);
    let active = 0;
    let peak = 0;
    await executeProjectTaskGraph(tasks, async (task) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return task.id;
    }, async () => undefined, 99);
    expect(peak).toBe(CODE_SUBAGENT_MAX_PARALLELISM);
    expect(tasks.every((task) => task.status === "completed")).toBe(true);
  });

  it("runs the planned tasks at the configured fan-out, which configuration can only lower", async () => {
    async function peakFor(parallelism?: number) {
      const agents = [
        { id: "main", role: "manager", isActive: true, tools: [], modelId: "auto" },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `dev${index}`, role: "frontend developer", isActive: true, tools: ["project.files.read"], modelId: "auto",
        })),
      ] as never[];
      const parent = { id: "parent-c12", status: "queued", requestedMode: "pipeline", result: "" };
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
      const plan = JSON.stringify({
        tasks: Array.from({ length: 6 }, (_, index) => ({
          id: `t${index}`, title: `Task ${index}`, role: "frontend", depends_on: [], paths: [`src/file-${index}.ts`],
        })),
      });
      let active = 0;
      let peak = 0;
      const runtime = {
        async execute(_ctx: unknown, _company: string, _input: unknown, key: string) {
          if (key.endsWith(":plan")) return { run: { status: "completed", result: plan } };
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { run: { status: "completed", result: "ok" } };
        },
      };
      const service = new ProjectMultiAgentService(
        store as never,
        runtime as never,
        { async startPreview() { return {}; } } as never,
        undefined,
        undefined,
        undefined,
        parallelism === undefined ? undefined : { parallelism },
      );
      const result = await service.execute({ workspaceId: "w", userId: "u" } as never, "c", "p", "Build", "ctx", `k-${parallelism ?? "default"}`);
      expect(result?.run.status).toBe("completed");
      return peak;
    }

    // The configured default is read (this was dead configuration before C12) …
    expect(await peakFor()).toBe(CODE_SUBAGENT_MAX_PARALLELISM);
    // … configuration may lower it …
    expect(await peakFor(2)).toBe(2);
    // … and an absurd value is clamped to the ceiling instead of being honoured.
    expect(await peakFor(99)).toBe(CODE_SUBAGENT_MAX_PARALLELISM);
  });
});
