import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import type { CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import {
  CodingAgentRunner,
  type CodeRunActivityEvent,
  type CodeRunToolDescriptor,
  type CodingAgentChatRequest,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "session-1",
    workspaceId: "ws-1",
    companyId: "company-1",
    projectId: "project-1",
    userId: "user-1",
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

const TOOLS: CodeRunToolDescriptor[] = [
  { name: "code.fs.edit", version: 1, status: "active", description: "edit", write: true },
  { name: "code.fs.apply_patch", version: 1, status: "active", description: "patch", write: true },
  { name: "code.fs.read", version: 1, status: "active", description: "read a file", write: false },
];
const SCHEMAS = TOOLS.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { path: { type: "string" } } } }));

function nativeCall(name: string, args: Record<string, unknown>, id: string) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

interface HarnessOptions {
  script: Array<ChatResult>;
  limits?: Partial<CodeAgentLimits>;
  quotaAllowed?: boolean;
  onFirstModelCall?: () => void;
  onToolInvoke?: (input: { runId?: string; runScopeId?: string; turnId?: string }) => void;
  flagsThrow?: boolean;
  modelProfiles?: CodingAgentRunnerPorts["modelProfiles"];
  admissionGate?: CodingAgentRunnerPorts["admissionGate"];
}

function createHarness(options: HarnessOptions) {
  const engineCalls: CodingAgentChatRequest[] = [];
  const activity: CodeRunActivityEvent[] = [];
  const script = [...options.script];
  let clock = 1_000;
  const start = clock;

  const ports: CodingAgentRunnerPorts = {
    ...(options.modelProfiles ? { modelProfiles: options.modelProfiles } : {}),
    flags: {
      assertEnabled: async () => {
        if (options.flagsThrow) throw Object.assign(new Error("disabled"), { code: "feature_disabled" });
        return true;
      },
    },
    rbac: { authorize: async () => ({ allowed: true }) },
    ...(options.admissionGate ? { admissionGate: options.admissionGate } : {}),
    toolRuntime: {
      listTools: () => TOOLS,
      invoke: async (_ctx, input) => {
        options.onToolInvoke?.(input);
        return ({
          ok: true,
          tool: input.tool,
          toolVersion: 1,
          schemaVersion: 1,
          result: { ok: true },
          truncated: false,
          durationMs: 1,
        }) satisfies CodeToolInvokeResult;
      },
    },
    engine: {
      chat: async (request) => {
        engineCalls.push(request);
        if (engineCalls.length === 1) options.onFirstModelCall?.();
        return script.shift() ?? { content: "done" };
      },
    },
    schemas: SCHEMAS,
    quota: {
      checkQuota: () => (options.quotaAllowed === false ? { allowed: false, error: "A2A_TOKEN_QUOTA_EXCEEDED" } : { allowed: true }),
      recordUsage: () => undefined,
    },
    activity: { record: async (event) => { activity.push(event); } },
    runEvents: { append: async (entry) => entry },
    limits: { maxStepsPerRun: 10, maxRunMinutes: 5, ...(options.limits ?? {}) },
    now: () => clock,
  };

  const runner = new CodingAgentRunner(ports);
  return {
    runner,
    engineCalls,
    activity,
    setClock: (value: number) => { clock = value; },
    run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
      runner.run({ ctx, session: session(), prompt: "fix the failing test", ...input }),
  };
}

