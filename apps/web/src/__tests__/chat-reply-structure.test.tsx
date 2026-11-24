import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ChatMessageContent } from "../ChatMessageContent";

// The final reply of a coding run is Markdown: a bold result line, short sections with bullets, file names in
// backticks and a closing note. The chat showed the raw "- ", "> " and backticks as one block of text.
it("renders a structured agent reply as headings, lists, a note and inline code", () => {
  const reply = [
    "**Сайт кав'ярні готовий.**",
    "",
    "### Що зроблено",
    "- Меню в `app.js`",
    "- Форма бронювання",
    "",
    "1. Відкрийте Preview",
    "2. Додайте товар",
    "",
    "> **Припущення:** назви є прикладами.",
  ].join("\n");
  const html = renderToStaticMarkup(<ChatMessageContent content={reply} />);
  expect(html).toContain("<strong>Сайт кав&#x27;ярні готовий.</strong>");
  expect(html).toContain("<h3>Що зроблено</h3>");
  expect(html).toContain('<ul class="chat-message-list"><li>Меню в <code class="chat-inline-code">app.js</code></li><li>Форма бронювання</li></ul>');
  expect(html).toContain('<ol class="chat-message-list"><li>Відкрийте Preview</li><li>Додайте товар</li></ol>');
  expect(html).toContain('<div class="chat-message-note"><div><strong>Припущення:</strong> назви є прикладами.</div></div>');
  expect(html).not.toMatch(/>- |&gt; |`/);
});

it("keeps bold text at the start of a line out of list detection", () => {
  const html = renderToStaticMarkup(<ChatMessageContent content={"**Готово** без списку"} />);
  expect(html).not.toContain("<ul");
});
