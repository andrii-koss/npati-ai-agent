#!/usr/bin/env node
/**
 * C7: web-source XSS invariant.
 *
 * Why a source scan and not an end-to-end test: rendering tests need jsdom + @testing-library/react, which
 * are not installed, run only in a browser-like environment, and would not be part of the security gate.
 * This scan is a plain Node program with no DOM, no network and no test runner, so the gate can require it
 * for every change — an HTML-injection path cannot enter the web app unnoticed.
 *
 * What it enforces:
 *  1. `dangerouslySetInnerHTML` is only allowed at an explicitly listed site, with a written reason, and
 *     only up to the recorded number of occurrences — so a **new** site, or one more site in an
 *     already-listed file, fails.
 *  2. `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval(` / `new Function(`
 *     are likewise allowlisted per file with a reason and a cap.
 *  3. `javascript:` in a JSX attribute, and `href`/`src` built from a template literal, are banned
 *     outright.
 *
 * Honesty about its limits: this is a **heuristic**, not a JavaScript parser. It strips comments (so the
 * word may appear in prose), and it treats `//` as a comment only when it follows whitespace, so `https://`
 * inside a string survives. It cannot follow an indirection such as `const key = "inner" + "HTML"`. It is
 * a guard against the ordinary mistake, not a proof of absence — the render-level checks in
 * `apps/web/src/code-workspace/__tests__/xss-hygiene.test.tsx` cover the other half.
 *
 * Usage: `node scripts/scan-web-xss.mjs [--json]` (exit 1 with `file:line: rule` lines when it finds one).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Every allowance names the file, the exact count and, most importantly, why it is safe. */
export const ALLOWLIST = [
  {
    file: "apps/web/src/CompanyPage.tsx",
    pattern: "dangerouslySetInnerHTML",
    occurrences: 2,
    reason: "i18n notice strings from the app's own translation resources (t(...)), never interpolated data.",
  },
  {
    file: "apps/web/src/ChatMessageContent.tsx",
    pattern: "dangerouslySetInnerHTML",
    occurrences: 2,
    reason:
      "escape-then-markup: content is escaped by escapeInlineText (including quotes) and links are built by cardLinkHtml, which re-escapes and validates the href. Both call sites now pass through sanitizeCardHtml (allowlist tags, http(s)/root-relative hrefs only).",
  },
  {
    file: "apps/web/src/ChatMessageContent.tsx",
    pattern: "innerHTML",
    occurrences: 8,
    reason:
      "the contentEditable card mirrors its own HTML between the inline card and the fullscreen body in the same document. Every read of that node (input handler, fullscreen toggle, __html) goes through sanitizeCardHtml first, and sanitizeCardHtml itself reads back the body it just sanitized; writes only ever receive sanitized markup. Nothing is persisted.",
  },
  {
    file: "apps/web/src/EmailInboxPage.tsx",
    pattern: "dangerouslySetInnerHTML",
    occurrences: 1,
    reason: "renders only the output of sanitizeEmailHtml, an allowlist sanitizer with blocked tags and http(s)-only hrefs.",
  },
  {
    file: "apps/web/src/EmailInboxPage.tsx",
    pattern: "innerHTML",
    occurrences: 1,
    reason: "inside sanitizeEmailHtml itself: reads back the sanitized document body it just built.",
  },
  {
    file: "apps/web/src/AIProviderMarketplace.tsx",
    pattern: "attr:template-src",
    occurrences: 1,
    reason:
      "icon URL whose only interpolation is encodeURIComponent(providerId) inside a literal /api/ai/providers/… path — the host and scheme are literals.",
  },
  {
    file: "apps/web/src/ProjectPage.tsx",
    pattern: "attr:template-src",
    occurrences: 1,
    reason:
      "screenshot data URL: the literal prefix is `data:image/png;base64,` and the interpolation is base64 from the server response, so no attacker-chosen scheme or host can be introduced.",
  },
];

const BANNED_PATTERNS = [
  "dangerouslySetInnerHTML",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "document.write",
  "eval(",
  "new Function(",
];

