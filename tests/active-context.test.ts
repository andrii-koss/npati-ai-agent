import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import type { AIEngine, OmniRouteMarketplace } from "@npati/agent";
import { validateActiveContext, ContextValidationError } from "@npati/shared";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  while (apps.length) {
    await apps.pop()!.close();
  }
});

function createMockAIEngine(onChat?: (req: any) => void): AIEngine {
  return {
    chat: async (input: any) => {
      onChat?.(input);
      return {
        content: `Response to: ${input.messages[input.messages.length - 1]?.content ?? ""}`,
        model: input.model ?? "test-model",
      };
    },
    streamChat: async function* () {
      yield "chunk";
    },
    embed: async () => ({ embedding: [0.1, 0.2, 0.3], dimensions: 3 }),
    rerank: async () => [],
    transcribe: async () => ({ text: "transcription" }),
    vision: async () => ({ text: "vision description" }),
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"],
    healthCheck: async () => ({ status: "ok" as const }),
    resilienceStatus: async () => ({
      source: "omniroute" as const,
      configuration: { waitForCooldown: { enabled: true, maxRetries: 2 } },
      runtime: { status: "healthy", providerBreakers: [], lockouts: [], adaptiveAdmission: {}, chatAdmission: {} },
    }),
  } satisfies AIEngine;
}

