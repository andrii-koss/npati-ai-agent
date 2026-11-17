import type { ChatStreamSend } from "./chat-stream-route-types";
import type { FastifyBaseLogger } from "fastify";
import { publicCompanyRunMessage } from "./chat-public-errors";
import { browserScreenshotAttachments } from "./chat-browser-screenshots";
import { companyRunTelemetryHeaders } from "./company-runtime";
import { NoMemoryEvaluationResult } from "./ephemeral-no-memory-and-rtk";
import { ResearchProgressListener } from "@npati/web-research";
import { AuthContext } from "@npati/workspace";
import type { ChatStreamRouteDeps } from "./chat-stream-route-types";
import type { Company, Conversation } from "@npati/workspace";
/** Execute and persist the delegated company branch through the existing runtime. */
export async function streamCompanyRun(deps: ChatStreamRouteDeps, input: {
    auth: AuthContext;
    company: Company;
    delegationProjectId?: string | null;
    chatConversation: () => Promise<Conversation | undefined>;
    message: string;
    progress: ResearchProgressListener;
    memoryPolicy: NoMemoryEvaluationResult;
    signal: AbortSignal;
    idempotencyKey?: string;
    log: FastifyBaseLogger;
    activeContext: unknown;
    send: ChatStreamSend;
}) {
    const { workspaceStore, companyRuntime, persistAutomaticCompanyMemory, boundedResponseChunks } = deps;
    const { auth, company, delegationProjectId, chatConversation, message, progress, memoryPolicy, signal, idempotencyKey, log, activeContext, send } = input;
    const delegationProject = delegationProjectId ? await workspaceStore.getProject(auth, company.id, delegationProjectId).catch(() => undefined) : undefined;
    const conversation = await chatConversation();
    if (conversation)
        await workspaceStore.appendNeutralMessage(auth, conversation.id, "user", message);
    progress({ type: "final_generation_started" });
    const runResult = await companyRuntime.execute(auth, company.id, { task: message, noMemory: memoryPolicy.noMemoryActive, memoryScope: { sessionId: conversation?.id }, conversationId: conversation?.id, projectId: delegationProject?.id }, (idempotencyKey) || `stream-${Date.now()}`, signal);
    if (runResult.run.errorCode === "SECURITY_GUARDRAIL_BLOCKED") {
        send("error", { error: { code: runResult.run.errorCode, message: runResult.run.errorMessage } });
    }
    else {
        progress({ type: "final_generation_completed" });
        const automaticMemory = await persistAutomaticCompanyMemory(auth, company.id, runResult.run.id, message, runResult.run.status, memoryPolicy.noMemoryActive);
        const responseMessage = publicCompanyRunMessage(runResult.run.result, runResult.run.errorMessage, message, runResult.run.errorCode)
            + await browserScreenshotAttachments({ store: workspaceStore, auth, companyId: company.id, runId: runResult.run.id, conversationId: conversation?.id, browser: deps.browserTool, chatFiles: deps.chatFiles, log: log });
        if (conversation)
            await workspaceStore.appendNeutralMessage(auth, conversation.id, "assistant", responseMessage);
        for (const delta of boundedResponseChunks(responseMessage))
            send("delta", { delta });
        await send("result", {
            message: responseMessage,
            suggestedActions: [],
            conversationId: conversation?.id,
            activeContext: activeContext,
            companyRunId: runResult.run.id,
            telemetry: companyRunTelemetryHeaders(runResult),
            automaticMemory,
        });
    }
}
