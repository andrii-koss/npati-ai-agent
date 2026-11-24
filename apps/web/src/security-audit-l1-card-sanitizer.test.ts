// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeCardHtml } from "./ChatMessageContent";

/** Security audit 2026-11-24, L1: children of an unwrapped element were never checked. */
describe("L1: sanitizeCardHtml checks every element", () => {
  it.each([
    "<x-a><img src=x onerror=alert(1)></x-a>",
    "<font><svg onload=alert(2)></svg><b-x><img src=y onerror=alert(3)></b-x></font>",
    "<section><article><div onclick=alert(4)><x-y><iframe src=javascript:alert(5)></iframe></x-y></div></article></section>",
    "<custom><a href=javascript:alert(6)>x</a></custom>",
  ])("neutralises %s", (payload) => {
    const output = sanitizeCardHtml(payload);
    expect(output).not.toMatch(/<(img|svg|iframe|script)\b/i);
    expect(output).not.toMatch(/\son\w+=/i);
    expect(output).not.toContain("javascript:");
  });

  it("keeps the card vocabulary", () => {
    expect(sanitizeCardHtml('<p><strong>a</strong> <a href="https://example.com">b</a></p>'))
      .toBe('<p><strong>a</strong> <a href="https://example.com" rel="noopener noreferrer">b</a></p>');
  });
});
