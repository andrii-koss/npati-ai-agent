// Browser-controlled strings never cross the model boundary.
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
const coordinate = value => Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : undefined;

export function normalizeBrowserDiagnostic(value) {
  const cause = typeof value?.cause === "string" && Object.hasOwn(causes, value.cause) ? value.cause : "runtime";
  const source = sourceNames.has(value?.source) ? value.source : "preview-script";
  const line = coordinate(value?.line), column = coordinate(value?.column);
  return { type: value?.type === "pageerror" ? "pageerror" : "error", cause,
    message: causes[cause], source, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) };
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
      const name = url.pathname.split("/").at(-1);
      if (sourceNames.has(name)) source = name;
      line = coordinate(loc.lineNumber) === undefined ? undefined : loc.lineNumber + 1;
      column = coordinate(loc.columnNumber) === undefined ? undefined : loc.columnNumber + 1;
    }
  } catch { /* Unknown location stays anonymous. */ }
  return normalizeBrowserDiagnostic({ type, cause, source, line, column });
}
