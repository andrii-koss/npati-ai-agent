import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { createCodeAskUserService, type CodeAskUserStore } from "../apps/agent-api/src/code-ask-user-service";
import { CodeRunReconciler } from "../apps/agent-api/src/code-run-reconciler";
import type { CodeRunStateRecord } from "@npati/workspace";

/**
 * C9 security-gate: `code.ask_user` — the run pauses, a human answers.
 *
 * The suite is built around the two failures that would make the feature worse than useless:
 *
 *  - **A pause that dies with the process.** The question is a row and the run is a state, so the tests answer
 *    through a *second* service instance built over the same store — that is what "after a restart" means here.
 *  - **A pause that C6a "recovers".** The reconciler turns `running` without a live lease into `interrupted` and
 *    repeats read-only tool calls; a waiting run must be invisible to it, or every restart would replay work and
 *    discard the answer that was on its way.
 *
 * Everything else in the file is the refusal list the owner specified: only a human answers, only an offered
 * choice is accepted, a repeated answer resumes nothing, and expiry never guesses a default.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";
const SESSION = "session-1";
const RUN = "run-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const user: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:read", "workspace:write"] };
const agent: AuthContext = { userId: "agent:bot-1", workspaceId: "ws-1", permissions: ["workspace:read", "workspace:write"] };
const servicePrincipal: AuthContext = { userId: "user-1", externalSubject: "service:automation", workspaceId: "ws-1", permissions: ["workspace:write"] };

function harness(options: { auditFails?: boolean } = {}) {
  const store = new InMemoryWorkspaceStore();
  const clock = { t: T0 };
  const runEvents: string[] = [];
  const activity: Array<{ kind: string; questionId: string; answeredBy?: string }> = [];
  const runState = {
    markWaitingForUser: async (input: { questionId: string }) => { runEvents.push(`waiting:${input.questionId}`); return {}; },
    resumeAfterAnswer: async (input: { questionId: string }) => { runEvents.push(`resume:${input.questionId}`); return {}; },
    markInterrupted: async (input: { reason: string }) => { runEvents.push(`interrupted:${input.reason}`); return {}; },
  };
  const audit = {
    record: async () => {
      if (options.auditFails) throw new Error("journal is down");
    },
  };
  const build = () => createCodeAskUserService({
    store: store as unknown as CodeAskUserStore,
    runState,
    audit,
    now: () => clock.t,
    onActivity: (event) => activity.push(event as { kind: string; questionId: string; answeredBy?: string }),
  });
  return { store, clock, runEvents, activity, service: build(), restart: build };
}

function askInput(overrides: Record<string, unknown> = {}) {
  return {
    ctx: user,
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    toolCallId: "call-1",
    prompt: "Which database should the migration target?",
    choices: [{ id: "local", label: "Local sandbox" }, { id: "dev", label: "Dev database" }],
    ...overrides,
  } as Parameters<ReturnType<typeof harness>["service"]["ask"]>[0];
}

describe("security-gate: C9 ask_user — the pause is a state, not a process", () => {
  it("asks the question, pauses the run and records the ask in Activity", async () => {
    const h = harness();
    const result = await h.service.ask(askInput());
    expect(result.created).toBe(true);
    expect(result.runPaused).toBe(true);
    expect(result.question.status).toBe("pending");
    expect(result.question.choices.map((c) => c.id)).toEqual(["local", "dev"]);
    expect(h.runEvents).toEqual([`waiting:${result.question.id}`]);
    expect(h.activity.map((e) => e.kind)).toEqual(["question_asked"]);
  });

  it("survives a restart: a new service over the same store finds the pending question and answers it", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput());
    // A restarted process shares only the database, so a second service instance is the honest simulation.
    const afterRestart = h.restart();
    const pending = await afterRestart.pendingForRun(COMPANY, RUN);
    expect(pending?.id).toBe(asked.question.id);
    const answered = await afterRestart.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
    });
    expect(answered.applied).toBe(true);
    expect(answered.runResumed).toBe(true);
    expect(answered.question.answer).toEqual({ choiceId: "local" });
    expect(answered.question.answeredBy).toBe("user-1");
    expect(h.runEvents).toEqual([`waiting:${asked.question.id}`, `resume:${asked.question.id}`]);
  });

  it("refuses an agent or service token before anything is read, because an agent must not answer its own question", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput());
    const answerSpy = vi.spyOn(h.store, "answerCodeUserQuestion");
    for (const ctx of [agent, servicePrincipal]) {
      await expect(h.service.answer({
        ctx, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
      })).rejects.toMatchObject({ code: "question_answer_forbidden", httpStatus: 403 });
    }
    expect(answerSpy).not.toHaveBeenCalled();
    expect(h.runEvents).toEqual([`waiting:${asked.question.id}`]);
  });

  it("resumes the run exactly once when the same answer is submitted twice", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput());
    const input = { ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "dev" };
    const first = await h.service.answer(input);
    const second = await h.service.answer(input);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.runResumed).toBe(false);
    expect(h.runEvents.filter((event) => event.startsWith("resume:"))).toHaveLength(1);
    expect(h.activity.filter((event) => event.kind === "question_answered")).toHaveLength(1);
  });

  it("refuses a different answer to an already-decided question", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput());
    await h.service.answer({ ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "dev" });
    await expect(h.service.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 2, choiceId: "local",
    })).rejects.toMatchObject({ code: "question_not_pending", httpStatus: 409 });
  });

  it("accepts only a choice the question actually offered, and only one answer form at a time", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput({ allowFreeAnswer: false }));
    await expect(h.service.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "production",
    })).rejects.toMatchObject({ code: "question_answer_invalid", httpStatus: 400 });
    await expect(h.service.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local", freeAnswer: "both",
    })).rejects.toMatchObject({ code: "question_answer_invalid" });
    await expect(h.service.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, freeAnswer: "something else",
    })).rejects.toMatchObject({ code: "question_answer_invalid" });
    const stillPending = await h.store.getCodeUserQuestion(COMPANY, asked.question.id);
    expect(stillPending?.status).toBe("pending");
  });

  it("expires past the TTL without answering, releasing the run with an explicit timeout", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput({ ttlMs: 60_000 }));
    h.clock.t = T0 + 120_000;
    const expired = await h.service.expireForRun({ companyId: COMPANY, runId: RUN });
    expect(expired).toMatchObject({ expired: true, questionId: asked.question.id, runReleased: true });
    const question = await h.store.getCodeUserQuestion(COMPANY, asked.question.id);
    expect(question?.status).toBe("expired");
    // The whole point: no default, no guess, no "most likely" answer was invented on the user's behalf.
    expect(question?.answer).toBeNull();
    expect(question?.answeredBy).toBeNull();
    expect(h.runEvents).toContain("interrupted:ask_user_timeout");
    await expect(h.service.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
    })).rejects.toMatchObject({ code: "question_not_pending" });
  });

  it("does not expire a question that is still inside its TTL", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput({ ttlMs: 3_600_000 }));
    h.clock.t = T0 + 60_000;
    const result = await h.service.expireForRun({ companyId: COMPANY, runId: RUN });
    expect(result).toMatchObject({ expired: false, runReleased: false });
    const question = await h.store.getCodeUserQuestion(COMPANY, asked.question.id);
    expect(question?.status).toBe("pending");
    expect(h.runEvents).toEqual([`waiting:${asked.question.id}`]);
  });

  it("fails closed when the journal cannot record the answer", async () => {
    const h = harness({ auditFails: true });
    const asked = await h.service.ask(askInput());
    const answerSpy = vi.spyOn(h.store, "answerCodeUserQuestion");
    // The rejection is captured explicitly instead of via `rejects.toThrow`, so the assertion cannot silently
    // pass because a matcher is missing from the harness shim.
    let thrown: unknown = null;
    try {
      await h.service.answer({
        ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
      });
    } catch (error) { thrown = error; }
    expect((thrown as Error | null)?.message).toBe("journal is down");
    // Refused before the state changed: an unrecorded decision must not exist.
    expect(answerSpy).not.toHaveBeenCalled();
    expect((await h.store.getCodeUserQuestion(COMPANY, asked.question.id))?.status).toBe("pending");
  });

  it("is tenant-scoped: another company's question is simply not found", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput());
    await expect(h.service.answer({
      ctx: user, companyId: OTHER_COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
    })).rejects.toMatchObject({ code: "question_not_found", httpStatus: 404 });
    expect(await h.store.getCodeUserQuestion(OTHER_COMPANY, asked.question.id)).toBeNull();
  });

  it("cancels the pending question when the run is stopped, instead of leaving it answerable", async () => {
    const h = harness();
    const asked = await h.service.ask(askInput());
    const cancelled = await h.service.cancelForRun({ companyId: COMPANY, runId: RUN });
    expect(cancelled.cancelled).toBe(1);
    const question = await h.store.getCodeUserQuestion(COMPANY, asked.question.id);
    expect(question?.status).toBe("cancelled");
    expect(h.activity.map((e) => e.kind)).toEqual(["question_asked", "question_cancelled"]);
  });

  it("is idempotent when the same tool call asks twice: one question, not two", async () => {
    const h = harness();
    const first = await h.service.ask(askInput());
    const second = await h.service.ask(askInput());
    expect(second.created).toBe(false);
    expect(second.question.id).toBe(first.question.id);
    // Pausing twice is not harmless: the second call would overwrite the run state after the user answered.
    const pendingCount = (await h.store.getPendingCodeUserQuestionForRun(COMPANY, RUN)) ? 1 : 0;
    expect(pendingCount).toBe(1);
  });
});

describe("security-gate: C9 ask_user — the reconciler must not touch a waiting run", () => {
  function waitingState(): CodeRunStateRecord {
    return {
      companyId: COMPANY,
      runId: RUN,
      projectId: PROJECT,
      sessionId: SESSION,
      status: "waiting_for_user",
      turnIndex: 1,
      lastEventSeq: 4,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      revision: 3,
      startedAt: new Date(T0),
      finishedAt: null,
      details: null,
      dataClassification: "confidential",
      retentionClass: "standard",
    } as unknown as CodeRunStateRecord;
  }

  it("skips it, marks nothing interrupted and never replays the call that asked", async () => {
    const marked: string[] = [];
    const appended: unknown[] = [];
    const replayed: unknown[] = [];
    const reconciler = new CodeRunReconciler({
      log: {
        listStaleRuns: async () => [waitingState()],
        loadTurnBoundary: async () => null,
        markInterrupted: async () => { marked.push("interrupted"); return waitingState(); },
        appendTurn: async (input: unknown) => { appended.push(input); return null as never; },
      } as never,
      now: () => T0,
      replayReadOnly: async (input) => { replayed.push(input); return { ok: true }; },
    });
    const report = await reconciler.reconcileRuns({ now: new Date(T0) });
    expect(report.interrupted).toEqual([]);
    expect(report.recovered).toEqual([]);
    expect(report.skipped).toBe(1);
    expect(marked).toEqual([]);
    expect(appended).toEqual([]);
    expect(replayed).toEqual([]);
  });
});
