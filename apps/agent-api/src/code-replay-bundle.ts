import { createHash } from "node:crypto";
import type { DataClassification, RetentionClass } from "@npati/workspace";
import { scanTextForSecrets } from "./code-secret-scanner";

/**
 * C6b: versioned replay bundles.
 *
 * A snapshot explains *what* a run executed with; a bundle records *what the model actually saw*, so the run
 * can be replayed deterministically from data instead of from memory. The owner's decisions shape this module:
 *
 *  1. Replay must reproduce the **same model-visible, settled tool result** that was handed back to the model.
 *     Raw, untruncated tool output is **not** required and must not influence the replay input. A step may
 *     carry an optional `rawArtifact` reference for debugging, and it is excluded from the replay-input hash by
 *     construction (`replayInputHash` strips it) — a test asserts that changing it cannot change the input hash.
 *  2. Nothing here may leak a secret: a bundle goes through the same classification/redaction/retention rules as
 *     the rest of the data, and a secret found anywhere in it **refuses** the write instead of being silently
 *     stripped. Silent stripping would hide the leak from the caller, which is exactly the wrong outcome.
 *  3. Recording must never break a run: a failing write is logged and the run continues, exactly like the
 *     Activity sink. The bundle is evidence, not a gate.
 *
 * `bundleVersion` versions the **format**, not the run (rule 13): a persisted JSON format whose shape changes
 * without a bump is unreadable evidence.
 */

export const REPLAY_BUNDLE_FORMAT_VERSION = 1;

/** Raised instead of persisting a bundle whose recording contains a credential. */
export class ReplayBundleSecretDetectedError extends Error {
  readonly code = "replay_bundle_secret_detected";
  readonly httpStatus = 403;
  readonly details: { kinds: string[] };
  constructor(kinds: string[]) {
    super("Replay bundle refused: a secret-shaped value was found in the recorded exchange");
    this.name = "ReplayBundleSecretDetectedError";
    this.details = { kinds };
  }
}

/**
 * Canonical JSON: keys sorted, `undefined` members dropped, dates as ISO. Two structurally identical
 * recordings therefore hash identically, while any real change does not — which is what makes the
 * "replaying the same run twice yields the same input hash" property meaningful.
 */
export function canonicalizeJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      if (input instanceof Date) return input.toISOString();
      return input;
    }
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map((item) => (item === undefined ? null : walk(item)));
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries) output[key] = walk(item);
    return output;
  };
  return JSON.stringify(walk(value));
}

export function bundleHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex")}`;
}

/**
 * The **canonical settled tool result** — one function, used by the runner when it builds the message it feeds
 * back to the model. Keeping it here means the recorded value and the value the model saw cannot drift apart:
 * if they were produced by two code paths, replay would be reproducing a different conversation.
 *
 * The key order is the one this function fixes (it is the *model-visible* text, not a hash input), so the text
 * is byte-for-byte the same as before this module existed. Canonical key sorting is used for **hashes**
 * (`bundleHash`), never for what a model reads: reordering the JSON a model sees would silently change the
 * conversation the bundle is supposed to reproduce.
 */
export function canonicalizeSettledToolResult(input: {
  ok: boolean;
  tool: string;
  result?: unknown;
  truncated?: boolean;
  error?: unknown;
  /** The same limit the runner applies to tool output; the settled form is the bounded one. */
  limit: number;
}): string {
  const payload = input.ok
    ? { ok: true, tool: input.tool, result: input.result, truncated: input.truncated === true }
    : { ok: false, error: input.error };
  return boundText(JSON.stringify(payload), input.limit);
}

