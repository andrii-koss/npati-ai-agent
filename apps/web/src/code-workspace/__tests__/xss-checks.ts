/**
 * [C9-web] Scanning helpers shared by the two web XSS suites (`xss-hygiene.test.tsx`,
 * `ask-user-and-xss.test.tsx`).
 *
 * Why this file exists. Both suites used to assert on substrings of the rendered HTML, e.g.
 * `expect(markup).not.toContain("onerror=")`. That is not the property the UI has to hold. React escapes a
 * hostile payload into the text node `&lt;img src=x onerror=alert(1)&gt;`, and that text still *contains* the
 * literal `onerror=` — so the assertion failed on correct output, and the cheapest way to make it pass would
 * have been to delete the check. The property is:
 *
 *  - no payload survives as markup — asserting the absence of `"<img"`/`"<script"`/`"<svg"` is sound because
 *    escaping rewrites every `<`, so no escaped payload can contain one of those substrings; and
 *  - no **tag** carries an event-handler attribute — stated structurally here, by scanning tags while
 *    skipping quoted attribute values, because the payload's text legitimately appears inside an attribute
 *    value such as `data-file="&lt;img src=x onerror=alert(1)&gt;"`.
 *
 * `liveHandlerAttributes` still reports a handler when a payload really is injected (the suites keep a
 * positive control for exactly that, so the check cannot quietly become vacuous).
 *
 * This is not a test file: `vitest.web.config.ts` collects `*.test.ts(x)`, and both source scans skip
 * `__tests__` directories. It has no imports, so the helpers can also be exercised from a plain Node probe.
 */

/**
 * Attribute names of every tag in `markup`, in document order.
 *
 * A hand-rolled scan rather than a regex because the two must be distinguished: a real attribute
 * (`<img src=x onerror=…>`) and the same words inside a quoted attribute value
 * (`data-file="&lt;img src=x onerror=…&gt;"`), where they are text. Quoted values are consumed whole, and
 * `=` inside them cannot start an attribute. No HTML parser is available in this repository by design
 * (jsdom is not installed), and this scan only needs to be exact for `react-dom/server` output, which
 * always quotes attribute values and escapes `<`, `>` and `"` inside them.
 */
export function tagAttributeNames(markup: string): string[] {
  const names: string[] = [];
  let cursor = 0;

  while (cursor < markup.length) {
    const open = markup.indexOf("<", cursor);
    if (open === -1) break;

    // Only a start tag has attributes; `</div>`, `<!doctype>` and a stray `<` are skipped.
    const tag = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(markup.slice(open));
    if (!tag) {
      cursor = open + 1;
      continue;
    }

    let index = open + tag[0].length;
    while (index < markup.length) {
      const char = markup[index] ?? "";
      if (char === ">") break;

      if (char === '"' || char === "'") {
        // A quoted value: consume it whole, so its contents are never read as attributes.
        const close = markup.indexOf(char, index + 1);
        index = close === -1 ? markup.length : close + 1;
        continue;
      }

      if (char.trim() === "" || char === "/" || char === "=") {
        index += 1;
        continue;
      }

      const attribute = /^[^\s=/>]+/.exec(markup.slice(index));
      if (!attribute) {
        index += 1;
        continue;
      }
      names.push(attribute[0]);
      index += attribute[0].length;

      // Skip `=value` (quoted or bare) so a value can never be mistaken for an attribute name.
      const value = /^\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/.exec(markup.slice(index));
      if (value) index += value[0].length;
    }

    cursor = index + 1;
  }

  return names;
}

/** Event-handler attributes (`onerror`, `onload`, `onclick`, …) that are live on a real tag. */
export function liveHandlerAttributes(markup: string): string[] {
  return tagAttributeNames(markup).filter((name) => /^on[a-z]+$/i.test(name));
}

/**
 * The text `react-dom/server` writes for a string child — the other half of the invariant: an escaped payload
 * is still *visible*, so a reviewer can see what the model produced.
 *
 * This is React's own escape map (the five characters that can close a tag or an attribute). Writing it down
 * here makes the assertion exact per payload instead of "the markup contains some `&lt;` somewhere": a payload
 * such as `javascript:alert(1)` contains no markup character at all, so asserting `&lt;` for it was wrong and
 * the case was simply never reached (the suite aborted earlier on the `onerror=` false positive).
 */
export function escapeAsReactText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Removes comments so a source scan reads *code* rather than prose.
 *
 * The two components that hold the invariant document it: `AgentStreamView.tsx` says in a comment that it
 * must never use `dangerouslySetInnerHTML`, and a scan of the raw text counted that sentence as the
 * violation. A comment cannot execute, and a check that forbids the *word* would push the rule out of the
 * documentation while leaving the code itself no better guarded.
 *
 * The rules mirror `scripts/scan-web-xss.mjs` (the gate's scanner) on purpose — two scans of the same tree
 * must agree — including its stated limitation: `//` starts a comment only after whitespace, so `https://`
 * inside a string survives, and an indirection such as `"inner" + "HTML"` cannot be followed. This is a
 * guard against the ordinary mistake, not a proof of absence.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const match = /(^|\s)\/\//.exec(line);
      if (!match) return line;
      const index = match.index + (match[1] ?? "").length;
      return line.slice(0, index);
    })
    .join("\n");
}
