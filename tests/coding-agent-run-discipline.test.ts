import { describe, expect, it, vi } from "vitest";
import { chatWithTransientRetry, isTransientProviderFailure, withTransientModelRetry } from "../apps/agent-api/src/coding-agent-provider-retry";
import { decideSelfReview } from "../apps/agent-api/src/code-self-review-risk";
import { buildSystemPrompt, CODE_RUN_DISCIPLINE_RULES, systemPromptStablePrefix } from "../apps/agent-api/src/coding-agent-runner-prompt";

describe("a transient provider failure is retried, nothing else is (audit F-11)", () => {
  it("recognises transient failures and never retries a cancelled request or a client error", () => {
    expect(isTransientProviderFailure({ httpStatus: 503 })).toBe(true);
    expect(isTransientProviderFailure({ httpStatus: 429 })).toBe(true);
    expect(isTransientProviderFailure({ code: "provider_timeout" })).toBe(true);
    expect(isTransientProviderFailure({ httpStatus: 400 })).toBe(false);
    const aborted = new AbortController(); aborted.abort();
    expect(isTransientProviderFailure({ httpStatus: 503 }, aborted.signal)).toBe(false);
  });

  it("keeps retrying with pauses and surfaces the failure only after the last attempt", async () => {
    const delaysMs = [1, 1, 1];
    const recovers = vi.fn().mockRejectedValueOnce(Object.assign(new Error("down"), { httpStatus: 502 })).mockRejectedValueOnce(Object.assign(new Error("down"), { httpStatus: 503 })).mockResolvedValueOnce("answer");
    await expect(chatWithTransientRetry(recovers, {}, { delaysMs })).resolves.toBe("answer");
    expect(recovers).toHaveBeenCalledTimes(3);
    const failing = vi.fn().mockRejectedValue(Object.assign(new Error("down"), { httpStatus: 502 }));
    await expect(chatWithTransientRetry(failing, {}, { delaysMs })).rejects.toThrow("down");
    expect(failing).toHaveBeenCalledTimes(4);
    const bad = vi.fn().mockRejectedValue(Object.assign(new Error("bad request"), { httpStatus: 400 }));
    await expect(chatWithTransientRetry(bad, {}, { delaysMs })).rejects.toThrow("bad request");
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it.each([
    "OmniRoute stream failed with HTTP 503: [deepseek/deepseek-flash] [503]: Service is too busy",
    "OmniRoute stream failed with HTTP 500: stream content stall: no model output within 800",
    "provider_stream_idle_timeout: no model output for 90 s",
  ])("treats a failed stream as transient: %s", (message) => {
    expect(isTransientProviderFailure(new Error(message))).toBe(true);
  });

  it("does not retry a request the provider refused", () => {
    expect(isTransientProviderFailure(new Error("provider_stream_error: OmniRoute stream failed with HTTP 400: reasoning_content must be passed back"))).toBe(false);
    expect(isTransientProviderFailure(new Error("provider_stream_error: OmniRoute stream failed with HTTP 429: slow down"))).toBe(true);
  });

  it("stops waiting as soon as the run is cancelled", async () => {
    const controller = new AbortController();
    const failing = vi.fn().mockRejectedValue(Object.assign(new Error("down"), { httpStatus: 503 }));
    const pending = chatWithTransientRetry(failing, { signal: controller.signal }, { delaysMs: [60_000] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toThrow("down");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("wraps only chat on the engine port and keeps its other methods", async () => {
    const engine = { chat: vi.fn().mockResolvedValue({ content: "ok" }), supportsNativeTools: async () => true };
    const wrapped = withTransientModelRetry(engine);
    await expect(wrapped.chat({ messages: [] } as never)).resolves.toEqual({ content: "ok" });
    await expect(wrapped.supportsNativeTools()).resolves.toBe(true);
  });
});

describe("no extra self-review for a style change the preview verifies", () => {
  const css = [{ path: "app/globals.css", diff: "-a\n+b" }];
  it("skips only presentation-only changes", () => {
    expect(decideSelfReview({ changedFiles: css, verificationStatus: "not_run", hadRepair: false }).decision).toBe("run");
    expect(decideSelfReview({ changedFiles: css, verificationStatus: "not_run", hadRepair: false, previewVerifies: true }).decision).toBe("skip");
    expect(decideSelfReview({ changedFiles: [{ path: "app/page.tsx", diff: "x" }], verificationStatus: "not_run", hadRepair: false, previewVerifies: true }).decision).toBe("run");
    expect(decideSelfReview({ changedFiles: css, verificationStatus: "failed", hadRepair: true, previewVerifies: true }).decision).toBe("run");
  });
});

describe("system prompt carries the working rules in its stable prefix", () => {
  it("states the rules before the data boundary so they are cacheable", () => {
    const prompt = buildSystemPrompt({
      session: { mode: "auto_edit" } as never, tools: [], limits: { maxStepsPerRun: 24, maxRunMinutes: 12 },
      environment: { os: "linux", cwd: "/w", date: "2026-10-22" },
    });
    const prefix = systemPromptStablePrefix(prompt);
    for (const rule of CODE_RUN_DISCIPLINE_RULES) expect(prefix).toContain(rule);
    expect(prefix).toContain("changes no files and creates nothing");
  });
});

describe("a repeated screenshot without a change is answered from run state", () => {
  it("captures again only after a file was written", async () => {
    const { CodingAgentRunner } = await import("../apps/agent-api/src/coding-agent-runner");
    const { CODE_TOOL_SCHEMAS } = await import("../apps/agent-api/src/code-tool-registry");
    const names = ["code.preview.screenshot", "code.fs.edit", "code.fs.read"];
    const tools = names.map((name) => ({ name, version: 1, status: "active", description: name, write: name === "code.fs.edit" }));
    const shot = (id: string) => ({ id, type: "function" as const, function: { name: "code.preview.screenshot", arguments: JSON.stringify({ path: "/" }) } });
    const script = [
      { content: "", toolCalls: [shot("s1")] },
      { content: "", toolCalls: [shot("s2")] },
      { content: "", toolCalls: [{ id: "e1", type: "function" as const, function: { name: "code.fs.edit", arguments: JSON.stringify({ path: "a.css", old_string: "a", new_string: "b" }) } }] },
      { content: "", toolCalls: [shot("s3")] },
      { content: "done" },
    ];
    const invoked: string[] = [];
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => tools, invoke: async (_ctx, input) => { invoked.push(`${input.tool}:${input.toolCallId}`); return { ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: { data: {} }, truncated: false, durationMs: 1 }; } },
      engine: { chat: async () => script.shift() ?? { content: "done" } },
      schemas: tools.map((tool) => ({ ...tool, inputSchema: CODE_TOOL_SCHEMAS.find((schema) => schema.name === tool.name)!.inputSchema })),
      limits: { maxStepsPerRun: 10, maxRunMinutes: 5 },
    });
    await runner.run({ ctx: { userId: "u", workspaceId: "w", permissions: ["workspace:write"] }, session: { id: "s", workspaceId: "w", companyId: "c", projectId: "p", userId: "u", mode: "auto", status: "active", dataClassification: "confidential", retentionClass: "standard", revision: 1, createdAt: "", updatedAt: "" } as never, prompt: "make the hero darker", websiteEdit: true, images: [{ mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }], toolContext: { userMessage: "make the hero darker" } });
    expect(invoked.filter((entry) => entry.startsWith("code.preview.screenshot"))).toEqual(["code.preview.screenshot:s1", "code.preview.screenshot:s3"]);
    expect(invoked).toContain("code.fs.edit:e1");
  });
});

describe("a Data Studio write is progress for the loop guard", () => {
  it("a database task that keeps inspecting after creating tables is not stopped as a loop", async () => {
    const { CodingAgentRunner } = await import("../apps/agent-api/src/coding-agent-runner");
    const { CODE_TOOL_SCHEMAS } = await import("../apps/agent-api/src/code-tool-registry");
    const names = ["code.data.schema.inspect", "code.data.backend.create", "code.fs.read"];
    const tools = names.map((name) => ({ name, version: 1, status: "active", description: name, write: name === "code.data.backend.create" }));
    const inspect = (id: string) => ({ content: "", toolCalls: [{ id, type: "function" as const, function: { name: "code.fs.read", arguments: JSON.stringify({ path: "lib/" + id + ".ts" }) } }] });
    const create = { content: "", toolCalls: [{ id: "create", type: "function" as const, function: { name: "code.data.backend.create", arguments: JSON.stringify({ name: "Shop DB", reason: "The user asked for a database." }) } }] };
    const script = [...[1, 2, 3, 4, 5, 6].map((n) => inspect("a" + n)), create, ...[1, 2, 3, 4, 5, 6].map((n) => inspect("b" + n)), { content: "done" }];
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => tools, invoke: async (_ctx, input) => ({ ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: { data: {} }, truncated: false, durationMs: 1 }) },
      engine: { chat: async () => script.shift() ?? { content: "done" } },
      schemas: tools.map((tool) => ({ ...tool, inputSchema: CODE_TOOL_SCHEMAS.find((schema) => schema.name === tool.name)!.inputSchema })),
      limits: { maxStepsPerRun: 30, maxRunMinutes: 5 },
    });
    const outcome = await runner.run({ ctx: { userId: "u", workspaceId: "w", permissions: ["workspace:write"] }, session: { id: "s", workspaceId: "w", companyId: "c", projectId: "p", userId: "u", mode: "auto", status: "active", dataClassification: "confidential", retentionClass: "standard", revision: 1, createdAt: "", updatedAt: "" } as never, prompt: "Create a database with products", websiteEdit: true, toolContext: { userMessage: "Create a database with products", dataBackendAttached: true } }) as { status: string; reason?: string };
    expect(outcome.reason).not.toBe("loop_detected");
  });
});

