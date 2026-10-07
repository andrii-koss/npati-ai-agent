import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, WorkspaceNotFoundError } from "@npati/workspace";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { CodeRunStateLog, type CodeRunStateStorePort } from "../apps/agent-api/src/code-run-state";
import { CodeRunReconciler } from "../apps/agent-api/src/code-run-reconciler";
import {
  CodeSessionResumeService,
  type CodeSessionResumeDeps,
} from "../apps/agent-api/src/code-session-resume";
import { CODE_SESSION_DURABILITY_FLAGS } from "../apps/agent-api/src/code-session-durability";

/**
 * C10 security-gate suite: **resume** after the browser and the server both went away.
 *
 * The properties this suite exists to protect, in order of how badly they break if lost:
 *
 *  1. **The same `runId`.** A resume that minted a new run would look fine and would destroy the run's evidence:
 *     the replay bundle is unique by `(run_id, bundle_version)`, so a second bundle for the same exchange cannot
 *     exist and the recording of one of the two runs would be unverifiable. The test asserts one run row, one
 *     lease owner and the same id before and after.
 *  2. **Lost processes are named, never assumed finished.** The evidence is the durable `unknown_outcome` record,
 *     not the (empty, after a restart) in-process registry. A read-only call with an unknown result is *not* lost
 *     work and is reported separately, because the reconciler may replay it.
 *  3. **Workspace and checkpoints come back honestly.** The checkpoint comes from `code_run_turns.checkpoint_id`
 *     (C10 gave that column its writer), and the workspace is only rolled back when the caller explicitly asks —
 *     the files survived the restart, and a silent reset would discard uncommitted work.
 *  4. **No existence oracle.** A run of another session, another project or another company is one identical 404
 *     with no ids in the details.
 *  5. **The continuation prompt is reconstructed from what is recorded** — the transcript bundle, the compaction
 *     summaries (which had no reader before this step), the plan and the todo list — and it is checked for
 *     credentials as a *combination*, because that is where a value harmless in two records can become a leak.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";
const SESSION = "session-1";
const RUN = "run-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: SESSION,
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    userId: "user-1",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

interface HarnessOptions {
  /** The status the run is left in before the resume. */
  runStatus?: "interrupted" | "running" | "waiting_for_user" | "completed";
  /** A live lease owned by somebody else, which a resume must not steal. */
  liveLeaseOwner?: string;
  checkpointId?: string;
  withCheckpointPort?: boolean;
  transcriptSteps?: readonly unknown[];
  answeredQuestion?: {
    questionId: string;
    status: string;
    answer: { choiceId?: string; freeAnswer?: string } | null;
    answeredBy: string;
    sessionId?: string;
  };
  promptSecret?: boolean;
  flagsEnabled?: boolean;
  headTurn?: number;
}

