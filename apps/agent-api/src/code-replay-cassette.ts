/**
 * C14 (owner decision 2): the **provider cassette** — the minimal adaptation of `CodeRunEnginePort.chat` that
 * replays a recorded exchange instead of talking to a model.
 *
 * What a cassette proves, and what it does not. It proves **reproducibility of the provider/tool sequence**: the
 * same input produces the same ordered model steps and tool calls, the same settled tool results, the same
 * `replayInputHash`, no provider dialog and no tool execution. It does **not** measure the quality of the model:
 * it replays answers a model already gave, so a cassette score can never be read as a model score, and nothing
 * here computes one. `CASSETTE_REPRODUCIBILITY_NOTICE` and `ReplayCassetteEngine.reproducibility()` carry that
 * statement as data, so a consumer cannot paraphrase it into a quality claim.
 *
 * Why an *adaptation* and not a second provider. The runner has exactly one model seam, `CodeRunEnginePort`
 * (`chat` plus the optional `supportsNativeTools` probe, see `coding-agent-runner.ts`). This class implements
 * that interface and holds **one** dependency: the recording. It has no transport, no HTTP client, no socket, no
 * provider, no tool runtime and no `fetch` — a live dialog or a tool execution is not merely refused here, it is
 * unreachable, which is why `providerDials`/`toolExecutions` are structural zeros and not promises. The suite
 * measures both at the process boundary instead of taking the class's word for it (a stubbed global `fetch` and
 * a tool runtime that throws if it is ever consulted).
 *
 * How faithful it is, and where it refuses instead of guessing:
 *
 *  - The recorded model answer is served **in order**, and only to a request that matches the recorded request
 *    (`idempotencyKey`, `model`, message count, the offered tool set and the policy-context data
 *    classification). A different conversation therefore gets a loud `replay_cassette_request_mismatch` rather
 *    than somebody else's recorded answer — there is no fallback to a live provider, because there is none.
 *  - Tool calls carry the recorded argument **bytes**, verified against the recorded `argumentsHash` before they
 *    are served, through the recorder's own canonical conversion (`replayArgumentsHash`): the hash pins the
 *    argument *value*, so both sides of the recording agree by construction and a substituted value still
 *    refuses. A recording that predates the bytes refuses with `replay_cassette_arguments_unavailable`: a
 *    hash cannot reconstruct a call, and serving `""` would hand a run a different tool call than the recorded
 *    one. Nothing is ever completed with a default — a partially recorded `usage` is refused
 *    (`replay_cassette_usage_incomplete`) rather than filled with zeros that would enter a run summary as
 *    metering.
 *  - Tool results are **read**, never executed: `toolResultFor` returns the recorded model-visible settled
 *    result, checked against the recorded `settledResultHash` that the recorder wrote beside it. Re-executing a
 *    tool could not reproduce that text (the untruncated result is deliberately not recorded), and it would be a
 *    live action inside a deterministic walk.
 *  - A recording whose integrity already fails (`integrityFailure`/`truncated` from `readReplayBundle`) is
 *    refused when the cassette is built, so a tampered cassette cannot be walked half-way and then "explained".
 */

import type { ChatResult, ChatToolCall } from "@npati/omniroute-adapter";
import {
  bundleHash,
  replayArgumentsHash,
  type ReplayBundleReadResult,
  type ReplayBundleStepPayload,
} from "./code-replay-bundle";
import { resolveEffectiveToolCallingMode, type CodeModelProfile } from "./code-model-profiles";
import type { CodeRunEnginePort, CodingAgentChatRequest } from "./coding-agent-runner";

/**
 * The honest label of everything this module produces. It is exported so a caller, a report or a UI has to
 * repeat the statement rather than invent a stronger one; a cassette score is a reproducibility score.
 */
export const CASSETTE_REPRODUCIBILITY_NOTICE =
  "Deterministic replay of a recorded provider/tool sequence: this proves reproducibility of the exchange, not the quality of the model.";

