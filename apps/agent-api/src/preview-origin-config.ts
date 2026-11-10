/**
 * Where a project Preview opens. A generated site runs its own JavaScript; opened from the app's own origin it could read
 * the app's stored access token, so each project gets an origin of its own.
 *
 * NPATI_PREVIEW_ORIGIN names that origin with a `{project}` placeholder in the host, for example
 * `https://{project}.preview.example.com`. It needs a wildcard DNS record and a wildcard TLS certificate for that name,
 * both pointing at this server. It is read when the server starts and handed to the web app in index.html, so a
 * prebuilt image can be configured without rebuilding the web bundle. Without it, a local installation uses
 * `<project>.preview.localhost`, and any other installation opens Preview on its own origin (not isolated).
 */
export interface PreviewOriginConfig { template: string; hostPattern: RegExp }

export function parsePreviewOrigin(value: string | undefined): PreviewOriginConfig | null {
  const raw = value?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw.replace("{project}", "project-placeholder")); } catch { throw new Error("NPATI_PREVIEW_ORIGIN must be a URL such as https://{project}.preview.example.com"); }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error("NPATI_PREVIEW_ORIGIN must be only a scheme and host, such as https://{project}.preview.example.com");
  const host = raw.replace(/^https?:\/\//, "");
  const firstLabel = host.split(":")[0]!.split(".")[0]!;
  if (host.split("{project}").length !== 2 || !firstLabel.includes("{project}"))
    throw new Error("NPATI_PREVIEW_ORIGIN must contain {project} exactly once, in the first part of the host name");
  const escaped = host.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{project\\}", "[a-z0-9-]+");
  return { template: raw, hostPattern: new RegExp(`^${escaped}$`, "i") };
}

let cached: { value: string | undefined; config: PreviewOriginConfig | null } | undefined;
/** The configured origin, read once per value of the variable. */
export function previewOriginConfig(env: NodeJS.ProcessEnv = process.env): PreviewOriginConfig | null {
  const value = env.NPATI_PREVIEW_ORIGIN;
  if (!cached || cached.value !== value) cached = { value, config: parsePreviewOrigin(value) };
  return cached.config;
}

/** The meta tag the web app reads; escaped for an HTML attribute. */
export function previewOriginMeta(config: PreviewOriginConfig | null): string {
  if (!config) return "";
  const content = config.template.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<meta name="npati-preview-origin" content="${content}">`;
}
