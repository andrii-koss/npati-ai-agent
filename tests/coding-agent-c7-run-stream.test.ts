import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { registerCodeRunStreamRoutes, type CodeRunStreamRouteDeps } from "../apps/agent-api/src/code-run-stream-routes";
import { CodeRbacError } from "../apps/agent-api/src/code-rbac";
import type { ReplayBundleStepPayload } from "../apps/agent-api/src/code-replay-bundle";

/**
 * C7 agent stream (`GET /companies/:companyId/code/runs/:runId/turns`).
 *
 * The suite drives the real handler through a minimal fake Fastify instance, so the assertions are about the
 * contract the UI depends on: turn grouping and order, pagination honesty, the legacy "no transcript" answer,
 * a 404 that cannot be used to probe for foreign runs, RBAC before any store read, and the guarantee that a
 * credential can neither be served nor smuggled through a tool result.
 */

const AUTH: AuthContext = {
  userId: "user-1",
  companyId: "company-1",
  externalSubject: "user:user-1",
  permissions: ["workspace:read"],
} as unknown as AuthContext;

function modelStep(turnIndex: number, content: string, calls: Array<{ id: string; name: string }> = []): ReplayBundleStepPayload {
  return {
    kind: "model_step",
    turnIndex,
    request: { model: "auto", messageCount: 3, toolNames: ["code.fs.read"] },
    response: {
      content,
      finishReason: "tool_calls",
      model: "auto",
      provider: "auto",
      usage: { promptTokens: 10, completionTokens: 5 },
      toolCalls: calls.map((call) => ({ id: call.id, name: call.name, argumentsHash: "sha256:args" })),
    },
  };
}

function toolStep(turnIndex: number, toolCallId: string, tool: string, result: unknown): ReplayBundleStepPayload {
  return {
    kind: "tool_call",
    turnIndex,
    toolCallId,
    tool,
    toolVersion: "1.0.0",
    argumentsHash: "sha256:args",
    settledResult: result,
    outcome: "ok",
    truncated: false,
  };
}

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
  threw?: unknown;
}

function buildHarness(overrides: {
  bundleSteps?: ReplayBundleStepPayload[];
  bundleKind?: "bundle" | "no_bundle";
  runState?: unknown;
  runTurns?: unknown[];
  authorize?: CodeRunStreamRouteDeps["authorize"];
} = {}) {
  const calls = { getCodeRunState: 0, listCodeRunTurns: 0, getReplayBundle: 0, listReplayBundleSteps: 0, getReplayBundleById: 0 };
  const store = {
    getCodeRunState: vi.fn(async () => {
      calls.getCodeRunState += 1;
      return overrides.runState === undefined ? { runId: "run-1", status: "completed", turnIndex: 1 } : overrides.runState;
    }),
    listCodeRunTurns: vi.fn(async () => {
      calls.listCodeRunTurns += 1;
      return overrides.runTurns ?? [];
    }),
    getReplayBundle: vi.fn(async () => {
      calls.getReplayBundle += 1;
      if (overrides.bundleKind === "no_bundle") return null;
      return {
        id: "bundle-1",
        runId: "run-1",
        replayMode: "recorded",
        terminalStatus: "completed",
        terminalReason: "completed",
        replayInputHash: "sha256:unused",
        payload: { stepCount: (overrides.bundleSteps ?? []).length },
      };
    }),
    listReplayBundleSteps: vi.fn(async () => {
      calls.listReplayBundleSteps += 1;
      return (overrides.bundleSteps ?? []).map((payload) => ({ payload }));
    }),
    getReplayBundleById: vi.fn(async () => {
      calls.getReplayBundleById += 1;
      return null;
    }),
  };

  const authorize = overrides.authorize ?? (async () => ({}));
  let captured: ((request: unknown, reply: unknown) => Promise<unknown>) | null = null;
  const instance = {
    get: (path: string, handler: (request: unknown, reply: unknown) => Promise<unknown>) => {
      if (!path.includes("/turns")) throw new Error(`unexpected path ${path}`);
      captured = handler;
    },
  };

  registerCodeRunStreamRoutes(instance as never, {
    store: store as never,
    authorize: authorize as never,
    getAuthContext: () => AUTH,
    logger: { warn: () => undefined },
  });

  const run = async (query: Record<string, string> = {}): Promise<Captured> => {
    const outcome: Captured = {};
    const reply = {
      code(status: number) {
        outcome.status = status;
        return this;
      },
      send(body: Record<string, unknown>) {
        outcome.body = body;
        return outcome;
      },
    };
    try {
      await captured!({ params: { companyId: "company-1", runId: "run-1" }, query }, reply);
    } catch (error) {
      outcome.threw = error;
    }
    return outcome;
  };

  return { run, calls, store };
}

