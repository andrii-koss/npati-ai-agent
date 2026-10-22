import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import {
  executableToolCalls,
  normalizeToolCalls,
  type KnownTool,
} from "../apps/agent-api/src/code-tool-call-adapter";
import {
  CodingAgentRunner,
  type CodeRunActivityEvent,
  type CodeRunToolDescriptor,
  type CodingAgentChatRequest,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";

/**
 * Step 1 — truncated tool calls and rejected-call loop detection.
 *
 * Everything here is exercised against a scripted engine and an in-memory tool runtime: no workspace, no
 * provider, no database. The provider behaviour that motivated the fix (a ~21.2 KB argument cap while
 * reasoning is disabled) is recorded in `docs/audit/step-1-tool-calls.md`.
 */

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
  { name: "code.fs.read", version: 1, status: "active", description: "read", write: false },
  { name: "code.fs.write", version: 1, status: "active", description: "write", write: true },
  { name: "code.fs.edit", version: 1, status: "active", description: "edit", write: true },
  { name: "code.fs.apply_patch", version: 1, status: "active", description: "patch", write: true },
];
const SCHEMAS = TOOLS.map((tool) => ({
  ...tool,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" }, patch: { type: "string" } },
  },
}));

const KNOWN: KnownTool[] = SCHEMAS.map((schema) => ({ name: schema.name, inputSchema: schema.inputSchema }));
const profile = { id: "step-1-native", toolCallingMode: "native" as const, maxParallelToolCalls: 1 };
const validate = (_schema: Record<string, unknown>, args: unknown) => args as Record<string, unknown>;

