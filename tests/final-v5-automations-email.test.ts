import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { registerIntegrationsRoutes } from "../apps/agent-api/src/integrations-routes";
import type { CompanyWebhook, IntegrationsRepository } from "../apps/agent-api/src/integrations-repository";

const auth: AuthContext = { userId: "fv5-12-user", workspaceId: "fv5-12-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const toolCall = (id: string, name: string, args: Record<string, unknown>): ChatToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
function engine(decision: Record<string, unknown>, chat: (request: ChatRequest) => Promise<Awaited<ReturnType<AIEngine["chat"]>>>, requests: ChatRequest[]): AIEngine {
  return {
    supportsNativeTools: () => true,
    chat: request => String(request.messages[0]?.content).startsWith("Classify the user's primary intent")
      ? Promise.resolve({ content: JSON.stringify({ confidence: 1, targets: [], entityRead: null, ...decision }) })
      : (requests.push(request), chat(request)),
    async *stream() { yield "Plain answer."; },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
  };
}

describe("Final V5 stage 12: email reads in Chat", () => {
  it("V5-D68/D69: a semantically routed inbox read without email keywords gets the Email context and may run a read action", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Mail Shop" }, "mail-shop");
    const requests: ChatRequest[] = [];
    const ai = engine({ intent: "CHAT", coreCapability: "npati_email_action", coreMutation: false }, async request => request.messages.some(message => message.role === "tool")
      ? { content: "Inbox checked." }
      : { content: "", toolCalls: [toolCall("read-inbox", "npati_email_action", { action: "inbox.list", companyId: company.id })] }, requests);
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      // "листи … надійшли" is not one of the email keywords; only the classifier knows this is an inbox read.
      const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "Які нові листи надійшли для «Mail Shop»?", contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      const first = requests.find(request => request.tools?.some(tool => tool.function.name === "npati_email_action"));
      expect(JSON.stringify(first?.messages)).toContain("inbox.list");
      const toolResult = requests.flatMap(request => request.messages).find(message => message.role === "tool");
      expect(String(toolResult?.content)).not.toContain("write on a read-only request");
    } finally { await app.close(); }
  });
});

describe("V6 step 11: an email read is evidence, not the answer", () => {
  it("keeps the model's answer when a misrouted inbox search found nothing", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "V6TEST_Bakery2" }, "bakery");
    const requests: ChatRequest[] = [];
    const ai = engine({ intent: "CHAT", coreCapability: "npati_email_action", coreMutation: false }, async request => request.messages.some(message => message.role === "tool")
      ? { content: "Слово-пароль з цього чату: ЛЕВАДА. Прогрес цілі: 120 з 500." }
      : { content: "", toolCalls: [toolCall("search", "npati_email_action", { action: "inbox.list", companyId: company.id, fields: { search: "пароль" } })] }, requests);
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat", payload: { message: "яке слово-пароль з цього чату і який прогрес цілі?", contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(response.json().message).toContain("ЛЕВАДА");
      expect(response.json().message).not.toContain("No matching email threads");
    } finally { await app.close(); }
  });
});

describe("Final V5 stage 12: inbound webhooks", () => {
  const webhook: CompanyWebhook = { id: "hook-1", workspaceId: "w", companyId: "c", userId: "u", name: "Orders", secret: "whsec_test", agentId: null,
    promptTemplate: "Summarize {{payload}}", isActive: true, createdAt: "", updatedAt: "" };
  const repo = { getWebhookBySecret: async (secret: string) => secret === webhook.secret ? webhook : null, recordWebhookTrigger: vi.fn(async () => undefined) } as unknown as IntegrationsRepository;
  const app = (triggerRun?: Parameters<typeof registerIntegrationsRoutes>[1]["triggerRun"]) => {
    const server = Fastify();
    registerIntegrationsRoutes(server, { auth: { authenticate: async () => auth } as never, store: new InMemoryWorkspaceStore(), repo, triggerRun });
    return server;
  };

  it("V5-D70: an accepted delivery starts the webhook agent with the delivery key", async () => {
    const triggerRun = vi.fn(async () => undefined);
    const server = app(triggerRun);
    const response = await server.inject({ method: "POST", url: "/v1/webhooks/whsec_test", headers: { "idempotency-key": "delivery-7" }, payload: { order: 7 } });
    expect(response.statusCode).toBe(202);
    expect(triggerRun).toHaveBeenCalledWith(webhook, expect.stringContaining("\"order\":7"), "delivery-7");
    await server.close();
  });

  it("V5-D70: without an agent runner the delivery is not reported as dispatched", async () => {
    const server = app(undefined);
    const response = await server.inject({ method: "POST", url: "/v1/webhooks/whsec_test", payload: { order: 8 } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("dispatched to agent");
    await server.close();
  });
});

describe("Final V5 stage 12: automation times", () => {
  it("V5-D71: run history states the automation's local time, not only UTC", async () => {
    const { CompanyAutomationsRepository } = await import("../apps/agent-api/src/automations-repository");
    const { ContentLibraryStore } = await import("../apps/agent-api/src/content-library-store");
    const { WorkspaceChatActions } = await import("../apps/agent-api/src/workspace-chat-actions");
    const store = new InMemoryWorkspaceStore();
    const automations = new CompanyAutomationsRepository();
    const company = await store.createCompany(auth, { name: "Clock Shop" }, "clock-shop");
    const automation = await automations.create(auth, company.id, { name: "Report", prompt: "Report", cronExpression: "30 18 * * *", timezone: "Europe/Kyiv", nextRunAt: "2026-10-28T16:30:00.000Z" });
    const run = await automations.recordRunStart(automation);
    await automations.recordRunComplete(run.id, automation.id, "2026-10-29T16:30:00.000Z", "Done", 10);
    const started = new Date((await automations.listRuns(auth, company.id, automation.id, 1))[0]!.startedAt);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(started);
    const deps = { store, automations, content: new ContentLibraryStore(store) } as never;
    const directive = "```workspace-action\n" + JSON.stringify({ action: "automation.history", companyId: company.id, automationId: automation.id }) + "\n```";
    const history = await WorkspaceChatActions.extractAndExecute(auth, directive, deps, "history", { requestMessage: "Покажи історію запусків автоматизації" });
    expect(history.cleanText).toContain(`${local} Europe/Kyiv`);
    const list = await WorkspaceChatActions.extractAndExecute(auth, directive.replace("automation.history", "automation.list"), deps, "list", { requestMessage: "Покажи автоматизації" });
    // The next run, 16:30 UTC on 29 October 2026, is 18:30 in Kyiv (UTC+2 after the October change).
    expect(list.cleanText).toContain("2026-10-29 18:30 Europe/Kyiv");
  });
});