describe("security-gate: C6 runner — every stop condition reports a reason and a summary", () => {
  it("fails closed when a configured execution snapshot cannot be persisted", async () => {
    let modelCalls = 0;
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => TOOLS, invoke: async () => { throw new Error("must not execute"); } },
      engine: { chat: async () => { modelCalls++; return { content: "done" }; } }, schemas: SCHEMAS,
      snapshot: { create: async () => { throw new Error("store unavailable"); } },
    });
    const result = await runner.run({ ctx, session: session(), prompt: "fix" });
    expect(result).toMatchObject({ status: "failed", reason: "refused", code: "snapshot_unavailable" });
    expect(modelCalls).toBe(0);
  });

  it("does not execute model tool calls that resolve after cancellation", async () => {
    const controller = new AbortController();
    const events: Array<import("@npati/shared").DevelopmentProcessProgressItem> = [];
    const harness = createHarness({ script: [{ content: "", usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 }, toolCalls: [nativeCall("code.fs.read", { path: "a.ts" }, "late-call")] }], onFirstModelCall: () => controller.abort() });
    const result = await harness.run({ signal: controller.signal, onActivity: async event => { events.push(event); } });
    expect(result.summary.tokens).toBe(18);
    expect(harness.activity.some(event => event.kind === "model_call" && event.phase === "completed")).toBe(true);
    // The `planning` event carries the assistant's prose (`title: result.content`), and this scripted turn has no
    // prose — only a tool call. Emitting an empty "planning completed" message would be a fabricated event, so the
    // contract is the opposite: no prose, no planning event. The real telemetry of the turn is asserted above.
    expect(events.some(event => event.stage === "planning")).toBe(false);
    expect(events.some(event => event.stage === "model_usage" && event.modelUsage?.totalTokens === 18)).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("cancelled");
    expect(result.summary.toolCalls).toBe(0);
  });

  it("classifies cancellation during a rejected provider call as cancelled", async () => {
    const controller = new AbortController();
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => TOOLS, invoke: async () => { throw new Error("must not execute"); } },
      engine: { chat: async () => { controller.abort(); throw new Error("request aborted"); } }, schemas: SCHEMAS,
    });
    const result = await runner.run({ ctx, session: session(), prompt: "fix", signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("cancelled");
  });

  it("stops with completed when the model makes no tool call", async () => {
    const harness = createHarness({ script: [{ content: "nothing to do" }] });
    const result = await harness.run();
    expect(result.reason).toBe("completed");
    expect(result.status).toBe("completed");
    expect(result.summary.turns).toBe(1);
    expect(result.summary.remaining).toContain("without further tool calls");
  });

  it("stops with step_limit at maxStepsPerRun", async () => {
    const calls = Array.from({ length: 6 }, (_value, index) => ({
      content: "",
      toolCalls: [nativeCall("code.fs.read", { path: `file-${index}.ts` }, `call-${index}`)],
    }));
    const harness = createHarness({ script: calls, limits: { maxStepsPerRun: 2 } });
    const result = await harness.run();
    expect(result.reason).toBe("step_limit");
    expect(result.status).toBe("stopped");
    expect(result.summary.turns).toBe(2);
    expect(result.summary.remaining).toContain("Step limit");
  });

  it("does not stop at a step limit when maxStepsPerRun is zero", async () => {
    const calls = Array.from({ length: 6 }, (_value, index) => ({
      content: "",
      toolCalls: [nativeCall("code.fs.read", { path: `file-${index}.ts` }, `unlimited-${index}`)],
    }));
    const harness = createHarness({ script: [...calls, { content: "done" }], limits: { maxStepsPerRun: 0 } });
    const result = await harness.run();
    expect(result.reason).toBe("completed");
    expect(result.status).toBe("completed");
  });

  it("does not stop at a time limit when maxRunMinutes is zero", async () => {
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.read", { path: "a.ts" }, "unlimited-time")] },
        { content: "done" },
      ],
      limits: { maxRunMinutes: 0 },
      onFirstModelCall: () => harness.setClock(1_000 + 120_000),
    });
    const result = await harness.run();
    expect(result.reason).toBe("completed");
    expect(result.status).toBe("completed");
  });

  it("stops with time_limit once the run exceeds maxRunMinutes", async () => {
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.read", { path: "a.ts" }, "call-1")] },
        { content: "done" },
      ],
      limits: { maxRunMinutes: 1 },
      onFirstModelCall: () => harness.setClock(1_000 + 120_000),
    });
    const result = await harness.run();
    expect(result.reason).toBe("time_limit");
    expect(result.status).toBe("stopped");
    expect(result.summary.remaining).toContain("Time limit");
  });

  it("stops with budget_exhausted when the quota check refuses", async () => {
    const harness = createHarness({ script: [{ content: "done" }], quotaAllowed: false });
    const result = await harness.run();
    expect(result.reason).toBe("budget_exhausted");
    expect(result.status).toBe("stopped");
    expect(result.summary.remaining).toContain("A2A_TOKEN_QUOTA_EXCEEDED");
  });

  it("stops with cancelled when the signal is already aborted", async () => {
    const harness = createHarness({ script: [{ content: "done" }] });
    const controller = new AbortController();
    controller.abort();
    const result = await harness.run({ signal: controller.signal });
    expect(result.reason).toBe("cancelled");
    expect(result.status).toBe("cancelled");
    expect(harness.engineCalls).toHaveLength(0);
  });

  it("stops with provider_error when the engine's fallback chain fails", async () => {
    const harness = createHarness({
      script: [],
    });
    // The script is empty → the engine returns "done"; use a throwing engine instead for this case.
    const failing = new CodingAgentRunner({
      flags: { assertEnabled: async () => true },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => TOOLS, invoke: async () => { throw new Error("unused"); } },
      engine: { chat: async () => { throw new Error("chain exhausted"); } },
      schemas: SCHEMAS,
      limits: { maxStepsPerRun: 3, maxRunMinutes: 5 },
    });
    const result = await failing.run({ ctx, session: session(), prompt: "x" });
    expect(result.reason).toBe("provider_error");
    expect(result.status).toBe("failed");
    // The happy path harness is untouched by the failing one (no cross-test state).
    expect((await harness.run()).reason).toBe("completed");
  });

  it("stops with refused for a disabled feature flag and still returns a summary", async () => {
    const harness = createHarness({ script: [{ content: "done" }], flagsThrow: true });
    const result = await harness.run();
    expect(result.reason).toBe("refused");
    expect(result.summary.turns).toBe(0);
    expect(result.summary.toolCalls).toBe(0);
    expect(harness.engineCalls).toHaveLength(0);
    expect(harness.activity).toHaveLength(0);
  });

  it("reports the empty snapshot id until C6b provides a provider", async () => {
    const harness = createHarness({ script: [{ content: "done" }] });
    const result = await harness.run();
    expect(result.snapshotId).toBe("");
  });

  it("starts normally when no deployment admission gate is configured", async () => {
    const harness = createHarness({ script: [{ content: "done" }] });
    const result = await harness.run();
    expect(result.reason).toBe("completed");
    expect(result.code).toBeUndefined();
    expect(harness.engineCalls).toHaveLength(1);
  });

  it("refuses the run with disk_pressure before the first model call when the reaper asks", async () => {
    const harness = createHarness({
      script: [{ content: "done" }],
      admissionGate: { isRefusingNewRuns: () => true },
    });
    const result = await harness.run();
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("refused");
    expect(result.code).toBe("disk_pressure");
    expect(result.message).toContain("disk_pressure");
    expect(harness.engineCalls).toHaveLength(0);
    expect(result.summary.turns).toBe(0);
  });

  it("refuses the run when the admission gate cannot answer (fail closed)", async () => {
    const harness = createHarness({
      script: [{ content: "done" }],
      admissionGate: {
        isRefusingNewRuns: () => {
          throw new Error("reaper unreachable");
        },
      },
    });
    const result = await harness.run();
    expect(result.reason).toBe("refused");
    expect(result.code).toBe("admission_gate_unavailable");
    expect(harness.engineCalls).toHaveLength(0);
  });

  it("uses the gate's own refusal code when it reports one", async () => {
    const harness = createHarness({
      script: [{ content: "done" }],
      admissionGate: { isRefusingNewRuns: () => true, refusalCode: () => "run_state_store_pressure" },
    });
    const result = await harness.run();
    expect(result.code).toBe("run_state_store_pressure");
    expect(harness.engineCalls).toHaveLength(0);
  });
});

