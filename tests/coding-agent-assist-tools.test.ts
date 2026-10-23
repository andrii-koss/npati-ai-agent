import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeToolExecutionContext, CodeToolInvokeFailure, CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import { canonicalAssistExecutors, CODE_IMAGE_ATTACHMENT_KEY, detectToolImageType } from "../apps/agent-api/src/code-tool-executors-assist";
import { CodingAgentRunner, type CodeRunToolDescriptor, type CodingAgentChatRequest } from "../apps/agent-api/src/coding-agent-runner";

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 7)]);

function execution(tool: string, args: Record<string, unknown>): CodeToolExecutionContext {
  const schema = CODE_TOOL_SCHEMAS.find((entry) => entry.name === tool)!;
  return { ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", tool: schema, args, toolCallId: "call-1" } as unknown as CodeToolExecutionContext;
}

function session(): CodeSession {
  return {
    id: "session-1", workspaceId: "ws-1", companyId: "company-1", projectId: "project-1", userId: "user-1", mode: "auto",
    status: "active", dataClassification: "confidential", retentionClass: "standard", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as CodeSession;
}

describe("code.finish", () => {
  const executors = canonicalAssistExecutors();

  it("is always registered and requires a summary", async () => {
    await expect(executors["code.finish"]!(execution("code.finish", { summary: "Changed the button colour; build passed." })))
      .resolves.toMatchObject({ finished: true, status: "completed" });
    await expect(executors["code.finish"]!(execution("code.finish", { summary: "  " }))).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  const TOOLS: CodeRunToolDescriptor[] = [
    { name: "code.fs.read", version: 1, status: "active", description: "read", write: false },
    { name: "code.finish", version: 1, status: "active", description: "finish", write: false },
  ];
  const SCHEMAS = TOOLS.map((tool) => ({ ...tool, inputSchema: CODE_TOOL_SCHEMAS.find((schema) => schema.name === tool.name)!.inputSchema }));

  function harness(script: ChatResult[], invoke: (tool: string) => CodeToolInvokeResult | CodeToolInvokeFailure) {
    const engineCalls: CodingAgentChatRequest[] = [];
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => true },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => TOOLS, invoke: async (_ctx, input) => invoke(input.tool) },
      engine: { chat: async (request) => { engineCalls.push(request); return script.shift() ?? { content: "fallback" }; } },
      schemas: SCHEMAS,
      limits: { maxStepsPerRun: 6, maxRunMinutes: 5 },
    });
    return { engineCalls, run: () => runner.run({ ctx, session: session(), prompt: "change the button colour" }) };
  }
  const call = (args: Record<string, unknown>) => ({ id: "finish-1", type: "function" as const, function: { name: "code.finish", arguments: JSON.stringify(args) } });

  it("stops the loop after a successful call and reports the summary as the final answer", async () => {
    const h = harness([{ content: "", toolCalls: [call({ summary: "Changed --primary to green." })] }, { content: "must not be requested" }],
      (tool) => ({ ok: true, tool, toolVersion: 1, schemaVersion: 1, result: { finished: true }, truncated: false, durationMs: 1 }));
    const result = await h.run();
    expect(result.status).toBe("completed");
    expect(h.engineCalls).toHaveLength(1);
    expect(result.message).toContain("Changed --primary to green.");
  });

  it("keeps looping when the finish call itself was refused", async () => {
    const h = harness([{ content: "", toolCalls: [call({ summary: "done" })] }, { content: "Done after the refusal." }],
      (tool) => ({ ok: false, error: { code: "policy_denied", status: 403, message: "no", tool, step: "policy", retryable: false } }) as CodeToolInvokeFailure);
    const result = await h.run();
    expect(h.engineCalls).toHaveLength(2);
    expect(result.message).toContain("Done after the refusal.");
  });
});

