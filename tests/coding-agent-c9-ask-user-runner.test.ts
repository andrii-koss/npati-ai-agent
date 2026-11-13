import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import type { CodeToolInvokeFailure, CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import {
  allCanonicalExecutors,
  canonicalAskUserExecutors,
  type CodeAskUserToolPort,
} from "../apps/agent-api/src/code-tool-executors";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import {
  CODE_ASK_USER_TOOL,
  CodingAgentRunner,
  type CodeRunActivityEvent,
  type CodeRunToolDescriptor,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";

/**
 * C9 security-gate: `code.ask_user` stops the run.
 *
 * The suite exists because "the model asked a question" is only half the feature. The other half is what the
 * loop does **next**, and there are exactly two acceptable answers:
 *
 *   - it stops, and the run is marked `waiting_for_user` — a non-terminal state that the C6a reconciler
 *     deliberately ignores, so a restart neither replays the turn nor discards the answer on its way;
 *   - it stops, and the pause **cannot** be recorded — in which case the run must fail, loudly and terminally,
 *     rather than continue as if a question nobody can find had never been asked.
 *
 * Everything here is written against the two failures that would make the tool worse than useless: a model that
 * keeps working after asking (so the "question" was decorative), and a pause that leaves the run `running` (so a
 * restart "recovers" a healthy run and orphans the answer).
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";
const RUN = "run-1";
const QUESTION = "question-1";

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:read", "workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: SESSION,
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
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
  { name: "code.fs.write", version: 1, status: "active", description: "write a file", write: true },
  { name: CODE_ASK_USER_TOOL, version: 1, status: "active", description: "ask the user", write: false },
];

const SCHEMAS = TOOLS.map((tool) => ({
  ...tool,
  inputSchema: { type: "object", properties: { path: { type: "string" }, prompt: { type: "string" } } },
}));

function nativeCall(name: string, args: Record<string, unknown>, id = `call-${name}`) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

/** The wrapped result the runtime produces for a successful ask: metadata only, never an answer. */
function askResult(questionId: string | null): CodeToolInvokeResult {
  return {
    ok: true,
    tool: CODE_ASK_USER_TOOL,
    toolVersion: 1,
    schemaVersion: 1,
    result: {
      kind: "code_tool_result",
      tool: CODE_ASK_USER_TOOL,
      toolVersion: 1,
      schemaVersion: 1,
      trust: "untrusted_data",
      note: "data",
      data: questionId === null
        ? { status: "pending", choices: 2, allowFreeAnswer: false, expiresAt: "2026-01-02T00:00:00.000Z" }
        : { questionId, status: "pending", choices: 2, allowFreeAnswer: false, expiresAt: "2026-01-02T00:00:00.000Z" },
    },
    truncated: false,
    durationMs: 1,
  };
}

interface HarnessOptions {
  script?: Array<ChatResult | Error>;
  mode?: CodeSession["mode"];
  /** What the faked runtime returns for `code.ask_user`; `null` means "success without a question id". */
  questionId?: string | null;
}

function createHarness(options: HarnessOptions = {}) {
  const engineCalls: unknown[] = [];
  const invocations: string[] = [];
  const activity: CodeRunActivityEvent[] = [];
  const runEvents: Array<{ eventType: string; runStatus: string }> = [];
  const releases: string[] = [];
  const paused: Array<{ questionId: string; toolCallId: string }> = [];
  const finished: Array<{ status: string; reason?: string }> = [];
  const turns: Array<{ turnIndex: number; status: string; outcome?: string | null }> = [];
  const script = [...(options.script ?? [])];
  const questionId = options.questionId === undefined ? QUESTION : options.questionId;

  const toolRuntime: CodingAgentRunnerPorts["toolRuntime"] = {
    listTools: () => TOOLS.map((tool) => ({ ...tool })),
    invoke: async (_ctx, input) => {
      invocations.push(input.tool);
      if (input.tool === CODE_ASK_USER_TOOL) return askResult(questionId);
      return {
        ok: true,
        tool: input.tool,
        toolVersion: 1,
        schemaVersion: 1,
        result: { ok: true, tool: input.tool },
        truncated: false,
        durationMs: 1,
      } satisfies CodeToolInvokeResult;
    },
  };

  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime,
    engine: {
      chat: async (request) => {
        engineCalls.push(request);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next ?? { content: "done" };
      },
    },
    schemas: SCHEMAS,
    imageAdmission: {
      admit: async () => ({
        reference: "npati/sandbox-node-1@sha256:abc",
        dev: false,
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        sbomRef: "sbom/sandbox-node-1.json",
      }),
    },
    quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
    activity: { record: async (event) => { activity.push(event); } },
    runEvents: { append: async (entry) => { runEvents.push(entry); return entry; } },
    sandbox: { release: async (input) => { releases.push(input.reason); } },
    limits: { maxStepsPerRun: 10, maxRunMinutes: 5, parallelReadOnlyCalls: 8 },
    runState: {
      startRun: async () => ({ runId: RUN }),
      renewLease: async () => ({ held: true }),
      markWaitingForUser: async (input) => {
        paused.push({ questionId: input.questionId, toolCallId: input.toolCallId });
        // The C9 contract: a pause records no terminal state and no finish reason. Returning a record keeps the
        // shape the runner expects without pretending the run ended.
        return { runId: RUN, status: "waiting_for_user" };
      },
      markFinished: async (input) => { finished.push({ status: input.status, ...(input.reason ? { reason: input.reason } : {}) }); },
      appendTurn: async (input) => { turns.push({ turnIndex: input.turnIndex, status: input.status, outcome: input.outcome ?? null }); return {}; },
      appendToolCall: async () => ({}),
    } as unknown as CodingAgentRunnerPorts["runState"],
    snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
  };

  const runner = new CodingAgentRunner(ports);
  return {
    runner,
    engineCalls,
    invocations,
    activity,
    runEvents,
    releases,
    paused,
    finished,
    turns,
    run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
      runner.run({ ctx, session: session(options.mode ? { mode: options.mode } : {}), prompt: "make the change", ...input }),
  };
}

describe("security-gate: C9 ask_user stops the run", () => {
  it("pauses the run as waiting_for_user and takes no further model or tool step", async () => {
    const harness = createHarness({
      script: [
        { content: "I need a decision", toolCalls: [nativeCall(CODE_ASK_USER_TOOL, { prompt: "Which database?" }, "call-ask-1")] },
        // A second script entry exists on purpose: if the loop continued, the engine would consume it and this
        // test would see two model calls. Its presence is the assertion's teeth.
        { content: "I answered my own question", toolCalls: [nativeCall("code.fs.write", { path: "a.ts" }, "call-write-1")] },
      ],
    });
    const result = await harness.run();

    expect(result.status).toBe("waiting_for_user");
    expect(result.reason).toBe("waiting_for_user");
    // V6 step 10: the reply shows the question itself (the person answers it with the next message), not its id.
    expect(result.message).toContain("Which database?");
    expect(result.message).not.toContain(QUESTION);

    // The run state says "waiting", and it was told which question and which tool call hold it.
    expect(harness.paused).toEqual([{ questionId: QUESTION, toolCallId: "call-ask-1" }]);
    // …and it is *not* finished: no terminal state, so C6a cannot treat the pause as a crash and the answer can
    // still be applied when it arrives.
    expect(harness.finished).toEqual([]);

    // Exactly one model call and exactly one tool call: the loop stopped before the next turn and before the
    // write that followed the question in the same script.
    expect(harness.engineCalls).toHaveLength(1);
    expect(harness.invocations).toEqual([CODE_ASK_USER_TOOL]);

    // The turn that asked is closed, so a resume never treats the question as re-runnable.
    expect(harness.turns.filter((turn) => turn.status === "finished")).toHaveLength(1);
    // The sandbox is released (a pause can last hours) and the run event says what is happening.
    expect(harness.releases).toEqual(["waiting_for_user"]);
    expect(harness.runEvents.map((event) => event.eventType)).toEqual(["started", "waiting_for_user"]);
  });

  it("does not execute the rest of the turn's calls, and still answers each one in the transcript", async () => {
    const harness = createHarness({
      script: [{
        content: "asking",
        toolCalls: [
          nativeCall(CODE_ASK_USER_TOOL, { prompt: "Which database?" }, "call-ask-1"),
          nativeCall("code.fs.write", { path: "a.ts" }, "call-write-1"),
        ],
      }],
    });
    const result = await harness.run();

    expect(result.status).toBe("waiting_for_user");
    // A call after the question is never invoked: nothing runs while a human is being waited on.
    expect(harness.invocations).toEqual([CODE_ASK_USER_TOOL]);
    expect(harness.paused).toHaveLength(1);
  });

  it("fails closed when a successful ask carries no question id", async () => {
    const harness = createHarness({
      questionId: null,
      script: [
        { content: "asking", toolCalls: [nativeCall(CODE_ASK_USER_TOOL, { prompt: "Which database?" }, "call-ask-1")] },
        { content: "kept working anyway" },
      ],
    });
    const result = await harness.run();

    // A result that claims success but cannot be turned into a pause must never be treated as an ordinary tool
    // result: continuing would run the model past a question nobody can find or answer.
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("tool_failure");
    expect(harness.paused).toEqual([]);
    expect(harness.finished).toEqual([{ status: "failed", reason: "tool_failure" }]);
    expect(harness.engineCalls).toHaveLength(1);
  });

  it("still runs a normal turn to completion, so the pause is specific to the question tool", async () => {
    const harness = createHarness({
      script: [
        { content: "reading", toolCalls: [nativeCall("code.fs.read", { path: "a.ts" })] },
        { content: "done" },
      ],
    });
    const result = await harness.run();
    expect(result.status).toBe("completed");
    expect(harness.paused).toEqual([]);
    expect(harness.invocations).toEqual(["code.fs.read"]);
  });
});

describe("security-gate: C9 ask_user is offered where it is allowed to run", () => {
  it("offers the question tool in plan mode through the narrow plan-safe list", () => {
    const harness = createHarness({ mode: "plan" });
    const names = harness.runner.toolDescriptors(session({ mode: "plan" })).map((tool) => tool.name);
    // `code.ask_user` is not in the read-only class; it is reachable in plan mode because it is in the explicit
    // `PLAN_SAFE_TOOLS` list. Without this the one mode that must ask rather than guess could not ask.
    expect(names).toContain(CODE_ASK_USER_TOOL);
    // A mutating tool stays unavailable there, so the plan allowance did not widen.
    expect(names).not.toContain("code.fs.write");
  });
});

describe("security-gate: C9 ask_user executor — a published tool with a real executor", () => {
  const tool = CODE_TOOL_SCHEMAS.find((schema) => schema.name === CODE_ASK_USER_TOOL)!;
  const askCalls: Array<Record<string, unknown>> = [];

  function port(): CodeAskUserToolPort {
    return {
      ask: async (input) => {
        askCalls.push(input as unknown as Record<string, unknown>);
        return {
          question: {
            id: QUESTION,
            status: "pending",
            choices: input.choices,
            allowFreeAnswer: input.allowFreeAnswer === true,
            expiresAt: new Date("2026-01-02T00:00:00.000Z"),
          },
          created: true,
          runPaused: true,
        };
      },
    };
  }

  function execution(overrides: Record<string, unknown> = {}) {
    return {
      ctx,
      companyId: COMPANY,
      projectId: PROJECT,
      sessionId: SESSION,
      turnId: "turn-1",
      runId: RUN,
      toolCallId: "call-ask-1",
      tool,
      args: { prompt: "Which database?", choices: [{ id: "local", label: "Local" }] },
      limits: resolveCodeAgentLimits({} as NodeJS.ProcessEnv),
      port: {} as never,
      ...overrides,
    } as Parameters<ReturnType<typeof canonicalAskUserExecutors>[string]>[0];
  }

  it("is present in the merged executor map, so the tool is not published and dead", () => {
    const executors = allCanonicalExecutors({ codeAskUserService: port() });
    expect(typeof executors[CODE_ASK_USER_TOOL]).toBe("function");
  });

  it("returns metadata only and never an answer", async () => {
    askCalls.length = 0;
    const result = await canonicalAskUserExecutors({ codeAskUserService: port() })[CODE_ASK_USER_TOOL]!(execution()) as Record<string, unknown>;
    expect(result).toMatchObject({ questionId: QUESTION, status: "pending", choices: 1, allowFreeAnswer: false });
    // No key of the payload could be mistaken for the user's decision.
    expect(Object.keys(result).sort()).toEqual(["allowFreeAnswer", "choices", "expiresAt", "questionId", "status"]);
    expect(askCalls).toHaveLength(1);
    // The run and the tool call come from the invocation envelope, never from model arguments.
    expect(askCalls[0]).toMatchObject({ runId: RUN, toolCallId: "call-ask-1", sessionId: SESSION });
  });

  it("converts expiresInSeconds to a TTL, and passes no TTL at all when it is absent", async () => {
    askCalls.length = 0;
    const executors = canonicalAskUserExecutors({ codeAskUserService: port() });
    await executors[CODE_ASK_USER_TOOL]!(execution({ args: { prompt: "q", allowFreeAnswer: true, expiresInSeconds: 60 } }));
    await executors[CODE_ASK_USER_TOOL]!(execution({ args: { prompt: "q", allowFreeAnswer: true } }));
    expect(askCalls[0]).toMatchObject({ ttlMs: 60_000, allowFreeAnswer: true });
    expect(askCalls[1]).not.toHaveProperty("ttlMs");
  });

  it("refuses a call with no run or no tool call instead of recording half a question", async () => {
    const executors = canonicalAskUserExecutors({ codeAskUserService: port() });
    for (const overrides of [{ runId: undefined }, { toolCallId: undefined }, { sessionId: undefined }]) {
      await expect(executors[CODE_ASK_USER_TOOL]!(execution(overrides))).rejects.toMatchObject({
        code: "invalid_arguments", status: 400,
      });
    }
  });

  it("fails closed when the service is not wired, instead of appearing to ask", async () => {
    const executors = canonicalAskUserExecutors({});
    await expect(executors[CODE_ASK_USER_TOOL]!(execution())).rejects.toMatchObject({
      code: "tool_not_configured", status: 503,
    });
  });

  it("maps a service refusal onto a structured invalid_arguments with its own reason", async () => {
    const refusing: CodeAskUserToolPort = {
      ask: async () => {
        throw Object.assign(new Error("A question needs at least one choice or a free-form answer"), {
          code: "question_answer_invalid", httpStatus: 400, retryable: false,
          // The service's own `details` carry context the model needs (here: the limit it exceeded); they must
          // survive the mapping, with `reason` replaced by the machine-readable code.
          details: { reason: "no answerable form", limit: 10 },
        });
      },
    };
    const executors = canonicalAskUserExecutors({ codeAskUserService: refusing });
    let thrown: unknown = null;
    try {
      await executors[CODE_ASK_USER_TOOL]!(execution({ args: { prompt: "q" } }));
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "invalid_arguments", status: 400, step: "validate_arguments" });
    expect((thrown as { details?: Record<string, unknown> }).details).toMatchObject({
      reason: "question_answer_invalid", limit: 10,
    });
  });

  /** The tool is read-only for policy and `code.read` for the sub-flag; it must not be a write tool. */
  it("is not classified as a workspace-writing tool", async () => {
    const { CODE_WRITE_TOOLS } = await import("../apps/agent-api/src/code-edit-approval");
    expect(CODE_WRITE_TOOLS.has(CODE_ASK_USER_TOOL)).toBe(false);
    const failure: CodeToolInvokeFailure | null = null;
    expect(failure).toBeNull();
  });
});
