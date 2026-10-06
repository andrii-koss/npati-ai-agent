import { describe, expect, it, vi } from "vitest";
import {
  REPLAY_BUNDLE_FORMAT_VERSION,
  boundText,
  bundleHash,
  canonicalizeSettledToolResult,
  readReplayBundle,
  replayInputHash,
  replayInputSteps,
  type ReplayBundleHeaderRecord,
  type ReplayBundleReadPort,
  type ReplayBundleStepPayload,
} from "../apps/agent-api/src/code-replay-bundle";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import {
  CODE_REPLAY_CODES,
  CodeReplayError,
  replayRecorded,
  type RecordedReplayDeps,
} from "../apps/agent-api/src/code-replay-engine";
import {
  compactConversation,
  type CompactableMessage,
  type CompressionArtifact,
} from "../apps/agent-api/src/code-conversation-compaction";

/**
 * C8 security-gate suite: the compaction artifact as **replay input**, walked end to end.
 *
 * The sibling suite (`c8-replay-compression`) pins the artifact's *shape* and its byte-stability. This one
 * drives the real `replayRecorded` over a full recording instead, because that is where the claim actually has
 * to hold: a compacted session must replay to the same terminal status with the recorded artifact reused, and
 * a summarizer must never be called — not because nobody wired one, but because offering one is refused.
 *
 * The second half pins truncation determinism, which is the same property one layer down: the model-visible
 * truncated result is the only thing replay consumes, and an untruncated raw reference may exist beside it
 * without ever substituting it.
 */

const CANARY = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

function publishedToolVersion(name: string): number | null {
  return CODE_TOOL_SCHEMAS.find((schema) => schema.name === name)?.version ?? null;
}

/** A session long enough to compact, with decisive facts so a lost summary would be visible. */
function longSession(turns: number): CompactableMessage[] {
  const messages: CompactableMessage[] = [
    { role: "system", content: "You are the NPATI Coding Agent." },
    { role: "user", content: "Fix the pagination cursor so ties do not repeat rows" },
  ];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      role: "assistant",
      content: `Decision: narrow case ${turn}\nOpen problem: cursor unstable on ties`,
    });
    messages.push({
      role: "tool",
      content: `payload ${turn} `.repeat(120),
      toolCallId: `call-${turn}`,
      toolName: "code.fs.read",
      argumentsHash: `sha256:args-${turn}`,
      outcome: "ok",
    });
  }
  return messages;
}

function modelStep(turnIndex: number, toolCalls: Array<{ id: string; name: string; argumentsHash: string }>): ReplayBundleStepPayload {
  return {
    kind: "model_step",
    turnIndex,
    request: { model: "auto", messageCount: 3, toolNames: ["code.fs.read"] },
    response: {
      content: toolCalls.length ? "" : "done",
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      provider: "test",
      model: "auto",
      usage: { totalTokens: 10 },
      toolCalls,
    },
  };
}

function toolStep(
  turnIndex: number,
  input: { toolCallId: string; tool: string; argumentsHash: string; settledResult: string; rawArtifact?: { hash: string; ref?: string } },
): ReplayBundleStepPayload {
  const payload: ReplayBundleStepPayload = {
    kind: "tool_call",
    turnIndex,
    toolCallId: input.toolCallId,
    tool: input.tool,
    toolVersion: publishedToolVersion(input.tool),
    argumentsHash: input.argumentsHash,
    settledResult: input.settledResult,
    settledResultHash: bundleHash({ settled: input.settledResult }),
    outcome: "ok",
    ...(input.rawArtifact ? { rawArtifact: input.rawArtifact } : {}),
  };
  return payload;
}

/** The recorded run: read a file, then finish — the shape a compacted session leaves behind. */
function compiledSteps(artifact: CompressionArtifact): ReplayBundleStepPayload[] {
  return [
    modelStep(1, [{ id: "call-read-1", name: "code.fs.read", argumentsHash: "sha256:read-arguments" }]),
    toolStep(1, {
      toolCallId: "call-read-1",
      tool: "code.fs.read",
      argumentsHash: "sha256:read-arguments",
      settledResult: canonicalizeSettledToolResult({
        ok: true,
        tool: "code.fs.read",
        result: `line 1\n${artifact.summaryText.slice(0, 40)}`,
        limit: 30_000,
      }),
    }),
    modelStep(2, []),
  ];
}

function recording(
  steps: ReplayBundleStepPayload[],
  artifacts: CompressionArtifact[],
): RecordedReplayDeps["recording"] {
  return {
    kind: "bundle",
    runId: "run-compacted",
    bundleId: "bundle-compacted",
    replayMode: "recorded",
    steps,
    replayInput: replayInputSteps(steps),
    // The version-3 derivation: a compacted run's input hash covers the artifacts.
    replayInputHash: replayInputHash(steps, artifacts),
    integrityFailure: false,
    truncated: false,
    compressionArtifacts: artifacts as unknown as Record<string, unknown>[],
  };
}

