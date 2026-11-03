/**
 * C6b: the replay engine.
 *
 * Two modes, and they must never be confused with each other:
 *
 *  - **`recorded`** — deterministic. It consumes the recorded bundle (`code-replay-bundle.ts`, the sibling
 *    module that owns recording, the format version and canonicalisation) and verifies that the recorded
 *    **model output** and the recorded **execution** are the same run: every tool call the model asked for was
 *    executed, in order, with the same tool, the same schema version and the same canonical argument hash, and
 *    the recording ends with the same terminal status. It makes **no** provider call and executes **no** tool:
 *    there is no port through which a live engine or tool runtime could reach it, so the guarantee is
 *    architectural rather than a promise (`providerCalls`/`toolExecutions` are reported as zero because they
 *    are structurally zero).
 *  - **`live_best_effort`** — starts a **new** run, really calls the model and the tools, keeps the source
 *    run/snapshot as the baseline and is labelled best-effort everywhere. It is never called deterministic,
 *    and the notice is the exact wording the owner fixed.
 *
 * The engine adds no hashing of its own: it compares recorded hashes with recorded hashes and with the
 * **current** tool schema versions, which is how a changed tool contract is detected.
 */

import type { AuthContext, CodeSession } from "@npati/workspace";
import { resolveKnownTool } from "./code-tool-call-adapter";
import {
  REPLAY_BUNDLE_FORMAT_VERSION,
  replayModelSteps,
  replayToolResults,
  type ReplayBundleReadResult,
  type ReplayBundleStepPayload,
} from "./code-replay-bundle";
import { COMPACTION_SCHEMA_VERSION } from "./code-conversation-compaction";
import { ReplayRuntimeMcpManifestChangedError, assertReplayRuntimeMcpManifestMatches } from "./mcp-runtime-capabilities";

/** Shape version of the payloads this engine writes. Bumped when the meaning changes. */
export const CODE_REPLAY_SCHEMA_VERSION = 1;

export type CodeReplayMode = "recorded" | "live_best_effort";

/**
 * The exact wording the owner requires for live replay. It is a constant so no caller can paraphrase it, and
 * tests assert it appears **verbatim** in the result and in the API response.
 */
export const LIVE_REPLAY_REPRODUCIBILITY_NOTICE =
  "Best-effort reproducibility. External models, registries and services may have changed.";

// ---------------------------------------------------------------------------------------------------------
// Errors and divergence
// ---------------------------------------------------------------------------------------------------------

export class CodeReplayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeReplayError";
  }
}

export const CODE_REPLAY_CODES = Object.freeze({
  bundleUnavailable: "replay_bundle_unavailable",
  bundleVersionUnsupported: "replay_bundle_version_unsupported",
  integrityFailed: "replay_integrity_failed",
  bundleTruncated: "replay_bundle_truncated",
  requiresRecordedData: "replay_requires_recorded_data",
  toolVersionsRequired: "replay_tool_versions_required",
  sessionUnavailable: "replay_session_unavailable",
  diverged: "replay_diverged",
  sourceRunUnavailable: "replay_source_run_unavailable",
  liveUnavailable: "replay_live_unavailable",
  notFound: "replay_not_found",
  invalidMode: "replay_invalid_mode",
  /**
   * C8: a caller tried to hand the recorded engine a compaction/summarizer callback. Compaction is **reused,
   * never recomputed**: the recorded artifact is model-visible state, and a regenerated summary would differ
   * between two replays of the same run. Refusing loudly is the only honest answer, because "we ignored your
   * summarizer" and "we never needed one" are indistinguishable from the outside.
   */
  compactionRecomputeForbidden: "replay_compaction_recompute_forbidden",
  /** C8: a recorded compression artifact is present but unusable (wrong schema, no hash, not an object). */
  compressionArtifactInvalid: "replay_compression_artifact_invalid",
  /**
   * C13 (owner decision 6): the runtime MCP tool set (or one tool's schema) changed since the run was recorded,
   * or the deployment cannot state the current manifest at all. The replay is refused instead of silently
   * running against a different set of tools.
   */
  runtimeMcpManifestChanged: "replay_runtime_mcp_manifest_changed",
});

