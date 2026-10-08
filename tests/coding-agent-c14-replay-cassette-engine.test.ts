import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { ChatMessage, ChatResult } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import {
  REPLAY_BUNDLE_FORMAT_VERSION,
  ReplayBundleRecorder,
  bundleHash,
  readReplayBundle,
  replayArgumentsHash,
  replayInputHash,
  type ReplayBundlePersistPort,
  type ReplayBundleReadResult,
  type ReplayBundleStepPayload,
} from "../apps/agent-api/src/code-replay-bundle";
import {
  CASSETTE_REPRODUCIBILITY_NOTICE,
  REPLAY_CASSETTE_CODES,
  ReplayCassetteEngine,
  ReplayCassetteError,
  cassetteToolResult,
  type CassetteToolResult,
} from "../apps/agent-api/src/code-replay-cassette";
import { CASSETTE_FILE_EXTENSION, ReplayBundleFileStore } from "../apps/agent-api/src/code-replay-cassette-store";
import { CODE_REPLAY_CODES, assertReplayMetadataOnly, replayRecorded } from "../apps/agent-api/src/code-replay-engine";
import type { CodeRunEnginePort, CodingAgentChatRequest } from "../apps/agent-api/src/coding-agent-runner";

/**
 * C14 (owner decision 2): the provider cassette — **one** adaptation of `CodeRunEnginePort.chat`.
 *
 * What is asserted here is reproducibility of the recorded **provider/tool sequence**, never model quality: the
 * same input produces the same ordered model steps and tool calls, the same settled tool results and the same
 * `replayInputHash`; no provider dialog happens and no tool executes; a cassette that was altered fails loudly
 * rather than replaying something else. The zeros are **measured** — the same walk with live ports really dials
 * and really executes, a stubbed global `fetch` counts every HTTP attempt, and the process boundary is what is
 * observed rather than the class's own report about itself.
 *
 * The fixture is a recording the format considers self-consistent: the tool step carries the same
 * `argumentsHash` the model step derived from the provider's argument text, which is what `replayRecorded`
 * compares. The runner's two derivations reach that agreement through **one** canonical conversion
 * (`replayArgumentsHash` in `code-replay-bundle.ts`): the model step holds the provider's argument text, the
 * tool step holds the parsed arguments, and both are hashed as the same argument **value**. Before that fix the
 * model step hashed the text (`bundleHash(text)`) while the tool step hashed the object, so a bundle the real
 * runner wrote diverged at `arguments_hash` on every replay; the fixture here only ever looked consistent
 * because a hand-built one could spell the same value on both sides.
 */

const COMPANY = "company-cassette-engine";
const PROJECT = "project-cassette-engine";
const SESSION = "session-cassette-engine";
const RUN = "run-cassette-engine";
const MODEL = "test-model";
const TOOL = "code.fs.read";
const TOOL_VERSION = 3;
const NOW = new Date("2026-04-01T00:00:00.000Z");
const RAW_ARGUMENTS = JSON.stringify({ path: "src/index.ts" });
const OTHER_ARGUMENTS = JSON.stringify({ path: "src/other.ts" });
const SETTLED_RESULT = JSON.stringify({ ok: true, tool: TOOL, result: "export const x = 1;", truncated: false });

