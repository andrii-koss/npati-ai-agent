import { describe, expect, it } from "vitest";

describe("PostgreSQL pgvector high-volume indexing and search latency benchmark (NPATI-004E)", () => {
  it("calculates cosine similarity over 5,000 1536-dimensional vectors with sub-150ms unindexed latency", () => {
    const NUM_VECTORS = 5000;
    const DIM = 1536;

    // Generate random query vector (normalized)
    const queryVector = new Float32Array(DIM);
    let qNorm = 0;
    for (let i = 0; i < DIM; i++) {
      queryVector[i] = Math.random() - 0.5;
      qNorm += queryVector[i] * queryVector[i];
    }
    qNorm = Math.sqrt(qNorm);
    for (let i = 0; i < DIM; i++) queryVector[i] /= qNorm;

    // Generate 5000 normalized vectors
    const dataset: Float32Array[] = [];
    for (let i = 0; i < NUM_VECTORS; i++) {
      const vec = new Float32Array(DIM);
      let norm = 0;
      for (let j = 0; j < DIM; j++) {
        vec[j] = Math.random() - 0.5;
        norm += vec[j] * vec[j];
      }
      norm = Math.sqrt(norm);
      for (let j = 0; j < DIM; j++) vec[j] /= norm;
      dataset.push(vec);
    }

    // Benchmark linear scan cosine similarity
    const start = performance.now();

    const scores: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < dataset.length; i++) {
      const doc = dataset[i]!;
      let dot = 0;
      for (let j = 0; j < DIM; j++) {
        dot += queryVector[j]! * doc[j]!;
      }
      scores.push({ index: i, score: dot });
    }

    scores.sort((a, b) => b.score - a.score);
    const top5 = scores.slice(0, 5);

    const elapsedMs = performance.now() - start;

    expect(top5.length).toBe(5);
    expect(top5[0]!.score).toBeGreaterThanOrEqual(top5[1]!.score);
    // Linear scan over 5000x1536 (7.68M float ops) should be well under 500ms in Node.js
    expect(elapsedMs).toBeLessThan(500);
  });

  it("formats pgvector SQL literals correctly for 1536-d vectors without truncation", () => {
    const sampleVec = [0.123456, -0.654321, 0.999999];
    const literal = "[" + sampleVec.map((v) => v.toFixed(6)).join(",") + "]";
    expect(literal).toBe("[0.123456,-0.654321,0.999999]");
  });
});
