import { describe, expect, it, vi } from "vitest";
import { adaptiveLimit, classifyRunTask, CODE_RUN_TASK_BUDGETS } from "../apps/agent-api/src/code-run-budget";
import { chatWithTransientRetry, isTransientProviderFailure, withTransientModelRetry } from "../apps/agent-api/src/coding-agent-provider-retry";
import { decideSelfReview } from "../apps/agent-api/src/code-self-review-risk";
import { buildSystemPrompt, CODE_RUN_DISCIPLINE_RULES, systemPromptStablePrefix } from "../apps/agent-api/src/coding-agent-runner-prompt";

describe("turn and time budgets follow the task class (audit F-13)", () => {
  it("classifies runs from trusted run input only", () => {
    expect(classifyRunTask({ readOnlyIntent: true, websiteEdit: true })).toBe("analysis");
    expect(classifyRunTask({ sessionMode: "plan" })).toBe("analysis");
    expect(classifyRunTask({ requireImplementation: true, websiteEdit: true })).toBe("creation");
    expect(classifyRunTask({ websiteEdit: true, imageCount: 1 })).toBe("visual_edit");
    expect(classifyRunTask({ websiteEdit: true })).toBe("small_edit");
    expect(classifyRunTask({})).toBe("general");
  });

  it("only ever lowers the configured limit and replaces 'unlimited' for known classes", () => {
    const small = CODE_RUN_TASK_BUDGETS.small_edit.turns;
    expect(adaptiveLimit(0, small, true)).toBe(small);
    expect(adaptiveLimit(40, small, true)).toBe(small);
    expect(adaptiveLimit(10, small, true)).toBe(10);
    expect(adaptiveLimit(0, small, false)).toBe(0);
    expect(CODE_RUN_TASK_BUDGETS.small_edit.turns).toBeLessThan(CODE_RUN_TASK_BUDGETS.creation.turns);
    // A code project of unknown size keeps the operator's limits, including "unlimited".
    expect(adaptiveLimit(60, CODE_RUN_TASK_BUDGETS.general.turns, true)).toBe(60);
    expect(adaptiveLimit(0, CODE_RUN_TASK_BUDGETS.general.turns, true)).toBe(0);
  });
});

describe("a transient provider failure is retried once, nothing else is (audit F-11)", () => {
  it("recognises transient failures and never retries a cancelled request or a client error", () => {
    expect(isTransientProviderFailure({ httpStatus: 503 })).toBe(true);
    expect(isTransientProviderFailure({ httpStatus: 429 })).toBe(true);
    expect(isTransientProviderFailure({ code: "provider_timeout" })).toBe(true);
    expect(isTransientProviderFailure({ httpStatus: 400 })).toBe(false);
    const aborted = new AbortController(); aborted.abort();
    expect(isTransientProviderFailure({ httpStatus: 503 }, aborted.signal)).toBe(false);
  });

  it("retries once and returns the second answer; a second failure surfaces unchanged", async () => {
    const ok = vi.fn().mockRejectedValueOnce(Object.assign(new Error("down"), { httpStatus: 502 })).mockResolvedValueOnce("answer");
    await expect(chatWithTransientRetry(ok, {}, { delayMs: 1 })).resolves.toBe("answer");
    expect(ok).toHaveBeenCalledTimes(2);
    const failing = vi.fn().mockRejectedValue(Object.assign(new Error("down"), { httpStatus: 502 }));
    await expect(chatWithTransientRetry(failing, {}, { delayMs: 1 })).rejects.toThrow("down");
    expect(failing).toHaveBeenCalledTimes(2);
    const bad = vi.fn().mockRejectedValue(Object.assign(new Error("bad request"), { httpStatus: 400 }));
    await expect(chatWithTransientRetry(bad, {}, { delayMs: 1 })).rejects.toThrow("bad request");
    expect(bad).toHaveBeenCalledTimes(1);
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
