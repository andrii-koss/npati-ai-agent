import { describe, expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const auth: AuthContext = {
  userId: "production-flow-user",
  workspaceId: "production-flow-workspace",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute", "research:execute"],
};

const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

function call(id: string, name: string, args: Record<string, unknown>): ChatToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function latestUser(request: ChatRequest) {
  const message = [...request.messages].reverse().find((item) => item.role === "user");
  return typeof message?.content === "string" ? message.content : "";
}

function productionPathEngine(requests: ChatRequest[]): AIEngine {
  let sequence = 0;
  return {
    supportsNativeTools: () => true,
    chat: async (request) => {
      requests.push(request);
      const last = request.messages.at(-1);
      const user = latestUser(request);
      if (last?.role === "tool") {
        if (last.name === "web_search" && /create 3 agents/i.test(user)) {
          return { content: "", toolCalls: [call("company-" + (++sequence), "npati_company_action", {
            action: "update",
            companyName: "Test Company",
            agents: Array.from({ length: 3 }, (_, index) => ({
              action: "create",
              fields: {
                name: "Competitor Agent " + (index + 1),
                role: index === 0 ? "Coordinator" : "Specialist",
                description: "Uses verified competitor research.",
                systemInstruction: "Use the supplied research evidence.",
              },
            })),
          })] };
        }
        if (last.name === "web_fetch") {
          return { content: /Проскануй|проаналізуй/iu.test(user)
            ? "Сайт фактично відкрито та проаналізовано на основі отриманого вмісту."
            : "The URL was actually opened and analyzed from the returned page content." };
        }
        return { content: /Crie uma empresa/iu.test(user)
          ? "A empresa foi criada com sucesso."
          : "Research completed and three agents were created." };
      }

      const forced = typeof request.toolChoice === "object" ? request.toolChoice.function.name : undefined;
      if (forced === "web_fetch") {
        const url = user.split(" ").find((part) => part.startsWith("http://") || part.startsWith("https://")) ?? "https://npati.com";
        return { content: "", toolCalls: [call("fetch-" + (++sequence), "web_fetch", { url, goal: user })] };
      }
      if (forced === "web_search") {
        return { content: "", toolCalls: [call("search-" + (++sequence), "web_search", { query: user })] };
      }
      if (/Create a company called Test Company/i.test(user)) {
        return { content: "", toolCalls: [call("create-" + (++sequence), "npati_company_action", {
          action: "create", fields: { name: "Test Company" },
        })] };
      }
      if (/Crie uma empresa chamada Test Portugal/iu.test(user)) {
        return { content: "", toolCalls: [call("create-" + (++sequence), "npati_company_action", {
          action: "create", fields: { name: "Test Portugal", languages: ["Portuguese"] },
        })] };
      }
      return { content: "No tool was executed." };
    },
    async *stream() { throw new Error("Production native-tool path must not fall back to streaming"); },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => undefined,
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"],
    healthCheck: async () => ({ status: "ok" }),
  };
}

function researchService() {
  const run = vi.fn(async (query: string) => ({
    kind: query.includes("http") ? "url_analysis" as const : "web_search" as const,
    context: query.includes("http")
      ? "Fetched page evidence: NPATI provides an AI business-agent platform."
      : "Verified competitor evidence from external public sources.",
    sources: [{ url: query.includes("http") ? "https://npati.com/" : "https://example.com/competitors", title: "Verified source", accessedAt: new Date().toISOString() }],
  }));
  return {
    shouldResearch: (message: string) => /https?:|research|competitors|pesquise|concorrentes/iu.test(message),
    run,
  } as any;
}

describe("production chat endpoint tool execution", () => {
  it.each([
    ["English", "Open and analyze https://npati.com", "English (en)"],
    ["Ukrainian", "Проскануй сайт https://npati.com", "Ukrainian (uk)"],
  ])("executes web_fetch for an explicit %s URL request", async (_label, message, languageMarker) => {
    const store = new InMemoryWorkspaceStore();
    const requests: ChatRequest[] = [];
    const webResearch = researchService();
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: productionPathEngine(requests), marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(webResearch.run).toHaveBeenCalledTimes(1);
      expect(webResearch.run.mock.calls[0]?.[0]).toContain("https://npati.com");
      expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["npati_company_action", "web_search", "web_fetch"]);
      expect(requests[0]?.tools?.find((tool) => tool.function.name === "web_fetch")?.function.description).toContain("Open, scan, or analyze");
      expect(requests[0]?.toolChoice).toEqual({ type: "function", function: { name: "web_fetch" } });
      expect(requests[0]?.messages.find((item) => item.role === "system")?.content).toContain(languageMarker);
      expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", name: "web_fetch" });
      expect(response.body).toMatch(/фактично відкрито|actually opened/iu);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["Create a company called Test Company", "Test Company", /created|complete/iu],
    ["Crie uma empresa chamada Test Portugal", "Test Portugal", /empresa foi criada/iu],
  ])("executes only the internal company tool for %s", async (message, companyName, responsePattern) => {
    const store = new InMemoryWorkspaceStore();
    const requests: ChatRequest[] = [];
    const webResearch = researchService();
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: productionPathEngine(requests), marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(webResearch.run).not.toHaveBeenCalled();
      expect(requests[0]?.toolChoice).toBe("auto");
      expect(requests.flatMap((request) => request.messages).filter((item) => item.role === "tool").map((item) => item.name)).toEqual(["npati_company_action"]);
      expect((await store.listCompanies(auth)).items.map((company) => company.name)).toEqual([companyName]);
      expect(response.body).toMatch(responsePattern);
    } finally {
      await app.close();
    }
  });

  it("executes web research before the internal three-agent action", async () => {
    const store = new InMemoryWorkspaceStore();
    const requests: ChatRequest[] = [];
    const webResearch = researchService();
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: productionPathEngine(requests), marketplace, webResearch });
    try {
      await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Create a company called Test Company", contextType: "none" } });
      requests.length = 0;
      webResearch.run.mockClear();

      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: {
        message: "Research competitors for Test Company and then create 3 agents",
        contextType: "none",
      } });

      const company = (await store.listCompanies(auth)).items.find((item) => item.name === "Test Company")!;
      expect(response.statusCode).toBe(200);
      expect(webResearch.run).toHaveBeenCalledTimes(1);
      expect(requests[0]?.toolChoice).toEqual({ type: "function", function: { name: "web_search" } });
      expect(requests[1]?.toolChoice).toBe("auto");
      expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", name: "web_search" });
      expect(requests[2]?.messages.at(-1)).toMatchObject({ role: "tool", name: "npati_company_action" });
      const agents = await store.listCompanyAgents(auth, company.id);
      expect(agents.filter((agent) => agent.name.startsWith("Competitor Agent"))).toHaveLength(3);
      expect(response.body).toContain("Research completed and three agents were created.");
    } finally {
      await app.close();
    }
  });

  it("executes Portuguese web research and keeps the final response Portuguese", async () => {
    const store = new InMemoryWorkspaceStore();
    const requests: ChatRequest[] = [];
    const webResearch = researchService();
    const ai = productionPathEngine(requests);
    ai.chat = async (request) => {
      requests.push(request);
      if (request.messages.at(-1)?.role === "tool") return { content: "A pesquisa foi concluída com fontes externas verificadas." };
      return { content: "", toolCalls: [call("pt-search", "web_search", { query: "concorrentes atuais de automação em Portugal" })] };
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: {
        message: "Pesquise na web os concorrentes atuais de automação em Portugal",
        contextType: "none",
      } });
      expect(response.statusCode).toBe(200);
      expect(webResearch.run).toHaveBeenCalledTimes(1);
      expect(requests[0]?.toolChoice).toEqual({ type: "function", function: { name: "web_search" } });
      expect(requests[0]?.messages.find((item) => item.role === "system")?.content).toContain("Portuguese (pt)");
      expect(response.body).toContain("A pesquisa foi concluída");
    } finally {
      await app.close();
    }
  });
});
