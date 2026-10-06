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
  flagsThrow?: boolean;
}

function createHarness(options: HarnessOptions) {
  const engineCalls: CodingAgentChatRequest[] = [];
  const activity: CodeRunActivityEvent[] = [];
  const script = [...options.script];
  let clock = 1_000;
  const start = clock;

  const ports: CodingAgentRunnerPorts = {
    flags: {
      assertEnabled: async () => {
        if (options.flagsThrow) throw Object.assign(new Error("disabled"), { code: "feature_disabled" });
        return true;
      },
    },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => TOOLS,
      invoke: async (_ctx, input) =>
        ({
          ok: true,
          tool: input.tool,
          toolVersion: 1,
          schemaVersion: 1,
          result: { ok: true },
          truncated: false,
          durationMs: 1,
        }) satisfies CodeToolInvokeResult,
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
    engineCalls,
    activity,
    setClock: (value: number) => { clock = value; },
    run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
      runner.run({ ctx, session: session(), prompt: "fix the failing test", ...input }),
  };
}

describe("security-gate: C6 runner — every stop condition reports a reason and a summary", () => {
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
});
