import type { AuthContext, CodeRunTurnRecord } from "@npati/workspace";

/**
 * C10 — the shared vocabulary of the three durable session operations: **resume**, **rewind** and **fork**.
 *
 * What this module owns, and why it is one module:
 *
 *  - the refusal vocabulary (one error class with one code → one HTTP status), so `resume`, `rewind` and `fork`
 *    cannot disagree about what `session_not_found` or `checkpoint_not_found` means;
 *  - the **operation key** rule: an operation that creates durable effects (a pre-rewind checkpoint, a new
 *    session) must be idempotent, and the cheapest honest way to get that is a caller-supplied key that defaults
 *    to a deterministic hash of the operation's own target. A retry of the *same* request therefore carries the
 *    same key without the client having to remember one, and two genuinely different rewinds never collide;
 *  - the **transcript reader**: `code_run_turns.messages` is empty by construction (the runner never writes it),
 *    so the only transcript is the C6b replay bundle. It is read here once, with the conversation cursor applied,
 *    and shaped into what a resume prompt needs — text, tool names, outcomes and settled results — bounded so one
 *    huge command output cannot become an unbounded prompt;
 *  - the **resume prompt builder**, which assembles the run's own request, the goal, the recorded transcript,
 *    the compaction summaries, the plan, the todo list and the re-checked environment. It states explicitly what
 *    it could not recover: the request when no record exists (or when the record was refused), the objective when
 *    no goal, plan or summary carried one, and every environment family the comparison could not cover.
 *
 * Nothing here mutates anything: every function is a pure transformation of values a caller already loaded.
 */

export class CodeSessionDurabilityError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeSessionDurabilityError";
    this.retryable = retryable;
  }
}

/** The actions of this surface. Named actions keep the required permission derived from the action. */
export const CODE_SESSION_DURABILITY_ACTIONS = Object.freeze({
  resume: "code.session.resume",
  rewind: "code.rewind",
  fork: "code.session.fork",
  recoveryRead: "code.recovery.read",
});

/** The feature flags of this surface: each operation has its own, because each has a different blast radius. */
export const CODE_SESSION_DURABILITY_FLAGS = Object.freeze({
  resume: "code.session_resume",
  rewind: "code.rewind",
  fork: "code.session_fork",
});

/** The statuses a resume may start from, and the ones it must refuse (with the reason it reports). */
export const RESUMABLE_RUN_STATUSES: readonly string[] = ["running", "interrupted"];

/**
 * The deterministic default operation key. Two calls with the same target and the same body therefore share one
 * key, which is what makes a retried request idempotent without the client having to invent an id — while a
 * *different* target gets a different key, so a real second rewind is not mistaken for a retry.
 */
export function defaultOperationKey(parts: ReadonlyArray<string | number | null | undefined>): string {
  const text = parts.map((part) => String(part ?? "")).join("\u0000");
  // FNV-1a, the same stable hash the project uses for payload identities: no dependency, no clock, no randomness.
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `op-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Bounds a block of text with an explicit marker, so a reader can tell "short" from "we cut it". */
export function boundedBlock(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n[... truncated at ${limit} characters ...]`, truncated: true };
}

// --- the recorded transcript -------------------------------------------------------------------------

/** One recorded model answer plus the calls it produced. `turnIndex` is the step's own index (1-based). */
export interface RecordedTurn {
  turnIndex: number;
  assistant: string | null;
  finishReason: string | null;
  toolCalls: Array<{ tool: string; outcome: string; errorCode?: string; settledResult?: string }>;
}

/** The bundle step shape this module reads. Structural, so the real reader's payload fits without a cast. */
export interface RecordedStep {
  kind: string;
  turnIndex: number;
  toolCallId?: unknown;
  tool?: unknown;
  outcome?: unknown;
  errorCode?: unknown;
  settledResult?: unknown;
  response?: Record<string, unknown> | null;
}

