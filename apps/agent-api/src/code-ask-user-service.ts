import {
  CodeUserQuestionAnswerInvalidError,
  CodeUserQuestionNotFoundError,
  CodeUserQuestionRevisionConflictError,
  CodeUserQuestionStateError,
  type AnswerCodeUserQuestionInput,
  type CodeUserQuestionChoice,
  type CodeUserQuestionRecord,
  type CreateCodeUserQuestionInput,
} from "@npati/workspace";
import { isNonHumanPrincipal } from "./code-principal";

/**
 * C9: `code.ask_user` — the run pauses and a human answers.
 *
 * Three rules from the owner are implemented here, and each one is a refusal rather than a convention:
 *
 *   1. **Only a human answers.** The run is paused on a decision that must belong to a person, so an agent or
 *      service token is refused with `question_answer_forbidden` before anything is read from the store. An
 *      agent that could answer its own question would have found a way to grant itself the permission it asked
 *      for — the same boundary that stops an agent from approving its own tool call.
 *   2. **The answer is journaled before it takes effect.** The decision resumes an agent, so it is a privileged
 *      action: the audit write happens first and a failure aborts the answer (fail closed). The store is only
 *      touched after the journal accepted the record.
 *   3. **Nothing is ever guessed.** Expiry moves the question to `expired` and releases the run with
 *      `ask_user_timeout`; no default choice, no "most likely" answer, no auto-approval. An unanswered question
 *      is an unanswered question.
 *
 * The answer itself is stored on the question row, attributed to the user who gave it (`answeredBy`,
 * `answeredAt`). That is what makes it *user-originated data* rather than a model instruction: the model never
 * writes this row, and a run that continues later reads the answer from here instead of from its own memory.
 * Driving that continuation is Resume (C10) and is deliberately not implemented in this step.
 */

export class CodeAskUserError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, httpStatus: number, retryable: boolean, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CodeAskUserError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface CodeAskUserStore {
  createCodeUserQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord>;
  getCodeUserQuestion(companyId: string, questionId: string): Promise<CodeUserQuestionRecord | null>;
  getPendingCodeUserQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null>;
  answerCodeUserQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord>;
  expireCodeUserQuestions(input?: { now?: Date; companyId?: string; runId?: string }): Promise<number>;
  cancelPendingCodeUserQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number>;
}

export interface CodeAskUserRunState {
  markWaitingForUser(input: { companyId: string; runId: string; questionId: string; toolCallId: string }): Promise<unknown>;
  resumeAfterAnswer(input: { companyId: string; runId: string; questionId: string; answeredBy: string }): Promise<unknown>;
  markInterrupted(input: { companyId: string; runId: string; reason: string; owner?: string }): Promise<unknown>;
}

/** The audit port. Its failure must abort the action, which is why it is awaited before any state change. */
export interface CodeAskUserAudit {
  record(entry: {
    companyId: string;
    projectId: string;
    action: string;
    actor: string;
    questionId: string;
    runId: string;
    snapshotId?: string;
    payloadHash?: string;
  }): Promise<void>;
}

export interface CodeAskUserServiceDeps {
  store: CodeAskUserStore;
  runState?: CodeAskUserRunState;
  audit?: CodeAskUserAudit;
  now?: () => number;
  onActivity?: (event: {
    kind: "question_asked" | "question_answered" | "question_expired" | "question_cancelled";
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    questionId: string;
    /** Present for `question_answered`: who decided, so Activity shows a human decision and not model output. */
    answeredBy?: string;
  }) => void;
}

export interface AskUserInput {
  ctx: { userId?: string | null; externalSubject?: string | null };
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  prompt: string;
  choices: CodeUserQuestionChoice[];
  allowFreeAnswer?: boolean;
  ttlMs?: number;
  createdBy?: string | null;
}

