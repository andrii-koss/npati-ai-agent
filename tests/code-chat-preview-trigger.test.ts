import { describe, expect, it } from "vitest";
import { isPreviewableChange } from "../apps/agent-api/src/code-chat-website";

describe("isPreviewableChange", () => {
  it("starts Preview for files a browser shows", () => {
    for (const file of ["index.html", "site/about.htm", "styles.css", "app.js", "src/main.tsx", "img/logo.svg"]) expect(isPreviewableChange(file), file).toBe(true);
  });
  it("does not start Preview for a text file, a manifest or installed modules", () => {
    for (const file of ["e2e-smoke/hello.txt", "package.json", "e2e-smoke/package-lock.json", "README.md", "node_modules/lodash/lodash.js"]) expect(isPreviewableChange(file), file).toBe(false);
  });
});
