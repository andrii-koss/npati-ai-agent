import { createSafeUrlValidatorAdapter, type SafeUrlValidatorLike } from "./ssrf-policy";

/**
 * C4b: URL validator handed to the web-research package.
 *
 * It is the shared SSRF policy (scheme, port, host shape, strict allowlist semantics, resolution of
 * every address, refusal of private/reserved IPs in any encoding) exposed through the shape that
 * package expects, so `web_fetch`, `web.crawl` and search-driven page loads use the same rules as
 * every other NPATI-side outbound request.
 *
 * Hosts are taken from `NPATI_WEB_FETCH_ALLOWED_HOSTS` (comma separated, `*.example.com` allows exactly
 * one extra label, `*` allows any public host). An empty configuration denies every host.
 */
export function webResearchUrlValidator(environment: NodeJS.ProcessEnv = process.env): SafeUrlValidatorLike {
  const allowlist = (environment.NPATI_WEB_FETCH_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return createSafeUrlValidatorAdapter({ allowlist });
}
