import { describe, it, expect } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AuthContext } from "@npati/workspace";

describe("PHASE 9: Business Lifecycle and Optional Business -> Company Transition", () => {
  const store = new InMemoryWorkspaceStore();

  const tenantA: AuthContext = {
    workspaceId: "ws-tenant-a",
    userId: "user-tenant-a",
    permissions: ["workspace:read", "workspace:write", "business:manage"],
  };

  const tenantB: AuthContext = {
    workspaceId: "ws-tenant-b",
    userId: "user-tenant-b",
    permissions: ["workspace:read", "workspace:write", "business:manage"],
  };

  describe("Conversion and Idempotency", () => {
    it("converts a Business into an operational Company with selected fields and Main Agent", async () => {
      // 1. Setup Business with rich artifacts
      const business = await store.createBusiness(tenantA, {
        name: "EcoLogistics Pro",
        industry: "Logistics & Supply Chain",
        description: "Green last-mile delivery fleet using electric cargo vans",
        businessModel: "B2B SaaS and delivery as a service",
        audienceSummary: "Urban e-commerce retailers and dark stores",
        market: "European Union",
        niche: "Carbon-neutral last mile",
        website: "https://ecologistics.example.com",
        productsServicesSummary: "EcoDispatch dispatch software and EV fleet delivery",
      });

      // 2. Add Goals and Confirmed Memory
      const goal1 = await store.createGoal(tenantA, business.id, {
        title: "Achieve 500 active delivery routes",
        description: "Scale operations across 3 major metropolitan areas",
      });

      const mem1 = await store.createMemory(tenantA, business.id, {
        content: "Only 100% electric vehicles are permitted in the delivery fleet",
      });

      // 3. Perform conversion with all selected fields
      const { company, created } = await store.convertBusinessToCompany(
        tenantA,
        business.id,
        {
          includeConfirmedMemory: true,
          includeGoals: true,
          includeResearchSummary: true,
          includeInstructions: true,
        },
        "idemp-convert-1"
      );

      expect(created).toBe(true);
      expect(company).toBeDefined();
      expect(company.businessId).toBe(business.id);
      expect(company.name).toBe("EcoLogistics Pro");
      expect(company.website).toBe("https://ecologistics.example.com");
      expect(company.industry).toBe("Logistics & Supply Chain");
      expect(company.status).toBe("active");
      expect(company.mainAgentId).toBeDefined();

      // Verify transferred memory and instructions
      const memObj = company.memory as Record<string, unknown>;
      expect(memObj["confirmed_business_facts"]).toBeDefined();
      expect((memObj["confirmed_business_facts"] as string[])[0]).toContain("Only 100% electric vehicles");

      expect(memObj["transferred_goals"]).toBeDefined();
      const goals = memObj["transferred_goals"] as Array<{ title: string }>;
      expect(goals[0]?.title).toBe("Achieve 500 active delivery routes");

      expect(company.companyInstructions).toContain("Business Description");
      expect(company.companyInstructions).toContain("Business Model");
      expect(company.companyInstructions).toContain("Target Audience");

      // Verify Main Agent exists
      const mainAgent = await store.getCompanyAgent(tenantA, company.id, company.mainAgentId!);
      expect(mainAgent).toBeDefined();
      expect(mainAgent.name).toBe("Main Agent");
      expect(mainAgent.role).toBe("Coordinator");
      expect(mainAgent.isActive).toBe(true);
      expect(mainAgent.tools).toContain("web.search");
    });

    it("retries conversion with same idempotency key and returns existing company without duplicates", async () => {
      const business = await store.createBusiness(tenantA, {
        name: "Idempotent Ventures",
        description: "Testing duplicate prevention",
      });

      // First conversion
      const first = await store.convertBusinessToCompany(
        tenantA,
        business.id,
        { includeInstructions: true },
        "idemp-same-key"
      );
      expect(first.created).toBe(true);

      // Second conversion with identical key
      const second = await store.convertBusinessToCompany(
        tenantA,
        business.id,
        { includeInstructions: true },
        "idemp-same-key"
      );
      expect(second.created).toBe(false);
      expect(second.company.id).toBe(first.company.id);

      // Verify count of companies for this business
      const page = await store.listCompanies(tenantA, 100);
      const matching = page.items.filter((c) => c.businessId === business.id);
      expect(matching.length).toBe(1);
    });

    it("respects selective transfer flags (selected fields only)", async () => {
      const business = await store.createBusiness(tenantA, {
        name: "Selective Data Co",
        description: "This description should NOT be transferred as instructions",
      });

      await store.createMemory(tenantA, business.id, {
        content: "Secret business idea",
      });

      // Transfer with ALL flags FALSE
      const { company } = await store.convertBusinessToCompany(
        tenantA,
        business.id,
        {
          includeConfirmedMemory: false,
          includeGoals: false,
          includeResearchSummary: false,
          includeInstructions: false,
        },
        "idemp-selective-test"
      );

      expect(company.companyInstructions).toBeUndefined();
      const memObj = company.memory as Record<string, unknown>;
      expect(memObj["confirmed_business_facts"]).toBeUndefined();
      expect(memObj["transferred_goals"]).toBeUndefined();
    });
  });

  describe("Security and Isolation Guarantees", () => {
    it("guarantees cross-tenant conversion is impossible", async () => {
      // Tenant A owns this business
      const businessA = await store.createBusiness(tenantA, {
        name: "Tenant A Confidential Business",
      });

      // Tenant B tries to convert Tenant A's business
      await expect(
        store.convertBusinessToCompany(
          tenantB,
          businessA.id,
          { includeConfirmedMemory: true },
          "idemp-cross-tenant-attack"
        )
      ).rejects.toThrow();
    });

    it("guarantees the original Business, goals, and memory remain intact after transition", async () => {
      const business = await store.createBusiness(tenantA, {
        name: "Evergreen Business",
        description: "Must never be mutated or deleted by company transition",
        businessStage: "starting",
      });

      await store.createGoal(tenantA, business.id, { title: "Preserve Business" });
      await store.createMemory(tenantA, business.id, { content: "Original knowledge item" });

      await store.convertBusinessToCompany(
        tenantA,
        business.id,
        { includeConfirmedMemory: true, includeGoals: true },
        "idemp-preserve-business"
      );

      // Verify business still exists in full
      const stillBusiness = await store.getBusiness(tenantA, business.id);
      expect(stillBusiness).toBeDefined();
      expect(stillBusiness.name).toBe("Evergreen Business");
      expect(stillBusiness.description).toBe("Must never be mutated or deleted by company transition");
      expect(stillBusiness.businessStage).toBe("starting");

      // Verify goals still exist
      const goals = await store.listGoals(tenantA, business.id);
      expect(goals.some((g) => g.title === "Preserve Business")).toBe(true);

      // Verify memories still exist
      const memories = await store.listMemory(tenantA, business.id);
      expect(memories.some((m) => m.content === "Original knowledge item")).toBe(true);
    });

    it("guarantees Business-only chat isolation", async () => {
      const business = await store.createBusiness(tenantA, {
        name: "Chat Scoped Business",
      });

      const conversation = await store.createConversation(tenantA, business.id, "Confidential Strategy Chat");
      await store.appendMessage(tenantA, business.id, conversation.id, "user", "How do we disrupt the market?");

      const { company } = await store.convertBusinessToCompany(
        tenantA,
        business.id,
        {},
        "idemp-chat-isolation"
      );

      // Verify business conversations are only present under the business scope
      const businessChats = await store.listConversations(tenantA, business.id);
      expect(businessChats.some((c) => c.id === conversation.id)).toBe(true);

      // Verify the company does not have or inherit business conversations
      const companyDetails = await store.getCompany(tenantA, company.id);
      expect((companyDetails as any).conversations).toBeUndefined();
    });
  });
});