const TOOL_DEFINITIONS = [{
  type: "function" as const,
  function: { name: TOOL, description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
}];

const ROOTS: string[] = [];
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

interface CassetteHarness {
  root: string;
  directory: string;
  files: ReplayBundleFileStore;
}

function cassetteHarness(): CassetteHarness {
  const root = mkdtempSync(path.join(tmpdir(), "npati-c14-cassette-engine-"));
  ROOTS.push(root);
  const directory = path.join(root, "cassettes");
  return { root, directory, files: new ReplayBundleFileStore({ directory }) };
}

interface RecordOptions {
  runId?: string;
  /** `false` writes the exchange exactly as a pre-C14 recorder would: the hash, and no argument bytes. */
  includeArguments?: boolean;
}

/** The recorded exchange: a model step that asks for one tool, the settled result the model saw, the final answer. */
async function recordExchange(store: ReplayBundlePersistPort, options: RecordOptions = {}): Promise<{ bundleId: string }> {
  const runId = options.runId ?? RUN;
  const includeArguments = options.includeArguments !== false;
  const recorder = new ReplayBundleRecorder({
    store,
    context: {
      workspaceId: "ws-cassette-engine",
      companyId: COMPANY,
      projectId: PROJECT,
      sessionId: SESSION,
      runId,
      executionSnapshotId: "snapshot-cassette",
      runnerVersion: "runner-c14",
      systemPromptVersion: 2,
      systemPromptContentHash: "sha256:prompt-2",
      modelProfileVersion: 1,
      provider: "provider-a",
      model: MODEL,
      replayMode: "recorded",
      dataClassification: "confidential",
      retentionClass: "standard",
    },
    toolOutputChars: 96,
    now: () => NOW,
  });
  recorder.recordModelStep({
    turnIndex: 1,
    request: { model: MODEL, messageCount: 2, toolNames: [TOOL], idempotencyKey: `${SESSION}:${runId}:1`, dataClassification: "confidential" },
    response: {
      content: "I will read the file.",
      finishReason: "tool_calls",
      model: MODEL,
      provider: "provider-a",
      usage: { totalTokens: 12, promptTokens: 8, completionTokens: 4 },
      toolCalls: [{
        id: "call-1",
        name: TOOL,
        argumentsHash: replayArgumentsHash(RAW_ARGUMENTS),
        ...(includeArguments ? { arguments: RAW_ARGUMENTS } : {}),
      }],
    },
  });
  recorder.recordToolCall({
    turnIndex: 1,
    toolCallId: "call-1",
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    argumentsHash: replayArgumentsHash(RAW_ARGUMENTS),
    settledResult: SETTLED_RESULT,
    outcome: "ok",
    truncated: false,
    durationMs: 5,
  });
  recorder.recordModelStep({
    turnIndex: 2,
    request: { model: MODEL, messageCount: 4, toolNames: [TOOL], idempotencyKey: `${SESSION}:${runId}:2`, dataClassification: "confidential" },
    response: {
      content: "The file exports one constant.",
      finishReason: "stop",
      model: MODEL,
      provider: "provider-a",
      usage: { totalTokens: 30, promptTokens: 20, completionTokens: 10 },
      toolCalls: [],
    },
  });
  const written = await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
  return { bundleId: written.bundleId ?? "" };
}

/** A recording whose only model step asked for nothing: the evidence `auto` needs to resolve to text. */
async function recordFinalOnly(store: ReplayBundlePersistPort, runId = "run-final-only"): Promise<void> {
  const recorder = new ReplayBundleRecorder({
    store,
    context: {
      workspaceId: "ws-cassette-engine", companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId,
      runnerVersion: "runner-c14", replayMode: "recorded", dataClassification: "confidential", retentionClass: "standard",
    },
    toolOutputChars: 96,
    now: () => NOW,
  });
  recorder.recordModelStep({
    turnIndex: 1,
    request: { model: MODEL, messageCount: 2, toolNames: [], idempotencyKey: `${SESSION}:${runId}:1`, dataClassification: "confidential" },
    response: { content: "Nothing to do.", finishReason: "stop", model: MODEL, provider: "provider-a", usage: { totalTokens: 4, promptTokens: 3, completionTokens: 1 }, toolCalls: [] },
  });
  await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
}

async function readRecording(files: ReplayBundleFileStore, runId = RUN): Promise<ReplayBundleReadResult> {
  const recording = await readReplayBundle({ store: files, companyId: COMPANY, runId });
  expect(recording.kind).toBe("bundle");
  return recording;
}

function cassetteRequest(overrides: Partial<CodingAgentChatRequest> = {}): CodingAgentChatRequest {
  return {
    messages: [{ role: "system", content: "system prompt" }, { role: "user", content: "read src/index.ts" }],
    tools: TOOL_DEFINITIONS,
    toolChoice: "auto",
    model: MODEL,
    idempotencyKey: `${SESSION}:${RUN}:1`,
    policyContext: { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, dataClassification: "confidential" },
    ...overrides,
  };
}

/**
 * The loop a consumer runs: ask the engine port, record what came back exactly like the runner records it, feed
 * each tool call's settled result back — **except** that where a live loop would execute, this one asks the
 * cassette. `toolResult` is the one seam the negative control swaps.
 */
async function runRecordedLoop(input: {
  engine: CodeRunEnginePort;
  store: ReplayBundlePersistPort;
  toolResult: (toolCallId: string, tool: string) => CassetteToolResult | Promise<CassetteToolResult>;
}): Promise<{ turns: number }> {
  const recorder = new ReplayBundleRecorder({
    store: input.store,
    context: {
      workspaceId: "ws-cassette-engine",
      companyId: COMPANY,
      projectId: PROJECT,
      sessionId: SESSION,
      runId: RUN,
      executionSnapshotId: "snapshot-cassette",
      runnerVersion: "runner-c14",
      systemPromptVersion: 2,
      systemPromptContentHash: "sha256:prompt-2",
      modelProfileVersion: 1,
      provider: "provider-a",
      model: MODEL,
      replayMode: "recorded",
      dataClassification: "confidential",
      retentionClass: "standard",
    },
    toolOutputChars: 96,
    now: () => NOW,
  });
  const messages: ChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "read src/index.ts" },
  ];
  let turn = 0;
  for (;;) {
    turn += 1;
    const idempotencyKey = `${SESSION}:${RUN}:${turn}`;
    const result: ChatResult = await input.engine.chat(cassetteRequest({ messages: [...messages], idempotencyKey }));
    // The recording is rebuilt the way the runner writes it, from the answer the port returned — that is what
    // makes "the same input yields the same replay input hash" a measurement of the port, not of a copy.
    recorder.recordModelStep({
      turnIndex: turn,
      request: {
        model: MODEL,
        messageCount: messages.length,
        toolNames: TOOL_DEFINITIONS.map((definition) => definition.function.name),
        idempotencyKey,
        dataClassification: "confidential",
      },
      response: {
        content: result.content ?? "",
        finishReason: result.finishReason ?? null,
        model: result.model ?? null,
        provider: result.telemetry?.provider ?? null,
        usage: result.usage
          ? { totalTokens: result.usage.totalTokens, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens }
          : null,
        toolCalls: (result.toolCalls ?? []).map((call) => ({
          id: call.id,
          name: call.function?.name ?? "",
          argumentsHash: replayArgumentsHash(call.function?.arguments),
          arguments: call.function?.arguments ?? "",
        })),
      },
    });
    const calls = result.toolCalls ?? [];
    if (!calls.length) break;
    messages.push({ role: "assistant", content: result.content, tool_calls: calls });
    for (const call of calls) {
      const settled = await input.toolResult(call.id, call.function.name);
      recorder.recordToolCall({
        turnIndex: turn,
        toolCallId: settled.toolCallId,
        tool: settled.tool,
        toolVersion: settled.toolVersion,
        argumentsHash: settled.argumentsHash,
        settledResult: settled.settledResult,
        outcome: settled.outcome,
        ...(settled.errorCode ? { errorCode: settled.errorCode } : {}),
        truncated: settled.truncated,
        ...(settled.durationMs === undefined ? {} : { durationMs: settled.durationMs }),
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: settled.settledResult });
    }
  }
  await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
  return { turns: turn };
}

