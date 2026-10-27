import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const auth: AuthContext = { userId: "novascale-user", workspaceId: "novascale-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const toolCall = (id: string, args: Record<string, unknown>): ChatToolCall => ({ id, type: "function", function: { name: "npati_business_profile", arguments: JSON.stringify(args) } });
const fields = {
  name: "NovaScale Labs", businessStage: "operating", businessType: "Technology", industry: "Technology / Artificial Intelligence",
  niche: "AI automation for small and medium businesses", country: "United States", market: "Global", teamType: "team",
  presenceType: "online", businessModel: "B2B subscription and implementation services", website: "https://novascalelabs.example",
  legalName: "NovaScale Labs LLC", contactEmail: "hello@novascalelabs.example", contactPhone: "+1 415 555 0100",
  postalAddress: "100 Market Street, San Francisco, CA 94105", description: "NovaScale Labs builds practical AI workflows for growing businesses.",
  productsServicesSummary: "AI workflow automation, customer support agents, and analytics consulting",
  audienceSummary: "Small and medium businesses seeking efficient operations", registrationDetails: "Delaware LLC; registration number supplied by user: 1234567",
};
const prompt = `Create a new business profile for NovaScale Labs and complete all available fields in the Business Profile form.\n\nBusiness name: ${fields.name}\nStage: Operating\nBusiness type: ${fields.businessType}\nIndustry: ${fields.industry}\nNiche: ${fields.niche}\nCountry: ${fields.country}\nMarket: ${fields.market}\nTeam: Team\nPresence: Online\nBusiness model: ${fields.businessModel}\nWebsite: ${fields.website}\nLegal company name: ${fields.legalName}\nContact email: ${fields.contactEmail}\nContact phone: ${fields.contactPhone}\nAddress: ${fields.postalAddress}\nBusiness description: ${fields.description}\nProducts/services: ${fields.productsServicesSummary}\nTarget audience: ${fields.audienceSummary}\nRegistration details: ${fields.registrationDetails}\n\nUser Goal: Launch the first 20 client automations.\nMemory: Our brand voice is clear, practical, and trustworthy.\nCompany Logo instructions: Use the existing attached logo only if it is actually available; do not invent a logo.\n\nComplete all applicable fields and create the business profile.`;
const args = {
  action: "create", profile: fields,
  goals: [{ title: "Launch the first 20 client automations", description: "Reach 20 client automations", priority: 1, status: "active" }],
  memories: [{ type: "brand", title: "Brand voice", content: "Our brand voice is clear, practical, and trustworthy.", confidence: 1 }],
};
function engine(chat: AIEngine["chat"]): AIEngine {
  return { supportsNativeTools: () => true, chat: request => request.tools?.[0]?.function.name === "npati_classify_chat_intent" ? Promise.reject(new Error("Semantic routing unavailable in this fixture")) : chat(request), async *stream() { throw new Error("No stream fallback expected"); }, listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }) };
}

