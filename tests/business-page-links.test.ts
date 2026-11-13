import { expect, it } from "vitest";
import { scopeBusinessPageLinks } from "../apps/agent-api/src/business-page-links";

// V6 step 11: a goal card's "Open in business goals" opened the user's current Business, not the goal's one.
it("adds the business to Goals and Memory card links only", () => {
  const card = "[Відкрити в цілях бізнесу →](/settings/goals)\n[Пам'ять](/settings/memory)\n[Content](/settings/content)";
  expect(scopeBusinessPageLinks(card, "0c6ae280-4071")).toBe("[Відкрити в цілях бізнесу →](/settings/goals?business=0c6ae280-4071)\n[Пам'ять](/settings/memory?business=0c6ae280-4071)\n[Content](/settings/content)");
  expect(scopeBusinessPageLinks(card, "b", ["goals"])).toContain("(/settings/memory)");
  expect(scopeBusinessPageLinks(card, undefined)).toBe(card);
});
