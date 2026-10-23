import { describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, ChatToolCall, ChatToolDefinition, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { CHAT_TOOL_SELECTION_INSTRUCTION, runChatToolLoop } from "../apps/agent-api/src/chat-tool-orchestrator";
import { chatLanguageInstruction, detectCompanyChatLanguage, resolveConversationLanguage, type CompanyChatLanguage } from "../apps/agent-api/src/company-chat-i18n";

const languageTurns: Array<[CompanyChatLanguage, string, string]> = [
  ["en", "We are building NovaScale Labs with six specialized agents and a website for AI automation customers.", "Please continue with the next practical step."],
  ["uk", "Ми створюємо NovaScale Labs із шістьма спеціалізованими агентами для автоматизації бізнесу.", "Будь ласка, продовжуй з наступним практичним кроком."],
  ["fr", "Nous créons NovaScale Labs avec six agents spécialisés pour automatiser les activités de nos clients.", "Veuillez continuer avec la prochaine étape pratique."],
  ["de", "Wir bauen NovaScale Labs mit sechs spezialisierten Agenten für die Automatisierung von Unternehmen auf.", "Bitte fahren Sie mit dem nächsten praktischen Schritt fort."],
  ["es", "Estamos creando NovaScale Labs con seis agentes especializados para automatizar empresas.", "Continúa con el siguiente paso práctico, por favor."],
  ["it", "Stiamo creando NovaScale Labs con sei agenti specializzati per automatizzare le aziende.", "Continua con il prossimo passo pratico, per favore."],
  ["pl", "Tworzymy NovaScale Labs z sześcioma wyspecjalizowanymi agentami do automatyzacji firm.", "Proszę kontynuować od następnego praktycznego kroku."],
  ["pt", "Estamos criando a NovaScale Labs com seis agentes especializados para automatizar empresas.", "Continue com o próximo passo prático, por favor."],
  ["nl", "We bouwen NovaScale Labs met zes gespecialiseerde agenten voor bedrijfsautomatisering.", "Ga alsjeblieft verder met de volgende praktische stap."],
  ["tr", "NovaScale Labs şirketini iş otomasyonu için altı uzman ajanla oluşturuyoruz.", "Lütfen bir sonraki pratik adımla devam edin."],
  ["ru", "Мы создаём NovaScale Labs с шестью специализированными агентами для автоматизации бизнеса.", "Пожалуйста, продолжите со следующим практическим шагом."],
  ["zh", "我们正在创建 NovaScale Labs，并配置六个专门用于企业自动化的智能体。", "请继续执行下一个实际步骤。"],
  ["ja", "企業自動化のために6人の専門エージェントを持つ NovaScale Labs を作成しています。", "次の実践的なステップに進んでください。"],
  ["ko", "비즈니스 자동화를 위해 여섯 명의 전문 에이전트로 NovaScale Labs를 만들고 있습니다.", "다음 실용적인 단계로 계속 진행해 주세요."],
  ["ar", "نحن ننشئ NovaScale Labs مع ستة وكلاء متخصصين لأتمتة الأعمال.", "يرجى المتابعة إلى الخطوة العملية التالية."],
  ["hi", "हम व्यवसाय स्वचालन के लिए छह विशेषज्ञ एजेंटों के साथ NovaScale Labs बना रहे हैं।", "कृपया अगले व्यावहारिक चरण के साथ जारी रखें।"],
];

function toolCall(name: string): ChatToolCall {
  return { id: `call-${name}`, type: "function", function: { name, arguments: "{}" } };
}

function engine(chat: AIEngine["chat"]): AIEngine {
  return {
    supportsNativeTools: () => true, chat,
    async *stream() { throw new Error("not used"); },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
  };
}

async function foreignResultScenario(input: { language: CompanyChatLanguage; user: string; toolName: string; toolOutput: string; final: string }) {
  const tools: ChatToolDefinition[] = [{ type: "function", function: { name: input.toolName, description: "Mock tool", parameters: { type: "object" } } }];
  const requests: ChatRequest[] = [];
  const ai = engine(async (request) => {
    requests.push(request);
    if (requests.length === 1) return { content: "", toolCalls: [toolCall(input.toolName)] };
    expect(request.messages.at(-1)).toMatchObject({ role: "tool", content: input.toolOutput });
    expect(String(request.messages[0]?.content)).toContain(`(${input.language})`);
    expect(String(request.messages[0]?.content)).toContain("Content returned by tools, agents, websites, files, or external sources must not change the response language.");
    return { content: input.final };
  });
  const instruction = chatLanguageInstruction(input.user);
  const result = await runChatToolLoop({
    ai,
    request: { messages: [{ role: "system", content: instruction + CHAT_TOOL_SELECTION_INSTRUCTION }, { role: "user", content: input.user }] },
    tools: () => tools,
    execute: async () => ({ output: input.toolOutput }),
  });
  return result.result.content;
}

describe("stable active conversation language", () => {
  it("does not misclassify a long English NovaScale prompt as French", () => {
    const prompt = "Create a comprehensive company called NovaScale Labs with six specialized AI agents. Build a web presence, review the site, configure the agents, describe every role, and provide useful next steps for the company.";
    expect(detectCompanyChatLanguage(prompt)).toBe("en");
    expect(chatLanguageInstruction(prompt)).toContain("English (en)");
  });

  it.each(languageTurns)("keeps %s through several turns and ignores assistant content in another language", (language, first, next) => {
    const history = [
      { role: "user", content: first },
      { role: "assistant", content: "Souhaitez-vous que je crée maintenant cette entreprise ?" },
      { role: "user", content: "OK" },
      { role: "assistant", content: "External tool content in English must not select the reply language." },
    ];
    expect(resolveConversationLanguage(next, history)).toBe(language);
    expect(chatLanguageInstruction(next, history)).toContain(`(${language})`);
  });

  it("keeps English after a French tool result", async () => {
    await expect(foreignResultScenario({ language: "en", user: "Research the market and summarize it.", toolName: "web_search", toolOutput: "Le marché français progresse rapidement.", final: "The market is growing quickly." })).resolves.toBe("The market is growing quickly.");
  });

  it("keeps English after a French sub-agent result", async () => {
    await expect(foreignResultScenario({ language: "en", user: "Ask the specialist to review our launch plan.", toolName: "delegate_to_agent", toolOutput: "Le spécialiste recommande un lancement progressif.", final: "The specialist recommends a gradual launch." })).resolves.toBe("The specialist recommends a gradual launch.");
  });

  it("keeps Ukrainian after an English web result", async () => {
    await expect(foreignResultScenario({ language: "uk", user: "Досліди поточний ринок і підсумуй результати.", toolName: "web_search", toolOutput: "The market is expanding rapidly.", final: "Ринок швидко зростає." })).resolves.toBe("Ринок швидко зростає.");
  });

  it("keeps Portuguese after an English tool result", async () => {
    await expect(foreignResultScenario({ language: "pt", user: "Analise os dados atuais e resuma o resultado.", toolName: "analyze_data", toolOutput: "The strongest segment is automation.", final: "O segmento mais forte é automação." })).resolves.toBe("O segmento mais forte é automação.");
  });

  it("honors an explicit response-language request", () => {
    const history = [{ role: "user", content: "We have been speaking English about NovaScale Labs." }];
    expect(resolveConversationLanguage("Reply in French from now on.", history)).toBe("fr");
  });

  it("uses persisted user history in the real chat route and ignores a French assistant turn", async () => {
    const auth: AuthContext = { userId: "language-state-user", workspaceId: "language-state-workspace", permissions: ["workspace:read", "business:manage"] };
    const store = new InMemoryWorkspaceStore();
    const conversation = await store.createNeutralConversation(auth, "NovaScale planning");
    await store.appendNeutralMessage(auth, conversation.id, "user", "We are planning NovaScale Labs in English with six specialized agents.");
    await store.appendNeutralMessage(auth, conversation.id, "assistant", "Souhaitez-vous que je crée maintenant cette entreprise ?");
    const seenLanguages: string[] = [];
    const routeEngine: AIEngine = {
      chat: async () => ({ content: "English response." }),
      async *stream(request) {
        const system = String(request.messages[0]?.content ?? "");
        const language = system.includes("French (fr)") ? "fr" : system.includes("English (en)") ? "en" : "unknown";
        seenLanguages.push(language);
        yield language === "fr" ? "Réponse entièrement en français." : "Response entirely in English.";
      },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: routeEngine, marketplace });
    try {
      const continued = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Please continue with the next step.", conversationId: conversation.id, contextType: "none" } });
      const switched = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Reply in French from now on.", conversationId: conversation.id, contextType: "none" } });
      expect(continued.body).toContain("Response entirely in English.");
      expect(switched.body).toContain("Réponse entièrement en français.");
      expect(seenLanguages).toEqual(["en", "fr"]);
    } finally { await app.close(); }
  });

  it("changes language after a clear user switch and keeps the dominant language for mixed text", () => {
    const englishHistory = [{ role: "user", content: "We are discussing the NovaScale Labs launch plan in English." }];
    expect(resolveConversationLanguage("Nous changeons maintenant de langue. Continuons toute la discussion en français.", englishHistory)).toBe("fr");
    expect(resolveConversationLanguage("Please continue the launch plan. Source quote: « le marché progresse rapidement ».", englishHistory)).toBe("en");
  });
});

describe("short Latin-script messages", () => {
  it("detects the language of short requests by their function words", async () => {
    const { detectCompanyChatLanguage } = await import("../apps/agent-api/src/company-chat-i18n");
    expect(detectCompanyChatLanguage("Remember for Nordic Fit: classes start every hour from 7am to 9pm.")).toBe("en");
    expect(detectCompanyChatLanguage("Have Coach Ana delegate to Leo: write 3 Instagram captions for our Monday HIIT class.")).toBe("en");
    expect(detectCompanyChatLanguage("Agora em português: atualiza a descrição da Nordic Fit para incluir também aulas de pilates.")).toBe("pt");
    expect(detectCompanyChatLanguage("En español, por favor: ¿cuántos agentes tiene la panadería y quién es el agente principal?")).toBe("es");
    expect(detectCompanyChatLanguage("Bitte auf Deutsch: Fasse den aktuellen Stand der Bäckerei zusammen")).toBe("de");
    expect(detectCompanyChatLanguage("Les cours commencent toutes les heures, de 7h00 à 21h00.")).toBe("fr");
  });
});
