export function rewriteSetCookieHeader(
  cookieStr: string,
  projectPrefix: string,
  proxyPath: string,
): string {
  const parts = cookieStr.split(";").map((p) => p.trim());
  if (parts.length === 0 || !parts[0] || !parts[0].includes("=")) return cookieStr;
  const eqIdx = parts[0].indexOf("=");
  const name = parts[0].slice(0, eqIdx);
  const val = parts[0].slice(eqIdx + 1);
  const newName = `${projectPrefix}${name}`;
  const attributes: string[] = [`${newName}=${val}`];
  let pathSet = false;
  let sameSiteSet = false;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const lower = part.toLowerCase();
    if (lower.startsWith("domain=")) {
      continue;
    }
    if (lower.startsWith("path=")) {
      attributes.push(`Path=${proxyPath}`);
      pathSet = true;
      continue;
    }
    if (lower.startsWith("samesite=")) {
      attributes.push("SameSite=Lax");
      sameSiteSet = true;
      continue;
    }
    attributes.push(part);
  }
  if (!pathSet) {
    attributes.push(`Path=${proxyPath}`);
  }
  if (!sameSiteSet) {
    attributes.push("SameSite=Lax");
  }
  return attributes.join("; ");
}
export function filterIncomingCookies(
  rawCookieHeader: string | undefined,
  projectPrefix: string,
): string | undefined {
  if (!rawCookieHeader || typeof rawCookieHeader !== "string") return undefined;
  const parts = rawCookieHeader.split(";");
  const upstreamCookies: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(projectPrefix)) {
      upstreamCookies.push(trimmed.slice(projectPrefix.length));
    }
  }
  return upstreamCookies.length > 0 ? upstreamCookies.join("; ") : undefined;
}
/** Project-scoped, HttpOnly preview session cookie. It is never forwarded to the project server. */
export function previewAuthCookieName(projectId: string): string {
  return `_npati_preview_${projectId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}
export function readCookieValue(rawCookieHeader: string | undefined, name: string): string | undefined {
  if (!rawCookieHeader) return undefined;
  for (const part of rawCookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}
