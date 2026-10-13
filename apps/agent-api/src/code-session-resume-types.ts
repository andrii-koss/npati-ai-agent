import type { AuthContext, CodeRunRequestRecord, CodeRunTurnRecord, CodeSession, ExecutionSnapshotRecord } from "@npati/workspace";
import type {
  CodeRunBoundary,
  CodeRunStateLog,
} from "./code-run-state";
import {
  CodeSessionDurabilityError,
  type ResumeEnvironmentChangeView,
  type ResumeNoticeView,
  type ResumePlanView,
  type ResumePrompt,
  type ResumeRequestUnavailableReason,
  type ResumeRequestView,
  type ResumeTodoView,
} from "./code-session-durability";
import type { ResumeEnvironmentAdmission } from "./execution-snapshot";

export const DEFAULT_PROMPT_CHARS = 24_000;
export const DEFAULT_TRANSCRIPT_CHARS = 16_000;
export const DEFAULT_SUMMARY_CHARS = 2_000;
export const MAX_SUMMARIES = 3;

/** Tools whose unknown outcome means a *process* may have been alive when the host went away. */
export const PROCESS_TOOLS: ReadonlyArray<string> = [
  "code.shell.exec",
  "code.shell.process.start",
  "code.deps.add",
  "code.deps.install",
  "code.deps.update",
  "code.deps.remove",
  "code.verify.run",
];

export function isProcessTool(tool: string): boolean {
  return PROCESS_TOOLS.includes(tool);
}

/** Turns the C6a refusal vocabulary into this surface's refusal vocabulary. */
export function refusalError(refusal: "waiting_for_user" | "terminal" | "not_found"): CodeSessionDurabilityError {
  if (refusal === "not_found") return new CodeSessionDurabilityError("run_not_found", "Run not found", 404, {});
  if (refusal === "waiting_for_user") {
    // A pause is not an interruption: the answer is what resumes this run (C9), and answering moves the run out
    // of `waiting_for_user` on its own. Resuming here would run past the question and orphan that answer.
    return new CodeSessionDurabilityError(
      "run_waiting_for_user",
      "The run is waiting for an answer to a question; answer it instead of resuming",
      409,
      { hint: "answer the pending question; the answer releases the run" },
      false,
    );
  }
  return new CodeSessionDurabilityError(
    "run_not_resumable",
    "The run is in a terminal state; continuing it would need a new run id, which cannot carry this run's recording",
    409,
    { hint: "start a new run for new work in this session" },
    false,
  );
}

/**
 * C10: reads the sandbox-image verdict out of a resume snapshot's own payload.
 *
 * The verdict is a fact the *source* produced when the snapshot was assembled, so it travels inside the payload
 * like every other environment fact — there is no second channel and no query at resume time. Anything that is
 * not the explicit `revoked` status is not a revocation: `unknown` is a warning (the catalogue could not be
 * read), never a stop.
 */
export function readImageVerdict(
  payload: Record<string, unknown>,
): { status: "admitted" | "revoked" | "unknown"; digest: string | null; replacement: string | null; reason: string } | null {
  const fact = payload?.sandboxImage;
  if (!fact || typeof fact !== "object") return null;
  const shaped = fact as Record<string, unknown>;
  const status = shaped.status === "revoked" ? "revoked" : shaped.status === "admitted" ? "admitted" : "unknown";
  return {
    status,
    digest: typeof shaped.recordedDigest === "string" ? shaped.recordedDigest : null,
    replacement: typeof shaped.replacement === "string" ? shaped.replacement : null,
    reason: typeof shaped.reason === "string" && shaped.reason ? shaped.reason : "image_status_unknown",
  };
}

export interface CodeSessionResumeRequest {
  /** Internal controller's unique lease identity; public resume routes never copy this argument. */
  owner?: string;
  ctx: AuthContext;
  companyId: string;
  sessionId: string;
  /** The run to continue. Optional: without it the session's own `run_id` is used, which is what C10 wrote. */
  runId?: string | null;
  /** The run-state revision the caller read; a stale value refuses instead of acting on a moved run. */
  expectedRevision?: number | null;
  /** C9: the question the user answered, so the answer enters the continuation prompt. */
  questionId?: string | null;
  /** Explicit, never implicit: restoring the workspace discards whatever is not committed. */
  restoreWorkspace?: boolean;
}