/**
 * Narrows one recorded step. The payload comes from a JSONB column, so its shape is checked rather than
 * asserted: a bundle written by an older format version must degrade into "this step says nothing I can use",
 * never into a crash while building a recovery prompt.
 */
export function readRecordedStep(value: unknown): RecordedStep | null {
  if (!value || typeof value !== "object") return null;
  const shaped = value as Record<string, unknown>;
  const kind = typeof shaped.kind === "string" ? shaped.kind : null;
  const turnIndex = Number(shaped.turnIndex);
  if (!kind || !Number.isFinite(turnIndex)) return null;
  const response = shaped.response && typeof shaped.response === "object"
    ? (shaped.response as Record<string, unknown>)
    : null;
  return {
    kind,
    turnIndex,
    toolCallId: shaped.toolCallId,
    tool: shaped.tool,
    outcome: shaped.outcome,
    errorCode: shaped.errorCode,
    settledResult: shaped.settledResult,
    response,
  };
}

/**
 * Groups recorded steps into turns and applies the conversation cursor. Steps are already in execution order, so
 * grouping must not reorder them; a turn **after** the cursor is dropped, because a rewound conversation is
 * defined as "the turns up to the cursor" and re-admitting a later turn would silently undo the rewind.
 */
export function groupRecordedTurns(steps: readonly unknown[], options: { upToTurn?: number | null } = {}): RecordedTurn[] {
  const upTo = options.upToTurn === null || options.upToTurn === undefined ? null : Number(options.upToTurn);
  const turns = new Map<number, RecordedTurn>();
  for (const value of steps) {
    const step = readRecordedStep(value);
    if (!step) continue;
    const turnIndex = step.turnIndex;
    if (upTo !== null && Number.isFinite(upTo) && turnIndex > upTo) continue;
    const existing = turns.get(turnIndex) ?? { turnIndex, assistant: null, finishReason: null, toolCalls: [] };
    if (step.kind === "model_step") {
      const response = step.response ?? {};
      existing.assistant = typeof response.content === "string" ? response.content : existing.assistant;
      if (typeof response.finishReason === "string") existing.finishReason = response.finishReason;
    } else {
      existing.toolCalls.push({
        tool: typeof step.tool === "string" ? step.tool : "unknown",
        outcome: typeof step.outcome === "string" ? step.outcome : "unknown",
        ...(typeof step.errorCode === "string" ? { errorCode: step.errorCode } : {}),
        ...(typeof step.settledResult === "string" ? { settledResult: step.settledResult } : {}),
      });
    }
    turns.set(turnIndex, existing);
  }
  return [...turns.values()].sort((a, b) => a.turnIndex - b.turnIndex);
}

/** A screen of the transcript, bounded: the prompt is provider-bound content, so it has a size ceiling. */
export interface ResumeTranscript {
  turns: RecordedTurn[];
  /** The highest turn actually included, so the caller can report where the transcript ends. */
  lastTurn: number | null;
  turnsOmitted: number;
}

export function boundTranscript(turns: readonly RecordedTurn[], limit: number): ResumeTranscript {
  const budget = Math.max(0, limit);
  const kept: RecordedTurn[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    const cost = renderTurn(turn).length;
    if (used + cost > budget && kept.length > 0) break;
    kept.push(turn);
    used += cost;
  }
  kept.reverse();
  return {
    turns: kept,
    lastTurn: kept.length ? kept[kept.length - 1]!.turnIndex : null,
    turnsOmitted: Math.max(0, turns.length - kept.length),
  };
}

