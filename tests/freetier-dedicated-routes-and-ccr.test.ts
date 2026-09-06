import { describe, expect, it } from "vitest";
import {
  FreeTierCatalogManager,
  DedicatedProviderRouter,
  CcrCompressionEvaluator,
} from "../apps/agent-api/src/freetier-dedicated-routes-and-ccr";

describe("Free-Tier Catalog Manager (Free-tier catalog)", () => {
  it("manages zero-cost model catalog and enforces daily quota thresholds", () => {
    const manager = new FreeTierCatalogManager();

    const models = manager.listFreeModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.some((m) => m.id === "google/gemini-2.0-flash-free")).toBe(true);

    const isAvailBefore = manager.isQuotaAvailable("google/gemini-2.0-flash-free", 5000);
    expect(isAvailBefore).toBe(true);

    // Record high usage
    manager.recordUsage("google/gemini-2.0-flash-free", 999_000);
    const isAvailAfter = manager.isQuotaAvailable("google/gemini-2.0-flash-free", 5000);
    expect(isAvailAfter).toBe(false);
  });
});

describe("Dedicated Provider Router (Dedicated provider routes)", () => {
  it("resolves direct provider routes and flags dynamic arbitration bypass", () => {
    const directRes = DedicatedProviderRouter.resolve(
      "/v1/providers/deepseek/chat/completions"
    );
    expect(directRes.isDirectRoute).toBe(true);
    expect(directRes.provider).toBe("deepseek");
    expect(directRes.normalizedEndpoint).toBe("/v1/chat/completions");
    expect(directRes.bypassArbitration).toBe(true);

    const normalRes = DedicatedProviderRouter.resolve("/v1/chat/completions");
    expect(normalRes.isDirectRoute).toBe(false);
    expect(normalRes.bypassArbitration).toBe(false);
  });
});

describe("CCR Compression Evaluator (CCR)", () => {
  it("calculates context reduction ratio and maintains thread history", () => {
    const evaluator = new CcrCompressionEvaluator();

    // Turn 1: 10,000 raw tokens compressed to 3,000 tokens (70% reduction -> CCR = 0.70)
    const res1 = evaluator.evaluateTurn("thread-alpha", 10_000, 3_000, 0.4);
    expect(res1.compressionRatio).toBe(0.7);
    expect(res1.meetsThreshold).toBe(true);

    // Turn 2: 5,000 raw tokens compressed to 4,000 tokens (20% reduction -> CCR = 0.20)
    const res2 = evaluator.evaluateTurn("thread-alpha", 5_000, 4_000, 0.4);
    expect(res2.compressionRatio).toBe(0.2);
    expect(res2.meetsThreshold).toBe(false);

    // Average: (0.7 + 0.2) / 2 = 0.45
    expect(evaluator.getAverageCcr("thread-alpha")).toBe(0.45);
  });
});
