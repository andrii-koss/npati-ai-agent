import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { chatLanguageInstruction } from "../apps/agent-api/src/company-chat-i18n";

const auth: AuthContext = { userId: "language-user", workspaceId: "language-workspace", permissions: ["workspace:read", "business:manage"] };

describe("chat response language", () => {
  it("adds a mandatory Chinese response instruction to general chat and management prompts", async () => {
    let request: ChatRequest | undefined;
    const aiEngine: AIEngine = {
      chat: async (input) => { request = input; return { content: "你好！我可以帮助你。" }; },
      async *stream(input) { request = input; yield "你好！我可以帮助你。"; },
      listModels: async () => [], getModel: async () => undefined,
      executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider: { authenticate: async () => auth }, aiEngine, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "请帮我创建一个商业创意和目标", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      const system = String(request?.messages[0]?.content ?? "");
      expect(system).toContain("MANDATORY RESPONSE LANGUAGE");
      expect(system).toContain("Simplified Chinese (zh)");
      expect(system).toContain("CRITICAL BUSINESS PROFILE & GOAL MANAGEMENT RULES");
      expect(response.body).toContain("你好");
    } finally { await app.close(); }
  });

  it("builds the same-language rule for every supported language", () => {
    expect(chatLanguageInstruction("Crée une entreprise")).toContain("French (fr)");
    expect(chatLanguageInstruction("Erstelle ein Unternehmen")).toContain("German (de)");
    expect(chatLanguageInstruction("Crea una empresa")).toContain("Spanish (es)");
    expect(chatLanguageInstruction("会社を作成してください")).toContain("Japanese (ja)");
    expect(chatLanguageInstruction("أنشئ شركة جديدة")).toContain("Arabic (ar)");
  });
});
