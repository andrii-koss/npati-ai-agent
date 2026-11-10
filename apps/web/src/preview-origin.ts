/**
 * A generated site runs its own JavaScript. Loaded from the app's origin, that code could read the app's stored
 * access token, so a Preview opens from a separate origin per project: `<project>.preview.localhost` locally, or the
 * template in VITE_PREVIEW_ORIGIN (for example `https://{project}.preview.example.com`). The preview proxy authorises
 * each request with its signed token and cookie, so it answers on any host.
 */
const PROXY = /^\/api\/companies\/[^/]+\/projects\/([^/]+)\/preview\/proxy(?:\/|$)/;

function originTemplate(): string | null {
  const configured = import.meta.env.VITE_PREVIEW_ORIGIN as string | undefined;
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window === "undefined") return null;
  const { protocol, hostname, port } = window.location;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return null;
  return `${protocol}//{project}.preview.localhost${port ? ":" + port : ""}`;
}

/** The address a Preview frame or tab should open; anything that is not a preview proxy path is returned as is. */
export function isolatedPreviewUrl(url: string): string;
export function isolatedPreviewUrl(url: string | null | undefined): string | undefined;
export function isolatedPreviewUrl(url: string | null | undefined): string | undefined {
  if (!url) return url ?? undefined;
  const match = PROXY.exec(url);
  const template = match ? originTemplate() : null;
  if (!match || !template) return url;
  const project = decodeURIComponent(match[1]!).toLowerCase().replace(/[^a-z0-9-]/g, "");
  return template.replace("{project}", project) + url;
}