function deps(
  steps: ReplayBundleStepPayload[],
  artifacts: CompressionArtifact[],
  overrides: Partial<RecordedReplayDeps> = {},
): RecordedReplayDeps {
  return {
    recording: recording(steps, artifacts),
    bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
    recordedTerminalStatus: "completed",
    toolVersions: publishedToolVersion,
    ...overrides,
  };
}

describe("[C8] [security-gate] recorded replay of a compacted session", () => {
  it("replays to the same terminal status while reusing the recorded artifact", async () => {
    const artifact = compactConversation({ messages: longSession(40), keepRecentTurns: 4 }).artifact;
    const steps = compiledSteps(artifact);

    const result = await replayRecorded(deps(steps, [artifact]));

    expect(result.status).toBe("replayed");
    expect(result.ok).toBe(true);
    expect(result.divergences).toEqual([]);
    // Same terminal status as the recorded run, derived from the recording rather than taken on faith.
    expect(result.terminalStatus).toBe("completed");
    expect(result.recordedTerminalStatus).toBe("completed");
    expect(result.comparison.modelSteps).toEqual({ matched: 2, expected: 2 });
    expect(result.comparison.toolCalls).toEqual({ matched: 1, expected: 1 });
    expect(result.comparison.integrity.replayInputHashMatched).toBe(true);

    // The exact recorded artifact is what came back — identified by its own content hash, not regenerated.
    expect(result.compression.status).toBe("reused_recorded_artifacts");
    expect(result.compression.recorded).toBe(1);
    expect(result.compression.reused).toBe(1);
    expect(result.compression.verified).toBe(1);
    expect(result.compression.artifactHashes).toEqual([artifact.contentHash]);
    expect(result.compression.schemaVersions).toEqual([artifact.schemaVersion]);
    // Structural zero: there is no summarizer to call and no artifact was re-derived.
    expect(result.compression.recomputed).toBe(0);
    expect(result.providerCalls).toBe(0);
    expect(result.toolExecutions).toBe(0);
  });

  it("never calls a summarizer, and refuses a caller that offers one", async () => {
    const artifact = compactConversation({ messages: longSession(30), keepRecentTurns: 4 }).artifact;
    const summarizer = vi.fn(() => {
      throw new Error("a replay must never summarise");
    });

    // Offering a compaction callback is refused *before* it can run, so a silently-ignored summarizer and a
    // summarizer that was never needed cannot be confused from the outside.
    await expect(replayRecorded(deps(compiledSteps(artifact), [artifact], { compaction: summarizer }))).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.compactionRecomputeForbidden,
      httpStatus: 409,
    });
    expect(summarizer).not.toHaveBeenCalled();
  });

  it("treats a bundle without the artifact field as 'no compaction', never as 'summarise on the fly'", async () => {
    const steps = compiledSteps(compactConversation({ messages: longSession(10), keepRecentTurns: 4 }).artifact);
    const result = await replayRecorded(deps(steps, []));

    expect(result.status).toBe("replayed");
    expect(result.compression.status).toBe("none_recorded");
    expect(result.compression.recorded).toBe(0);
    expect(result.compression.reused).toBe(0);
    expect(result.compression.recomputed).toBe(0);
    // And the honest way to ask for a recomputation is refused, not honoured.
    await expect(replayRecorded(deps(steps, [], { compaction: () => ({ summaryText: "invented" }) }))).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.compactionRecomputeForbidden,
    });
  });

  it("makes a summary swapped into the header after the fact fail the integrity check", async () => {
    const artifact = compactConversation({ messages: longSession(20), keepRecentTurns: 4 }).artifact;
    const steps = compiledSteps(artifact);
    const forged = { ...artifact, summaryText: "Goal: something else entirely" } as CompressionArtifact;

    // The stored hash was computed over the steps alone, while the header now carries an artifact: the reader
    // must notice, and the engine must refuse rather than replay a context nobody recorded.
    const store: ReplayBundleReadPort = {
      getReplayBundle: async (): Promise<ReplayBundleHeaderRecord> => ({
        id: "bundle-forged",
        runId: "run-compacted",
        bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
        replayMode: "recorded",
        terminalStatus: "completed",
        terminalReason: "completed",
        replayInputHash: replayInputHash(steps),
        payload: {
          stepCount: steps.length,
          compressionArtifacts: [forged as unknown as Record<string, unknown>],
          compressionArtifactCount: 1,
        },
      }),
      listReplayBundleSteps: async () => steps.map((step) => ({ payload: step })),
    } as unknown as ReplayBundleReadPort;

    const read = await readReplayBundle({ store, companyId: "company-a", runId: "run-compacted" });
    expect(read.kind).toBe("bundle");
    expect(read.integrityFailure).toBe(true);

    await expect(replayRecorded({ ...deps(steps, [artifact]), recording: read })).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.integrityFailed,
      httpStatus: 409,
    });
  });

  it("refuses an unusable artifact instead of replaying without it", async () => {
    const artifact = compactConversation({ messages: longSession(20), keepRecentTurns: 4 }).artifact;
    const steps = compiledSteps(artifact);

    const wrongSchema = { ...artifact, schemaVersion: 99 } as unknown as CompressionArtifact;
    await expect(replayRecorded(deps(steps, [wrongSchema]))).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.compressionArtifactInvalid,
      details: expect.objectContaining({ field: "schemaVersion" }),
    });

    const noHash = { ...artifact, contentHash: "" } as unknown as CompressionArtifact;
    await expect(replayRecorded(deps(steps, [noHash]))).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.compressionArtifactInvalid,
      details: expect.objectContaining({ field: "contentHash" }),
    });
  });

  it("does not let a tampered artifact text reach the replay result", async () => {
    const artifact = compactConversation({ messages: longSession(20), keepRecentTurns: 4 }).artifact;
    const steps = compiledSteps(artifact);
    const result = await replayRecorded(deps(steps, [artifact]));

    // The result carries hashes and counts, never the summary text: a replay result is metadata, and the
    // artifact's own text stays in the recording where it belongs.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(artifact.summaryText.slice(0, 24));
    expect(serialised).not.toContain(CANARY);
  });
});

