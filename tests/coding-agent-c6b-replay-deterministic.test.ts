import { describe, expect, it } from "vitest";
import {
  bundleHash,
  readReplayBundle,
  replayInputHash,
  REPLAY_BUNDLE_FORMAT_VERSION,
  type ReplayBundleReadPort,
  type ReplayBundleReadResult,
  type ReplayBundleStepPayload,
} from "../apps/agent-api/src/code-replay-bundle";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import {
  assertReplayClean,
  assertReplayMetadataOnly,
  CODE_REPLAY_CODES,
  CodeReplayError,
  replayRecorded,
  type RecordedReplayDeps,
} from "../apps/agent-api/src/code-replay-engine";

/**
 * C6b — deterministic replay (recorded).
 *
 * The recorded mode verifies the recorded run against its own two records: the **model output** (what the
 * model asked for) and the **execution** (what actually ran). It calls no provider and runs no tool — the deps
 * below have no engine and no tool runtime to call, so "no real execution" is structural.
 */

function publishedToolVersion(name: string): number | null {
  return CODE_TOOL_SCHEMAS.find((schema) => schema.name === name)?.version ?? null;
}

function modelStep(
  turnIndex: number,
  toolCalls: Array<{ id: string; name: string; argumentsHash: string }>,
  content = "",
): ReplayBundleStepPayload {
  return {
    kind: "model_step",
    turnIndex,
    request: { model: "auto", messageCount: 1, toolNames: ["code.fs.read"] },
    response: {
      content,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      provider: "test",
      model: "auto",
      usage: { totalTokens: 10 },
      toolCalls,
    },
  };
}

