import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const prompt = readFileSync(fileURLToPath(new URL("./fixtures/novascale-business-profile.txt", import.meta.url)), "utf8").replace(/^\uFEFF/, "");
const auth: AuthContext = { userId: "exact-novascale-user", workspaceId: "exact-novascale-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const goalTitle = "Build and grow NovaScale Labs into an AI-powered automation company that helps businesses improve efficiency, automate repetitive work, and scale operations using specialized AI agents.";
const memoryContent = "NovaScale Labs is an AI automation and digital products company focused on helping small and medium-sized businesses automate operations, customer support, sales, research, marketing, and internal workflows using specialized AI agents.";
const fields = {
  name: "NovaScale Labs", businessStage: "operating", industry: "Technology / Artificial Intelligence",
  niche: "AI Automation, Digital Products & Business Automation", country: "United States",
  market: "Small and medium-sized businesses, startups, agencies, and online businesses", teamType: "team", presenceType: "both",
  businessModel: "B2B SaaS, AI automation services, consulting, and digital products", website: "https://novascalelabs.example",
  legalName: "NovaScale Labs LLC", contactEmail: "hello@novascalelabs.example", contactPhone: "+1 555 010 2026",
  postalAddress: "123 Innovation Drive, Austin, TX 78701, United States",
  description: "NovaScale Labs helps small and medium-sized businesses automate repetitive work, improve customer support, research markets, generate leads, create content, optimize internal operations, and grow through AI-powered agents and automated workflows.",
  productsServicesSummary: "AI business automation; Custom AI agents; Workflow automation; AI-powered customer support; Sales and lead generation automation; Market and competitor research; Marketing and content automation; Business process optimization; AI consulting; Digital products and SaaS solutions",
  audienceSummary: "Small and medium-sized businesses, startups, agencies, entrepreneurs, online businesses, sales teams, marketing teams, customer support teams, and companies looking to automate repetitive business operations with AI.",
  registrationDetails: "NovaScale Labs LLC",
};
const args = { action: "create", profile: fields, goals: [{ title: goalTitle, status: "active", priority: 1 }], memories: [{ type: "business_fact", title: "NovaScale Labs business focus", content: memoryContent, confidence: 1 }] };
const rawPlanFields = { ...fields, businessStage: "Operating", presenceType: "Online & local", website: "novascalelabs.example", contactEmail: "[hello@novascalelabs.example](mailto:hello@novascalelabs.example)", registrationDetails: "NovaScale Labs LLC. Use the business registration information available in the system." };
function resultEvent(body: string): Record<string, unknown> {
  const match = /event: result\r?\ndata: (\{[^\r\n]+\})/.exec(body);
  expect(match, body).toBeTruthy();
  return JSON.parse(match![1]!);
}

describe("exact NovaScale Labs production chat regression", () => {
  it("reports verified creation after final model failure and reports an existing profile on repeat", async () => {
    const store = new InMemoryWorkspaceStore();
    let failedFinalOnce = false;
    const modelRequests: ChatRequest[] = [];
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        modelRequests.push(request);
        if (!request.tools?.length) return { content: JSON.stringify({ primary_action: "create_business_profile", entity: "NovaScale Labs", provided_fields: rawPlanFields, secondary_actions: ["resolve_goal", "resolve_memory"], dependencies: ["create_business_profile", "link_goal", "link_memory"], completion_criteria: ["profile and links saved"], requires_external_research: false }) };
        if (request.messages.at(-1)?.role === "tool") {
          if (!failedFinalOnce) { failedFinalOnce = true; throw new Error("Simulated final model failure after a successful database write"); }
          return { content: "Model says done." };
        }
        return { content: "", toolCalls: [{ id: `business-${modelRequests.length}`, type: "function", function: { name: "npati_business_profile", arguments: JSON.stringify(args) } }] };
      },
      async *stream() { throw new Error("Native chat must not fall back to streaming"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: prompt, contextType: "none" } });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain("NPATI Agent could not complete this message");
        const result = resultEvent(response.body);
        expect(result.message).toContain("NovaScale Labs");
        expect(result.message).toContain(attempt === 0 ? "created" : "already exists");
        const businesses = await store.listUserBusinesses(auth);
        expect(businesses).toHaveLength(1);
        expect(businesses[0]).toMatchObject(fields);
        expect(businesses[0]!.logoFileId).toBeFalsy();
        expect(await store.listGoals(auth, businesses[0]!.id)).toMatchObject([{ title: goalTitle, businessId: businesses[0]!.id }]);
        expect(await store.listMemory(auth, businesses[0]!.id)).toMatchObject([{ content: memoryContent, businessId: businesses[0]!.id }]);
        expect(await store.listGoals(auth, businesses[0]!.id)).toHaveLength(1);
        expect(await store.listMemory(auth, businesses[0]!.id)).toHaveLength(1);
        expect((await store.listCompanies(auth)).items).toHaveLength(0);
      }
      expect(modelRequests.some((request) => request.toolChoice === "none" && String(request.messages.at(-1)?.content).startsWith("Create a new business profile"))).toBe(true);
    } finally { await app.close(); }
  });
  it("returns a verified result from the selected-business chat path when final generation fails", async () => {
    const store = new InMemoryWorkspaceStore();
    const anchor = await store.createBusiness(auth, { name: "Context Anchor", businessStage: "idea" });
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        if (!request.tools?.length) return { content: JSON.stringify({ primary_action: "create_business_profile", entity: "NovaScale Labs", provided_fields: rawPlanFields, secondary_actions: ["resolve_goal", "resolve_memory"], dependencies: [], completion_criteria: ["profile saved"], requires_external_research: false }) };
        if (request.messages.at(-1)?.role === "tool") throw new Error("Final response failed after saving the profile");
        return { content: "", toolCalls: [{ id: "business-context", type: "function", function: { name: "npati_business_profile", arguments: JSON.stringify(args) } }] };
      },
      async *stream() { throw new Error("Native chat must not fall back to streaming"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: prompt, contextType: "business", businessId: anchor.id } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("NPATI Agent could not complete this message");
      expect(resultEvent(response.body).message).toContain("NovaScale Labs");
      const businesses = await store.listUserBusinesses(auth);
      expect(businesses.map((item) => item.name).sort()).toEqual(["Context Anchor", "NovaScale Labs"]);
      const nova = businesses.find((item) => item.name === "NovaScale Labs")!;
      expect(nova).toMatchObject(fields);
      expect(await store.listGoals(auth, nova.id)).toHaveLength(1);
      expect(await store.listMemory(auth, nova.id)).toHaveLength(1);
    } finally { await app.close(); }
  });
  it("reports a saved profile with an explicit missing-field note when the model stops early", async () => {
    const store = new InMemoryWorkspaceStore();
    const partialFields = { ...fields } as Partial<typeof fields>;
    delete partialFields.registrationDetails;
    let toolCalled = false;
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        if (!request.tools?.length) return { content: JSON.stringify({ primary_action: "create_business_profile", entity: "NovaScale Labs", provided_fields: rawPlanFields, secondary_actions: ["resolve_goal", "resolve_memory"], dependencies: [], completion_criteria: ["profile saved"], requires_external_research: false }) };
        if (toolCalled) return { content: "Done." };
        toolCalled = true;
        return { content: "", toolCalls: [{ id: "partial-business", type: "function", function: { name: "npati_business_profile", arguments: JSON.stringify({ ...args, profile: partialFields }) } }] };
      },
      async *stream() { throw new Error("Native chat must not fall back to streaming"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: prompt, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("NPATI Agent could not complete this message");
      const result = resultEvent(response.body);
      expect(result.message).toContain("NovaScale Labs");
      expect(result.message).toContain("Registration details");
      expect(await store.listUserBusinesses(auth)).toHaveLength(1);
    } finally { await app.close(); }
  });
  it("recreates a deleted business in a new chat despite a stale model update ID and uses the existing card renderer", async () => {
    const store = new InMemoryWorkspaceStore();
    let staleId = "deleted-profile-id";
    const nativeChoices: unknown[] = [];
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        if (!request.tools?.length) return { content: JSON.stringify({ primary_action: "create_business_profile", entity: "NovaScale Labs", provided_fields: rawPlanFields, secondary_actions: ["resolve_goal", "resolve_memory"], dependencies: [], completion_criteria: ["profile saved"] }) };
        nativeChoices.push(request.toolChoice);
        if (request.messages.at(-1)?.role === "tool") return { content: "Done." };
        const partial = { ...fields } as Partial<typeof fields>;
        delete partial.contactEmail;
        delete partial.description;
        return { content: "", toolCalls: [{ id: "stale-business-update", type: "function", function: { name: "npati_business_profile", arguments: JSON.stringify({ ...args, action: "update", businessId: staleId, profile: partial }) } }] };
      },
      async *stream() { throw new Error("Native chat must not fall back to streaming"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const first = resultEvent((await app.inject({ method: "POST", url: "/chat/stream", payload: { message: prompt, contextType: "none" } })).body);
      expect(first.message).toContain("```card:Business Profile: NovaScale Labs");
      expect(nativeChoices[0]).toEqual({ type: "function", function: { name: "npati_business_profile" } });
      expect(first.message).toContain("**Contact email:** hello@novascalelabs.example");
      expect(first.message).toContain("**What the business does:**");
      expect(first.message).not.toContain("Some requested details could not be verified");
      const original = (await store.listUserBusinesses(auth))[0]!;
      staleId = original.id;
      const deleted = await app.inject({ method: "DELETE", url: `/businesses/${original.id}` });
      expect(deleted.statusCode).toBe(204);
      expect(await store.listUserBusinesses(auth)).toHaveLength(0);
      const second = resultEvent((await app.inject({ method: "POST", url: "/chat/stream", payload: { message: prompt, contextType: "none" } })).body);
      expect(second.message).toContain("```card:Business Profile: NovaScale Labs");
      expect(second.message).toContain("was created and verified");
      const businesses = await store.listUserBusinesses(auth);
      expect(businesses).toHaveLength(1);
      expect(businesses[0]!.id).not.toBe(original.id);
      expect(businesses[0]).toMatchObject(fields);
      expect(await store.listGoals(auth, businesses[0]!.id)).toHaveLength(1);
      expect(await store.listMemory(auth, businesses[0]!.id)).toHaveLength(1);
    } finally { await app.close(); }
  });
});
