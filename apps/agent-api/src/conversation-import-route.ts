import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import { errorReply } from "./workspace-routes";

// Imported histories are independent neutral chats: external business IDs never grant access.
export function registerConversationImportRoute(app: FastifyInstance, store: WorkspaceStore, auth: AuthProvider) {
  app.post<{ Body: { title: string; messages: Array<{ role: "user" | "assistant" | "system"; content: string }> } }>(
    "/conversations/import", {
      bodyLimit: 20 * 1024 * 1024,
      schema: { body: {
        type: "object", required: ["title", "messages"], additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 1000 },
          messages: { type: "array", maxItems: 100000, items: {
            type: "object", required: ["role", "content"], additionalProperties: false,
            properties: { role: { type: "string", enum: ["user", "assistant", "system"] }, content: { type: "string" } },
          } },
        },
      } },
    }, async (request, reply) => {
      try {
        const context = await auth.authenticate(request);
        const conversation = await store.createNeutralConversation(context, request.body.title);
        try {
          for (const message of request.body.messages) {
            await store.appendNeutralMessage(context, conversation.id, message.role, message.content);
          }
        } catch (error) {
          await store.deleteNeutralConversation(context, conversation.id);
          throw error;
        }
        return reply.code(201).send(conversation);
      } catch (error) { return errorReply(reply, error); }
    }
  );
}
