import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardLinkHtml, escapeInlineText, isSafeCardHref } from "../apps/web/src/chat-markdown-inline";
import { ALLOWLIST, scanWebSources } from "../scripts/lib/scan-web-xss.mjs";

/**
 * [security-gate] C7: web-source XSS invariant.
 *
 * Two halves, both deterministic — no DOM, no network, no browser:
 *
 *  1. **Source scan** over `apps/web/src/**`, executed through `scripts/scan-web-xss.mjs` (the same program
 *     that can be run by hand as `node scripts/scan-web-xss.mjs`). `dangerouslySetInnerHTML`, `innerHTML`,
 *     `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(` and `new Function(` are allowed only at
 *     explicitly allowlisted sites **with a written reason and an occurrence cap**, so an HTML-injection path
 *     — including one more occurrence inside an already-listed file — fails the gate. `javascript:` in a JSX
 *     attribute and template-built `href`/`src` are refused unless allowlisted with a reason.
 *
 *  2. **Behavioural check of the escaping helpers** (`apps/web/src/chat-markdown-inline.ts`), which is the
 *     real reason those helpers live outside the JSX file: they can be executed here. The defect they close
 *     was that `markdownToCardHtml` escaped `&`, `<` and `>` but **not quotes**, while the link pattern
 *     accepted `"` inside the URL — so a model-authored message containing
 *     `[x](https://a.com/"onmouseover="location=name)` produced a link whose own `href` was terminated early,
 *     installing an event handler. The tests assert the payload can no longer escape its attribute, that an
 *     un-escaped caller is refused rather than guessed at, and that the helpers are actually wired into the
 *     renderer (a helper nobody calls would leave the hole open while looking fixed).
 *
 * This file must stay a **plain Node test**: it reads sources as text and executes two dependency-free
 * modules. Importing a React component or reading the tree at module scope makes the suite fail to load,
 * which the gate reports as "reported no tests at all" — a silent red.
 */

