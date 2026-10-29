import { apiFetch } from "./website-builder-cache";

export function projectPreviewRoot(companyId: string, projectId: string) {
  return `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`;
}
/** Only call after the user chooses Preview or Create screenshot. */
export async function openableProjectPreview(companyId: string, projectId: string): Promise<string> {
  const root = projectPreviewRoot(companyId, projectId);
  const status = await apiFetch<{ isRunning?: boolean }>(root + "/preview/status");
  const result = status.isRunning
    ? await apiFetch<{ token: string }>(root + "/preview/token")
    : await apiFetch<{ token: string }>(root + "/preview/start", { method: "POST", body: "{}" });
  if (!result.token) throw new Error("Preview did not return an access token");
  return `/api${root}/preview/proxy/?token=${encodeURIComponent(result.token)}`;
}
