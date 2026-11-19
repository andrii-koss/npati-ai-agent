import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type WorkspaceStore, type AuthContext } from "@npati/workspace";
import { chatPreflightReads } from "../apps/agent-api/src/chat-preflight-reads";
import { registerChatOpenRoutes } from "../apps/agent-api/src/chat-open-routes";
import { saveChatProjectCard } from "../apps/agent-api/src/project-chat-cards";
const owner: AuthContext = { workspaceId: "ws", userId: "owner", permissions: ["workspace:read"] };

it("shares routing reads within one request while retaining store method binding and user isolation", async () => {
  const original = { label: "store", getNeutralConversation: vi.fn(async function(this: { label: string }, ctx: AuthContext, id: string) {
    return { conversation: { id, title: this.label + ctx.userId }, messages: [] };
  }) };
  const store = original as unknown as WorkspaceStore;
  const snapshot = chatPreflightReads(store);
  const reads = await Promise.all(Array.from({ length: 3 }, () => snapshot.getNeutralConversation(owner, "chat")));
  expect(original.getNeutralConversation).toHaveBeenCalledTimes(1); expect(reads[0]?.conversation.title).toBe("storeowner");
  await snapshot.getNeutralConversation({ ...owner, userId: "other" }, "chat");
  await snapshot.getNeutralConversation({ ...owner, permissions: [] }, "chat");
  expect(original.getNeutralConversation).toHaveBeenCalledTimes(3);
  await chatPreflightReads(store).getNeutralConversation(owner, "chat");
  expect(original.getNeutralConversation).toHaveBeenCalledTimes(4);
});

it("uses bounded store pages for open and history instead of full conversations or business-list fanout", async () => {
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  const conversation = await store.createNeutralConversation(owner, "Chat");
  const getPage = vi.fn(async () => ({ conversation, messages: [{ id: "last", role: "assistant" as const, content: "Latest", createdAt: new Date().toISOString() }], earlier: 4990, cursor: "last", hasMore: true }));
  const sidebar = vi.fn(async () => ({ items: [{ ...conversation, businessName: "" }], more: false }));
  Object.assign(store, { getNeutralConversationPage: getPage, listChatSidebarPage: sidebar });
  const full = vi.spyOn(store, "getNeutralConversation").mockRejectedValue(new Error("Unbounded read"));
  const allChats = vi.spyOn(store, "listNeutralConversations").mockRejectedValue(new Error("Unbounded sidebar"));
  const businesses = vi.spyOn(store, "listUserBusinesses");
  const listProcesses = vi.fn(async () => []);
  const app = Fastify(); registerChatOpenRoutes(app, { auth: { authenticate: async () => owner }, store, listProcesses });
  try {
    const opened = await app.inject({ method: "GET", url: `/chat/open?conversationId=${conversation.id}` });
    expect(opened.statusCode).toBe(200); expect(opened.json().conversation.messages[0].content).toBe("Latest");
    listProcesses.mockImplementationOnce(() => new Promise(() => {}));
    const deferred = await app.inject({ method: "GET", url: `/chat/open?conversationId=${conversation.id}&deferProcesses=1` });
    expect(deferred.statusCode).toBe(200); expect(deferred.json().processesDeferred).toBe(true);
    expect(deferred.json().conversation.messages[0].content).toBe("Latest");
    expect(listProcesses).toHaveBeenCalledTimes(1);
    const earlier = await app.inject({ method: "GET", url: `/conversations/${conversation.id}/messages?before=cursor&limit=7` });
    expect(earlier.statusCode).toBe(200); expect(getPage).toHaveBeenLastCalledWith(owner, conversation.id, "cursor", 7);
    await app.inject({ method: "GET", url: "/chat/sidebar?offset=20" });
    expect(sidebar).toHaveBeenLastCalledWith(owner, 20, 20);
    expect(full).not.toHaveBeenCalled(); expect(allChats).not.toHaveBeenCalled();
    // Overview may list businesses, but the sidebar no longer requests each business's conversations.
    expect(businesses.mock.calls.length).toBeLessThanOrEqual(2);
  } finally { await app.close(); }
});

it("includes a project's saved thumbnail once in the first record of a streamed chat opening", async () => {
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  const conversation = await store.createNeutralConversation(owner, "Chat");
  const card = { id: "site", companyId: "company", status: "running", name: "Site", kind: "website_project" as const };
  for (const content of ["Created the site", "Updated the site"]) {
    const message = await store.appendNeutralMessage(owner, conversation.id, "assistant", content);
    await saveChatProjectCard(store, owner, conversation.id, message.id, card);
  }
  const readThumbnail = vi.fn(async () => ({ dataUrl: "data:image/png;base64,c2FtcGxl" }));
  const app = Fastify();
  registerChatOpenRoutes(app, { auth: { authenticate: async () => owner }, store, listProcesses: async () => [], readThumbnail });
  try {
    const response = await app.inject({ method: "GET", url: `/chat/open?conversationId=${conversation.id}&stream=1` });
    expect(response.statusCode).toBe(200);
    const first = JSON.parse(response.body.split("\n")[0]!);
    expect(first.conversation.messages).toHaveLength(2);
    expect(first.projectThumbnails).toEqual({ '["company","site"]': "data:image/png;base64,c2FtcGxl" });
    expect(readThumbnail).toHaveBeenCalledExactlyOnceWith(owner, "company", "site");
  } finally { await app.close(); }
});
