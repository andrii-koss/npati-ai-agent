import { forbidsNewWebResearch, explicitlyRequestsWebResearch } from "../apps/agent-api/src/chat-text-directives";
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

function streamResult(body: string): Record<string, any> {
  const block = body.split(String.fromCharCode(10, 10)).find((item) => item.includes("event: result"));
  const data = block?.split(String.fromCharCode(10)).find((line) => line.startsWith("data: "));
  return data ? JSON.parse(data.slice(6)) : {};
}

function productionPathEngine(requests: ChatRequest[]): AIEngine {
  let sequence = 0;
  return {
    supportsNativeTools: () => true,
    chat: async (request) => {
      if (request.messages[0]?.content.startsWith("Classify the user's primary intent")) {
        return { content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [] }) };
      }
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
      if (/Create a complete AI-powered business company called NovaScale Labs/iu.test(user)) {
        const agents = [
          ["Alex Morgan", "Chief Strategy Agent"],
          ["Maya Chen", "Market Research Agent"],
          ["Daniel Brooks", "Sales Agent"],
          ["Sophie Taylor", "Customer Support Agent"],
          ["Emma Wilson", "Marketing & Content Agent"],
          ["Ryan Cooper", "Business Operations Agent"],
        ].map(([name, role], index) => ({
          action: "create",
          fields: { name, role, description: "Specialized NovaScale Labs agent", systemInstruction: "Stay focused on the assigned role and report completed work." },
          ...(index === 0 ? { main: true } : { parentAgentName: "Alex Morgan" }),
        }));
        return { content: "", toolCalls: [call("create-novascale-" + (++sequence), "npati_company_action", {
          action: "create",
          fields: {
            name: "NovaScale Labs",
            industry: "Digital Products & AI Automation",
            description: "AI-powered workflows for small and medium-sized businesses.",
          },
          agents,
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
  it("creates the full NovaScale company, then scans a URL in the same company chat", async () => {
    const store = new InMemoryWorkspaceStore();
    const requests: ChatRequest[] = [];
    const webResearch = researchService();
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: productionPathEngine(requests), marketplace, webResearch });
    const creationPrompt = [
      "Create a complete AI-powered business company called NovaScale Labs.",
      "Company Details",
      "Name: NovaScale Labs",
      "Industry: Digital Products & AI Automation",
      "Create the company with 6 specialized AI agents.",
      "1. Alex Morgan - Role: Chief Strategy Agent",
      "2. Maya Chen - Role: Market Research Agent - Research markets and analyze competitors",
      "3. Daniel Brooks - Role: Sales Agent",
      "4. Sophie Taylor - Role: Customer Support Agent",
      "5. Emma Wilson - Role: Marketing & Content Agent - Research relevant topics",
      "6. Ryan Cooper - Role: Business Operations Agent",
      "Create the company and all six agents with their respective roles, responsibilities, and collaboration structure.",
    ].join(String.fromCharCode(10));
    try {
      const created = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: creationPrompt, contextType: "none" } });
      const company = (await store.listCompanies(auth)).items.find((item) => item.name === "NovaScale Labs");
      expect(created.statusCode).toBe(200);
      expect(company).toBeDefined();
      expect(await store.listCompanyAgents(auth, company!.id)).toHaveLength(6);
      expect(webResearch.run).not.toHaveBeenCalled();
      expect(requests[0]?.toolChoice).toEqual({ type: "function", function: { name: "npati_company_action" } });
      expect(requests[0]?.messages.find((item) => item.role === "system")?.content).toContain("English (en)");
      const conversationId = String(streamResult(created.body).conversationId ?? "");
      expect(conversationId).not.toBe("");

      requests.length = 0;
      const scanned = await app.inject({ method: "POST", url: "/chat/stream", payload: {
        message: "Проскануй сайт [**npati.com**](https://npati.com/?utm_source=NPATI_Agent)",
        conversationId,
        contextType: "company",
        companyId: company!.id,
      } });

      expect(scanned.statusCode).toBe(200);
      expect(webResearch.run).toHaveBeenCalledTimes(1);
      expect(requests[0]?.toolChoice).toEqual({ type: "function", function: { name: "web_fetch" } });
      expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", name: "web_fetch" });
      expect(scanned.body).toContain("Сайт фактично відкрито");
      expect(scanned.body).not.toContain("тимчасову недоступність вибраної AI-моделі");
    } finally {
      await app.close();
    }
  });

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
      expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["npati_company_action", "web_search", "web_fetch", "npati_business_profile", "npati_goal_action"]);
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
      expect(requests[0]?.toolChoice).toEqual({ type: "function", function: { name: "npati_company_action" } });
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
      if (request.messages[0]?.content.startsWith("Classify the user's primary intent")) {
        return { content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [] }) };
      }
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