/** Renders one turn. Metadata plus the model-visible settled result; never a raw file body of its own. */
export function renderTurn(turn: RecordedTurn): string {
  const lines: string[] = [];
  if (turn.assistant) lines.push(`assistant: ${turn.assistant}`);
  for (const call of turn.toolCalls) {
    const status = call.outcome === "ok" ? "ok" : `failed:${call.errorCode ?? "error"}`;
    lines.push(`tool ${call.tool} -> ${status}`);
    if (call.settledResult) lines.push(indent(call.settledResult, "    "));
  }
  return lines.join("\n");
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

// --- the resume prompt --------------------------------------------------------------------------------

export interface ResumePlanView {
  revision: number;
  status: string;
  executionMode: string | null;
  files: readonly string[];
  steps: readonly string[];
  risks: readonly string[];
  testStrategy: string;
}

export interface ResumeTodoView {
  taskId: string;
  content: string;
  status: string;
}

export interface ResumeSummaryView {
  turnIndex: number;
  summaryText: string;
  createdAt: Date;
}

export interface ResumeNoticeView {
  reason: string;
  lastFinishedTurn: number;
  messageForModel: string;
  unknownOutcome: Array<{ toolCallId: string; tool: string }>;
}

export interface ResumePromptInput {
  sessionId: string;
  runId: string;
  /** The projection the prompt is bounded to: the whole prompt may not exceed this many characters. */
  promptChars: number;
  transcriptChars: number;
  summaryChars: number;
  lastFinishedTurn: number;
  headTurn: number | null;
  transcript: ResumeTranscript;
  summaries: readonly ResumeSummaryView[];
  plan: ResumePlanView | null;
  todos: readonly ResumeTodoView[];
  notice: ResumeNoticeView | null;
  lostProcesses: ReadonlyArray<{ toolCallId: string; tool: string }>;
  /** The task text, when a goal row or a session summary recorded one. `null` means "not recorded". */
  objective: string | null;
  /**
   * C10: the run's **own** request, recorded when the run was created. When it is available the prompt quotes it
   * verbatim and says so; when it is not, the prompt states the reason instead of implying the objective is a
   * quotation of it. Optional so a caller that has no request reader keeps the previous behaviour exactly.
   */
  request?: ResumeRequestView | null;
  /**
   * The session mode in force. A resume continues the **same session**, so the mode is not reconstructed from
   * the transcript — it is read from the session row that every later turn is governed by, and stated here so
   * the model is not left guessing which of plan/edit/auto/full_auto the continuation runs under.
   */
  sessionMode?: string | null;
  /**
   * C10: the environment changes found by re-checking the run's snapshot against the effective environment.
   * Rendered so a continuation is never silently run in an environment that moved under it.
   */
  environmentChange?: ResumeEnvironmentChangeView | null;
  /**
   * C9: the answer the user gave to a question the run paused on, when the resume is the continuation of that
   * pause. It travels as the user's turn, because it *is* the user's turn.
   */
  answeredQuestion?: { questionId: string; answer: string | null; answeredBy: string } | null;
}

/**
 * C10 (Question 2): what a resume found when it re-read the environment. `changes` are the store's own
 * content-safe diff entries, restricted to the fields that describe the environment (never the ones that only
 * describe the recording, such as the snapshot's creation time).
 */
export interface ResumeEnvironmentChangeView {
  /** True when the resume created a **new** snapshot version for the continuation. */
  captured: boolean;
  snapshotId: string | null;
  snapshotVersion: number | null;
  previousSnapshotId: string | null;
  previousVersion: number | null;
  /** The value families that moved, as short secret-free strings. */
  changes: Array<{ field: string; from: string; to: string }>;
  /**
   * The verdict of the C1b admission policy on the sandbox image the run was admitted with. It is a verdict and
   * not a diff (see `RESUME_ENVIRONMENT_DIFF_FAMILIES`), and `revoked` is the one change that stops a resume.
   */
  image: { status: "admitted" | "revoked" | "unknown"; digest: string | null; replacement: string | null; reason: string } | null;
  /** The families the comparison could not cover, with the reason. Never silently "unchanged". */
  notCompared: Array<{ family: string; reason: string }>;
  /** True when the change stops the continuation (a revoked sandbox image). */
  blocking: boolean;
  reason: string | null;
}

export interface ResumePrompt {
  prompt: string;
  truncated: boolean;
  sections: string[];
  /** The blocks that were actually available. A reader can see what the reconstruction was built from. */
  sources: {
    transcript: number;
    summaries: number;
    plan: boolean;
    todos: number;
    notice: boolean;
    objective: boolean;
    /** C10: whether the run's own request was quoted. */
    request: boolean;
  };
}

/**
 * Builds the continuation prompt.
 *
 * The sections are deliberately ordered by authority: the data invariant and the recovery notice come first
 * (what must not be trusted and what is in doubt), then the goal, then the recorded conversation, then the
 * derived context. A summary or a repository-derived value never appears with the authority of the system's own
 * rules — the same boundary the C8 prompt builder draws.
 */
export function buildResumePrompt(input: ResumePromptInput): ResumePrompt {
  const sections: string[] = [];
  const lines: string[] = [];
  const request = input.request ?? null;

  lines.push(
    "This coding session is being RESUMED after the server or the browser went away.",
    `Session: ${input.sessionId}. Run: ${input.runId}. Last completed turn: ${input.lastFinishedTurn}.`,
    "The transcript below is reconstructed from the durable recording of this run.",
  );
  /**
   * C10: what is said about the original request now depends on whether it was recorded — and the wording never
   * claims either way on behalf of the other case. Before this step the sentence was unconditionally "the
   * original request text was never stored", which was true then and would be a lie after C10.
   */
  if (request?.available) {
    lines.push(
      "The original request is quoted verbatim below: it is the user's own text, recorded when the run was",
      "created, not a summary.",
    );
  } else {
    lines.push(
      "The original request text was not recorded for this run"
      + (request?.reason === "request_refused_credential"
        ? " because the record of it was refused (it looked like it carried a credential)."
        : request?.reason === "request_record_unavailable"
          ? " because the record could not be read."
          : "."),
      "so the objective below is what the plan, the goal or a compaction summary recorded — not a quotation.",
    );
  }
  if (input.headTurn !== null) {
    lines.push(`A conversation rewind is in force: turns after ${input.headTurn} are not part of this conversation.`);
  }
  sections.push("recovery");

  /**
   * The run's own request, placed directly after the recovery header and before everything derived: it is the
   * highest-authority statement of what the work is, and a reader must not have to reach it through a summary.
   */
  if (request?.available && request.text) {
    lines.push(
      "",
      "=== Original request (verbatim, recorded when the run was created) ===",
      request.text,
      ...(request.truncated ? ["[the request above was truncated when it was recorded]"] : []),
    );
    sections.push("request");
  }

  if (input.sessionMode) {
    lines.push(
      "",
      "=== Mode and rules ===",
      `Session mode: ${input.sessionMode}.`,
      "Permissions, approval rules and the provider data policy are resolved again for every call by the policy",
      "engine: they are never carried by this transcript and must not be assumed from it.",
    );
    sections.push("mode");
  }

  if (input.environmentChange
    && (input.environmentChange.changes.length
      || input.environmentChange.notCompared.length
      || (input.environmentChange.image !== null && input.environmentChange.image.status !== "admitted"))) {
    lines.push(
      "",
      "=== Environment change since this run was admitted ===",
      input.environmentChange.captured
        ? `A new execution snapshot (version ${input.environmentChange.snapshotVersion ?? "unknown"}) records the environment this continuation runs in.`
        : "The environment could not be re-recorded; the comparison below is what could be established.",
    );
    for (const change of input.environmentChange.changes) {
      lines.push(`- ${change.field}: ${change.from} -> ${change.to}`);
    }
    if (input.environmentChange.image && input.environmentChange.image.status !== "admitted") {
      const image = input.environmentChange.image;
      lines.push(
        image.status === "revoked"
          ? `- sandbox image ${image.digest ?? "unknown"}: REVOKED (${image.reason})${image.replacement ? `; a replacement is available: ${image.replacement}` : ""}`
          : `- sandbox image ${image.digest ?? "unknown"}: could not be confirmed as admitted (${image.reason})`,
      );
    }
    for (const missing of input.environmentChange.notCompared) {
      lines.push(`- ${missing.family}: not compared (${missing.reason})`);
    }
    lines.push(
      input.environmentChange.blocking
        ? "This change stops the continuation until it is resolved."
        : "Continue under the CURRENT values above; do not assume the environment this run started in.",
    );
    sections.push("environment");
  }

  if (input.notice) {
    lines.push(
      "",
      "=== Recovery notice (what the recovery was in doubt about) ===",
      `Reason: ${input.notice.reason}. Last completed turn: ${input.notice.lastFinishedTurn}.`,
      input.notice.messageForModel,
    );
    sections.push("notice");
  }

  if (input.lostProcesses.length) {
    lines.push(
      "",
      "=== Lost processes ===",
      "The following calls were in flight when the process died. Their results are UNKNOWN and their processes",
      "are GONE: they must not be assumed to have finished, and they must not be repeated blindly.",
      ...input.lostProcesses.map((entry) => `- ${entry.tool} (${entry.toolCallId}): lost`),
    );
    sections.push("lost_processes");
  }

  lines.push("", "=== Objective ===");
  lines.push(input.objective ?? "(not recorded: no goal, plan or summary carried one)");
  sections.push("objective");

  lines.push("", "=== Recorded transcript (oldest first) ===");
  if (!input.transcript.turns.length) {
    lines.push("(no recorded turn is available for this run)");
  } else {
    if (input.transcript.turnsOmitted > 0) {
      lines.push(`[${input.transcript.turnsOmitted} earlier turn(s) omitted to bound this prompt]`);
    }
    for (const turn of input.transcript.turns) {
      lines.push(`--- turn ${turn.turnIndex} ---`);
      lines.push(renderTurn(turn));
    }
  }
  sections.push("transcript");

  if (input.summaries.length) {
    lines.push("", "=== Earlier context (recorded compaction summaries, newest first) ===");
    for (const summary of input.summaries) {
      const bounded = boundedBlock(summary.summaryText, input.summaryChars);
      lines.push(`--- summary at turn ${summary.turnIndex} ---`);
      lines.push(bounded.text);
    }
    sections.push("summaries");
  }

  if (input.plan) {
    lines.push(
      "",
      "=== Session plan ===",
      `revision ${input.plan.revision}, status ${input.plan.status}, execution mode ${input.plan.executionMode ?? "not recorded"}`,
    );
    if (input.plan.files.length) lines.push("files:", ...input.plan.files.map((file) => `- ${file}`));
    if (input.plan.steps.length) lines.push("steps:", ...input.plan.steps.map((step, index) => `${index + 1}. ${step}`));
    if (input.plan.risks.length) lines.push("risks:", ...input.plan.risks.map((risk) => `- ${risk}`));
    if (input.plan.testStrategy) lines.push(`test strategy: ${input.plan.testStrategy}`);
    sections.push("plan");
  }

  if (input.todos.length) {
    lines.push("", "=== Task list ===", ...input.todos.map((todo) => `- [${todo.status}] ${todo.taskId}: ${todo.content}`));
    sections.push("todos");
  }

  if (input.answeredQuestion) {
    lines.push(
      "",
      "=== The question you were paused on ===",
      `Question ${input.answeredQuestion.questionId} was answered by ${input.answeredQuestion.answeredBy}:`,
      input.answeredQuestion.answer ?? "(the answer was recorded without a text value)",
    );
    sections.push("answered_question");
  }

  lines.push(
    "",
    "Continue from the last completed turn. Do not repeat a call whose result is unknown; inspect the workspace",
    "first. State what you are about to do before you do it.",
  );

  const joined = lines.join("\n");
  const bounded = boundedBlock(joined, input.promptChars);
  return {
    prompt: bounded.text,
    truncated: bounded.truncated,
    sections,
    sources: {
      transcript: input.transcript.turns.length,
      summaries: input.summaries.length,
      plan: input.plan !== null,
      todos: input.todos.length,
      notice: input.notice !== null,
      objective: input.objective !== null,
      request: request?.available === true,
    },
  };
}

// --- rewind target resolution -------------------------------------------------------------------------

/**
 * The checkpoint a rewind to a turn must restore.
 *
 * A turn's checkpoint is the state *before* that turn wrote anything, which is what the runner records in
 * `code_run_turns.checkpoint_id` (C10 gave that column its writer). A turn that wrote nothing has no checkpoint
 * of its own, and the honest answer is not "the turn you asked for, approximately": it is the exact turn, plus
 * the nearest **earlier** turn that does have one, so the caller can choose. Guessing would silently roll the
 * workspace back further than the caller asked for.
 */
export interface RewindTurnTarget {
  turnIndex: number;
  checkpointId: string | null;
  nearestEarlierTurn: { turnIndex: number; checkpointId: string } | null;
}

export function resolveRewindTurnTarget(turns: readonly CodeRunTurnRecord[], turnIndex: number): RewindTurnTarget {
  const exact = turns.find((turn) => turn.turnIndex === turnIndex) ?? null;
  const earlier = turns
    .filter((turn) => turn.turnIndex < turnIndex && typeof turn.checkpointId === "string" && turn.checkpointId)
    .sort((a, b) => b.turnIndex - a.turnIndex)[0] ?? null;
  return {
    turnIndex,
    checkpointId: exact?.checkpointId ?? null,
    nearestEarlierTurn: earlier && earlier.checkpointId
      ? { turnIndex: earlier.turnIndex, checkpointId: earlier.checkpointId }
      : null,
  };
}

/**
 * C10: the run's **original request** as the resume surface reports it.
 *
 * `available: false` always carries a reason, and the three reasons are deliberately different facts:
 *
 *   - `request_not_recorded` — the run has no recorded request. Either it predates C10's request recording or its
 *     caller supplied no prompt. The distinction matters to an operator, but not to the model: in both cases the
 *     honest statement is "this is not available", and inventing a paraphrase would be worse than saying so.
 *   - `request_refused_credential` — a request was offered and was deliberately **not** stored, because it
 *     looked like it carried a credential. The value never reached disk, so there is nothing to hand back; the
 *     fact that a record was refused is what keeps "we refused to store it" distinguishable from "there was
 *     none".
 *   - `request_record_unavailable` — the read itself failed. This is not evidence about the request at all, so
 *     it is never reported as "not recorded": a store outage must not turn into a claim about the content.
 */
export type ResumeRequestUnavailableReason =
  | "request_not_recorded"
  | "request_refused_credential"
  | "request_record_unavailable";

export interface ResumeRequestView {
  available: boolean;
  /** The verbatim text; `null` whenever `available` is false. */
  text: string | null;
  reason: ResumeRequestUnavailableReason | null;
  /** True when the stored text is a bounded prefix; the marker is part of the text, so this is a summary. */
  truncated: boolean;
  /** sha256 of the stored text, so a caller can prove the quotation is the recorded bytes. */
  sha256: string | null;
  recordedAt: Date | null;
}

/**
 * Maps a stored request record onto the view. One mapping for the whole surface, so the prompt, the API response
 * and the tests cannot tell three different stories about the same record.
 */
export function toResumeRequestView(
  record: { status: string; text: string | null; sha256: string | null; truncated: boolean; recordedAt: Date | null } | null,
  options: { readFailed?: boolean } = {},
): ResumeRequestView {
  if (options.readFailed === true) {
    return { available: false, text: null, reason: "request_record_unavailable", truncated: false, sha256: null, recordedAt: null };
  }
  if (!record) {
    return { available: false, text: null, reason: "request_not_recorded", truncated: false, sha256: null, recordedAt: null };
  }
  if (record.status === "refused_credential") {
    return { available: false, text: null, reason: "request_refused_credential", truncated: false, sha256: null, recordedAt: null };
  }
  if (record.status !== "recorded" || typeof record.text !== "string") {
    return { available: false, text: null, reason: "request_not_recorded", truncated: false, sha256: null, recordedAt: null };
  }
  return {
    available: true,
    text: record.text,
    reason: null,
    truncated: record.truncated === true,
    sha256: record.sha256,
    recordedAt: record.recordedAt,
  };
}

/** The request body a rewind accepts, validated into a decidable shape. */export interface RewindRequest {
  target: "code" | "conversation" | "both";
  runId: string | null;
  turnIndex: number | null;
  checkpointId: string | null;
  operationId: string | null;
  expectedRevision: number | null;
}

export function readRewindRequest(body: unknown): RewindRequest {
  const shaped = (body ?? {}) as Record<string, unknown>;
  const target = shaped.target === undefined ? null : String(shaped.target);
  if (target !== "code" && target !== "conversation" && target !== "both") {
    throw new CodeSessionDurabilityError("invalid_arguments", "target must be one of code, conversation, both", 400, {
      field: "target",
      allowed: ["code", "conversation", "both"],
    });
  }
  const rawTurn = shaped.turnIndex;
  let turnIndex: number | null = null;
  if (rawTurn !== undefined && rawTurn !== null && rawTurn !== "") {
    const numeric = Number(rawTurn);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new CodeSessionDurabilityError("invalid_arguments", "turnIndex must be a non-negative number", 400, { field: "turnIndex" });
    }
    turnIndex = Math.trunc(numeric);
  }
  const checkpointId = shaped.checkpointId === undefined || shaped.checkpointId === null || shaped.checkpointId === ""
    ? null
    : String(shaped.checkpointId);
  if (turnIndex === null && checkpointId === null) {
    throw new CodeSessionDurabilityError("invalid_arguments", "Provide turnIndex or checkpointId", 400, {
      fields: ["turnIndex", "checkpointId"],
    });
  }
  const runId = shaped.runId === undefined || shaped.runId === null || shaped.runId === "" ? null : String(shaped.runId);
  const operationId = shaped.operationId === undefined || shaped.operationId === null || shaped.operationId === ""
    ? null
    : String(shaped.operationId);
  const rawRevision = shaped.expectedRevision;
  let expectedRevision: number | null = null;
  if (rawRevision !== undefined && rawRevision !== null && rawRevision !== "") {
    const numeric = Number(rawRevision);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new CodeSessionDurabilityError("invalid_arguments", "expectedRevision must be a non-negative number", 400, { field: "expectedRevision" });
    }
    expectedRevision = Math.trunc(numeric);
  }
  return { target, runId, turnIndex, checkpointId, operationId, expectedRevision };
}

/** The recovery-notice view a route returns: the stored row, rebuilt from named fields only. */
export function toNoticeView(record: {
  runId: string;
  reason: string;
  lastFinishedTurn: number;
  replayedReadOnly: Array<{ toolCallId: string; tool: string; replayed: boolean }>;
  unknownOutcome: Array<{ toolCallId: string; tool: string }>;
  workspaceDiff: Record<string, unknown> | null;
  messageForModel: string;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    runId: record.runId,
    reason: record.reason,
    lastFinishedTurn: record.lastFinishedTurn,
    replayedReadOnlyToolCalls: record.replayedReadOnly,
    unknownOutcomeToolCalls: record.unknownOutcome,
    workspaceDiff: record.workspaceDiff,
    messageForModel: record.messageForModel,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Every durability operation reports the caller it acted for; this is the one place that reads it. */
export function actorOf(ctx: AuthContext): string {
  return String(ctx.userId ?? "unknown");
}
