import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp, isSpreadsheetEditRequest } from "../apps/agent-api/src/app";
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

  it.each([
    ["en", "Add a new Status column to the spreadsheet and fill it"],
    ["uk", "Додай новий стовпець Статус до таблиці та заповни його"],
    ["fr", "Ajoute une colonne Statut au tableau et remplis-la"],
    ["de", "Eine Spalte Status zur Tabelle hinzufügen und ausfüllen"],
    ["es", "Agrega una columna Estado a la tabla y rellénala"],
    ["it", "Aggiungi una colonna Stato alla tabella e compilala"],
    ["pl", "Dodaj kolumnę Status do arkusza i wypełnij ją"],
    ["pt", "Adicione uma coluna Status à planilha e preencha-a"],
    ["nl", "Voeg een kolom Status toe aan het werkblad en vul deze in"],
    ["tr", "Tabloya Durum sütunu ekle ve doldur"],
    ["ru", "Добавь новый столбец Статус в таблицу и заполни его"],
    ["zh", "在电子表格中添加状态列并填写"],
    ["ja", "スプレッドシートにステータス列を追加して入力してください"],
    ["ko", "스프레드시트에 상태 열을 추가하고 입력하세요"],
    ["ar", "أضف عمود الحالة إلى الجدول واملأه"],
    ["hi", "स्प्रेडशीट में स्थिति कॉलम जोड़ें और भरें"],
  ])("recognizes spreadsheet editing in %s", (_language, message) => {
    expect(isSpreadsheetEditRequest(message)).toBe(true);
  });
});
