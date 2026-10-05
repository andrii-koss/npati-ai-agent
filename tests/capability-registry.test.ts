import { describe, it, expect } from "vitest";
import {
  defaultCapabilityRegistry,
  CapabilityRegistry,
  type CapabilityDefinition,
} from "@npati/shared";

describe("PHASE 2: Capability Registry for all 306 Inventory Items", () => {
  describe("Schema Validation and Hygiene", () => {
    it("passes full registry validation with zero errors", () => {
      const validation = defaultCapabilityRegistry.validate();
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    });

    it("verifies all capabilities have required metadata fields populated", () => {
      const all = defaultCapabilityRegistry.list();
      expect(all.length).toBeGreaterThanOrEqual(306);

      for (const cap of all) {
        expect(cap.id).toBeDefined();
        expect(cap.id.length).toBeGreaterThan(0);
        expect(cap.name).toBeDefined();
        expect(cap.name.length).toBeGreaterThan(0);
        expect(cap.description).toBeDefined();
        expect(cap.description.length).toBeGreaterThan(0);
        expect(cap.domain).toBeDefined();
        expect(cap.type).toBeDefined();
        expect(["runtime", "tool", "orchestration", "security_ops", "configuration", "skill"]).toContain(cap.type);
        expect(["ai", "research", "files", "browser", "communications", "storage", "security", "orchestration", "system", "business", "code"]).toContain(cap.domain);
        expect(["low", "medium", "high", "critical"]).toContain(cap.risk);
        expect(cap.useWhen.length).toBeGreaterThan(0);
        expect(cap.doNotUseWhen.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Coverage of 306 Inventory IDs", () => {
    it("covers 100% of the 306 inventory items without omissions", () => {
      const validation = defaultCapabilityRegistry.validate();
      expect(validation.coveredInventoryCount).toBe(367);
      expect(validation.missingInventoryIds).toEqual([]);
    });

    it("can resolve any inventory ID between 1 and 306", () => {
      for (let i = 1; i <= 306; i++) {
        const cap = defaultCapabilityRegistry.getByInventoryId(i);
        expect(cap, `Missing resolution for inventory ID ${i}`).toBeDefined();
        expect(cap!.inventoryIds).toContain(i);
      }
    });

    it("guarantees uniqueness of all capability IDs and inventory mappings", () => {
      const validation = defaultCapabilityRegistry.validate();
      expect(validation.duplicateCapabilityIds).toEqual([]);
      expect(validation.duplicateInventoryIds).toEqual([]);
    });
  });

  describe("Safety Gating (No runtime-only capability exposed to LLM)", () => {
    it("ensures ONLY 'tool' type capabilities can be agent_callable", () => {
      const validation = defaultCapabilityRegistry.validate();
      expect(validation.runtimeCallableViolations).toEqual([]);

      const callable = defaultCapabilityRegistry.listAgentCallable();
      expect(callable.length).toBe(103);

      for (const cap of callable) {
        expect(cap.type).toBe("tool");
        expect(cap.agentCallable).toBe(true);
      }
    });

    it("ensures all runtime, security_ops, configuration, and internal orchestration capabilities are NOT agent_callable", () => {
      const nonTools = defaultCapabilityRegistry.list().filter((c) => c.type !== "tool");
      expect(nonTools.length).toBe(306 - 42); // 264 non-tools

      for (const cap of nonTools) {
        expect(cap.agentCallable).toBe(false);
      }
    });
  });

  describe("Registry API, Filtering and Startup Performance", () => {
    it("filters capabilities accurately by type, domain and risk", () => {
      const tools = defaultCapabilityRegistry.list({ type: "tool" });
      expect(tools.length).toBe(103);

      const runtimes = defaultCapabilityRegistry.list({ type: "runtime" });
      expect(runtimes.length).toBe(160);

      const orchestration = defaultCapabilityRegistry.list({ type: "orchestration" });
      expect(orchestration.length).toBe(53);

      const securityOps = defaultCapabilityRegistry.list({ type: "security_ops" });
      expect(securityOps.length).toBe(33);

      const configuration = defaultCapabilityRegistry.list({ type: "configuration" });
      expect(configuration.length).toBe(18);
    });

    it("executes registry instantiation and queries deterministically within bounded time", () => {
      const start = performance.now();
      const all = defaultCapabilityRegistry.list();
      const callable = defaultCapabilityRegistry.listAgentCallable();
      const item100 = defaultCapabilityRegistry.getByInventoryId(100);
      const item306 = defaultCapabilityRegistry.getByInventoryId(306);
      const durationMs = performance.now() - start;

      expect(all.length).toBe(367);
      expect(callable.length).toBe(103);
      expect(item100).toBeDefined();
      expect(item306).toBeDefined();
      expect(durationMs).toBeLessThan(50); // Well within sub-50ms bound
    });
  });

  describe("API Exposure", () => {
    it("exposes /capabilities endpoint with filtering", async () => {
      const { buildApp } = await import("../apps/agent-api/src/app");
      const app = buildApp();
      const res = await app.inject({ method: "GET", url: "/capabilities?type=tool" });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.length).toBe(103);
      expect(data.every((c: any) => c.type === "tool")).toBe(true);

      const callableOnly = await app.inject({ method: "GET", url: "/capabilities?callable=true" });
      expect(callableOnly.statusCode).toBe(200);
      expect(callableOnly.json().length).toBe(103);

      await app.close();
    }, 40_000);
  });
});