export const REPLAY_CASSETTE_CODES = Object.freeze({
  /** The recording is missing, failed its integrity check, or is truncated: nothing can be replayed from it. */
  notIntact: "replay_cassette_not_intact",
  /** More model answers were asked for than the recording holds. A cassette never invents an answer. */
  exhausted: "replay_cassette_exhausted",
  /** The request does not match the recorded one: this cassette has no answer for that conversation. */
  requestMismatch: "replay_cassette_request_mismatch",
  /** A recorded tool call is missing its own id or its tool name, so it cannot be rebuilt as a call. */
  toolCallIncomplete: "replay_cassette_tool_call_incomplete",
  /** The recorded call carries no argument bytes (a pre-C14 bundle): the cassette refuses to fabricate them. */
  argumentsUnavailable: "replay_cassette_arguments_unavailable",
  /** The recorded argument bytes do not hash to the recorded `argumentsHash`: the cassette was altered. */
  argumentsMismatch: "replay_cassette_arguments_mismatch",
  /** The recorded usage is partial, so a `ChatResult` cannot carry it without inventing token counts. */
  usageIncomplete: "replay_cassette_usage_incomplete",
  /** No recorded settled result for that tool call: the cassette executes nothing, so it has nothing to give. */
  toolResultMissing: "replay_cassette_tool_result_missing",
  /** The recorded settled result does not hash to its own recorded `settledResultHash`. */
  settledResultMismatch: "replay_cassette_settled_result_mismatch",
});

/**
 * Raised instead of answering something weaker. `details` is metadata only — ids, tool names, hashes, counts and
 * field names — never recorded content: the suite asserts that with the replay engine's own
 * `assertReplayMetadataOnly`, so a future field cannot quietly start leaking an answer or a tool result.
 */
export class ReplayCassetteError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = "ReplayCassetteError";
    this.code = code;
    this.details = details;
  }
}

/** A recorded tool call's model-visible result, ready to be re-recorded — and never produced by executing it. */
export interface CassetteToolResult {
  toolCallId: string;
  tool: string;
  toolVersion: string | number | null;
  argumentsHash: string;
  settledResult: string;
  outcome: "ok" | "failed";
  errorCode?: string;
  truncated: boolean;
  durationMs?: number;
}

/** What a cassette is and is not, as data. `doesNotProve` is a closed list: no field names a quality score. */
export interface CassetteReproducibility {
  mode: "recorded_sequence";
  proves: "provider_and_tool_sequence_reproducibility";
  doesNotProve: readonly ["model_quality", "live_provider_behaviour"];
  servedModelSteps: number;
  toolResultsServed: number;
  /** Structurally zero: this module owns no transport, client or socket (see the module comment). */
  providerDials: 0;
  /** Structurally zero: this module owns no tool runtime and executes nothing (see the module comment). */
  toolExecutions: 0;
  notice: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : null;
}

/**
 * The provider seam of a recording.
 *
 * One adaptation, dropped in where a real engine would be: `chat` answers from the recording, `supportsNativeTools`
 * answers from the **profile** through the project's own resolver, so the cassette cannot disagree with the loop
 * about how tool calls are supposed to arrive.
 */
export class ReplayCassetteEngine implements CodeRunEnginePort {
  private readonly modelSteps: ReplayBundleStepPayload[];
  private readonly toolStepsByCallId = new Map<string, ReplayBundleStepPayload>();
  private readonly profile: Pick<CodeModelProfile, "toolCallingMode">;
  private readonly recordedNativeToolCalls: boolean;
  private readonly completionArtifacts: readonly Record<string, unknown>[];
  private cursor = 0;
  private served = 0;
  private toolResults = 0;

  constructor(input: {
    /** The result of the existing reader (`readReplayBundle` / `getReplayBundleById`) — one read path, no second. */
    recording: ReplayBundleReadResult;
    /**
     * The model profile the cassette should answer `supportsNativeTools` from. Optional: without it the
     * project's conservative default (`auto`, i.e. native only with evidence) applies, which is the same rule
     * an unknown model gets from `resolveModelProfile`.
     */
    profile?: Pick<CodeModelProfile, "toolCallingMode"> | null;
  }) {
    const { recording } = input;
    if (recording.kind !== "bundle") {
      throw new ReplayCassetteError(REPLAY_CASSETTE_CODES.notIntact, "There is no recorded bundle to replay", {
        reason: "replay_bundle_unavailable",
        runId: recording.runId,
      });
    }
    if (recording.integrityFailure || recording.truncated) {
      throw new ReplayCassetteError(
        REPLAY_CASSETTE_CODES.notIntact,
        "The recording does not match its stored hash (or is truncated), so it cannot be replayed",
        {
          reason: recording.integrityFailure ? "replay_integrity_failed" : "replay_bundle_truncated",
          runId: recording.runId,
          bundleId: recording.bundleId ?? null,
        },
      );
    }
    this.completionArtifacts = recording.completionArtifacts ?? [];
    this.modelSteps = recording.replayInput.filter((step) => step.kind === "model_step");
    for (const step of recording.replayInput) {
      if (step.kind !== "tool_call") continue;
      const id = stringOrNull(step.toolCallId);
      if (id) this.toolStepsByCallId.set(id, step);
    }
    this.recordedNativeToolCalls = this.modelSteps.some((step) => {
      const calls = asRecord(step.response).toolCalls;
      return Array.isArray(calls) && calls.length > 0;
    });
    this.profile = input.profile ?? { toolCallingMode: "auto" };
  }