describe("security-gate: C1a flags during an active model exchange", () => {
  it("stops before dispatching tools returned after the flag was disabled in flight", async () => {
    const options: HarnessOptions = { script: [{ content: "", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      toolCalls: [nativeCall("code.fs.read", { path: "should-not-read.ts" }, "late-flag-call")] }] };
    options.onFirstModelCall = () => { options.flagsThrow = true; };
    const harness = createHarness(options);
    const result = await harness.run();
    expect(result).toMatchObject({ status: "suspended_by_flag", reason: "feature_disabled", code: "feature_disabled" });
    expect(result.summary.toolCalls).toBe(0);
    expect(result.summary.tokens).toBe(8);
    expect(harness.engineCalls).toHaveLength(1);
  });
  it("does not call the model again when a completed tool is followed by flag disablement", async () => {
    let enabled = true, modelCalls = 0, toolCalls = 0;
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => { if (!enabled) throw Object.assign(new Error("Disabled"), { code: "feature_disabled" }); return true; } },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => TOOLS, invoke: async (_ctx, input) => {
        toolCalls++; enabled = false;
        return { ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: { ok: true }, truncated: false, durationMs: 1 };
      } },
      engine: { chat: async () => { modelCalls++; return modelCalls === 1
        ? { content: "", toolCalls: [nativeCall("code.fs.read", { path: "first.ts" }, "first")] }
        : { content: "Must not call again" }; } },
      schemas: SCHEMAS,
    });
    const result = await runner.run({ ctx, session: session(), prompt: "Read a file" });
    expect(result).toMatchObject({ status: "suspended_by_flag", reason: "feature_disabled", code: "feature_disabled" });
    expect(modelCalls).toBe(1);
    expect(toolCalls).toBe(1);
  });
});

