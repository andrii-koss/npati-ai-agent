import { describe, expect, it, vi } from "vitest";

import { InMemoryWorkspaceStore } from "../packages/workspace/src/in-memory-store";
import {
  REPLAY_BUNDLE_FORMAT_VERSION,
  ReplayBundleRecorder,
  ReplayBundleSecretDetectedError,
  boundText,
  canonicalizeSettledToolResult,
  getReplayBundleById,
  readReplayBundle,
  replayInputHash,
  replayToolResults,
} from "../apps/agent-api/src/code-replay-bundle";

/**
 * C6b security-gate suite for the versioned replay bundle.
 *
 * The properties that matter here are the ones the owner fixed explicitly: replay reproduces the
 * **model-visible settled** tool result (raw untruncated output is not input), a secret refuses the bundle
 * instead of being silently stripped, the recorded input is deterministic, and recording never changes the run.
 */

const CONTEXT = {
  workspaceId: "ws-1",
  companyId: "company-1",
  projectId: "project-1",
  sessionId: "session-1",
  runId: "run-1",
  executionSnapshotId: "snapshot-1",
  runnerVersion: "1.0.0+abc+fp",
  systemPromptVersion: 3,
  systemPromptContentHash: "sha256:prompt-3",
  modelProfileVersion: 2,
  provider: "auto",
  model: "auto",
  replayMode: "recorded" as const,
  dataClassification: "confidential" as const,
  retentionClass: "standard" as const,
};