/** Repository root: this file lives in `tests/`, so one level up. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const HOSTILE = [
  'https://a.com/"onmouseover="location=name',
  'https://a.com/"onerror="alert(1)',
  "https://a.com/'onmouseover='alert(1)",
  'https://a.com/"onload="document.title=1',
];

describe("[security-gate] C7 web-source XSS scan", () => {
  it("finds no unlisted HTML-injection or DOM-writing site in apps/web/src", () => {
    const result = scanWebSources(ROOT);
    const report = result.violations
      .map((violation) => `  ${violation.file}:${violation.line} — ${violation.rule} (${violation.detail})`)
      .join("\n");
    expect(result.violations, `violations:\n${report}`).toEqual([]);
    expect(result.scannedFiles).toBeGreaterThan(50);
  });

  it("scans deterministically: the same tree gives the same result", () => {
    const first = scanWebSources(ROOT);
    const second = scanWebSources(ROOT);
    expect(second.violations).toEqual(first.violations);
    expect(second.scannedFiles).toBe(first.scannedFiles);
  });

  it("requires every allowlisted site to be present, so a rename cannot silently drop coverage", () => {
    const result = scanWebSources(ROOT);
    const checked = new Set(result.allowlistChecked);
    const stale = ALLOWLIST.filter((entry) => !checked.has(`${entry.file}::${entry.pattern}`)).map(
      (entry) => `${entry.file}::${entry.pattern}`
    );
    expect(stale, `stale allowlist entries: ${stale.join(", ")}`).toEqual([]);
  });

  it("requires a written reason for every allowance", () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.file}::${entry.pattern} needs a reason`).toBeGreaterThan(20);
      expect(entry.occurrences).toBeGreaterThan(0);
    }
  });
});

describe("[security-gate] C7 chat card markdown escaping", () => {
  it("escapes quotes as well as angle brackets and ampersands", () => {
    expect(escapeInlineText('a"b')).toBe("a&quot;b");
    expect(escapeInlineText("a'b")).toBe("a&#39;b");
    expect(escapeInlineText("<b>&")).toBe("&lt;b&gt;&amp;");
  });

  it("cannot break out of the href attribute on the real call path (escaped-in, as formatInline does)", () => {
    for (const payload of HOSTILE) {
      // formatInline escapes the whole line first and only then builds the link — this is that call shape.
      const html = cardLinkHtml(escapeInlineText("label"), escapeInlineText(payload));
      // The handler *text* may legitimately survive inside the escaped attribute value — what must not
      // survive is the attribute boundary. Assert on the boundary, not on the substring: asserting
      // `!html.includes("onmouseover=")` would fail on perfectly safe output and would teach the next
      // author to weaken the check.
      const hrefValue = /href="([^"]*)"/.exec(html)?.[1] ?? "";
      expect(hrefValue, `${payload} → ${html}`).not.toContain('"');
      expect(hrefValue, `${payload} → ${html}`).not.toContain("'");
      expect(html, `${payload} → ${html}`).not.toMatch(/["']\s+on[a-z]+\s*=/i);
      // The anchor carries exactly three quoted attributes (href, class, style): a fourth pair of quotes
      // would mean the payload closed `href` early and started an attribute of its own.
      expect((html.match(/"/g) ?? []).length, `${payload} → ${html}`).toBe(6);
      expect(html, `${payload} → ${html}`).toMatch(/&quot;|&#39;/);
    }
  });

  it("refuses to build a link when the caller passes raw markup, instead of guessing", () => {
    for (const payload of HOSTILE) {
      const html = cardLinkHtml("label", payload);
      expect(html, payload).not.toContain("<a ");
      expect(html, payload).not.toContain("href=");
    }
    // The refusal path must escape the label it returns: returning raw markup there would inject through
    // the very check that refused the link.
    const rawLabel = cardLinkHtml('<img src=x onerror="alert(1)">', "https://ok.test/x");
    expect(rawLabel).not.toContain("<img");
    expect(rawLabel).not.toContain("<a ");
    expect(rawLabel).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("does not escape twice, so a URL with a query string survives intact", () => {
    const html = cardLinkHtml("docs", "https://example.test/guide?a=1&amp;b=2");
    expect(html).toContain('href="https://example.test/guide?a=1&amp;b=2"');
    expect(html).not.toContain("&amp;amp;");
    expect(html).toContain('class="chat-card-link"');
    expect(html).toContain(">docs</a>");
  });

  it("refuses javascript: and protocol-relative URLs, rendering them as text", () => {
    for (const unsafe of ["javascript:alert(1)", "JavaScript:alert(1)", "//evil.test/x", "data:text/html,<script>"]) {
      expect(isSafeCardHref(unsafe), unsafe).toBe(false);
      const html = cardLinkHtml(escapeInlineText("label"), escapeInlineText(unsafe));
      expect(html, unsafe).not.toContain("<a ");
      expect(html, unsafe).not.toContain("href=");
    }
  });

  it("still links the URLs the chat is supposed to link", () => {
    const html = cardLinkHtml("docs", "https://example.test/guide?q=1");
    expect(html).toContain('<a href="https://example.test/guide?q=1" class="chat-card-link"');
    expect(html).toContain(">docs</a>");
    expect(cardLinkHtml("root", "/settings/code")).toContain('href="/settings/code"');
  });

  it("keeps the escaping helpers wired into the chat renderer", () => {
    const source = readFileSync(join(ROOT, "apps", "web", "src", "ChatMessageContent.tsx"), "utf8");
    expect(source).toContain('from "./chat-markdown-inline"');
    expect(source).toContain("escapeInlineText(str)");
    expect(source).toContain("cardLinkHtml(label, url)");
    // The vulnerable inline href interpolation must be gone.
    expect(source).not.toContain('<a href="$2"');
  });
});
