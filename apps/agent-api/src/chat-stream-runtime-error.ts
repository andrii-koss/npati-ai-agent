import type { ChatStreamSend } from "./chat-stream-route-types";
import type { ChatStreamBody } from "./chat-stream-route-types";
import { publicChatError } from "./chat-public-errors";
import { ProjectOrchestrationError } from "./project-orchestrator";
import { AdmissionError } from "./resilience-admission-queue";
import { SecurityPolicyViolation } from "./security-guardrails";
import { StorageRateLimitError } from "./storage-protection";
import { ContextValidationError } from "@npati/shared";
import { WorkspaceAccessError } from "@npati/workspace";
import type { ChatStreamRouteDeps } from "./chat-stream-route-types";
import type { FastifyBaseLogger } from "fastify";
import type { AuthContext } from "@npati/workspace";
import type { ResearchProgressListener } from "@npati/web-research";
/** Publish a localized runtime failure; never manufacture a completed result. */
export async function chatStreamRuntimeError(deps: ChatStreamRouteDeps, error: unknown, auth: AuthContext, body: ChatStreamBody, log: FastifyBaseLogger, progress: ResearchProgressListener, send: ChatStreamSend) {
    const { workspaceStore, getAIContext } = deps;
    log.error(error);
    const expected = error instanceof WorkspaceAccessError || error instanceof StorageRateLimitError || error instanceof ContextValidationError || error instanceof SecurityPolicyViolation || error instanceof AdmissionError || error instanceof ProjectOrchestrationError;
    const route = expected ? undefined : await getAIContext(auth).then((ai) => ai.model).catch(() => undefined);
    // A voice message usually comes without text: the person's language is then read from their earlier messages,
    // so the failure is not in English for a Ukrainian chat (V6 step 14).
    const languageSource = body.message?.trim() ? body.message : body.conversationId
        ? await workspaceStore.getNeutralConversation(auth, body.conversationId).then((c) => c.messages.filter((m) => m.role === "user" && m.content.trim() && !/^(?:🎤|📷|📄)/u.test(m.content)).slice(-3).map((m) => m.content).join("\n")).catch(() => "")
        : "";
    const detail = expected ? error.message : publicChatError(error, route, languageSource ?? "");
    progress({ type: "final_generation_failed", error: detail });
    send("error", { error: { code: expected ? ("code" in error ? error.code : undefined) ?? "ERROR" : "AGENT_UNAVAILABLE", message: detail } });
}
