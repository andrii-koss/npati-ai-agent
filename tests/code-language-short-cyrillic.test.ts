import { describe, expect, it } from "vitest";
import { resolveCodingConversationLanguage } from "../apps/agent-api/src/company-chat-i18n";

describe("the reply language of a short request", () => {
  it("is not English for Cyrillic without tell-tale letters", () => {
    expect(resolveCodingConversationLanguage("сума в кошику неправильна")).not.toBe("en");
  });

  it("stays English for short English", () => {
    expect(resolveCodingConversationLanguage("fix the cart total")).toBe("en");
  });

  it("keeps Ukrainian when the letters show it", () => {
    expect(resolveCodingConversationLanguage("тести червоні, полагодь")).toBe("uk");
  });
});
