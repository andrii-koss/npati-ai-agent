import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function harness() {
  const context: AuthContext = {
    workspaceId: "workspace-private",
    userId: "user-private",
    permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"],
  };
  const store = new InMemoryWorkspaceStore();
  const authProvider: AuthProvider = { authenticate: async () => ({ ...context, permissions: [...context.permissions] }) };
  const requests: ChatRequest[] = [];
  const aiEngine: AIEngine = {
    chat: vi.fn(async (request) => {
      requests.push(request);
      return { content: "Ephemeral answer", model: request.model };
    }),
    async *stream() { yield ""; },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => ({}),
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"],
    healthCheck: async () => ({ status: "ok" }),
    ensureA2AEnabled: async () => undefined,
    a2aSend: vi.fn(async () => ({
      taskId: "private-plan",
      content: JSON.stringify({
        mode: "single",
        agentIds: [],
        toolRequests: [{ agentId: "manager-placeholder", tool: "storage.company_memory", input: { operation: "list" } }],
      }),
      metadata: {},
    })),
    ensureCombo: async ({ name }) => ({ name }),
  };
  const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
  const app = buildApp({ workspaceStore: store, authProvider, marketplace, aiEngine });
  apps.push(app);
  return { app, store, context, requests, aiEngine };
}

describe("Per-request no-memory production wiring", () => {
  it("bypasses Business Memory and conversation read/write for JSON and SSE requests", async () => {
    const { app, store, context, requests } = harness();
    const business = await store.createBusiness(context, { name: "Private Business", businessStage: "operating" });
    await store.createMemory(context, business.id, {
      type: "business_fact",
      title: "Private code",
      content: "MEMORY-SECRET-7391",
      source: "test",
      confidence: 1,
    });
    const conversation = await store.createConversation(context, business.id, "Existing");
    await store.appendMessage(context, business.id, conversation.id, "user", "HISTORY-SECRET-8821");

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-npati-no-memory": "true" },
      payload: {
        message: "Answer without stored context",
        contextType: "business",
        businessId: business.id,
        conversationId: "conversation-from-another-business",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ noMemory: true });
    expect(response.json().conversationId).toBeUndefined();
    const firstPrompt = JSON.stringify(requests.at(-1)?.messages);
    expect(firstPrompt).not.toContain("MEMORY-SECRET-7391");
    expect(firstPrompt).not.toContain("HISTORY-SECRET-8821");
    expect((await store.getConversation(context, business.id, conversation.id)).messages).toHaveLength(1);

    const streamed = await app.inject({
      method: "POST",
      url: "/chat/stream",
      payload: {
        message: "Stream without stored context",
        contextType: "business",
        businessId: business.id,
        conversationId: "conversation-from-another-business",
        noMemory: true,
      },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain('"noMemory":true');
    const streamPrompt = JSON.stringify(requests.at(-1)?.messages);
    expect(streamPrompt).not.toContain("MEMORY-SECRET-7391");
    expect(streamPrompt).not.toContain("HISTORY-SECRET-8821");
    expect((await store.getConversation(context, business.id, conversation.id)).messages).toHaveLength(1);
  });

  it("does not create neutral history and blocks Company memory tools with an audited reason", async () => {
    const { app, store, context, aiEngine } = harness();
    const neutral = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        message: "One private image question",
        contextType: "none",
        ephemeral: true,
        attachments: [{
          kind: "image",
          name: "private.png",
          mimeType: "image/png",
          dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
        }],
      },
    });
    expect(neutral.statusCode).toBe(200);
    expect(neutral.json()).toMatchObject({ noMemory: true });
    expect(neutral.json().conversationId).toBeUndefined();
    expect(await store.listNeutralConversations(context)).toEqual([]);

    await store.setUserSetting(context, "ai.preferences", { addedModels: [{ id: "test/chat", upstreamId: "chat", providerId: "test", providerName: "Test", name: "Test Chat", capabilities: ["chat"], added: true, local: false, freeStatus: "free" }], routing: { mode: "manual", defaultModelId: "test/chat" } }, 0);
    const company = await store.createCompany(context, {
      name: "Private Company",
      memory: { secret: "COMPANY-SECRET-4455" },
    }, "private-company");
    const manager = await store.createCompanyAgent(context, company.id, {
      name: "Manager",
      role: "Manager",
      tools: ["Knowledge", "Company Memory", "Files"],
    }, "private-manager");
    await store.setCompanyMainAgent(context, company.id, manager.id, company.revision);
    vi.mocked(aiEngine.a2aSend!).mockImplementation(async () => ({
      taskId: "private-plan",
      content: JSON.stringify({
        mode: "single",
        agentIds: [],
        toolRequests: [{ agentId: manager.id, tool: "storage.company_memory", input: { operation: "list" } }],
      }),
      metadata: {},
    }));

    const companyResponse = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Do not use memory", contextType: "company", companyId: company.id, noMemory: true },
    });
    expect(companyResponse.statusCode).toBe(200);
    const details = await store.getCompanyAgentRun(context, company.id, companyResponse.json().companyRunId);
    expect(details.run, JSON.stringify(details.run)).toMatchObject({ status: "failed", errorCode: "NO_MEMORY_TOOL_FORBIDDEN" });
    expect(details.toolAudit).toEqual([
      expect.objectContaining({ toolName: "storage.company_memory", decision: "denied", reasonCode: "no_memory", status: "blocked" }),
    ]);
    const prompts = JSON.stringify(vi.mocked(aiEngine.a2aSend!).mock.calls[0]?.[0].messages);
    expect(prompts).not.toContain("COMPANY-SECRET-4455");
  });
});
