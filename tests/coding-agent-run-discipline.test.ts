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