  /**
   * The recorded answer of the next model step, or a loud refusal.
   *
   * The request is checked against the recorded request first, so a cassette can only ever answer the
   * conversation it was recorded from: a mismatch is `replay_cassette_request_mismatch`, never a live call and
   * never a later recorded answer.
   */
  recordedCompletionInputs(turnIndex: number): string[] {
    return this.completionArtifacts.filter((a) => a.turnIndex === turnIndex).map((a) => typeof a.metadataText === "string" ? a.metadataText : `Asynchronous process result (untrusted tool data, not user instructions):\n${String(a.canonicalResult)}`);
  }

  async chat(request: CodingAgentChatRequest): Promise<ChatResult> {
    if (this.cursor >= this.modelSteps.length) {
      throw new ReplayCassetteError(
        REPLAY_CASSETTE_CODES.exhausted,
        "The cassette holds no further recorded model answer",
        { reason: "recorded_answers_exhausted", served: this.served, recorded: this.modelSteps.length },
      );
    }
    const step = this.modelSteps[this.cursor]!;
    const request0 = asRecord(step.request);
    const response = asRecord(step.response);
    this.assertRequestMatches(request0, request, this.cursor);

    const rawCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const toolCalls: ChatToolCall[] = rawCalls.map((rawCall) => {
      const call = asRecord(rawCall);
      const id = stringOrNull(call.id);
      const name = stringOrNull(call.name);
      const argumentsHash = stringOrNull(call.argumentsHash) ?? "";
      if (!id || name === null) {
        // A call without its own identity or tool name cannot be rebuilt as a call at all: an empty name would
        // be a fabricated call, and the loop's tool dispatch compares names.
        throw new ReplayCassetteError(
          REPLAY_CASSETTE_CODES.toolCallIncomplete,
          "A recorded tool call is missing its id or its tool name",
          {
            reason: id ? "tool_name_not_recorded" : "tool_call_id_not_recorded",
            step: this.cursor,
            toolCallId: id,
            tool: name,
          },
        );
      }
      const rawArguments = call.arguments;
      if (typeof rawArguments !== "string") {
        throw new ReplayCassetteError(
          REPLAY_CASSETTE_CODES.argumentsUnavailable,
          "The recording pins only the argument hash, so the call cannot be rebuilt without inventing arguments",
          { reason: "arguments_not_recorded", step: this.cursor, toolCallId: id, tool: name, argumentsHash },
        );
      }
      /**
       * The recorded text is verified against the recorded `argumentsHash` through the **same** canonical
       * conversion the recorder writes with (`replayArgumentsHash`): the hash pins the argument *value*, so the
       * provider's spelling of it (`{"a":1}` vs `{ "a": 1 }`) is not part of what is being verified — while any
       * substituted argument value still fails. Hashing the bytes on this side and the value on the recorder's
       * side is exactly the drift that made a recorded run unreplayable, so both sides call one function.
       */
      const actualHash = replayArgumentsHash(rawArguments);
      if (argumentsHash !== actualHash) {
        throw new ReplayCassetteError(
          REPLAY_CASSETTE_CODES.argumentsMismatch,
          "The recorded argument bytes do not hash to the recorded argument hash",
          { reason: "arguments_hash_mismatch", step: this.cursor, toolCallId: id, tool: name, expected: argumentsHash, actual: actualHash },
        );
      }
      return { id, type: "function", function: { name, arguments: rawArguments } };
    });

    /**
     * Usage is carried only when it was recorded completely. A partial usage is refused instead of completed
     * with zeros: a fabricated token count would reach the run summary as metering, and "not recorded" must
     * never look like "zero tokens".
     */
    const recordedUsage = asRecord(response.usage);
    let usage: ChatResult["usage"];
    if (Object.keys(recordedUsage).length > 0) {
      const promptTokens = finiteNumberOrNull(recordedUsage.promptTokens);
      const completionTokens = finiteNumberOrNull(recordedUsage.completionTokens);
      const totalTokens = finiteNumberOrNull(recordedUsage.totalTokens);
      if (promptTokens === null || completionTokens === null || totalTokens === null) {
        throw new ReplayCassetteError(
          REPLAY_CASSETTE_CODES.usageIncomplete,
          "The recorded usage is partial, so it cannot be reported without inventing token counts",
          { reason: "usage_incomplete", step: this.cursor },
        );
      }
      usage = { promptTokens, completionTokens, totalTokens };
    }

    const provider = stringOrNull(response.provider);
    const finishReason = stringOrNull(response.finishReason);
    const answerModel = stringOrNull(response.model);
    const content = stringOrNull(response.content);
    this.cursor += 1;
    this.served += 1;
    const answer: ChatResult = {
      // A recorded answer always carries its text (the runner records `result.content ?? ""`); `""` is the honest
      // reading of a recording that holds none, and a cassette never invents prose.
      content: content ?? "",
      ...(finishReason !== null ? { finishReason } : {}),
      ...(answerModel !== null ? { model: answerModel } : {}),
      ...(usage ? { usage } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      // No provider was contacted, so there is no latency, no cache hit and no failover to report. `costUsd` is
      // deliberately absent rather than zero: a price was never recorded, and 0 would read as one.
      telemetry: {
        ...(provider !== null ? { provider } : {}),
        latencyMs: 0,
        cacheHit: false,
        failoverCount: 0,
      },
    };
    return answer;
  }

  /**
   * `supportsNativeTools` answered from the **profile**, through the resolver the loop itself uses. `native` and
   * `text` are the profile's own answer; `auto` resolves to native only on the recorded evidence (the run really
   * received native tool calls), which is exactly `resolveEffectiveToolCallingMode`'s documented asymmetry.
   */
  supportsNativeTools(_model?: string): boolean {
    return resolveEffectiveToolCallingMode(this.profile, { sawNativeToolCalls: this.recordedNativeToolCalls }) === "native";
  }

  /**
   * The recorded, model-visible settled result of one tool call — **read**, never executed.
   *
   * Three refusals, all loud: an unknown call id, a call recorded without a settled result (nothing could be fed
   * back), and a settled result that does not hash to the `settledResultHash` recorded beside it. The last one is
   * a second wall behind `replayInputHash`: a fully re-forged cassette that recomputes the bundle hash still
   * cannot hand out a tool result the recorder never wrote.
   */
  toolResultFor(toolCallId: string): CassetteToolResult {
    const step = this.toolStepsByCallId.get(toolCallId);
    if (!step) {
      throw new ReplayCassetteError(REPLAY_CASSETTE_CODES.toolResultMissing, "No recorded tool call has that id", {
        reason: "tool_call_not_recorded",
        toolCallId,
        recordedToolCalls: this.toolStepsByCallId.size,
      });
    }
    const settledResult = step.settledResult;
    if (typeof settledResult !== "string" || settledResult.length === 0) {
      throw new ReplayCassetteError(
        REPLAY_CASSETTE_CODES.toolResultMissing,
        "The recording holds no model-visible settled result for that call",
        { reason: "settled_result_not_recorded", toolCallId, tool: stringOrNull(step.tool) },
      );
    }
    const recordedHash = stringOrNull(step.settledResultHash);
    if (recordedHash !== null) {
      const actualHash = bundleHash({ settled: settledResult });
      if (recordedHash !== actualHash) {
        throw new ReplayCassetteError(
          REPLAY_CASSETTE_CODES.settledResultMismatch,
          "The recorded settled result does not hash to the hash recorded beside it",
          { reason: "settled_result_hash_mismatch", toolCallId, tool: stringOrNull(step.tool), expected: recordedHash, actual: actualHash },
        );
      }
    }
    const outcome = step.outcome;
    if (outcome !== "ok" && outcome !== "failed") {
      throw new ReplayCassetteError(
        REPLAY_CASSETTE_CODES.toolResultMissing,
        "The recording does not say how that tool call ended",
        { reason: "outcome_not_recorded", toolCallId, tool: stringOrNull(step.tool) },
      );
    }
    const durationMs = finiteNumberOrNull(step.durationMs);
    this.toolResults += 1;
    return {
      toolCallId,
      tool: stringOrNull(step.tool) ?? "",
      toolVersion: typeof step.toolVersion === "string" || typeof step.toolVersion === "number" ? step.toolVersion : null,
      argumentsHash: stringOrNull(step.argumentsHash) ?? "",
      settledResult,
      outcome,
      ...(stringOrNull(step.errorCode) !== null ? { errorCode: String(step.errorCode) } : {}),
      truncated: step.truncated === true,
      ...(durationMs === null ? {} : { durationMs }),
    };
  }

  /** Answers served from the recording so far. A provider dialog would not increment this. */
  get servedModelSteps(): number {
    return this.served;
  }

  /** Recorded tool results handed out so far. Executing a tool would not increment this. */
  get toolResultsServed(): number {
    return this.toolResults;
  }

  /** How many model steps the recording holds — what `servedModelSteps` must reach for a complete walk. */
  get recordedModelSteps(): number {
    return this.modelSteps.length;
  }

  /** What this cassette is, and explicitly what it is not: reproducibility, never model quality. */
  reproducibility(): CassetteReproducibility {
    return Object.freeze({
      mode: "recorded_sequence",
      proves: "provider_and_tool_sequence_reproducibility",
      // Read this as the limit of every number above: a cassette replays answers, it does not evaluate them.
      doesNotProve: ["model_quality", "live_provider_behaviour"] as const,
      servedModelSteps: this.served,
      toolResultsServed: this.toolResults,
      providerDials: 0,
      toolExecutions: 0,
      notice: CASSETTE_REPRODUCIBILITY_NOTICE,
    });
  }

  /**
   * The "same input" half of the contract. Only fields the recording actually holds are compared, so a bundle
   * written by an older recorder (or by a test fixture) is not refused for a field it never stored — but every
   * field it *did* store must match, and the error names the fields, never their content.
   */
  private assertRequestMatches(
    recorded: Record<string, unknown>,
    request: CodingAgentChatRequest,
    step: number,
  ): void {
    const fields: string[] = [];
    const differences: Array<{ field: string; expected: string | number | null; actual: string | number | null }> = [];
    const compare = (field: string, expected: string | number | null, actual: string | number | null): void => {
      if (expected === actual) return;
      fields.push(field);
      differences.push({ field, expected, actual });
    };

    const recordedModel = stringOrNull(recorded.model);
    if (recordedModel !== null) compare("model", recordedModel, stringOrNull(request.model));
    const recordedKey = stringOrNull(recorded.idempotencyKey);
    if (recordedKey !== null) compare("idempotencyKey", recordedKey, stringOrNull(request.idempotencyKey));
    const recordedClass = stringOrNull(recorded.dataClassification);
    if (recordedClass !== null) compare("dataClassification", recordedClass, stringOrNull(request.policyContext?.dataClassification));
    const recordedCount = finiteNumberOrNull(recorded.messageCount);
    if (recordedCount !== null) compare("messageCount", recordedCount, request.messages.length);
    const recordedTools = stringList(recorded.toolNames);
    if (recordedTools !== null) {
      const offered = (request.tools ?? []).map((tool) => tool.function.name);
      // NUL-joined rather than comma-joined: a tool name is an identifier, and a separator that cannot appear in
      // one keeps the comparison from conflating two different offers.
      compare("toolNames", recordedTools.join("\u0000"), offered.join("\u0000"));
    }

    if (fields.length) {
      throw new ReplayCassetteError(
        REPLAY_CASSETTE_CODES.requestMismatch,
        "The request does not match the recorded one, so this cassette has no answer for it",
        { reason: "recorded_request_mismatch", step, fields, differences },
      );
    }
  }
}

/**
 * The standalone read of a recorded settled tool result, for a caller that holds only the recording. The engine's
 * `toolResultFor` is the same logic with the per-instance counter; this exists so the cassette's tool seam can be
 * used without building an engine (and so a test can drive both and compare).
 */
export function cassetteToolResult(recording: ReplayBundleReadResult, toolCallId: string): CassetteToolResult {
  const engine = new ReplayCassetteEngine({ recording });
  return engine.toolResultFor(toolCallId);
}
