import { describe, expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { researchEvidenceContext } from "../apps/agent-api/src/chat-research-evidence";

const alice: AuthContext = { userId: "evidence-alice", workspaceId: "evidence-ws", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
const bob: AuthContext = { userId: "evidence-bob", workspaceId: "evidence-ws", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const evidence = { companyId: null, tool: "web_fetch", kind: "url_analysis", query: "https://store.google.com/ navigation",
  sources: [{ url: "https://store.google.com/", title: "Change your region" }], evidenceExcerpt: "Region selector page only." };

describe("conversation research evidence store", () => {
  it("keeps evidence inside its own conversation and owner", async () => {
    const store = new InMemoryWorkspaceStore();
    const chatA = await store.createNeutralConversation(alice, "Chat A");
    const chatB = await store.createNeutralConversation(alice, "Chat B");
    const bobChat = await store.createNeutralConversation(bob, "Bob");
    await store.appendConversationResearch!(alice, chatA.id, evidence);
    expect((await store.listConversationResearch!(alice, chatA.id)).map((item) => item.sources[0]?.url)).toEqual(["https://store.google.com/"]);
    expect(await store.listConversationResearch!(alice, chatB.id)).toEqual([]);
    await expect(store.listConversationResearch!(bob, chatA.id)).rejects.toThrow();
    await expect(store.appendConversationResearch!(alice, bobChat.id, evidence)).rejects.toThrow();
    await store.deleteNeutralConversation(alice, chatA.id);
    await expect(store.listConversationResearch!(alice, chatA.id)).rejects.toThrow();
  });

  it("preserves every URL, timestamp, full evidence and page count without mutable aliases", async () => {
    const store = new InMemoryWorkspaceStore();
    const chat = await store.createNeutralConversation(alice, "Lossless evidence");
    const sources = Array.from({ length: 32 }, (_, index) => ({ url: "https://example.com/page/" + index, title: "Page " + index, accessedAt: "2026-10-24T00:00:00Z" }));
    const full = "Evidence\n".repeat(500);
    const saved = await store.appendConversationResearch!(alice, chat.id, { ...evidence, sources, evidenceExcerpt: full, pageCount: 29 });
    saved.sources.length = 0;
    const [actual] = await store.listConversationResearch!(alice, chat.id);
    expect(actual).toMatchObject({ sourceCount: 32, sources, evidenceExcerpt: full, pageCount: 29 });
    actual!.sources.length = 0;
    expect((await store.listConversationResearch!(alice, chat.id))[0]!.sources).toHaveLength(32);
  });

  it("formats exact sources and counts, newest last, within a bounded block", () => {
    const now = new Date().toISOString();
    const text = researchEvidenceContext([
      { id: "1", workspaceId: "w", userId: "u", conversationId: "c", companyId: null, tool: "web_fetch", kind: "url_analysis", query: "apple", sources: [{ url: "https://www.apple.com/" }], sourceCount: 9, evidenceExcerpt: "Apple pages", createdAt: now },
      { id: "2", workspaceId: "w", userId: "u", conversationId: "c", companyId: null, tool: "web_fetch", kind: "url_analysis", query: "google", sources: [{ url: "https://store.google.com/", title: "Change your region" }], sourceCount: 1, evidenceExcerpt: "Region page", createdAt: now },
    ])!;
    expect(text).toContain("9 source(s): https://www.apple.com/");
    expect(text).toContain("1 source(s): https://store.google.com/ (Change your region)");
    expect(text.indexOf("apple")).toBeLessThan(text.indexOf("store.google.com"));
    expect(researchEvidenceContext([])).toBeUndefined();
  });
});

describe("research recall across turns", () => {
  it("records a web_fetch turn and gives the next turn of the same chat, not another chat, the exact sources", async () => {
    const store = new InMemoryWorkspaceStore();
    const requests: ChatRequest[] = [];
    let fetched = false;
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      chat: async (request) => {
        if (String(request.messages[0]?.content).startsWith("Classify the user's primary intent")) return { content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [] }) };
        requests.push(request);
        if (!fetched && request.tools?.some((tool) => tool.function.name === "web_fetch")) {
          fetched = true;
          const call: ChatToolCall = { id: "fetch-1", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://store.google.com/", goal: "navigation" }) } };
          return { content: "", toolCalls: [call] };
        }
        return { content: "Done." };
      },
      async *stream() { yield "Done."; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const webResearch = {
      shouldResearch: () => false,
      run: vi.fn(async () => ({ kind: "url_analysis" as const, context: "Region selector page only.", sources: [{ url: "https://store.google.com/", title: "Change your region", accessedAt: new Date().toISOString() }] })),
    } as never;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, aiEngine: ai, marketplace, webResearch });
    try {
      const chatA = await store.createNeutralConversation(alice, "Chat A");
      const chatB = await store.createNeutralConversation(alice, "Chat B");
      await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Read https://store.google.com/ and describe its navigation.", conversationId: chatA.id, contextType: "none" } });
      const recorded = await store.listConversationResearch!(alice, chatA.id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ tool: "web_fetch", sourceCount: 1, sources: [{ url: "https://store.google.com/", title: "Change your region" }] });

      requests.length = 0;
      await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Use the earlier research without searching again. Which sources did we read?", conversationId: chatA.id, contextType: "none" } });
      expect(JSON.stringify(requests.map((request) => request.messages))).toContain("1 source(s): https://store.google.com/ (Change your region)");

      requests.length = 0;
      await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Which sources did we read?", conversationId: chatB.id, contextType: "none" } });
      expect(JSON.stringify(requests.map((request) => request.messages))).not.toContain("store.google.com");
    } finally { await app.close(); }
  });
});
