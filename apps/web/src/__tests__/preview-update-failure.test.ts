import { expect, it } from "vitest";
import { previewUpdateFailure } from "../preview-update-failure";

// V6-O06-01: a refused Preview update names the missing file in the user's language instead of staying silent.
it("explains a missing resource in Ukrainian and English", () => {
  const message = "Static website references missing resource: img/photo.png (from index.html)";
  expect(previewUpdateFailure(message, true)).toBe("Preview не оновився: index.html посилається на файл img/photo.png, якого немає в проєкті. Показано попередню версію.");
  expect(previewUpdateFailure(message, false)).toContain("index.html links to img/photo.png");
});
it("keeps any other reason", () => {
  expect(previewUpdateFailure("HTTP 502", true)).toBe("Preview не оновився: HTTP 502. Показано попередню версію.");
});
