import path from "node:path";

/** Validate authored HTML resources before opening a static server, without running user scripts. */
export async function validateStaticProjectResources(files: Array<{path:string}>, read: (file:string)=>Promise<string>): Promise<void> {
  const known = new Set(files.map(file => file.path));
  if (!known.has("index.html")) throw Error("Static website is missing index.html");
  for (const file of files.filter(file => /\.html?$/i.test(file.path))) {
    const html = await read(file.path);
    const documentUrl = new URL(file.path, "http://project.local/");
    const baseHref = html.match(/<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const base = baseHref ? new URL(baseHref, documentUrl) : documentUrl;
    for (const tag of html.matchAll(/<(?:script|link|img|source|video|audio)\b[^>]*>/gi)) {
      for (const match of tag[0].matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) {
        const target = match[1]!;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
        const url = new URL(target, base);
        if (url.origin !== documentUrl.origin) continue;
        const resource = path.posix.normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
        if (!known.has(resource)) throw Error("Static website references missing resource: " + resource + " (from " + file.path + ")");
      }
    }
  }
}
