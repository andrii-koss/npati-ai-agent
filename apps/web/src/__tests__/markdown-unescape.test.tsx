import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { renderInlineMarkdown, unescapeMarkdown } from "../chat-message-sources";

// V6 step 12: "Email account **agent@npati\.test** created" showed the backslash in the chat.
it("renders markdown escapes as the characters they protect", () => {
  expect(unescapeMarkdown("agent@npati\\.test \\*not bold\\* C:\\\\path")).toBe("agent@npati.test *not bold* C:\\path");
  const html = renderToStaticMarkup(<>{renderInlineMarkdown("Email account **agent@npati\\.test** created \\(pending\\)", false, new Map())}</>);
  expect(html).toBe("Email account <strong>agent@npati.test</strong> created (pending)");
});

// V6 step 17: a URL quoted in pasted HTML or written in inline code linked with the quote or backtick in its address.
it("ends a bare URL at a quote or backtick", () => {
  const html = renderToStaticMarkup(<>{renderInlineMarkdown('<script src="https://cdn.example.invalid/p.js"></script> and `https://exfil.example.invalid/`', false, new Map())}</>);
  expect(html).not.toMatch(/%22|%60/);
  expect(html).toContain('href="https://cdn.example.invalid/p.js?utm_source=NPATI_Agent"');
  expect(html).toContain('href="https://exfil.example.invalid/?utm_source=NPATI_Agent"');
});
