import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("chat in a project context", () => {
  it("runs work addressed to a company agent by name through the Company Runtime", async () => {
    const context: AuthContext = { workspaceId: "workspace-delegation", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: vi.fn(async () => ({ content: "Neutral answer" })),
      async *stream() { yield "Neutral answer"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" }), ensureA2AEnabled: async () => undefined,
      a2aSend: vi.fn(async () => ({ taskId: "plan", content: JSON.stringify({ mode: "single", agentIds: [], toolRequests: [] }), metadata: {} })),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    await store.setUserSetting(context, "ai.preferences", { addedModels: [{ id: "test/chat", upstreamId: "chat", providerId: "test", providerName: "Test", name: "Test Chat", capabilities: ["chat"], added: true, local: false, freeStatus: "free" }], routing: { mode: "manual", defaultModelId: "test/chat" } }, 0);
    const company = await store.createCompany(context, { name: "Nordic Fit" }, "fit");
    const ana = await store.createCompanyAgent(context, company.id, { name: "Coach Ana", role: "Lead trainer" }, "ana");
    await store.createCompanyAgent(context, company.id, { name: "Leo", role: "Content marketer" }, "leo");
    await store.setCompanyMainAgent(context, company.id, ana.id, company.revision);
    await store.createProject(context, company.id, { name: "Landing", type: "website" } as never, "landing");
    const project = (await store.listProjects(context, company.id))[0]!;

    const delegated = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Have Coach Ana delegate to Leo: write 3 Instagram captions for the Monday HIIT class", contextType: "project", companyId: company.id, projectId: project.id } });
    expect(delegated.statusCode).toBe(200);
    expect(delegated.body).toContain('"companyRunId"');

    const neutral = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Hello! Thanks for the help today.", contextType: "project", companyId: company.id, projectId: project.id } });
    expect(neutral.statusCode).toBe(200);
    expect(neutral.body).not.toContain('"companyRunId"');
  });
});