describe("security-gate: C1a signal suspension", () => {
  it.each(["resolve", "reject"] as const)("preserves kill-switch suspension after an in-flight provider %s", async (outcome) => {
    const controller = new AbortController();
    let invoked = 0;
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => TOOLS, invoke: async () => { invoked++; throw new Error("Must not execute"); } },
      engine: { chat: async () => {
        controller.abort({ code: "feature_disabled" });
        if (outcome === "reject") throw new Error("Provider aborted");
        return { content: "", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
          toolCalls: [nativeCall("code.fs.read", { path: "late.ts" }, "flag-abort")] };
      } }, schemas: SCHEMAS,
    });
    const result = await runner.run({ ctx, session: session(), prompt: "Read", signal: controller.signal });
    expect(result).toMatchObject({ status: "suspended_by_flag", reason: "feature_disabled", code: "feature_disabled" });
    expect(invoked).toBe(0);
    if (outcome === "resolve") expect(result.summary.tokens).toBe(8);
  });
});

describe("security-gate: C1a durable flag suspension", () => {
  it("persists a resumable suspended_by_flag run rather than recording failure or user cancellation", async () => {
    const { InMemoryWorkspaceStore } = await import("@npati/workspace");
    const { CodeRunStateLog, refuseResume } = await import("../apps/agent-api/src/code-run-state");
    const owner = { ...ctx, permissions: ["*", "owner"] };
    const store = new InMemoryWorkspaceStore(); await store.initialize(owner);
    const company = await store.createCompany(owner, { name: "Flag Suspension" }, "flag-suspension");
    const { project } = await store.createProject(owner, company.id, { name: "Owned", type: "code_project" }, "flag-project");
    const saved = await store.createCodeSession(owner, company.id, project.id, {});
    let enabled = true;
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => { if (!enabled) throw Object.assign(new Error("Disabled"), { code: "feature_disabled" }); return true; } },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => TOOLS, invoke: async () => { throw new Error("No tool should execute"); } },
      engine: { chat: async () => { enabled = false; return { content: "Interrupted by kill switch" }; } },
      schemas: SCHEMAS, runState: new CodeRunStateLog({ store }),
    });
    const result = await runner.run({ ctx: owner, session: saved, prompt: "Read", runId: "durable-flag-run" });
    expect(result).toMatchObject({ status: "suspended_by_flag", reason: "feature_disabled", code: "feature_disabled" });
    const state = await store.getCodeRunState(company.id, "durable-flag-run");
    expect(state).toMatchObject({ status: "suspended_by_flag", details: { stopReason: "feature_disabled" } });
    expect(state!.leaseOwner).toBeNull();
    expect(refuseResume(state!.status)).toBeNull();
    const resumed = await new CodeRunStateLog({ store }).resumeRun({ companyId: company.id, runId: "durable-flag-run", owner: "resumed-worker" });
    expect(resumed.held).toBe(true);
    expect(resumed.state).toMatchObject({ status: "running", finishedAt: null, leaseOwner: "resumed-worker" });
  });
});