function nativeCall(name: string, args: Record<string, unknown> | string, id = "call-1") {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

/** Exactly what the live provider returned above the cap: a JSON object cut inside a string. */
function truncatedWrite(id = "truncated-1"): string {
  return `{"path":"styles.css","content":"${"x".repeat(400)}`;
}

function normalize(payload: Parameters<typeof normalizeToolCalls>[0]["payload"], mode: "native" | "text" = "native") {
  return normalizeToolCalls({
    payload,
    profile,
    mode,
    knownTools: KNOWN,
    validate,
  });
}

describe("Step 1 — adapter: incomplete arguments are never executable", () => {
  it("accepts a valid large tool call (200 KB of file content)", () => {
    const content = "x".repeat(200_000);
    const result = normalize({
      toolCalls: [nativeCall("code.fs.write", { path: "styles.css", content })],
      content: "",
      finishReason: "tool_calls",
    });
    expect(result.rejected).toHaveLength(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.partial).toBe(false);
    expect(result.calls[0]?.arguments).toMatchObject({ path: "styles.css" });
    expect(String(result.calls[0]?.arguments.content)).toHaveLength(200_000);
    expect(executableToolCalls(result)).toHaveLength(1);
  });

  it("rejects a truncated native JSON object and keeps it out of executable calls", () => {
    const result = normalize({
      toolCalls: [nativeCall("code.fs.write", truncatedWrite(), "call-cut")],
      content: "",
      finishReason: "tool_calls",
    });
    expect(result.calls[0]?.partial).toBe(true);
    expect(result.rejected.map((entry) => entry.code)).toEqual(["partial_tool_call"]);
    expect(result.rejected[0]?.id).toBe("call-cut");
    expect(result.rejected[0]?.message).toContain("incomplete");
    expect(executableToolCalls(result)).toHaveLength(0);
  });

  it("fails closed on finish_reason=length even when the JSON happens to parse", () => {
    const result = normalize({
      toolCalls: [nativeCall("code.fs.write", { path: "styles.css", content: "body{}" })],
      content: "",
      finishReason: "length",
    });
    expect(result.rejected.map((entry) => entry.code)).toEqual(["partial_tool_call"]);
    expect(result.rejected[0]?.message).toContain("output limit");
    expect(result.warnings).toContain("output_limit_tool_calls");
    expect(executableToolCalls(result)).toHaveLength(0);
  });

  it("rejects an unterminated text-protocol tool block", () => {
    const result = normalize(
      {
        toolCalls: [],
        content: '```json\n{"name":"code.fs.write","arguments":{"path":"a.css","content":"body{',
        finishReason: "stop",
      },
      "text",
    );
    expect(result.rejected.map((entry) => entry.code)).toEqual(["partial_tool_call"]);
    expect(result.warnings).toContain("partial_text_tool_call_block");
    expect(executableToolCalls(result)).toHaveLength(0);
  });

  it("keeps a complete text-protocol call executable (fallback path unchanged)", () => {
    const result = normalize(
      {
        toolCalls: [],
        content: '```json\n{"name":"code.fs.edit","arguments":{"path":"a.css","content":"body{}"}}\n```',
        finishReason: "stop",
      },
      "text",
    );
    expect(result.rejected).toHaveLength(0);
    expect(executableToolCalls(result)).toHaveLength(1);
    expect(executableToolCalls(result)[0]?.name).toBe("code.fs.edit");
  });
});

interface HarnessOptions {
  script: ChatResult[];
  limits?: Partial<{ maxStepsPerRun: number; maxRunMinutes: number; parallelReadOnlyCalls: number }>;
}

function createHarness(options: HarnessOptions) {
  const engineCalls: CodingAgentChatRequest[] = [];
  const invocations: Array<{ tool: string; toolCallId: string; args: Record<string, unknown> }> = [];
  const activity: CodeRunActivityEvent[] = [];
  const script = [...options.script];

  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => TOOLS,
      invoke: async (_ctx, input) => {
        invocations.push({ tool: input.tool, toolCallId: input.toolCallId, args: (input.args ?? {}) as Record<string, unknown> });
        return {
          ok: true,
          tool: input.tool,
          toolVersion: 1,
          schemaVersion: 1,
          result: { ok: true },
          truncated: false,
          durationMs: 1,
        } satisfies CodeToolInvokeResult;
      },
    },
    engine: {
      chat: async (request) => {
        engineCalls.push(request);
        return script.shift() ?? { content: "done" };
      },
    },
    schemas: SCHEMAS,
    quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
    activity: { record: async (event) => { activity.push(event); } },
    runEvents: { append: async (entry) => entry },
    limits: { maxStepsPerRun: 10, maxRunMinutes: 5, parallelReadOnlyCalls: 8, ...(options.limits ?? {}) },
    now: () => 1_000,
  };

  const runner = new CodingAgentRunner(ports);
  return {
    engineCalls,
    invocations,
    activity,
    run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
      runner.run({ ctx, session: session(), prompt: "create the store", verificationTools: [], ...input }),
  };
}

const reminderText = "Reminder: the last attempts repeated the same call or the same error.";

