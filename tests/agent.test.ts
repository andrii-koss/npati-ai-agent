import { NpatiAgent } from "@npati/agent";
import { createHubClient } from "@npati/hub-connector";
import { InMemoryProvider } from "@npati/memory";
import { OmniRouteEngine, type AIEngine, type ChatRequest } from "@npati/omniroute-adapter";
import { describe, expect, it } from "vitest";

describe("NPATI Agent orchestration", () => {
  it("routes a startup request through the demonstration skill", async () => {
    const agent = new NpatiAgent({
      aiEngine: new OmniRouteEngine({}),
      hub: createHubClient(),
      memory: new InMemoryProvider(),
    });
    const reply = await agent.handle({ message: "I want to start a business" });
    expect(reply.suggestedActions).toContain("Define the customer and problem");
  });

  it("sends only the selected business context and configured model to AI", async () => {
    const requests: ChatRequest[] = [];
    const aiEngine: AIEngine = {
      chat: async (request) => { requests.push(request); return { content: "Grounded answer", model: request.model }; },
      async *stream() { yield ""; },
      listModels: async () => [],
      getModel: async () => undefined,
      executeTool: async () => undefined,
      searchMemory: async () => [],
      saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" }),
    };
    const agent = new NpatiAgent({ aiEngine, hub: createHubClient(), memory: new InMemoryProvider() });
    await agent.handleBusinessMessage({
      message: "How can I reach more customers?",
      context: {
        user: { id: "user-a" },
        workspace: { id: "workspace-a" },
        business: {
          id: "candles", workspaceId: "workspace-a", ownerUserId: "user-a", name: "Happy Candle",
          industry: "Handmade candles", country: "US", businessStage: "growing",
          audienceSummary: "Women 25-45", createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
        goals: [{
          id: "goal-a", workspaceId: "workspace-a", businessId: "candles", createdByUserId: "user-a",
          title: "Get first 100 customers", status: "active", priority: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
        }],
        memory: [{
          id: "memory-a", workspaceId: "workspace-a", businessId: "candles", userId: "user-a",
          type: "channel", title: "Preferred channel", content: "Pinterest", source: "user",
          createdAt: "2026-01-01", updatedAt: "2026-01-01",
        }],
        skills: [], connections: [], ai: { mode: "manual", model: "provider/model-a" },
      },
    });
    const serialized = JSON.stringify(requests[0]);
    expect(serialized).toContain("Happy Candle");
    expect(serialized).toContain("Get first 100 customers");
    expect(serialized).toContain("Pinterest");
    expect(serialized).not.toContain("Software Agency");
    expect(requests[0]?.model).toBe("provider/model-a");
  });
});
