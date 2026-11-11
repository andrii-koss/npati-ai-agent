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

    // Delegation that mentions an email reply template is still work for the agents, not an email setting.
    const template = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Нехай Coach Ana доручить Leo підготувати шаблон відповіді на скарги про запізнення", contextType: "project", companyId: company.id, projectId: project.id } });
    expect(template.body).toContain('"companyRunId"');

    const neutral = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Hello! Thanks for the help today.", contextType: "project", companyId: company.id, projectId: project.id } });
    expect(neutral.statusCode).toBe(200);
    expect(neutral.body).not.toContain('"companyRunId"');
  });
});

describe("management actions in a project chat", () => {
  it("use the project's company as the selected company", async () => {
    const context: AuthContext = { workspaceId: "workspace-project-management", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const prompts: string[] = [];
    const aiEngine: AIEngine = {
      chat: vi.fn(async (request) => { prompts.push(request.messages.map((item) => String(item.content)).join("\n")); return { content: "NO_ACTION" }; }),
      async *stream(request) { prompts.push(request.messages.map((item) => String(item.content)).join("\n")); yield "NO_ACTION"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    await store.createCompany(context, { name: "Other Co" }, "other");
    const company = await store.createCompany(context, { name: "Bakery" }, "bakery");
    await store.createProject(context, company.id, { name: "Bakery site", type: "website" } as never, "site");
    const project = (await store.listProjects(context, company.id))[0]!;
    const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Створи автоматизацію: щопонеділка о 9:00 план постів для Instagram", contextType: "project", companyId: company.id, projectId: project.id } });
    expect(response.statusCode).toBe(200);
    expect(prompts.some((prompt) => prompt.includes(`Selected company ID: ${JSON.stringify(company.id)}`))).toBe(true);
  });
});

describe("a chat whose stored company was deleted", () => {
  it("continues without that context instead of failing every message", async () => {
    const context: AuthContext = { workspaceId: "workspace-stale", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: vi.fn(async () => ({ content: "Neutral answer" })), async *stream() { yield "Neutral answer"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    const company = await store.createCompany(context, { name: "Cafe" }, "cafe");
    await store.createProject(context, company.id, { name: "Cafe site", type: "website" } as never, "cafe-site");
    const project = (await store.listProjects(context, company.id))[0]!;
    const conversation = await store.createNeutralConversation(context, "Cafe site");
    await store.appendNeutralMessage(context, conversation.id, "assistant", `Created the site. [Open project](/code?company=${company.id}&project=${project.id})`);
    await store.deleteCompany(context, company.id, (await store.getCompany(context, company.id)).revision);
    const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Hello! Thanks for the help today.", conversationId: conversation.id, contextType: "project", companyId: company.id, projectId: project.id } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("BUSINESS_ACCESS_DENIED");
    expect(response.body).toContain('"contextType":"none"');
    // A companyId the conversation never worked with keeps the access refusal.
    const foreign = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Hello!", contextType: "company", companyId: "00000000-0000-4000-8000-000000000000" } });
    expect(foreign.statusCode === 403 || foreign.body.includes("BUSINESS_ACCESS_DENIED") || foreign.body.includes("not available")).toBe(true);
  });
});

describe("deleting a website from chat", () => {
  it("asks for confirmation, then deletes the project through the project service", async () => {
    const { isProjectDeleteRequest } = await import("../apps/agent-api/src/chat-project-delete");
    expect(isProjectDeleteRequest("Видали сайт Nordic Fit — він більше не потрібен.")).toBe(true);
    expect(isProjectDeleteRequest("Видали сторінку /about з сайту")).toBe(false);
    expect(isProjectDeleteRequest("Delete /about from the website")).toBe(false);
    expect(isProjectDeleteRequest('Delete only the test React/Vite project "Stress Vite"')).toBe(true);
    const context: AuthContext = { workspaceId: "workspace-site-delete", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: vi.fn(async () => ({ content: "Neutral answer" })), async *stream() { yield "Neutral answer"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    const company = await store.createCompany(context, { name: "Fit" }, "fit-delete");
    await store.createProject(context, company.id, { name: "Fit landing", type: "website" } as never, "fit-landing");
    const project = (await store.listProjects(context, company.id))[0]!;
    const payload = { contextType: "project", companyId: company.id, projectId: project.id };
    const asked = await app.inject({ method: "POST", url: "/chat/stream", payload: { ...payload, message: "Видали сайт Fit landing — він більше не потрібен." } });
    expect(asked.body).toContain("Для підтвердження напишіть");
    expect(await store.listProjects(context, company.id)).toHaveLength(1);
    const conversationId = /"conversationId":"([^"]+)"/.exec(asked.body)?.[1];
    const confirmed = await app.inject({ method: "POST", url: "/chat/stream", payload: { ...payload, conversationId, message: "Так, підтверджую видалення." } });
    expect(confirmed.body).toContain("видалено");
    expect(await store.listProjects(context, company.id)).toHaveLength(0);
  });
  it("finds the named site from a new chat with no company chosen, and asks before deleting it", async () => {
    const context: AuthContext = { workspaceId: "workspace-site-new-chat", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: vi.fn(async () => ({ content: "Neutral answer" })), async *stream() { yield "Neutral answer"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    const company = await store.createCompany(context, { name: "Fit" }, "fit-new-chat");
    await store.createProject(context, company.id, { name: "Fit landing", type: "website" } as never, "fit-landing-new-chat");
    await store.createProject(context, company.id, { name: "Fit blog", type: "website" } as never, "fit-blog-new-chat");
    const vague = await app.inject({ method: "POST", url: "/chat/stream", payload: { contextType: "none", message: "Видали сайт." } });
    expect(vague.body).not.toContain("Для підтвердження напишіть");
    const asked = await app.inject({ method: "POST", url: "/chat/stream", payload: { contextType: "none", message: "Видали сайт Fit landing — він більше не потрібен." } });
    expect(asked.body).toContain("Для підтвердження напишіть");
    expect(asked.body).toContain("Fit landing");
    expect(await store.listProjects(context, company.id)).toHaveLength(2);
    await store.setUserSetting(context, "chat.data-auto-allow:" + company.id, { autoAllow: true }, 0);
    const deleted = await app.inject({ method: "POST", url: "/chat/stream", payload: { contextType: "none", message: "Видали сайт Fit landing — він більше не потрібен." } });
    expect(deleted.body).toContain("видалено");
    expect((await store.listProjects(context, company.id)).map(item => item.name)).toEqual(["Fit blog"]);
  });

  it("deletes the named site at once when the company lets its agents act without asking", async () => {
    const context: AuthContext = { workspaceId: "workspace-site-auto-delete", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: vi.fn(async () => ({ content: "Neutral answer" })), async *stream() { yield "Neutral answer"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    const company = await store.createCompany(context, { name: "Fit" }, "fit-auto-delete");
    await store.setUserSetting(context, "chat.data-auto-allow:" + company.id, { autoAllow: true }, 0);
    await store.createProject(context, company.id, { name: "Fit landing", type: "website" } as never, "fit-landing-auto");
    await store.createProject(context, company.id, { name: "Fit blog", type: "website" } as never, "fit-blog-auto");
    const blog = (await store.listProjects(context, company.id)).find(item => item.name === "Fit blog")!;
    // The chat works on the blog and deletes the other site: the site goes at once, and the chat keeps the blog.
    const answer = await app.inject({ method: "POST", url: "/chat/stream", payload: { contextType: "project", companyId: company.id, projectId: blog.id, message: "Видали сайт Fit landing — він більше не потрібен." } });
    expect(answer.body).not.toContain("Для підтвердження напишіть");
    expect(answer.body).toContain("видалено");
    expect(answer.body).not.toContain('"contextType":"none"');
    expect((await store.listProjects(context, company.id)).map(item => item.name)).toEqual(["Fit blog"]);
  });
});

describe("deleting a site of another named company", () => {
  it("finds the site in the company the request names, confirms it, and deletes only that site", async () => {
    const context: AuthContext = { workspaceId: "workspace-other-delete", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: vi.fn(async () => ({ content: "Neutral answer" })), async *stream() { yield "Neutral answer"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    const shop = await store.createCompany(context, { name: "Stress Bakery" }, "other-delete-bakery");
    const studio = await store.createCompany(context, { name: "Stress Studio" }, "other-delete-studio");
    const { project: next } = await store.createProject(context, shop.id, { name: "Stress Next Shop", type: "website" } as never, "other-delete-next");
    await store.createProject(context, studio.id, { name: "Stress Vite", type: "website" } as never, "other-delete-vite");
    const payload = { contextType: "project", companyId: shop.id, projectId: next.id };
    const asked = await app.inject({ method: "POST", url: "/chat/stream", payload: { ...payload, message: 'Delete only the test React/Vite project "Stress Vite" in company "Stress Studio" through the normal confirmation flow.' } });
    expect(asked.body).toContain("Yes, delete website Stress Vite");
    const conversationId = /"conversationId":"([^"]+)"/.exec(asked.body)?.[1];
    const confirmed = await app.inject({ method: "POST", url: "/chat/stream", payload: { ...payload, conversationId, message: "Yes, delete website Stress Vite" } });
    expect(confirmed.body).toContain("was deleted");
    expect(await store.listProjects(context, studio.id)).toHaveLength(0);
    expect(await store.listProjects(context, shop.id)).toHaveLength(1);
  });
});

describe("editing the website of a company that has none", () => {
  it("says there is no website instead of creating a project named after the request", async () => {
    const context: AuthContext = { workspaceId: "workspace-no-site", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    const store = new InMemoryWorkspaceStore();
    const aiEngine: AIEngine = {
      chat: vi.fn(async () => ({ content: JSON.stringify({ intent: "EDIT_WEBSITE", confidence: 0.9, targets: [] }) })), async *stream() { yield ""; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => ({ ...context }) }, aiEngine, marketplace });
    apps.push(app);
    const company = await store.createCompany(context, { name: "Nordic Fit" }, "fit-no-site");
    const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Add a contact form to the Nordic Fit website.", contextType: "company", companyId: company.id } });
    expect(response.statusCode).toBe(200);
    expect(await store.listProjects(context, company.id)).toHaveLength(0);
  });
});