const BANNED_ATTRIBUTE_RULES = [
  { id: "attr:javascript-url", rule: "javascript: URL in a JSX attribute", regex: /(?:href|src|action|formAction)\s*=\s*["'`]\s*javascript:/i },
  { id: "attr:template-href", rule: "template-built href", regex: /href\s*=\s*\{\s*`/ },
  { id: "attr:template-src", rule: "template-built src", regex: /src\s*=\s*\{\s*`/ },
  { id: "attr:innerhtml-template-assign", rule: "template assigned to innerHTML", regex: /\.innerHTML\s*\+?=\s*`/ },
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      // `//` starts a comment only when it follows whitespace (so `https://` is left alone).
      const match = /(^|\s)\/\//.exec(line);
      if (!match) return line;
      const index = match.index + match[1].length;
      return line.slice(0, index);
    })
    .join("\n");
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      walk(full, out);
      continue;
    }
    if (/\.(tsx?|jsx?)$/.test(entry) && !/\.(test|spec)\./.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Returns `{ violations: [{file, line, rule, detail}], scannedFiles, allowlistChecked }`. */
export function scanWebSources(root = process.cwd()) {
  const srcRoot = join(root, "apps", "web", "src");
  const files = walk(srcRoot);
  const violations = [];
  const allowlistChecked = new Set();

  const allowanceFor = (relPath, pattern) =>
    ALLOWLIST.find((entry) => entry.file === relPath.replace(/\\/g, "/") && entry.pattern === pattern);

  for (const file of files) {
    const relPath = relative(root, file).split(sep).join("/");
    const source = readFileSync(file, "utf8");
    const code = stripComments(source);
    const lines = code.split("\n");

    for (const pattern of BANNED_PATTERNS) {
      let count = 0;
      const foundAt = [];
      lines.forEach((line, index) => {
        if (line.includes(pattern)) {
          count += 1;
          foundAt.push(index + 1);
        }
      });
      if (count === 0) continue;

      const allowance = allowanceFor(relPath, pattern);
      if (!allowance) {
        for (const line of foundAt) {
          violations.push({
            file: relPath,
            line,
            rule: `unlisted ${pattern}`,
            detail: "add an explicit allowlist entry with a reason in scripts/scan-web-xss.mjs, or remove the HTML path",
          });
        }
        continue;
      }
      allowlistChecked.add(`${allowance.file}::${pattern}`);
      if (count > allowance.occurrences) {
        for (const line of foundAt.slice(allowance.occurrences)) {
          violations.push({
            file: relPath,
            line,
            rule: `new ${pattern} beyond the allowlisted count (${allowance.occurrences})`,
            detail: allowance.reason,
          });
        }
      }
    }

    const attrHits = new Map();
    lines.forEach((line, index) => {
      for (const { id, rule, regex } of BANNED_ATTRIBUTE_RULES) {
        if (!regex.test(line)) continue;
        const hits = attrHits.get(id) ?? [];
        hits.push({ line: index + 1, rule, text: line.trim().slice(0, 160) });
        attrHits.set(id, hits);
      }
    });

    for (const { id, rule } of BANNED_ATTRIBUTE_RULES) {
      const hits = attrHits.get(id);
      if (!hits || hits.length === 0) continue;
      const allowance = allowanceFor(relPath, id);
      if (!allowance) {
        for (const hit of hits) {
          violations.push({
            file: relPath,
            line: hit.line,
            rule: `${rule} (${id})`,
            detail: `${hit.text} — allowlist it with a reason in scripts/scan-web-xss.mjs if it is genuinely safe, otherwise remove it`,
          });
        }
        continue;
      }
      allowlistChecked.add(`${allowance.file}::${id}`);
      for (const hit of hits.slice(allowance.occurrences)) {
        violations.push({
          file: relPath,
          line: hit.line,
          rule: `new ${rule} beyond the allowlisted count (${allowance.occurrences})`,
          detail: allowance.reason,
        });
      }
    }
  }

  return { violations, scannedFiles: files.length, allowlistChecked: [...allowlistChecked] };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (isMain) {
  const result = scanWebSources(process.cwd());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[web-xss] scanned files: ${result.scannedFiles}`);
    console.log(`[web-xss] allowlisted sites checked: ${result.allowlistChecked.length}/${ALLOWLIST.length}`);
    for (const entry of ALLOWLIST) {
      if (!result.allowlistChecked.includes(`${entry.file}::${entry.pattern}`)) {
        console.log(`[web-xss] STALE ALLOWLIST: ${entry.file} no longer contains ${entry.pattern}`);
      }
    }
    for (const violation of result.violations) {
      console.log(`[web-xss] ${violation.file}:${violation.line}: ${violation.rule} — ${violation.detail}`);
    }
    console.log(result.violations.length === 0 ? "[web-xss] OK" : `[web-xss] FAILED: ${result.violations.length} violation(s)`);
  }
  process.exit(result.violations.length === 0 ? 0 : 1);
}
