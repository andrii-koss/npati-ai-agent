/**
 * Why a saved file did not reach the running Preview, in the user's language. A static site that links a file that
 * does not exist is refused on purpose (409 preview_resources_missing); the old page keeps running, so the user has to
 * be told instead of seeing it silently (V6-O06-01).
 */
export function previewUpdateFailure(message: string, isUk: boolean): string {
  const missing = /missing resource:\s*(.+?)\s*\(from\s+(.+?)\)/i.exec(message);
  if (missing) return isUk
    ? `Preview не оновився: ${missing[2]} посилається на файл ${missing[1]}, якого немає в проєкті. Показано попередню версію.`
    : `Preview was not updated: ${missing[2]} links to ${missing[1]}, which is not in the project. The previous version is shown.`;
  const reason = message.trim() || (isUk ? "невідома помилка" : "unknown error");
  return isUk ? `Preview не оновився: ${reason}. Показано попередню версію.` : `Preview was not updated: ${reason}. The previous version is shown.`;
}