function recorderFor(store: InstanceType<typeof InMemoryWorkspaceStore>, overrides: Record<string, unknown> = {}) {
  return new ReplayBundleRecorder({
    store,
    context: { ...CONTEXT, ...overrides },
    toolOutputChars: 24,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

/** One model step plus one tool call: the smallest exchange that is actually replayable. */
function recordMinimalExchange(recorder: ReplayBundleRecorder, settled = '{"ok":true,"tool":"code.fs.read"}'): void {
  recorder.recordModelStep({
    turnIndex: 1,
    request: { model: "auto", messageCount: 2, toolNames: ["code.fs.read"], idempotencyKey: "session-1:turn-1:1" },
    response: {
      content: "I will read the file.",
      finishReason: "tool_calls",
      model: "auto",
      provider: "auto",
      usage: { totalTokens: 12, promptTokens: 8, completionTokens: 4 },
      toolCalls: [{ id: "call-1", name: "code.fs.read", argumentsHash: "sha256:args" }],
    },
  });
  recorder.recordToolCall({
    turnIndex: 1,
    toolCallId: "call-1",
    tool: "code.fs.read",
    toolVersion: 3,
    argumentsHash: "sha256:args",
    settledResult: settled,
    outcome: "ok",
    truncated: false,
    durationMs: 7,
  });
}

describe("security-gate: C6b replay bundle records everything a deterministic replay needs", () => {
  it("persists every field of the bundle contract, including the format version", async () => {
    const store = new InMemoryWorkspaceStore();
    const recorder = recorderFor(store);
    recordMinimalExchange(recorder);
    const written = await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
    expect(written.written).toBe(true);

    const bundle = await store.getReplayBundle("company-1", "run-1");
    expect(bundle).not.toBeNull();
    expect(bundle?.bundleVersion).toBe(REPLAY_BUNDLE_FORMAT_VERSION);
    expect(bundle?.executionSnapshotId).toBe("snapshot-1");
    expect(bundle?.runnerVersion).toBe("1.0.0+abc+fp");
    expect(bundle?.systemPromptVersion).toBe(3);
    expect(bundle?.systemPromptContentHash).toBe("sha256:prompt-3");
    expect(bundle?.modelProfileVersion).toBe(2);
    expect(bundle?.provider).toBe("auto");
    expect(bundle?.model).toBe("auto");
    expect(bundle?.replayMode).toBe("recorded");
    expect(bundle?.terminalStatus).toBe("completed");
    expect(bundle?.terminalReason).toBe("completed");
    expect(bundle?.dataClassification).toBe("confidential");
    expect(bundle?.retentionClass).toBe("standard");
    // The header summary states the counts, so a truncated bundle is detectable rather than silently short.
    expect(bundle?.payload).toMatchObject({ stepCount: 2, modelStepCount: 1, toolCallCount: 1 });
    expect(String(bundle?.payloadHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(bundle?.replayInputHash)).toMatch(/^sha256:[0-9a-f]{64}$/);

    const steps = await store.listReplayBundleSteps("company-1", bundle!.id);
    expect(steps.map((step) => step.kind)).toEqual(["model_step", "tool_call"]);
    expect(steps.map((step) => step.seq)).toEqual([1, 2]);
    expect(steps[1]?.toolCallId).toBe("call-1");
    const toolPayload = steps[1]?.payload as Record<string, unknown>;
    // Everything the replay engine needs to re-issue the call and feed the same result back.
    expect(toolPayload).toMatchObject({
      kind: "tool_call",
      turnIndex: 1,
      tool: "code.fs.read",
      toolVersion: 3,
      argumentsHash: "sha256:args",
      outcome: "ok",
    });
    expect(String(toolPayload.settledResultHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const modelPayload = steps[0]?.payload as Record<string, unknown>;
    expect(modelPayload).toMatchObject({ kind: "model_step" });
    expect((modelPayload.request as Record<string, unknown>).idempotencyKey).toBe("session-1:turn-1:1");
    expect((modelPayload.response as Record<string, unknown>).finishReason).toBe("tool_calls");
  });

  it("is deterministic: recording the same exchange twice yields the same input hash", async () => {
    const first = recorderFor(new InMemoryWorkspaceStore());
    recordMinimalExchange(first);
    const second = recorderFor(new InMemoryWorkspaceStore());
    recordMinimalExchange(second);
    expect(replayInputHash(first.orderedSteps())).toBe(replayInputHash(second.orderedSteps()));
  });
});

describe("security-gate: C6b replay input is the model-visible settled result, never raw output", () => {
  it("records the bounded settled result the model actually saw", async () => {
    const store = new InMemoryWorkspaceStore();
    const long = JSON.stringify({ ok: true, tool: "code.fs.read", result: "x".repeat(200) });
    const settled = canonicalizeSettledToolResult({
      ok: true, tool: "code.fs.read", result: "x".repeat(200), truncated: true, limit: 24,
    });
    // The settled form is the bounded one — the same shape the runner appends to `messages`.
    expect(settled).toBe(boundText(JSON.stringify({ ok: true, tool: "code.fs.read", result: "x".repeat(200), truncated: true }), 24));
    expect(settled.length).toBeLessThan(long.length);

    const recorder = recorderFor(store);
    recordMinimalExchange(recorder, settled);
    await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
    const bundle = await store.getReplayBundle("company-1", "run-1");
    const steps = await store.listReplayBundleSteps("company-1", bundle!.id);
    expect((steps[1]?.payload as Record<string, unknown>).settledResult).toBe(settled);
  });

  it("keeps a raw artifact out of the replay input, so it cannot change what is replayed", async () => {
    const store = new InMemoryWorkspaceStore();
    const recorder = recorderFor(store);
    recorder.recordModelStep({
      turnIndex: 1,
      request: { model: "auto", messageCount: 2, toolNames: [] },
      response: { content: "done", toolCalls: [] },
    });
    recorder.recordToolCall({
      turnIndex: 1,
      toolCallId: "call-9",
      tool: "code.fs.read",
      argumentsHash: "sha256:args",
      settledResult: '{"ok":true}',
      outcome: "ok",
      rawArtifact: { hash: "sha256:raw-1", bytes: 4096, ref: "artifacts/raw-1" },
    });
    const withRaw = replayInputHash(recorder.orderedSteps());

    const other = recorderFor(new InMemoryWorkspaceStore());
    other.recordModelStep({
      turnIndex: 1,
      request: { model: "auto", messageCount: 2, toolNames: [] },
      response: { content: "done", toolCalls: [] },
    });
    other.recordToolCall({
      turnIndex: 1,
      toolCallId: "call-9",
      tool: "code.fs.read",
      argumentsHash: "sha256:args",
      settledResult: '{"ok":true}',
      outcome: "ok",
      rawArtifact: { hash: "sha256:raw-DIFFERENT", bytes: 9_999_999, ref: "artifacts/other" },
    });
    const withOtherRaw = replayInputHash(other.orderedSteps());

    // Identical replay input despite different raw artifacts — the property the owner asked for.
    expect(withRaw).toBe(withOtherRaw);
  });

  it("returns only the recorded tool results when a replay asks for them", async () => {
    const store = new InMemoryWorkspaceStore();
    const recorder = recorderFor(store);
    recordMinimalExchange(recorder);
    await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
    const read = await readReplayBundle({ store, companyId: "company-1", runId: "run-1" });
    expect(read.kind).toBe("bundle");
    expect(read.terminalStatus).toBe("completed");
    expect(read.terminalReason).toBe("completed");
    expect(replayToolResults(read.steps).map((step) => step.toolCallId)).toEqual(["call-1"]);
    expect(read.integrityFailure).toBe(false);
    expect(read.truncated).toBe(false);
    expect(read.replayInputHash).toBe(replayInputHash(read.replayInput));
  });

  it("serves a bundle by replay id with its terminal status, and is not an existence oracle", async () => {
    const store = new InMemoryWorkspaceStore();
    const recorder = recorderFor(store);
    recordMinimalExchange(recorder);
    // A raw artifact is present on the recorded step, so the by-id read can prove it stays out of the input.
    recorder.recordToolCall({
      turnIndex: 1,
      toolCallId: "call-2",
      tool: "code.fs.read",
      argumentsHash: "sha256:args-2",
      settledResult: '{"ok":true,"tool":"code.fs.read"}',
      outcome: "ok",
      rawArtifact: { hash: "sha256:raw-2", bytes: 2048, ref: "artifacts/raw-2" },
    });
    const written = await recorder.finalize({ terminalStatus: "failed", terminalReason: "provider_error" });

    const byId = await getReplayBundleById({ store, companyId: "company-1", replayId: written.bundleId! });
    expect(byId.kind).toBe("bundle");
    expect(byId.bundleId).toBe(written.bundleId);
    expect(byId.runId).toBe("run-1");
    expect(byId.terminalStatus).toBe("failed");
    expect(byId.terminalReason).toBe("provider_error");
    expect(byId.replayMode).toBe("recorded");
    // The same read path and the same step assembly as the by-run read.
    const byRun = await readReplayBundle({ store, companyId: "company-1", runId: "run-1" });
    expect(byId.steps).toEqual(byRun.steps);
    expect(byId.replayInputHash).toBe(byRun.replayInputHash);

    // Unknown id, and a foreign tenant's id, both answer `no_bundle` without an error or a hint.
    const unknown = await getReplayBundleById({ store, companyId: "company-1", replayId: "does-not-exist" });
    expect(unknown.kind).toBe("no_bundle");
    expect(unknown.steps).toEqual([]);
    const foreign = await getReplayBundleById({ store, companyId: "company-2", replayId: written.bundleId! });
    expect(foreign.kind).toBe("no_bundle");

    // The by-id read keeps the replay-input rule: a raw artifact appears in `steps`, never in `replayInput`.
    const withRaw = byId.steps.find((step) => String(step.toolCallId) === "call-2") as Record<string, unknown>;
    expect(withRaw?.rawArtifact).toBeDefined();
    const inInput = byId.replayInput.find((step) => String(step.toolCallId) === "call-2") as Record<string, unknown>;
    expect(inInput).toBeDefined();
    expect(inInput.rawArtifact).toBeUndefined();
  });
});

describe("security-gate: C6b replay bundle refuses secrets and stays tenant-scoped", () => {
  it("refuses a bundle whose recorded exchange contains a secret, without calling the store", async () => {
    const store = new InMemoryWorkspaceStore();
    const create = vi.spyOn(store, "createReplayBundle");
    const recorder = recorderFor(store);
    recordMinimalExchange(recorder, '{"ok":true,"content":"token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}');
    await expect(recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" }))
      .rejects.toBeInstanceOf(ReplayBundleSecretDetectedError);
    expect(create).not.toHaveBeenCalled();
    expect(await store.getReplayBundle("company-1", "run-1")).toBeNull();
  });

  it("catches a secret in a provider answer, not only in tool output", async () => {
    const store = new InMemoryWorkspaceStore();
    const recorder = recorderFor(store);
    recorder.recordModelStep({
      turnIndex: 1,
      request: { model: "auto", messageCount: 1, toolNames: [] },
      response: { content: "use sk-abcdefghijklmnopqrstuvwxyz012345", toolCalls: [] },
    });
    await expect(recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" }))
      .rejects.toBeInstanceOf(ReplayBundleSecretDetectedError);
  });

  it("does not let one tenant read another tenant's bundle", async () => {
    const store = new InMemoryWorkspaceStore();
    const recorder = recorderFor(store);
    recordMinimalExchange(recorder);
    await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
    expect(await store.getReplayBundle("company-2", "run-1")).toBeNull();
    const bundle = await store.getReplayBundle("company-1", "run-1");
    expect(await store.listReplayBundleSteps("company-2", bundle!.id)).toEqual([]);
    const read = await readReplayBundle({ store, companyId: "company-2", runId: "run-1" });
    expect(read.kind).toBe("no_bundle");
  });

  it("is idempotent: recording the same run twice keeps one bundle and one step per call", async () => {
    const store = new InMemoryWorkspaceStore();
    const first = recorderFor(store);
    recordMinimalExchange(first);
    const written = await first.finalize({ terminalStatus: "completed", terminalReason: "completed" });

    const second = recorderFor(store);
    recordMinimalExchange(second);
    const again = await second.finalize({ terminalStatus: "completed", terminalReason: "completed" });
    expect(again.bundleId).toBe(written.bundleId);
    const bundle = await store.getReplayBundle("company-1", "run-1");
    const steps = await store.listReplayBundleSteps("company-1", bundle!.id);
    expect(steps).toHaveLength(2);
  });

  it("never changes the run when the write fails: it reports the failure instead", async () => {
    const store = new InMemoryWorkspaceStore();
    const failing = {
      createReplayBundle: vi.fn(async () => {
        throw Object.assign(new Error("store down"), { code: "store_unavailable" });
      }),
    };
    const recorder = new ReplayBundleRecorder({
      store: failing,
      context: { ...CONTEXT },
      toolOutputChars: 24,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      logger: { warn: vi.fn() },
    });
    recordMinimalExchange(recorder);
    const result = await recorder.finalize({ terminalStatus: "failed", terminalReason: "provider_error" });
    expect(result.written).toBe(false);
    expect(result.errorCode).toBe("store_unavailable");
    expect(store).toBeInstanceOf(InMemoryWorkspaceStore);
  });
});
