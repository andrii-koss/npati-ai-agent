import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const prompt = readFileSync(fileURLToPath(new URL("./fixtures/novascale-ai-company.txt", import.meta.url)), "utf8");
const auth: AuthContext = { userId: "ai-company-user", workspaceId: "ai-company-workspace", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const names = ["Alex Morgan", "Maya Chen", "Daniel Brooks", "Sophie Taylor", "Emma Wilson", "Ryan Cooper"];
const roles = ["Chief Strategy Agent", "Market Research Agent", "Sales Agent", "Customer Support Agent", "Marketing & Content Agent", "Business Operations Agent"];
const responsibilities = names.map((name, index) => {
  const next = names[index + 1];
  const start = prompt.indexOf(index + 1 + ". " + name);
  const end = next ? prompt.indexOf(index + 2 + ". " + next) : prompt.indexOf("  Company Structure", start);
  return [...prompt.slice(start, end).matchAll(/^- (.+)$/gm)].map((match) => match[1]!);
});
const plannedAgents = names.map((name, index) => ({ name, role: roles[index]!, responsibilities: responsibilities[index]!, main: index === 0, ...(index ? { parent_name: names[0]! } : {}) }));
const plan = {
  primary_action: "create_company", entity: "NovaScale Labs", provided_fields: {},
  company_fields: { name: "NovaScale Labs", industry: "Digital Products & AI Automation", description: "NovaScale Labs helps small and medium-sized businesses automate operations, improve customer support, create content, analyze markets, generate leads, and grow through AI-powered workflows." },
  company_agents: plannedAgents, company_agent_count: 6,
  company_agent_rules: ["Stay focused on its assigned role", "Use available company context when making decisions", "Collaborate with other agents when necessary", "Avoid duplicating work already assigned to another agent", "Clearly report completed work and important findings", "Escalate tasks when they fall outside their specialization", "Keep recommendations practical and business-oriented", "Maintain professional communication"],
  company_coordination: "The Chief Strategy Agent should be the primary agent that receives high-level business requests and delegates work to the most appropriate specialist agents. When a task requires multiple areas of expertise, the Chief Strategy Agent should coordinate the relevant agents and combine their results into one final response.",
  secondary_actions: [], dependencies: ["create_company", "create_agents", "link_hierarchy"], completion_criteria: ["company and six agents saved"], requires_external_research: false,
};

function resultEvent(body: string): Record<string, unknown> {
  const match = /event: result\r?\ndata: (\{[^\r\n]+\})/.exec(body);
  expect(match, body).toBeTruthy();
  return JSON.parse(match![1]!);
}

describe("long AI Company creation through production chat", () => {
  it("creates the company, all named agents, responsibilities, hierarchy, and no unsolicited memory, then remains idempotent", async () => {
    const store = new InMemoryWorkspaceStore();
    const nativeChoices: unknown[] = [];
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        if (request.tools?.[0]?.function.name === "npati_classify_chat_intent") throw new Error("Semantic routing unavailable in this fixture");
        if (!request.tools?.length) return { content: JSON.stringify(plan) };
        nativeChoices.push(request.toolChoice);
        const last = request.messages.at(-1);
        if (last?.role === "system" && String(last.content).includes("original primary requested outcome")) {
          return { content: "", toolCalls: [{ id: "company-create", type: "function", function: { name: "npati_company_action", arguments: JSON.stringify({ action: "create", fields: { name: "NovaScale Labs" }, agents: [] }) } }] };
        }
        return { content: "```memory-action\n{\"action\":\"create\",\"memory\":{\"type\":\"brand\",\"title\":\"Company Structure and AI Agent Roles\",\"content\":\"Only a memory\"}}\n```" };
      },
      async *stream() { throw new Error("Native chat must not stream"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: prompt, contextType: "none" } });
        expect(response.statusCode).toBe(200);
        const result = resultEvent(response.body);
        expect(result.message).toContain("NovaScale Labs");
        expect(result.message).toContain("```card:");
        expect(result.message).not.toContain("Open Business Memory");
        expect(nativeChoices[attempt * 3]).toEqual({ type: "function", function: { name: "npati_company_action" } });
        const companies = (await store.listCompanies(auth)).items;
        expect(companies).toHaveLength(1);
        const company = companies[0]!;
        expect(company).toMatchObject(plan.company_fields);
        expect(company.companyInstructions).toContain(plan.company_coordination);
        for (const rule of plan.company_agent_rules) expect(company.companyInstructions).toContain(rule);
        const agents = await store.listCompanyAgents(auth, company.id);
        expect(agents).toHaveLength(6);
        expect(agents.map((agent) => agent.name)).toEqual(names);
        for (let index = 0; index < agents.length; index++) {
          expect(agents[index]!.role).toBe(roles[index]);
          for (const task of responsibilities[index]!) expect(agents[index]!.systemInstruction).toContain(task);
          for (const rule of plan.company_agent_rules) expect(agents[index]!.systemInstruction).toContain(rule);
        }
        expect(agents.find((agent) => agent.id === company.mainAgentId)?.name).toBe("Alex Morgan");
        expect(agents.find((agent) => agent.id === company.mainAgentId)?.systemInstruction).toContain(plan.company_coordination);
        const edges = await store.listCompanyAgentEdges(auth, company.id);
        expect(edges).toHaveLength(5);
        for (const edge of edges) expect(edge.parentAgentId).toBe(company.mainAgentId);
        expect(await store.listUserBusinesses(auth)).toHaveLength(0);
      }
    } finally { await app.close(); }
  });
  it("recovers from repeated memory-only model responses using the semantic company plan", async () => {
    const store = new InMemoryWorkspaceStore();
    let toolModelCalls = 0;
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        if (request.tools?.[0]?.function.name === "npati_classify_chat_intent") throw new Error("Semantic routing unavailable in this fixture");
        if (!request.tools?.length) return { content: JSON.stringify(plan) };
        toolModelCalls++;
        return { content: "```memory-action\n{\"action\":\"create\",\"memory\":{\"type\":\"brand\",\"title\":\"Wrong secondary action\",\"content\":\"Not requested\"}}\n```" };
      },
      async *stream() { throw new Error("Native chat must not stream"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: prompt, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(resultEvent(response.body).message).toContain("```card:");
      expect(toolModelCalls).toBe(2);
      const company = (await store.listCompanies(auth)).items[0]!;
      expect(company.name).toBe("NovaScale Labs");
      expect(await store.listCompanyAgents(auth, company.id)).toHaveLength(6);
      expect(await store.listUserBusinesses(auth)).toHaveLength(0);
    } finally { await app.close(); }
  });
});