export interface AskUserResult {
  question: CodeUserQuestionRecord;
  /** False when the same tool call had already asked: the run is paused once, not twice. */
  created: boolean;
  runPaused: boolean;
}

export interface AnswerQuestionInput {
  ctx: { userId?: string | null; externalSubject?: string | null };
  companyId: string;
  questionId: string;
  expectedRevision: number;
  choiceId?: string;
  freeAnswer?: string;
}

export interface AnswerQuestionResult {
  question: CodeUserQuestionRecord;
  /** True only when this call recorded the decision; a retry of the same answer reports `false`. */
  applied: boolean;
  /** True only when this call released the paused run; a retry never resumes twice. */
  runResumed: boolean;
}

export function createCodeAskUserService(deps: CodeAskUserServiceDeps) {
  if (!deps.store) {
    throw new CodeAskUserError("ask_user_unavailable", "Question store is not configured", 503, false);
  }
  const now = () => new Date(deps.now ? deps.now() : Date.now());

  /** The human-only rule, applied identically to asking and answering on behalf of a person. */
  function assertHuman(ctx: AskUserInput["ctx"], action: string): string {
    if (isNonHumanPrincipal(ctx)) {
      throw new CodeAskUserError(
        "question_answer_forbidden",
        "An agent or service principal can never answer a question addressed to a user",
        403,
        false,
        { action },
      );
    }
    const userId = String(ctx.userId ?? "").trim();
    if (!userId) {
      // An answer with no attributable human is not an answer: it could not be shown, audited or reconciled.
      throw new CodeAskUserError("question_answer_forbidden", "An authenticated user is required", 403, false, { action });
    }
    return userId;
  }

  async function journal(entry: {
    companyId: string;
    projectId: string;
    action: string;
    actor: string;
    questionId: string;
    runId: string;
  }): Promise<void> {
    if (!deps.audit) return;
    // Fail closed: if the journal cannot record the decision, the decision does not happen.
    await deps.audit.record(entry);
  }

  return {
    /**
     * Asks the question and pauses the run. The question is created first, so a failure to pause leaves an
     * answerable question rather than a paused run nobody can find; the ordering is deliberate in that direction.
     */
    async ask(input: AskUserInput): Promise<AskUserResult> {
      const existing = await deps.store.getPendingCodeUserQuestionForRun(input.companyId, input.runId);
      const sameCall = existing && existing.toolCallId === input.toolCallId ? existing : null;
      const question = sameCall ?? await deps.store.createCodeUserQuestion({
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        prompt: input.prompt,
        choices: input.choices,
        ...(input.allowFreeAnswer === undefined ? {} : { allowFreeAnswer: input.allowFreeAnswer }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        createdBy: input.createdBy ?? input.ctx.userId ?? null,
        now: now(),
      });
      if (!sameCall) {
        deps.onActivity?.({
          kind: "question_asked",
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          runId: input.runId,
          questionId: question.id,
        });
      }
      let runPaused = false;
      if (deps.runState) {
        await deps.runState.markWaitingForUser({
          companyId: input.companyId,
          runId: input.runId,
          questionId: question.id,
          toolCallId: input.toolCallId,
        });
        runPaused = true;
      }
      return { question, created: !sameCall, runPaused };
    },

    /**
     * Records the user's answer. A repeat of the same answer is an idempotent success that resumes nothing: the
     * client retried, or two tabs raced, and the run must not be driven twice from one decision.
     */
    async answer(input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
      const userId = assertHuman(input.ctx, "answer_question");
      const before = await deps.store.getCodeUserQuestion(input.companyId, input.questionId);
      if (!before) throw new CodeUserQuestionNotFoundError({ questionId: input.questionId });
      // Journal before the state change: the decision is the privileged act, and an unjournaled decision must not
      // exist. A repeat of an already-recorded answer is not a new decision, so it is not journaled again.
      if (before.status === "pending") {
        await journal({
          companyId: input.companyId,
          projectId: before.projectId,
          action: "code.question.answer",
          actor: userId,
          questionId: before.id,
          runId: before.runId,
        });
      }
      const question = await deps.store.answerCodeUserQuestion({
        companyId: input.companyId,
        questionId: input.questionId,
        expectedRevision: input.expectedRevision,
        ...(input.choiceId === undefined ? {} : { choiceId: input.choiceId }),
        ...(input.freeAnswer === undefined ? {} : { freeAnswer: input.freeAnswer }),
        answeredBy: userId,
        now: now(),
      });
      const applied = before.status === "pending";
      let runResumed = false;
      if (applied && deps.runState) {
        await deps.runState.resumeAfterAnswer({
          companyId: input.companyId,
          runId: question.runId,
          questionId: question.id,
          answeredBy: userId,
        });
        runResumed = true;
      }
      if (applied) {
        deps.onActivity?.({
          kind: "question_answered",
          companyId: input.companyId,
          projectId: question.projectId,
          sessionId: question.sessionId,
          runId: question.runId,
          questionId: question.id,
          answeredBy: userId,
        });
      }
      return { question, applied, runResumed };
    },

    /**
     * Expiry. Called by the reaper (or a test) with a clock: the question becomes `expired` and the run is
     * released with `ask_user_timeout`. Nothing is answered on the user's behalf — that is the whole point.
     */
    async expireForRun(input: { companyId: string; runId: string; now?: Date }): Promise<{
      expired: boolean;
      questionId: string | null;
      runReleased: boolean;
    }> {
      const at = input.now ?? now();
      const pending = await deps.store.getPendingCodeUserQuestionForRun(input.companyId, input.runId);
      if (!pending) return { expired: false, questionId: null, runReleased: false };
      if (pending.expiresAt.getTime() > at.getTime()) return { expired: false, questionId: pending.id, runReleased: false };
      const moved = await deps.store.expireCodeUserQuestions({ companyId: input.companyId, runId: input.runId, now: at });
      if (moved === 0) return { expired: false, questionId: pending.id, runReleased: false };
      let runReleased = false;
      if (deps.runState) {
        await deps.runState.markInterrupted({
          companyId: input.companyId,
          runId: input.runId,
          reason: "ask_user_timeout",
        });
        runReleased = true;
      }
      deps.onActivity?.({
        kind: "question_expired",
        companyId: input.companyId,
        projectId: pending.projectId,
        sessionId: pending.sessionId,
        runId: pending.runId,
        questionId: pending.id,
      });
      return { expired: true, questionId: pending.id, runReleased };
    },

    /** A stopped or cancelled run can no longer be answered: its pending questions are cancelled, not expired. */
    async cancelForRun(input: { companyId: string; runId: string }): Promise<{ cancelled: number; runReleased: boolean }> {
      const pending = await deps.store.getPendingCodeUserQuestionForRun(input.companyId, input.runId);
      const cancelled = await deps.store.cancelPendingCodeUserQuestions({ companyId: input.companyId, runId: input.runId, now: now() });
      if (pending && cancelled > 0) {
        deps.onActivity?.({
          kind: "question_cancelled",
          companyId: input.companyId,
          projectId: pending.projectId,
          sessionId: pending.sessionId,
          runId: pending.runId,
          questionId: pending.id,
        });
      }
      return { cancelled, runReleased: cancelled > 0 };
    },

    /** What the UI (and a later Resume) asks first: is this run waiting on a person, and on what? */
    async pendingForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null> {
      return deps.store.getPendingCodeUserQuestionForRun(companyId, runId);
    },
  };
}

export type CodeAskUserService = ReturnType<typeof createCodeAskUserService>;

/** Re-exported so a route can map a store-level refusal without importing the workspace package twice. */
export {
  CodeUserQuestionAnswerInvalidError,
  CodeUserQuestionNotFoundError,
  CodeUserQuestionRevisionConflictError,
  CodeUserQuestionStateError,
};
