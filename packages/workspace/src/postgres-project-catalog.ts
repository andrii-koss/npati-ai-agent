import type { Pool } from "pg";
import type { AuthContext } from "./types";
import { assertMember, assertCompany } from "./postgres-store-support";
import { catalogCursor, catalogPage, type ProjectCatalogInput, type ProjectCatalogItem } from "./project-catalog";

export function projectCatalogQuery(context: AuthContext, input: ProjectCatalogInput) {
  const cursor = catalogCursor(context, input);
  const values: unknown[] = [context.workspaceId, context.userId];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = ["p.workspace_id=$1", "p.created_by=$2", "p.status NOT IN ('soft_deleted','purging','deleted')",
    "EXISTS (SELECT 1 FROM companies c WHERE c.id=p.company_id AND c.workspace_id=$1 AND c.user_id=$2)"];
  if (context.companyId) where.push(`p.company_id=${bind(context.companyId)}`);
  if (input.companyId) where.push(`p.company_id=${bind(input.companyId)}`);
  if (input.status === "active") where.push("p.status<>'archived'");
  if (input.status === "archived") where.push("p.status='archived'");
  if (input.kind && input.kind !== "all") where.push(`p.kind=${bind(input.kind)}`);
  if (input.framework && input.framework !== "all") {
    const fw = "lower(coalesce(p.framework,''))";
    where.push(input.framework === "static" ? `(${fw} LIKE '%static%' OR ${fw} LIKE '%html%')` : `${fw} LIKE ${bind(`%${input.framework === "nextjs" ? "next" : input.framework}%`)}`);
  }
  if (input.search) where.push(`lower(p.name || ' ' || coalesce(p.description,'')) LIKE ${bind('%' + input.search.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%')}`);
  if (cursor) {
    const time = bind(cursor.time), id = bind(cursor.id);
    where.push(`p.updated_at <= ${time}::timestamptz AND (p.updated_at < ${time}::timestamptz OR p.id > ${id})`);
  }
  return { text: `SELECT p.id,p.company_id AS "companyId",p.name,p.description,p.type,p.kind,p.status,p.framework,p.revision,
    p.deployment_url AS "deploymentUrl",p.deployment_status AS "deploymentStatus",p.preview_url AS "previewUrl",p.preview_port AS "previewPort",
    to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
    EXISTS (SELECT 1 FROM project_qa_reports q WHERE q.workspace_id=p.workspace_id AND q.company_id=p.company_id AND q.project_id=p.id AND jsonb_typeof(q.screenshots)='array' AND jsonb_array_length(q.screenshots)>0) AS "hasThumbnail"
    FROM projects p WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC,p.id ASC LIMIT 25`, values };
}
export async function listProjectCatalog(pool: Pool, context: AuthContext, input: ProjectCatalogInput) {
  await assertMember(pool, context);
  if (input.companyId) await assertCompany(pool, context, input.companyId);
  return catalogPage(context, input, (await pool.query<ProjectCatalogItem>(projectCatalogQuery(context, input))).rows);
}
export async function findProjectByDomain(pool: Pool, domain: string): Promise<{ workspaceId: string; userId: string; companyId: string; projectId: string; previewPort?: number | null } | null> {
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!clean) return null;
  const res = await pool.query<{ workspaceId: string; userId: string; companyId: string; projectId: string; previewPort: number | null }>(
    `SELECT workspace_id AS "workspaceId", created_by AS "userId", company_id AS "companyId", id AS "projectId", preview_port AS "previewPort"
     FROM projects
     WHERE lower(regexp_replace(coalesce(deployment_url, ''), '^https?://|/.*$', '', 'g')) = $1
       AND status NOT IN ('archived', 'soft_deleted', 'purging', 'deleted')
     ORDER BY updated_at DESC LIMIT 1`,
    [clean],
  );
  return res.rows[0] ?? null;
}