describe("[C8] [security-gate] model-visible truncation is deterministic", () => {
  it("bounds text the same way every time, with a visible marker", () => {
    const long = "x".repeat(500);
    const first = boundText(long, 100);
    const second = boundText(long, 100);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(100);
    expect(first).toContain("[truncated 400 chars]");
    // Below the limit nothing is touched: truncation is a bound, not a rewrite.
    expect(boundText("short", 100)).toBe("short");
  });

  it("records the canonical settled result identically across runs", () => {
    const input = { ok: true, tool: "code.shell.run", result: { stdout: "y".repeat(200) }, truncated: true, limit: 60 };
    expect(canonicalizeSettledToolResult(input)).toBe(canonicalizeSettledToolResult(input));
  });

  it("keeps a raw reference beside the model-visible result without ever substituting it", () => {
    const visible = canonicalizeSettledToolResult({ ok: true, tool: "code.fs.read", result: "z".repeat(400), limit: 80 });
    const withRaw = [
      toolStep(1, {
        toolCallId: "call-1",
        tool: "code.fs.read",
        argumentsHash: "sha256:args",
        settledResult: visible,
        rawArtifact: { hash: "sha256:raw", ref: "artifact://full-output" },
      }),
    ];
    const withoutRaw = [
      toolStep(1, { toolCallId: "call-1", tool: "code.fs.read", argumentsHash: "sha256:args", settledResult: visible }),
    ];

    // The model-visible result is untouched whether or not a raw reference exists next to it.
    expect(withRaw[0]!.settledResult).toBe(visible);
    expect(withRaw[0]!.rawArtifact).toBeDefined();

    // The replay input has no raw artifact at all, and the input hash ignores it — so debugging data can never
    // change what a replay reproduces.
    expect(replayInputSteps(withRaw)[0]).not.toHaveProperty("rawArtifact");
    expect(replayInputHash(withRaw)).toBe(replayInputHash(withoutRaw));
    expect(replayInputSteps(withRaw)[0]!.settledResult).toBe(visible);

    // Rewriting the raw reference changes neither the input nor the visible result: it is out of band by design.
    const reRaw = [
      toolStep(1, {
        toolCallId: "call-1",
        tool: "code.fs.read",
        argumentsHash: "sha256:args",
        settledResult: visible,
        rawArtifact: { hash: "sha256:different", ref: "artifact://other" },
      }),
    ];
    expect(replayInputHash(reRaw)).toBe(replayInputHash(withRaw));
    expect(replayInputSteps(reRaw)[0]!.settledResult).toBe(visible);
  });

  it("survives a replay when the recorded result was truncated", async () => {
    const visible = canonicalizeSettledToolResult({ ok: true, tool: "code.fs.read", result: "q".repeat(500), limit: 100 });
    const steps = [modelStep(1, [{ id: "call-1", name: "code.fs.read", argumentsHash: "sha256:args" }]), toolStep(1, { toolCallId: "call-1", tool: "code.fs.read", argumentsHash: "sha256:args", settledResult: visible }), modelStep(2, [])];
    const result = await replayRecorded(deps(steps, []));
    expect(result.status).toBe("replayed");
    expect(result.comparison.toolCalls).toEqual({ matched: 1, expected: 1 });
  });
});

/** Guards the suite itself: a canary that no scanner matches would make every refusal assertion vacuous. */
describe("[C8] [security-gate] suite preconditions", () => {
  it("uses a canary the repository scanner actually recognises", async () => {
    const { scanTextForSecrets } = await import("../apps/agent-api/src/code-secret-scanner");
    expect(scanTextForSecrets(CANARY).findings.length).toBeGreaterThan(0);
    expect(typeof CodeReplayError).toBe("function");
  });
});
