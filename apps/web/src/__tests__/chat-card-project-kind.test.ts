import { expect, it } from "vitest";
import { resolveChatProjectType } from "../ChatProjectPreviewCard";

// V6 step 07 (D07-04): a Snake game on plain HTML/CSS was labelled "HTML/CSS Website": the card's own kind is
// code_project, so the label guessed from the framework. The project's kind decides now.
it("labels a card by the project's kind, not by its framework", () => {
  const base = { id: "p", name: "V6TEST_S7_SnakeC", status: "ready", companyId: "c", framework: "HTML/CSS", kind: "code_project" as const };
  expect(resolveChatProjectType({ ...base, projectKind: "game" })).toBe("game");
  expect(resolveChatProjectType({ ...base, projectKind: "website" })).toBe("website");
  // Older cards without the project's kind keep the former guess.
  expect(resolveChatProjectType(base)).toBe("website");
});
