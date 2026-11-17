import { ProjectNameAmbiguityError } from "./same-name-project-i18n";
import { AuthenticationError } from "./auth";
import { CodeRunRefusedError } from "./code-run-queue";
import { CodeRunRateLimitedError } from "./code-run-rate-limit";
import { ChatStreamLeaseError } from "./chat-stream-lease";
import { ContextValidationError } from "@npati/shared";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import type { FastifyRequest, FastifyReply } from "fastify";
/** Translate preflight failures without changing cancellation, auth, admission or clarification rules. */
export async function chatStreamStartError(error: unknown, request: FastifyRequest, reply: FastifyReply, signal: AbortSignal, queueTimeoutMs: number, clarify?: (question: string) => Promise<void>) {
    if (error instanceof ChatStreamLeaseError)
        return reply.code(error.status).send({ error: { code: error.code, message: error.message, retryable: error.status === 503 } });
    if (signal.aborted) {
        if (!reply.sent && !reply.raw.destroyed)
            return reply.code(499).send({ error: { code: "CHAT_CANCELLED", message: "Chat request cancelled.", retryable: false } });
        return;
    }
    if (error instanceof AuthenticationError) {
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof CodeRunRateLimitedError) {
        request.log.warn({ code: error.code, scope: error.scope }, "code_run_rate_limited");
        return reply
            .header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
            .code(429)
            .send({
            error: {
                code: "CODE_RUN_RATE_LIMITED",
                message: error.message,
                scope: error.scope,
                limit: error.limit,
                used: error.used,
                retryable: true,
            },
        });
    }
    if (error instanceof CodeRunRefusedError) {
        request.log.warn({ code: error.code }, "code_run_queue_refused");
        return reply
            .header("retry-after", String(Math.max(1, Math.ceil(queueTimeoutMs / 1000))))
            .code(429)
            .send({ error: { code: error.code === "queue_cancelled" ? "CODE_RUN_QUEUE_CANCELLED" : "CODE_RUN_QUEUE_FULL", message: error.message, retryable: true } });
    }
    if (error instanceof ProjectNameAmbiguityError && clarify && !reply.sent)
        return clarify(error.question);
    if (error instanceof ContextValidationError) {
        return reply.code(400).send({ error: { code: "INVALID_CONTEXT", message: error.message } });
    }
    if (error instanceof WorkspaceAccessError) {
        return reply.code(403).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof WorkspaceNotFoundError) {
        return reply.code(404).send({ error: { code: ("code" in error ? error.code : undefined) ?? "WORKSPACE_NOT_FOUND", message: error.message } });
    }
    if (!reply.sent) {
        request.log.error(error);
        const errorMessage = error instanceof Error ? error.message : "Could not start the chat stream.";
        return reply.code(500).send({ error: { code: "STREAM_UNAVAILABLE", message: errorMessage } });
    }
}
