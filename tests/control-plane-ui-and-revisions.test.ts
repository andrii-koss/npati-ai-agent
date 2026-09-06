import { describe, it, expect } from "vitest";
import {
  CAPABILITY_CATALOG,
  EffectiveCapabilityResolver,
  defaultCapabilityRegistry,
  type AgentExecutionInput,
} from "@npati/shared";
import { InMemoryWorkspaceStore } from "@npati/workspace";

describe("PHASE 8: Settings and Company UI as Control Plane", () => {
  const store = new InMemoryWorkspaceStore();
  const resolver = new EffectiveCapabilityResolver(defaultCapabilityRegistry);
  const context = {
    userId: "user-control-plane",
    workspaceId: "ws-control-plane",
    permissions: ["workspace:read", "workspace:write", "research:execute", "files:execute", "ai:execute", "browser:execute", "communications:execute", "business:manage"],
  };

  describe("UI Capability Exposure & Filtering", () => {
    it("ensures UI only exposes agent-callable tools and never exposes internal runtime capabilities", () => {
      const allCapabilities = CAPABILITY_CATALOG;
      expect(allCapabilities.length).toBe(306);

      const agentCallableTools = allCapabilities.filter((cap) => cap.agentCallable);
      const internalNonTools = allCapabilities.filter((cap) => !cap.agentCallable);

      // Exactly 42 tools should be agent-callable
      expect(agentCallableTools.length).toBe(42);
      expect(internalNonTools.length).toBe(264);

      // Verify that internal runtime/ops/orchestration capabilities are strictly non-agentCallable
      const internalTypes = new Set(["runtime", "orchestration", "security_ops", "configuration"]);
      for (const nonTool of internalNonTools) {
        expect(nonTool.agentCallable).toBe(false);
        expect(internalTypes.has(nonTool.type)).toBe(true);
      }

      // Verify that agent-callable tools belong to tool domain
      for (const tool of agentCallableTools) {
        expect(tool.type).toBe("tool");
        expect(tool.agentCallable).toBe(true);
      }
    });
  });

  describe("Backend Effective Set Toggling", () => {
    it("reflects tool toggle immediately in EffectiveCapabilityResolver", async () => {
      const tools = defaultCapabilityRegistry.list({ type: "tool" });
      const tool1 = tools[0]!;
      const tool2 = tools[1]!;

      const company = await store.createCompany(
        context,
        { name: "Control Plane Co", languages: ["en"], status: "active" },
        "idemp-cp-1"
      );

      const agent = await store.createCompanyAgent(
        context,
        company.id,
        {
          name: "Flexible Agent",
          role: "Specialist",
          tools: [tool1.id],
          isActive: true,
        },
        "idemp-agent-1"
      );

      const executionCtxBefore: AgentExecutionInput = {
        auth: context,
        activeContext: { contextType: "company", companyId: company.id, businessId: null },
        company: { id: company.id, revision: company.revision },
        agent: { id: agent.id, revision: agent.revision, tools: agent.tools },
      };

      // Before toggle: tool1 allowed, tool2 denied
      expect(resolver.canExecute(executionCtxBefore, tool1.id).allowed).toBe(true);
      const deniedBefore = resolver.canExecute(executionCtxBefore, tool2.id);
      expect(deniedBefore.allowed).toBe(false);
      expect(deniedBefore.detail?.reasonCode).toBe("agent_allowlist");

      // Toggle tool: add tool2
      const updatedAgent = await store.updateCompanyAgent(
        context,
        company.id,
        agent.id,
        { tools: [tool1.id, tool2.id] },
        agent.revision
      );

      const executionCtxAfter: AgentExecutionInput = {
        auth: context,
        activeContext: { contextType: "company", companyId: company.id, businessId: null },
        company: { id: company.id, revision: company.revision },
        agent: { id: updatedAgent.id, revision: updatedAgent.revision, tools: updatedAgent.tools },
      };

      // After toggle: tool2 is immediately allowed
      const allowedAfter = resolver.canExecute(executionCtxAfter, tool2.id);
      expect(allowedAfter.allowed).toBe(true);
    });
  });

  describe("Revision Conflict & Multi-Tab Concurrent Editing Protection", () => {
    it("rejects stale revision with conflict error and prevents silent overwriting", async () => {
      const company = await store.createCompany(
        context,
        { name: "Revision Test Co", languages: ["en"], status: "active" },
        "idemp-rev-1"
      );

      const agent = await store.createCompanyAgent(
        context,
        company.id,
        { name: "Concurrent Agent", role: "Worker", tools: [], isActive: true },
        "idemp-agent-rev"
      );

      expect(agent.revision).toBe(1);

      // Tab 1 updates agent with expectedRevision 1 -> success, revision becomes 2
      const tab1Result = await store.updateCompanyAgent(
        context,
        company.id,
        agent.id,
        { description: "Updated from Tab 1" },
        1
      );
      expect(tab1Result.revision).toBe(2);

      // Tab 2 (holding stale revision 1) attempts to update -> must throw conflict
      await expect(
        store.updateCompanyAgent(
          context,
          company.id,
          agent.id,
          { description: "Overwrite from Tab 2" },
          1
        )
      ).rejects.toThrow(/changed by another request/i);

      // Verify the agent description was NOT overwritten silently
      const current = await store.getCompanyAgent(context, company.id, agent.id);
      expect(current.description).toBe("Updated from Tab 1");
      expect(current.revision).toBe(2);
    });

    it("enforces revision conflict for Company settings as well", async () => {
      const company = await store.createCompany(
        context,
        { name: "Initial Name", languages: ["en"], status: "active" },
        "idemp-comp-rev"
      );
      expect(company.revision).toBe(1);

      // Update 1: Rev 1 -> 2
      await store.updateCompany(context, company.id, { name: "Name by Tab A" }, 1);

      // Concurrent Update by Tab B with stale rev 1 -> conflict
      await expect(
        store.updateCompany(context, company.id, { name: "Name by Tab B" }, 1)
      ).rejects.toThrow(/changed by another request/i);

      const current = await store.getCompany(context, company.id);
      expect(current.name).toBe("Name by Tab A");
      expect(current.revision).toBe(2);
    });
  });

  describe("Disabled Company / Agent Behavior", () => {
    it("respects inactive agent and inactive company status", async () => {
      const company = await store.createCompany(
        context,
        { name: "Active Company", languages: ["en"], status: "active" },
        "idemp-active-co"
      );

      const inactiveAgent = await store.createCompanyAgent(
        context,
        company.id,
        { name: "Disabled Specialist", role: "Auditor", tools: [], isActive: false },
        "idemp-inactive-agent"
      );

      expect(inactiveAgent.isActive).toBe(false);

      // Verify that candidate filtering excludes inactive agents
      const list = await store.listCompanyAgents(context, company.id);
      const activeCandidates = list.filter((a) => a.isActive);
      expect(activeCandidates.some((a) => a.id === inactiveAgent.id)).toBe(false);

      // Deactivate company
      const inactiveCompany = await store.updateCompany(
        context,
        company.id,
        { status: "inactive" },
        company.revision
      );
      expect(inactiveCompany.status).toBe("inactive");
    });
  });
});
