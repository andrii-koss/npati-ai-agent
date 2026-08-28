import { buildApp } from "../apps/agent-api/src/app";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { WebResearchService } from "@npati/web-research";
import { afterEach, describe, expect, it } from "vitest";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("Agent API", () => {
  it("streams real research progress events before the final result", async () => {
    const aiEngine: AIEngine = {
      chat: async () => ({ content: "Final researched answer." }),
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const webResearch = {
      shouldResearch: () => true,
      run: async (_message: string, _business: unknown, _refresh: boolean, progress?: (event: Record<string, unknown>) => void) => {
        progress?.({ type: "search_started", query: "Hostkoss official website" });
        progress?.({ type: "search_results_received", query: "Hostkoss official website", resultCount: 1 });
        progress?.({ type: "source_discovered", url: "https://hostkoss.com/", title: "Hostkoss" });
        progress?.({ type: "page_fetch_started", url: "https://hostkoss.com/", domain: "hostkoss.com" });
        progress?.({ type: "page_fetch_completed", url: "https://hostkoss.com/", domain: "hostkoss.com", title: "Hostkoss" });
        progress?.({ type: "research_completed", sourceCount: 1, pageCount: 1 });
        return { kind: "web_search" as const, context: "Hostkoss evidence", sources: [{ url: "https://hostkoss.com/", title: "Hostkoss", accessedAt: new Date().toISOString() }] };
      },
    } as unknown as WebResearchService;
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace, webResearch });
    apps.push(app);
    const business = await app.inject({ method: "POST", url: "/businesses", payload: { name: "Research Lab", businessStage: "operating" } });
    const conversation = await app.inject({
      method: "POST",
      url: "/businesses/" + business.json().id + "/conversations",
      payload: { title: "New conversation" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/chat/stream",
      payload: { message: "Analyze Hostkoss and its services", conversationId: conversation.json().id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const types = [...response.body.matchAll(/event: progress\ndata: ({[^\n]+})/g)].map((match) => JSON.parse(match[1]!).type);
    expect(types).toEqual([
      "search_started",
      "search_results_received",
      "source_discovered",
      "page_fetch_started",
      "page_fetch_completed",
      "research_completed",
      "final_generation_started",
      "final_generation_completed",
    ]);
    expect(response.body.indexOf("search_started")).toBeLessThan(response.body.indexOf("event: result"));
    expect(response.body).toContain("Final researched answer.");
    const conversations = await app.inject({ method: "GET", url: "/businesses/" + business.json().id + "/conversations" });
    expect(conversations.json()[0].title).toBe("Analyze Hostkoss and its services");
  });

  it("starts and exposes aggregate health", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      services: { agent: "ok", omniroute: "not_configured", hub: "not_configured" },
    });
  });

  it("requires an AI provider but does not require a Business before opening Chat", async () => {
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 0 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ marketplace });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Start a business" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("AI_PROVIDER_REQUIRED");
  });

  it("starts rapid onboarding directly from a free-text business brief", async () => {
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const instruction = request.messages[0]?.content ?? "";
        if (instruction.includes("answer validator")) {
          return { content: '{"valid":true,"feedback":"","business":{"name":"Language Lab","description":"online Ukrainian lessons","market":"Poland","businessStage":"idea","teamType":"solo","businessModel":"subscription","presenceType":"online","audienceSummary":"Ukrainian families","productsServicesSummary":"weekly lessons and printable materials"}}' };
        }
        return { content: "What is the first meaningful goal you want to achieve? Example: I want to get my first 1,000 customers." };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "I want to launch online Ukrainian lessons in Poland for Ukrainian families. I will start solo with a subscription." } });
    expect(response.statusCode).toBe(200);
    expect(response.json().onboarding).toMatchObject({
      scenario: "starting",
      currentField: "businessGoal",
      currentStep: 1,
      totalFields: 2,
      business: { name: "Language Lab", market: "Poland", teamType: "solo", presenceType: "online" },
    });
    expect(response.json().message).toContain("1,000 customers");
  });

  it("runs conversational onboarding through AI and writes a structured Business Profile", async () => {
    const calls: ChatRequest[] = [];
    const aiEngine: AIEngine = {
      chat: async (request) => {
        calls.push(request);
        const instruction = request.messages[0]?.content ?? "";
        if (instruction.includes("answer validator")) {
          if (instruction.includes("Target field: businessGoal")) {
            return { content: '{"valid":true,"feedback":"Ціль збережено.","goalTitle":"Отримати перших 1,000 клієнтів"}' };
          }
          return instruction.includes("asdf qwer zzzz") || instruction.includes("Привіт")
            ? { content: '{"valid":false,"feedback":"Це не схоже на назву бізнесу. Напишіть, будь ласка, його назву."}' }
            : { content: '{"valid":true,"feedback":"","business":{"name":"Happy Candle","niche":"home fragrance","market":"United States","businessStage":"operating","teamType":"solo","businessModel":"B2C","presenceType":"online","audienceSummary":"home decor and gift buyers","productsServicesSummary":"handmade soy candles"}}' };
        }
        if (instruction.includes("conversational business onboarding")) {
          return instruction.includes("Привіт")
            ? { content: "Привіт! Радий познайомитися. Що ви хочете створити або продавати?" }
            : { content: "Схоже, ми почали не з того. Напишіть коротко, що ви хочете створити або продавати." };
        }
        if (instruction.includes("NPATI Hub")) {
          return { content: "Бізнес зрозумілий. Перший етап — залучення трафіку. Для цього бізнесу варто підключити Instagram, TikTok і Facebook до NPATI Hub, щоб разом створювати дописи та планувати публікації. Коли підключите, напишіть мені — я перевірю підключення." };
        }
        const prefix = /[іїєґ]/i.test(instruction.match(/latest answer is: ([^\n]+)/)?.[1] ?? "") ? "Добре. " : "Great. ";
        return { content: prefix + (instruction.match(/intended question is: ([^\n]+)/)?.[1] ?? "Tell me more.") };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = {
      marketplace: async () => ({ overview: { connectedProviders: 1 } }),
    } as unknown as OmniRouteMarketplace;
    const store = new InMemoryWorkspaceStore();
    const app = buildApp({ workspaceStore: store, aiEngine, marketplace });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: "/chat", payload: { onboardingAction: "start", scenario: "existing" } });
    expect(started.statusCode).toBe(200);
    expect(started.json().onboarding).toMatchObject({ currentField: "businessSnapshot", status: "active" });
    expect(calls[0]?.model).toBe("auto/chat:free");

    const invalid = await app.inject({ method: "POST", url: "/chat", payload: { message: "asdf qwer zzzz" } });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().message).toContain("почали не з того");
    expect(invalid.json().onboarding).toMatchObject({ currentField: "businessSnapshot", business: { name: "Business setup" } });
    expect(invalid.json().onboarding.completedFields).not.toContain("businessSnapshot");

    const greeting = await app.inject({ method: "POST", url: "/chat", payload: { message: "Привіт" } });
    expect(greeting.statusCode).toBe(200);
    expect(greeting.json().message).toMatch(/^Привіт!/);
    expect(greeting.json().message).not.toMatch(/[—–]/);
    expect(greeting.json().onboarding.currentField).toBe("businessSnapshot");

    const named = await app.inject({ method: "POST", url: "/chat", payload: { message: "Happy Candle sells handmade soy candles online in the United States to home decor and gift buyers. It is a solo B2C operating business." } });
    expect(named.statusCode).toBe(200);
    expect(named.json().onboarding.business).toMatchObject({ name: "Happy Candle", activationStatus: "draft" });
    expect(named.json().onboarding.completedFields).toContain("businessSnapshot");
    expect(named.json().onboarding.business.productsServicesSummary).toContain("soy candles");
    const memory = await app.inject({ method: "GET", url: `/businesses/${named.json().onboarding.businessId}/memory` });
    expect(memory.statusCode).toBe(200);
    expect(memory.json()).toMatchObject([{ type: "business_fact", source: "chat_onboarding", content: expect.stringContaining("soy candles") }]);

    const localized = await app.inject({ method: "POST", url: "/chat", payload: { message: "Хочу отримати перших 1000 клієнтів." } });
    expect(localized.statusCode).toBe(200);
    expect(localized.json().message).toContain("NPATI Hub");
    expect(localized.json().message).not.toMatch(/[—–]/);
    expect(localized.json().onboarding.status).toBe("completed");
    const goals = await app.inject({ method: "GET", url: `/businesses/${localized.json().onboarding.businessId}/goals` });
    expect(goals.statusCode).toBe(200);
    expect(goals.json()).toMatchObject([{ title: "Отримати перших 1,000 клієнтів", status: "active" }]);

    const context = await app.inject({ method: "GET", url: "/workspace/context" });
    expect(context.json()).toMatchObject({ currentBusiness: { name: "Happy Candle", activationStatus: "active" }, onboarding: null });
    const conversations = await app.inject({ method: "GET", url: `/businesses/${localized.json().onboarding.businessId}/conversations` });
    expect(conversations.json()).toHaveLength(1);
  });

  it("accepts a short useful business description without requesting optional details", async () => {
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const instruction = request.messages[0]?.content ?? "";
        if (instruction.includes("answer validator")) {
          return { content: JSON.stringify({ valid: false, feedback: "Потрібно більше деталей.", business: { market: "Ukraine", teamType: "solo", presenceType: "online", productsServicesSummary: "tables" } }) };
        }
        return { content: "Якого першого результату ви хочете досягти з продажем столів?" };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Україна, продаю столи, сам працюю, онлайн." } });
    expect(response.statusCode).toBe(200);
    expect(response.json().onboarding).toMatchObject({
      currentField: "businessGoal",
      currentStep: 1,
      business: { market: "Ukraine", teamType: "solo", presenceType: "online", productsServicesSummary: "tables" },
    });
    expect(response.json().message).toContain("столів");
  });

  it("rejects an invalid onboarding goal without saving it and continues to traffic guidance", async () => {
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const instruction = request.messages[0]?.content ?? "";
        if (instruction.includes("answer validator") && instruction.includes("Target field: businessGoal")) {
          return { content: '{"valid":false,"feedback":"Ця відповідь не підходить для цілі. Додайте ціль вручну в розділі Goals."}' };
        }
        if (instruction.includes("answer validator")) {
          return { content: '{"valid":true,"feedback":"","business":{"name":"Eco Home","description":"online eco home shop","market":"Ukraine","businessStage":"idea","teamType":"solo","businessModel":"B2C","presenceType":"online","audienceSummary":"people reducing single-use plastic","productsServicesSummary":"reusable bottles, bags and containers"}}' };
        }
        if (instruction.includes("NPATI Hub")) {
          return { content: "Бізнес зрозумілий. Перший етап — залучення трафіку. Рекомендую Instagram, TikTok і Facebook. Підключіть їх до NPATI Hub, а потім напишіть мені — я перевірю підключення." };
        }
        return { content: "Якої першої конкретної цілі ви хочете досягти? Наприклад: отримати перших 1000 клієнтів." };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);

    const brief = await app.inject({ method: "POST", url: "/chat", payload: { message: "Хочу створити онлайн-магазин екотоварів в Україні для людей, які зменшують використання пластику." } });
    expect(brief.statusCode).toBe(200);
    expect(brief.json().onboarding.currentField).toBe("businessGoal");

    const invalidGoal = await app.inject({ method: "POST", url: "/chat", payload: { message: "asdf qwer zzzz" } });
    expect(invalidGoal.statusCode).toBe(200);
    expect(invalidGoal.json().message).toContain("NPATI Hub");
    expect(invalidGoal.json().onboarding.status).toBe("completed");

    const businessId = invalidGoal.json().onboarding.businessId;
    const goals = await app.inject({ method: "GET", url: `/businesses/${businessId}/goals` });
    expect(goals.json()).toEqual([]);
    const history = await app.inject({ method: "GET", url: `/businesses/${businessId}/conversations` });
    const conversation = await app.inject({ method: "GET", url: `/businesses/${businessId}/conversations/${history.json()[0].id}` });
    const messages = conversation.json().messages;
    expect(messages.at(-2)?.content).toContain("Goals");
    expect(messages.at(-1)?.content).toContain("NPATI Hub");
  });

  it("stores Business and Goal from one short message without asking optional questions", async () => {
    const aiEngine: AIEngine = {
      chat: async (request) => {
        const instruction = request.messages[0]?.content ?? "";
        if (instruction.includes("answer validator")) {
          return {
            content: JSON.stringify({
              valid: true,
              feedback: "",
              business: {
                market: "Ukraine",
                country: "Ukraine",
                businessStage: "starting",
                presenceType: "local",
                productsServicesSummary: "oil sold at a market",
              },
              goalTitle: "Заробляти 500 доларів на місяць",
            }),
          };
        }
        if (instruction.includes("NPATI Hub")) {
          return { content: "Для залучення покупців спробуйте Facebook та Instagram. Підключити канали можна тут: https://www.npati.com/hub/ Після підключення напишіть мені, і я перевірю з’єднання." };
        }
        return { content: "Це запитання не повинно з’явитися." };
      },
      async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), aiEngine, marketplace });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Я хочу продавати олію на базарі в Україні, ціль 500 доларів у місяць." },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().onboarding).toMatchObject({
      status: "completed",
      business: { market: "Ukraine", presenceType: "local", productsServicesSummary: "oil sold at a market" },
    });
    expect(response.json().message).toContain("https://www.npati.com/hub/?utm_source=NPATI_Agent");
    expect(response.json().message).not.toContain("яку саме олію");
    expect(response.json().message).not.toContain("основним покупцем");

    const businessId = response.json().onboarding.businessId;
    const goals = await app.inject({ method: "GET", url: "/businesses/" + businessId + "/goals" });
    expect(goals.json()).toMatchObject([{ title: "Заробляти 500 доларів на місяць", status: "active" }]);
    const memory = await app.inject({ method: "GET", url: "/businesses/" + businessId + "/memory" });
    expect(memory.json()).toMatchObject([{ type: "business_fact", content: expect.stringContaining("олію") }]);
  });

  it("creates a business through backend-owned local auth context", async () => {
    const app = buildApp();
    apps.push(app);
    const created = await app.inject({
      method: "POST", url: "/businesses",
      headers: { "x-workspace-id": "spoofed-workspace" },
      payload: { name: "North Star Studio", businessStage: "operating" },
    });
    expect(created.statusCode).toBe(201);
    const context = await app.inject({ method: "GET", url: "/workspace/context" });
    expect(context.json()).toMatchObject({
      workspace: { id: "dev-workspace" },
      currentBusiness: { name: "North Star Studio" },
    });
  });
});