describe("security-gate: PLAN default turn budget integration", () => {
  it.each([40, 60])("stops before dispatching model turn beyond the configured %i turn budget", async limit => {
    const { DEFAULT_CODE_AGENT_LIMITS, resolveCodeAgentLimits } = await import("../apps/agent-api/src/code-agent-config");
    const configured = limit === 40 ? resolveCodeAgentLimits({}) : resolveCodeAgentLimits({ NPATI_CODE_MAX_STEPS: "60" });
    if (limit === 40) expect(DEFAULT_CODE_AGENT_LIMITS.maxStepsPerRun).toBe(40);
    const h = createHarness({ limits: configured,
      script: Array.from({ length: limit + 1 }, (_, index) => ({ content: "", toolCalls: [nativeCall("code.fs.read", { path: "file-" + index + ".ts" }, "budget-" + index)] })) });
    const result = await h.run();
    expect(result).toMatchObject({ status: "stopped", reason: "step_limit" });
    expect(h.engineCalls).toHaveLength(limit);
    expect(result.summary.remaining).toContain("unfinished");
  });
});

describe("security-gate: C3 profile preference reaches the actual model request", () => {
  it.each(["code.fs.apply_patch", "code.fs.edit", "apply_patch"])("passes configured %s without branching on the model name", async preferred => {
    const h = createHarness({ script: [{ content: "done" }], modelProfiles: { profiles: [{
      id: "custom-proof", match: { models: ["custom-proof-model"] }, toolCallingMode: "native",
      ...(preferred === "apply_patch" ? { preferred_edit_tool: preferred } : { preferredEditTool: preferred }), maxParallelToolCalls: 1, contextWindow: 32768,
    }] } });
    await h.run({ model: "custom-proof-model" });
    expect(h.engineCalls[0]?.messages[0]?.content).toContain("Editing preference from model profile: " + (preferred === "apply_patch" ? "code.fs.apply_patch" : preferred));
  });
});

describe("security-gate: C3 runner operation scope", () => {
  it.each(["durable-run", undefined])("keeps stable operation identity across model turns with runId %s", async runId => {
    const calls: Array<{ runId?: string; runScopeId?: string; turnId?: string }> = [];
    const harness = createHarness({
      script: [0, 1, 2].map(index => ({ content: "", toolCalls: [nativeCall("code.fs.read", { path: "file-" + index }, "scope-" + index)] })),
      onToolInvoke: input => calls.push({ runId: input.runId, runScopeId: input.runScopeId, turnId: input.turnId }),
    });
    await harness.run({ runId, turnId: "user-request" });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(call => call.turnId)).size).toBe(3);
    expect(calls.every(call => call.runId === runId)).toBe(true);
    expect(calls.every(call => call.runScopeId === "user-request")).toBe(true);
  });
});


it("stops website inspection with changing arguments after ten turns without saved source progress", async () => {
  const h = createHarness({ limits: { maxStepsPerRun: 40 }, script: Array.from({ length: 30 }, (_, i) => ({ content: "Inspect", toolCalls: [nativeCall("code.fs.read", { path: "component-" + i + ".tsx" }, "read-" + i)] })) });
  const result = await h.run({ websiteEdit: true });
  expect(result.reason).toBe("loop_detected");
  expect(h.engineCalls.length).toBeLessThanOrEqual(11);
  expect(result.summary.filesChanged).toEqual([]);
  expect(h.activity.some(event => event.kind === "reminder" && event.reason === "no_source_progress")).toBe(true);
});


it("retains reference bytes only for the active authorized parent and clears them on settlement", async () => {
  const images = [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }];
  const h = createHarness({ script: [{ content: "done" }], onFirstModelCall: () => {
    expect(h.runner.referenceContext(ctx, session(), "visual-root")?.images).toBe(images);
    expect(h.runner.referenceContext({ ...ctx, userId: "foreign" }, session(), "visual-root")).toBeUndefined();
    expect(h.runner.referenceContext(ctx, session({ projectId: "other" }), "visual-root")).toBeUndefined();
  } });
  await h.run({ runId: "visual-root", images, model: "vision" });
  expect(h.runner.referenceContext(ctx, session(), "visual-root")).toBeUndefined();
  const imageParts = (h.engineCalls[0]!.messages.find(message => message.role === "user")!.content as any[]).filter(part => part.type === "image_url");
  expect(imageParts).toHaveLength(1);
});
