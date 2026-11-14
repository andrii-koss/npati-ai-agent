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
