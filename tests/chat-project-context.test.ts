import { describe, expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { ProjectOrchestrator } from "../apps/agent-api/src/project-orchestrator";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
const auth = { userId: "project-context-owner", workspaceId: "project-context-ws", permissions: ["workspace:read", "business:manage"] };

describe("authorized project context in the existing neutral chat", () => {
  it.each(["/chat", "/chat/stream"])("routes a named existing site edit from Company context to its exact Project executor: %s", async url => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Source Studio" }, "source-studio");
    const { project } = await store.createProject(auth, company.id, { name: "Owned Portal", type: "code_project" }, "owned-portal");
    const chat = vi.fn(async (request: ChatRequest) => {
      expect(String(request.messages[0]?.content).startsWith("Classify")).toBe(true);
      expect(JSON.parse(request.messages[1]!.content as string).hasActiveProject).toBe(true);
      return { content: JSON.stringify({ intent: "EDIT_WEBSITE", confidence: 1, targets: [] }) };
    });
    const ai = { chat, async *stream() { throw new Error("Unexpected chat fallback"); }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }) } as AIEngine;
    // Stop at the real execution boundary: this regression proves routing, not a fabricated website edit.
    const execute = vi.spyOn(ProjectOrchestrator.prototype, "executeWebsiteTask").mockRejectedValue(new Error("PROJECT_EXECUTOR_REACHED"));
    const activity = vi.spyOn(CompanyDelegationRuntime.prototype, "execute");
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai,
      marketplace: { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace });
    try {
      await app.inject({ method: "POST", url, payload: { message: 'In "Owned Portal" of company "Source Studio" change the heading. Keep the paragraph.', contextType: "company", companyId: company.id } });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]![1]).toMatchObject({ companyId: company.id, projectId: project.id, intentDecision: { intent: "EDIT_WEBSITE", needsClarification: false } });
      expect(activity).not.toHaveBeenCalled();
      expect(chat).toHaveBeenCalledOnce();
      expect((await store.listProjects(auth, company.id)).map(item => item.id)).toEqual([project.id]);
    } finally { execute.mockRestore(); activity.mockRestore(); await app.close(); }
  });
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
