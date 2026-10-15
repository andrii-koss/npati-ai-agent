import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import type { CanonicalPlanExecutorOptions } from "./code-tool-executors-plan";
import { toolNotConfigured } from "./code-tool-executors-common";

/**
 * C9: `code.ask_user`. A dispatch-only adapter as well: the rules (prompt/choice bounds, one question per tool
 * call, the human-only answer, expiry without a guess) live in `code-ask-user-service.ts` and the store behind
 * it, and the *run* is paused by the runner, which is the component that owns the run state and the loop.
 *
 * The port is the service's `ask` alone, so a test can pass the smallest possible fake and so the executor
 * cannot reach any other part of the question lifecycle.
 *
 * Two refusals are the point of this adapter:
 *   - a call with no run (or no tool-call id) is refused with `invalid_arguments`, because a question nobody
 *     can attribute to a run could never be answered or expired;
 *   - the model's arguments are passed to the service unchanged, so the service — not this shim — decides
 *     what a legal question is.
 */
export interface CodeAskUserToolPort {
  ask(input: {
    ctx: { userId?: string | null; externalSubject?: string | null };
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    toolCallId: string;
    prompt: string;
    choices: Array<{ id: string; label: string; description?: string }>;
    allowFreeAnswer?: boolean;
    ttlMs?: number;
    createdBy?: string | null;
  }): Promise<{ question: { id: string; status: string; choices: Array<{ id: string }>; allowFreeAnswer: boolean; expiresAt: Date }; created: boolean; runPaused: boolean }>;
}

export interface CanonicalAskUserExecutorOptions extends CanonicalPlanExecutorOptions {
  /**
   * The question service; absent → `code.ask_user` fails closed with `tool_not_configured` instead of appearing
   * to ask. A published tool with no wiring is the `runCtags` defect class: visible everywhere, unable to work.
   */
  codeAskUserService?: CodeAskUserToolPort;
}

/** A service refusal keeps its own reason code, so the model learns what was wrong instead of seeing "tool failed". */
function rethrowAskUser(error: unknown, tool: string): never {
  const shaped = error as {
    code?: unknown; httpStatus?: unknown; status?: unknown; message?: unknown;
    retryable?: unknown; details?: unknown;
  };
  if (shaped && typeof shaped.code === "string") {
    const details = shaped.details && typeof shaped.details === "object" && !Array.isArray(shaped.details)
      ? shaped.details as Record<string, unknown>
      : {};
    throw new CodeToolError(
      "invalid_arguments",
      typeof shaped.message === "string" ? shaped.message : `The question was refused (${shaped.code})`,
      typeof shaped.httpStatus === "number" ? shaped.httpStatus : (typeof shaped.status === "number" ? shaped.status : 400),
      "validate_arguments",
      shaped.retryable === true,
      tool,
      // The service's own fields are kept and `reason` is the machine code: the human-readable text is already the
      // message, and a reader of `details` needs the code to branch on.
      { ...details, reason: shaped.code },
    );
  }
  throw error;
}

/** `expiresInSeconds` is the schema's unit; the store caps the TTL at 24h, so a bad value can only shorten it. */
function ttlMsFromArgs(args: Record<string, unknown>): number | undefined {
  const seconds = args.expiresInSeconds;
  if (seconds === undefined || seconds === null) return undefined;
  if (!Number.isFinite(seconds) || Number(seconds) <= 0) return undefined;
  return Math.trunc(Number(seconds) * 1000);
}

export function canonicalAskUserExecutors(options: CanonicalAskUserExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    "code.ask_user": async (input) => {
      const tool = input.tool.name;
      if (!options.codeAskUserService) toolNotConfigured(tool, "the user-question service wiring");
      const service = options.codeAskUserService;
      const sessionId = input.sessionId;
      // Both identities come from the invocation envelope. Without them the question could not be found again
      // (no run to pause, no tool call to be idempotent on), so the call is refused rather than half-recorded.
      if (!sessionId || !input.runId || !input.toolCallId) {
        throw new CodeToolError(
          "invalid_arguments",
          `${tool} requires an active run: it pauses the run until a human answers`,
          400,
          "validate_arguments",
          false,
          tool,
        );
      }
      const choices = Array.isArray(input.args.choices)
        ? input.args.choices as Array<{ id: string; label: string; description?: string }>
        : [];
      const ttlMs = ttlMsFromArgs(input.args);
      try {
        const result = await service.ask({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          prompt: String(input.args.prompt ?? ""),
          choices,
          ...(input.args.allowFreeAnswer === undefined ? {} : { allowFreeAnswer: input.args.allowFreeAnswer === true }),
          ...(ttlMs === undefined ? {} : { ttlMs }),
          createdBy: input.ctx.userId ?? null,
        });
        // Metadata only: the question text is the user's to read, and the model must not be handed back a
        // "result" it could mistake for an answer. It learns that the run is paused, and nothing more.
        return {
          questionId: result.question.id,
          status: result.question.status,
          choices: result.question.choices.length,
          allowFreeAnswer: result.question.allowFreeAnswer,
          expiresAt: result.question.expiresAt.toISOString(),
        };
      } catch (error) { rethrowAskUser(error, tool); }
    },
  };
}