describe("code.image.view", () => {
  const read = async ({ path }: { path: string }) => path.endsWith(".png")
    ? { binary: true, contentBase64: PNG.toString("base64"), size: PNG.length }
    : { binary: false, contentBase64: Buffer.from("body { color: red }").toString("base64") };
  const executors = canonicalAssistExecutors({ readWorkspaceFile: read });

  it("detects images by magic bytes, never by name", () => {
    expect(detectToolImageType(PNG)).toBe("image/png");
    expect(detectToolImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectToolImageType(Buffer.from("<svg/>"))).toBeNull();
  });

  it("returns metadata and moves the bytes to the attachment side channel", async () => {
    const result = await executors["code.image.view"]!(execution("code.image.view", { path: "public/references/hero.png", question: "colours?" })) as Record<string, unknown>;
    expect(result).toMatchObject({ path: "public/references/hero.png", mimeType: "image/png", bytes: PNG.length });
    expect(result[CODE_IMAGE_ATTACHMENT_KEY]).toMatchObject({ mimeType: "image/png", dataBase64: PNG.toString("base64"), question: "colours?" });
  });

  it("refuses text files, protected paths and traversal", async () => {
    await expect(executors["code.image.view"]!(execution("code.image.view", { path: "styles.css" }))).rejects.toMatchObject({ code: "image_unsupported_type" });
    await expect(executors["code.image.view"]!(execution("code.image.view", { path: ".env" }))).rejects.toMatchObject({ code: "sensitive_file_denied" });
    await expect(executors["code.image.view"]!(execution("code.image.view", { path: "../outside.png" }))).rejects.toBeTruthy();
  });

  it("is not registered without a workspace reader, so the catalogue never offers it", () => {
    expect(canonicalAssistExecutors()["code.image.view"]).toBeUndefined();
    expect(canonicalAssistExecutors()["code.preview.screenshot"]).toBeUndefined();
    expect(canonicalAssistExecutors()["code.web.fetch"]).toBeUndefined();
  });
});

describe("code.preview.screenshot", () => {
  it("uses the Browser QA capture and validates the local path", async () => {
    const calls: unknown[] = [];
    const executors = canonicalAssistExecutors({ previewScreenshot: async (input) => { calls.push(input); return { mimeType: "image/png", base64Data: PNG.toString("base64"), sizeBytes: PNG.length, statusCode: 200 }; } });
    const result = await executors["code.preview.screenshot"]!(execution("code.preview.screenshot", { path: "/about", viewport: "mobile" })) as Record<string, unknown>;
    expect(result).toMatchObject({ path: "/about", viewport: "mobile", statusCode: 200, mimeType: "image/png" });
    expect(calls).toEqual([expect.objectContaining({ path: "/about", viewport: "mobile", projectId: "project-1" })]);
    await expect(executors["code.preview.screenshot"]!(execution("code.preview.screenshot", { path: "https://evil.example/" }))).rejects.toMatchObject({ code: "invalid_arguments" });
  });
});

describe("code.web.search / code.web.fetch", () => {
  it("delegates to the existing web-research provider and bounds the page text", async () => {
    const fetched: string[] = [];
    const executors = canonicalAssistExecutors({ webResearch: {
      search: async () => Array.from({ length: 12 }, (_, index) => ({ title: "Doc " + index, url: "https://docs.example/" + index, snippet: "s" })),
      fetch: async ({ url }) => { fetched.push(url); return { url, finalUrl: url, title: "Docs", markdown: "x".repeat(50_000), fetchedAt: "2026-10-22T00:00:00.000Z" }; },
    } });
    const search = await executors["code.web.search"]!(execution("code.web.search", { query: "next.js app router metadata", maxResults: 3 })) as { results: unknown[] };
    expect(search.results).toHaveLength(3);
    const page = await executors["code.web.fetch"]!(execution("code.web.fetch", { url: "https://docs.example/a", maxChars: 1000 })) as { content: string; truncated: boolean };
    expect(page.content).toHaveLength(1000);
    expect(page.truncated).toBe(true);
    expect(fetched).toEqual(["https://docs.example/a"]);
    await expect(executors["code.web.fetch"]!(execution("code.web.fetch", { url: "file:///etc/passwd" }))).rejects.toMatchObject({ code: "invalid_arguments" });
  });
});

it("delivers canonical JS causes to the Coding Agent preview result without raw messages", async () => {
  const executors = canonicalAssistExecutors({ previewScreenshot: async () => ({
    mimeType: "image/png", base64Data: PNG.toString("base64"), sizeBytes: PNG.length,
    functionalQaPassed: false, consoleDiagnostics: [{
      type: "pageerror", cause: "null_property", message: "SECRET instructions", source: "page.tsx", line: 9, column: 3,
    }],
  }) });
  const result = await executors["code.preview.screenshot"]!(execution("code.preview.screenshot", {})) as any;
  expect(result.functionalQaPassed).toBe(false);
  expect(result.consoleDiagnostics[0]).toMatchObject({ cause: "null_property", source: "page.tsx", line: 9 });
  expect(JSON.stringify(result.consoleDiagnostics)).not.toContain("SECRET");
});