export type ReplayDivergenceReason =
  | "tool_call_order"
  | "tool_name"
  | "arguments_hash"
  | "tool_version"
  | "tool_version_unknown"
  | "unexpected_tool_call"
  | "missing_tool_call"
  | "inconsistent_outcome"
  | "terminal_status";

/**
 * A structured explanation of a divergence. Every field is metadata: ids, names, versions, hashes, counts and
 * the turn number. Arguments and results never travel here — a divergence report cannot leak a payload.
 */
export interface ReplayDivergence {
  reason: ReplayDivergenceReason;
  turn: number;
  toolCallId?: string;
  expected?: string | number | null;
  actual?: string | number | null;
}

const FORBIDDEN_DIVERGENCE_KEYS = [
  "args", "arguments", "argumentsjson", "content", "command", "diff", "result", "settledresult",
  "stdout", "stderr", "prompt", "token", "secret", "password",
] as const;

/** Throws when a divergence (or any replay record) starts carrying payload instead of metadata. */
export function assertReplayMetadataOnly(value: Record<string, unknown>, label = "replay record"): void {
  for (const key of Object.keys(value)) {
    if ((FORBIDDEN_DIVERGENCE_KEYS as readonly string[]).includes(key.toLowerCase())) {
      throw new CodeReplayError("replay_metadata_violation", `${label} must not carry "${key}"`, 500, { reason: key });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Deterministic (recorded) replay
// ---------------------------------------------------------------------------------------------------------

export interface ReplayComparison {
  modelSteps: { matched: number; expected: number };
  toolCalls: { matched: number; expected: number };
  terminalStatus: { matched: boolean; expected: string | null; actual: string };
  integrity: { replayInputHashMatched: boolean; truncated: boolean };
}

export interface RecordedReplayResult {
  replayId: string;
  mode: "recorded";
  ok: boolean;
  status: "replayed" | "diverged";
  runId: string;
  terminalStatus: string;
  recordedTerminalStatus: string | null;
  divergences: ReplayDivergence[];
  comparison: ReplayComparison;
  /**
   * The recorded mode makes no live call at all: these are structurally zero, reported so a caller (and a
   * test) can assert it rather than take it on faith.
   */
  providerCalls: number;
  toolExecutions: number;
  /**
   * C8: whether the recorded compaction was reused. `recomputed` is a structural zero — a caller that supplies
   * a summarizer is refused outright, and the only source of compaction state is the recorded bundle — while
   * `none_recorded` is the honest reading of a run that never compacted (or of a bundle written before the
   * compression artifact existed).
   */
  compression: ReplayCompressionState;
  /**
   * C13 (owner decision 6, corrected): what the runtime MCP pin of this replay was checked against.
   * `mode: "recorded"` means the run verified itself against the manifest **it recorded** — no discovery, no
   * dial (`dials` is a structural zero); `mode: "live"` means the caller supplied a live manifest and it matched
   * the recorded one; `mode: "none"` means the run recorded no manifest (no runtime MCP tool, or a pre-C13
   * bundle), so there was nothing to check. Hashes and modes only: never a schema body, an endpoint or an
   * argument.
   */
  runtimeMcpManifest: {
    mode: "recorded" | "live" | "none";
    checked: boolean;
    source: "recording" | "live_discovery" | "none";
    recordedHash: string | null;
    comparedHash: string | null;
    dials: number;
  };
  /** How many recorded steps the verification walk actually inspected. */
  stepsVerified: number;
  durationMs: number;
}

export interface RecordedReplayDeps {
  recording: ReplayBundleReadResult;
  /**
   * The current schema version per tool name (the published registry in production). Required: without it a
   * changed tool contract could not be detected, so the replay refuses instead of verifying less.
   */
  toolVersions?(toolName: string): number | null;
  /**
   * The bundle format version when the caller has the header; an unsupported one refuses the replay. The
   * recorded terminal status comes from the same header (the read result does not carry it), so it is passed
   * in rather than guessed.
   */
  bundleVersion?: number | null;
  recordedTerminalStatus?: string | null;
  /**
   * C8: a channel through which a **compaction/summarizer** could be handed in. The recorded engine has no
   * compaction step at all and must never gain one implicitly, so supplying this is refused with
   * `replay_compaction_recompute_forbidden` *before* it can be invoked — the callback is never called, which is
   * what a test asserts. The parameter exists precisely so the refusal is testable rather than a comment.
   */
  compaction?: () => unknown;
  /**
   * C13 (owner decision 6): the runtime MCP tool set of the tenant replaying the run.
   *
   * **Two modes, and they are not interchangeable** (owner requirement, C13 correction):
   *
   *  - **`recorded`** (the default, and the only mode a deterministic replay may use): the manifest the run
   *    recorded in its own bundle is used as the value to check against. The engine makes **no** discovery and
   *    contacts nothing — it has no transport, provider or discovery port at all — so the replay reproduces the
   *    run against the tool set and schemas it was admitted under, in a fresh process, with zero dials. This is
   *    also why the recorded tool results are the only results a replay feeds back.
   *  - **`live`** (opt-in): the caller already performed a **live discovery** and hands the current manifest in.
   *    It is compared with the recorded one and a difference is refused, so a live comparison can never silently
   *    substitute the current tool set for the recorded one.
   *
   * The mode is explicit (`runtimeMcpManifestMode`) and defaults to `live` exactly when a manifest is supplied,
   * which keeps every existing caller's meaning: a caller that passes a manifest is asking for the comparison.
   * An explicit `live` with nothing to compare stays a refusal — "we could not tell" is not "unchanged".
   */
  runtimeMcpManifest?: Record<string, unknown> | null;
  runtimeMcpManifestMode?: "recorded" | "live";
  onActivity?(event: Record<string, unknown> & { kind: string }): void | Promise<void>;
  now?(): number;
}

/**
 * C8: the recorded compaction, validated but never regenerated.
 *
 * Validation is structural — supported `schemaVersion`, a well-formed `contentHash`, an object shape — plus the
 * `replayInputHash` check the caller already performs, which now covers the artifacts themselves (format
 * version 3). The hash is deliberately **not** recomputed from the artifact's JSON here: the artifact is stored
 * as `jsonb`, and a database is free to reorder object keys, so a JSON-stringify-based recomputation would fail
 * on a perfectly intact artifact read back from Postgres. Canonical, order-independent hashing lives in the
 * replay-input hash, which is the check that actually detects an edited summary.
 */
export interface ReplayCompressionState {
  recorded: number;
  reused: number;
  verified: number;
  recomputed: 0;
  status: "reused_recorded_artifacts" | "none_recorded";
  schemaVersions: number[];
  artifactHashes: string[];
}

export function inspectRecordedCompression(
  artifacts: readonly Record<string, unknown>[] | undefined,
): ReplayCompressionState {
  const list = artifacts ?? [];
  const schemaVersions: number[] = [];
  const artifactHashes: string[] = [];
  list.forEach((artifact, index) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new CodeReplayError(
        CODE_REPLAY_CODES.compressionArtifactInvalid,
        "A recorded compression artifact is not an object",
        409,
        { reason: "replay_compression_artifact_invalid", index, field: "artifact" },
      );
    }
    const schemaVersion = numberOrNull((artifact as { schemaVersion?: unknown }).schemaVersion);
    if (schemaVersion === null || schemaVersion > COMPACTION_SCHEMA_VERSION || schemaVersion < 1) {
      throw new CodeReplayError(
        CODE_REPLAY_CODES.compressionArtifactInvalid,
        "A recorded compression artifact declares an unsupported schema version",
        409,
        {
          reason: "replay_compression_artifact_invalid",
          index,
          field: "schemaVersion",
          expected: COMPACTION_SCHEMA_VERSION,
          actual: schemaVersion,
        },
      );
    }
    const contentHash = (artifact as { contentHash?: unknown }).contentHash;
    if (typeof contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
      throw new CodeReplayError(
        CODE_REPLAY_CODES.compressionArtifactInvalid,
        "A recorded compression artifact has no usable content hash",
        409,
        { reason: "replay_compression_artifact_invalid", index, field: "contentHash" },
      );
    }
    schemaVersions.push(schemaVersion);
    artifactHashes.push(contentHash);
  });

  return {
    recorded: list.length,
    reused: list.length,
    verified: list.length,
    // The recorded engine recomputes nothing. Reported as a number so a caller can assert it rather than
    // believe it, exactly like `providerCalls`/`toolExecutions`.
    recomputed: 0,
    status: list.length > 0 ? "reused_recorded_artifacts" : "none_recorded",
    schemaVersions,
    artifactHashes,
  };
}

interface PendingCall {
  toolCallId: string;
  toolName: string;
  argumentsHash: string;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function divergence(reason: ReplayDivergenceReason, turn: number, fields: Partial<ReplayDivergence> = {}): ReplayDivergence {
  const value: ReplayDivergence = { reason, turn, ...fields };
  assertReplayMetadataOnly(value as unknown as Record<string, unknown>, "replay divergence");
  return value;
}

/**
 * C13 (owner decision 6, corrected): **one** implementation of the runtime MCP pin, used by both replay modes
 * so they cannot drift into two different checks.
 *
 * `recorded` is the manifest the run itself recorded (from its bundle); `current` is a manifest a **live**
 * caller discovered. `mode: "recorded"` checks the recording against itself — no discovery, no dial — and
 * `mode: "live"` compares a live value, refusing a difference and refusing "we could not tell".
 */
export function compareRuntimeMcpManifestForReplay(input: {
  recorded: Record<string, unknown> | null | undefined;
  current: Record<string, unknown> | null | undefined;
  mode: "recorded" | "live";
  runId: string;
}): RecordedReplayResult["runtimeMcpManifest"] {
  const recorded = input.recorded ?? null;
  // A run that recorded no runtime MCP manifest has nothing to compare, in either mode. That is the honest
  // "no runtime MCP tool was involved" answer, not a skipped check.
  if (!recorded) {
    return { mode: "none", checked: false, source: "none", recordedHash: null, comparedHash: null, dials: 0 };
  }
  const current = input.mode === "live" ? input.current ?? null : recorded;
  try {
    const checked = assertReplayRuntimeMcpManifestMatches({ recorded, current });
    return {
      mode: input.mode,
      checked: checked.checked,
      source: input.mode === "live" ? "live_discovery" : "recording",
      recordedHash: checked.recordedHash,
      comparedHash: checked.currentHash,
      // Structurally zero: this module owns no transport, discovery port or HTTP client, so a replay cannot dial
      // anything even by mistake. Reported so a caller (and a test) can assert it rather than believe it.
      dials: 0,
    };
  } catch (error) {
    if (error instanceof ReplayRuntimeMcpManifestChangedError) {
      throw new CodeReplayError(
        CODE_REPLAY_CODES.runtimeMcpManifestChanged,
        "The runtime MCP tool set or one of its schemas changed since this run was recorded",
        409,
        { runId: input.runId, mode: input.mode, ...error.details },
      );
    }
    throw error;
  }
}

/**
 * Deterministic replay: verify the recorded run against its own two records (model output and execution).
 *
 * Divergences are returned, not thrown, so a caller can show the whole comparison and the API can answer
 * `409 replay_diverged` with the first divergence's details (`assertReplayClean` does that conversion).
 */
export async function replayRecorded(deps: RecordedReplayDeps): Promise<RecordedReplayResult> {
  const started = (deps.now ?? Date.now)();
  const recording = deps.recording;

  if (!recording || recording.kind !== "bundle") {
    throw new CodeReplayError(CODE_REPLAY_CODES.bundleUnavailable, "No recorded bundle exists for this run", 404, {
      reason: "replay_bundle_unavailable",
      runId: recording?.runId ?? null,
    });
  }
  if (typeof deps.bundleVersion === "number" && deps.bundleVersion !== REPLAY_BUNDLE_FORMAT_VERSION) {
    throw new CodeReplayError(
      CODE_REPLAY_CODES.bundleVersionUnsupported,
      `Replay bundle version ${deps.bundleVersion} is not supported`,
      409,
      { reason: "replay_bundle_version_unsupported", expected: REPLAY_BUNDLE_FORMAT_VERSION, actual: deps.bundleVersion },
    );
  }
  if (recording.integrityFailure) {
    throw new CodeReplayError(
      CODE_REPLAY_CODES.integrityFailed,
      "The recorded replay input does not match its stored hash; the bundle was altered or truncated",
      409,
      { reason: "replay_integrity_failed", runId: recording.runId },
    );
  }
  if (recording.truncated) {
    throw new CodeReplayError(
      CODE_REPLAY_CODES.bundleTruncated,
      "The bundle claims more steps than were recorded; a partial recording cannot be replayed",
      409,
      { reason: "replay_bundle_truncated", runId: recording.runId },
    );
  }
  /**
   * C13 (owner decision 6, corrected): the runtime MCP tool set is dynamic, so the recording pins it and this is
   * where the pin is enforced. The check sits with the other structural refusals — before any verification walk —
   * so a changed schema cannot produce a "divergence report" against a tool set the run never had. A run without
   * a recorded manifest skips it entirely.
   *
   * The **default is the recorded manifest**, and that is the correction the owner asked for: a deterministic
   * replay must not discover anything. Reading the value out of the bundle it is about to verify cannot fail for
   * a reason that has nothing to do with the run (an empty in-process overlay after a restart), and it is the
   * only value that describes the tool set this run actually saw. A caller that hands in a **live** manifest
   * asks for the comparison instead, which is the separate live mode; the two meanings are reported apart in
   * `runtimeMcpManifest.mode` rather than merged into one "current manifest" concept.
   *
   * The MCP module raises its own error type so the guard is reusable outside replay; here it is translated into
   * the engine's single error vocabulary, keeping the structured reason and both hashes for the API answer.
   */
  const recordedRuntimeMcpManifest = recording.runtimeMcpManifest ?? null;
  const runtimeMcpManifestMode: "recorded" | "live" =
    deps.runtimeMcpManifestMode ?? (deps.runtimeMcpManifest ? "live" : "recorded");
  const runtimeMcpManifestReport = compareRuntimeMcpManifestForReplay({
    recorded: recordedRuntimeMcpManifest,
    // In `recorded` mode the comparison value is the recording itself, so the check can never fail for a reason
    // that has nothing to do with the run (an empty in-process overlay after a restart).
    current: runtimeMcpManifestMode === "live" ? deps.runtimeMcpManifest ?? null : recordedRuntimeMcpManifest,
    mode: runtimeMcpManifestMode,
    runId: recording.runId,
  });
  if (!deps.toolVersions) {
    throw new CodeReplayError(
      CODE_REPLAY_CODES.toolVersionsRequired,
      "Recorded replay needs the current tool schema versions to verify the recording",
      500,
      { reason: "replay_tool_versions_required" },
    );
  }

  const steps = recording.replayInput;
  /**
   * C8: compaction is **reused, never recomputed**.
   *
   * Two things make that structural instead of promised. First, a caller that tries to supply a
   * compaction/summarizer callback is refused here — before the callback could run — because a silently ignored
   * summarizer and a summarizer that was never needed are indistinguishable from the outside. Second, the only
   * source of compaction state is the recorded bundle, and it is validated (schema version, hash shape) but
   * never regenerated.
   */
  if (deps.compaction) {
    throw new CodeReplayError(
      CODE_REPLAY_CODES.compactionRecomputeForbidden,
      "Recorded replay reuses the recorded compaction artifact and never recomputes a summary",
      409,
      { reason: "replay_compaction_recompute_forbidden", runId: recording.runId },
    );
  }
  const compression = inspectRecordedCompression(recording.compressionArtifacts);
  const modelStepCount = replayModelSteps(steps).length;
  const toolStepCount = replayToolResults(steps).length;

  const divergences: ReplayDivergence[] = [];
  const pending: PendingCall[] = [];
  let modelMatched = 0;
  let toolMatched = 0;
  let lastModelHadToolCalls = false;
  let stepsVerified = 0;

  for (const step of steps as Array<ReplayBundleStepPayload & Record<string, unknown>>) {
    stepsVerified += 1;
    const turn = numberOrNull(step.turnIndex) ?? 0;

    if (step.kind === "model_step") {
      const response = (step.response ?? {}) as { toolCalls?: Array<Record<string, unknown>> };
      const calls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      modelMatched += 1;
      lastModelHadToolCalls = calls.length > 0;
      for (const call of calls) {
        pending.push({
          toolCallId: String(call.id ?? ""),
          toolName: String(call.name ?? ""),
          argumentsHash: String(call.argumentsHash ?? ""),
        });
      }
      continue;
    }

    if (step.kind !== "tool_call") continue;

    const actualId = String(step.toolCallId ?? "");
    const actualTool = String(step.tool ?? "");
    const actualHash = String(step.argumentsHash ?? "");
    const recordedVersion = numberOrNull(step.toolVersion);
    const expected = pending[0];

    if (!expected) {
      divergences.push(divergence("unexpected_tool_call", turn, { toolCallId: actualId, actual: actualTool }));
      continue;
    }
    if (expected.toolCallId !== actualId) {
      divergences.push(
        divergence("tool_call_order", turn, { toolCallId: actualId, expected: expected.toolCallId, actual: actualId }),
      );
      continue;
    }
    // A model may name a tool by its provider alias; the run executed the canonical tool.
    if (expected.toolName !== actualTool && resolveKnownTool([actualTool], expected.toolName)?.name !== actualTool) {
      divergences.push(
        divergence("tool_name", turn, { toolCallId: actualId, expected: expected.toolName, actual: actualTool }),
      );
      continue;
    }
    if (expected.argumentsHash !== actualHash) {
      divergences.push(
        divergence("arguments_hash", turn, { toolCallId: actualId, expected: expected.argumentsHash, actual: actualHash }),
      );
      continue;
    }
    // The tool contract itself must not have moved: a changed schema version is a divergence, not a warning.
    const currentVersion = deps.toolVersions(actualTool);
    if (currentVersion === null || currentVersion === undefined) {
      divergences.push(
        divergence("tool_version_unknown", turn, { toolCallId: actualId, expected: recordedVersion, actual: null }),
      );
      continue;
    }
    if (recordedVersion === null || recordedVersion !== currentVersion) {
      divergences.push(
        divergence("tool_version", turn, { toolCallId: actualId, expected: recordedVersion, actual: currentVersion }),
      );
      continue;
    }
    // An outcome that claims failure without a code is not a usable recording.
    if (step.outcome === "failed" && !step.errorCode) {
      divergences.push(divergence("inconsistent_outcome", turn, { toolCallId: actualId, actual: "failed" }));
      continue;
    }
    // The settled result is what the model saw; a call recorded without one cannot be replayed.
    if (typeof step.settledResult !== "string" || step.settledResult.length === 0) {
      throw new CodeReplayError(
        CODE_REPLAY_CODES.requiresRecordedData,
        "The recording has no settled result for a tool call it executed",
        500,
        { reason: "replay_requires_recorded_data", toolCallId: actualId },
      );
    }

    pending.shift();
    toolMatched += 1;
  }

  if (pending.length) {
    const missing = pending[0]!;
    divergences.push(
      divergence("missing_tool_call", numberOrNull((steps[steps.length - 1] as ReplayBundleStepPayload)?.turnIndex) ?? 0, {
        toolCallId: missing.toolCallId,
        expected: missing.toolName,
        actual: null,
      }),
    );
  }

  // The terminal status: a recording that ends with a model step that asked for no tool call ended normally,
  // so `completed` is derived and a header claiming otherwise is a divergence. A recording that ends
  // mid-flight (calls still pending) cannot derive a status, so the recorded one is reported as-is.
  const recordedTerminalStatus = deps.recordedTerminalStatus ?? null;
  const headerStatus = recordedTerminalStatus;
  const derivedTerminalStatus = lastModelHadToolCalls || pending.length ? "incomplete" : "completed";
  const terminalStatus = derivedTerminalStatus === "completed" ? "completed" : headerStatus ?? "incomplete";
  const terminalMatched =
    derivedTerminalStatus === "completed" ? headerStatus === null || headerStatus === "completed" : true;
  if (!terminalMatched && headerStatus !== null) {
    divergences.push(
      divergence("terminal_status", 0, { expected: headerStatus, actual: derivedTerminalStatus }),
    );
  }

  const result: RecordedReplayResult = {
    replayId: recording.bundleId ?? recording.runId,
    mode: "recorded",
    ok: divergences.length === 0,
    status: divergences.length === 0 ? "replayed" : "diverged",
    runId: recording.runId,
    terminalStatus,
    recordedTerminalStatus: recordedTerminalStatus ?? headerStatus,
    divergences,    comparison: {
      modelSteps: { matched: modelMatched, expected: modelStepCount },
      toolCalls: { matched: toolMatched, expected: toolStepCount },
      terminalStatus: { matched: terminalMatched, expected: headerStatus, actual: terminalStatus },
      integrity: { replayInputHashMatched: !recording.integrityFailure, truncated: Boolean(recording.truncated) },
    },
    // Structurally zero: no provider is called and no tool runs in the recorded mode.
    providerCalls: 0,
    toolExecutions: 0,
    /**
     * C8: compaction is **reused, never recomputed**. `recorded`/`reused`/`verified` count the artifacts the
     * recorded run produced and that this replay fed back verbatim; `recomputed` is a hard zero, and
     * `none_recorded` is the honest reading of a bundle written before this format version (or of a run that
     * never compacted) — never a licence to summarise on the fly. The artifact hashes travel with the result so
     * a caller can compare them with what the recorded run persisted, which is how "the same artifact" is
     * checked without recomputing it (a `jsonb` column may reorder keys, so re-hashing the JSON would be a
     * false alarm rather than a check).
     */
    compression,
    runtimeMcpManifest: runtimeMcpManifestReport,
    stepsVerified,
    durationMs: (deps.now ?? Date.now)() - started,
  };

  await deps.onActivity?.({
    kind: divergences.length ? "replay_diverged" : "replay_finished",
    replayId: result.replayId,
    runId: result.runId,
    mode: "recorded",
    divergences: divergences.length,
    providerCalls: 0,
    toolExecutions: 0,
    stepsVerified,
  });
  return result;
}

/** Route-facing conversion: a clean replay passes, a diverged one becomes `409 replay_diverged`. */
export function assertReplayClean(result: RecordedReplayResult): RecordedReplayResult {
  if (result.ok) return result;
  const first = result.divergences[0];
  throw new CodeReplayError(CODE_REPLAY_CODES.diverged, "The replay diverged from the recorded run", 409, {
    reason: first?.reason ?? "replay_diverged",
    turn: first?.turn ?? 0,
    ...(first?.toolCallId ? { toolCallId: first.toolCallId } : {}),
    ...(first?.expected !== undefined ? { expected: first.expected } : {}),
    ...(first?.actual !== undefined ? { actual: first.actual } : {}),
    divergences: result.divergences.length,
    comparison: result.comparison,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Live replay (best effort)
// ---------------------------------------------------------------------------------------------------------

export interface LiveReplaySourceRun {
  companyId: string;
  projectId: string;
  runId: string;
  snapshotId?: string | null;
  sessionId?: string | null;
  prompt?: string | null;
}

export interface LiveReplayDeps {
  source: LiveReplaySourceRun;
  /** Starts a **new** run, really calling the model and the tools, with the source snapshot as baseline. */
  startRun(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    session: CodeSession;
    prompt: string;
    sourceRunId: string;
    sourceSnapshotId: string | null;
  }): Promise<{ runId: string; snapshotId?: string | null; status: string; reason?: string }>;
  ctx: AuthContext;
  session: CodeSession | null;
  prompt?: string;
  /** Persists the replay record (mode and the source references). Storage of the record is a port. */
  recordReplay?(record: LiveReplayRecord): Promise<void>;
}

export interface LiveReplayRecord {
  replayId: string;
  mode: "live_best_effort";
  replayMode: "live_best_effort";
  sourceRunId: string;
  sourceSnapshotId: string | null;
  runId: string;
  snapshotId: string | null;
  requestedBy: string;
  createdAt: string;
  reproducibility: "best_effort";
  notice: string;
}

export interface LiveReplayResult extends LiveReplayRecord {
  status: string;
  reason?: string;
  attempt: number;
}

const FORBIDDEN_LIVE_WORDING = /deterministic/i;

/**
 * Guard against the one wording mistake that would mislead a user: a live replay is never deterministic.
 * It is applied to the serialised result, so a nested field cannot smuggle the word in either.
 */
export function assertNotDeterministic(value: unknown, label = "live replay result"): void {
  if (FORBIDDEN_LIVE_WORDING.test(JSON.stringify(value ?? null))) {
    throw new CodeReplayError("replay_wording_violation", `${label} must not claim deterministic replay`, 500, {
      reason: "replay_wording_violation",
    });
  }
}

export async function replayLive(deps: LiveReplayDeps): Promise<LiveReplayResult> {
  if (!deps.session) {
    throw new CodeReplayError(CODE_REPLAY_CODES.sessionUnavailable, "The source session is required", 404, {
      reason: "replay_session_unavailable",
      sessionId: deps.source.sessionId ?? null,
    });
  }
  const prompt = deps.prompt ?? deps.source.prompt ?? "";
  const started = await deps.startRun({
    ctx: deps.ctx,
    companyId: deps.source.companyId,
    projectId: deps.source.projectId,
    session: deps.session,
    prompt,
    sourceRunId: deps.source.runId,
    sourceSnapshotId: deps.source.snapshotId ?? null,
  });

  const record: LiveReplayRecord = {
    replayId: `${deps.source.runId}:live:${Date.now().toString(36)}`,
    mode: "live_best_effort",
    replayMode: "live_best_effort",
    sourceRunId: deps.source.runId,
    sourceSnapshotId: deps.source.snapshotId ?? null,
    runId: started.runId,
    snapshotId: started.snapshotId ?? null,
    requestedBy: deps.ctx.userId,
    createdAt: new Date().toISOString(),
    reproducibility: "best_effort",
    notice: LIVE_REPLAY_REPRODUCIBILITY_NOTICE,
  };
  const result: LiveReplayResult = {
    ...record,
    status: started.status,
    ...(started.reason ? { reason: started.reason } : {}),
    attempt: CODE_REPLAY_SCHEMA_VERSION,
  };
  assertNotDeterministic(result);
  await deps.recordReplay?.(record);
  return result;
}