describe("a provider that refuses a forced tool_choice still answers from the fetched page", () => {
  function thinkingModeEngine(fallbackPrompts: string[]): AIEngine {
    const base = productionPathEngine([]);
    return {
      ...base,
      chat: async (request) => {
        if (typeof request.toolChoice === "object") throw Object.assign(new Error("OmniRoute chat failed with HTTP 400: Thinking mode does not support this tool_choice"), { httpStatus: 400 });
        return base.chat(request);
      },
      async *stream(request) {
        fallbackPrompts.push(request.messages.filter((item) => item.role === "system").map((item) => String(item.content)).join("\n"));
        yield "Answer from the supplied page evidence.";
      },
    };
  }

  it.each([
    ["Ukrainian", "Проаналізуй сайт https://npati.com і скажи, що покращити"],
    ["English", "Analyze the website https://npati.com and tell me what to improve"],
  ])("%s: fetches the named page once and puts its content into the fallback prompt", async (_label, message) => {
    const prompts: string[] = [];
    const webResearch = researchService();
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: thinkingModeEngine(prompts), marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(webResearch.run).toHaveBeenCalledTimes(1);
      expect(webResearch.run.mock.calls[0]?.[0]).toContain("https://npati.com");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Fetched page evidence: NPATI provides an AI business-agent platform.");
      expect(streamResult(response.body).research).toMatchObject({ used: true, kind: "url_analysis" });
    } finally {
      await app.close();
    }
  });

  it("states that the page could not be opened instead of analysing it from memory", async () => {
    const prompts: string[] = [];
    const webResearch = researchService();
    webResearch.run.mockRejectedValueOnce(new Error("fetch_failed: getaddrinfo ENOTFOUND unreachable.invalid"));
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: thinkingModeEngine(prompts), marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Проаналізуй сайт https://unreachable.invalid", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      // No page content: the answer is the error itself, the model is not asked to "analyse" anything.
      expect(prompts).toHaveLength(0);
      expect(streamResult(response.body).message).toMatch(/^Не вдалося відкрити сторінку https:\/\/unreachable\.invalid\/?: fetch_failed: getaddrinfo ENOTFOUND/);
      expect(streamResult(response.body).research).toMatchObject({ used: true, degraded: expect.stringContaining("ENOTFOUND") });
    } finally {
      await app.close();
    }
  });
});

describe("a failed web_fetch is reported to the model as missing evidence", () => {
  it("tells the model the page was not opened and must not be analysed from memory", async () => {
    const requests: ChatRequest[] = [];
    const webResearch = researchService();
    webResearch.run.mockRejectedValueOnce(new Error("No hostname allowlist is configured, so no host is reachable"));
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: productionPathEngine(requests), marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Analyze the website https://npati.com", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      const toolMessage = requests[1]?.messages.at(-1);
      expect(toolMessage).toMatchObject({ role: "tool", name: "web_fetch" });
      const content = JSON.parse(String(toolMessage?.content));
      expect(content.error).toContain("No hostname allowlist");
      expect(content.instruction).toMatch(/could not be opened.*Do not describe or analyse the page from memory/s);
    } finally {
      await app.close();
    }
  });
});

describe("an unreachable page gets a clear error, never an analysis from memory", () => {
  it("native tool path: the model's own text is replaced by the error", async () => {
    const webResearch = researchService();
    webResearch.run.mockRejectedValueOnce(new Error("No hostname allowlist is configured, so no host is reachable"));
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: productionPathEngine([]), marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Проаналізуй сайт https://npati.com", contextType: "none" } });
      const result = streamResult(response.body);
      expect(result.message).toMatch(/^Не вдалося відкрити сторінку https:\/\/npati\.com\/?: No hostname allowlist/);
      expect(result.message).not.toContain("actually opened");
    } finally {
      await app.close();
    }
  });

  it("fallback path: the model is not asked at all", async () => {
    const prompts: string[] = [];
    const webResearch = researchService();
    webResearch.run.mockRejectedValueOnce(new Error("fetch_failed: ENOTFOUND"));
    const base = productionPathEngine([]);
    const engine: AIEngine = { ...base, chat: async (request) => { if (typeof request.toolChoice === "object") throw new Error("HTTP 400: Thinking mode does not support this tool_choice"); return base.chat(request); },
      async *stream(request) { prompts.push(String(request.messages[0]?.content)); yield "From memory: example sites usually need a CTA."; } };
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: engine, marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Analyze the website https://unreachable.invalid", contextType: "none" } });
      expect(prompts).toHaveLength(0);
      expect(streamResult(response.body).message).toMatch(/^The page https:\/\/unreachable\.invalid\/? could not be opened: fetch_failed: ENOTFOUND/);
      expect(response.body).not.toContain("From memory");
    } finally {
      await app.close();
    }
  });
});

describe("a review request for an external URL reaches Web Research, not the project stub", () => {
  it("REVIEW_PROJECT + URL fetches the page", async () => {
    const webResearch = researchService();
    const base = productionPathEngine([]);
    const engine: AIEngine = { ...base, chat: async (request) => request.messages[0]?.content.startsWith("Classify the user's primary intent")
      ? { content: JSON.stringify({ intent: "REVIEW_PROJECT", confidence: 1, targets: [] }) } : base.chat(request) };
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: engine, marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Проаналізуй сайт https://npati.com", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(webResearch.run).toHaveBeenCalledTimes(1);
      expect(response.body).not.toContain("будуть розширені у наступних кроках");
    } finally {
      await app.close();
    }
  });
});