describe("a full build without source changes only when it is asked for", () => {
  it("forces the build for creation and explicit build/preview requests only", async () => {
    const { forcesBuild } = await import("../apps/agent-api/src/code-session-run-executor");
    expect(forcesBuild({ requireImplementation: true, prompt: "Створи магазин" })).toBe(true);
    expect(forcesBuild({ prompt: "Створи сучасний інтернет-магазин на Next.js. Запусти Live Preview." })).toBe(true);
    expect(forcesBuild({ prompt: "Rebuild the site and check it" })).toBe(true);
    expect(forcesBuild({ prompt: "Створи для мого інтернет-магазину базу даних із таблицями products, categories та orders." })).toBe(false);
    expect(forcesBuild({ prompt: "Зміни колір кнопки на зелений" })).toBe(false);
    expect(forcesBuild({ prompt: "x", toolContext: { userMessage: "Перезапусти превʼю" } })).toBe(true);
  });
});

describe("an approval wait actually waits for the human decision", () => {
  it("polls until approved, and returns pending only after the timeout", async () => {
    const { waitForApprovalDecision } = await import("../apps/agent-api/src/code-approval-scope");
    let clock = 0; const sleep = async (ms: number) => { clock += ms; };
    const statuses = ["pending", "pending", "approved"];
    const read = vi.fn(async () => ({ status: statuses.shift() ?? "approved" }));
    await expect(waitForApprovalDecision(read, 60_000, { sleep, now: () => clock })).resolves.toEqual({ status: "approved" });
    expect(read).toHaveBeenCalledTimes(3);
    clock = 0;
    const never = vi.fn(async () => ({ status: "pending" }));
    await expect(waitForApprovalDecision(never, 5_000, { sleep, now: () => clock, intervalMs: 1_000 })).resolves.toEqual({ status: "pending" });
    expect(clock).toBeGreaterThanOrEqual(5_000);
    expect(never.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});

describe("creating several tables in a row is not a tool-call cycle", () => {
  it("lets a run apply schema operations for different collections", async () => {
    const { CodingAgentRunner } = await import("../apps/agent-api/src/coding-agent-runner");
    const { CODE_TOOL_SCHEMAS } = await import("../apps/agent-api/src/code-tool-registry");
    const names = ["code.data.schema.inspect", "code.data.schema.apply", "code.fs.read"];
    const tools = names.map((name) => ({ name, version: 1, status: "active", description: name, write: name === "code.data.schema.apply" }));
    const apply = (collection: string) => ({ content: "", toolCalls: [{ id: collection, type: "function" as const, function: { name: "code.data.schema.apply", arguments: JSON.stringify({ expectedFingerprint: "f", operation: { kind: "create_collection", collection, fields: [{ name: "name", type: "string" }] } }) } }] });
    const script = ["categories", "products", "orders", "reviews", "carts", "wishlists", "coupons"].map(apply).concat([{ content: "done" } as never]);
    const runner = new CodingAgentRunner({
      flags: { assertEnabled: async () => true }, rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: { listTools: () => tools, invoke: async (_ctx, input) => ({ ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: { data: {} }, truncated: false, durationMs: 1 }) },
      engine: { chat: async () => script.shift() ?? { content: "done" } },
      schemas: tools.map((tool) => ({ ...tool, inputSchema: CODE_TOOL_SCHEMAS.find((schema) => schema.name === tool.name)!.inputSchema })),
      limits: { maxStepsPerRun: 30, maxRunMinutes: 5 },
    });
    const outcome = await runner.run({ ctx: { userId: "u", workspaceId: "w", permissions: ["workspace:write"] }, session: { id: "s", workspaceId: "w", companyId: "c", projectId: "p", userId: "u", mode: "auto", status: "active", dataClassification: "confidential", retentionClass: "standard", revision: 1, createdAt: "", updatedAt: "" } as never, prompt: "Create the store database", websiteEdit: true, toolContext: { userMessage: "Create the store database", dataBackendAttached: true } }) as { reason?: string; message?: string };
    expect(outcome.reason, outcome.message).not.toBe("loop_detected");
  });
});

it("cancels a pending approval wait promptly and never returns an allow after Stop", async () => {
 const { waitForApprovalDecision } = await import("../apps/agent-api/src/code-approval-scope");
 const controller = new AbortController();
 const read = vi.fn(async () => ({ status: "pending" }));
 const waiting = waitForApprovalDecision(read, 30 * 60_000, { signal: controller.signal, intervalMs: 1000 });
 controller.abort(new Error("Stopped by user"));
 await expect(waiting).rejects.toThrow("Stopped by user");
 expect(read).toHaveBeenCalledOnce();
});
