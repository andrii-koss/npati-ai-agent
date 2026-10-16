import { describe, it, expect } from "vitest";
import { validateArguments } from "../apps/agent-api/src/code-tool-runtime";
import { normalizeToolCalls } from "../apps/agent-api/src/code-tool-call-adapter";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";

describe("code.fs.grep limit -> maxResults safe normalization & error feedback tests", () => {
  const grepTool = CODE_TOOL_SCHEMAS.find((t) => t.name === "code.fs.grep")!;
  const grepSchema = grepTool.inputSchema as Record<string, unknown>;

  const readTool = CODE_TOOL_SCHEMAS.find((t) => t.name === "code.fs.read")!;
  const readSchema = readTool.inputSchema as Record<string, unknown>;

  // 1. limit -> maxResults normalization
  it("normalizes 'limit' to 'maxResults' when maxResults is omitted", () => {
    // With explicit toolName
    const input1 = { pattern: "<script", limit: 20 };
    const res1 = validateArguments(grepSchema, input1, "code.fs.grep");
    expect(res1.maxResults).toBe(20);
    expect(res1.limit).toBeUndefined();
    expect(res1.pattern).toBe("<script");

    // Without explicit toolName (schema inference)
    const input2 = { pattern: "test", limit: 50 };
    const res2 = validateArguments(grepSchema, input2);
    expect(res2.maxResults).toBe(50);
    expect(res2.limit).toBeUndefined();
  });

  // 2. Preserving explicitly passed valid maxResults
  it("preserves explicitly passed valid 'maxResults'", () => {
    const input = { pattern: "button", maxResults: 100 };
    const res = validateArguments(grepSchema, input, "code.fs.grep");
    expect(res.maxResults).toBe(100);
    expect(res.limit).toBeUndefined();
  });

  // 3. Rejects conflicting simultaneous limit and maxResults
  it("rejects simultaneous conflicting 'limit' and 'maxResults' without silent overwrite", () => {
    const input = { pattern: "button", limit: 10, maxResults: 20 };
    expect(() => validateArguments(grepSchema, input, "code.fs.grep")).toThrowError(
      /Conflicting arguments provided \('limit' and 'maxResults'\)/,
    );
  });

  // 4. Strictly rejects non-integer/invalid types for limit
  it("strictly rejects non-integer/invalid types for 'limit'", () => {
    // String
    expect(() => validateArguments(grepSchema, { pattern: "a", limit: "20" }, "code.fs.grep")).toThrow(
      /Argument 'limit' must be an integer/,
    );
    // Float
    expect(() => validateArguments(grepSchema, { pattern: "a", limit: 10.5 }, "code.fs.grep")).toThrow(
      /Argument 'limit' must be an integer/,
    );
    // Boolean
    expect(() => validateArguments(grepSchema, { pattern: "a", limit: true }, "code.fs.grep")).toThrow(
      /Argument 'limit' must be an integer/,
    );
    // Null
    expect(() => validateArguments(grepSchema, { pattern: "a", limit: null }, "code.fs.grep")).toThrow(
      /Argument 'limit' must be an integer/,
    );
  });

  // 5. Strictly rejects values out of bounds (< 1 or > 1000)
  it("strictly rejects 'limit' values out of bounds", () => {
    // limit < 1
    expect(() => validateArguments(grepSchema, { pattern: "a", limit: 0 }, "code.fs.grep")).toThrow(
      /Argument 'limit' must be >= 1/,
    );
    expect(() => validateArguments(grepSchema, { pattern: "a", limit: -5 }, "code.fs.grep")).toThrow(
      /Argument 'limit' must be >= 1/,
    );
    // limit > 1000
    expect(() => validateArguments(grepSchema, { pattern: "a", limit: 1001 }, "code.fs.grep")).toThrow(
      /Argument 'limit' exceeds maximum of 1000/,
    );
    expect(() => validateArguments(grepSchema, { pattern: "a", limit: 9999 }, "code.fs.grep")).toThrow(
      /Argument 'limit' exceeds maximum of 1000/,
    );
  });

  // 6. Strictly rejects other unknown arguments with allowed parameters hint
  it("strictly rejects unknown arguments with allowed parameters list in error message", () => {
    expect(() => validateArguments(grepSchema, { pattern: "a", unknownProp: true }, "code.fs.grep")).toThrowError(
      /Tool 'code\.fs\.grep': Unknown argument: unknownProp\. Allowed parameters: \[pattern, mode, glob, type, contextLines, maxResults, ignoreCase, fixedStrings, path\]/,
    );
  });

  // 7. Immutability of original arguments object
  it("never mutates the caller's original arguments object directly", () => {
    const originalInput = Object.freeze({ pattern: "test", limit: 25 });
    const normalized = validateArguments(grepSchema, originalInput, "code.fs.grep");
    expect(normalized.maxResults).toBe(25);
    expect(normalized.limit).toBeUndefined();
    // originalInput must be completely unchanged
    expect(originalInput.limit).toBe(25);
    expect((originalInput as any).maxResults).toBeUndefined();
  });

  // 8. Zero effect on other tools
  it("does not normalize limit for tools where limit is a native parameter (e.g. code.fs.read)", () => {
    const readInput = { path: "index.html", limit: 50 };
    const readRes = validateArguments(readSchema, readInput, "code.fs.read");
    expect(readRes.limit).toBe(50);
    expect((readRes as any).maxResults).toBeUndefined();
  });

  // 9. Integration with normalizeToolCalls
  it("integrates seamlessly into normalizeToolCalls native and text flows", () => {
    const normalized = normalizeToolCalls({
      payload: {
        toolCalls: [
          {
            id: "call_test_1",
            function: {
              name: "code.fs.grep",
              arguments: JSON.stringify({ pattern: "Click Me", limit: 50, ignoreCase: true }),
            },
          },
        ],
      },
      knownTools: CODE_TOOL_SCHEMAS,
      profile: { id: "test", name: "test", provider: "test", family: "openai", contextWindowTokens: 8192, supportsNativeTools: true, maxParallelToolCalls: 1, toolCallingMode: "native" },
      validate: validateArguments,
    });

    expect(normalized.rejected.length).toBe(0);
    expect(normalized.calls.length).toBe(1);
    expect(normalized.calls[0].arguments.maxResults).toBe(50);
    expect(normalized.calls[0].arguments.limit).toBeUndefined();
    expect(normalized.calls[0].arguments.pattern).toBe("Click Me");
  });
});
