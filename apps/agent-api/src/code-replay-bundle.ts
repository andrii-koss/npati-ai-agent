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

export const REPLAY_BUNDLE_FORMAT_VERSION = 3;
/**
 * Version 2 (C8) added the recorded compression artifacts to the header.
 *
 * Why that is a format change and not a step: an artifact is **model-visible state**, not another exchange.
 * Replay must feed the exact recorded summary and context selection rather than recompute them, because a
 * summarizer would not produce the same text twice and the replay would then diverge at the first compaction
 * for a reason that has nothing to do with the agent. A version-1 bundle simply has no artifacts, which reads
 * as "this run did not compact", and that is the honest interpretation rather than a silent recomputation.
 *
 * Version 3 (C8, same shape, stronger meaning) makes the artifacts part of the **replay input** and not merely
 * of the header: `replayInputHash` now covers them, so a swapped or edited summary is caught by the same
 * integrity check that already protects the steps. The exact compressed context therefore travels as replay
 * input, which is what the owner asked for. The field is included **only when the run actually compacted**, so
 * a version-1/2 bundle — whose stored hash was derived from the steps alone — still verifies unchanged: the
 * hash semantics changed, and the bump is what makes that visible instead of silent.
 *
 * Version 3 is **unchanged** by C13's runtime MCP manifest, and that is a deliberate, argued decision rather
 * than an omission. The persisted shape is the same: `runtimeMcpManifest` is an optional header member that is
 * written **only when the run actually had runtime MCP tools**, exactly like `commandExpansions`. A bundle
 * without the field therefore serialises to the same header and derives the same `replayInputHash` as before
 * C13 (asserted directly: `replayInputHash(steps) === bundleHash({ steps })`), so a format bump would invalidate
 * stored bundles that are still perfectly readable — the opposite of what the version exists to protect. The
 * one thing that *did* change is the hash of a bundle that carries the field, and that is visible where it
 * matters: on the bundles that carry the new input.
 *
 * Version 3 is likewise **unchanged** by C14's provider cassette, and for the same reason. A recorded model step
 * may now carry the model's own argument **bytes** beside the argument **hash** it always carried
 * (`response.toolCalls[].arguments`, see `ReplayModelStepInput`). That field is optional and is written only
 * when the engine really returned argument text, which every engine does for a tool call, so it is present on
 * new bundles and absent on old ones. A bundle without it serialises to exactly the step it always did and
 * therefore derives the pre-C14 hash byte for byte — the pin is the C10 literal in
 * `tests/coding-agent-c10-rewind-fork.test.ts` (`sha256:579374f1…`), and
 * `tests/coding-agent-c14-replay-cassette-engine.test.ts` asserts that literal against the same fixture.
 *
 * Why record the bytes at all, when the hash was enough for verification: a **hash cannot reconstruct a tool
 * call**. The cassette (`code-replay-cassette.ts`) has to hand a consumer a `ChatResult`, whose
 * `toolCalls[].function.arguments` is a string by type; serving `""` there would hand a real run a different
 * tool call than the one that was recorded, silently. The bytes are also the **source** of the hash, through the
 * one canonical conversion below (`replayArgumentsHash`); a recording that carries none is refused by the
 * cassette (`replay_cassette_arguments_unavailable`) rather than completed with an invented call. The bytes are
 * replay **input** (they are inside the step, so they are inside `replayInputHash`) because a replay that fed
 * different arguments would reproduce a conversation the run never had — the same rule the C13 command
 * expansions follow. A secret in them is refused by the existing whole-recording scan, never stripped.
 *
 * Version 3 is **unchanged** by the C14 arguments-hash fix as well, and that is the same argued decision rather
 * than an omission (rule 13). What changed is the *material* `response.toolCalls[].argumentsHash` is derived
 * from, not the persisted shape: the recorder now derives it through `replayArgumentsHash` — the one canonical
 * conversion of the argument **value**, which is what the tool step has always hashed — instead of hashing the
 * provider's JSON **text**. The stored members are byte-for-byte the members that were stored before, so a
 * version-3 bundle keeps verifying against its own stored `replayInputHash` (`replayInputHash` itself is
 * untouched: it is a hash of the steps, and the steps' *shape* did not move), and the pre-C14 literal
 * `sha256:579374f1…` that `tests/coding-agent-c10-rewind-fork.test.ts` pins is unaffected because that fixture
 * supplies its own `argumentsHash` and carries no argument bytes. A bump would therefore invalidate stored
 * bundles that are still perfectly readable — the opposite of what the version exists to protect. The only
 * visible effect is the one the fix is for: `arguments_hash` now agrees between the model step and the tool step
 * of a runner-recorded bundle.
 *
 * **The bundles written before this fix.** Their model step holds a hash of the argument *text* while their tool
 * step holds a hash of the argument *value*, so `code-replay-engine.ts` diverged at `arguments_hash` on **every**
 * replay of a runner-recorded bundle that executed a tool — the deterministic replay of a real run did not work
 * at all. Nothing regresses by correcting the writer: those bundles were already unreplayable, and they stay
 * readable evidence (their step payloads and their `replayInputHash` are untouched, and the reader recomputes the
 * same hash). They are **not** retro-fitted: there is no second derivation, no lenient "old bundles compare
 * differently" branch, and no migration that rewrites a stored recording. A cassette still refuses a recording
 * that predates the argument bytes (`replay_cassette_arguments_unavailable`), so nothing is silently re-derived
 * for them either. `tests/coding-agent-c13-mcp-run-path.test.ts` measures both halves: a bundle the **real**
 * runner recorded replays clean, and the older mismatched pair still diverges.
 */

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
 * **The canonical tool-call arguments** — the *one* material every `argumentsHash` is derived from.
 *
 * Why this function has to exist at all, and why it is a conversion rather than a second hash. A recorded run
 * holds a tool call's arguments in two places that are written by two different parts of the loop: the model step
 * keeps the provider's own JSON **text** (`ChatToolCall.function.arguments` is a string by wire contract) and the
 * tool step keeps the **parsed object** the adapter produced and the policy/approval gate then admitted. Hashing
 * each of those with `bundleHash` directly gave two different values for one call — `bundleHash('{"path":"a"}')`
 * is not `bundleHash({ path: "a" })` — and `code-replay-engine.ts` compares the two, so a bundle written by the
 * real runner diverged at `arguments_hash` on every replay. The recorder, not the comparison, was wrong: the
 * authoritative material is the argument value, and `canonicalizeJson` (key order, `undefined`, dates) is how
 * this module already decides when two argument values are the same value. This function therefore states the
 * conversion **once**, and every writer and every reader of an `argumentsHash` goes through it.
 *
 * The rules, and why each one cannot invent a call:
 *
 *  - an object is canonicalised as it stands (recursively, by `canonicalizeJson`), so `{a:1,b:2}` and `{b:2,a:1}`
 *    are the same call — they are, and the tool received the same value;
 *  - JSON text is parsed and then canonicalised, because a provider's text and the adapter's object *are* the
 *    same argument value: `{"path":"a.txt"}` and `{ path: "a.txt" }` are two spellings of one call, and treating
 *    them as two would make a replay depend on a provider's whitespace;
 *  - text that does not parse is hashed **as text**. It is not an argument value this project can read, and the
 *    alternative — hashing it as `{}` — would make two different unreadable fragments hash identically. The
 *    adapter refuses such a call before execution (`invalid_tool_arguments`), so this branch is reachable only
 *    from a hand-written fixture or a foreign recorder; hashing what was actually stored is the honest answer;
 *  - `""`, `null` and `undefined` are the empty argument object, once, so a call that carried no arguments has
 *    exactly one hash whether it was recorded as absent, as `null`, or as empty text;
 *  - an array, a number, a boolean: canonicalised as it stands, never coerced into `{}` — the adapter refuses
 *    them, and a hash that flattened them would erase the difference between a refused call and a valid empty one.
 *
 * Nothing here is a trust decision: the value that is hashed is data, and executing it still passes the whole
 * policy/approval path.
 *
 * The return value is the **argument value**, never its serialisation: `bundleHash` canonicalises whatever it is
 * given, so handing it the canonical *text* would hash a JSON string literal (a quoted string) instead of the
 * value — a second, differently-spelled material, which is exactly the class of defect this function removes.
 */