async function harness(options: HarnessOptions = {}) {
  const store = new InMemoryWorkspaceStore();
  // The clock starts at the crash: the run's 60 s lease expires at T0+60 s, which is what every later step is
  // relative to (a worker that is genuinely alive must be modelled by a *live* lease, not by a stale timestamp).
  const clock = { t: T0 };
  const log = new CodeRunStateLog({
    store: store as unknown as CodeRunStateStorePort,
    now: () => clock.t,
  });

  // The run as the crash left it: turn 1 finished, turn 2 open with a shell call and a read whose result nobody
  // observed. That is the durable evidence a resume works from.
  await log.startRun({
    ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, owner: "worker-a", runId: RUN,
  });
  await log.appendTurn({
    companyId: COMPANY, runId: RUN, turnIndex: 1, status: "finished", outcome: "ok",
    ...(options.checkpointId ? { checkpointId: options.checkpointId } : {}),
  });
  await log.appendTurn({ companyId: COMPANY, runId: RUN, turnIndex: 2, status: "running" });
  await log.appendToolCall({
    companyId: COMPANY, runId: RUN, turnIndex: 2, toolCallId: "call-shell", tool: "code.shell.exec",
    readOnly: false, outcome: "unknown_outcome", finishedAt: null,
  });
  await log.appendToolCall({
    companyId: COMPANY, runId: RUN, turnIndex: 2, toolCallId: "call-read", tool: "code.fs.read",
    readOnly: true, outcome: "unknown_outcome", finishedAt: null,
  });

  if (options.runStatus === "waiting_for_user") {
    await log.markWaitingForUser({ companyId: COMPANY, runId: RUN, questionId: "q-1", toolCallId: "call-ask" });
  } else if (options.runStatus === "interrupted") {
    // The reconciler is what turns a dead lease into `interrupted` in production, so it is what produces the state
    // here; the notice it writes is then read back by the resume.
    clock.t = T0 + 2 * 60 * 60_000;
    await new CodeRunReconciler({
      log,
      now: () => clock.t,
      notices: { record: async (input) => { await store.createCodeRunRecoveryNotice({ ...input, workspaceDiff: input.workspaceDiff ?? null }); } },
    }).reconcileRuns({ now: new Date(clock.t) });
  } else if (options.runStatus === "completed") {
    await log.markFinished({ companyId: COMPANY, runId: RUN, status: "completed", reason: "completed" });
  } else if (options.liveLeaseOwner) {
    // Two minutes in: the crashed worker's own lease (60 s) has expired, and the new one is live for another
    // minute — the only state in which a resume must refuse to take the lease.
    clock.t = T0 + 2 * 60_000;
    await log.acquireLease({ companyId: COMPANY, runId: RUN, owner: options.liveLeaseOwner });
  }

  // A "restart": a brand-new log with an empty per-run sequence cache, exactly what a new process has.
  const restartedLog = new CodeRunStateLog({
    store: store as unknown as CodeRunStateStorePort,
    now: () => clock.t,
  });

  await store.createCodeContextSummary({
    companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId: RUN, turnIndex: 1,
    schemaVersion: 1, summary: { goal: "make the tests pass" },
    summaryText: "goal: make the tests pass\ndecisions: none\nnext steps: run the suite",
    contentHash: "hash-1",
  });

  const audits: Array<Record<string, unknown>> = [];
  const restored: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];

  const deps: CodeSessionResumeDeps = {
    flags: {
      assertEnabled: async (_ctx, flagKey) => {
        if (options.flagsEnabled === false) {
          throw Object.assign(new Error(`Feature "${flagKey}" is disabled`), { code: "feature_disabled" });
        }
        return true;
      },
    },
    sessions: {
      get: async (_ctx, companyId, sessionId) => {
        if (companyId !== COMPANY || sessionId !== SESSION) throw new WorkspaceNotFoundError("Code session not found");
        // The session points at its run because C10 gave `code_sessions.run_id` its writer; a resume without it
        // would have to be told the run id by the caller.
        return session({ runId: RUN });
      },
    },
    runState: restartedLog,
    store: {
      getCodeSessionHead: (companyId, sessionId) => store.getCodeSessionHead(companyId, sessionId),
      setCodeSessionHead: (input) => store.setCodeSessionHead(input),
      getLatestCodeRunRecoveryNotice: (companyId, runId) => store.getLatestCodeRunRecoveryNotice(companyId, runId),
      listCodeContextSummaries: (input) => store.listCodeContextSummaries(input),
      listCodeGoals: (input) => store.listCodeGoals(input),
      getLatestCodeSessionPlan: (companyId, sessionId) => store.getLatestCodeSessionPlan(companyId, sessionId),
      listCodeSessionTodos: (input) => store.listCodeSessionTodos(input),
      listCodeRunTurns: (companyId, runId) => store.listCodeRunTurns(companyId, runId),
      // C10: the run's own request. This harness starts its run through the real log without a prompt, so the
      // honest answer here is `not_recorded` — which is what the prompt assertions below pin.
      getCodeRunRequest: (companyId, runId) => store.getCodeRunRequest(companyId, runId),
    },
    transcript: async () => (options.transcriptSteps ? { steps: options.transcriptSteps } : null),
    ...(options.answeredQuestion
      ? {
        questions: {
          get: async (_companyId: string, questionId: string) =>
            questionId === options.answeredQuestion!.questionId
              ? {
                questionId,
                sessionId: options.answeredQuestion!.sessionId ?? SESSION,
                runId: RUN,
                status: options.answeredQuestion!.status,
                answer: options.answeredQuestion!.answer,
                answeredBy: options.answeredQuestion!.answeredBy,
              }
              : null,
        },
      }
      : {}),
    processes: {
      forfeit: async () => ({ forfeited: ["proc-1"], failed: [] }),
    },
    ...(options.withCheckpointPort === false
      ? {}
      : {
        checkpoints: {
          restore: async (input) => {
            restored.push(input);
            return { restoredCheckpointId: input.checkpointId, safetyCheckpointId: "cp-safety" };
          },
        },
      }),
    linkRun: async () => ({ linked: true }),
    activity: { record: async (event) => { activity.push(event as unknown as Record<string, unknown>); } },
    owner: "resume-worker",
    now: () => clock.t,
  };

  await store.createCodeSessionPlan({
    companyId: COMPANY, projectId: PROJECT, sessionId: SESSION,
    plan: { files: ["src/a.ts"], steps: ["change a"], risks: ["none"], testStrategy: "npm test" },
    createdBy: "user-1",
  });
  await store.replaceCodeSessionTodos({
    companyId: COMPANY, projectId: PROJECT, sessionId: SESSION,
    tasks: [{ taskId: "t1", content: "update the parser", status: "in_progress" }],
  });
  await store.createCodeGoal({
    companyId: COMPANY, projectId: PROJECT, sessionId: SESSION,
    objective: "make the failing parser test pass",
    criteria: ["the suite is green"],
    createdBy: "user-1",
  });
  if (options.headTurn !== undefined) {
    await store.setCodeSessionHead({
      companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId: RUN,
      turnIndex: options.headTurn, reason: "rewind", operationId: "op-rewind", expectedRevision: 0,
    });
  }

  const service = new CodeSessionResumeService(deps);
  return {
    store,
    log: restartedLog,
    clock,
    service,
    audits,
    restored,
    activity,
    resume: (input: Partial<Parameters<CodeSessionResumeService["resume"]>[0]> = {}) =>
      service.resume({ ctx, companyId: COMPANY, sessionId: SESSION, ...input }),
  };
}

