import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
const auth = { userId: "project-context-owner", workspaceId: "project-context-ws", permissions: ["workspace:read", "business:manage"] };

describe("authorized project context in the existing neutral chat", () => {
  it.each(["What products does this store sell?", "Que produtos esta loja vende?"])("passes project metadata without earlier chat history: %s", async message => {
    const requests: ChatRequest[] = [];
    const engine = {
      chat: async (input: ChatRequest) => { requests.push(input); return { content: String(input.messages[0]?.content).startsWith("Classify")
        ? JSON.stringify({ intent: "CHAT", confidence: 0.99, targets: [] }) : "This store sells handmade brass lamps." }; },
      async *stream(input: ChatRequest) { requests.push(input); yield "This store sells handmade brass lamps."; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat", "streaming"],
      healthCheck: async () => ({ status: "ok" }),
    } as AIEngine;
    const store = new InMemoryWorkspaceStore(); await store.initialize();
    const company = await store.createCompany(auth, { name: "Context Test" }, "context-company");
    const { project } = await store.createProject(auth, company.id, { name: "Lumen Lab", type: "code_project", description: "An online shop selling handmade brass lamps." }, "context-project");
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: engine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "project", companyId: company.id, projectId: project.id } });
      expect(response.statusCode).toBe(200);
      const answering = requests.find(input => input.messages.some(item => String(item.content).includes("UNTRUSTED SELECTED PROJECT DATA")));
      expect(answering).toBeTruthy();
      expect(JSON.stringify(answering!.messages)).toContain("Lumen Lab");
      expect(JSON.stringify(answering!.messages)).toContain("handmade brass lamps");
      expect(requests.filter(input => String(input.messages[0]?.content).startsWith("Classify"))).toHaveLength(1);
    } finally { await app.close(); }
  });
});
