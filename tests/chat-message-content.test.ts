import { describe, expect, it } from "vitest";
import { collectSourceTitles, isSourceCitationLine, stripInternalChatActions, toTrackedChatUrl } from "../apps/web/src/ChatMessageContent";

describe("chat source links", () => {
  it("uses the real source-list title for a generic inline citation", () => {
    const content = [
      "Твердження [**Джерело**](https://www.npati.com/services?utm_source=NPATI_Agent)",
      "",
      "### Sources (1)",
      "1. [Local Services & Professional Help Listings in the USA | NPATI](https://www.npati.com/services)",
    ].join("\n");

    expect([...collectSourceTitles(content).values()]).toEqual([
      "Local Services & Professional Help Listings in the USA | NPATI",
    ]);
  });

  it("keeps tracked source destinations safe and explicit", () => {
    expect(toTrackedChatUrl("https://example.com/article")).toBe(
      "https://example.com/article?utm_source=NPATI_Agent",
    );
    expect(toTrackedChatUrl("javascript:alert(1)")).toBe("");
  });

  it("recognizes a titled inline link after the source prefix", () => {
    expect(isSourceCitationLine("Джерело: [**відеоінструкція NPATI**](https://www.npati.com/videos/example)")).toBe(true);
    expect(isSourceCitationLine("Source: [NPATI video](https://www.npati.com/videos/example)")).toBe(true);
    expect(isSourceCitationLine("Перегляньте [відеоінструкцію](https://www.npati.com/videos/example)")).toBe(false);
  });
});

describe("streamed chat actions", () => {
  it("never exposes a partial business deletion directive", () => {
    const prefix = "I deleted the test business idea.\n\n";
    const response = prefix + '```business-action\n{"action":"delete","businessName":"Test"}\n```';
    for (let end = prefix.length + 1; end <= response.length; end++) {
      expect(stripInternalChatActions(response.slice(0, end), true).trim()).toBe(prefix.trim());
    }
    expect(stripInternalChatActions(response + "\nDone.").trim()).toBe(prefix.trim() + "\n\n\nDone.");
  });

  it("keeps ordinary code blocks visible", () => {
    expect(stripInternalChatActions("Example:\n```js\nconsole.log(1)\n```"))
      .toBe("Example:\n```js\nconsole.log(1)\n```");
    expect(stripInternalChatActions("Use `code`")).toBe("Use `code`");
  });
});
