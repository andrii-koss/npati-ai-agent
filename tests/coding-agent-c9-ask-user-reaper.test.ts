import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { createCodeAskUserService, type CodeAskUserStore } from "../apps/agent-api/src/code-ask-user-service";
import { createCodeUserQuestionReaperPort } from "../apps/agent-api/src/code-ask-user-reaper";
import { CodeReaper, type CodeReaperPorts } from "../apps/agent-api/src/code-reaper";

/**
 * C9 security-gate: the question expires, and the run is released without an answer.
 *
 * A paused run is held by a **row** with a TTL, not by a process. Without expiry the TTL would be decorative:
 * the question would stay `pending` and the run `waiting_for_user` forever, and the reconciler would keep
 * refusing to touch it (correctly — it is not a crash). So this file pins the one thing that ends an unresolved
 * pause, and it pins the refusals around it:
 *
 *   - expiry writes **no** answer: no default choice, no "most likely" option, no silent approval;
 *   - the run is released with the explicit reason `ask_user_timeout`, not `completed` and not `lease_expired`;
 *   - a dry run reports the expired questions for real (this step *has* a preview), so it is never reported as
 *     an unavailable preview or as "nothing to clean";
 *   - the pause and the answer survive a restart, and a repeated answer resumes the run exactly once.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";
const RUN = "run-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const user: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:read", "workspace:write"] };
const agent: AuthContext = { userId: "agent:bot-1", workspaceId: "ws-1", permissions: ["workspace:read", "workspace:write"] };
const servicePrincipal: AuthContext = {
  userId: "user-1", externalSubject: "service:automation", workspaceId: "ws-1", permissions: ["workspace:write"],
};

/**
 * A real in-memory store plus real run-state effects: the question rules live in the shared store, and the tests
 * below go through them rather than through a hand-written fake, so "the database guarantees it" cannot mean
 * "only the fake guarantees it".
 */
function harness() {
  const store = new InMemoryWorkspaceStore();
  const clock = { t: T0 };
  const runEvents: string[] = [];
  const activity: Array<{ kind: string; questionId: string }> = [];
  const runState = {
    markWaitingForUser: async (input: { questionId: string }) => { runEvents.push(`waiting:${input.questionId}`); return {}; },
    resumeAfterAnswer: async (input: { questionId: string }) => { runEvents.push(`resume:${input.questionId}`); return {}; },
    markInterrupted: async (input: { reason: string }) => { runEvents.push(`interrupted:${input.reason}`); return {}; },
  };
  const buildService = () => createCodeAskUserService({
    store: store as unknown as CodeAskUserStore,
    runState,
    now: () => clock.t,
    onActivity: (event) => activity.push(event as { kind: string; questionId: string }),
  });
  const buildReaperPort = () => createCodeUserQuestionReaperPort({
    store: store as unknown as Parameters<typeof createCodeUserQuestionReaperPort>[0]["store"],
    runState,
    now: () => clock.t,
    onActivity: (event) => activity.push(event as { kind: string; questionId: string }),
  });
  return { store, clock, runEvents, activity, service: buildService(), restartService: buildService, reaperPort: buildReaperPort() };
}

async function ask(service: ReturnType<typeof harness>["service"], ttlMs: number) {
  return service.ask({
    ctx: user,
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    toolCallId: "call-1",
    prompt: "Which database should the migration target?",
    choices: [{ id: "local", label: "Local sandbox" }, { id: "dev", label: "Dev database" }],
    ttlMs,
  });
}

