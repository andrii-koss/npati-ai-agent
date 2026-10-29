import { describe, expect, it } from "vitest";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import type { DevelopmentProcess } from "@npati/shared";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { chatProcess } from "../apps/agent-api/src/chat-open-routes";

const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const user = (id: string, permissions = ["workspace:read", "workspace:write", "business:manage", "tools:execute"]): AuthContext => ({ userId: id, workspaceId: "boundary-workspace", permissions });
const ai: AIEngine = {
  supportsNativeTools: () => true,
  async chat(request) {
    if (request.tools?.[0]?.function.name === "npati_classify_chat_intent") {
      const args = { intent: "CHAT", confidence: 0.99, targets: [], entityRead: null, coreCapability: null, coreMutation: false, assignsWorkToCompanyAgent: false, format: "none", reply: "Приватна відповідь." };
      return { content: "", toolCalls: [{ id: "route", type: "function", function: { name: "npati_classify_chat_intent", arguments: JSON.stringify(args) } }] };
    }
    return { content: "Відповідь." };
  },
  async *stream() { yield "Відповідь."; },
  listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
  searchMemory: async () => [], saveMemory: async () => undefined,
  getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
};

describe("chat open boundaries", () => {
  it("withholds the workspace overview without workspace:read and never returns another user's chat", async () => {
    const store = new InMemoryWorkspaceStore();
    const owner = user("owner"), limited = user("limited", ["workspace:write"]);
    const chat = await store.createNeutralConversation(owner, "Owner only");
    await store.appendNeutralMessage(owner, chat.id, "user", "Owner secret");
    let current = limited;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => current }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "GET", url: `/chat/open?conversationId=${chat.id}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ overview: null, conversation: null });
      expect(response.body).not.toContain("Owner secret");
      expect((await app.inject({ method: "GET", url: `/conversations/${chat.id}/messages` })).statusCode).toBeGreaterThanOrEqual(403);
      current = owner;
      expect((await app.inject({ method: "GET", url: `/chat/open?conversationId=${chat.id}` })).json().conversation.messages[0].content).toBe("Owner secret");
    } finally { await app.close(); }
  });

  it("keeps a private request out of the sidebar and out of an opened chat", async () => {
    const store = new InMemoryWorkspaceStore();
    const owner = user("private-owner");
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => owner }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Приватне питання", contextType: "none", noMemory: true } });
      expect(response.statusCode).toBe(200);
      const sidebar = (await app.inject({ method: "GET", url: "/chat/sidebar" })).json() as { items: unknown[] };
      expect(sidebar.items).toHaveLength(0);
      expect((await app.inject({ method: "GET", url: "/chat/open" })).body).not.toContain("Приватне питання");
    } finally { await app.close(); }
  });

  it("sends a chat its own processes, including one awaiting approval, and only running processes of other chats", () => {
    const process = (id: string, conversationId: string, status: DevelopmentProcess["status"]) => ({ id, conversationId, parentConversationId: "parent-" + conversationId, status }) as DevelopmentProcess;
    expect(chatProcess(process("own", "chat", "awaiting_approval" as DevelopmentProcess["status"]), "chat")).toBe(true);
    expect(chatProcess(process("own-done", "chat", "completed"), "chat")).toBe(true);
    expect(chatProcess(process("other-done", "other", "completed"), "chat")).toBe(false);
    expect(chatProcess(process("other-running", "other", "running"), "chat")).toBe(true);
    expect(chatProcess(process("child", "child", "completed"), "parent-child")).toBe(true);
  });
});
