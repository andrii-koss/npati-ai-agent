import { describe, expect, it } from "vitest";
import {
  LitePromptCompressor,
  ToolOutputCompressor,
  ContextHeadroomCompressor,
} from "../apps/agent-api/src/compression-lite-tool-headroom";

describe("Lite Prompt Compressor (Lite)", () => {
  it("compresses text by stripping cosmetic markdown and whitespace in sub-millisecond time", () => {
    const input = `
    **Important Notice:**

    Please follow the __instructions__ carefully.


    - Point 1
    - Point 2
    `;

    const res = LitePromptCompressor.compress(input);
    expect(res.compressedText).toContain("Important Notice:");
    expect(res.compressedText).not.toContain("**");
    expect(res.compressedTokens).toBeLessThan(res.originalTokens);
    expect(res.durationMs).toBeLessThan(50); // very fast execution
  });
});

describe("Tool Output Compressor (Responses Tool Output)", () => {
  it("compacts large array outputs and generates summary indicators", () => {
    const largeArray = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `Resource ${i}`,
      status: "active",
      payload: "extra payload data",
    }));

    const res = ToolOutputCompressor.compress(largeArray, 100);
    expect(res.isTruncated).toBe(true);
    expect(res.compressedSizeBytes).toBeLessThan(res.originalSizeBytes);

    const parsed = JSON.parse(res.compressedOutput);
    expect(parsed.totalCount).toBe(50);
    expect(parsed.sample.length).toBe(3);
    expect(parsed.omittedCount).toBe(47);
  });
});

describe("Context Headroom Compressor (Headroom)", () => {
  it("progressively trims older dialogue turns to reserve token headroom for generation", () => {
    const messages = [
      { role: "system", content: "You are NPATI coding agent." },
      { role: "user", content: "A".repeat(4000) }, // ~1000 tokens
      { role: "assistant", content: "B".repeat(4000) }, // ~1000 tokens
      { role: "user", content: "C".repeat(4000) }, // ~1000 tokens
      { role: "assistant", content: "D".repeat(4000) }, // ~1000 tokens
      { role: "user", content: "Final question." },
    ];

    // Max context 8192 tokens, target headroom 6000 tokens => max prompt tokens allowed: 2192 tokens
    const res = ContextHeadroomCompressor.enforce(messages, 8192, 6000);

    expect(res.trimmedTurnsCount).toBeGreaterThan(0);
    expect(res.messages[0]!.role).toBe("system");
    expect(res.messages[res.messages.length - 1]!.content).toBe("Final question.");
    expect(res.totalTokens).toBeLessThan(8192 - 6000 + 500);
  });
});
