import { describe, expect, it } from "vitest";
import {
  OutputStyleModifier,
  CompressionEvalHarness,
  CacheManagementService,
} from "../apps/agent-api/src/output-styles-eval-and-cache";

describe("Output Style Modifier (Output Styles)", () => {
  it("injects concise, bulleted, and minimal-json style prompts into message history", () => {
    const messages = [
      { role: "system", content: "You are NPATI Assistant." },
      { role: "user", content: "List all microservices." },
    ];

    const concise = OutputStyleModifier.applyOutputStyle(messages, "concise");
    expect(concise[0]!.content).toContain("Extremely concise and direct");

    const minimalJson = OutputStyleModifier.applyOutputStyle(messages, "minimal-json");
    expect(minimalJson[0]!.content).toContain("Valid compact JSON only");
  });
});

describe("Compression Eval Harness (Compression Eval Harness)", () => {
  it("evaluates compression reduction percent and entity retention accuracy", () => {
    const original =
      "PostgreSQL and Redis cluster deployment in production with 3 replicas and automated failover.";
    const compressed =
      "PostgreSQL Redis cluster deployment production 3 replicas automated failover.";

    const report = CompressionEvalHarness.evaluate(original, compressed);

    expect(report.reductionPercent).toBeGreaterThan(10);
    expect(report.entityRetentionRate).toBeGreaterThanOrEqual(0.7);
    expect(report.passedValidation).toBe(true);
  });
});

describe("Cache Management Service (Cache Stats / Flush)", () => {
  it("tracks hit ratios and supports scoped cache flushing", () => {
    const cache = new CacheManagementService();

    cache.set("tenantA:session:1", { user: "alice" });
    cache.set("tenantA:session:2", { user: "bob" });
    cache.set("tenantB:session:1", { user: "carol" });

    // Hit & Miss
    expect(cache.get("tenantA:session:1")).toEqual({ user: "alice" });
    expect(cache.get("tenantA:nonexistent")).toBeUndefined();

    const stats = cache.getStats("tenantA");
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.totalKeys).toBe(2);
    expect(stats.hitRatio).toBe(0.5);

    // Scoped flush for tenantA
    const flushRes = cache.flush({ tenantId: "tenantA" });
    expect(flushRes.flushedCount).toBe(2);
    expect(cache.getStats("tenantA").totalKeys).toBe(0);

    // tenantB still exists
    expect(cache.get("tenantB:session:1")).toEqual({ user: "carol" });
  });
});
