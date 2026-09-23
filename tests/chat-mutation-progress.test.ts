import { describe, expect, it } from "vitest";
import { detectChatMutationOperation, mutationProgressTargets } from "../apps/web/src/chat-mutation-progress";
import { progressModel, type ChatProgressEvent } from "../apps/web/src/ResearchProgress";

const paths = (message: string, context: "none" | "business" | "company" = "none") =>
  mutationProgressTargets(message, context).map((target) => new URL(target.url).pathname);

describe("chat mutation progress", () => {
  it("shows every affected settings page in the order stated by the user", () => {
    const message = "Створи бізнес-ідею, ціль і компанію з 5 агентами";
    expect(detectChatMutationOperation(message, "none")).toBe("create");
    expect(paths(message)).toEqual(["/settings/business", "/settings/goals", "/settings/company"]);
  });

  it("shows the Goals page for a goal-only request even when a company is selected", () => {
    const message = "Створи мені ціль для тестового бізнесу";
    expect(detectChatMutationOperation(message, "company")).toBe("create");
    expect(paths(message, "company")).toEqual(["/settings/goals"]);
  });

  it("keeps multiple workspace pages in request order", () => {
    const message = "Create automations, content, and memory for the company";
    expect(paths(message)).toEqual(["/settings/automations", "/settings/content", "/settings/memory", "/settings/company"]);
  });

  it("recognizes the Ukrainian transliteration меморі as Business Memory", () => {
    const message = "створи ще одну компанію, ціль, бізнес ідею, і меморі, для теста";
    expect(detectChatMutationOperation(message, "none")).toBe("create");
    expect(paths(message)).toEqual(["/settings/company", "/settings/goals", "/settings/business", "/settings/memory"]);
  });

  it.each([
    ["English", "Create memory"],
    ["Ukrainian", "Створи меморі"],
    ["French", "Créer une mémoire"],
    ["German", "Gedächtnis erstellen"],
    ["Spanish", "Crear memoria"],
    ["Italian", "Creare memoria"],
    ["Polish", "Utwórz pamięć"],
    ["Portuguese", "Criar memória"],
    ["Dutch", "Geheugen maken"],
    ["Turkish", "Hafıza oluştur"],
    ["Russian", "Создай память"],
    ["Chinese", "创建记忆"],
    ["Japanese", "メモリを作成"],
    ["Korean", "메모리 생성"],
    ["Arabic", "إنشاء الذاكرة"],
    ["Hindi", "मेमोरी बनाएँ"],
  ])("recognizes Business Memory in %s", (_language, message) => {
    expect(paths(message)).toEqual(["/settings/memory"]);
  });

  it("retains every completed action while the next settings page is active", () => {
    const timestamp = new Date().toISOString();
    const events: ChatProgressEvent[] = [
      { type: "action_started", timestamp, url: "https://ai.npati.com/settings/business", domain: "ai.npati.com", title: "Business settings" },
      { type: "action_started", timestamp, url: "https://ai.npati.com/settings/goals", domain: "ai.npati.com", title: "Business goals" },
      { type: "action_started", timestamp, url: "https://ai.npati.com/settings/company", domain: "ai.npati.com", title: "Company settings" },
      { type: "action_completed", timestamp, url: "https://ai.npati.com/settings/company", domain: "ai.npati.com", title: "Company settings" },
    ];
    expect(progressModel(events).actions.map((action) => ({ path: new URL(action.url).pathname, status: action.status }))).toEqual([
      { path: "/settings/business", status: "completed" },
      { path: "/settings/goals", status: "completed" },
      { path: "/settings/company", status: "completed" },
    ]);
  });

  it("detects creation requests in all 16 supported languages", () => {
    const messages = [
      "Create a business idea, goal, and company",
      "Створи бізнес-ідею, ціль і компанію",
      "Crée une idée d’entreprise, un objectif et une entreprise",
      "Erstelle eine Geschäftsidee, ein Ziel und ein Unternehmen",
      "Crea una idea de negocio, un objetivo y una empresa",
      "Crea un’idea imprenditoriale, un obiettivo e un’azienda",
      "Utwórz pomysł na biznes, cel i firmę",
      "Crie uma ideia de negócio, uma meta e uma empresa",
      "Maak een businessidee, een doel en een bedrijf",
      "Bir iş fikri, hedef ve şirket oluştur",
      "Создай бизнес-идею, цель и компанию",
      "创建商业想法、目标和公司",
      "ビジネスアイデア、目標、会社を作成",
      "비즈니스 아이디어, 목표, 회사를 생성",
      "أنشئ فكرة عمل وهدفًا وشركة",
      "व्यवसाय विचार, लक्ष्य और कंपनी बनाएँ",
    ];
    for (const message of messages) {
      expect(detectChatMutationOperation(message, "none"), message).toBe("create");
      expect(paths(message), message).toEqual(["/settings/business", "/settings/goals", "/settings/company"]);
    }
  });
});