export interface CodeSessionResumeLostProcess {
  toolCallId: string;
  tool: string;
  /** `unknown_outcome_after_restart` — the result was never observed; the process died with its host. */
  reason: string;
  /** True when the call starts a process or a command rather than editing a file. */
  process: boolean;
}

export interface CodeSessionResumeResultView {
  status: "resumed" | "already_resumed";
  sessionId: string;
  projectId: string;
  runId: string;
  runStatus: string;
  runRevision: number;
  lease: { held: boolean };
  boundary: {
    lastFinishedTurn: number;
    incompleteTurn: number | null;
    unknownOutcomeCalls: number;
    replayableReadOnlyCalls: number;
  };
  lostProcesses: CodeSessionResumeLostProcess[];
  unknownOutcomeToolCalls: Array<{ toolCallId: string; tool: string }>;
  forfeitedProcesses: string[];
  checkpoint: { checkpointId: string | null; turnIndex: number | null; source: "last_finished_turn" | "earlier_turn" | "none" };
  workspace: { attached: boolean | null; reason?: string; restored: boolean; restoreReason?: string; safetyCheckpointId?: string | null };
  sessionRunLink: { linked: boolean; reason?: string };
  /**
   * The conversation cursor in force for the session, read only. `null` means "no rewind is in force", which is
  * the state of every session that was never rewound — a resume never writes this cursor, because truncating the
   * conversation at the last finished turn would amputate every turn a continuing run produces after it.
   */
  conversationHead: { created: boolean; turnIndex: number; revision: number } | null;
  notice: Record<string, unknown> | null;
  history: {
    source: "replay_bundle" | "run_state" | "none";
    turns: number;
    summaries: number;
    planRevision: number | null;
    todos: number;
    notice: boolean;
    answeredQuestion: boolean;
    /** C10: whether the run's own request was quoted into the prompt. */
    request: boolean;
  };
  /**
   * C10: the run's own request, recovered from the run row. `requestUnavailable` is the honest answer when it is
   * not there — one of `request_not_recorded`, `request_refused_credential`, `request_record_unavailable` — and
   * it is `null` exactly when the text below is the recorded request.
   */
  request: ResumeRequestView;
  requestUnavailable: ResumeRequestUnavailableReason | null;
  /** C10 (Question 2): what the environment re-check found, and the new snapshot it recorded. */
  environment: ResumeEnvironmentChangeView;
  resumePrompt: string;
  resumePromptChars: number;
  resumePromptTruncated: boolean;
  resumePromptHash: string;
  resumePromptSections: string[];
}

export interface CodeSessionResumeNoticeRow {
  runId: string;
  reason: string;
  lastFinishedTurn: number;
  replayedReadOnly: Array<{ toolCallId: string; tool: string; replayed: boolean }>;
  unknownOutcome: Array<{ toolCallId: string; tool: string }>;
  workspaceDiff: Record<string, unknown> | null;
  messageForModel: string;
  createdAt: Date;
}

export interface CodeSessionResumeAnsweredQuestion {
  questionId: string;
  sessionId: string;
  runId: string;
  status: string;
  answer: { choiceId?: string; freeAnswer?: string } | null;
  answeredBy: string | null;
}

