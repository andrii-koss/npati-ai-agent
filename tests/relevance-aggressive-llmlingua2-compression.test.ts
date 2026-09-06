import { describe, expect, it } from "vitest";
import {
  RelevancePromptCompressor,
  AggressivePromptCompressor,
  LlmLingua2Compressor,
} from "../apps/agent-api/src/prompt-compression-algorithms";

describe("Relevance Prompt Compressor (Relevance)", () => {
  it("filters out low relevance conversation turns while retaining system instructions and recent turns", () => {
    const turns = [
      { role: "system", content: "You are NPATI routing engine." },
      { role: "user", content: "What is the weather in Kyiv today?" },
      { role: "assistant", content: "The weather in Kyiv is 22C and sunny." },
      { role: "user", content: "Can you explain quantum computing basics?" },
      { role: "assistant", content: "Quantum computing uses qubits and superposition." },
      { role: "user", content: "How do qubits use superposition in quantum algorithms?" },
    ];

    const result = RelevancePromptCompressor.compressByRelevance(
      "quantum qubits superposition",
      turns,
      0.3
    );

    expect(result.originalTurnsCount).toBe(6);
    // Irrelevant weather turns should be trimmed
    expect(result.retainedTurnsCount).toBeLessThan(6);
    expect(result.compressedTurns.some((t) => t.content.includes("weather in Kyiv"))).toBe(false);
    expect(result.compressedTurns.some((t) => t.content.includes("quantum"))).toBe(true);
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);
  });
});

describe("Aggressive Prompt Compressor (Aggressive)", () => {
  it("strips filler phrases and excessive whitespace while preserving code blocks", () => {
    const promptWithFillers = `
    Please note that in order to configure Redis, you must use the following config:

    \`\`\`json
    { "port": 6379, "host": "127.0.0.1" }
    \`\`\`

    It is important to remember that as previously mentioned, this is critical.
    `;

    const result = AggressivePromptCompressor.compress(promptWithFillers);

    expect(result.reductionPercent).toBeGreaterThan(10);
    expect(result.compressedText).not.toContain("Please note that");
    expect(result.compressedText).not.toContain("as previously mentioned");
    // Code block must remain completely intact
    expect(result.compressedText).toContain('```json\n    { "port": 6379, "host": "127.0.0.1" }\n    ```');
  });
});

describe("LLMLingua-2 Compressor (LLMLingua-2)", () => {
  it("compresses text by dropping low entropy words while preserving semantic core", () => {
    const text =
      "The system is literally and very simply going to deploy an application and a database to the production cluster.";

    const result = LlmLingua2Compressor.compressWithLingua(text, 0.5);

    expect(result.method).toBe("llmlingua-2");
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);
    expect(result.reductionPercent).toBeGreaterThan(0);
    expect(result.compressedText).toContain("deploy");
    expect(result.compressedText).toContain("production");
  });
});
