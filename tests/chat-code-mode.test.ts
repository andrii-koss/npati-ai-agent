import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { codeModeDecision } from "../apps/agent-api/src/chat-project-intent";
import { classifyProjectIntent } from "@npati/shared";

const auth: AuthContext = { userId: "mode-user", workspaceId: "mode-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

async function run(mode: "chat" | "code" | undefined) {
  const store = new InMemoryWorkspaceStore();
  for (let index = 1; index <= 10; index += 1) await store.createBusiness(auth, { name: `Mode Bakery ${index}`, businessStage: "operating" });
  const company = await store.createCompany(auth, { name: "Mode Labs" }, "mode-labs");
  const { project } = await store.createProject(auth, company.id, { name: "Mode Shop", type: "website" } as never, "mode-shop");
  const classifierCalls: ChatRequest[] = [];
  const main: ChatRequest[] = [];
  const ai: AIEngine = {
    supportsNativeTools: () => true,
    async chat(request) {
      if (request.tools?.[0]?.function.name === "npati_classify_chat_intent") {
        classifierCalls.push(request);
        const args = { intent: "EDIT_WEBSITE", confidence: 0.99, targets: [], entityRead: null, coreCapability: null, coreMutation: false, assignsWorkToCompanyAgent: false };
        return { content: "", toolCalls: [{ id: "route", type: "function", function: { name: "npati_classify_chat_intent", arguments: JSON.stringify(args) } }] };
      }
      const system = request.messages[0];
      if (system?.role === "system" && String(system.content).startsWith("You are NPATI Agent")) main.push(request);
      return { content: "Готово." };
    },
    async *stream() { yield "Готово."; },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
  };
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
  try {
    const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Зроби кнопку в шапці синьою.", contextType: "project", companyId: company.id, projectId: project.id, ...(mode ? { mode } : {}) } });
    expect(response.statusCode).toBe(200);
  } finally { await app.close(); }
  return { classifierCalls, main };
}

describe("Code mode", () => {
  it("requires a project instead of invoking the neutral model when Code has no scope", async () => {
    const store = new InMemoryWorkspaceStore();
    const calls: ChatRequest[] = [];
    const ai = { chat: async (request: ChatRequest) => { calls.push(request); return { content: "No file tools" }; },
      supportsNativeTools: () => true } as unknown as AIEngine;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      for (const context of [{ contextType: "none" }, { contextType: "company", companyId: (await store.createCompany(auth, { name: "Scope Labs" }, "scope-labs")).id }]) {
        const response = await app.inject({ method: "POST", url: "/chat/stream", payload: {
          message: "Створи файл e2e-smoke/hello.txt з текстом Hello", mode: "code", ...context,
        } });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: "CODE_PROJECT_REQUIRED" } });
      }
      expect(calls).toHaveLength(0);
      expect(await store.listNeutralConversations(auth)).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("works on the selected project without a classifier call or record modules", async () => {
    const { classifierCalls, main } = await run("code");
    expect(classifierCalls).toHaveLength(0);
    const system = main.map((request) => String(request.messages[0]!.content)).join("\n");
    expect(system).not.toContain("USER'S CURRENT BUSINESSES");
  });

  it("keeps the classifier for Chat mode and for clients that send no mode", async () => {
    expect((await run("chat")).classifierCalls.length).toBeGreaterThan(0);
    expect((await run(undefined)).classifierCalls.length).toBeGreaterThan(0);
  });

  it("turns a conversational or creation reading into an edit of the selected project", () => {
    const chat = classifyProjectIntent({ message: "Привіт", activeProjectId: "p1", activeCompanyId: "c1", hasWorkspace: true });
    expect(codeModeDecision({ ...chat, intent: "CHAT" }).decision.intent).toBe("EDIT_PROJECT");
    expect(codeModeDecision({ ...chat, intent: "CREATE_WEBSITE" }).decision.intent).toBe("EDIT_PROJECT");
    expect(codeModeDecision({ ...chat, intent: "TEST_PROJECT" }).decision.intent).toBe("TEST_PROJECT");
    expect(codeModeDecision({ ...chat, intent: "CHAT" })).toMatchObject({ source: "guard", coreRoute: { mutation: false }, targets: [] });
  });
});