describe("long Business Profile production chat path", () => {
  it("persists every field and dependent record through /chat/stream and continues after a premature secondary response", async () => {
    const store = new InMemoryWorkspaceStore();
    const requests: ChatRequest[] = [];
    const longPrompt = prompt + "\nAdditional context: " + "Background data. ".repeat(750) + "\nComplete all applicable fields and create the business profile.";
    let nativeStep = 0;
    const ai = engine(async (request) => {
      requests.push(request);
      if (!request.tools?.length) return { content: JSON.stringify({ primary_action: "create_business_profile", requires_external_research: false, entity: "NovaScale Labs", provided_fields: fields, secondary_actions: ["resolve_goal", "resolve_memory"], dependencies: ["create_business_profile", "link_goal", "link_memory"], completion_criteria: ["Business Profile and dependencies persist"] }) };
      nativeStep += 1;
      if (nativeStep === 1) return { content: "Memory was created." };
      if (nativeStep === 2) return { content: "", toolCalls: [toolCall("create-profile", args)] };
      return { content: "NovaScale Labs Business Profile, goal, and memory were saved." };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: longPrompt, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(longPrompt.length).toBeGreaterThan(10_000);
      expect(String(requests[0]?.messages.at(-1)?.content)).toContain("Create a new business profile for NovaScale Labs");
      expect(String(requests[0]?.messages.at(-1)?.content)).toContain("Complete all applicable fields and create the business profile.");
      const businesses = await store.listUserBusinesses(auth);
      expect(businesses).toHaveLength(1);
      for (const [key, value] of Object.entries(fields)) expect((businesses[0] as unknown as Record<string, unknown>)[key]).toBe(value);
      expect(businesses[0]!.logoFileId).toBeFalsy();
      const goals = await store.listGoals(auth, businesses[0]!.id);
      const memories = await store.listMemory(auth, businesses[0]!.id);
      expect(goals).toHaveLength(1);
      expect(goals[0]).toMatchObject({ businessId: businesses[0]!.id, title: args.goals[0]!.title });
      expect(memories).toHaveLength(1);
      expect(memories[0]).toMatchObject({ businessId: businesses[0]!.id, content: args.memories[0]!.content });
      expect((await store.listCompanies(auth)).items).toHaveLength(0);
      expect(nativeStep).toBe(3);
      expect(requests[1]?.toolChoice).toEqual({ type: "function", function: { name: "npati_business_profile" } });
      expect(requests[2]?.messages.some((item) => item.role === "system" && String(item.content).includes("primary requested outcome has not been verified"))).toBe(true);
      expect(response.body).toContain("NovaScale Labs");
      expect(response.body).not.toContain("NPATI Agent could not complete this message");
    } finally { await app.close(); }
  });
  it("retries when the first business tool call omits supplied fields", async () => {
    const store = new InMemoryWorkspaceStore();
    let nativeStep = 0;
    const ai = engine(async (request) => {
      if (!request.tools?.length) return { content: JSON.stringify({ primary_action: "CREATE_BUSINESS_PROFILE", requires_external_research: false, entity: "NovaScale Labs", provided_fields: fields, secondary_actions: ["resolve_goal", "resolve_memory"], dependencies: ["create_business_profile"], completion_criteria: ["All fields saved"] }) };
      nativeStep += 1;
      if (nativeStep === 1) return { content: "", toolCalls: [toolCall("partial", { action: "create", profile: { name: fields.name } })] };
      if (nativeStep === 2) return { content: "Done." };
      if (nativeStep === 3) return { content: "", toolCalls: [toolCall("complete", args)] };
      return { content: "All supplied fields, goal, and memory are saved." };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat", payload: { message: prompt, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(nativeStep).toBe(4);
      const businesses = await store.listUserBusinesses(auth);
      expect(businesses).toHaveLength(1);
      expect(businesses[0]).toMatchObject(fields);
      expect(await store.listGoals(auth, businesses[0]!.id)).toHaveLength(1);
      expect(await store.listMemory(auth, businesses[0]!.id)).toHaveLength(1);
    } finally { await app.close(); }
  });
  it("adds a goal to the business from conversation context without creating another business", async () => {
    const store = new InMemoryWorkspaceStore();
    let step = 0;
    const ai = engine(async (request) => {
      const last = request.messages.at(-1);
      if (last?.role === "tool") return { content: step <= 1 ? "The profile was created." : "The goal was linked to this business." };
      step += 1;
      return { content: "", toolCalls: [toolCall(`step-${step}`, step === 1
        ? { action: "create", profile: { name: "Context Studio", businessStage: "operating" } }
        : { action: "update", profile: {}, goals: [{ title: "Reach 100 customers", status: "active", priority: 1 }] })] };
    });
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const first = await app.inject({ method: "POST", url: "/chat", payload: { message: "Create a business profile named Context Studio", contextType: "none" } });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: "/chat", payload: { message: "Now add a goal to this business: Reach 100 customers", conversationId: first.json().conversationId, contextType: "none" } });
      expect(second.statusCode).toBe(200);
      const businesses = await store.listUserBusinesses(auth);
      expect(businesses).toHaveLength(1);
      expect(await store.listGoals(auth, businesses[0]!.id)).toMatchObject([{ title: "Reach 100 customers", businessId: businesses[0]!.id }]);
    } finally { await app.close(); }
  });
});
