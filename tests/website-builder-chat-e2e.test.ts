
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../apps/agent-api/src/app";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { WEBSITE_FILE_TOOLS, PROJECT_PREVIEW_TOOLS } from "../apps/agent-api/src/project-agent-capabilities";

const createPrompt = "\u0421\u0442\u0432\u043e\u0440\u0438 \u0441\u0443\u0447\u0430\u0441\u043d\u0438\u0439 \u0441\u0430\u0439\u0442 \u0434\u043b\u044f \u0445\u043e\u0441\u0442\u0438\u043d\u0433-\u043a\u043e\u043c\u043f\u0430\u043d\u0456\u0457. \u0412\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u0430\u0439 Next.js. \u0421\u0442\u043e\u0440\u0456\u043d\u043a\u0438: Home, Hosting, Domains, Pricing, Contact. \u0417\u0440\u043e\u0431\u0438 \u0430\u0434\u0430\u043f\u0442\u0438\u0432\u043d\u0438\u0439 \u0434\u0438\u0437\u0430\u0439\u043d \u0456 \u0437\u0430\u043f\u0443\u0441\u0442\u0438 Live Preview.";
const editPrompt = "\u0417\u0440\u043e\u0431\u0438 header \u0442\u0435\u043c\u043d\u0456\u0448\u0438\u043c.";
function streamResult(body: string): any {
  const match = /event: result\ndata: ([^\n]+)/.exec(body);
  if (!match) throw new Error("Chat stream returned no result: " + body.slice(0, 500));
  return JSON.parse(match[1]!);
}

describe("Website Builder through ordinary streamed Chat", () => {
  const roots: string[] = [];
  const apps: Array<ReturnType<typeof buildApp>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  it("creates a Project and routes a follow-up edit to the same Project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "npati-chat-builder-"));
    roots.push(root);
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const auth: AuthContext = { workspaceId: "builder-ws", userId: "builder-user", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
    const company = await store.createCompany(auth, { name: "Hosting Company" }, "hosting-company");
    const agent = await store.createCompanyAgent(auth, company.id, {
      name: "Builder", role: "frontend developer",
      tools: [...WEBSITE_FILE_TOOLS, ...PROJECT_PREVIEW_TOOLS], isActive: true,
    }, "builder-agent");
    // Reproduce a fresh Company with a builder but no Main Agent selected.
    expect((await store.getCompany(auth, company.id)).mainAgentId).toBeUndefined();
    const aiEngine = {
      chat: async () => ({ content: "Website task completed.", model: "test-model", usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }),
      async *stream() { yield "Website task completed."; },
      listModels: async () => [{ id: "test/chat", name: "Test Chat", capabilities: ["chat", "coding"] }], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
      ensureA2AEnabled: async () => undefined,
      ensureCombo: async (input: { name: string }) => ({ name: input.name }),
      a2aSend: async () => ({ taskId: "builder-plan", content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [] }), metadata: {} }),
    } as AIEngine;
    await store.setUserSetting(auth, "ai.preferences", { addedModels: [{ id: "test/chat", upstreamId: "chat", providerId: "test", providerName: "Test", name: "Chat", capabilities: ["text", "chat", "coding"], added: true, local: false, freeStatus: "free" }], routing: { mode: "manual", defaultModelId: "test/chat" } }, 0);
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as OmniRouteMarketplace;
    const authProvider: AuthProvider = { authenticate: async () => auth };
    const app = buildApp({ workspaceStore: store, authProvider, aiEngine, marketplace, projectWorkspaceRoot: root });
    apps.push(app);
    const first = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: createPrompt, contextType: "project", companyId: company.id, projectId: "7b54458a-f557-4d4b-b7ab-a6d4b9b05fb4" } });
    expect(first.statusCode).toBe(200);
    const created = streamResult(first.body);
    expect(created.projectAction?.action).toBe("create");
    const assignedMain = (await store.getCompany(auth, company.id)).mainAgentId;
    expect(assignedMain).toBeTruthy();
    expect((await store.getCompanyAgent(auth, company.id, assignedMain!)).isActive).toBe(true);
    const projectId = created.projectCard?.projectId as string;
    expect(projectId).toBeTruthy();
    expect(created.activeContext).toMatchObject({ contextType: "project", companyId: company.id, projectId });
    expect(await store.listProjects(auth, company.id)).toHaveLength(1);
    expect((await store.getProject(auth, company.id, projectId)).description).toBe(createPrompt);
    const runsBefore = await store.listProjectRuns(auth, company.id, projectId);
    expect(runsBefore).toHaveLength(1);
    expect(runsBefore.some((run) => run.selectedAgentIds.includes(agent.id))).toBe(true);
    expect(created.projectCard.framework).toBe("Next.js");
    expect(created.projectCard.lastBuildStatus).toBe("failed");
    expect(created.projectCard.previewUrl).toBeUndefined();
    expect(created.suggestedActions).toEqual([`Open: ${created.projectCard.name}`]);
    const projectBase = `/companies/${company.id}/projects/${projectId}`;
    const files = await app.inject({ method: "GET", url: `${projectBase}/files/tree` });
    expect(files.statusCode).toBe(200);
    expect(JSON.stringify(files.json())).toContain("PROJECT.md");
    const changes = await app.inject({ method: "GET", url: `${projectBase}/changes` });
    expect(changes.statusCode).toBe(200);
    const activity = await app.inject({ method: "GET", url: `${projectBase}/runs` });
    expect(activity.statusCode).toBe(200);
    expect(activity.json().runs.some((run: { id: string }) => run.id === created.companyRunId)).toBe(true);
    const trace = await app.inject({ method: "GET", url: `/companies/${company.id}/runs/${created.companyRunId}` });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().run.projectId).toBe(projectId);
    const second = await app.inject({ method: "POST", url: "/chat/stream", payload: {
      message: editPrompt, contextType: "project", companyId: company.id, projectId, conversationId: created.conversationId,
    } });
    expect(second.statusCode).toBe(200);
    const edited = streamResult(second.body);
    expect(edited.projectAction?.action).toBe("edit");
    expect(edited.projectAction?.projectId).toBe(projectId);
    expect(await store.listProjects(auth, company.id)).toHaveLength(1);
    expect((await store.listProjectRuns(auth, company.id, projectId)).length).toBeGreaterThan(runsBefore.length);
    // Older clients may send the previous Project when explicitly asking for a new site.
    const another = await app.inject({ method: "POST", url: "/chat", payload: {
      message: createPrompt,
      contextType: "project", companyId: company.id, projectId: "deleted-project",
    } });
    expect(another.statusCode, another.body).toBe(200);
    expect(another.json().projectAction?.action).toBe("create");
    expect(another.json().activeContext.projectId).not.toBe(projectId);
    expect(await store.listProjects(auth, company.id)).toHaveLength(2);
  });
});