describe("Step 1 — runner: truncated calls never reach the workspace", () => {
  it("executes a large but well-formed write instead of rejecting it", async () => {
    const content = "x".repeat(120_000);
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.write", { path: "big.css", content }, "big")] },
        { content: "done" },
      ],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(harness.invocations).toHaveLength(1);
    expect(harness.invocations[0]?.toolCallId).toBe("big");
    expect(String(harness.invocations[0]?.args.content)).toHaveLength(120_000);
    expect(harness.activity.some((event) => event.kind === "tool_call" && event.ok === false)).toBe(false);
  });

  it("rejects the same truncated write, reminds once, then stops with loop_detected", async () => {
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.write", truncatedWrite("cut-1"), "cut-1")] },
        { content: "", toolCalls: [nativeCall("code.fs.write", truncatedWrite("cut-2"), "cut-2")] },
        { content: "", toolCalls: [nativeCall("code.fs.write", truncatedWrite("cut-3"), "cut-3")] },
        { content: "", toolCalls: [nativeCall("code.fs.write", truncatedWrite("cut-4"), "cut-4")] },
      ],
    });
    const result = await harness.run();

    expect(harness.invocations).toHaveLength(0);
    expect(result.reason).toBe("loop_detected");
    expect(result.status).toBe("stopped");
    expect(result.summary.toolCalls).toBe(0);

    // First rejection teaches the model to shrink the work instead of resending the same call.
    const firstFeedback = JSON.stringify(harness.engineCalls[1]?.messages ?? []);
    expect(firstFeedback).toContain("arguments were cut off");
    expect(firstFeedback).toContain("code.fs.apply_patch");

    // Third identical rejection produces the existing reminder, visible to the next model call.
    expect(JSON.stringify(harness.engineCalls[3]?.messages ?? [])).toContain(reminderText);
    expect(harness.activity.some((event) => event.kind === "reminder" && event.reason === "repeated_call")).toBe(true);
    expect(harness.activity.filter((event) => event.kind === "tool_call" && event.errorCode === "partial_tool_call")).toHaveLength(4);
  });

  it("recovers when the model answers the hint with a smaller write", async () => {
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.write", truncatedWrite(), "cut")] },
        { content: "", toolCalls: [nativeCall("code.fs.write", { path: "styles.css", content: "body{color:red}" }, "small")] },
        { content: "Done" },
      ],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(result.reason).toBe("completed");
    expect(harness.invocations).toHaveLength(1);
    expect(harness.invocations[0]).toMatchObject({ tool: "code.fs.write", toolCallId: "small" });
    expect(harness.invocations[0]?.args).toMatchObject({ path: "styles.css", content: "body{color:red}" });
    expect(result.reason).not.toBe("loop_detected");
  });

  it("keeps the safe default for an unfixable rejection and stops after the correction budget", async () => {
    const unknown = (id: string) => ({ content: "", toolCalls: [nativeCall("code.fs.not_a_tool", { path: "a" }, id)] });
    const harness = createHarness({ script: [unknown("u1"), unknown("u2"), unknown("u3"), unknown("u4")] });
    const result = await harness.run();

    expect(harness.invocations).toHaveLength(0);
    expect(result.reason).toBe("invalid_arguments_exhausted");
    expect(result.status).toBe("stopped");
    expect(JSON.stringify(harness.engineCalls[1]?.messages ?? [])).toContain("Retry only this rejected call");
    expect(JSON.stringify(harness.engineCalls[1]?.messages ?? [])).not.toContain("arguments were cut off");
  });
});

describe("Step 1 — loop detection stays quiet on normal work", () => {
  it("does not trip on five different successful reads", async () => {
    const calls = Array.from({ length: 5 }, (_value, index) => ({
      content: "",
      toolCalls: [nativeCall("code.fs.read", { path: `src/file-${index}.ts` }, `read-${index}`)],
    }));
    const harness = createHarness({ script: [...calls, { content: "done" }] });
    const result = await harness.run();

    expect(harness.invocations).toHaveLength(5);
    expect(result.reason).not.toBe("loop_detected");
    expect(result.status).toBe("completed");
  });

  it("does not trip when a truncated call is followed by different successful work", async () => {
    const harness = createHarness({
      script: [
        { content: "", toolCalls: [nativeCall("code.fs.write", truncatedWrite(), "cut")] },
        { content: "", toolCalls: [nativeCall("code.fs.read", { path: "styles.css" }, "read-1")] },
        { content: "", toolCalls: [nativeCall("code.fs.read", { path: "index.html" }, "read-2")] },
        { content: "", toolCalls: [nativeCall("code.fs.edit", { path: "styles.css", content: "a{}" }, "edit-1")] },
        { content: "done" },
      ],
    });
    const result = await harness.run();

    expect(result.reason).not.toBe("loop_detected");
    expect(harness.invocations.map((call) => call.tool)).toEqual(["code.fs.read", "code.fs.read", "code.fs.edit"]);
  });
});
