import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { registerWorkspaceRoutes } from "../apps/agent-api/src/workspace-routes";
import { saveChatProjectCard } from "../apps/agent-api/src/project-chat-cards";
import type { AuthProvider } from "../apps/agent-api/src/auth";

const context: AuthContext = {
  workspaceId: "project-card-workspace",
  userId: "project-card-user",
  permissions: ["workspace:read", "workspace:write"],
};

describe("website cards in chat history", () => {
  it("returns each saved project card when a conversation is reopened", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize(context);
    const conversation = await store.createNeutralConversation(context, "Blog website");
    await store.appendNeutralMessage(context, conversation.id, "user", "Create a blog website");
    const firstReply = await store.appendNeutralMessage(context, conversation.id, "assistant", "Created the blog website. Click Preview.");
    const firstCard = {
      id: "project-blog",
      projectId: "project-blog",
      companyId: "company-blog",
      name: "Blog",
      framework: "HTML/CSS",
      status: "ready",
      lastBuildStatus: "success",
    };
    await saveChatProjectCard(store, context, conversation.id, firstReply.id, firstCard);

    await store.appendNeutralMessage(context, conversation.id, "user", "Create a hosting website");
    const secondReply = await store.appendNeutralMessage(context, conversation.id, "assistant", "Created the hosting website. Click Preview.");
    const secondCard = { ...firstCard, id: "project-hosting", projectId: "project-hosting", name: "Hosting" };
    await saveChatProjectCard(store, context, conversation.id, secondReply.id, secondCard);

    const app = Fastify();
    registerWorkspaceRoutes(app, store, { authenticate: async () => context } as AuthProvider);
    try {
      const response = await app.inject({ method: "GET", url: "/conversations/" + conversation.id });
      expect(response.statusCode).toBe(200);
      expect(response.json().messages).toEqual([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ id: firstReply.id, projectCard: firstCard }),
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ id: secondReply.id, projectCard: secondCard }),
      ]);
    } finally {
      await app.close();
    }
  });
});
it("shows the stored question instead of the technical waiting receipt without leaking another workspace",async()=>{
 const {publicCodeChatReply}=await import("../apps/agent-api/src/project-chat-cards");
 const card={id:"s",projectId:"p",companyId:"c",runId:"r",name:"Website",status:"waiting_for_user",kind:"code_project" as const};
 const store={getCodeRunState:async()=>({workspaceId:context.workspaceId,projectId:"p",sessionId:"s",details:{waitingForUser:{questionId:"q"}}}),getCodeUserQuestion:async()=>({prompt:"Який варіант макета обрати?",projectId:"p",sessionId:"s"})};
 const content="Waiting for the user to answer question q.";
 expect(await publicCodeChatReply(store as never,context,card,content)).toBe("Який варіант макета обрати?");
 const foreign=await publicCodeChatReply(store as never,{...context,workspaceId:"other"},card,content);expect(foreign).not.toContain("q.");expect(foreign).not.toContain("Який варіант");
});
