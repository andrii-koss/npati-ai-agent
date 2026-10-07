import { describe, it, expect } from "vitest";
import {
  CapabilityInspectorService,
  EffectiveCapabilityResolver,
  flagKeyForCapabilityId,
} from "@npati/shared";

describe("Section 15: Developer / Capability Inspector", () => {
  const inspector = new CapabilityInspectorService();

  describe("Capabilities Overview & Filter Views (All 13 Slices)", () => {
    it("returns correct aggregate counts matching the extended 385-item catalog", () => {
      const report = inspector.inspect("all");

      expect(report.counts.all).toBe(385);
      expect(report.counts.agentCallable).toBe(121);
      expect(report.counts.runtimeOnly).toBe(264);
      expect(report.counts.userVisible).toBe(121);
      expect(report.counts.automatic).toBeGreaterThan(0);
      expect(report.counts.requiresApproval).toBeGreaterThan(0);
      expect(report.counts.destructive).toBeGreaterThan(0);
      expect(report.counts.missingTest).toBe(0);
      expect(report.counts.missingUi).toBe(264);
      expect(report.items.length).toBe(385);
    });

    it("filters precisely by agent-callable slice (121 tools)", () => {
      const report = inspector.inspect("agent-callable");
      expect(report.items.length).toBe(121);
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
      expect(body.counts.all).toBe(385);
      expect(body.counts.agentCallable).toBe(121);
      expect(body.items.length).toBe(121);
      expect(body.activeSlice).toBe("agent-callable");

      await app.close();
    }, 40_000);
  });

  describe("security-gate: C2/C3 coding capabilities and their feature-flag badge", () => {
    const READ_IDS = ["code.fs.list", "code.fs.read", "code.fs.grep", "code.fs.tree", "code.symbols.outline", "code.project.info", "code.shell.process.list", "code.shell.process.logs", "code.deps.inspect"];
    const WRITE_IDS = ["code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move", "code.fs.delete", "code.fs.diff", "code.fs.undo_last_turn", "code.shell.exec", "code.shell.process.start", "code.shell.process.stop", "code.verify.run", "code.deps.audit", "code.deps.add"];
    const CODE_IDS = [...READ_IDS, ...WRITE_IDS];
    /** C9: session metadata — a plan draft, the todo list and the user question. All three are `low` risk. */
    const PLAN_AND_QUESTION_IDS = ["code.plan.propose", "code.plan.update", "code.ask_user"];
    /** C11: the git workflow, adapters over the existing `ProjectGitService` (inventory ids 374-384). */
    const GIT_IDS = ["code.git.status", "code.git.diff", "code.git.log", "code.git.branch.create", "code.git.branch.switch", "code.git.stage", "code.git.commit", "code.git.restore", "code.git.push", "code.git.pr.create", "code.git.pr.comment"];
    /** C12: the delegation tool (inventory id 385), visible in the Inspector like every other `code.*` tool. */
    const SUBAGENT_IDS = ["code.agent.spawn"];
    const ALL_CODE_IDS = [...CODE_IDS, ...PLAN_AND_QUESTION_IDS, ...GIT_IDS, ...SUBAGENT_IDS];
    const EXPECTED_RISK: Record<string, string> = {
      "code.fs.list": "low", "code.fs.read": "low", "code.fs.grep": "low", "code.fs.tree": "low",
      "code.symbols.outline": "low", "code.project.info": "low", "code.fs.diff": "low",
      "code.shell.process.list": "low", "code.shell.process.logs": "low", "code.deps.inspect": "low",
      "code.fs.edit": "medium", "code.fs.apply_patch": "medium", "code.fs.write": "medium",
      "code.fs.move": "medium", "code.fs.undo_last_turn": "medium", "code.fs.delete": "high",
      "code.shell.exec": "high", "code.shell.process.start": "high", "code.shell.process.stop": "medium",
      "code.verify.run": "medium", "code.deps.audit": "medium", "code.deps.add": "high",
      "code.plan.propose": "low", "code.plan.update": "low", "code.ask_user": "low",
      "code.git.status": "low", "code.git.diff": "low", "code.git.log": "low",
      "code.git.branch.create": "low", "code.git.branch.switch": "medium", "code.git.stage": "low",
      "code.git.commit": "medium", "code.git.restore": "high", "code.git.push": "high",
      "code.git.pr.create": "high", "code.git.pr.comment": "medium",
      // C12: delegation starts another run that may write, so it is a medium-risk act and not a read. It is not
      // approve-gated: the approval belongs to the write the child attempts.
      "code.agent.spawn": "medium",
    };

    it("registers every code capability with the expected contract and unique inventory ids", () => {
      const report = inspector.inspect("all");
      const codeItems = report.items.filter((item) => item.domain === "code");

      expect(codeItems.map((item) => item.capabilityId).sort()).toEqual([...ALL_CODE_IDS].sort());
      // The code inventory ids are contiguous from 349, so a group that is appended (never renumbered) keeps
      // every earlier id — which is the property the whole registry depends on.
      const expectedIds = Array.from({ length: ALL_CODE_IDS.length }, (_, index) => 349 + index);
      expect(codeItems.map((item) => item.id).sort((a, b) => a - b)).toEqual(expectedIds);
      expect(new Set(codeItems.map((item) => item.id)).size).toBe(ALL_CODE_IDS.length);
      for (const item of codeItems) {
        expect(item.risk, `${item.capabilityId} risk`).toBe(EXPECTED_RISK[item.capabilityId]);
        expect(item.agentCallable).toBe(true);
        expect(item.type).toBe("tool");
        expect(item.status).toBe("VERIFIED_EXISTING");
      }
      // The code domain is additive: the previous three domains keep their exact sizes.
      const byDomain = report.items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.domain]: (acc[item.domain] ?? 0) + 1 }), {});
      // The code domain is additive and grows with every Coding Agent step: assert the invariant
    // (the registered set matches the contract lists) instead of a hardcoded step number.
    expect(byDomain.code).toBe(ALL_CODE_IDS.length);
      expect(report.counts.all).toBe(385);
    });

    it("never reports a code capability as allowed when no flag source is available", () => {
      const items = inspector.inspect("all").items.filter((item) => item.domain === "code");
      for (const item of items) {
        // The governing flag comes from the canonical per-tool mapping (reads and code.fs.diff use
        // code.read, file mutations code.write, sandbox execution code.shell) — never a hardcoded list.
        const expectedFlag = flagKeyForCapabilityId(item.capabilityId, "code");
        expect(item.flagKey, `${item.capabilityId} flag`).toBe(expectedFlag);
        // No flag source configured: the badge must be unknown, never "on".
        expect(item.flagState).toBe("unknown");
      }
      const nonCode = inspector.inspect("all").items.filter((item) => item.domain !== "code");
      for (const item of nonCode) {
        expect(item.flagKey).toBeNull();
        expect(item.flagState).toBeNull();
      }
    });

    it("maps the code flag states into the badge without enabling anything itself", () => {
      // C12: `code.subagents` is the fifth flag a `code.*` capability can hang off, so it is part of the source.
      const off = inspector.inspect("all", undefined, { flagStates: { "code.read": false, "code.write": false, "code.shell": false, "code.git": false, "code.subagents": false }, flagSourceAvailable: true });
      const on = inspector.inspect("all", undefined, { flagStates: { "code.read": true, "code.write": true, "code.shell": true, "code.git": true, "code.subagents": true }, flagSourceAvailable: true });
      expect(off.items.filter((i) => i.domain === "code").every((i) => i.flagState === "off")).toBe(true);
      expect(on.items.filter((i) => i.domain === "code").every((i) => i.flagState === "on")).toBe(true);
      // Read tools enabled but writes, sandbox execution, git and delegation disabled: those stay off, never on.
      const readOnly = inspector.inspect("all", undefined, { flagStates: { "code.read": true, "code.write": false, "code.shell": false, "code.git": false, "code.subagents": false }, flagSourceAvailable: true });
      for (const item of readOnly.items.filter((i) => i.domain === "code")) {
        const key = flagKeyForCapabilityId(item.capabilityId, "code");
        expect(item.flagState, `${item.capabilityId} state`).toBe(key === "code.read" ? "on" : "off");
      }
      // A flag that the source does not report is never treated as enabled (off or unknown, not on).
      const missing = inspector.inspect("all", undefined, { flagStates: { "code.read": true }, flagSourceAvailable: true });
      for (const item of missing.items.filter((i) => i.domain === "code")) {
        const key = flagKeyForCapabilityId(item.capabilityId, "code");
        if (key === "code.read") { expect(item.flagState, `${item.capabilityId} state`).toBe("on"); continue; }
        expect(["off", "unknown"], `${item.capabilityId} must not be on when its flag is missing`).toContain(item.flagState);
      }
      // Dark launch default: the flags are off, and the capability list itself is unchanged (C12: 385 entries).
      expect(off.counts.all).toBe(385);
      expect(on.counts.all).toBe(385);
    });
  });
});
