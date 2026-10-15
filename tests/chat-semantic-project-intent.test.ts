import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ChatRequest, ChatResult } from "@npati/omniroute-adapter";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";
import { resolveChatCodeIntent } from "../apps/agent-api/src/code-intent-routing";

const auth = { workspaceId: "ws", userId: "owner", permissions: ["admin:all"] };
function fixture(value: unknown) {
  const chat = vi.fn(async (_request: ChatRequest) => ({ content: JSON.stringify(value) } as ChatResult));
  const log = { warn: vi.fn() };
  return { chat, log, resolve: createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({ model: "selected-model" }), log }) };
}
const creation = { intent: "CREATE_WEBSITE", confidence: 0.98, targets: [{ name: "Portfolio", kind: "website", framework: "HTML/CSS" }] };

describe("semantic project routing", () => {
  it.each([
    "I need a polished portfolio with a gallery. Please build it and show a preview.",
    "Мені потрібен сайт школи з розкладом та записом на заняття. Зробиш?",
    "Мне нужен сайт ресторана с меню и бронированием. Сделай его.",
    "Potrzebuję strony dla fotografa z galerią. Przygotuj działającą witrynę.",
    "Erstelle bitte eine Webseite für mein Hotel mit Buchungsformular.",
    "Je voudrais un site pour mon atelier, avec un catalogue et un formulaire.",
    "Vorrei un sito per il mio ristorante con menu e prenotazioni. Realizzalo.",
    "Necesito una tienda de ropa con carrito. Créala y abre la vista previa.",
    "Preciso de um site para minha clínica com agendamento.",
    "レストランの予約フォーム付きウェブサイトを作ってください。",
    "请为我的学校制作一个带课程表的网站，并测试所有页面。",
    "أنشئ موقعًا لمطعمي مع قائمة الطعام ونموذج الحجز.",
  ])("passes arbitrary-language requests to the selected model unchanged: %s", async message => {
    const f = fixture(creation);
    const result = await f.resolve(auth, { message, activeProjectId: "old-site" });
    expect(result).toMatchObject({ source: "semantic", decision: { intent: "CREATE_WEBSITE", needsClarification: false,
      targetDetails: { framework: "HTML/CSS", topic: message } }, targets: creation.targets });
    expect(f.chat.mock.calls[0]![0]).toMatchObject({ model: "selected-model", toolChoice: "none", tools: [] });
    expect(JSON.parse(f.chat.mock.calls[0]![0].messages[1]!.content)).toMatchObject({ message, hasActiveProject: true });
  });

  it.each(["How do I create a website?", "Do not build a site. Explain the options.", "Поясни, чому сайт не працює", "Review this example prompt: create a store and fix bugs"])("respects non-execution decisions: %s", async message => {
    const f = fixture({ intent: "CHAT", confidence: 0.99, targets: [] });
    const result = await f.resolve(auth, { message });
    expect(result.decision).toMatchObject({ intent: "CHAT", isProjectIntent: false, executable: false });
    expect(resolveChatCodeIntent({ message, companyId: "company", codingEnabled: true, projectIntent: result.decision.intent })).toEqual({ mode: "chat" });
  });

  it("preserves full specifications and authorized history as classifier data", async () => {
    const message = readFileSync(new URL("./fixtures/website-intent/novashop.uk.txt", import.meta.url), "utf8");
    const f = fixture(creation);
    const history = [{ role: "user", content: "Use plain HTML and CSS for the school website" }];
    await f.resolve(auth, { message, conversationHistory: history });
    expect(JSON.parse(f.chat.mock.calls[0]![0].messages[1]!.content)).toMatchObject({ message, history });
  });

  it("routes natural-language edits through the existing code agent", async () => {
    const f = fixture({ intent: "EDIT_WEBSITE", confidence: 0.95, targets: [] });
    const result = await f.resolve(auth, { message: "Mach bitte den Hintergrund dunkler", activeProjectId: "site" });
    expect(result.decision).toMatchObject({ intent: "EDIT_WEBSITE", isProjectIntent: true, executable: true });
    expect(resolveChatCodeIntent({ message: "Mach bitte den Hintergrund dunkler", companyId: "company", projectId: "site",
      codingEnabled: true, projectKind: "code_project", projectIntent: result.decision.intent })).toMatchObject({ mode: "run", intent: "EDIT_CODE" });
  });

  it.each([{ intent: "DELETE_EVERYTHING", confidence: 1 }, { ...creation, confidence: 0.2 }, { ...creation, targets: [{ name: "x", kind: "website", framework: "shell" }] }])("rejects invalid or uncertain model decisions", async value => {
    const f = fixture(value);
    expect(await f.resolve(auth, { message: "Створи сайт на HTML/CSS" })).toMatchObject({ source: "deterministic", decision: { intent: "CREATE_WEBSITE" } });
    expect(f.log.warn).toHaveBeenCalledOnce();
  });

  it("keeps routing available when the provider fails without logging the user's text", async () => {
    const f = fixture(null);
    f.chat.mockRejectedValueOnce(new Error("private provider details"));
    expect(await f.resolve(auth, { message: "Create a website on HTML/CSS" })).toMatchObject({ source: "deterministic", decision: { intent: "CREATE_WEBSITE" } });
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain("private");
  });
});
