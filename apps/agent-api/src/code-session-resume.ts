import type { AuthContext, CodeRunRequestRecord, CodeRunTurnRecord, CodeSession } from "@npati/workspace";
import type {
  CodeRunBoundary,
  CodeRunStateLog,
} from "./code-run-state";
import { refuseResume } from "./code-run-state";
import {
  boundTranscript,
  boundedBlock,
  buildResumePrompt,
  CodeSessionDurabilityError,
  CODE_SESSION_DURABILITY_FLAGS,
  groupRecordedTurns,
  toNoticeView,
  toResumeRequestView,
  type ResumeEnvironmentChangeView,
  type ResumeNoticeView,
  type ResumePlanView,
  type ResumePrompt,
  type ResumeRequestUnavailableReason,
  type ResumeRequestView,
  type ResumeTodoView,
} from "./code-session-durability";
import { scanTextForSecrets } from "./code-secret-scanner";
import {
  RESUME_ENVIRONMENT_DIFF_FAMILIES,
  RESUME_ENVIRONMENT_FAMILIES,
  type ResumeEnvironmentAdmission,
} from "./execution-snapshot";
import type { ExecutionSnapshotRecord } from "@npati/workspace";
import { sha256Hex } from "./code-tool-runtime";

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

/**
 * C10 — **Resume**: continue the run a session was interrupted in, after the browser and the server both went
 * away.
 *
 * The single most important design decision is that a resume continues the **same** `runId`. Minting a new one
 * would look harmless and would quietly destroy the run's evidence: the replay bundle is unique by
 * `(run_id, bundle_version)`, so a second bundle for the same exchange cannot exist, and a second run would
 * either collide with the recording's identity or append steps the recorded mode can no longer verify. The same
 * `runId` also keeps `code_run_turns`, the snapshots and the Activity of one run in one place, which is what
 * makes "what happened before the restart" answerable at all.
 *
 * What a resume does, in order, and each step exists because a real failure mode does:
 *
 *  1. **The session and the run are re-checked against each other.** The C6a tables carry no foreign key to
 *     `code_sessions` (deliberately: they are evidence), so "the session still exists, the run still belongs to
 *     it and to this tenant" is checked here. A run of another session or another company answers exactly like
 *     a run that never existed — no existence oracle, the same rule the run-stream route follows.
 *  2. **The durable state decides whether a resume is allowed at all.** `refuseResume` is the one rule: a pause
 *     on a question and a terminal run are refusals; an expired-lease `running` run and an `interrupted` run are
 *     resumable.
 *  3. **The lease is re-taken under a new owner.** `startRun` is idempotent by run id, so it cannot create a
 *     second run; `resumeRun` then takes the lease and returns the run to `running` in one ordered step.
 *  4. **Lost processes are named, never assumed finished.** The evidence is durable, not in-process: every
 *     non-read-only call whose outcome nobody observed is a call that may have started a command or a process
 *     and may or may not have landed. The in-process registry is consulted as well (a deployment that still
 *     holds processes can release them), but it is never the source of truth, because after a restart it is
 *     empty.
 *  5. **The workspace and the checkpoint linkage are restored.** The files survived the restart; what did not
 *     survive is the in-memory turn→checkpoint map, and that is exactly what `code_run_turns.checkpoint_id` now
 *     holds. The checkpoint of the last finished turn is reported (and used as the comparison base), and a caller
 *     that explicitly asks for it can have the workspace restored through the existing checkpoint service —
 *     never silently, because a reset discards uncommitted work.
 *  6. **The continuation prompt is rebuilt from what is actually recorded**: the run's own request (C10 — the
 *     column pair that had no writer until now), the replay bundle (the transcript), the compaction summaries,
 *     the plan, the todo list, the goal and the recovery notice. Nothing is re-derived from
 *     `code_run_turns.messages`, which is empty by construction and stays the metadata-only turn snapshot it was
 *     declared to be.
 *  7. **The environment is re-checked, not assumed.** A resume records a NEW `ExecutionSnapshot` version
 *     (`trigger: "resume"`), diffs it against the snapshot the run was admitted under, and refuses to continue
 *     when the sandbox image the run ran in has been revoked. Nothing is continued silently in a moved
 *     environment.
 */