describe("security-gate: C9 ask_user expiry — the run is released, never answered", () => {
  it("expires the question and releases the run with ask_user_timeout, writing no answer", async () => {
    const h = harness();
    const asked = await ask(h.service, 60_000);
    h.clock.t = T0 + 120_000;

    const moved = await h.reaperPort.expireCodeUserQuestions({ now: h.clock.t });
    expect(moved).toBe(1);

    const question = await h.store.getCodeUserQuestion(COMPANY, asked.question.id);
    expect(question?.status).toBe("expired");
    // The whole point: nothing was invented on the user's behalf, and the store's CHECK constraints make that
    // structural rather than a convention of this code path.
    expect(question?.answer).toBeNull();
    expect(question?.answeredBy).toBeNull();
    expect(question?.answeredAt).toBeNull();
    expect(h.runEvents).toEqual([`waiting:${asked.question.id}`, "interrupted:ask_user_timeout"]);
    expect(h.activity.map((event) => event.kind)).toEqual(["question_asked", "question_expired"]);
    // Expired is not answerable: a late answer is refused, so the run cannot be resumed after its release.
    await expect(h.service.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
    })).rejects.toMatchObject({ code: "question_not_pending", httpStatus: 409 });
  });

  it("leaves a question inside its TTL alone, and reports nothing to expire", async () => {
    const h = harness();
    const asked = await ask(h.service, 3_600_000);
    h.clock.t = T0 + 60_000;

    // The preview is real, so a dry run reports the same zero the real pass would.
    expect(await h.reaperPort.previewCodeUserQuestions({ now: h.clock.t })).toEqual([]);
    expect(await h.reaperPort.expireCodeUserQuestions({ now: h.clock.t })).toBe(0);

    const question = await h.store.getCodeUserQuestion(COMPANY, asked.question.id);
    expect(question?.status).toBe("pending");
    expect(h.runEvents).toEqual([`waiting:${asked.question.id}`]);
  });

  it("previews exactly the questions a real pass would expire, and is idempotent", async () => {
    const h = harness();
    const first = await ask(h.service, 60_000);
    h.clock.t = T0 + 120_000;

    const preview = await h.reaperPort.previewCodeUserQuestions({ now: h.clock.t });
    expect(preview).toEqual([{ companyId: COMPANY, runId: RUN, questionId: first.question.id }]);
    // The preview changed nothing at all.
    expect((await h.store.getCodeUserQuestion(COMPANY, first.question.id))?.status).toBe("pending");

    expect(await h.reaperPort.expireCodeUserQuestions({ now: h.clock.t })).toBe(1);
    // A second pass finds nothing: the question left `pending`, so it can neither be expired nor released twice.
    expect(await h.reaperPort.previewCodeUserQuestions({ now: h.clock.t })).toEqual([]);
    expect(await h.reaperPort.expireCodeUserQuestions({ now: h.clock.t })).toBe(0);
    expect(h.runEvents.filter((event) => event.startsWith("interrupted:"))).toHaveLength(1);
  });

  it("refuses a late answer instead of resuming a run that was already released", async () => {
    const h = harness();
    const asked = await ask(h.service, 60_000);
    h.clock.t = T0 + 120_000;
    await h.reaperPort.expireCodeUserQuestions({ now: h.clock.t });

    let thrown: unknown = null;
    try {
      await h.restartService().answer({
        ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "dev",
      });
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "question_not_pending" });
    // Still exactly one release: the refused answer resumed nothing.
    expect(h.runEvents).toEqual([`waiting:${asked.question.id}`, "interrupted:ask_user_timeout"]);
  });
});

