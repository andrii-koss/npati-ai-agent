import { describe, expect, it } from "vitest";
import {
  CavemanCompressor,
  UltraCompressor,
  OmniGlyphCompressor,
} from "../apps/agent-api/src/compression-caveman-ultra-omniglyph";

describe("Caveman Compressor (Caveman)", () => {
  it("strips polite fluff and articles while leaving code blocks intact", () => {
    const text = `Could you please check the server status?
\`\`\`typescript
const theServer = "active";
\`\`\`
Please note that a database is going to be restarted.`;

    const res = CavemanCompressor.compress(text);
    expect(res.output).toContain("check server status?");
    expect(res.output).toContain("const theServer = \"active\";"); // code intact
    expect(res.output).not.toContain("Could you please");
    expect(res.compressedTokens).toBeLessThan(res.originalTokens);
  });
});

describe("Ultra Compressor (Ultra)", () => {
  it("performs maximalist log compression with timestamp stripping and deduplication", () => {
    const log = `2026-09-02T15:30:00Z INFO User 123e4567-e89b-12d3-a456-426614174000 logged in
2026-09-02T15:30:01Z INFO User 123e4567-e89b-12d3-a456-426614174000 logged in
2026-09-02T15:30:02Z INFO Task completed`;

    const res = UltraCompressor.compress(log);
    expect(res.output).toContain("[TIME]");
    expect(res.output).toContain("[ID]");
    expect(res.compressedTokens).toBeLessThan(res.originalTokens);
  });
});

describe("OmniGlyph Compressor (OmniGlyph)", () => {
  it("encodes repetitive multi-token structures into compact Unicode glyphs and decodes back", () => {
    const prompt = "user: Run tests. assistant: Tests completed with success. system: Ready.";

    const encoded = OmniGlyphCompressor.encode(prompt);
    expect(encoded.output).toContain("👤");
    expect(encoded.output).toContain("🤖");
    expect(encoded.output).toContain("⚙️");
    expect(encoded.output).toContain("✓");

    const decoded = OmniGlyphCompressor.decode(encoded.output);
    expect(decoded.toLowerCase()).toContain("user:");
    expect(decoded.toLowerCase()).toContain("assistant:");
  });
});
