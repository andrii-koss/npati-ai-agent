import { describe, expect, it, vi } from "vitest";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";

const auth = { userId: "u", workspaceId: "w" } as never;
const target = { name: "Новий сайт", kind: "website", framework: "HTML/CSS", reason: "Простий сайт", criteria: ["Без вимог"] };

function resolver(arguments_: Record<string, unknown> | string) {
  const warn = vi.fn();
  const resolve = createChatProjectIntentResolver({
    engine: { chat: async () => ({ content: typeof arguments_ === "string" ? arguments_ : JSON.stringify(arguments_) }) } as never,
    getAIContext: async () => ({ model: "m" }),
    log: { warn },
  });
  return { resolve, warn };
}
const answer = (intent: string, confidence: number) => ({ intent, confidence, targets: intent.startsWith("CREATE") ? [target] : [], entityRead: null, coreCapability: null, coreMutation: false, assignsWorkToCompanyAgent: false });

describe("router confidence", () => {
  it("keeps the AI plan for a bare creation request the model rates below 0.8", async () => {
    const { resolve, warn } = resolver(answer("CREATE_WEBSITE", 0.62));
    const result = await resolve(auth, { message: "Створи мені сайт" });
    expect(result.source).toBe("semantic");
    expect(result.targets[0]?.technologySelection?.source).toBe("ai_planner");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not lower the bar for a question about creating a site", async () => {
    const { resolve, warn } = resolver(answer("CREATE_WEBSITE", 0.62));
    const result = await resolve(auth, { message: "Що краще для кав'ярні?" });
    expect(result.targets).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "low_confidence" }), expect.any(String));
  });

  it("logs a fixed reason and never the model's text", async () => {
    const { resolve, warn } = resolver("private text that is not JSON");
    await resolve(auth, { message: "Створи мені сайт" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid_json" }), expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });
});