describe("security-gate: C9 ask_user survives a restart and resumes exactly once", () => {
  it("keeps the question pending across a new service instance and answers it once", async () => {
    const h = harness();
    const asked = await ask(h.service, 3_600_000);

    // A restarted process shares only the store, so a second service over it is the honest simulation.
    const afterRestart = h.restartService();
    const pending = await afterRestart.pendingForRun(COMPANY, RUN);
    expect(pending?.id).toBe(asked.question.id);
    expect(pending?.status).toBe("pending");

    const answered = await afterRestart.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
    });
    expect(answered.applied).toBe(true);
    expect(answered.runResumed).toBe(true);
    expect(answered.question.answer).toEqual({ choiceId: "local" });
    expect(answered.question.answeredBy).toBe("user-1");

    // A repeated submission of the same answer is an idempotent no-op: the run is not driven twice from one
    // decision.
    const repeated = await afterRestart.answer({
      ctx: user, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
    });
    expect(repeated.applied).toBe(false);
    expect(repeated.runResumed).toBe(false);
    expect(h.runEvents).toEqual([`waiting:${asked.question.id}`, `resume:${asked.question.id}`]);
  });

  it("refuses an agent or service principal before anything is read from the store", async () => {
    const h = harness();
    const asked = await ask(h.service, 3_600_000);
    const answerSpy = vi.spyOn(h.store, "answerCodeUserQuestion");
    for (const principal of [agent, servicePrincipal]) {
      await expect(h.service.answer({
        ctx: principal, companyId: COMPANY, questionId: asked.question.id, expectedRevision: 1, choiceId: "local",
      })).rejects.toMatchObject({ code: "question_answer_forbidden", httpStatus: 403 });
    }
    // Refused before the store was touched: an agent must not be able to answer the question it asked itself.
    expect(answerSpy).not.toHaveBeenCalled();
    expect(h.runEvents).toEqual([`waiting:${asked.question.id}`]);
  });
});

describe("security-gate: C9 reaper step — expire_user_questions", () => {
  function reaper(options: Partial<CodeReaperPorts>) {
    const instance = new CodeReaper({
      intervalMs: 60_000,
      toolCallNoProgressMs: 60_000,
      maxRunMinutes: 30,
      now: () => T0,
      activity: { record: () => undefined },
      ...options,
    });
    return { instance };
  }

  it("reports the expired questions it would release in a dry run, releasing nothing", async () => {
    const previewCodeUserQuestions = vi.fn(async () => [{ companyId: COMPANY, runId: RUN, questionId: "q-1" }]);
    const expireCodeUserQuestions = vi.fn(async () => 0);
    const { instance } = reaper({ userQuestions: { previewCodeUserQuestions, expireCodeUserQuestions } });

    const summary = await instance.run({ dryRun: true });
    expect(summary.cleaned.expiredUserQuestions).toBe(1);
    expect(previewCodeUserQuestions).toHaveBeenCalledTimes(1);
    // A dry run mutates nothing, and this step has a real preview, so it is not reported as unavailable.
    expect(expireCodeUserQuestions).not.toHaveBeenCalled();
    expect(summary.skipped.map((entry) => entry.step)).not.toContain("expire_user_questions");
  });

  it("expires for real outside a dry run and reports the count", async () => {
    const previewCodeUserQuestions = vi.fn(async () => []);
    const expireCodeUserQuestions = vi.fn(async () => 2);
    const { instance } = reaper({ userQuestions: { previewCodeUserQuestions, expireCodeUserQuestions } });

    const summary = await instance.run();
    expect(summary.cleaned.expiredUserQuestions).toBe(2);
    expect(expireCodeUserQuestions).toHaveBeenCalledTimes(1);
    expect(previewCodeUserQuestions).not.toHaveBeenCalled();
    expect(summary.errors).toEqual([]);
  });

  it("marks the step as skipped, not clean, when the port is unavailable or the pass fails", async () => {
    const unavailable = await reaper({}).instance.run();
    // `toContainEqual`, not `toContain`: vitest's `toContain` compares by identity, so an object literal
    // can never be found in an array the implementation built, and the assertion would fail even though
    // the entry is exactly this one. The check is the same two fields; only the comparison is deep.
    expect(unavailable.skipped).toContainEqual({ step: "expire_user_questions", reason: "port_unavailable" });
    expect(unavailable.cleaned.expiredUserQuestions).toBe(0);

    // A failing expiry is reported as an error for this step and never turns into "nothing to expire", and it
    // does not stop the other steps.
    const failing = await reaper({
      userQuestions: {
        previewCodeUserQuestions: async () => [],
        expireCodeUserQuestions: async () => { throw new Error("question store is down"); },
      },
    }).instance.run();
    expect(failing.errors).toContainEqual({ step: "expire_user_questions", message: "question store is down" });
    expect(failing.cleaned.expiredUserQuestions).toBe(0);
  });
});