const DEFAULT_PROMPT_CHARS = 24_000;
const DEFAULT_TRANSCRIPT_CHARS = 16_000;
const DEFAULT_SUMMARY_CHARS = 2_000;
const MAX_SUMMARIES = 3;

/** Tools whose unknown outcome means a *process* may have been alive when the host went away. */
const PROCESS_TOOLS: ReadonlyArray<string> = [
  "code.shell.exec",
  "code.shell.process.start",
  "code.deps.add",
  "code.deps.install",
  "code.deps.update",
  "code.deps.remove",
  "code.verify.run",
];

export interface CodeSessionResumeRequest {
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
  /** This replica's lease identity. A resume from another replica is a different owner, by design. */
  owner?: string;
  promptChars?: number;
  transcriptChars?: number;
  summaryChars?: number;
  now?: () => number;
}

function isProcessTool(tool: string): boolean {
  return PROCESS_TOOLS.includes(tool);
}

/** Turns the C6a refusal vocabulary into this surface's refusal vocabulary. */
function refusalError(refusal: "waiting_for_user" | "terminal" | "not_found"): CodeSessionDurabilityError {
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

export class CodeSessionResumeService {
  constructor(private readonly deps: CodeSessionResumeDeps) {}

  async resume(request: CodeSessionResumeRequest): Promise<CodeSessionResumeResultView> {
    const { ctx, companyId, sessionId } = request;
    await this.deps.flags.assertEnabled(ctx, CODE_SESSION_DURABILITY_FLAGS.resume, { companyId });

    const session = await this.deps.sessions.get(ctx, companyId, sessionId);
    if (session.status === "archived") {
      throw new CodeSessionDurabilityError("session_archived", "Archived sessions cannot be resumed", 409, {});
    }
    const runId = String(request.runId ?? session.runId ?? "").trim();
    if (!runId) {
      throw new CodeSessionDurabilityError("run_not_found", "This session has no run to resume", 404, { reason: "session_has_no_run" });
    }
    const state = await this.deps.runState.loadRunState(companyId, runId);
    // No oracle: a run of another session, another project or another company is answered exactly like a run
    // that does not exist. The store is tenant-scoped, so `null` already covers the last of those.
    if (!state || state.sessionId !== session.id || state.projectId !== session.projectId) {
      throw new CodeSessionDurabilityError("run_not_found", "Run not found", 404, {});
    }
    if (request.expectedRevision !== undefined && request.expectedRevision !== null && request.expectedRevision !== state.revision) {
      throw new CodeSessionDurabilityError(
        "run_revision_conflict",
        "The run changed since it was read; reload and try again",
        409,
        { expectedRevision: request.expectedRevision, currentRevision: state.revision },
        true,
      );
    }
    const refusal = refuseResume(state.status);
    if (refusal) throw refusalError(refusal);

    /**
     * C10 (Question 2): the environment is re-checked **before** the lease is taken. Doing it here is deliberate:
     * a refusal must leave the run exactly as the crash left it — still `interrupted`, still owned by nobody —
     * so the caller can resolve the environment and retry, instead of finding a run that was moved to `running`
     * and then abandoned. The new snapshot, on the other hand, *is* written either way: "this resume was
     * attempted in this environment" is evidence, and it is the whole point of a diff.
     */
    const recordedSnapshot = await this.readRecordedSnapshot(companyId, runId);
    const environment = await this.checkEnvironment({
      ctx, companyId, session, runId, recorded: recordedSnapshot,
    });
    if (environment.blocking) {
      throw new CodeSessionDurabilityError(
        "run_environment_revoked",
        "The environment this run was admitted in is no longer usable; resolve the change and resume again",
        409,
        {
          reason: environment.reason ?? "environment_changed",
          changes: environment.changes,
          notCompared: environment.notCompared,
          snapshotId: environment.snapshotId,
          previousSnapshotId: environment.previousSnapshotId,
        },
        true,
      );
    }

    const owner = this.deps.owner ?? `resume-${process.pid}`;
    const alreadyResumed = state.status === "running"
      && state.leaseExpiresAt !== null
      && state.leaseExpiresAt.getTime() >= (this.deps.now?.() ?? Date.now());

    // (3) The same run id, never a new one: `startRun` is idempotent by run id and keeps the existing row.
    // No `request` is passed, and none could take effect anyway: the row already exists, so the create is a
    // no-op — which is exactly what protects the original request when the continuation itself is driven through
    // the runner (its prompt is the reconstructed continuation prompt, not the user's original words).
    await this.deps.runState.startRun({ ctx, companyId, projectId: session.projectId, sessionId, owner, runId });
    const resumed = await this.deps.runState.resumeRun({ companyId, runId, owner });
    if (resumed.refused) throw refusalError(resumed.refused);
    if (!resumed.held) {
      throw new CodeSessionDurabilityError(
        "run_lease_held",
        "Another worker holds the lease of this run right now",
        409,
        { reason: "lease_held_by_another_worker" },
        true,
      );
    }

    const boundary = await this.deps.runState.loadTurnBoundary(companyId, runId);
    const lost = this.lostProcesses(boundary);
    const forfeited = await this.forfeitProcesses({ ctx, companyId, projectId: session.projectId, sessionId });
    await this.recordRecovery({ companyId, sessionId, projectId: session.projectId, runId, boundary, lost });

    const checkpoint = await this.resolveCheckpoint(companyId, runId, boundary);
    const workspace = await this.ensureWorkspace(ctx, companyId, session, request.restoreWorkspace === true, checkpoint);
    const head = await this.readConversationHead({ companyId, sessionId: session.id });
    const notice = await this.readNotice(companyId, runId);
    const answeredQuestion = await this.readAnsweredQuestion(companyId, session, runId, request.questionId ?? null);
    const recoveredRequest = await this.readRunRequest(companyId, runId);
    const history = await this.buildHistory({
      ctx, companyId, session, runId, headTurn: head?.turnIndex ?? null, notice, boundary, lost, answeredQuestion,
      request: recoveredRequest, environment,
    });
    const link = await this.relink({ ctx, companyId, session, runId });

    return {
      status: alreadyResumed ? "already_resumed" : "resumed",
      sessionId,
      projectId: session.projectId,
      runId,
      runStatus: "running",
      runRevision: resumed.state?.revision ?? state.revision,
      lease: { held: true },
      boundary: {
        lastFinishedTurn: boundary?.lastFinishedTurn ?? 0,
        incompleteTurn: boundary?.incompleteTurn?.turnIndex ?? null,
        unknownOutcomeCalls: boundary?.unknownOutcomeToolCalls.length ?? 0,
        replayableReadOnlyCalls: boundary?.replayableReadOnlyToolCalls.length ?? 0,
      },
      lostProcesses: lost,
      unknownOutcomeToolCalls: (boundary?.unknownOutcomeToolCalls ?? []).map((call) => ({ toolCallId: call.toolCallId, tool: call.tool })),
      forfeitedProcesses: forfeited,
      checkpoint,
      workspace,
      sessionRunLink: link,
      conversationHead: head,
      notice,
      history: history.history,
      request: recoveredRequest,
      requestUnavailable: recoveredRequest.available ? null : recoveredRequest.reason,
      environment,
      resumePrompt: history.prompt.prompt,
      resumePromptChars: history.prompt.prompt.length,
      resumePromptTruncated: history.prompt.truncated,
      resumePromptHash: sha256Hex(history.prompt.prompt),
      resumePromptSections: history.prompt.sections,
    };
  }

  /**
   * The lost work, from the durable evidence. A read-only call whose outcome is unknown is *not* lost work: it
   * cannot have changed anything, and the reconciler may replay it. Everything else is reported as lost.
   */
  private lostProcesses(boundary: CodeRunBoundary | null): CodeSessionResumeLostProcess[] {
    return (boundary?.unknownOutcomeToolCalls ?? []).map((call) => ({
      toolCallId: call.toolCallId,
      tool: call.tool,
      reason: "unknown_outcome_after_restart",
      process: isProcessTool(call.tool),
    }));
  }

  private async forfeitProcesses(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string }): Promise<string[]> {
    if (!this.deps.processes) return [];
    try {
      const outcome = await this.deps.processes.forfeit({ ...input, reason: "resume_after_restart" });
      return outcome.forfeited;
    } catch {
      // Reported by absence; the durable evidence above is the authoritative list either way.
      return [];
    }
  }

  /**
   * C10: "lost" is a fact about the platform, so it is written down, not only returned. The Activity sink carries
   * metadata only — tool counts and the turn — which is the same vocabulary the reconciler uses.
   */
  private async recordRecovery(input: {
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    boundary: CodeRunBoundary | null;
    lost: readonly CodeSessionResumeLostProcess[];
  }): Promise<void> {
    if (!this.deps.activity) return;
    try {
      await this.deps.activity.record({
        kind: "run_reconcile",
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        runId: input.runId,
        reason: input.lost.length ? "resume_processes_lost" : "resume_no_lost_processes",
        lastFinishedTurn: input.boundary?.lastFinishedTurn ?? 0,
        unknownOutcomeToolCalls: input.boundary?.unknownOutcomeToolCalls.length ?? 0,
      });
    } catch {
      // Activity is a log, never a gate: a failing sink must not stop a resume.
    }
  }

  /**
   * The checkpoint the workspace is compared against (and restored to, when the caller asked). It comes from
   * `code_run_turns.checkpoint_id` — the column C10 finally writes — preferring the boundary's own checkpoint
   * and falling back to the newest earlier turn that has one, because the state a mid-run turn was based on is
   * the newest checkpoint before it.
   */
  private async resolveCheckpoint(companyId: string, runId: string, boundary: CodeRunBoundary | null): Promise<{
    checkpointId: string | null; turnIndex: number | null; source: "last_finished_turn" | "earlier_turn" | "none";
  }> {
    const lastFinished = boundary?.lastFinishedTurn ?? 0;
    const turns = await this.safeTurns(companyId, runId);
    if (boundary?.checkpointId) {
      const owner = turns.find((turn) => turn.checkpointId === boundary.checkpointId);
      return { checkpointId: boundary.checkpointId, turnIndex: owner?.turnIndex ?? lastFinished, source: "last_finished_turn" };
    }
    const earlier = turns
      .filter((turn) => typeof turn.checkpointId === "string" && turn.checkpointId && turn.turnIndex <= lastFinished)
      .sort((a, b) => b.turnIndex - a.turnIndex)[0] ?? null;
    if (earlier?.checkpointId) {
      return { checkpointId: earlier.checkpointId, turnIndex: earlier.turnIndex, source: "earlier_turn" };
    }
    return { checkpointId: null, turnIndex: null, source: "none" };
  }

  private async safeTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]> {
    try {
      return await this.deps.store.listCodeRunTurns(companyId, runId);
    } catch {
      return [];
    }
  }

  /**
   * The workspace and the checkpoint. Two separate facts, reported separately:
   *
   *  - **attached** — whether the deployment could re-attach a workspace/sandbox for the session. That lifecycle
   *    belongs to the sandbox provider, so the answer is whatever the injected port says and `null` when nothing
   *    is wired: "we did not check" is not "it is fine".
   *  - **restored** — whether the files were rolled back to the checkpoint. Only when the caller asked
   *    (`restoreWorkspace: true`), because the files survived the restart and a reset would discard every
   *    uncommitted change made since. The restore goes through the existing checkpoint service, so its mandatory
   *    pre-restore safety checkpoint applies and the action stays reversible.
   */
  private async ensureWorkspace(
    ctx: AuthContext,
    companyId: string,
    session: CodeSession,
    restoreRequested: boolean,
    checkpoint: { checkpointId: string | null },
  ): Promise<CodeSessionResumeResultView["workspace"]> {
    let attached: boolean | null = null;
    let reason: string | undefined;
    if (this.deps.workspace) {
      try {
        const outcome = await this.deps.workspace.ensure({ ctx, companyId, projectId: session.projectId, sessionId: session.id });
        attached = outcome.ready;
        if (!outcome.ready) reason = outcome.reason ?? "workspace_not_ready";
      } catch (error) {
        attached = false;
        reason = (error as Error).message;
      }
    } else {
      reason = "workspace_provider_not_configured";
    }

    if (!restoreRequested) {
      return {
        attached,
        ...(reason === undefined ? {} : { reason }),
        restored: false,
        restoreReason: checkpoint.checkpointId ? "not_requested" : "no_checkpoint_recorded",
      };
    }
    if (!checkpoint.checkpointId) {
      return { attached, ...(reason === undefined ? {} : { reason }), restored: false, restoreReason: "no_checkpoint_recorded" };
    }
    if (!this.deps.checkpoints) {
      return { attached, ...(reason === undefined ? {} : { reason }), restored: false, restoreReason: "checkpoint_service_not_configured" };
    }
    try {
      const restored = await this.deps.checkpoints.restore({
        ctx, companyId, projectId: session.projectId, checkpointId: checkpoint.checkpointId,
      });
      return {
        attached,
        ...(reason === undefined ? {} : { reason }),
        restored: true,
        safetyCheckpointId: restored.safetyCheckpointId ?? null,
      };
    } catch (error) {
      return { attached, ...(reason === undefined ? {} : { reason }), restored: false, restoreReason: (error as Error).message };
    }
  }

  /**
   * The conversation cursor, read **only**. A resume never creates or moves one, and that is deliberate:
   *
   *  - the cursor means "the conversation is the turns up to and including this one", so creating one at the last
   *    finished turn would truncate the transcript of every future turn of a run that continues past it — a
   *    resume would silently amputate the conversation it is supposed to continue;
   *  - a session whose conversation *was* rewound already has a cursor, and pushing it back up to the run's last
   *    turn would undo that rewind;
   *  - no cursor means "no rewind in force", which is exactly what a session that was never rewound should say.
   *
   * The value is still reported, because a caller continuing a rewound conversation needs to know the transcript
   * it is continuing from ends at that turn.
   */
  private async readConversationHead(input: {
    companyId: string;
    sessionId: string;
  }): Promise<{ created: boolean; turnIndex: number; revision: number } | null> {
    const existing = await this.deps.store.getCodeSessionHead(input.companyId, input.sessionId);
    if (!existing) return null;
    return { created: false, turnIndex: existing.turnIndex, revision: existing.revision };
  }

  /**
   * C10: the run's **original request**. Two different failures are kept apart on purpose: a store that cannot
   * answer is `request_record_unavailable` (a fact about this resume), while a record that says
   * `not_recorded`/`refused_credential` is a fact about the run. Collapsing them would let an outage read as
   * "the user never asked for anything".
   */
  private async readRunRequest(companyId: string, runId: string): Promise<ResumeRequestView> {
    try {
      const record = await this.deps.store.getCodeRunRequest(companyId, runId);
      return toResumeRequestView(record);
    } catch {
      return toResumeRequestView(null, { readFailed: true });
    }
  }

  /**
   * The snapshot the run was admitted under — the comparison base of the environment re-check.
   *
   * It is read **once, before** the resume snapshot is written, and that is not an optimisation: `getSnapshotForRun`
   * answers with the newest snapshot of the run, which after the capture below is the resume snapshot itself.
   * Re-reading it afterwards would diff a snapshot against itself and report that nothing ever changed.
   */
  private async readRecordedSnapshot(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null> {
    if (!this.deps.environment) return null;
    try {
      return await this.deps.environment.read(companyId, runId);
    } catch {
      return null;
    }
  }

  /**
   * C10 (Question 2): re-reads the environment, records a new snapshot version for it and reports what moved.
   *
   * The order — capture first, then diff — is what makes the report trustworthy: the snapshot that is written is
   * the value the diff is computed from, so "what this continuation runs in" and "what the diff shows" cannot be
   * two different environments.
   *
   * Three outcomes, and none of them is silence:
   *
   *   - **not configured / not comparable** — the deployment injected no admission port, or the run has no
   *     recorded snapshot. Reported as `not compared` with the reason; the resume proceeds, because a check that
   *     did not happen is not evidence of a change.
   *   - **changed, not blocking** — the four families are compared and every difference is reported. The
   *     continuation runs, but the prompt and the response both state the current values, so nothing is
   *     continued *silently* in a moved environment.
   *   - **blocking** — the sandbox image the run was admitted with has been revoked. Revocation cannot be read
   *     off a field-by-field diff (a new digest and a revoked digest look the same), so it is its own fact from
   *     the source, and it stops the resume before the lease is taken.
   */
  private async checkEnvironment(input: {
    ctx: AuthContext;
    companyId: string;
    session: CodeSession;
    runId: string;
    recorded: ExecutionSnapshotRecord | null;
  }): Promise<ResumeEnvironmentChangeView> {
    /**
     * `reportFamilies` decides whether "we did not compare this" is passed on to the model. A deployment that
     * wired no admission port at all has nothing to report — the environment was never part of its contract, and
     * filling the continuation prompt with four "not compared" lines would be noise. A deployment that *can*
     * check but could not (a run predating C6b, a capture that failed) is a real gap, and it is stated.
     */
    const empty = (reason: string, reportFamilies = true): ResumeEnvironmentChangeView => ({
      captured: false,
      snapshotId: null,
      snapshotVersion: null,
      previousSnapshotId: null,
      previousVersion: null,
      changes: [],
      image: null,
      notCompared: reportFamilies ? RESUME_ENVIRONMENT_FAMILIES.map((family) => ({ family, reason })) : [],
      blocking: false,
      reason,
    });
    if (!this.deps.environment) return empty("environment_check_not_configured", false);

    let captured: { record: ExecutionSnapshotRecord; unavailable: string[] } | null = null;
    try {
      captured = await this.deps.environment.capture({
        ctx: input.ctx,
        companyId: input.companyId,
        workspaceId: input.session.workspaceId,
        projectId: input.session.projectId,
        sessionId: input.session.id,
        runId: input.runId,
        actor: String(input.ctx.userId ?? "unknown"),
        reason: "resume_environment_check",
        recorded: input.recorded?.payload ?? null,
      });
    } catch {
      captured = null;
    }

    if (!input.recorded) {
      return {
        ...empty("no_snapshot_recorded_for_run"),
        captured: captured !== null,
        snapshotId: captured?.record.id ?? null,
        snapshotVersion: captured?.record.snapshotVersion ?? null,
        image: captured ? readImageVerdict(captured.record.payload) : null,
      };
    }
    if (!captured) {
      return {
        ...empty("resume_snapshot_not_recorded"),
        previousSnapshotId: input.recorded.id,
        previousVersion: input.recorded.snapshotVersion,
      };
    }

    const full = this.deps.environment.diff(input.recorded, captured.record);
    // Only the value families are diffed; the sandbox image is a verdict from the admission policy, and diffing
    // two different shapes would report every one of its fields as changed on every resume.
    const environmentChanges = full.changes.filter((change) =>
      RESUME_ENVIRONMENT_DIFF_FAMILIES.some((family) => change.field === family || change.field.startsWith(`${family}.`)),
    );
    const notCompared = captured.unavailable
      .filter((family) => RESUME_ENVIRONMENT_FAMILIES.includes(family))
      .map((family) => ({ family, reason: "resume_environment_source_unavailable" }));
    const image = readImageVerdict(captured.record.payload);
    return {
      captured: true,
      snapshotId: captured.record.id,
      snapshotVersion: captured.record.snapshotVersion,
      previousSnapshotId: input.recorded.id,
      previousVersion: input.recorded.snapshotVersion,
      changes: environmentChanges,
      image,
      notCompared,
      blocking: image?.status === "revoked",
      reason: image?.status === "revoked"
        ? `sandbox_image_revoked:${image.reason}`
        : environmentChanges.length || (image !== null && image.status === "unknown")
          ? "environment_changed"
          : "environment_unchanged",
    };
  }

  private async readNotice(companyId: string, runId: string): Promise<Record<string, unknown> | null> {    try {
      const notice = await this.deps.store.getLatestCodeRunRecoveryNotice(companyId, runId);
      return notice ? toNoticeView(notice) : null;
    } catch {
      return null;
    }
  }

  private async relink(input: { ctx: AuthContext; companyId: string; session: CodeSession; runId: string }): Promise<{ linked: boolean; reason?: string }> {
    if (!this.deps.linkRun) return { linked: false, reason: "session_run_link_not_configured" };
    try {
      const outcome = await this.deps.linkRun({
        ctx: input.ctx, companyId: input.companyId, projectId: input.session.projectId,
        sessionId: input.session.id, runId: input.runId,
      });
      return outcome.linked ? { linked: true } : { linked: false, reason: outcome.reason ?? "session_run_link_failed" };
    } catch (error) {
      return { linked: false, reason: (error as Error).message };
    }
  }

  /**
   * C9: the answer the run was paused on. Only an **answered** question is included, and only when it belongs to
   * this session and this run — a question of another session is ignored rather than refused, so the surface
   * cannot be used to discover foreign question ids.
   */
  private async readAnsweredQuestion(
    companyId: string,
    session: CodeSession,
    runId: string,
    questionId: string | null,
  ): Promise<{ questionId: string; answer: string | null; answeredBy: string } | null> {
    if (!questionId || !this.deps.questions) return null;
    try {
      const question = await this.deps.questions.get(companyId, questionId);
      if (!question || question.sessionId !== session.id || question.runId !== runId) return null;
      if (question.status !== "answered") return null;
      const answer = question.answer;
      return {
        questionId: question.questionId,
        answer: answer ? (answer.choiceId ?? answer.freeAnswer ?? null) : null,
        answeredBy: question.answeredBy ?? "unknown",
      };
    } catch {
      return null;
    }
  }

  /**
   * Rebuilds the continuation prompt from the recorded sources. Every read is fail-soft: a missing summary or an
   * unreadable plan reduces the prompt's *sources* (which are reported) rather than failing the resume, because
   * the run is already live again and a partial context is better than a run nobody continues.
   */
  private async buildHistory(input: {
    ctx: AuthContext;
    companyId: string;
    session: CodeSession;
    runId: string;
    headTurn: number | null;
    notice: Record<string, unknown> | null;
    boundary: CodeRunBoundary | null;
    lost: readonly CodeSessionResumeLostProcess[];
    answeredQuestion: { questionId: string; answer: string | null; answeredBy: string } | null;
    request: ResumeRequestView;
    environment: ResumeEnvironmentChangeView;
  }): Promise<{ history: CodeSessionResumeResultView["history"]; prompt: ResumePrompt }> {
    const { companyId, session, runId } = input;

    let steps: readonly unknown[] = [];
    let source: "replay_bundle" | "run_state" | "none" = "none";
    if (this.deps.transcript) {
      try {
        const recorded = await this.deps.transcript({ ctx: input.ctx, companyId, runId });
        if (recorded && recorded.steps.length) {
          steps = recorded.steps;
          source = "replay_bundle";
        }
      } catch {
        steps = [];
      }
    }
    if (source === "none" && (await this.safeTurns(companyId, runId)).length) source = "run_state";

    const recorded = groupRecordedTurns(steps, { upToTurn: input.headTurn });
    const transcript = boundTranscript(recorded, this.deps.transcriptChars ?? DEFAULT_TRANSCRIPT_CHARS);

    let summaries: Array<{ turnIndex: number; summaryText: string; createdAt: Date }> = [];
    try {
      summaries = (await this.deps.store.listCodeContextSummaries({ companyId, sessionId: session.id, limit: MAX_SUMMARIES }))
        .filter((summary) => input.headTurn === null || summary.turnIndex <= input.headTurn)
        .slice(0, MAX_SUMMARIES);
    } catch {
      summaries = [];
    }

    let objective: string | null = null;
    try {
      const goals = await this.deps.store.listCodeGoals({ companyId, sessionId: session.id, limit: 1 });
      objective = goals[0]?.objective ?? null;
    } catch {
      objective = null;
    }
    // The session's own summary is the second-best record of what the work was about. The prompt states that the
    // original request text was never stored, so this is never presented as a quotation of it.
    if (!objective) objective = session.summary ?? null;

    let plan: ResumePlanView | null = null;
    try {
      const stored = await this.deps.store.getLatestCodeSessionPlan(companyId, session.id);
      plan = stored
        ? {
          revision: stored.revision,
          status: stored.status,
          executionMode: stored.executionMode ?? null,
          files: stored.plan.files,
          steps: stored.plan.steps,
          risks: stored.plan.risks,
          testStrategy: stored.plan.testStrategy,
        }
        : null;
    } catch {
      plan = null;
    }

    let todos: ResumeTodoView[] = [];
    try {
      todos = (await this.deps.store.listCodeSessionTodos({ companyId, sessionId: session.id }))
        .map((todo) => ({ taskId: todo.taskId, content: todo.content, status: todo.status }));
    } catch {
      todos = [];
    }

    const noticeView: ResumeNoticeView | null = input.notice
      ? {
        reason: String(input.notice.reason ?? "unknown"),
        lastFinishedTurn: Number(input.notice.lastFinishedTurn ?? 0),
        messageForModel: String(input.notice.messageForModel ?? ""),
        unknownOutcome: Array.isArray(input.notice.unknownOutcomeToolCalls)
          ? (input.notice.unknownOutcomeToolCalls as Array<{ toolCallId: string; tool: string }>)
          : [],
      }
      : null;

    const prompt = buildResumePrompt({
      sessionId: session.id,
      runId,
      promptChars: this.deps.promptChars ?? DEFAULT_PROMPT_CHARS,
      transcriptChars: this.deps.transcriptChars ?? DEFAULT_TRANSCRIPT_CHARS,
      summaryChars: this.deps.summaryChars ?? DEFAULT_SUMMARY_CHARS,
      lastFinishedTurn: input.boundary?.lastFinishedTurn ?? 0,
      headTurn: input.headTurn,
      transcript,
      summaries: summaries.map((summary) => ({
        turnIndex: summary.turnIndex,
        summaryText: boundedBlock(summary.summaryText, this.deps.summaryChars ?? DEFAULT_SUMMARY_CHARS).text,
        createdAt: summary.createdAt,
      })),
      plan,
      todos,
      notice: noticeView,
      lostProcesses: input.lost.map((entry) => ({ toolCallId: entry.toolCallId, tool: entry.tool })),
      objective,
      request: input.request,
      sessionMode: session.mode ?? null,
      environmentChange: input.environment,
      answeredQuestion: input.answeredQuestion,
    });

    /**
     * The prompt is provider-bound content, so it is scanned before it is handed back: the bundle and the
     * summaries were each checked when they were written, but this text is a *combination* of them, and a
     * combination is exactly where a value harmless in two separate records can become a credential in one. A
     * finding refuses the resume loudly instead of returning a prompt that would carry it onward.
     */
    const findings = scanTextForSecrets(prompt.prompt).findings;
    if (findings.length) {
      throw new CodeSessionDurabilityError(
        "resume_prompt_invalid",
        "The reconstructed continuation prompt contains a credential and was refused",
        500,
        { kinds: Array.from(new Set(findings.map((finding) => String(finding.kind)))) },
      );
    }

    return {
      history: {
        source,
        turns: transcript.turns.length,
        summaries: summaries.length,
        planRevision: plan?.revision ?? null,
        todos: todos.length,
        notice: noticeView !== null,
        answeredQuestion: input.answeredQuestion !== null,
        request: input.request.available,
      },
      prompt,
    };
  }
}
