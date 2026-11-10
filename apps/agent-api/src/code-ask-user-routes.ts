import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import {
  CodeUserQuestionAnswerInvalidError,
  CodeUserQuestionNotFoundError,
  CodeUserQuestionRevisionConflictError,
  CodeUserQuestionStateError,
} from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import type { CodeAuditPort } from "./code-project-trust";
import { CodeAskUserError, createCodeAskUserService, type CodeAskUserService } from "./code-ask-user-service";

/**
 * C9: the surface a person uses to answer a paused run.
 *
 * Two endpoints, and one shape decision that matters: the answer is addressed by
 * `sessions/:sessionId/questions/:questionId`, so answering is scoped to the session as well as the company.
 * Without that, a question id from one session could be answered through another session's path within the same
 * company — the tenant boundary would hold while the session boundary did not, which is exactly the sort of
 * half-checked path C7 found in the UI routes.
 *
 * The answer body is `{ revision, choiceId?, freeAnswer? }`: exactly one of the two answer forms, and the
 * revision the user was shown. `questionId` doubles as the idempotency key for a retried submission, which the
 * service enforces (a repeat of the same answer resumes nothing).
 *
 * Refusal codes are part of the contract because the card explains them:
 *   unauthorized · invalid_arguments · permission_denied · action_not_mapped · permission_action_mismatch
 *   question_not_found · question_not_pending · question_revision_conflict · question_answer_invalid
 *   question_answer_forbidden · ask_user_unavailable · code_question_request_failed
 */

export class CodeAskUserRouteError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeAskUserRouteError";
    this.retryable = retryable;
  }
}

export const CODE_ASK_USER_ACTIONS = Object.freeze({
  questionRead: "code.question.read",
  questionAnswer: "code.question.answer",
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  question_not_found: 404,
  question_not_pending: 409,
  question_revision_conflict: 409,
  question_answer_invalid: 400,
  question_answer_forbidden: 403,
  ask_user_unavailable: 503,
  code_question_request_failed: 500,
};

export interface CodeAskUserRouteStore {
  getPendingCodeUserQuestionForRun: WorkspaceStore["getPendingCodeUserQuestionForRun"];
  getCodeUserQuestion: WorkspaceStore["getCodeUserQuestion"];
  createCodeUserQuestion: WorkspaceStore["createCodeUserQuestion"];
  answerCodeUserQuestion: WorkspaceStore["answerCodeUserQuestion"];
  expireCodeUserQuestions: WorkspaceStore["expireCodeUserQuestions"];
  cancelPendingCodeUserQuestions: WorkspaceStore["cancelPendingCodeUserQuestions"];
}

export interface CodeAskUserRouteDeps {
  store: CodeAskUserRouteStore;
  /** The recorded status of a run, so a chat can tell a stopped run from one still working. */
  runStatus?(companyId: string, runId: string): Promise<string | undefined>;
  getAuthContext(request: unknown): AuthContext | null;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  audit?: CodeAuditPort;
  runState?: {
    markWaitingForUser(input: { companyId: string; runId: string; questionId: string; toolCallId: string }): Promise<unknown>;
    resumeAfterAnswer(input: { companyId: string; runId: string; questionId: string; answeredBy: string }): Promise<unknown>;
    markInterrupted(input: { companyId: string; runId: string; reason: string; owner?: string }): Promise<unknown>;
  };
  onActivity?: (event: {
    kind: "question_asked" | "question_answered" | "question_expired" | "question_cancelled";
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    questionId: string;
    answeredBy?: string;
  }) => void;
}

interface CompanyParams { companyId: string }
interface RunParams extends CompanyParams { runId: string }
interface QuestionParams extends CompanyParams { sessionId: string; questionId: string }

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof CodeUserQuestionNotFoundError) {
    return reply.code(404).send({ ...withApiVersion({}), error: { code: error.code, message: error.message, retryable: false, details: error.details } });
  }
  if (error instanceof CodeUserQuestionAnswerInvalidError
    || error instanceof CodeUserQuestionStateError
    || error instanceof CodeUserQuestionRevisionConflictError) {
    return reply.code(error.httpStatus).send({ ...withApiVersion({}), error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details } });
  }
  if (error instanceof CodeAskUserError) {
    return reply.code(error.httpStatus).send({ ...withApiVersion({}), error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details } });
  }
  if (error instanceof CodeAskUserRouteError) {
    return reply.code(error.httpStatus).send({ ...withApiVersion({}), error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details } });
  }
  if (error instanceof AuthenticationError) {
    return reply.code(401).send({ ...withApiVersion({}), error: { code: "unauthorized", message: error.message, retryable: false } });
  }
  const code = (error as { code?: string }).code ?? "code_question_request_failed";
  const status = ROUTE_ERROR_STATUS[code] ?? 500;
  return reply.code(status).send({
    ...withApiVersion({}),
    error: { code, message: (error as Error).message, retryable: (error as { retryable?: boolean }).retryable === true },
  });
}

