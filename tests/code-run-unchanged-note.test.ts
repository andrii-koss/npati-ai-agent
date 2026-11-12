import { expect, it } from "vitest";
import { withUnchangedFilesNote } from "../apps/agent-api/src/code-session-run-executor";

const run = (message: string, filesChanged: string[]) => ({ status: "completed", message, summary: { filesChanged } });

// V6 step 05 (CODING_ACCEPTANCE "Невиконання"): an edit run that changed no file must not read as done.
it("adds the evidence when an edit run claims success without changing a file", () => {
  const out = withUnchangedFilesNote(run("Готово, кнопку зроблено зеленою.", []), { responseLanguage: "uk" }) as { message: string };
  expect(out.message).toContain("жоден файл проєкту не змінено");
});

it("leaves a reply alone when it already says nothing changed, when files changed, or for read-only and plan runs", () => {
  expect((withUnchangedFilesNote(run("Нічого не змінював: кнопка вже зелена.", []), { responseLanguage: "uk" }) as { message: string }).message).not.toContain("Примітка системи");
  expect((withUnchangedFilesNote(run("Команду виконано, файли проєкту не змінювалися.", []), {}) as { message: string }).message).not.toContain("System note");
  expect((withUnchangedFilesNote(run("Готово.", ["styles.css"]), {}) as { message: string }).message).toBe("Готово.");
  expect((withUnchangedFilesNote(run("Аналіз готовий.", []), { readOnlyIntent: true }) as { message: string }).message).toBe("Аналіз готовий.");
  expect((withUnchangedFilesNote(run("План готовий.", []), { session: { mode: "plan" } }) as { message: string }).message).toBe("План готовий.");
  expect((withUnchangedFilesNote({ status: "failed", message: "Не вдалося.", summary: { filesChanged: [] } }, {}) as { message: string }).message).toBe("Не вдалося.");
});

// V6-D06-01: after an automatic repair the user still sees what was built, then what the repair fixed.
it("keeps the root reply first when an automatic repair answers", async () => {
  const { withRootReply } = await import("../apps/agent-api/src/code-session-run-executor");
  const root = "Створено застосунок Todo: додавання, редагування, видалення, localStorage.";
  const repaired = { status: "completed", message: "Замінив crypto.randomUUID() на createId()." };
  const out = withRootReply(repaired, root, "uk") as { message: string; status: string };
  expect(out.status).toBe("completed");
  expect(out.message.startsWith(root)).toBe(true);
  expect(out.message).toContain("Автоматична перевірка знайшла помилку і виправила її:\nЗамінив crypto.randomUUID()");
  expect(withRootReply(out, root, "uk")).toBe(out);
  expect((withRootReply({ status: "failed", message: "" }, root, "uk") as { message: string }).message).toBe(root);
  expect(withRootReply(repaired, undefined, "uk")).toBe(repaired);
});

it("puts a failed repair's notice after the root reply without claiming a fix", async () => {
  const { withRootReply } = await import("../apps/agent-api/src/code-session-run-executor");
  const out = withRootReply({ status: "failed", message: "Проєкт зібрався, але під час відкриття в браузері є помилки…" }, "Створено сайт.", "uk") as { message: string };
  expect(out.message).toBe("Створено сайт.\n\nПроєкт зібрався, але під час відкриття в браузері є помилки…");
});