describe("security-gate: C7 run stream — the transcript the workspace renders", () => {
  it("groups recorded steps into turns, keeping execution order and the settled result", async () => {
    const harness = buildHarness({
      bundleSteps: [
        modelStep(0, "Let me look at the file.", [{ id: "call-1", name: "code.fs.read" }]),
        toolStep(0, "call-1", "code.fs.read", { ok: true, bytes: 120 }),
        modelStep(1, "The test passes now."),
      ],
    });
    const { status, body } = await harness.run();
    expect(status).toBe(200);
    const stream = body!.stream as Record<string, unknown>;
    expect(stream.source).toBe("replay_bundle");
    expect(stream.streamUnavailable).toBe(false);
    expect(stream.terminalStatus).toBe("completed");
    const turns = stream.turns as Array<Record<string, unknown>>;
    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
    expect((turns[0]!.assistant as Record<string, unknown>).content).toBe("Let me look at the file.");
    expect((turns[0]!.toolCalls as Array<Record<string, unknown>>)[0]).toMatchObject({
      toolCallId: "call-1",
      tool: "code.fs.read",
      toolVersion: "1.0.0",
      outcome: "ok",
    });
    expect((turns[1]!.assistant as Record<string, unknown>).content).toBe("The test passes now.");
    expect(body!.page).toMatchObject({ limit: 50, nextCursor: null });
  });

  it("paginates by turn index without gaps or duplicates", async () => {
    const harness = buildHarness({
      bundleSteps: [modelStep(0, "first"), modelStep(1, "second"), modelStep(2, "third")],
    });
    const first = await harness.run({ limit: "2" });
    const firstTurns = (first.body!.stream as Record<string, unknown>).turns as Array<{ turnIndex: number }>;
    expect(firstTurns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
    expect((first.body!.page as Record<string, unknown>).nextCursor).toBe("1");

    const second = await harness.run({ limit: "2", cursor: "1" });
    const secondTurns = (second.body!.stream as Record<string, unknown>).turns as Array<{ turnIndex: number }>;
    expect(secondTurns.map((turn) => turn.turnIndex)).toEqual([2]);
    // The cursor only promises more when the page was provably full.
    expect((second.body!.page as Record<string, unknown>).nextCursor).toBeNull();
  });

  it("refuses a malformed cursor as a client error, not a permission problem", async () => {
    const harness = buildHarness({ bundleSteps: [modelStep(0, "a")] });
    const { status, body } = await harness.run({ cursor: "-3" });
    expect(status).toBe(400);
    expect((body!.error as Record<string, unknown>).code).toBe("invalid_stream_cursor");
  });

  it("reports a run without a recorded bundle as an unavailable transcript, not an empty one", async () => {
    const harness = buildHarness({
      bundleKind: "no_bundle",
      runTurns: [
        {
          runId: "run-1",
          companyId: "company-1",
          turnIndex: 0,
          status: "finished",
          outcome: "ok",
          toolCalls: [{ toolCallId: "call-9", tool: "code.verify.run", readOnly: false, outcome: "ok", startedAt: new Date(), finishedAt: new Date() }],
          messages: [],
          results: [],
          checkpointId: null,
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      ],
    });
    const { status, body } = await harness.run();
    expect(status).toBe(200);
    const stream = body!.stream as Record<string, unknown>;
    expect(stream.source).toBe("run_state");
    expect(stream.streamUnavailable).toBe(true);
    expect(String(stream.message)).toContain("no recorded transcript");
    const turns = stream.turns as Array<Record<string, unknown>>;
    expect((turns[0]!.toolCalls as Array<Record<string, unknown>>)[0]!.tool).toBe("code.verify.run");
    // A legacy run has no assistant text anywhere, so the field is absent rather than an empty string.
    expect(turns[0]!.assistant).toBeUndefined();
  });

  it("answers an unknown run and a foreign run identically, so it cannot be used to probe", async () => {
    const unknown = buildHarness({ runState: null });
    const foreign = buildHarness({ runState: null });
    const first = await unknown.run();
    const second = await foreign.run();
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    // Byte-identical bodies: neither the run id nor any tenant detail may distinguish the two cases.
    expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));
    expect(JSON.stringify(first.body)).not.toContain("run-1");
    expect((first.body!.error as Record<string, unknown>).details).toEqual({});
  });

  it("authorizes before touching the store and refuses without permission", async () => {
    const harness = buildHarness({
      bundleSteps: [modelStep(0, "secret plan")],
      authorize: (async () => {
        throw new CodeRbacError("permission_denied", "Denied", 403, { reason: "permission_denied" });
      }) as never,
    });
    const { status } = await harness.run();
    expect(status).toBe(403);
    expect(harness.calls.getCodeRunState).toBe(0);
    expect(harness.calls.getReplayBundle).toBe(0);
    expect(harness.calls.listReplayBundleSteps).toBe(0);
  });

  it("never serves a credential found in a stored tool result", async () => {
    const harness = buildHarness({
      bundleSteps: [
        modelStep(0, "running the command", [{ id: "call-1", name: "code.shell.exec" }]),
        toolStep(0, "call-1", "code.shell.exec", { stdout: "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }),
      ],
    });
    const { status, body } = await harness.run();
    expect(status).toBe(500);
    expect((body!.error as Record<string, unknown>).code).toBe("stream_payload_invalid");
    expect(JSON.stringify(body)).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });

  it("bounds a huge settled result and marks that it was cut", async () => {
    const harness = buildHarness({
      bundleSteps: [
        modelStep(0, "big output", [{ id: "call-1", name: "code.shell.exec" }]),
        toolStep(0, "call-1", "code.shell.exec", { stdout: "x".repeat(20_000) }),
      ],
    });
    const { status, body } = await harness.run();
    expect(status).toBe(200);
    const turns = (body!.stream as Record<string, unknown>).turns as Array<Record<string, unknown>>;
    const card = (turns[0]!.toolCalls as Array<Record<string, unknown>>)[0]!;
    expect(card.resultTruncated).toBe(true);
    expect(String(card.result).length).toBeLessThanOrEqual(4_001);
  });
});
