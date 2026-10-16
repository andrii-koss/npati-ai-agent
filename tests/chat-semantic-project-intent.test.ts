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
  it("finishes cancellation even when the routing provider ignores its signal", async () => {
    const f = fixture(creation), controller = new AbortController();
    f.chat.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = f.resolve(auth, { message: "Build a website", signal: controller.signal });
    await vi.waitFor(() => expect(f.chat).toHaveBeenCalledOnce());
    controller.abort(new Error("cancel ignored provider"));
    await expect(pending).rejects.toThrow("cancel ignored provider");
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it("preserves deterministic onboarding help without a classifier call", async () => {
    const f = fixture(creation);
    expect((await f.resolve(auth, { message: "Поясніть, як працює агент NPATI" })).decision.intent).toBe("CHAT");
    expect(f.chat).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps edits to a current or earlier attached workbook on the document path: %s", async previous => {
    const f = fixture(creation);
    const result = await f.resolve(auth, { message: "Додай новий стовпець та поверни змінений файл",
      ...(previous ? { conversationHistory: [{ role: "user", content: "[[npati-attachment:document:11111111-1111-4111-8111-111111111111:roadmap.xlsx]]" }] }
        : { attachmentNames: ["roadmap.xlsx"] }) });
    expect(result).toMatchObject({ source: "deterministic", decision: { intent: "CHAT" }, targets: [] });
    expect(f.chat).not.toHaveBeenCalled();
  });

  it.each([{ message: "Add a database table", activeProjectId: undefined }, { message: "Add a column", activeProjectId: "project" }])(
    "retains semantic project/data routing despite a spreadsheet when explicitly requested: %j", async input => {
      const f = fixture({ intent: "ADD_DATA_MODEL", confidence: 0.99, targets: [] });
      expect((await f.resolve(auth, { ...input, attachmentNames: ["roadmap.xlsx"] })).decision.intent).toBe("ADD_DATA_MODEL");
      expect(f.chat).toHaveBeenCalledOnce();
    });

  it("does not route an already cancelled request", async () => {
    const f = fixture(creation), controller = new AbortController();
    controller.abort(new Error("cancelled before routing"));
    await expect(f.resolve(auth, { message: "Build a website", signal: controller.signal })).rejects.toThrow("cancelled before routing");
    expect(f.chat).not.toHaveBeenCalled();
  });

  it("propagates cancellation to the provider and never converts it into fallback execution", async () => {
    const f = fixture(creation), controller = new AbortController();
    f.chat.mockImplementationOnce(async request => {
      expect(request.signal).toBeDefined();
      controller.abort(new Error("cancelled during routing"));
      expect(request.signal?.aborted).toBe(true);
      return { content: JSON.stringify(creation) };
    });
    await expect(f.resolve(auth, { message: "Build a website", signal: controller.signal })).rejects.toThrow("cancelled during routing");
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it("handles large Business specifications without an extra routing request", async () => {
    const f = fixture(creation);
    const message = "Create a business profile named Context Studio\n" + "Background data. ".repeat(6250);
    expect((await f.resolve(auth, { message })).decision.intent).toBe("CHAT");
    expect(f.chat).not.toHaveBeenCalled();
  });

  it("redacts credentials and personal data from the routing request and history", async () => {
    const f = fixture(creation);
    await f.resolve(auth, { message: "Build a website. Contact alice@example.com with sk-proj-1234567890abcdef1234567890",
      conversationHistory: [{ role: "user", content: "Contact prior@example.com with sk-proj-abcdef1234567890abcdef1234567890" }] });
    expect(f.chat).toHaveBeenCalledOnce();
    const sent = JSON.stringify(f.chat.mock.calls);
    expect(sent).not.toContain("alice@example.com");
    expect(sent).not.toContain("prior@example.com");
    expect(sent).not.toContain("sk-proj-");
    expect(sent).toContain("[REDACTED");
  });

  it.each([
    "Create a company named NovaScale with five agents",
    "Create a business profile named Context Studio",
    "Now add a goal to this business: Reach 100 customers",
    "Fill Recommended Prompts for the selected company's agents",
    "Delete everything that was just created",
  ])("preserves recognized settings requests without a routing model call: %s", async message => {
    const f = fixture(creation);
    expect(await f.resolve(auth, { message })).toMatchObject({
      source: "deterministic", decision: { intent: "CHAT", isProjectIntent: false }, targets: [],
    });
    expect(f.chat).not.toHaveBeenCalled();
  });

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
