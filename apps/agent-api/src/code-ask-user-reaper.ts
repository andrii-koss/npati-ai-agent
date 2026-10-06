import type { CodeUserQuestionRecord } from "@npati/workspace";
import { createCodeAskUserService, type CodeAskUserRunState, type CodeAskUserStore } from "./code-ask-user-service";

/**
 * C9: the reaper's view of `code.ask_user` — a question that nobody answered must release its run.
 *
 * A paused run is held by a **row**, not by a process, and that row has a TTL. Without this port the TTL would be
 * decorative: the question would sit `pending` forever, the run would sit `waiting_for_user` forever, and the
 * reconciler would refuse to touch it (correctly — it is not a crash). So expiry is the one thing that ends a
 * pause nobody resolved.
 *
 * Two properties are the whole point, and both are refusals rather than conventions:
 *
 *   - **Nothing is answered.** Expiry moves the question to `expired` and releases the run with
 *     `ask_user_timeout`. No default choice, no "most likely" option, no silent approval: the run stops where the
 *     question was asked. The store's CHECK constraints make that structural — an unanswered question cannot
 *     carry an answer even if this code were wrong.
 *   - **The status change and the run release are one action.** Expiring the row without releasing the run would
 *     leave a run waiting on a question that can never be answered, which is strictly worse than the timeout. Both
 *     happen inside the service's `expireForRun`, so the two backends and the service cannot disagree about it.
 *
 * The port has a genuine **preview**, which is why a reaper dry run reports a count here instead of the
 * `dry_run_preview_unavailable` skip: the questions are simply listed, nothing is written.
 */

export interface CodeUserQuestionReaperDeps {
  store: CodeAskUserStore & {
    listExpiredCodeUserQuestions(input?: { now?: Date; limit?: number }): Promise<CodeUserQuestionRecord[]>;
  };
  /** The run-state writer. Absent → the question still expires, and the report says the run was not released. */
  runState?: CodeAskUserRunState;
  /** Activity sink for `question_expired`, so the timeout is visible where every other run event is. */
  onActivity?: (event: {
    kind: "question_asked" | "question_answered" | "question_expired" | "question_cancelled";
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    questionId: string;
    answeredBy?: string;
  }) => void;
  now?: () => number;
  /** How many questions one pass considers. Bounded so a backlog cannot make a reaper pass unbounded. */
  limit?: number;
}

export interface CodeUserQuestionReaperPort {
  previewCodeUserQuestions(input: { now: number }): Promise<Array<{ companyId: string; runId: string; questionId: string }>>;
  expireCodeUserQuestions(input: { now: number }): Promise<number>;
}

const DEFAULT_LIMIT = 100;

export function createCodeUserQuestionReaperPort(deps: CodeUserQuestionReaperDeps): CodeUserQuestionReaperPort {
  const limit = Number.isFinite(deps.limit) && Number(deps.limit) > 0 ? Math.trunc(Number(deps.limit)) : DEFAULT_LIMIT;
  // One service instance, built over the same store: the expiry rules (TTL check, `expired` transition, the
  // `ask_user_timeout` release) exist in exactly one place, and the reaper does not re-implement them.
  const service = createCodeAskUserService({
    store: deps.store,
    ...(deps.runState ? { runState: deps.runState } : {}),
    ...(deps.onActivity ? { onActivity: deps.onActivity } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  return {
    async previewCodeUserQuestions(input) {
      const expired = await deps.store.listExpiredCodeUserQuestions({ now: new Date(input.now), limit });
      return expired.map((question) => ({
        companyId: question.companyId,
        runId: question.runId,
        questionId: question.id,
      }));
    },

    async expireCodeUserQuestions(input) {
      const now = new Date(input.now);
      const expired = await deps.store.listExpiredCodeUserQuestions({ now, limit });
      let moved = 0;
      for (const question of expired) {
        // Per run, through the service: `expireForRun` re-checks the TTL (so a question that was answered between
        // the scan and this call is left alone), moves the row and releases the run with `ask_user_timeout`.
        const result = await service.expireForRun({ companyId: question.companyId, runId: question.runId, now });
        if (result.expired) moved += 1;
      }
      return moved;
    },
  };
}
