/**
 * C7 security fix: the pure escaping helpers behind chat card markdown.
 *
 * They live in their own module — away from JSX — for one reason: an invariant that can only be checked by
 * reading JSX is not checked at all. These are plain string transforms, so the security gate can execute
 * them in a Node environment (no jsdom) and assert that a hostile markdown link cannot break out of the
 * attribute it is placed in.
 *
 * The defect this closes: `markdownToCardHtml` escaped `&`, `<` and `>` but **not quotes**, while the link
 * pattern accepted `"` inside the URL (`[^\s)]+`). A model-authored message containing
 * `[x](https://a.com/"onmouseover="location=name)` therefore produced
 * `<a href="https://a.com/"onmouseover="location=name" …>` — the quote closed the attribute and the browser
 * installed an event handler.
 *
 * Contract, stated explicitly because getting it wrong in the other direction is its own bug:
 *  - `escapeInlineText` takes **raw** text and escapes it once.
 *  - `cardLinkHtml` takes label and URL **already escaped** by `escapeInlineText` (that is the order
 *    `formatInline` uses, so that no user text can inject markup before the escaping happens). It therefore
 *    does **not** escape again — re-escaping would turn `&amp;` into `&amp;amp;` and break any URL with a
 *    query string — and instead **refuses to build a link** at all if a raw markup character is still
 *    present, which means a caller that forgot to escape gets text, not a link. Guessing was what produced
 *    the original hole; refusing is what removes it.
 */

/** Escape everything that can change parsing in text *and* in a double-quoted attribute (raw input only). */
export function escapeInlineText(input: string): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only these may become a real `href`; anything else is rendered as text instead of as a link. */
export function isSafeCardHref(url: string): boolean {
  const value = String(url ?? "").trim();
  if (value.length === 0) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  return /^https?:\/\//i.test(value);
}

/** Any of these in an "escaped" value means the caller did not escape it. */
const RAW_MARKUP = /["'<>]/;

/**
 * The label as it may be emitted: an already-escaped label is returned untouched (escaping it again would
 * corrupt `&amp;`), while a label that still contains raw markup is escaped. The refusal path below relies
 * on this — returning a raw label there would inject markup through the very check that refused the link.
 */
function emittedLabel(labelText: string): string {
  return RAW_MARKUP.test(labelText) ? escapeInlineText(labelText) : labelText;
}

/**
 * Build the card link from **already escaped** parts. A raw quote, apostrophe or angle bracket anywhere in
 * either part refuses the link, and a URL that is not http(s) or root-relative is refused too; in both cases
 * the label is returned as (escaped) text, so an un-escaped caller can never produce an attribute break-out.
 */
export function cardLinkHtml(label: string, url: string): string {
  const labelText = String(label ?? "");
  const urlText = String(url ?? "");
  if (RAW_MARKUP.test(urlText) || RAW_MARKUP.test(labelText)) return emittedLabel(labelText);
  if (!isSafeCardHref(urlText)) return emittedLabel(labelText);
  return `<a href="${urlText}" class="chat-card-link" style="color:var(--brand-500, #3b82f6);text-decoration:underline;font-weight:600;display:inline-flex;margin-top:4px;">${labelText}</a>`;
}
