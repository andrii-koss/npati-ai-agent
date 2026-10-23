import { describe, expect, it } from "vitest";
import { contextualToolMatches } from "../apps/agent-api/src/code-tool-visibility";

describe("Browser QA tool visibility", () => {
  it("offers the Preview tool for a check of the running website", () => {
    for (const userMessage of [
      "Run Browser QA on the Nordic Fit site and tell me if there are console errors or broken links.",
      "Відкрий Live Preview меню і перевір сам: чи видно відгуки і чи немає помилок у консолі?",
    ]) expect(contextualToolMatches({ userMessage, sessionMode: "auto", websiteEdit: true }).has("code.preview.screenshot"), userMessage).toBe(true);
    expect(contextualToolMatches({ userMessage: "Add a contact form", sessionMode: "auto", websiteEdit: true }).has("code.preview.screenshot")).toBe(false);
    expect(contextualToolMatches({ userMessage: "Run Browser QA", sessionMode: "auto" }).has("code.preview.screenshot")).toBe(false);
  });
});
