import type { AuthContext, Project } from "./types";

export interface ProjectCatalogInput {
  companyId?: string; search?: string; status?: string; framework?: string; kind?: string; cursor?: string;
}
export type ProjectCatalogItem = Pick<Project, "id" | "companyId" | "name" | "description" | "type" | "kind" | "status" | "framework" | "deploymentUrl" | "deploymentStatus" | "previewUrl" | "previewPort" | "revision" | "createdAt" | "updatedAt"> & { hasThumbnail?: boolean };
export interface ProjectCatalogPage { projects: ProjectCatalogItem[]; pagination: { nextCursor: string | null } }
export const CATALOG_SIZE = 6;
export function catalogScope(context: AuthContext, input: ProjectCatalogInput) {
  return JSON.stringify([context.workspaceId, context.userId, context.companyId ?? "", input.companyId ?? "", input.search ?? "", input.status ?? "all", input.framework ?? "all", input.kind ?? "all"]);
}
export function catalogCursor(context: AuthContext, input: ProjectCatalogInput): { time: string; id: string } | null {
  if (!input.cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
    if (value.scope !== catalogScope(context, input) || typeof value.time !== "string" || !Number.isFinite(Date.parse(value.time)) || typeof value.id !== "string" || !/^[\da-f-]{36}$/i.test(value.id)) throw Error();
    return { time: value.time, id: value.id };
  } catch { throw new Error("Invalid catalog cursor"); }
}
export function catalogPage(context: AuthContext, input: ProjectCatalogInput, rows: ProjectCatalogItem[]): ProjectCatalogPage {
  const projects = rows.slice(0, CATALOG_SIZE).map(({ id, companyId, name, description, type, kind, status, framework, deploymentUrl, deploymentStatus, previewUrl, previewPort, revision, createdAt, updatedAt, hasThumbnail }) => ({
    id, companyId, name, description, type, kind, status, framework, revision, createdAt, updatedAt,
    ...(deploymentUrl ? { deploymentUrl } : {}),
    ...(deploymentStatus ? { deploymentStatus } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(typeof previewPort === "number" ? { previewPort } : {}),
    ...(typeof hasThumbnail === "boolean" ? { hasThumbnail } : {}),
  }));
  const last = projects.at(-1);
  const cursorTime = last?.createdAt || last?.updatedAt;
  return { projects, pagination: { nextCursor: rows.length > CATALOG_SIZE && last && cursorTime ? Buffer.from(JSON.stringify({ scope: catalogScope(context, input), time: cursorTime, id: last.id })).toString("base64url") : null } };
}
export function catalogFramework(framework: string, filter: string) {
  const fw = framework.toLowerCase();
  return filter === "all" || (filter === "static" ? /static|html/.test(fw) : fw.includes(filter === "nextjs" ? "next" : filter));
}