function toolStep(turnIndex: number, input: {
  toolCallId: string;
  tool: string;
  toolVersion?: string | number | null;
  argumentsHash: string;
  settledResult?: string;
  outcome?: string;
  errorCode?: string;
}): ReplayBundleStepPayload {
  return {
    kind: "tool_call",
    turnIndex,
    toolCallId: input.toolCallId,
    tool: input.tool,
    toolVersion: input.toolVersion === undefined ? 1 : input.toolVersion,
    argumentsHash: input.argumentsHash,
    settledResult: input.settledResult ?? '{"ok":true,"content":"line 1"}',
    settledResultHash: bundleHash({ settled: input.settledResult ?? "line 1" }),
    outcome: input.outcome ?? "ok",
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

const READ_HASH = "sha256:read-arguments";

/** A recorded run: one tool call in turn 1, then a final answer in turn 2. */
function goodSteps(): ReplayBundleStepPayload[] {
  return [
    modelStep(1, [{ id: "call-read-1", name: "code.fs.read", argumentsHash: READ_HASH }]),
    toolStep(1, { toolCallId: "call-read-1", tool: "code.fs.read", argumentsHash: READ_HASH }),
    modelStep(2, [], "done"),
  ];
}

function recording(steps: ReplayBundleStepPayload[], overrides: Partial<ReplayBundleReadResult> = {}): ReplayBundleReadResult {
  return {
    kind: "bundle",
    runId: "run-1",
    bundleId: "bundle-1",
    replayMode: "recorded",
    steps,
    replayInput: steps,
    replayInputHash: replayInputHash(steps),
    integrityFailure: false,
    truncated: false,
    ...overrides,
  };
}

function deps(steps: ReplayBundleStepPayload[], overrides: Partial<RecordedReplayDeps> = {}): RecordedReplayDeps {
  return {
    recording: recording(steps),
    bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
    recordedTerminalStatus: "completed",
    toolVersions: publishedToolVersion,
    ...overrides,
  };
}

describe("security-gate: C6b replay — deterministic replay of a recorded run", () => {
  it("reproduces the recorded sequence and terminal status without a single live call", async () => {
    const result = await replayRecorded(deps(goodSteps()));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("replayed");
    expect(result.divergences).toEqual([]);
    expect(result.terminalStatus).toBe("completed");
    expect(result.comparison.modelSteps).toEqual({ matched: 2, expected: 2 });
    expect(result.comparison.toolCalls).toEqual({ matched: 1, expected: 1 });
    expect(result.comparison.terminalStatus).toMatchObject({ matched: true, expected: "completed" });
    expect(result.comparison.integrity).toEqual({ replayInputHashMatched: true, truncated: false });
    // Structural zero: the recorded mode has no provider and no tool runtime to call.
    expect(result.providerCalls).toBe(0);
    expect(result.toolExecutions).toBe(0);
    expect(result.stepsVerified).toBe(3);
  });

  it("reads a real bundle through the bundle module's reader", async () => {
    const steps = goodSteps();
    const store: ReplayBundleReadPort = {
      getReplayBundle: async () => ({
        id: "bundle-1",
        companyId: "company-1",
        runId: "run-1",
        bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
        executionSnapshotId: "snapshot-1",
        runnerVersion: "1.0.0",
        systemPromptVersion: 1,
        systemPromptContentHash: "sha256:prompt",
        modelProfileVersion: 1,
        provider: "test",
        model: "auto",
        replayMode: "recorded",
        terminalStatus: "completed",
        terminalReason: "stop",
        payload: { stepCount: steps.length },
        replayInputHash: replayInputHash(steps),
      }),
      listReplayBundleSteps: async () =>
        steps.map((payload, index) => ({
          id: `step-${index}`,
          seq: index,
          kind: String(payload.kind),
          turnIndex: Number(payload.turnIndex),
          toolCallId: (payload.toolCallId as string | undefined) ?? null,
          payload,
          payloadHash: bundleHash(payload),
        })),
    };

    const read = await readReplayBundle({ store, companyId: "company-1", runId: "run-1" });
    const result = await replayRecorded({
      recording: read,
      bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
      recordedTerminalStatus: "completed",
      toolVersions: publishedToolVersion,
    });

    expect(read.kind).toBe("bundle");
    expect(read.integrityFailure).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.comparison.modelSteps).toEqual({ matched: 2, expected: 2 });
  });

  it("refuses a bundle whose stored input hash no longer matches, instead of half-replaying it", async () => {
    const steps = goodSteps();
    const store: ReplayBundleReadPort = {
      getReplayBundle: async () => ({
        id: "bundle-1",
        companyId: "company-1",
        runId: "run-1",
        bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
        executionSnapshotId: null,
        runnerVersion: null,
        systemPromptVersion: null,
        systemPromptContentHash: null,
        modelProfileVersion: null,
        provider: null,
        model: null,
        replayMode: "recorded",
        terminalStatus: "completed",
        terminalReason: "stop",
        payload: { stepCount: steps.length },
        // A hash that cannot match the recomputed one: the bundle was altered.
        replayInputHash: "sha256:tampered",
      }),
      listReplayBundleSteps: async () =>
        steps.map((payload, index) => ({
          id: `step-${index}`,
          seq: index,
          kind: String(payload.kind),
          turnIndex: Number(payload.turnIndex),
          toolCallId: null,
          payload,
          payloadHash: bundleHash(payload),
        })),
    };

    const read = await readReplayBundle({ store, companyId: "company-1", runId: "run-1" });
    expect(read.integrityFailure).toBe(true);
    await expect(
      replayRecorded({ recording: read, bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION, toolVersions: publishedToolVersion }),
    ).rejects.toMatchObject({ code: CODE_REPLAY_CODES.integrityFailed, httpStatus: 409 });
  });
});

describe("security-gate: C6b replay — divergences stop the replay", () => {
  it("reports a tool call order divergence", async () => {
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.read", argumentsHash: READ_HASH }]),
      toolStep(1, { toolCallId: "call-b", tool: "code.fs.read", argumentsHash: READ_HASH }),
      modelStep(2, [], "done"),
    ];
    const result = await replayRecorded(deps(steps));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("diverged");
    expect(result.divergences[0]).toMatchObject({ reason: "tool_call_order", expected: "call-a", actual: "call-b", turn: 1 });
    // The call that diverged was never counted as executed.
    expect(result.toolExecutions).toBe(0);
    expect(result.comparison.toolCalls).toEqual({ matched: 0, expected: 1 });
  });

  it("reports a tool name divergence", async () => {
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.edit", argumentsHash: READ_HASH }]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", argumentsHash: READ_HASH }),
      modelStep(2, [], "done"),
    ];
    const result = await replayRecorded(deps(steps));

    expect(result.divergences[0]).toMatchObject({ reason: "tool_name", expected: "code.fs.edit", actual: "code.fs.read" });
  });

  it("reports an arguments hash divergence", async () => {
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.read", argumentsHash: "sha256:expected" }]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", argumentsHash: "sha256:actual" }),
      modelStep(2, [], "done"),
    ];
    const result = await replayRecorded(deps(steps));

    expect(result.divergences[0]).toMatchObject({
      reason: "arguments_hash",
      expected: "sha256:expected",
      actual: "sha256:actual",
    });
  });

  it("reports a tool schema version divergence and an unknown version", async () => {
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.read", argumentsHash: READ_HASH }]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", toolVersion: 1, argumentsHash: READ_HASH }),
      modelStep(2, [], "done"),
    ];
    const moved = await replayRecorded(deps(steps, { toolVersions: () => 99 }));
    expect(moved.divergences[0]).toMatchObject({ reason: "tool_version", expected: 1, actual: 99 });

    const unknown = await replayRecorded(deps(steps, { toolVersions: () => null }));
    expect(unknown.divergences[0]).toMatchObject({ reason: "tool_version_unknown", actual: null });

    const notRecorded = goodSteps();
    (notRecorded[1] as Record<string, unknown>).toolVersion = null;
    const missingVersion = await replayRecorded(deps(notRecorded));
    expect(missingVersion.divergences[0]).toMatchObject({ reason: "tool_version", expected: null });
  });

  it("reports an unexpected tool call that no model step asked for", async () => {
    const steps = [
      toolStep(1, { toolCallId: "call-ghost", tool: "code.fs.read", argumentsHash: READ_HASH }),
      modelStep(1, [], "done"),
    ];
    const result = await replayRecorded(deps(steps));

    expect(result.divergences[0]).toMatchObject({ reason: "unexpected_tool_call", toolCallId: "call-ghost" });
  });

  it("reports a tool call the model asked for that never ran", async () => {
    const steps = [
      modelStep(1, [
        { id: "call-a", name: "code.fs.read", argumentsHash: READ_HASH },
        { id: "call-b", name: "code.fs.read", argumentsHash: READ_HASH },
      ]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", argumentsHash: READ_HASH }),
      modelStep(2, [], "done"),
    ];
    const result = await replayRecorded(deps(steps));

    expect(result.divergences[0]).toMatchObject({ reason: "missing_tool_call", toolCallId: "call-b" });
    expect(result.comparison.toolCalls).toEqual({ matched: 1, expected: 1 });
  });

  it("reports an outcome that claims failure without a code", async () => {
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.read", argumentsHash: READ_HASH }]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", argumentsHash: READ_HASH, outcome: "failed" }),
      modelStep(2, [], "done"),
    ];
    const result = await replayRecorded(deps(steps));

    expect(result.divergences[0]).toMatchObject({ reason: "inconsistent_outcome", toolCallId: "call-a" });
  });

  it("reports a terminal status that the recording contradicts", async () => {
    const result = await replayRecorded(deps(goodSteps(), { recordedTerminalStatus: "failed" }));

    expect(result.divergences[0]).toMatchObject({ reason: "terminal_status", expected: "failed", actual: "completed" });
    expect(result.comparison.terminalStatus.matched).toBe(false);
  });

  it("keeps an interrupted recording replayable and does not invent a terminal status", async () => {
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.read", argumentsHash: READ_HASH }]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", argumentsHash: READ_HASH }),
    ];
    const result = await replayRecorded(deps(steps, { recordedTerminalStatus: "interrupted" }));

    // Every recorded step verified; the last model step still had a call out, so no status is derived from it.
    expect(result.ok).toBe(true);
    expect(result.terminalStatus).toBe("interrupted");
    expect(result.comparison.terminalStatus.matched).toBe(true);
  });

  it("keeps the divergence report metadata-only and converts to a 409 for the route", async () => {
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.read", argumentsHash: "sha256:expected" }]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", argumentsHash: "sha256:actual", settledResult: "SECRET CONTENT" }),
      modelStep(2, [], "done"),
    ];
    const result = await replayRecorded(deps(steps));

    for (const divergence of result.divergences) {
      const serialised = JSON.stringify(divergence);
      expect(serialised).not.toMatch(/SECRET CONTENT|settledResult|"arguments"/);
    }
    expect(() => assertReplayMetadataOnly({ settledResult: "x" }, "test")).toThrow(CodeReplayError);

    try {
      assertReplayClean(result);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as CodeReplayError).code).toBe(CODE_REPLAY_CODES.diverged);
      expect((error as CodeReplayError).httpStatus).toBe(409);
      expect((error as CodeReplayError).details).toMatchObject({ reason: "arguments_hash" });
    }
  });

  it("marks the divergence on the Activity stream", async () => {
    const events: Array<Record<string, unknown> & { kind: string }> = [];
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.read", argumentsHash: "sha256:expected" }]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", argumentsHash: "sha256:actual" }),
      modelStep(2, [], "done"),
    ];
    const result = await replayRecorded(deps(steps, { onActivity: (event) => void events.push(event) }));

    expect(result.ok).toBe(false);
    expect(events.some((event) => event.kind === "replay_diverged" && event.providerCalls === 0)).toBe(true);
  });
});

