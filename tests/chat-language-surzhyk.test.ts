import { describe, expect, it } from "vitest";
import { resolveCodingConversationLanguage } from "../apps/agent-api/src/company-chat-i18n";

const ukrainian = [{ role: "user", content: "Створи простий блог про чай, мінімальні стилі, з базою даних" }];

describe("Ukrainian chat with surzhyk", () => {
  it("keeps Ukrainian for a message that reads as both Ukrainian and Russian", () => {
    expect(resolveCodingConversationLanguage("блог: дабав в пости поле автор текст", ukrainian)).toBe("uk");
    expect(resolveCodingConversationLanguage("ой, тегі не тре, прибери", ukrainian)).toBe("uk");
  });

  it("still switches to Russian when the message is clearly Russian", () => {
    expect(resolveCodingConversationLanguage("Добавь в таблицу posts колонку и сделай это быстро", ukrainian)).toBe("ru");
    expect(resolveCodingConversationLanguage("что это за таблица, какой у неё смысл", ukrainian)).toBe("ru");
  });
});