describe("security-gate: C10 resume — the same run, continued", () => {
  it("continues the same run id and re-takes its lease instead of minting a new run", async () => {
    const h = await harness({ runStatus: "interrupted" });
    const before = await h.store.getCodeRunState(COMPANY, RUN);
    expect(before?.status).toBe("interrupted");
    // The lease of the dead worker may still be named on the row; what matters is that it is no longer live.
    expect(before?.leaseExpiresAt?.getTime()).toBeLessThan(h.clock.t);

    const outcome = await h.resume();
    expect(outcome.status).toBe("resumed");
    expect(outcome.runId).toBe(RUN);
    expect(outcome.lease.held).toBe(true);

    const after = await h.store.getCodeRunState(COMPANY, RUN);
    expect(after?.status).toBe("running");
    expect(after?.leaseOwner).toBe("resume-worker");
    expect(after?.leaseExpiresAt?.getTime()).toBeGreaterThan(h.clock.t);
    // Exactly one run row exists: a resume cannot create a second run for the same session.
    const runs = await h.store.listCodeRunStatesForScan({
      companyId: COMPANY, startedBefore: new Date(h.clock.t + 1), limit: 10,
    });
    expect(runs.items.map((item) => item.runId)).toEqual([RUN]);
  });

  it("resumes a run whose lease merely expired, without waiting for the reconciler", async () => {
    const h = await harness();
    // The lease is the crashed worker's; the process it belonged to is gone.
    h.clock.t = T0 + 3 * 60 * 60_000;
    const outcome = await h.resume();
    expect(outcome.runId).toBe(RUN);
    expect((await h.store.getCodeRunState(COMPANY, RUN))?.status).toBe("running");
  });

  it("reports an already-running run it already holds instead of claiming a second resume", async () => {
    const h = await harness({ liveLeaseOwner: "resume-worker" });
    const outcome = await h.resume();
    expect(outcome.status).toBe("already_resumed");
    expect(outcome.lease.held).toBe(true);
  });

  it("refuses to steal a lease another live worker holds", async () => {
    const h = await harness({ liveLeaseOwner: "other-worker" });
    await expect(h.resume()).rejects.toMatchObject({ code: "run_lease_held", httpStatus: 409, retryable: true });
    // The owner is unchanged: a refused resume is not a takeover.
    expect((await h.store.getCodeRunState(COMPANY, RUN))?.leaseOwner).toBe("other-worker");
  });

  it("refuses a paused run and a finished run, with different reasons", async () => {
    const paused = await harness({ runStatus: "waiting_for_user" });
    await expect(paused.resume()).rejects.toMatchObject({ code: "run_waiting_for_user", httpStatus: 409 });

    const finished = await harness({ runStatus: "completed" });
    await expect(finished.resume()).rejects.toMatchObject({ code: "run_not_resumable", httpStatus: 409 });
  });

  it("refuses a stale run revision instead of continuing a run that moved", async () => {
    const h = await harness({ runStatus: "interrupted" });
    const state = await h.store.getCodeRunState(COMPANY, RUN);
    await expect(h.resume({ expectedRevision: (state?.revision ?? 0) + 5 }))
      .rejects.toMatchObject({ code: "run_revision_conflict", httpStatus: 409, retryable: true });
    await expect(h.resume({ expectedRevision: state?.revision })).resolves.toMatchObject({ runId: RUN });
  });

  it("is refused when its feature flag is off, before anything is touched", async () => {
    const h = await harness({ runStatus: "interrupted", flagsEnabled: false });
    await expect(h.resume()).rejects.toMatchObject({ code: "feature_disabled" });
    expect((await h.store.getCodeRunState(COMPANY, RUN))?.status).toBe("interrupted");
    expect(CODE_SESSION_DURABILITY_FLAGS.resume).toBe("code.session_resume");
  });

  it("marks the lost processes and keeps the replayable read apart from them", async () => {
    const h = await harness({ runStatus: "interrupted" });
    const outcome = await h.resume();
    /**
     * `unknownOutcomeToolCalls` in the C6a boundary is already split: a read-only call whose result nobody
     * observed cannot have changed anything and may be replayed, so only the calls that *may* have started a
     * process or changed a file are "lost". Reporting the read as a lost process would be a false alarm; hiding it
     * would lose the fact that its result is unknown. Both facts are reported, separately.
     */
    expect(outcome.lostProcesses).toEqual([
      { toolCallId: "call-shell", tool: "code.shell.exec", reason: "unknown_outcome_after_restart", process: true },
    ]);
    expect(outcome.unknownOutcomeToolCalls).toEqual([{ toolCallId: "call-shell", tool: "code.shell.exec" }]);
    expect(outcome.boundary.unknownOutcomeCalls).toBe(1);
    expect(outcome.boundary.replayableReadOnlyCalls).toBe(1);
    expect(outcome.boundary.incompleteTurn).toBe(2);
    expect(outcome.forfeitedProcesses).toEqual(["proc-1"]);
    // "Lost" is a platform fact, so it is written down (metadata only, through the existing Activity kind).
    expect(h.activity.map((event) => event.reason)).toEqual(["resume_processes_lost"]);
    expect(JSON.stringify(h.activity)).not.toContain("code.shell.exec");
  });

  it("reports the checkpoint of the last finished turn and only restores the workspace on request", async () => {
    const h = await harness({ runStatus: "interrupted", checkpointId: "cp-turn-1" });
    const plain = await h.resume();
    expect(plain.checkpoint).toEqual({ checkpointId: "cp-turn-1", turnIndex: 1, source: "last_finished_turn" });
    expect(plain.workspace.restored).toBe(false);
    expect(plain.workspace.restoreReason).toBe("not_requested");
    expect(h.restored).toHaveLength(0);

    const restored = await h.resume({ restoreWorkspace: true });
    expect(restored.workspace.restored).toBe(true);
    expect(restored.workspace.safetyCheckpointId).toBe("cp-safety");
    expect(h.restored).toEqual([
      { ctx, companyId: COMPANY, projectId: PROJECT, checkpointId: "cp-turn-1" },
    ]);
  });

  it("says so when there is no recorded checkpoint instead of pretending the workspace is clean", async () => {
    const h = await harness({ runStatus: "interrupted" });
    const outcome = await h.resume();
    expect(outcome.checkpoint).toEqual({ checkpointId: null, turnIndex: null, source: "none" });
    expect(outcome.workspace.restoreReason).toBe("no_checkpoint_recorded");
  });

  it("creates no cursor at all, so a resume cannot truncate the conversation it is continuing", async () => {
    const h = await harness({
      runStatus: "interrupted",
      transcriptSteps: [
        { kind: "model_step", turnIndex: 1, response: { content: "first answer" } },
        { kind: "model_step", turnIndex: 2, response: { content: "second answer" } },
      ],
    });
    const outcome = await h.resume();
    expect(outcome.conversationHead).toBeNull();
    expect(await h.store.getCodeSessionHead(COMPANY, SESSION)).toBeNull();
    // Both recorded turns are part of the conversation: a cursor written at the last finished turn would have
    // hidden turn 2 and every turn the continuation produces afterwards.
    expect(outcome.history.turns).toBe(2);
    expect(outcome.resumePrompt).toContain("second answer");
  });

  it("reports an existing rewound cursor without moving it", async () => {
    const rewound = await harness({ runStatus: "interrupted", headTurn: 0 });
    const outcome = await rewound.resume();
    expect(outcome.conversationHead).toEqual({ created: false, turnIndex: 0, revision: 1 });
    expect((await rewound.store.getCodeSessionHead(COMPANY, SESSION))?.turnIndex).toBe(0);
    expect(outcome.resumePrompt).toContain("A conversation rewind is in force");
  });

  it("answers an unknown, foreign or mismatched run with one identical 404", async () => {
    const h = await harness({ runStatus: "interrupted" });
    await expect(h.resume({ runId: "run-does-not-exist" }))
      .rejects.toMatchObject({ code: "run_not_found", httpStatus: 404, details: {} });
    // A run of a session that is not this one is not found either — the check is on the pair, not on the run alone.
    const other = new CodeRunStateLog({ store: h.store as unknown as CodeRunStateStorePort, now: () => h.clock.t });
    await other.startRun({
      ctx, companyId: OTHER_COMPANY, projectId: PROJECT, sessionId: "session-2", owner: "worker-a", runId: "run-foreign",
    });
    await expect(h.resume({ runId: "run-foreign" }))
      .rejects.toMatchObject({ code: "run_not_found", httpStatus: 404, details: {} });
  });
});