describe("security-gate: C6b replay — refusal instead of a partial replay", () => {
  it("refuses a run with no recorded bundle", async () => {
    await expect(
      replayRecorded(deps([], { recording: { kind: "no_bundle", runId: "run-1", steps: [], replayInput: [] } })),
    ).rejects.toMatchObject({ code: CODE_REPLAY_CODES.bundleUnavailable, httpStatus: 404 });
  });

  it("refuses an unsupported bundle format version", async () => {
    await expect(replayRecorded(deps(goodSteps(), { bundleVersion: 999 }))).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.bundleVersionUnsupported,
      httpStatus: 409,
    });
  });

  it("refuses a truncated recording", async () => {
    await expect(replayRecorded(deps(goodSteps(), { recording: recording(goodSteps(), { truncated: true }) }))).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.bundleTruncated,
    });
  });

  it("refuses to verify tool versions without the registry", async () => {
    await expect(replayRecorded(deps(goodSteps(), { toolVersions: undefined }))).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.toolVersionsRequired,
    });
  });

  it("refuses a recorded call with no settled result instead of replaying an empty one", async () => {
    const steps = [
      modelStep(1, [{ id: "call-a", name: "code.fs.read", argumentsHash: READ_HASH }]),
      toolStep(1, { toolCallId: "call-a", tool: "code.fs.read", argumentsHash: READ_HASH, settledResult: "" }),
      modelStep(2, [], "done"),
    ];
    await expect(replayRecorded(deps(steps))).rejects.toMatchObject({ code: CODE_REPLAY_CODES.requiresRecordedData });
  });
});
