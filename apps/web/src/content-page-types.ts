export interface ContentItem {
  id: string;
  title: string;
  type: "article" | "seo_structure" | "social_post" | "brief";
  content: string;
  sourceRunId?: string;
  companyId?: string;
  companyName?: string;
  createdAt: string;
}

export const STORAGE_DELETED_KEY = "npati_content_deleted_ids_v1";
export const STORAGE_EDITS_KEY = "npati_content_edits_v1";

export function getDeletedIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_DELETED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function getEditsMap(): Record<string, Partial<ContentItem>> {
  try {
    const raw = localStorage.getItem(STORAGE_EDITS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Partial<ContentItem>>) : {};
  } catch {
    return {};
  }
}

export function parseChatContentTask(task: string): { title?: string; type?: ContentItem["type"]; task: string } {
  const match = task.match(/^\[NPATI_CONTENT:(article|seo_blueprint|social_post|brief|strategy|other):([A-Za-z0-9_-]+)\]\s*/);
  if (!match) return { task };
  let title: string | undefined;
  try {
    const base64 = match[2]!.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    title = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    title = undefined;
  }
  const mappedType: ContentItem["type"] = match[1] === "seo_blueprint"
    ? "seo_structure"
    : match[1] === "social_post"
      ? "social_post"
      : match[1] === "brief" || match[1] === "strategy"
        ? "brief"
        : "article";
  return { title, type: mappedType, task: task.slice(match[0].length) };
}
