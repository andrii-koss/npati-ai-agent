import type { ChatStreamSend } from "./chat-stream-route-types";
import { conversationTitle } from "./chat-intent-helpers";
import type { ChatStreamRouteDeps } from "./chat-stream-route-types";
import type { FastifyReply } from "fastify";
import type { AuthContext } from "@npati/workspace";
import type { ChatStreamBody } from "./chat-stream-route-types";
import type { NoMemoryEvaluationResult } from "./ephemeral-no-memory-and-rtk";
/** Persist clarification as the actual conversation turn before ending its SSE response. */
export function chatStreamClarification(workspaceStore: ChatStreamRouteDeps["workspaceStore"], auth: AuthContext, reply: FastifyReply, body: ChatStreamBody, message: () => string, memoryPolicy: NoMemoryEvaluationResult) {
    return async (question: string) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "connection": "keep-alive", "x-accel-buffering": "no" });
        let sequence = 0;
        const write = (event: "progress" | "delta" | "result", data: unknown) => {
            if (reply.raw.destroyed)
                return;
            sequence += 1;
            reply.raw.write(`id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        let conversationId: string | undefined;
        if (memoryPolicy.writeAllowed) {
            const conversation = body.conversationId
                ? (await workspaceStore.getNeutralConversation(auth, body.conversationId)).conversation
                : await workspaceStore.createNeutralConversation(auth, conversationTitle(message()));
            if (!body.conversationId)
                write("progress", { type: "conversation_started", conversationId: conversation.id });
            await workspaceStore.appendNeutralMessage(auth, conversation.id, "user", message());
            await workspaceStore.appendNeutralMessage(auth, conversation.id, "assistant", question);
            conversationId = conversation.id;
        }
        write("delta", { delta: question });
        write("result", { message: question, suggestedActions: [], conversationId });
        reply.raw.end();
    };
}
/** Resolve the same conversation for every consumer of this turn. */
export async function chatStreamConversation(workspaceStore: ChatStreamRouteDeps["workspaceStore"], auth: AuthContext, body: ChatStreamBody, message: string, writeAllowed: boolean, send: ChatStreamSend) {
    if (!writeAllowed)
        return undefined;
    if (body.conversationId)
        return (await workspaceStore.getNeutralConversation(auth, body.conversationId)).conversation;
    const created = await workspaceStore.createNeutralConversation(auth, conversationTitle(message));
    await send("progress", { type: "conversation_started", conversationId: created.id });
    return created;
}
