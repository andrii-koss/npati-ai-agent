import { describe, expect, it } from "vitest";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const auth: AuthContext = { userId: "reply-user", workspaceId: "reply-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

async function turn(route: Record<string, unknown>, payload: Record<string, unknown> = {}) {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(auth, { name: "Reply Labs" }, "reply-labs");
  let calls = 0, mainCalls = 0;
  const ai: AIEngine = {
    supportsNativeTools: () => true,
    async chat(request) {
      calls += 1;
      if (request.tools?.[0]?.function.name === "npati_classify_chat_intent") {
        const args = { intent: "CHAT", confidence: 0.99, targets: [], entityRead: null, coreCapability: null, coreMutation: false, assignsWorkToCompanyAgent: false, externalResearch: false, ...route };
        return { content: "", toolCalls: [{ id: "route", type: "function", function: { name: "npati_classify_chat_intent", arguments: JSON.stringify(args) } }] };
      }
      if (String(request.messages[0]?.content).startsWith("You are NPATI Agent")) mainCalls += 1;
      return { content: "Відповідь основної моделі." };
    },
    async *stream() { yield "Відповідь основної моделі."; },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
  };
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const conversation = (await app.inject({ method: "POST", url: "/conversations", payload: { title: "Reply" } })).json() as { id?: string; data?: { id: string } };
    const conversationId = conversation.id ?? conversation.data!.id;
    const context = payload.company ? { contextType: "company", companyId: company.id } : { contextType: "none" };
    const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Ти працюєш??", conversationId, ...context } });
    expect(response.statusCode).toBe(200);
    const stored = await store.getNeutralConversation(auth, conversationId);
    return { calls, mainCalls, body: response.body, stored };
  } finally { await app.close(); }
}

describe("router reply", () => {
  it("answers plain conversation with the router's reply in one model call and keeps the history", async () => {
    const { calls, mainCalls, body, stored } = await turn({ reply: "Так, я працюю — чим допомогти?" });
    expect(calls).toBe(1);
    expect(mainCalls).toBe(0);
    expect(body).toContain('"delta":"Так, я працюю - чим допомогти?"');
    expect(body).toContain('"message":"Так, я працюю - чим допомогти?"');
    expect(stored.messages.map((message) => message.content)).toEqual(["Ти працюєш??", "Так, я працюю - чим допомогти?"]);
  });

  it("uses the reply for plain conversation while a Company is selected", async () => {
    const { calls, mainCalls } = await turn({ reply: "Так, працюю." }, { company: true });
    expect(calls).toBe(1);
    expect(mainCalls).toBe(0);
  });

  it("ignores a reply for a record route, research, delegation or a self-classified draft", async () => {
    for (const [route, payload] of [
      [{ reply: "Створено.", coreCapability: "npati_business_profile", coreMutation: true }, {}],
      [{ reply: "Ось новини.", externalResearch: true }, {}],
      [{ reply: "Доручено.", assignsWorkToCompanyAgent: true }, { company: true }],
      [{ reply: "«Свіжий хліб щодня».", format: "draft" }, {}],
    ] as const) {
      const { mainCalls, body } = await turn(route, payload);
      expect(mainCalls, JSON.stringify(route)).toBeGreaterThan(0);
      expect(body).not.toContain(`"message":"${String(route.reply)}"`);
    }
  });
});