describe("security-gate: C10 resume — the reconstructed continuation prompt", () => {
  it("builds the prompt from the recorded transcript, the summaries, the plan and the todos", async () => {
    const h = await harness({
      runStatus: "interrupted",
      transcriptSteps: [
        {
          kind: "model_step", turnIndex: 1,
          response: { content: "I will update the parser.", finishReason: "tool_calls" },
        },
        {
          kind: "tool_call", turnIndex: 1, toolCallId: "call-1", tool: "code.fs.edit",
          outcome: "ok", settledResult: "edited src/parser.ts",
        },
      ],
    });
    const outcome = await h.resume();
    expect(outcome.history.source).toBe("replay_bundle");
    expect(outcome.history.turns).toBe(1);
    expect(outcome.history.summaries).toBe(1);
    expect(outcome.history.planRevision).toBe(1);
    expect(outcome.history.todos).toBe(1);
    expect(outcome.history.notice).toBe(true);

    const prompt = outcome.resumePrompt;
    expect(prompt).toContain("I will update the parser.");
    expect(prompt).toContain("tool code.fs.edit -> ok");
    expect(prompt).toContain("edited src/parser.ts");
    expect(prompt).toContain("goal: make the tests pass");
    expect(prompt).toContain("revision 1, status draft");
    expect(prompt).toContain("update the parser");
    expect(prompt).toContain("make the failing parser test pass");
    // The recovery notice travels with the continuation, because that is what tells the model what is in doubt.
    expect(prompt).toContain("=== Recovery notice");
    expect(prompt).toContain("Do NOT repeat those calls");
    // And it states what it could not recover, instead of implying the objective is a quotation.
    expect(prompt).toContain("The original request text was");
    // C10: the two facts are kept apart — no record exists for this run, and that is what is reported (not
    // "unreadable", which would be a claim about this resume rather than about the run).
    expect(outcome.history.request).toBe(false);
    expect(outcome.requestUnavailable).toBe("request_not_recorded");
    expect(outcome.request.available).toBe(false);
    expect(prompt).not.toContain("=== Original request");
    expect(outcome.resumePromptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.resumePromptSections).toContain("transcript");
  });

  it("applies the conversation cursor to the reconstructed transcript", async () => {
    const steps = [1, 2, 3].map((turnIndex) => ({
      kind: "model_step", turnIndex, response: { content: `answer for turn ${turnIndex}` },
    }));
    const unbounded = await harness({ runStatus: "interrupted", transcriptSteps: steps });
    expect((await unbounded.resume()).history.turns).toBe(3);

    const rewound = await harness({ runStatus: "interrupted", transcriptSteps: steps, headTurn: 2 });
    const outcome = await rewound.resume();
    expect(outcome.history.turns).toBe(2);
    expect(outcome.resumePrompt).toContain("answer for turn 2");
    // A rewound conversation must not be continued from a turn the rewind removed.
    expect(outcome.resumePrompt).not.toContain("answer for turn 3");
    expect(outcome.resumePrompt).toContain("A conversation rewind is in force");
  });

  it("says the transcript is unavailable when the run has no recording at all", async () => {
    // A hard crash leaves no replay bundle (it is written on a terminal path) and no finished turn, so there is
    // nothing to reconstruct: the prompt must say that rather than imply a conversation nobody stored.
    const h = await harness({ runStatus: "running" });
    h.clock.t = T0 + 3 * 60 * 60_000;
    const outcome = await h.resume();
    expect(outcome.history.source).toBe("run_state");
    expect(outcome.history.turns).toBe(0);
    expect(outcome.resumePrompt).toContain("(no recorded turn is available for this run)");
  });

  it("refuses the prompt when the combination of sources carries a credential", async () => {
    const h = await harness({
      runStatus: "interrupted",
      transcriptSteps: [{
        kind: "tool_call", turnIndex: 1, toolCallId: "call-1", tool: "code.shell.exec", outcome: "ok",
        settledResult: "export API_TOKEN=sk_live_0123456789abcdefghijkl",
      }],
    });
    await expect(h.resume()).rejects.toMatchObject({ code: "resume_prompt_invalid", httpStatus: 500 });
  });

  it("carries the answer of the question the run was paused on, and ignores a question of another session", async () => {
    const answered = await harness({
      runStatus: "interrupted",
      answeredQuestion: { questionId: "q-9", status: "answered", answer: { choiceId: "postgres" }, answeredBy: "user-1" },
    });
    const outcome = await answered.resume({ questionId: "q-9" });
    expect(outcome.history.answeredQuestion).toBe(true);
    expect(outcome.resumePrompt).toContain("The question you were paused on");
    expect(outcome.resumePrompt).toContain("postgres");

    // A question of another session (or another run) is ignored rather than refused: the surface must not become a
    // way to discover foreign question ids, and a resume is not the place to argue about one.
    const foreign = await harness({
      runStatus: "interrupted",
      answeredQuestion: { questionId: "q-9", status: "answered", answer: { choiceId: "postgres" }, answeredBy: "user-1", sessionId: "session-other" },
    });
    const ignored = await foreign.resume({ questionId: "q-9" });
    expect(ignored.history.answeredQuestion).toBe(false);
    expect(ignored.resumePrompt).not.toContain("postgres");
  });
});