export function canonicalReplayArguments(value: unknown): unknown {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // Not an argument value this project can read (the adapter refuses such a call before execution), so the
      // stored text is hashed as text rather than flattened into `{}` — which would erase the difference
      // between two unreadable fragments.
      return text;
    }
  }
  return value;
}

/**
 * The recorded `argumentsHash` of a tool call — the single derivation used by the recorder (model step and tool
 * step, both of which hand it a different *shape* of the same value) and by every reader that has to verify one.
 */
export function replayArgumentsHash(value: unknown): string {
  return bundleHash(canonicalReplayArguments(value));
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
    toolCalls: Array<{
      id: string;
      name: string;
      argumentsHash: string;
      /**
       * C14 (provider cassette): the model's raw argument text, exactly as the provider returned it — the value
       * `argumentsHash` is derived from. Optional and additive, so a bundle recorded before this field existed
       * keeps its exact pre-C14 bytes and hash (and the format version stays 3, see the module header).
       *
       * It is recorded because a **hash cannot reconstruct a call**: the cassette must answer a consumer's
       * `ChatResult` with a string, and inventing one would silently change the tool call. The cassette
       * therefore serves these bytes, verifies them against `argumentsHash` before it does, and refuses with
       * `replay_cassette_arguments_unavailable` when a recording predates the field.
       */
      arguments?: string;
    }>;
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

/**
 * The **replay input hash**.
 *
 * It covers the ordered steps with every `rawArtifact` removed, plus — when the run actually compacted — the
 * recorded compression artifacts, and — since C13 — any recorded **command expansions**. All three halves
 * matter for the same reason: a replay must consume exactly what the model saw. The artifacts are added **only
 * when present**, so the hash of a run that never compacted is byte-identical to the version-1/2 derivation and
 * old bundles keep verifying; a run that did compact gets a hash that a swapped or edited summary cannot
 * satisfy.
 *
 * C13 extends the same rule to slash commands. A command expansion is a **stored template**, so the persisted
 * bundle must pin the exact text the run expanded, or "replay the same run" would expand today's template and
 * reproduce a conversation that never happened. The field is added only when the run really expanded a command,
 * which is what keeps every pre-C13 bundle — whose stored hash was derived from the steps alone — verifiable
 * without a format bump. `REPLAY_BUNDLE_FORMAT_VERSION` therefore stays at 3: the **shape** of a persisted
 * bundle is unchanged (the two provenance lists are optional header members, absent for every run that does not
 * use the feature), and the hash change is visible exactly where it is meaningful, on the bundles that carry
 * the new input.
 */
export function replayInputHash(
  steps: ReplayBundleStepPayload[],
  compressionArtifacts?: readonly Record<string, unknown>[],
  commandExpansions?: readonly Record<string, unknown>[],
  runtimeMcpManifests?: readonly Record<string, unknown>[],
  completionArtifacts?: readonly Record<string, unknown>[],
): string {
  const artifacts = compressionArtifacts ?? [];
  const expansions = commandExpansions ?? [];
  const manifests = runtimeMcpManifests ?? [];
  const completions = completionArtifacts ?? [];
  const input = replayInputSteps(steps);
  if (artifacts.length === 0 && expansions.length === 0 && manifests.length === 0 && completions.length === 0) return bundleHash({ steps: input });
  return bundleHash({
    steps: input,
    ...(completions.length ? { completionArtifacts: [...completions] } : {}),
    ...(artifacts.length > 0 ? { compressionArtifacts: [...artifacts] } : {}),
    ...(expansions.length > 0 ? { commandExpansions: [...expansions] } : {}),
    // C13 (owner decision 6): the runtime MCP manifest the run was admitted under. It is replay **input** for
    // the same reason a slash-command expansion is: the tool set is dynamic, so a replay that resolved today's
    // tools would reproduce a conversation the run never had. Added only when the run had runtime MCP tools, so
    // a bundle without the field keeps the pre-C13 derivation byte for byte (and the format stays at version 3).
    ...(manifests.length > 0 ? { runtimeMcpManifests: [...manifests] } : {}),
  });
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
  /**
   * C13: the slash-command expansions that produced this run's prompt. The prompt is resolved before the first
   * model call, so the provenance is known at run start and travels with the context; it is recorded when the
   * bundle is written, and it is **replay input**, because a replay must expand the recorded version of
   * `/review` rather than whatever the repository or the user has today.
   */
  commandProvenance?: readonly Record<string, unknown>[];
  /**
   * C13 (owner decision 6): the runtime MCP manifest this run was admitted under, read from the run's
   * ExecutionSnapshot. It is optional and absent for every run that used no MCP tool, which is what keeps the
   * persisted shape (and therefore the format version) unchanged.
   */
  runtimeMcpManifest?: Readonly<Record<string, unknown>> | null;
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
  async finalize(input: {
    terminalStatus: string;
    terminalReason: string;
    /**
     * C8: the compaction artifacts produced during the run, in order. They are recorded as part of the replay
     * input so a replay replays the *model-visible* compacted context instead of recomputing a summary.
     */
    compressionArtifacts?: readonly Record<string, unknown>[];
    completionArtifacts?: readonly Record<string, unknown>[];
    /**
     * C13: the slash-command expansions this run applied, in order. Each entry pins the command's provenance
     * (`source`/`scope`/`version`/`hash`) and the `contentHash` of the exact expanded text — never the text's
     * argument values, and never a secret. Recorded for the same reason as the compaction artifacts: a stored
     * template is not a frozen input until the bundle says which version was expanded.
     */
    commandExpansions?: readonly Record<string, unknown>[];
  }): Promise<{ written: boolean; bundleId?: string; errorCode?: string }> {
    if (this.written) return { written: false, errorCode: "already_written" };
    const now = this.input.now?.() ?? new Date();
    const steps = this.orderedSteps();
    // C13: the expansions this run applied. The runner reports them at finalize time; a caller that resolved
    // them at run start (where the prompt is built) may instead publish them through the context. `finalize`
    // wins when both exist, so one expansion is never recorded twice.
    const commandExpansions = input.commandExpansions
      ? [...input.commandExpansions]
      : [...(this.input.context.commandProvenance ?? [])];
    // C13: the runtime MCP manifest, recorded only when the run really had runtime tools. `null`/absent means
    // "this run had none (or predates the feature)", which is exactly what the reader derives the hash from too.
    const runtimeMcpManifest = this.input.context.runtimeMcpManifest ?? null;
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
      // C8: the compaction artifacts are part of the header, therefore part of `payloadHash`: a rewritten
      // summary changes the bundle's own hash, so tampering is detectable rather than merely unlikely.
      compressionArtifacts: [...(input.compressionArtifacts ?? [])],
      compressionArtifactCount: input.compressionArtifacts?.length ?? 0,
      ...(input.completionArtifacts?.length ? { completionArtifacts: [...input.completionArtifacts] } : {}),
      // C13: recorded **only when the run applied one**, so a run that used no slash command has exactly the
      // header it had before this feature existed.
      ...(commandExpansions.length > 0
        ? { commandExpansions, commandExpansionCount: commandExpansions.length }
        : {}),
      // C13: the runtime MCP manifest, recorded **only when the run had one**, so a run that used no MCP tool
      // has exactly the header it had before this feature existed.
      ...(runtimeMcpManifest ? { runtimeMcpManifest } : {}),
      createdAt: now.toISOString(),
    };
    const compressionArtifacts = [...(input.compressionArtifacts ?? [])];
    try {
      // Scan the whole recording, not the header: a secret can arrive through a provider answer or a tool
      // result, and "we did not put one there" is not a guarantee.
      assertNoSecretsInReplayBundle({ header, steps });
    } catch (error) {
      this.written = true;
      throw error;
    }
    const payloadHash = bundleHash(header);
    const inputHash = replayInputHash(steps, compressionArtifacts, commandExpansions, runtimeMcpManifest ? [runtimeMcpManifest] : [], input.completionArtifacts);
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
  /**
   * C8: the recorded compression artifacts, in order. When this is non-empty the run compacted its context and
   * a replay must reuse these exact artifacts; an empty list means the run did not compact (or predates C8),
   * which reads as "no compaction to reproduce" rather than as a licence to recompute a summary.
   */
  compressionArtifacts?: Record<string, unknown>[];
  completionArtifacts?: Record<string, unknown>[];
  /**
   * C13: the recorded slash-command expansions, in order. **This is replay input, not a report**: a template is
   * versioned, so a replay must expand the recorded version (`version` + `hash`) and republish the recorded
   * `contentHash`, never resolve `/name` against whatever the repository or the user has today. An empty list
   * means the run applied no slash command (or predates C13), which reads as "there is nothing to re-expand".
   */
  commandExpansions?: Record<string, unknown>[];
  /**
   * C13 (owner decision 6): the runtime MCP manifest the run was recorded under, or `null`/absent when the run
   * had no runtime MCP tools. **This is replay input, not a report**: a replay must refuse when the current
   * runtime manifest hash differs, because otherwise it would reproduce the run against a tool set (or a tool
   * schema) the run never saw.
   */
  runtimeMcpManifest?: Record<string, unknown> | null;
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
  const completionArtifacts = Array.isArray(bundle.payload?.completionArtifacts) ? bundle.payload.completionArtifacts as Record<string, unknown>[] : [];
  const storedCount = Number(bundle.payload?.stepCount ?? steps.length);
  // C8: read straight from the persisted header. A version-1 bundle has no field here, and the honest reading
  // of that is "no recorded compaction", never "recompute one".
  const compressionArtifacts = Array.isArray(bundle.payload?.compressionArtifacts)
    ? (bundle.payload?.compressionArtifacts as Record<string, unknown>[])
    : [];
  // C13: the same reading for the command expansions. Absent means "this run applied none", and the hash is
  // derived without them — which is exactly what the writer did for that run.
  const commandExpansions = Array.isArray(bundle.payload?.commandExpansions)
    ? (bundle.payload?.commandExpansions as Record<string, unknown>[])
    : [];
  // C13: the same reading for the runtime MCP manifest. Absent means "this run had no runtime MCP tools", and
  // the hash is derived without it — exactly what the writer did for that run.
  const runtimeMcpManifest =
    bundle.payload?.runtimeMcpManifest && typeof bundle.payload.runtimeMcpManifest === "object" && !Array.isArray(bundle.payload.runtimeMcpManifest)
      ? (bundle.payload.runtimeMcpManifest as Record<string, unknown>)
      : null;
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
    // The same derivation the writer used, artifacts included: a summary that was swapped after the fact can
    // no longer pass, because it is now part of the value the stored hash covers.
    integrityFailure: bundle.replayInputHash !== replayInputHash(steps, compressionArtifacts, commandExpansions, runtimeMcpManifest ? [runtimeMcpManifest] : [], completionArtifacts),
    truncated: steps.length < storedCount,
    compressionArtifacts,
    ...(completionArtifacts.length ? { completionArtifacts } : {}),
    commandExpansions,
    runtimeMcpManifest,
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
