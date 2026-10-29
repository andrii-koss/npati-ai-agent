import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

// Measures the prompt the main chat model receives for each semantic route, without calling a provider.
// MiMo tokenized the stage 15 prompt at 1.47 characters per token (65 686 chars -> 44 697 tokens), so
// characters / 1.47 approximates provider tokens for this mix of English rules, Cyrillic and UUIDs.
const CHARS_PER_TOKEN = 1.47;
const auth: AuthContext = { userId: "budget-user", workspaceId: "budget-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

type Route = { coreCapability: string | null; coreMutation: boolean; additionalCoreCapabilities?: string[]; format?: string };
const scenarios: Array<{ name: string; message: string; route: Route; company?: boolean; history?: boolean }> = [
  { name: "conversation", message: "Скільки буде 2+2?", route: { coreCapability: null, coreMutation: false, format: "none" } },
  { name: "draft_writing", message: "Напиши короткий слоган для сімейної пекарні.", route: { coreCapability: null, coreMutation: false, format: "draft" } },
  { name: "company_draft", message: "Напиши короткий слоган для сімейної пекарні.", route: { coreCapability: null, coreMutation: false, format: "draft" }, company: true },
  { name: "long_history", message: "А тепер коротше.", route: { coreCapability: null, coreMutation: false, format: "none" }, history: true },
  { name: "business_read", message: "Яка цільова аудиторія бізнесу Budget Bakery 3?", route: { coreCapability: "npati_business_profile", coreMutation: false } },
  { name: "business_create", message: "Створи бізнес-профіль Budget New Cafe, ринок Київ.", route: { coreCapability: "npati_business_profile", coreMutation: true } },
  { name: "goal_create", message: "Додай ціль «100 замовлень» для Budget Bakery 3.", route: { coreCapability: "npati_goal_action", coreMutation: true } },
  { name: "company_update", message: "Зміни тон бренду цієї компанії на дружній.", route: { coreCapability: "npati_company_action", coreMutation: true }, company: true },
  { name: "workspace_memory", message: "Запам'ятай, що постачальник борошна — Млин-3.", route: { coreCapability: "npati_workspace_action", coreMutation: true } },
  { name: "email_read", message: "Покажи останні листи компанії.", route: { coreCapability: "npati_email_action", coreMutation: false }, company: true },
];

async function seed(store: InMemoryWorkspaceStore) {
  for (let index = 1; index <= 20; index += 1) {
    const business = await store.createBusiness(auth, { name: `Budget Bakery ${index}`, businessStage: "operating", industry: "Food", country: "Ukraine", market: "Kyiv",
      audienceSummary: "Local families and office workers who want fresh bread every morning", productsServicesSummary: "Sourdough bread, pastries and coffee",
      description: "A neighbourhood bakery with a small cafe area and online pre-orders" });
    await store.createGoal(auth, business.id, { title: `Reach 100 weekly orders ${index}`, priority: 1, status: "active" });
    await store.createGoal(auth, business.id, { title: `Open second location ${index}`, priority: 2, status: "active" });
  }
  const companies = [];
  for (let index = 1; index <= 5; index += 1) companies.push(await store.createCompany(auth, { name: `Budget Company ${index}`, description: "Bakery operations company" }, `budget-company-${index}`));
  return companies;
}

function measure(request: ChatRequest) {
  const text = (content: unknown) => typeof content === "string" ? content : JSON.stringify(content ?? "");
  const systemChars = request.messages.filter((message) => message.role === "system").reduce((sum, message) => sum + text(message.content).length, 0);
  const totalChars = request.messages.reduce((sum, message) => sum + text(message.content).length, 0);
  const toolChars = JSON.stringify(request.tools ?? []).length;
  return { systemChars, totalChars, toolChars, tools: (request.tools ?? []).map((tool) => tool.function.name),
    estimatedTokens: Math.round((totalChars + toolChars) / CHARS_PER_TOKEN) };
}

describe("chat prompt budget", () => {
  it("records the main-call prompt size for every route", async () => {
    const results: Record<string, ReturnType<typeof measure> & { modelCalls: number; classifierChars: number }> = {};
    for (const scenario of scenarios) {
      const store = new InMemoryWorkspaceStore();
      const companies = await seed(store);
      const main: ChatRequest[] = [];
      let modelCalls = 0, classifierChars = 0;
      const ai: AIEngine = {
        supportsNativeTools: () => true,
        async chat(request) {
          modelCalls += 1;
          if (request.tools?.[0]?.function.name === "npati_classify_chat_intent") {
            classifierChars = request.messages.reduce((sum, message) => sum + String(message.content).length, 0) + JSON.stringify(request.tools).length;
            const args = { intent: "CHAT", confidence: 0.99, targets: [], entityRead: null, assignsWorkToCompanyAgent: false, externalResearch: false, ...scenario.route };
            return { content: "", toolCalls: [{ id: "route", type: "function", function: { name: "npati_classify_chat_intent", arguments: JSON.stringify(args) } }] };
          }
          const system = request.messages[0];
          if (system?.role === "system" && typeof system.content === "string" && system.content.startsWith("You are NPATI Agent")) {
            main.push(request);
            return { content: "Готово." };
          }
          return { content: "{}" };
        },
        async *stream() { throw new Error("Native chat must not stream"); },
        listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
        searchMemory: async () => [], saveMemory: async () => undefined,
        getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
      };
      const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
      try {
        const context = scenario.company ? { contextType: "company", companyId: companies[0]!.id } : { contextType: "none" };
        let conversationId: string | undefined;
        if (scenario.history) {
          const created = (await app.inject({ method: "POST", url: "/conversations", payload: { title: "History" } })).json() as { id?: string; data?: { id: string } };
          conversationId = created.id ?? created.data!.id;
          for (let index = 0; index < 6; index += 1) await store.appendNeutralMessage(auth, conversationId, index % 2 ? "assistant" : "user", `Повідомлення ${index}: ` + "докладний текст ".repeat(200));
        }
        const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: scenario.message, ...(conversationId ? { conversationId } : {}), ...context } });
        expect(response.statusCode, scenario.name).toBe(200);
      } finally { await app.close(); }
      expect(main.length, scenario.name).toBeGreaterThan(0);
      results[scenario.name] = { ...measure(main[0]!), modelCalls, classifierChars };
      const out = process.env.NPATI_PROMPT_BUDGET_OUT;
      if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/${scenario.name}.system.txt`, main[0]!.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n=====\n\n")); }
    }
    const out = process.env.NPATI_PROMPT_BUDGET_OUT;
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(out + "/prompt-sizes.json", JSON.stringify({ charsPerToken: CHARS_PER_TOKEN, seed: { businesses: 20, goalsPerBusiness: 2, companies: 5 }, results }, null, 2)); }
    console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, r]) => [name, { tokens: r.estimatedTokens, system: r.systemChars, classifier: r.classifierChars, tools: r.tools.length, calls: r.modelCalls }]))));
    // Stage 16 budgets (characters of the whole main-call prompt incl. tool schemas, 20 Businesses seeded). Stage 15
    // sent 39-50k system characters on every route; a conversational turn must not carry stored records again.
    // Writing rules follow the router's format, so plain conversation carries neither SEO nor table rules.
    const budgets: Record<string, number> = { conversation: 6_000, draft_writing: 7_000, business_read: 36_000, business_create: 42_000, goal_create: 31_000,
      company_update: 18_000, workspace_memory: 24_000, email_read: 19_000 };
    for (const [name, limit] of Object.entries(budgets)) {
      const r = results[name]!;
      expect(r.totalChars + r.toolChars, name).toBeLessThanOrEqual(limit);
    }
    expect(results.conversation!.tools.filter((tool) => tool.startsWith("npati_"))).toEqual([]);
    // The router reads only the latest four turns, trimmed; six 3 200-character turns once added about 19k characters.
    expect(results.conversation!.classifierChars).toBeLessThanOrEqual(20_000);
    expect(results.long_history!.classifierChars - results.conversation!.classifierChars).toBeLessThanOrEqual(6_500);
  }, 120_000);
});