describe("a web search request survives a provider that refuses forced tool_choice", () => {
  const thinking = (prompts: string[]): AIEngine => {
    const base = productionPathEngine([]);
    return { ...base, chat: async (request) => { if (typeof request.toolChoice === "object") throw new Error("HTTP 400: Thinking mode does not support this tool_choice"); return base.chat(request); },
      async *stream(request) { prompts.push(request.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n")); yield "Answer from the supplied evidence."; } };
  };

  it("runs the search before the tool-less fallback and gives it the evidence", async () => {
    const prompts: string[] = [];
    const webResearch = researchService();
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: thinking(prompts), marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Знайди в інтернеті три інтернет-магазини з подібними товарами і проаналізуй їхній дизайн. Пошукай competitors.", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(webResearch.run).toHaveBeenCalledTimes(1);
      expect(prompts[0]).toContain("Verified competitor evidence from external public sources.");
    } finally {
      await app.close();
    }
  });

  it("states that the search returned nothing instead of answering from memory", async () => {
    const prompts: string[] = [];
    const webResearch = researchService();
    webResearch.run.mockRejectedValueOnce(new Error("search provider unavailable"));
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: thinking(prompts), marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Знайди в інтернеті competitors для мого магазину", contextType: "none" } });
      expect(prompts).toHaveLength(0);
      expect(streamResult(response.body).message).toMatch(/^Вебпошук не дав результатів.*search provider unavailable/s);
    } finally {
      await app.close();
    }
  });

  it("a model's web_search call is executed in search mode", async () => {
    const requests: ChatRequest[] = [];
    const webResearch = researchService();
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: productionPathEngine(requests), marketplace, webResearch });
    try {
      await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Search the web for competitors of my store", contextType: "none" } });
      const searchCall = webResearch.run.mock.calls.find((call: unknown[]) => (call[4] as { mode?: string } | undefined)?.mode === "search");
      expect(searchCall).toBeDefined();
    } finally {
      await app.close();
    }
  });
});


describe("explicit research recall restrictions", () => {
  const requests = [
    "Return to the earlier Apple analysis, without searching again.",
    "Vuelve al analisis anterior. Sin buscar otra vez, resume dos decisiones.",
    "Use o estudo anterior, sem pesquisar novamente.",
    "Nutze die vorherige Analyse, ohne neue Recherche.",
    "Verwende die frühere Analyse von Apple, Samsung und Google. Keine neue Websuche und keine Codeänderung.",
    "Use the earlier comparison; no new web search.",
    "Usa el análisis anterior, ninguna búsqueda nueva.",
    "Use a análise anterior, nenhuma nova pesquisa.",
    "\u0412\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u0430\u0439 \u043f\u043e\u043f\u0435\u0440\u0435\u0434\u043d\u0456\u0439 \u0430\u043d\u0430\u043b\u0456\u0437, \u0431\u0435\u0437 \u043d\u043e\u0432\u043e\u0433\u043e \u043f\u043e\u0448\u0443\u043a\u0443.",
  ];
  it.each(requests)("recognizes a current-turn restriction: %s", message => {
    expect(forbidsNewWebResearch(message)).toBe(true);
    expect(explicitlyRequestsWebResearch(message + " https://apple.com")).toBe(false);
  });
  it.each([true, false])("does not call research with native tools=%s even when heuristics request it", async native => {
    const observed: ChatRequest[] = [];
    const webResearch = researchService();
    const ai: AIEngine = {
      supportsNativeTools: () => native,
      chat: async request => {
        if (String(request.messages[0]?.content).startsWith("Classify the user's primary intent")) return { content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [] }) };
        observed.push(request);
        return { content: "Prior analysis: preserve short navigation and a visible catalog." };
      },
      async *stream(request) { observed.push(request); yield "Prior analysis: short navigation."; },
    };
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace, webResearch });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: requests[1], contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(webResearch.run).not.toHaveBeenCalled();
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.flatMap(request => request.tools ?? []).some(tool => ["web_search", "web_fetch"].includes(tool.function.name))).toBe(false);
      expect(streamResult(response.body).message).toContain("Prior analysis");
    } finally { await app.close(); }
  });
  it("continues to allow an explicit fresh research request", () => {
    expect(forbidsNewWebResearch("Research https://apple.com again and compare the changes.")).toBe(false);
    expect(explicitlyRequestsWebResearch("Research https://apple.com again and compare the changes.")).toBe(true);
  });
});

it("does not read an ordinary 'no' sentence as a research restriction", () => {
  expect(forbidsNewWebResearch("Search the web for bakery trends; no payment is required.")).toBe(false);
});