/** Bounds text the way the runner bounds tool output, with an explicit marker so a truncation is visible. */
export function boundText(text: string, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

// --- step shapes ---------------------------------------------------------------------------------------

export interface ReplayModelStepInput {
  turnIndex: number;
  request: {
    model: string;
    messageCount: number;
    toolNames: string[];
    idempotencyKey?: string;
    /** Recorded so a replay can prove the provider data policy context was the same. */
    dataClassification?: string;
  };
  response: {
    content: string;
    finishReason?: string | null;
    model?: string | null;
    provider?: string | null;
    usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number } | null;
    toolCalls: Array<{ id: string; name: string; argumentsHash: string }>;
  };
}

export interface ReplayToolCallStepInput {
  turnIndex: number;
  toolCallId: string;
  tool: string;
  /** Tool schema version, so a replay can tell that the tool contract itself changed. */
  toolVersion?: string | number | null;
  argumentsHash: string;
  /** The exact model-visible settled result that was appended to `messages` as the tool message. */
  settledResult: string;
  outcome: "ok" | "failed";
  errorCode?: string;
  truncated?: boolean;
  durationMs?: number;
  /**
   * Optional debugging reference for the untruncated output. It is **not** replay input: `replayInputHash`
   * removes it before hashing, and the reader ignores it when feeding a replay.
   */
  rawArtifact?: { hash: string; bytes?: number; ref?: string };
}

export interface ReplayBundleStepPayload extends Record<string, unknown> {
  kind: "model_step" | "tool_call";
  turnIndex: number;
}

/**
 * The **replay input**: the ordered steps with every `rawArtifact` removed. This is the value the replay engine
 * consumes and the value whose hash is stored, so raw output can never influence a replay.
 */
export function replayInputSteps(steps: ReplayBundleStepPayload[]): ReplayBundleStepPayload[] {
  return steps.map((step) => {
    const { rawArtifact: _rawArtifact, ...rest } = step as ReplayBundleStepPayload & { rawArtifact?: unknown };
    return rest as ReplayBundleStepPayload;
  });
}

export function replayInputHash(steps: ReplayBundleStepPayload[]): string {
  return bundleHash({ steps: replayInputSteps(steps) });
}

/** Refuse a bundle whose serialised recording contains a credential (scanned, not trusted by field list). */
export function assertNoSecretsInReplayBundle(payload: unknown): void {
  const scan = scanTextForSecrets(canonicalizeJson(payload));
  if (!scan.findings.length) return;
  const kinds = Array.from(new Set(scan.findings.map((finding) => String(finding.kind))));
  throw new ReplayBundleSecretDetectedError(kinds);
}

// --- recording -----------------------------------------------------------------------------------------

export interface ReplayBundlePersistPort {
  createReplayBundle(input: {
    workspaceId: string;
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    executionSnapshotId?: string | null;
    bundleVersion: number;
    runnerVersion?: string | null;
    systemPromptVersion?: number | null;
    systemPromptContentHash?: string | null;
    modelProfileVersion?: number | null;
    provider?: string | null;
    model?: string | null;
    replayMode: "recorded" | "live_best_effort";
    sourceRunId?: string | null;
    sourceSnapshotId?: string | null;
    terminalStatus?: string | null;
    terminalReason?: string | null;
    payload: Record<string, unknown>;
    payloadHash: string;
    replayInputHash: string;
    dataClassification?: DataClassification;
    retentionClass?: RetentionClass;
    steps: Array<{
      kind: "model_step" | "tool_call";
      turnIndex: number;
      toolCallId?: string | null;
      payload: Record<string, unknown>;
      payloadHash: string;
      createdAt?: Date;
    }>;
    now?: Date;
  }): Promise<{ id: string }>;
}

export interface ReplayBundleContext {
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  executionSnapshotId?: string | null;
  runnerVersion?: string | null;
  systemPromptVersion?: number | null;
  systemPromptContentHash?: string | null;
  modelProfileVersion?: number | null;
  provider?: string | null;
  model?: string | null;
  replayMode?: "recorded" | "live_best_effort";
  sourceRunId?: string | null;
  sourceSnapshotId?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
}