export async function registerCodeAskUserRoutes(instance: FastifyInstance, deps: CodeAskUserRouteDeps) {
  const contextOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    return context;
  };

  const authorize = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = contextOrFail(request);
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  const service: CodeAskUserService = createCodeAskUserService({
    store: deps.store,
    ...(deps.runState ? { runState: deps.runState } : {}),
    ...(deps.audit
      ? {
          audit: {
            // The journal is the existing C1c port: the answer is journaled before it takes effect, and a journal
            // outage refuses the answer rather than resuming an agent unrecorded.
            record: async (entry) => {
              await deps.audit!.record({
                ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
                action: entry.action,
                actor: entry.actor,
                companyId: entry.companyId,
                resourceType: "code_user_question",
                resourceId: entry.questionId,
                decision: "allow",
                metadata: { runId: entry.runId, projectId: entry.projectId },
              });
            },
          },
        }
      : {}),
    ...(deps.onActivity ? { onActivity: deps.onActivity } : {}),
  });

  /** The question a run is waiting on, if any. `status: "none"` is the honest answer, not an empty question. */
  instance.get<{ Params: RunParams }>(
    "/companies/:companyId/code/runs/:runId/question",
    async (request, reply) => {
      try {
        const { companyId, runId } = request.params;
        await authorize(request, companyId, CODE_ASK_USER_ACTIONS.questionRead);
        const question = await service.pendingForRun(companyId, runId);
        if (!question) return reply.send(withApiVersion({ status: "ok", waiting: false, question: null, runStatus: await deps.runStatus?.(companyId, runId) ?? null }));
        return reply.send(withApiVersion({
          status: "ok",
          waiting: true,
          question: {
            id: question.id,
            sessionId: question.sessionId,
            runId: question.runId,
            prompt: question.prompt,
            choices: question.choices,
            allowFreeAnswer: question.allowFreeAnswer,
            revision: question.revision,
            createdAt: question.createdAt,
            expiresAt: question.expiresAt,
          },
        }));
      } catch (error) { return fail(reply, error); }
    },
  );

  /**
   * The user's answer. The path carries both the session and the question, and the session is checked against
   * the stored row before the answer is applied.
   */
  instance.post<{
    Params: QuestionParams;
    Body: { revision?: number; choiceId?: string; freeAnswer?: string };
  }>(
    "/companies/:companyId/code/sessions/:sessionId/questions/:questionId/answer",
    async (request, reply) => {
      try {
        const { companyId, sessionId, questionId } = request.params;
        const ctx = await authorize(request, companyId, CODE_ASK_USER_ACTIONS.questionAnswer);
        const body = request.body ?? {};
        const revision = Number(body.revision);
        if (!Number.isInteger(revision) || revision < 1) {
          throw new CodeAskUserRouteError("invalid_arguments", "revision is required", 400);
        }
        const question = await deps.store.getCodeUserQuestion(companyId, questionId);
        if (!question) throw new CodeUserQuestionNotFoundError({ questionId });
        if (question.sessionId !== sessionId) {
          // Answering through another session's path is refused *as not found*, so the response cannot be used to
          // learn whether a question id exists elsewhere in the same company.
          throw new CodeUserQuestionNotFoundError({ questionId });
        }
        const result = await service.answer({
          ctx,
          companyId,
          questionId,
          expectedRevision: revision,
          ...(body.choiceId === undefined ? {} : { choiceId: body.choiceId }),
          ...(body.freeAnswer === undefined ? {} : { freeAnswer: body.freeAnswer }),
        });
        return reply.send(withApiVersion({
          status: "ok",
          applied: result.applied,
          runResumed: result.runResumed,
          question: {
            id: result.question.id,
            status: result.question.status,
            revision: result.question.revision,
            answer: result.question.answer,
            answeredBy: result.question.answeredBy,
            answeredAt: result.question.answeredAt,
          },
        }));
      } catch (error) { return fail(reply, error); }
    },
  );
}
