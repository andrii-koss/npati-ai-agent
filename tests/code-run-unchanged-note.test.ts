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