export interface ReplayBundleRecorderInput {
  store: ReplayBundlePersistPort;
  context: ReplayBundleContext;
  /** The same bound the runner applies to tool output, so settled results are recorded exactly as sent. */
  toolOutputChars: number;
  now?: () => Date;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

/**
 * Collects the exchange during a run and writes it once at the end.
 *
 * Why write once instead of step by step: the header and its steps must agree (a header claiming steps that
 * are missing is worse than no bundle), and both stores write them as a unit. Crash-time evidence is already
 * C6a's job (`code_run_states` write-ahead records), so duplicating it here would add a second, weaker source
 * of truth.
 */
export class ReplayBundleRecorder {
  private readonly modelSteps: ReplayBundleStepPayload[] = [];
  private readonly toolSteps: ReplayBundleStepPayload[] = [];
  private written = false;

  constructor(private readonly input: ReplayBundleRecorderInput) {}

  /** Records one model answer exactly as it came back (text and/or tool calls). */
  recordModelStep(step: ReplayModelStepInput): void {
    this.modelSteps.push({
      kind: "model_step",
      turnIndex: step.turnIndex,
      request: { ...step.request },
      response: { ...step.response },
    });
  }

  /** Records one tool call with the canonical settled result the model received. */
  recordToolCall(step: ReplayToolCallStepInput): void {
    const payload: ReplayBundleStepPayload = {
      kind: "tool_call",
      turnIndex: step.turnIndex,
      toolCallId: step.toolCallId,
      tool: step.tool,
      toolVersion: step.toolVersion ?? null,
      argumentsHash: step.argumentsHash,
      settledResult: step.settledResult,
      settledResultHash: bundleHash({ settled: step.settledResult }),
      outcome: step.outcome,
      ...(step.errorCode ? { errorCode: step.errorCode } : {}),
      truncated: step.truncated === true,
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      // Excluded from replay input by `replayInputSteps`; kept for debugging only.
      ...(step.rawArtifact ? { rawArtifact: step.rawArtifact } : {}),
    };
    this.toolSteps.push(payload);
  }

  /** Steps in execution order: within a turn the model step comes before the calls it produced. */
  orderedSteps(): ReplayBundleStepPayload[] {
    return [...this.modelSteps, ...this.toolSteps].sort((a, b) => {
      if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
      if (a.kind === b.kind) return 0;
      return a.kind === "model_step" ? -1 : 1;
    });
  }

  get stepCount(): number {
    return this.modelSteps.length + this.toolSteps.length;
  }

