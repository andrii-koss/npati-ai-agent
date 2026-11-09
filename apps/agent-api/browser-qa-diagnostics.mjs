// Browser-controlled text never crosses the model boundary: the message stays a fixed phrase. What does cross is the
// file of the same site, the line and the error class, each limited to characters that cannot carry an instruction, so
// the agent can open the right file instead of searching blind (E2E G7 spent 32 turns without them).
const causes = {
  undefined_reference: "ReferenceError: an identifier is not defined",
  null_property: "TypeError: a property was read from null or undefined",
  not_callable: "TypeError: a value is not a function",
  network_failure: "Network request failed; check the local data route and Project API connectivity",
  hydration: "React hydration failed: server and client markup differ",
  syntax: "JavaScript syntax error",
  runtime: "JavaScript runtime error",
};
const sourceNames = new Set(["page.tsx", "page.jsx", "layout.tsx", "layout.jsx", "main.js", "webpack.js", "preview-script"]);
const safeSource = value => typeof value === "string" && value.length <= 160 && /^[A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,8}$/.test(value) && !value.includes("..") ? value : undefined;
const safeErrorName = value => typeof value === "string" && /^[A-Z][A-Za-z]{2,40}Error$/.test(value) ? value : undefined;
const coordinate = value => Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : undefined;

export function normalizeBrowserDiagnostic(value) {
  const cause = typeof value?.cause === "string" && Object.hasOwn(causes, value.cause) ? value.cause : "runtime";
  const source = safeSource(value?.source) ?? "preview-script";
  const errorName = safeErrorName(value?.errorName);
  const line = coordinate(value?.line), column = coordinate(value?.column);
  return { type: value?.type === "pageerror" ? "pageerror" : "error", cause,
    message: causes[cause], source, ...(errorName ? { errorName } : {}), ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) };
}

/** The check itself blocks outside hosts, so a photo or stylesheet from another site failing here says nothing about the page. */
export function isBlockedExternalResource(text, location, origin) {
  if (typeof text !== "string" || !/Failed to load resource/i.test(text)) return false;
  try { return new URL(location?.url).origin !== origin; } catch { return false; }
}

export function captureBrowserDiagnostic(type, rawMessage, location, stack, origin) {
  const text = typeof rawMessage === "string" ? rawMessage.slice(0, 4096) : "";
  const cause = /ReferenceError|is not defined/i.test(text) ? "undefined_reference"
    : /Cannot (?:read|set) propert.*(?:undefined|null)/i.test(text) ? "null_property"
    : /is not a function/i.test(text) ? "not_callable"
    : /Failed to fetch|fetch failed|Failed to load resource|NetworkError|ERR_CONNECTION/i.test(text) ? "network_failure"
    : /hydration|hydrating|Minified React error #4(?:18|23|25)/i.test(text) ? "hydration"
    : /SyntaxError|Unexpected token/i.test(text) ? "syntax" : "runtime";
  let loc = location;
  if (!loc?.url && typeof stack === "string") {
    for (const frame of stack.slice(0, 8192).split("\n").slice(0, 12)) {
      const match = frame.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)\)?$/);
      if (match) {
        try { if (new URL(match[1]).origin === origin) { loc = { url: match[1], lineNumber: Number(match[2]) - 1, columnNumber: Number(match[3]) - 1 }; break; } } catch { /* discard */ }
      }
    }
  }
  let source = "preview-script", line, column;
  try {
    const url = new URL(loc?.url);
    if (url.origin === origin) {
      // The path inside the project, e.g. src/main.js or node_modules/.vite/deps/three.js; the query (?v=hash) is dropped.
      const name = url.pathname.replace(/^\/+/, "");
      if (sourceNames.has(name.split("/").at(-1)) || safeSource(name)) source = safeSource(name) ?? name.split("/").at(-1);
      line = coordinate(loc.lineNumber) === undefined ? undefined : loc.lineNumber + 1;
      column = coordinate(loc.columnNumber) === undefined ? undefined : loc.columnNumber + 1;
    }
  } catch { /* Unknown location stays anonymous. */ }
  const errorName = text.match(/^(?:Uncaught\s+)?([A-Z][A-Za-z]{2,40}Error)\b/)?.[1];
  return normalizeBrowserDiagnostic({ type, cause, source, errorName, line, column });
}
