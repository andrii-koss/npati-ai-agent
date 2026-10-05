import { describe, it, expect } from "vitest";
import {
  CapabilityInspectorService,
  EffectiveCapabilityResolver,
} from "@npati/shared";

describe("Section 15: Developer / Capability Inspector", () => {
  const inspector = new CapabilityInspectorService();

  describe("Capabilities Overview & Filter Views (All 13 Slices)", () => {
    it("returns correct aggregate counts matching the extended 354-item catalog", () => {
      const report = inspector.inspect("all");

      expect(report.counts.all).toBe(354);
      expect(report.counts.agentCallable).toBe(90);
      expect(report.counts.runtimeOnly).toBe(264);
      expect(report.counts.userVisible).toBe(90);
      expect(report.counts.automatic).toBeGreaterThan(0);
      expect(report.counts.requiresApproval).toBeGreaterThan(0);
      expect(report.counts.destructive).toBeGreaterThan(0);
      expect(report.counts.missingTest).toBe(0);
      expect(report.counts.missingUi).toBe(264);
      expect(report.items.length).toBe(354);
    });

    it("filters precisely by agent-callable slice (90 tools)", () => {
      const report = inspector.inspect("agent-callable");
      expect(report.items.length).toBe(90);
      for (const item of report.items) {
        expect(item.agentCallable).toBe(true);
      }
    });

    it("filters precisely by runtime-only slice (264 capabilities)", () => {
      const report = inspector.inspect("runtime-only");
      expect(report.items.length).toBe(264);
      for (const item of report.items) {
        expect(item.agentCallable).toBe(false);
      }
    });

    it("filters by requires-approval slice", () => {
      const report = inspector.inspect("requires-approval");
      expect(report.items.length).toBe(report.counts.requiresApproval);
      for (const item of report.items) {
        expect(["high", "critical"]).toContain(item.risk);
      }
    });

    it("filters by destructive slice", () => {
      const report = inspector.inspect("destructive");
      expect(report.items.length).toBe(report.counts.destructive);
    });

    it("evaluates denied and unavailable capabilities under an authenticated context", () => {
      const ctx = {
        auth: { workspaceId: "ws-test", userId: "u-test", permissions: [] }, // zero permissions
        activeContext: { contextType: "company", companyId: "comp-1", businessId: null },
        company: { id: "comp-1", revision: 1 },
        agent: {
          id: "ag-limited",
          revision: 1,
          tools: ["research.web_search"],
          disabledCapabilities: ["system.database_write"],
        },
        activeConnections: [], // no active connections
      };

      const deniedReport = inspector.inspect("denied", ctx);
      expect(deniedReport.counts.denied).toBeGreaterThan(0);
      expect(deniedReport.items.length).toBe(deniedReport.counts.denied);

      const unavailReport = inspector.inspect("unavailable", ctx);
      expect(unavailReport.counts.unavailable).toBeGreaterThan(0);
      expect(unavailReport.items.length).toBe(unavailReport.counts.unavailable);
    });
  });

  describe("Run Details Inspection with Complete Telemetry", () => {
    it("generates a comprehensive run inspector report with all required inspection fields", () => {
      const now = new Date();
      const startTime = new Date(now.getTime() - 4500).toISOString();
      const endTime = now.toISOString();

      const runReport = inspector.inspectRun({
        run: {
          id: "run-inspect-101",
          workspaceId: "ws-enterprise",
          companyId: "comp-acme",
          mainAgentId: "ag-main",
          selectedAgentIds: ["ag-main", "ag-seo", "ag-reviewer"],
          task: "Conduct SEO analysis and create publication report",
          status: "completed",
          executionMode: "single",
          requestedMode: "single",
          startedAt: startTime,
          completedAt: endTime,
          costUsd: 0.042,
          tokenCount: 1540,
          retryCount: 0,
          contextSnapshot: {
            contextType: "company",
            companyId: "comp-acme",
          },
        },
        steps: [
          {
            id: "step-1",
            stepOrder: 1,
            agentId: "ag-main",
            status: "completed",
            toolCalls: [{ toolName: "web.search", status: "succeeded", outputPreview: "Search results 1..5" }],
          },
          {
            id: "step-2",
            stepOrder: 2,
            agentId: "ag-seo",
            status: "completed",
            toolCalls: [{ toolName: "web.fetch", status: "succeeded", outputPreview: "Fetched 12kb HTML" }],
          },
          {
            id: "step-3",
            stepOrder: 3,
            agentId: "ag-reviewer",
            status: "completed",
          },
        ],
        detectedIntent: "seo_research_and_drafting",
        selectedSkills: ["research", "seo"],
        candidateCapabilities: ["research.web_search", "browser.web_fetch"],
        capabilitiesRemovedByPolicy: [{ capabilityId: "system.database_drop", reasonCode: "agent_allowlist" }],
        toolsExposedToModel: ["web.search", "web.fetch"],
        auditEvents: [
          { id: "audit-1", toolName: "web.search", status: "succeeded", payloadHash: "hash-1" },
        ],
      });

      expect(runReport.runId).toBe("run-inspect-101");
      expect(runReport.activeContext.contextType).toBe("company");
      expect(runReport.activeContext.workspaceId).toBe("ws-enterprise");
      expect(runReport.selectedCompanyId).toBe("comp-acme");
      expect(runReport.selectedAgent?.id).toBe("ag-main");
      expect(runReport.detectedIntent).toBe("seo_research_and_drafting");
      expect(runReport.selectedSkills).toEqual(["research", "seo"]);
      expect(runReport.candidateCapabilities).toEqual(["research.web_search", "browser.web_fetch"]);
      expect(runReport.capabilitiesRemovedByPolicy).toHaveLength(1);
      expect(runReport.toolsExposedToModel).toEqual(["web.search", "web.fetch"]);
      expect(runReport.toolsActuallyCalled).toHaveLength(2);
      expect(runReport.toolResults).toHaveLength(2);
      expect(runReport.agentDelegations).toHaveLength(3);
      expect(runReport.tokenCostRuntime.tokenCount).toBe(1540);
      expect(runReport.tokenCostRuntime.costUsd).toBe(0.042);
      expect(runReport.tokenCostRuntime.durationMs).toBeGreaterThan(4000);
      expect(runReport.auditEvents).toHaveLength(1);
      expect(runReport.status).toBe("completed");
    });
  });

  describe("API Exposure: GET /capabilities/inspect", () => {
    it("exposes /capabilities/inspect over HTTP returning filtered slices", async () => {
      const { buildApp } = await import("../apps/agent-api/src/app");
      const { InMemoryWorkspaceStore } = await import("@npati/workspace");
      const app = buildApp({
        workspaceStore: new InMemoryWorkspaceStore(),
        authProvider: { authenticate: async () => ({ workspaceId: "ws-dev", userId: "u-dev", permissions: ["workspace:read"] }) },
        marketplace: { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as any,
        aiEngine: { healthCheck: async () => ({ status: "ok" }) } as any,
      });

      const res = await app.inject({ method: "GET", url: "/capabilities/inspect?slice=agent-callable" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.counts.all).toBe(354);
      expect(body.counts.agentCallable).toBe(90);
      expect(body.items.length).toBe(90);
      expect(body.activeSlice).toBe("agent-callable");

      await app.close();
    }, 40_000);
  });

  describe("security-gate: C2 coding capabilities and their feature-flag badge", () => {
    const CODE_IDS = ["code.fs.list", "code.fs.read", "code.fs.grep", "code.fs.tree", "code.symbols.outline", "code.project.info"];

    it("registers the six read-only code capabilities with the expected contract and unique inventory ids", () => {
      const report = inspector.inspect("all");
      const codeItems = report.items.filter((item) => item.domain === "code");

      expect(codeItems.map((item) => item.capabilityId).sort()).toEqual([...CODE_IDS].sort());
      expect(codeItems.map((item) => item.id)).toEqual([349, 350, 351, 352, 353, 354]);
      expect(new Set(codeItems.map((item) => item.id)).size).toBe(6);
      for (const item of codeItems) {
        expect(item.risk).toBe("low");
        expect(item.agentCallable).toBe(true);
        expect(item.type).toBe("tool");
        expect(item.status).toBe("VERIFIED_EXISTING");
      }
      // The code domain is additive: the previous three domains keep their exact sizes.
      const byDomain = report.items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.domain]: (acc[item.domain] ?? 0) + 1 }), {});
      expect(byDomain.code).toBe(6);
      expect(report.counts.all).toBe(354);
    });

    it("never reports a code capability as allowed when no flag source is available", () => {
      const items = inspector.inspect("all").items.filter((item) => item.domain === "code");
      for (const item of items) {
        expect(item.flagKey).toBe("code.read");
        // No flag source configured: the badge must be unknown, never "on".
        expect(item.flagState).toBe("unknown");
      }
      const nonCode = inspector.inspect("all").items.filter((item) => item.domain !== "code");
      for (const item of nonCode) {
        expect(item.flagKey).toBeNull();
        expect(item.flagState).toBeNull();
      }
    });

    it("maps the code.read flag state into the badge without enabling anything itself", () => {
      const off = inspector.inspect("all", undefined, { flagStates: { "code.read": false }, flagSourceAvailable: true });
      const on = inspector.inspect("all", undefined, { flagStates: { "code.read": true }, flagSourceAvailable: true });
      expect(off.items.filter((i) => i.domain === "code").every((i) => i.flagState === "off")).toBe(true);
      expect(on.items.filter((i) => i.domain === "code").every((i) => i.flagState === "on")).toBe(true);
      // Dark launch default: the flag is off, and the capability list itself is unchanged.
      expect(off.counts.all).toBe(354);
      expect(on.counts.all).toBe(354);
    });
  });
});