  /**
   * Writes the bundle. Never throws into the run: a bundle is evidence, and evidence failing to write must not
   * turn into a failed run. A secret, however, is not a write failure — it refuses the bundle loudly so nobody
   * mistakes a redacted-away leak for a clean recording.
   */
  async finalize(input: { terminalStatus: string; terminalReason: string }): Promise<{ written: boolean; bundleId?: string; errorCode?: string }> {
    if (this.written) return { written: false, errorCode: "already_written" };
    const now = this.input.now?.() ?? new Date();
    const steps = this.orderedSteps();
    const header = {
      bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
      runId: this.input.context.runId,
      sessionId: this.input.context.sessionId,
      executionSnapshotId: this.input.context.executionSnapshotId ?? null,
      runnerVersion: this.input.context.runnerVersion ?? null,
      systemPromptVersion: this.input.context.systemPromptVersion ?? null,
      systemPromptContentHash: this.input.context.systemPromptContentHash ?? null,
      modelProfileVersion: this.input.context.modelProfileVersion ?? null,
      provider: this.input.context.provider ?? null,
      model: this.input.context.model ?? null,
      replayMode: this.input.context.replayMode ?? ("recorded" as const),
      sourceRunId: this.input.context.sourceRunId ?? null,
      sourceSnapshotId: this.input.context.sourceSnapshotId ?? null,
      terminalStatus: input.terminalStatus,
      terminalReason: input.terminalReason,
      stepCount: steps.length,
      modelStepCount: steps.filter((step) => step.kind === "model_step").length,
      toolCallCount: steps.filter((step) => step.kind === "tool_call").length,
      createdAt: now.toISOString(),
    };
    const replayInput = replayInputSteps(steps);
    try {
      // Scan the whole recording, not the header: a secret can arrive through a provider answer or a tool
      // result, and "we did not put one there" is not a guarantee.
      assertNoSecretsInReplayBundle({ header, steps });
    } catch (error) {
      this.written = true;
      throw error;
    }
    const payloadHash = bundleHash(header);
    const inputHash = bundleHash({ steps: replayInput });
    try {
      const record = await this.input.store.createReplayBundle({
        workspaceId: this.input.context.workspaceId,
        companyId: this.input.context.companyId,
        projectId: this.input.context.projectId,
        sessionId: this.input.context.sessionId,
        runId: this.input.context.runId,
        executionSnapshotId: this.input.context.executionSnapshotId ?? null,
        bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
        runnerVersion: this.input.context.runnerVersion ?? null,
        systemPromptVersion: this.input.context.systemPromptVersion ?? null,
        systemPromptContentHash: this.input.context.systemPromptContentHash ?? null,
        modelProfileVersion: this.input.context.modelProfileVersion ?? null,
        provider: this.input.context.provider ?? null,
        model: this.input.context.model ?? null,
        replayMode: this.input.context.replayMode ?? "recorded",
        sourceRunId: this.input.context.sourceRunId ?? null,
        sourceSnapshotId: this.input.context.sourceSnapshotId ?? null,
        terminalStatus: input.terminalStatus,
        terminalReason: input.terminalReason,
        payload: header,
        payloadHash,
        replayInputHash: inputHash,
        ...(this.input.context.dataClassification ? { dataClassification: this.input.context.dataClassification } : {}),
        ...(this.input.context.retentionClass ? { retentionClass: this.input.context.retentionClass } : {}),
        steps: steps.map((step) => ({
          kind: step.kind,
          turnIndex: step.turnIndex,
          toolCallId: step.kind === "tool_call" ? String(step.toolCallId ?? "") || null : null,
          payload: step,
          payloadHash: bundleHash(step),
          createdAt: now,
        })),
        now,
      });
      this.written = true;
      return { written: true, bundleId: record.id };
    } catch (error) {
      const code = error instanceof ReplayBundleSecretDetectedError
        ? error.code
        : (error as { code?: string })?.code ?? "replay_bundle_write_failed";
      if (error instanceof ReplayBundleSecretDetectedError) {
        this.written = true;
        throw error;
      }
      this.input.logger?.warn("replay_bundle_write_failed", { code, runId: this.input.context.runId });
      return { written: false, errorCode: code };
    }
  }
}

// --- reading (the interface the replay engine consumes) ------------------------------------------------

export interface ReplayBundleReadPort {
  getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleHeaderRecord | null>;
  /**
   * C6b: by-id access, additive. A replay status endpoint and the UI know a replay id, not a run id, so the
   * same read path is exposed by id instead of every caller inventing its own store query.
   */
  getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleHeaderRecord | null>;
  listReplayBundleSteps(companyId: string, bundleId: string): Promise<Array<{
    id: string;
    seq: number;
    kind: string;
    turnIndex: number;
    toolCallId: string | null;
    payload: Record<string, unknown>;
    payloadHash: string;
  }>>;
}

/** The header fields the read path needs. A store row satisfies this structurally. */
export interface ReplayBundleHeaderRecord {
  id: string;
  companyId: string;
  runId: string;
  bundleVersion: number;
  executionSnapshotId: string | null;
  runnerVersion: string | null;
  systemPromptVersion: number | null;
  systemPromptContentHash: string | null;
  modelProfileVersion: number | null;
  provider: string | null;
  model: string | null;
  replayMode: string;
  terminalStatus: string | null;
  terminalReason: string | null;
  payload: Record<string, unknown>;
  replayInputHash: string;
}

export interface ReplayBundleReadResult {
  kind: "bundle" | "no_bundle";
  /** The run the bundle belongs to (also when it was read by id). */
  runId: string;
  bundleId?: string;
  replayMode?: string;
  /** How the run ended, straight from the header — what a status endpoint and the UI need. */
  terminalStatus?: string | null;
  terminalReason?: string | null;
  /** Ordered steps, exactly as recorded (`seq` order = executed order). */
  steps: ReplayBundleStepPayload[];
  /** The recorded replay input: steps with every `rawArtifact` removed. */
  replayInput: ReplayBundleStepPayload[];
  replayInputHash?: string;
  /** True when the stored hash does not match the recomputed one: the bundle was tampered with or truncated. */
  integrityFailure?: boolean;
  /** True when the header claims more steps than were stored (a partially written bundle). */
  truncated?: boolean;
}

/** One assembly path for every read (by run and by id), so the two can never answer differently. */
async function assembleBundleRead(
  store: ReplayBundleReadPort,
  companyId: string,
  bundle: ReplayBundleHeaderRecord | null,
  runIdFallback: string,
): Promise<ReplayBundleReadResult> {
  if (!bundle) return { kind: "no_bundle", runId: runIdFallback, steps: [], replayInput: [] };
  const rows = await store.listReplayBundleSteps(companyId, bundle.id);
  const steps = rows.map((row) => row.payload as ReplayBundleStepPayload);
  const replayInput = replayInputSteps(steps);
  const storedCount = Number(bundle.payload?.stepCount ?? steps.length);
  return {
    kind: "bundle",
    runId: bundle.runId,
    bundleId: bundle.id,
    replayMode: bundle.replayMode,
    terminalStatus: bundle.terminalStatus,
    terminalReason: bundle.terminalReason,
    steps,
    replayInput,
    replayInputHash: bundle.replayInputHash,
    integrityFailure: bundle.replayInputHash !== bundleHash({ steps: replayInput }),
    truncated: steps.length < storedCount,
  };
}

/**
 * Reads a bundle for replay. A run without a bundle is a first-class answer (`no_bundle`), not an error, for
 * exactly the reason `legacy_no_snapshot` exists: runs recorded before C6b must stay readable.
 */
export async function readReplayBundle(input: {
  store: ReplayBundleReadPort;
  companyId: string;
  runId: string;
  bundleVersion?: number;
}): Promise<ReplayBundleReadResult> {
  const bundle = await input.store.getReplayBundle(input.companyId, input.runId, input.bundleVersion);
  return assembleBundleRead(input.store, input.companyId, bundle, input.runId);
}

/**
 * Reads a bundle by replay id — the shape a status endpoint and the UI hold. Tenant-scoped through the store,
 * and an unknown or foreign id is `no_bundle` rather than an error, so it cannot become an existence oracle.
 */
export async function getReplayBundleById(input: {
  store: ReplayBundleReadPort;
  companyId: string;
  replayId: string;
}): Promise<ReplayBundleReadResult> {
  const bundle = await input.store.getReplayBundleById(input.companyId, input.replayId);
  return assembleBundleRead(input.store, input.companyId, bundle, bundle?.runId ?? "");
}

/** Model steps of a bundle, in order. */
export function replayModelSteps(steps: ReplayBundleStepPayload[]): ReplayBundleStepPayload[] {
  return steps.filter((step) => step.kind === "model_step");
}

/** Recorded settled tool results of a bundle, in order — the model-visible values a replay must feed back. */
export function replayToolResults(steps: ReplayBundleStepPayload[]): ReplayBundleStepPayload[] {
  return steps.filter((step) => step.kind === "tool_call");
}