describe("PHASE 1: Active Context Specification & Isolation", () => {
  describe("ActiveContext Model & Mutual Exclusion Validation", () => {
    it("enforces mutual exclusivity between businessId and companyId", () => {
      expect(() =>
        validateActiveContext({
          contextType: "business",
          businessId: "biz-123",
          companyId: "comp-456",
        })
      ).toThrow(ContextValidationError);

      expect(() =>
        validateActiveContext({
          businessId: "biz-123",
          companyId: "comp-456",
        })
      ).toThrow("mutually exclusive");
    });

    it("rejects neutral context if businessId or companyId is present", () => {
      expect(() =>
        validateActiveContext({
          contextType: "none",
          businessId: "biz-123",
        })
      ).toThrow(ContextValidationError);

      expect(() =>
        validateActiveContext({
          contextType: "none",
          companyId: "comp-456",
        })
      ).toThrow(ContextValidationError);
    });

    it("validates required companyId for company context", () => {
      expect(() =>
        validateActiveContext({
          contextType: "company",
        })
      ).toThrow("requires a valid companyId");
    });

    it("correctly resolves valid contexts", () => {
      expect(validateActiveContext({ contextType: "none" })).toEqual({
        contextType: "none",
        businessId: null,
        companyId: null,
      });

      expect(validateActiveContext({ contextType: "business", businessId: "biz-1" })).toEqual({
        contextType: "business",
        businessId: "biz-1",
        companyId: null,
      });

      expect(validateActiveContext({ contextType: "company", companyId: "comp-1" })).toEqual({
        contextType: "company",
        businessId: null,
        companyId: "comp-1",
      });
    });
  });

  describe("API Active Context Resolution & Boundary Enforcement", () => {
    it("allows neutral chat without forcing business onboarding (negative retrieval)", async () => {
      const active: AuthContext = {
        workspaceId: "ws-neutral",
        userId: "user-neutral",
        permissions: ["workspace:read", "workspace:write"],
      };
      const authProvider: AuthProvider = { authenticate: async () => active };
      const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
      let lastChatInput: any = null;
      const aiEngine = createMockAIEngine((input) => {
        lastChatInput = input;
      });
      const store = new InMemoryWorkspaceStore();

      const app = buildApp({ workspaceStore: store, authProvider, marketplace, aiEngine });
      apps.push(app);

      // Chat with explicit neutral context
      const response = await app.inject({
        method: "POST",
        url: "/chat",
        payload: {
          contextType: "none",
          message: "Explain what Redis is",
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.message).toContain("Explain what Redis is");
      expect(data.activeContext).toEqual({
        contextType: "none",
        businessId: null,
        companyId: null,
      });
      // Neutral chat did not create onboarding or business memory
      expect(data.onboarding).toBeUndefined();
      expect(lastChatInput.messages[0].content).toContain("NPATI Agent");
      expect(lastChatInput.messages[0].content).toContain("without referencing any specific business or company data");
    });

    it("rejects simultaneous businessId and companyId via API with 400 Bad Request", async () => {
      const active: AuthContext = {
        workspaceId: "ws-test",
        userId: "user-test",
        permissions: ["workspace:read", "workspace:write"],
      };
      const authProvider: AuthProvider = { authenticate: async () => active };
      const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
      const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, marketplace, aiEngine: createMockAIEngine() });
      apps.push(app);

      const response = await app.inject({
        method: "POST",
        url: "/chat",
        payload: {
          businessId: "biz-1",
          companyId: "comp-1",
          message: "Conflict test",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "INVALID_CONTEXT",
        },
      });
    });

    it("denies access to unauthorized companyId with 403 Forbidden before execution", async () => {
      const tenantA: AuthContext = {
        workspaceId: "workspace-a",
        userId: "user-a",
        permissions: ["workspace:read", "workspace:write"],
      };
      const tenantB: AuthContext = {
        workspaceId: "workspace-b",
        userId: "user-b",
        permissions: ["workspace:read", "workspace:write"],
      };

      let currentTenant = tenantA;
      const authProvider: AuthProvider = { authenticate: async () => currentTenant };
      const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
      const store = new InMemoryWorkspaceStore();

      // Create company in Workspace A
      const companyA = await store.createCompany(tenantA, { name: "Company Alpha" });

      const app = buildApp({ workspaceStore: store, authProvider, marketplace, aiEngine: createMockAIEngine() });
      apps.push(app);

      // Tenant A can access their company
      const okResponse = await app.inject({
        method: "GET",
        url: `/companies/${companyA.id}`,
      });
      expect(okResponse.statusCode).toBe(200);

      // Switch to Tenant B
      currentTenant = tenantB;

      // Tenant B tries to chat with Company A -> MUST return 403 Forbidden
      const deniedChat = await app.inject({
        method: "POST",
        url: "/chat",
        payload: {
          contextType: "company",
          companyId: companyA.id,
          message: "What is Alpha's proprietary secret?",
        },
      });

      expect(deniedChat.statusCode).toBe(403);

      // Tenant B tries to stream chat with Company A -> MUST return 403 Forbidden
      const deniedStream = await app.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          contextType: "company",
          companyId: companyA.id,
          message: "Stream secret",
        },
      });

      expect(deniedStream.statusCode).toBe(403);
    });

    it("guarantees Cross-Company Isolation: Company A never receives Company B resources", async () => {
      const tenant: AuthContext = {
        workspaceId: "workspace-multi",
        userId: "user-owner",
        permissions: ["workspace:read", "workspace:write"],
      };
      const authProvider: AuthProvider = { authenticate: async () => tenant };
      const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
      const store = new InMemoryWorkspaceStore();

      // Create Company 1 and Company 2 in same workspace
      const comp1 = await store.createCompany(tenant, { name: "FinTech Corp" }, "fin-corp-key");
      const comp2 = await store.createCompany(tenant, { name: "HealthTech Corp" }, "health-corp-key");

      // Add agents to each company
      const agent1 = await store.createCompanyAgent(tenant, comp1.id, {
        name: "Finance Manager",
        role: "worker",
        systemInstruction: "Handle financial data",
        modelId: "gpt-4o",
      }, "agent-fin-key");
      const c1 = await store.getCompany(tenant, comp1.id);
      await store.setCompanyMainAgent(tenant, comp1.id, agent1.id, c1!.revision);

      const agent2 = await store.createCompanyAgent(tenant, comp2.id, {
        name: "Health Manager",
        role: "worker",
        systemInstruction: "Handle patient data",
        modelId: "gpt-4o",
      }, "agent-health-key");
      const c2 = await store.getCompany(tenant, comp2.id);
      await store.setCompanyMainAgent(tenant, comp2.id, agent2.id, c2!.revision);

      const app = buildApp({ workspaceStore: store, authProvider, marketplace, aiEngine: createMockAIEngine() });
      apps.push(app);

      // Verify agents list for comp1 only contains agent1
      const agentsComp1 = await store.listCompanyAgents(tenant, comp1.id);
      expect(agentsComp1.some((a) => a.id === agent2.id)).toBe(false);
      expect(agentsComp1.some((a) => a.id === agent1.id)).toBe(true);

      // Verify agents list for comp2 only contains agent2
      const agentsComp2 = await store.listCompanyAgents(tenant, comp2.id);
      expect(agentsComp2.some((a) => a.id === agent1.id)).toBe(false);
      expect(agentsComp2.some((a) => a.id === agent2.id)).toBe(true);
    });

    it("preserves immutable run context snapshot on CompanyAgentRun creation and across restarts", async () => {
      const tenant: AuthContext = {
        workspaceId: "ws-immutable",
        userId: "user-immutable",
        permissions: ["workspace:read", "workspace:write"],
      };
      const store = new InMemoryWorkspaceStore();

      const company = await store.createCompany(tenant, { name: "Snapshot Corp" });
      const mainAgent = await store.createCompanyAgent(tenant, company.id, {
        name: "Director",
        role: "worker",
        systemInstruction: "Direct operations",
        modelId: "gpt-4o",
      }, "director-agent-key");
      const freshCompany = await store.getCompany(tenant, company.id);
      await store.setCompanyMainAgent(tenant, company.id, mainAgent.id, freshCompany!.revision);

      // Create run
      const { run } = await store.createCompanyAgentRun(
        tenant,
        company.id,
        { task: "Execute immutable audit", requestedMode: "single" },
        "idemp-snapshot-01"
      );

      expect(run.contextSnapshot).toBeDefined();
      expect(run.contextSnapshot).toMatchObject({
        contextType: "company",
        workspaceId: "ws-immutable",
        userId: "user-immutable",
        companyId: company.id,
        businessId: null,
        agentId: mainAgent.id,
      });

      // Simulate retrieval / worker restart
      const fetched = await store.getCompanyAgentRun(tenant, company.id, run.id);
      expect(fetched.run.contextSnapshot).toEqual(run.contextSnapshot);
      expect(fetched.run.contextSnapshot?.capturedAt).toBe(run.contextSnapshot?.capturedAt);
    });
  });
});
