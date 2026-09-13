import { describe, expect, it } from "vitest";
import {
  OutputStyleModifier,
  CompressionEvalHarness,
  CacheManagementService,
  type OutputStyleType,
} from "../apps/agent-api/src/output-styles-eval-and-cache";

describe("Output Style Modifier (Capability #200 system.output_styles)", () => {
  it("provides a complete catalog of available output styles", () => {
    const styles = OutputStyleModifier.getAvailableStyles();
    expect(styles.length).toBe(4);

    const ids = styles.map((s) => s.id);
    expect(ids).toContain("concise");
    expect(ids).toContain("bulleted");
    expect(ids).toContain("minimal-json");
    expect(ids).toContain("executive");

    for (const style of styles) {
      expect(style.name).toBeDefined();
      expect(style.description).toBeDefined();
      expect(style.instruction).toBeDefined();
      expect(style.expectedTokenSavingsPercent).toBeGreaterThan(0);
    }
  });

  it("validates output style types correctly", () => {
    expect(OutputStyleModifier.isValidStyle("concise")).toBe(true);
    expect(OutputStyleModifier.isValidStyle("bulleted")).toBe(true);
    expect(OutputStyleModifier.isValidStyle("minimal-json")).toBe(true);
    expect(OutputStyleModifier.isValidStyle("executive")).toBe(true);
    expect(OutputStyleModifier.isValidStyle("unknown-style")).toBe(false);
    expect(OutputStyleModifier.isValidStyle(null)).toBe(false);
    expect(OutputStyleModifier.isValidStyle(123)).toBe(false);
  });

  it("injects concise, bulleted, and minimal-json style prompts into existing system message", () => {
    const messages = [
      { role: "system", content: "You are NPATI Assistant." },
      { role: "user", content: "List all microservices." },
    ];

    const concise = OutputStyleModifier.applyOutputStyle(messages, "concise");
    expect(concise[0]!.content).toContain("You are NPATI Assistant.");
    expect(concise[0]!.content).toContain("Extremely concise and direct");

    const minimalJson = OutputStyleModifier.applyOutputStyle(messages, "minimal-json");
    expect(minimalJson[0]!.content).toContain("Valid compact JSON only");
  });

  it("prepends a new system message when messages list lacks a system message", () => {
    const messages = [{ role: "user", content: "Explain quantum computing." }];
    const executive = OutputStyleModifier.applyOutputStyle(messages, "executive");

    expect(executive.length).toBe(2);
    expect(executive[0]!.role).toBe("system");
    expect(executive[0]!.content).toContain("Executive briefing");
    expect(executive[1]!.role).toBe("user");
  });

  it("injects style instructions into a single prompt string", () => {
    const prompt = "Summarize the quarterly revenue report.";
    const styled = OutputStyleModifier.applyOutputStyleToPrompt(prompt, "bulleted");

    expect(styled).toContain("Concise bulleted points");
    expect(styled).toContain("Summarize the quarterly revenue report.");
  });
});

describe("Compression Eval Harness (Capability #201 system.compression_eval_harness)", () => {
  it("evaluates compression reduction percent, entity retention, and semantic overlap", () => {
    const original =
      "PostgreSQL and Redis cluster deployment in production with 3 replicas and automated failover.";
    const compressed =
      "PostgreSQL Redis cluster deployment production 3 replicas automated failover.";

    const report = CompressionEvalHarness.evaluate(original, compressed);

    expect(report.reductionPercent).toBeGreaterThan(10);
    expect(report.entityRetentionRate).toBeGreaterThanOrEqual(0.7);
    expect(report.semanticOverlapScore).toBeGreaterThan(0.5);
    expect(report.passedValidation).toBe(true);
    expect(report.notes).toContain("Passed evaluation");
  });

  it("evaluates multi-turn messages compression", () => {
    const originalMessages = [
      { role: "system", content: "You are a cloud architect specialized in Kubernetes." },
      { role: "user", content: "How do we scale worker pods based on custom Redis queue depth metrics?" },
    ];
    const compressedMessages = [
      { role: "system", content: "Cloud architect Kubernetes specialist." },
      { role: "user", content: "Scale worker pods on Redis queue metrics?" },
    ];

    const report = CompressionEvalHarness.evaluateMessages(originalMessages, compressedMessages);

    expect(report.originalLength).toBeGreaterThan(report.compressedLength);
    expect(report.reductionPercent).toBeGreaterThan(15);
    expect(report.entityRetentionRate).toBeGreaterThanOrEqual(0.5);
    expect(report.passedValidation).toBe(true);
  });

  it("enforces custom quality thresholds and detects failed compression", () => {
    const original = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda";
    // Compressed text strips too many entities and has almost no reduction
    const poorCompression = "Alpha Beta";

    // Strict requirements: min 70% retention and min 20% reduction
    const report = CompressionEvalHarness.evaluate(original, poorCompression, {
      minEntityRetentionRate: 0.7,
      minReductionPercent: 20,
    });

    // 2 out of 11 entities retained = ~18%, fails 70% threshold
    expect(report.passedValidation).toBe(false);
    expect(report.notes).toContain("Failed evaluation");
  });
});

describe("Cache Management Service (Capability #202 system.cache_stats_flush)", () => {
  it("tracks hit ratios, has, delete, and supports scoped cache flushing", () => {
    const cache = new CacheManagementService();

    cache.set("tenantA:session:1", { user: "alice" });
    cache.set("tenantA:session:2", { user: "bob" });
    cache.set("tenantB:session:1", { user: "carol" });

    expect(cache.has("tenantA:session:1")).toBe(true);
    expect(cache.has("tenantA:unknown")).toBe(false);

    // Hit & Miss
    expect(cache.get("tenantA:session:1")).toEqual({ user: "alice" });
    expect(cache.get("tenantA:nonexistent")).toBeUndefined();

    const stats = cache.getStats("tenantA");
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.totalKeys).toBe(2);
    expect(stats.hitRatio).toBe(0.5);
    expect(stats.memoryBytesEstimate).toBeGreaterThan(0);

    // Single item deletion
    expect(cache.delete("tenantA:session:2")).toBe(true);
    expect(cache.has("tenantA:session:2")).toBe(false);

    // Scoped flush for tenantA
    const flushRes = cache.flush({ tenantId: "tenantA" });
    expect(flushRes.flushedCount).toBe(1);
    expect(cache.getStats("tenantA").totalKeys).toBe(0);

    // tenantB still exists
    expect(cache.get("tenantB:session:1")).toEqual({ user: "carol" });
    expect(cache.getStats("tenantB").totalKeys).toBe(1);

    // Global clear
    cache.clear();
    expect(cache.getStats().totalKeys).toBe(0);
    expect(cache.getStats().hits).toBe(0);
  });
});
