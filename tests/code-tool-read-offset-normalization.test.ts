import { describe, it, expect } from "vitest";
import { validateArguments } from "../apps/agent-api/src/code-tool-runtime";
import { normalizeToolCalls } from "../apps/agent-api/src/code-tool-call-adapter";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";

describe("code.fs.read offset: 0 safe normalization unit & regression tests", () => {
  const readTool = CODE_TOOL_SCHEMAS.find((t) => t.name === "code.fs.read")!;
  const readSchema = readTool.inputSchema as Record<string, unknown>;

  // Tool with 0-based offset
  const procLogsTool = CODE_TOOL_SCHEMAS.find((t) => t.name === "code.shell.process.logs")!;
  const procLogsSchema = procLogsTool.inputSchema as Record<string, unknown>;

  it("normalizes offset: 0 to offset: 1 specifically for code.fs.read", () => {
    // 1. With explicit toolName
    const res1 = validateArguments(readSchema, { path: "index.html", offset: 0 }, "code.fs.read");
    expect(res1.offset).toBe(1);
    expect(res1.path).toBe("index.html");

    // 2. Without explicit toolName (schema inference)
    const res2 = validateArguments(readSchema, { path: "index.html", offset: 0 });
    expect(res2.offset).toBe(1);
  });

  it("preserves 1-based offset semantics when valid positive offset is supplied", () => {
    const res1 = validateArguments(readSchema, { path: "index.html", offset: 1 }, "code.fs.read");
    expect(res1.offset).toBe(1);

    const res50 = validateArguments(readSchema, { path: "index.html", offset: 50 }, "code.fs.read");
    expect(res50.offset).toBe(50);
  });

  it("strictly rejects negative offset values", () => {
    expect(() => validateArguments(readSchema, { path: "index.html", offset: -1 }, "code.fs.read")).toThrow(
      /below the minimum/,
    );
    expect(() => validateArguments(readSchema, { path: "index.html", offset: -100 }, "code.fs.read")).toThrow(
      /below the minimum/,
    );
  });

  it("strictly rejects fractional/float offset values", () => {
    expect(() => validateArguments(readSchema, { path: "index.html", offset: 0.5 }, "code.fs.read")).toThrow(
      /must be an integer/,
    );
    expect(() => validateArguments(readSchema, { path: "index.html", offset: 1.5 }, "code.fs.read")).toThrow(
      /must be an integer/,
    );
  });

  it("strictly rejects non-numeric offset values", () => {
    expect(() => validateArguments(readSchema, { path: "index.html", offset: "0" }, "code.fs.read")).toThrow(
      /must be an integer/,
    );
    expect(() => validateArguments(readSchema, { path: "index.html", offset: "1" }, "code.fs.read")).toThrow(
      /must be an integer/,
    );
    expect(() => validateArguments(readSchema, { path: "index.html", offset: true }, "code.fs.read")).toThrow(
      /must be an integer/,
    );
    expect(() => validateArguments(readSchema, { path: "index.html", offset: [] }, "code.fs.read")).toThrow(
      /must be an integer/,
    );
    expect(() => validateArguments(readSchema, { path: "index.html", offset: {} }, "code.fs.read")).toThrow(
      /must be an integer/,
    );
  });

  it("does not change behavior of other tools using offset (e.g. code.shell.process.logs)", () => {
    // code.shell.process.logs uses 0-based byte offsets
    const logsArgs = validateArguments(
      procLogsSchema,
      { processId: "proc-123", offset: 0 },
      "code.shell.process.logs",
    );
    // Must remain 0, NOT transformed to 1
    expect(logsArgs.offset).toBe(0);
  });

  it("does not normalize offset: 0 on arbitrary unknown tools with minimum: 1", () => {
    const customSchema = {
      type: "object",
      required: ["count"],
      additionalProperties: false,
      properties: {
        count: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 1 },
      },
    };
    expect(() =>
      validateArguments(customSchema, { count: 5, offset: 0 }, "custom.other.tool"),
    ).toThrow(/below the minimum/);
  });

  it("integrates with normalizeToolCalls adapter without repeating invalid argument rejections", () => {
    const knownTools = [{ name: "code.fs.read", inputSchema: readSchema }];
    const profile = { name: "test-model", engine: "openai", toolCallingMode: "native" as const };

    // Valid offset: 0 normalized to 1
    const resValid = normalizeToolCalls({
      payload: {
        toolCalls: [
          {
            id: "call_read_0",
            type: "function",
            function: {
              name: "code.fs.read",
              arguments: JSON.stringify({ path: "index.html", offset: 0, limit: 100 }),
            },
          },
        ],
      },
      profile,
      mode: "native",
      knownTools,
      validate: validateArguments,
    });

    expect(resValid.rejected).toHaveLength(0);
    expect(resValid.calls).toHaveLength(1);
    expect(resValid.calls[0].arguments.offset).toBe(1);

    // Invalid negative offset still rejected with model feedback
    const resInvalid = normalizeToolCalls({
      payload: {
        toolCalls: [
          {
            id: "call_read_neg",
            type: "function",
            function: {
              name: "code.fs.read",
              arguments: JSON.stringify({ path: "index.html", offset: -5 }),
            },
          },
        ],
      },
      profile,
      mode: "native",
      knownTools,
      validate: validateArguments,
    });

    expect(resInvalid.rejected).toHaveLength(1);
    expect(resInvalid.rejected[0].code).toBe("invalid_tool_arguments");
    expect(resInvalid.rejected[0].message).toMatch(/below the minimum/);
  });
});