/** Mutates the one cassette file of a directory. Used to build the tampered cases — never silently. */
function mutateCassette(directory: string, mutate: (file: { bundle: Record<string, unknown>; steps: Array<{ payload: ReplayBundleStepPayload }> }) => void): void {
  const name = readdirSync(directory).find((entry) => entry.endsWith(CASSETTE_FILE_EXTENSION));
  expect(name).toBeTruthy();
  const filePath = path.join(directory, name!);
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { bundle: Record<string, unknown>; steps: Array<{ payload: ReplayBundleStepPayload }> };
  mutate(parsed);
  writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf8");
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

/** The `payloadHash` a cassette file really stores — the read port does not expose it, so the bytes are read. */
function storedPayloadHash(directory: string): unknown {
  const name = readdirSync(directory).find((entry) => entry.endsWith(CASSETTE_FILE_EXTENSION));
  expect(name).toBeTruthy();
  const parsed = JSON.parse(readFileSync(path.join(directory, name!), "utf8")) as { bundle?: { payloadHash?: unknown } };
  return parsed.bundle?.payloadHash;
}

function cassetteError(value: unknown): ReplayCassetteError {
  expect(value).toBeInstanceOf(ReplayCassetteError);
  const error = value as ReplayCassetteError;
  // Every refusal this module makes is metadata-only: the replay engine's own checker is the arbiter.
  assertReplayMetadataOnly(error.details);
  return error;
}

describe("security-gate: C14 provider cassette — the recorded sequence, replayed through the engine port", () => {
  it("reproduces the provider/tool sequence byte-for-byte: same steps, same replayInputHash, same header", async () => {
    const source = cassetteHarness();
    const target = cassetteHarness();
    await recordExchange(source.files);
    const original = await readRecording(source.files);

    const engine = new ReplayCassetteEngine({ recording: original, profile: { toolCallingMode: "native" } });
    const result = await runRecordedLoop({
      engine,
      store: target.files,
      // The cassette's own tool seam: a recorded settled result, read — nothing is executed.
      toolResult: (toolCallId) => engine.toolResultFor(toolCallId),
    });
    expect(result.turns).toBe(2);

    const reproduced = await readRecording(target.files);
    // Byte-for-byte: the ordered step payloads, the whole replay input, and the derived hash.
    expect(reproduced.steps).toEqual(original.steps);
    expect(reproduced.replayInput).toEqual(original.replayInput);
    expect(reproduced.replayInputHash).toBe(original.replayInputHash);
    expect(reproduced.integrityFailure).toBe(false);
    expect(reproduced.truncated).toBe(false);
    // …and the sequence is the recorded one, in the recorded order.
    expect(reproduced.steps.map((step) => `${step.kind}@${step.turnIndex}:${step.toolCallId ?? ""}`))
      .toEqual(["model_step@1:", "tool_call@1:call-1", "model_step@2:"]);

    // The header is reproduced too, so nothing about the exchange was lost at the port boundary. `payloadHash`
    // is not on the read port (the read path never uses it), so it is compared from the stored bytes.
    const originalHeader = await source.files.getReplayBundle(COMPANY, RUN);
    const reproducedHeader = await target.files.getReplayBundle(COMPANY, RUN);
    expect(reproducedHeader?.payload).toEqual(originalHeader?.payload);
    expect(storedPayloadHash(target.directory)).toBe(storedPayloadHash(source.directory));

    // Measured, not promised: every answer came from the recording, and every tool result was read from it.
    expect(engine.recordedModelSteps).toBe(2);
    expect(engine.servedModelSteps).toBe(2);
    expect(engine.toolResultsServed).toBe(1);
    expect(engine.reproducibility()).toMatchObject({
      servedModelSteps: 2,
      toolResultsServed: 1,
      providerDials: 0,
      toolExecutions: 0,
    });
  });

  it("measures its own zeros: the same walk with live ports really dials and really executes", async () => {
    const source = cassetteHarness();
    const cassetteTarget = cassetteHarness();
    const liveTarget = cassetteHarness();
    await recordExchange(source.files);
    const original = await readRecording(source.files);

    const fetchSpy = vi.fn(async () => {
      throw new Error("the deterministic walk must not perform an HTTP request");
    });
    const liveEngine = {
      chatCalls: 0,
      async chat(): Promise<ChatResult> {
        this.chatCalls += 1;
        return this.chatCalls === 1
          ? {
              content: "live answer",
              finishReason: "tool_calls",
              model: MODEL,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              toolCalls: [{ id: "live-call-1", type: "function", function: { name: TOOL, arguments: OTHER_ARGUMENTS } }],
              telemetry: { provider: "provider-live", latencyMs: 1, cacheHit: false, failoverCount: 0 },
            }
          : {
              content: "live final",
              finishReason: "stop",
              model: MODEL,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              telemetry: { provider: "provider-live", latencyMs: 1, cacheHit: false, failoverCount: 0 },
            };
      },
      supportsNativeTools: () => true,
    };
    const liveToolExecutions: string[] = [];
    const liveToolResult = (toolCallId: string, tool: string): CassetteToolResult => {
      liveToolExecutions.push(toolCallId);
      return {
        toolCallId,
        tool,
        toolVersion: 1,
        argumentsHash: replayArgumentsHash(OTHER_ARGUMENTS),
        settledResult: JSON.stringify({ ok: true, tool, result: "live output", truncated: false }),
        outcome: "ok",
        truncated: false,
      };
    };

    try {
      vi.stubGlobal("fetch", fetchSpy);
      const cassetteEngine = new ReplayCassetteEngine({ recording: original });
      await runRecordedLoop({
        engine: cassetteEngine,
        store: cassetteTarget.files,
        toolResult: (toolCallId) => cassetteEngine.toolResultFor(toolCallId),
      });
      // The deterministic walk: zero HTTP attempts, zero executions through the live tool seam.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(liveToolExecutions).toEqual([]);
      expect(liveEngine.chatCalls).toBe(0);

      // Negative control: hand the *same* loop a live engine and a live tool seam and both really happen, so the
      // zeros above are a measurement of this walk rather than a counter nobody wired.
      const live = await runRecordedLoop({ engine: liveEngine, store: liveTarget.files, toolResult: liveToolResult });
      expect(live.turns).toBe(2);
      expect(liveEngine.chatCalls).toBe(2);
      expect(liveToolExecutions).toEqual(["live-call-1"]);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Negative control for the network counter itself: the stub really observes a request, so "not called"
      // above is a measurement of the walk and not a stub nobody could reach.
      await fetch("https://cassette.invalid/").catch(() => undefined);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }

    // And the recorded answers came from the cassette, not from the live engine: the two runs differ, precisely
    // because one replayed and the other asked.
    const replayed = await readRecording(cassetteTarget.files);
    const asked = await readRecording(liveTarget.files);
    expect(replayed.replayInputHash).toBe(original.replayInputHash);
    expect(asked.replayInputHash).not.toBe(original.replayInputHash);
  });

  it("answers supportsNativeTools from the profile, with the recorded evidence for `auto`", async () => {
    const withCalls = cassetteHarness();
    const withoutCalls = cassetteHarness();
    await recordExchange(withCalls.files);
    await recordFinalOnly(withoutCalls.files);
    const native = await readRecording(withCalls.files);
    const plain = await readRecording(withoutCalls.files, "run-final-only");

    expect(new ReplayCassetteEngine({ recording: native, profile: { toolCallingMode: "native" } }).supportsNativeTools()).toBe(true);
    expect(new ReplayCassetteEngine({ recording: native, profile: { toolCallingMode: "text" } }).supportsNativeTools()).toBe(false);
    // `auto` is the project's documented asymmetry: native only when the recorded exchange really had native calls.
    expect(new ReplayCassetteEngine({ recording: native, profile: { toolCallingMode: "auto" } }).supportsNativeTools()).toBe(true);
    expect(new ReplayCassetteEngine({ recording: plain, profile: { toolCallingMode: "auto" } }).supportsNativeTools()).toBe(false);
    // No profile: the conservative default an unknown model gets, resolved by the same function the loop uses.
    expect(new ReplayCassetteEngine({ recording: native }).supportsNativeTools()).toBe(true);
    expect(new ReplayCassetteEngine({ recording: plain }).supportsNativeTools()).toBe(false);
  });

  it("refuses a request that is not the recorded one, consumes nothing from it, and never falls back", async () => {
    const harness = cassetteHarness();
    await recordExchange(harness.files);
    const recording = await readRecording(harness.files);
    const engine = new ReplayCassetteEngine({ recording });

    const replies: ChatResult[] = [];
    const cases: Array<{ label: string; request: CodingAgentChatRequest; field: string }> = [
      {
        label: "a different conversation length",
        request: cassetteRequest({ messages: [{ role: "user", content: "different" }] }),
        field: "messageCount",
      },
      { label: "a different model", request: cassetteRequest({ model: "another-model" }), field: "model" },
      { label: "a different exchange identity", request: cassetteRequest({ idempotencyKey: "somebody-elses-run:1" }), field: "idempotencyKey" },
      {
        label: "a different provider policy context",
        request: cassetteRequest({ policyContext: { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, dataClassification: "public" } }),
        field: "dataClassification",
      },
      {
        label: "a different tool offer",
        request: cassetteRequest({
          tools: [{ type: "function", function: { name: "code.shell.exec", description: "shell", parameters: {} } }],
        }),
        field: "toolNames",
      },
    ];

    for (const scenario of cases) {
      const error = cassetteError(await captureError(() => engine.chat(scenario.request)));
      expect(error.code).toBe(REPLAY_CASSETTE_CODES.requestMismatch);
      expect(error.details.fields).toEqual([scenario.field]);
      // The refusal names the field, never the conversation, and never falls back to another answer.
      expect(JSON.stringify(error.details)).not.toContain("I will read the file.");
      expect(JSON.stringify(error.details)).not.toContain(RAW_ARGUMENTS);
    }
    // A refused request consumes nothing: the first recorded answer is still the first answer served.
    expect(engine.servedModelSteps).toBe(0);
    replies.push(await engine.chat(cassetteRequest()));
    expect(replies[0]?.content).toBe("I will read the file.");
    expect(replies[0]?.finishReason).toBe("tool_calls");
    expect(replies[0]?.model).toBe(MODEL);
    expect(replies[0]?.telemetry?.provider).toBe("provider-a");
    expect(replies[0]?.usage).toEqual({ promptTokens: 8, completionTokens: 4, totalTokens: 12 });
    expect(replies[0]?.toolCalls?.[0]?.function.arguments).toBe(RAW_ARGUMENTS);

    // The second answer needs the recorded tool result to have been fed back: without it the recorded message
    // count cannot be produced, which is the "same input" pin doing its job.
    const tooShort = cassetteError(await captureError(() => engine.chat(cassetteRequest({
      messages: [{ role: "system", content: "system prompt" }],
      idempotencyKey: `${SESSION}:${RUN}:2`,
    }))));
    expect(tooShort.code).toBe(REPLAY_CASSETTE_CODES.requestMismatch);
    expect(tooShort.details.fields).toEqual(["messageCount"]);

    // …and asking for more answers than were recorded is its own refusal, not a repeat of the last one.
    await engine.chat(cassetteRequest({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "assistant", content: "a" }, { role: "tool", tool_call_id: "call-1", content: SETTLED_RESULT }], idempotencyKey: `${SESSION}:${RUN}:2` }));
    const exhausted = cassetteError(await captureError(() => engine.chat(cassetteRequest())));
    expect(exhausted.code).toBe(REPLAY_CASSETTE_CODES.exhausted);
    expect(exhausted.details).toMatchObject({ served: 2, recorded: 2 });
  });

  it("refuses to invent what the recording does not hold, and keeps a pre-C14 bundle verifiable", async () => {
    const harness = cassetteHarness();
    await recordExchange(harness.files, { includeArguments: false });
    const recording = await readRecording(harness.files);

    // The cassette cannot hand out a call whose argument text was never recorded, and it says which.
    const engine = new ReplayCassetteEngine({ recording });
    const error = cassetteError(await captureError(() => engine.chat(cassetteRequest())));
    expect(error.code).toBe(REPLAY_CASSETTE_CODES.argumentsUnavailable);
    expect(error.details).toMatchObject({ reason: "arguments_not_recorded", toolCallId: "call-1", tool: TOOL });

    // The same bundle is still readable and still verifies through the **existing** hash-based engine: only the
    // cassette needs the bytes, because only the cassette has to produce a `ChatResult`.
    const verified = await replayRecorded({
      recording,
      toolVersions: () => TOOL_VERSION,
      bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
      recordedTerminalStatus: "completed",
    });
    expect(verified.ok).toBe(true);
    expect(verified.status).toBe("replayed");
    expect(verified.providerCalls).toBe(0);
    expect(verified.toolExecutions).toBe(0);

    // A tool call the recording never made, and a call recorded without a settled result: both refuse.
    const unknownCall = cassetteError(await captureError(async () => engine.toolResultFor("call-never-recorded")));
    expect(unknownCall.code).toBe(REPLAY_CASSETTE_CODES.toolResultMissing);
    expect(unknownCall.details).toMatchObject({ reason: "tool_call_not_recorded", recordedToolCalls: 1 });

    const noResult = cassetteHarness();
    await recordExchange(noResult.files);
    mutateCassette(noResult.directory, (file) => {
      const toolStep = file.steps.find((step) => step.payload.kind === "tool_call")!;
      delete toolStep.payload.settledResult;
      file.bundle.replayInputHash = replayInputHash(file.steps.map((step) => step.payload));
    });
    const noResultEngine = new ReplayCassetteEngine({ recording: await readRecording(noResult.files) });
    const missing = cassetteError(await captureError(async () => noResultEngine.toolResultFor("call-1")));
    expect(missing.code).toBe(REPLAY_CASSETTE_CODES.toolResultMissing);
    expect(missing.details).toMatchObject({ reason: "settled_result_not_recorded" });

    // A call that lost its own tool name: an empty name would be a *different* call, so this refuses too.
    const nameless = cassetteHarness();
    await recordExchange(nameless.files);
    mutateCassette(nameless.directory, (file) => {
      const modelStep = file.steps.find((step) => step.payload.kind === "model_step")!;
      const response = modelStep.payload.response as { toolCalls: Array<Record<string, unknown>> };
      delete response.toolCalls[0]!.name;
      file.bundle.replayInputHash = replayInputHash(file.steps.map((step) => step.payload));
    });
    const namelessEngine = new ReplayCassetteEngine({ recording: await readRecording(nameless.files) });
    const namelessError = cassetteError(await captureError(() => namelessEngine.chat(cassetteRequest())));
    expect(namelessError.code).toBe(REPLAY_CASSETTE_CODES.toolCallIncomplete);
    expect(namelessError.details).toMatchObject({ reason: "tool_name_not_recorded", toolCallId: "call-1" });

    // A partial usage is refused rather than completed with zeros that would reach a run summary as metering.
    const partialUsage = cassetteHarness();
    await recordExchange(partialUsage.files);
    mutateCassette(partialUsage.directory, (file) => {
      const modelStep = file.steps.find((step) => step.payload.kind === "model_step")!;
      (modelStep.payload.response as { usage?: unknown }).usage = { totalTokens: 12 };
      file.bundle.replayInputHash = replayInputHash(file.steps.map((step) => step.payload));
    });
    const partialEngine = new ReplayCassetteEngine({ recording: await readRecording(partialUsage.files) });
    const incomplete = cassetteError(await captureError(() => partialEngine.chat(cassetteRequest())));
    expect(incomplete.code).toBe(REPLAY_CASSETTE_CODES.usageIncomplete);
  });

  it("refuses a tampered cassette loudly: the integrity hash and two independent second walls", async () => {
    // (1) A step payload edited without touching the stored hash: the existing integrity check catches it, and
    // the cassette refuses to be built at all.
    const edited = cassetteHarness();
    await recordExchange(edited.files);
    mutateCassette(edited.directory, (file) => {
      const toolStep = file.steps.find((step) => step.payload.kind === "tool_call")!;
      toolStep.payload.settledResult = JSON.stringify({ ok: true, tool: TOOL, result: "TAMPERED", truncated: false });
    });
    const broken = await readRecording(edited.files);
    expect(broken.integrityFailure).toBe(true);
    const notIntact = cassetteError(await captureError(async () => new ReplayCassetteEngine({ recording: broken })));
    expect(notIntact.code).toBe(REPLAY_CASSETTE_CODES.notIntact);
    expect(notIntact.details).toMatchObject({ reason: "replay_integrity_failed" });
    // The existing deterministic engine refuses the very same recording, so the two paths cannot disagree.
    const existingRefusal = await captureError(() => replayRecorded({
      recording: broken,
      toolVersions: () => TOOL_VERSION,
      bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
      recordedTerminalStatus: "completed",
    }));
    expect((existingRefusal as { code?: string }).code).toBe(CODE_REPLAY_CODES.integrityFailed);
    expect((existingRefusal as { httpStatus?: number }).httpStatus).toBe(409);

    // (2) A step removed while the header still claims it: a partial recording cannot be replayed.
    const truncated = cassetteHarness();
    await recordExchange(truncated.files);
    mutateCassette(truncated.directory, (file) => {
      file.steps.pop();
      file.bundle.replayInputHash = replayInputHash(file.steps.map((step) => step.payload));
    });
    const partial = await readRecording(truncated.files);
    expect(partial.integrityFailure).toBe(false);
    expect(partial.truncated).toBe(true);
    const truncatedError = cassetteError(await captureError(async () => new ReplayCassetteEngine({ recording: partial })));
    expect(truncatedError.code).toBe(REPLAY_CASSETTE_CODES.notIntact);
    expect(truncatedError.details).toMatchObject({ reason: "replay_bundle_truncated" });

    // (3) A fully re-forged cassette — the argument bytes replaced *and* the bundle hash recomputed, so the
    // integrity check passes. The call-level pin is what catches it: the bytes no longer hash to the recorded
    // `argumentsHash`.
    const forgedArguments = cassetteHarness();
    await recordExchange(forgedArguments.files);
    mutateCassette(forgedArguments.directory, (file) => {
      const modelStep = file.steps.find((step) => step.payload.kind === "model_step")!;
      const response = modelStep.payload.response as { toolCalls: Array<Record<string, unknown>> };
      response.toolCalls[0]!.arguments = OTHER_ARGUMENTS;
      file.bundle.replayInputHash = replayInputHash(file.steps.map((step) => step.payload));
    });
    const forgedArgumentsRecording = await readRecording(forgedArguments.files);
    expect(forgedArgumentsRecording.integrityFailure).toBe(false);
    const forgedEngine = new ReplayCassetteEngine({ recording: forgedArgumentsRecording });
    const argumentsError = cassetteError(await captureError(() => forgedEngine.chat(cassetteRequest())));
    expect(argumentsError.code).toBe(REPLAY_CASSETTE_CODES.argumentsMismatch);
    expect(argumentsError.details).toMatchObject({ reason: "arguments_hash_mismatch", toolCallId: "call-1", expected: replayArgumentsHash(RAW_ARGUMENTS), actual: replayArgumentsHash(OTHER_ARGUMENTS) });

    // (4) The same for a tool result: re-forged hash, edited settled result — the result's own recorded hash is
    // the wall, so a replayed run can never be handed a tool result the recorder did not write.
    const forgedResult = cassetteHarness();
    await recordExchange(forgedResult.files);
    mutateCassette(forgedResult.directory, (file) => {
      const toolStep = file.steps.find((step) => step.payload.kind === "tool_call")!;
      toolStep.payload.settledResult = JSON.stringify({ ok: true, tool: TOOL, result: "FORGED", truncated: false });
      file.bundle.replayInputHash = replayInputHash(file.steps.map((step) => step.payload));
    });
    const forgedResultRecording = await readRecording(forgedResult.files);
    expect(forgedResultRecording.integrityFailure).toBe(false);
    const forgedResultEngine = new ReplayCassetteEngine({ recording: forgedResultRecording });
    const resultError = cassetteError(await captureError(async () => forgedResultEngine.toolResultFor("call-1")));
    expect(resultError.code).toBe(REPLAY_CASSETTE_CODES.settledResultMismatch);
    expect(resultError.details).toMatchObject({ reason: "settled_result_hash_mismatch", toolCallId: "call-1" });

    // The standalone read is the same logic as the engine's seam, and refuses identically.
    const standalone = cassetteError(await captureError(async () => cassetteToolResult(forgedResultRecording, "call-1")));
    expect(standalone.code).toBe(REPLAY_CASSETTE_CODES.settledResultMismatch);
    // A recording that is intact still answers with the recorded, model-visible settled result.
    const intact = cassetteHarness();
    await recordExchange(intact.files);
    expect(cassetteToolResult(await readRecording(intact.files), "call-1").settledResult).toBe(SETTLED_RESULT);
  });

  it("keeps the format at version 3 and hashes a bundle without the new field exactly as before", async () => {
    const argumentsHash = "sha256:args";
    /**
     * The exact C10 fixture, and the **literal** hash
     * `tests/coding-agent-c10-rewind-fork.test.ts` pinned before C14 existed: a step carrying no `arguments`
     * field still derives exactly that value, which is what makes the new field additive and the format version
     * immovable. The value is computed by the same function the recorder uses and then compared with what each
     * store really holds.
     */
    const PRE_C14_INPUT_HASH = "sha256:579374f118457967140d5f0cadb61f1a9bb004b8fa8fe7656938ea6e6d8fab17";
    const recordPreC14Fixture = async (store: ReplayBundlePersistPort): Promise<string> => {
      const recorder = new ReplayBundleRecorder({
        store,
        context: {
          workspaceId: "ws-1", companyId: "company-legacy", projectId: "project-legacy", sessionId: "session-legacy",
          runId: "run-legacy", executionSnapshotId: null, runnerVersion: "runner-1", systemPromptVersion: 1,
          systemPromptContentHash: "sha256:prompt", modelProfileVersion: 1, provider: "provider-a", model: "model-a",
          replayMode: "recorded", dataClassification: "confidential", retentionClass: "standard",
        },
        toolOutputChars: 4_000,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });
      recorder.recordModelStep({
        turnIndex: 1,
        request: { model: "model-a", messageCount: 2, toolNames: ["code.fs.edit"], idempotencyKey: "session-1:run-1:1", dataClassification: "confidential" },
        response: {
          content: "hello", finishReason: "tool_calls", model: "model-a", provider: "provider-a",
          usage: { totalTokens: 5, promptTokens: 3, completionTokens: 2 },
          toolCalls: [{ id: "call-1", name: "code.fs.edit", argumentsHash }],
        },
      });
      recorder.recordToolCall({
        turnIndex: 1, toolCallId: "call-1", tool: "code.fs.edit", toolVersion: 1,
        argumentsHash, settledResult: '{"ok":true,"tool":"code.fs.edit"}', outcome: "ok", truncated: false, durationMs: 3,
      });
      const computed = replayInputHash(recorder.orderedSteps());
      await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
      return computed;
    };

    const memory = new InMemoryWorkspaceStore();
    expect(await recordPreC14Fixture(memory)).toBe(PRE_C14_INPUT_HASH);
    expect((await memory.getReplayBundle("company-legacy", "run-legacy"))?.replayInputHash).toBe(PRE_C14_INPUT_HASH);
    // The file cassette derives and stores the same hash for the same bytes, so the container changes nothing.
    const legacyFiles = cassetteHarness();
    expect(await recordPreC14Fixture(legacyFiles.files)).toBe(PRE_C14_INPUT_HASH);
    const legacyHeader = await legacyFiles.files.getReplayBundle("company-legacy", "run-legacy");
    expect(legacyHeader?.replayInputHash).toBe(PRE_C14_INPUT_HASH);
    expect(REPLAY_BUNDLE_FORMAT_VERSION).toBe(3);

    const legacyRead = await readReplayBundle({ store: legacyFiles.files, companyId: "company-legacy", runId: "run-legacy" });
    expect(legacyRead.kind).toBe("bundle");
    expect(legacyRead.replayInputHash).toBe(PRE_C14_INPUT_HASH);
    expect(replayInputHash(legacyRead.replayInput)).toBe(bundleHash({ steps: legacyRead.replayInput }));
    expect(legacyRead.integrityFailure).toBe(false);
    // A pre-C14 bundle has no such field at all, so it is not merely empty — it is absent, which is what keeps
    // the old derivation byte for byte.
    expect(((legacyRead.replayInput[0]!.response as { toolCalls: Array<Record<string, unknown>> }).toolCalls[0] ?? {}).arguments).toBeUndefined();

    // The field is replay **input**, so a bundle that carries it has a different hash — visible exactly where it
    // matters — and the bytes survive the file round-trip.
    const withArguments = cassetteHarness();
    await recordExchange(withArguments.files);
    const recording = await readRecording(withArguments.files);
    const modelStep = recording.replayInput[0]!;
    const calls = (modelStep.response as { toolCalls: Array<Record<string, unknown>> }).toolCalls;
    expect(calls[0]?.arguments).toBe(RAW_ARGUMENTS);
    expect(replayInputHash(recording.replayInput)).not.toBe(PRE_C14_INPUT_HASH);
  });

  it("carries the reproducibility-not-quality statement in the code and as data", async () => {
    const harness = cassetteHarness();
    await recordExchange(harness.files);
    const engine = new ReplayCassetteEngine({ recording: await readRecording(harness.files) });

    const report = engine.reproducibility();
    expect(report.mode).toBe("recorded_sequence");
    expect(report.proves).toBe("provider_and_tool_sequence_reproducibility");
    expect(report.doesNotProve).toEqual(["model_quality", "live_provider_behaviour"]);
    expect(report.providerDials).toBe(0);
    expect(report.toolExecutions).toBe(0);
    expect(report.notice).toBe(CASSETTE_REPRODUCIBILITY_NOTICE);
    // The surface is closed: there is no field a reader could mistake for a quality or model score.
    expect(Object.keys(report)).toEqual([
      "mode", "proves", "doesNotProve", "servedModelSteps", "toolResultsServed", "providerDials", "toolExecutions", "notice",
    ]);
    expect(CASSETTE_REPRODUCIBILITY_NOTICE).toContain("proves reproducibility of the exchange, not the quality of the model");

    // …and the statement is in the module itself, so the wording cannot survive only in this suite.
    const source = readFileSync(path.join(process.cwd(), "apps", "agent-api", "src", "code-replay-cassette.ts"), "utf8");
    expect(source).toContain("not the quality of the model");
    expect(source).toContain("proves **reproducibility of the provider/tool sequence**");
  });
});
