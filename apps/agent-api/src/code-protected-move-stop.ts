import type { CodeToolInvokeFailure, CodeToolInvokeResult } from "./code-tool-runtime";

/** A content-preserving move cannot repair a protection refusal by rewriting or relocating its data. */
export function protectedMoveStopMessage(tool: string, result: CodeToolInvokeResult | CodeToolInvokeFailure, language?: string, prompt = "", requireImplementation = false): string | null {
  if (tool !== "code.fs.move" || result.ok || result.error.code !== "secret_content") return null;
  // Internal creation work can repair its own newly introduced data; a user's rename request cannot.
  if (requireImplementation || !/^(?:please\s+|будь\s+ласка,?\s+)?(?:rename|move|перейменуй|перемісти|переименуй|перемести)\s/iu.test(prompt.trim())) return null;
  if (language === "uk") return "Переміщення не виконано: захист вмісту відхилив операцію (secret_content, 403). Оригінальний файл збережено. Запуск зупинено; наступні операції після відмови не виконувалися. Схвалення користувача не може скасувати цей захист; переносити той самий вміст іншим інструментом або поза робочим процесом не можна.";
  if (language === "ru") return "Перемещение не выполнено: защита содержимого отклонила операцию (secret_content, 403). Исходный файл сохранён. Выполнение остановлено; следующие операции не выполнялись. Подтверждение пользователя не отменяет защиту; переносить то же содержимое другим инструментом или вне рабочего процесса нельзя.";
  return "The move was refused by content protection (secret_content, 403). The original file is preserved. The run stopped; subsequent operations were not executed. User approval cannot override this protection. Do not transfer the same content using another tool or outside this workflow.";
}
