import { describe, expect, it } from "vitest";
import { publicChatError } from "../apps/agent-api/src/chat-public-errors";
import { InferenceRouteFailure } from "../apps/agent-api/src/production-resilient-ai-engine";

const failure = (status: number) => new InferenceRouteFailure([{ modelId: "deepseek/deepseek-flash", httpStatus: status }], new Error(`OmniRoute request failed: HTTP ${status}`));

describe("provider failures in chat", () => {
  it("tells a Ukrainian user what happened, in Ukrainian, with advice that fits the status", () => {
    const uk = "Напиши, будь ласка, план на тиждень";
    expect(publicChatError(failure(429), undefined, uk)).toBe("Маршрут AI «deepseek/deepseek-flash» не відповів (HTTP 429). Досягнуто ліміту запитів або квоти провайдера. Спробуйте за хвилину або виберіть іншу модель.");
    expect(publicChatError(failure(401), undefined, uk)).toContain("Провайдер відхилив запит");
    expect(publicChatError(failure(502), undefined, uk)).toContain("Провайдер тимчасово недоступний");
    expect(publicChatError(failure(503), undefined, "Напиши мне план")).toContain("Провайдер временно недоступен");
    expect(publicChatError(failure(429), undefined, "日本語で答えて")).toContain("リクエスト上限");
  });

  it("keeps English for a short Latin message whose language is not clear", () => {
    expect(publicChatError(failure(429), undefined, "Try again")).toContain("The provider rate limit or quota was reached");
    expect(publicChatError(failure(500), undefined, "Hello")).toContain("The provider is temporarily unavailable");
    expect(publicChatError(failure(429), undefined, "Por favor, inténtalo de nuevo más tarde")).toContain("límite de solicitudes");
  });
});