export interface CodeSessionResumeDeps {
  flags: { assertEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string }): Promise<unknown> };
  sessions: { get(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> };
  /** The C6a log: the lease, the run state and the turn boundary. */
  runState: Pick<CodeRunStateLog, "loadRunState" | "loadTurnBoundary" | "startRun" | "resumeRun">;
  store: {
    getCodeSessionHead(companyId: string, sessionId: string): Promise<{ turnIndex: number; revision: number; runId: string | null } | null>;
    setCodeSessionHead(input: {
      companyId: string;
      projectId: string;
      sessionId: string;
      runId?: string | null;
      turnIndex: number;
      reason: "resume";
      operationId?: string | null;
      expectedRevision: number;
      createdBy?: string | null;
    }): Promise<{ turnIndex: number; revision: number }>;
    getLatestCodeRunRecoveryNotice(companyId: string, runId: string): Promise<CodeSessionResumeNoticeRow | null>;
    listCodeContextSummaries(input: { companyId: string; sessionId?: string; runId?: string; limit?: number }): Promise<Array<{ turnIndex: number; summaryText: string; createdAt: Date }>>;
    listCodeGoals(input: { companyId: string; sessionId?: string; limit?: number }): Promise<Array<{ objective: string; status: string }>>;
    getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<{
      revision: number; status: string; executionMode?: string | null;
      plan: { files: readonly string[]; steps: readonly string[]; risks: readonly string[]; testStrategy: string };
    } | null>;
    listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<Array<{ taskId: string; content: string; status: string }>>;
    listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]>;
    /**
     * C10: the run's original request, recorded when the run was created. Tenant-scoped, and `null` only when the
     * run row does not exist — a run whose request was never recorded answers with a record whose `status` says
     * so, which is what lets the surface distinguish "not recorded" from "the read failed".
     */
    getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null>;
  };
  /** C6b: the recorded transcript. `null` means the run has no bundle (recorded before C6b). */
  transcript?: (input: { ctx: AuthContext; companyId: string; runId: string }) => Promise<{ steps: readonly unknown[] } | null>;
  /** C9: the question the caller named, with the answer the user gave. */
  questions?: {
    get(companyId: string, questionId: string): Promise<CodeSessionResumeAnsweredQuestion | null>;
  };
  /**
   * C10 (Question 2): the environment re-check. It reads the snapshot the run was admitted under, records a NEW
   * version with `trigger: "resume"` from the facts a resume can genuinely re-read, and hands back the store's
   * own content-safe diff. Optional: a deployment without it reports the check as not performed, with the
   * reason — never as "nothing changed".
   */
  environment?: ResumeEnvironmentAdmission;
  /**
   * Processes the process-local registry still claims. Optional: after a restart this is empty, and the durable
   * evidence above is what names the lost work. When it is wired, anything it still holds for the session is
   * forfeited — a resumed run must not inherit a process nobody is driving.
   */
  processes?: {
    forfeit(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string; reason: string }): Promise<{
      forfeited: string[];
      failed: Array<{ processId: string; reason: string }>;
    }>;
  };
  checkpoints?: {
    restore(input: { ctx: AuthContext; companyId: string; projectId: string; checkpointId: string }): Promise<{
      restoredCheckpointId: string;
      safetyCheckpointId?: string | null;
    }>;
  };
  workspace?: {
    ensure(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string }): Promise<{ ready: boolean; reason?: string }>;
  };
  /** The session→run link: a resume repairs it too, because that link is how the next resume finds the run. */
  linkRun?: (input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string; runId: string }) => Promise<{ linked: boolean; reason?: string }>;
  activity?: {
    record(event: {
      kind: "run_reconcile";
      companyId: string;
      projectId: string;
      sessionId: string;
      runId: string;
      reason: string;
      lastFinishedTurn?: number;
      unknownOutcomeToolCalls?: number;
    }): Promise<void>;
  };
  /**
   * N1: the inbox task of the resumed session, when the durable inbox is wired.
   *
   * A resume takes the run's C6a lease and **hands the continuation prompt back** to its caller; it does not
   * drive the loop. Leaving the inbox saying "this run is driving" therefore closed the session against the very
   * continuation the resume had just prepared, until the 60 s lease expired. The port lets the resume record the
   * same yield a pause records, so the next run id may take the session immediately. Optional: a deployment
   * without the inbox keeps the old behaviour, and the marker is only ever a permission to proceed, never a
   * grant.
   */
  inbox?: {
    yieldTask(input: { ctx: AuthContext; companyId: string; sessionId: string; runId: string; owner: string }): Promise<void>;
  };
  /** This replica's lease identity. A resume from another replica is a different owner, by design. */
  owner?: string;
  promptChars?: number;
  transcriptChars?: number;
  summaryChars?: number;
  now?: () => number;
}
