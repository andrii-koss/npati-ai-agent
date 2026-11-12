import type { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import { DataStudioError } from "./identifier";

export interface CatalogQuery {
  companyId?: string; search?: string; status?: "all" | "ready" | "attention"; cursor?: string; limit?: number;
}
interface CatalogItem {
  id: string; name: string; companyId: string; companyName: string; provider: string; status: string;
  createdAt: string; updatedAt: string; removeAfter: string | null; attachedProjectCount: number;
}
interface EnvironmentSummary {
  backendId: string; environment: "dev" | "prod"; status: string; syncStatus: string;
  schemaFingerprint: string | null; tableCount: number | null; measuredAt: string;
}
export interface CatalogStats {
  total: number; ready: number; attention: number; totalEnvironments: number; readyEnvironments: number;
  tables: number | null; tableCountsKnown: number; attachedProjects: number; totalProjects: number;
}
export interface CatalogPage {
  companies: Array<{ id: string; name: string }>;
  items: Array<CatalogItem & { environments: EnvironmentSummary[]; tableCount: number | null }>;
  stats: CatalogStats; pagination: { total: number; nextCursor: string | null };
}

const owned = `WITH owned AS (
  SELECT b.*, c.name AS company_name FROM data_backends b
  JOIN companies c ON c.id=b.company_id AND c.workspace_id=b.workspace_id
  WHERE b.workspace_id=$1 AND b.created_by=$2 AND c.user_id=$2
    AND ($3::text IS NULL OR b.company_id=$3::text)
)`;
const filtered = `($4='' OR b.name ILIKE $4 OR b.company_name ILIKE $4 OR b.provider ILIKE $4)
  AND ($5='all' OR ($5='ready' AND b.status='ready') OR ($5='attention' AND b.status<>'ready'))`;
const tableCount = `CASE WHEN jsonb_typeof(e.expected_schema->'tables')='array'
  THEN jsonb_array_length(e.expected_schema->'tables') ELSE NULL END`;

/** Reads only Core metadata. No project-database connections, schema inspections or secrets. */
export async function readDataStudioCatalog(pool: Pick<Pool, "query">, ctx: AuthContext, input: CatalogQuery): Promise<CatalogPage> {
  const companyId = input.companyId || null;
  const search = (input.search ?? "").trim();
  const status = input.status ?? "all";
  const limit = input.limit ?? 10;
  if (search.length > 200 || !["all", "ready", "attention"].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new DataStudioError(400, "catalog", "Invalid catalog query", false, "INVALID_CATALOG_QUERY");
  }
  const scope = JSON.stringify([companyId, search, status]);
  let cursor: { createdAt: string; id: string; scope: string } | null = null;
  if (input.cursor) {
    try {
      if (input.cursor.length > 2048) throw new Error();
      cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (!cursor || cursor.scope !== scope || typeof cursor.createdAt !== "string" || cursor.createdAt.length > 80
        || !Number.isFinite(Date.parse(cursor.createdAt)) || typeof cursor.id !== "string"
        || !/^[A-Za-z0-9_-]{1,128}$/.test(cursor.id)) throw new Error();
    } catch { throw new DataStudioError(400, "catalog", "Invalid catalog cursor", false, "INVALID_CURSOR"); }
  }
  const companies = (await pool.query<{ id: string; name: string }>(
    "SELECT id,name FROM companies WHERE workspace_id=$1 AND user_id=$2 ORDER BY name,id", [ctx.workspaceId, ctx.userId],
  )).rows;
  if (companyId && !companies.some(company => company.id === companyId)) {
    throw new DataStudioError(404, "catalog", "Company not found", false, "COMPANY_NOT_FOUND");
  }
  const values = [ctx.workspaceId, ctx.userId, companyId];
  const filterValues = [...values, search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : "", status];
  const [page, count, statistics] = await Promise.all([
    pool.query<CatalogItem>(`${owned}
      SELECT b.id,b.name,b.company_id AS "companyId",b.company_name AS "companyName",b.provider,b.status,
        b.created_at::text AS "createdAt",b.updated_at::text AS "updatedAt",b.remove_after::text AS "removeAfter",
        (SELECT count(*)::int FROM projects p WHERE p.workspace_id=$1 AND p.created_by=$2
          AND p.company_id=b.company_id AND p.data_backend_id=b.id AND p.status<>'archived') AS "attachedProjectCount"
      FROM owned b WHERE ${filtered}
        AND ($6::timestamptz IS NULL OR (b.created_at,b.id)<($6::timestamptz,$7::text))
      ORDER BY b.created_at DESC,b.id DESC LIMIT $8`,
    [...filterValues, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]),
    pool.query<{ total: number }>(`${owned} SELECT count(*)::int AS total FROM owned b WHERE ${filtered}`, filterValues),
    pool.query<CatalogStats>(`${owned}, environment_stats AS (
      SELECT e.backend_id, count(*)::int AS total, count(*) FILTER (WHERE e.status='ready')::int AS ready,
        max(${tableCount}) FILTER (WHERE e.environment='dev') AS tables
      FROM data_backend_environments e JOIN owned b ON b.id=e.backend_id
        AND b.workspace_id=e.workspace_id AND b.company_id=e.company_id GROUP BY e.backend_id
    ), project_stats AS (
      SELECT count(*)::int AS total, count(*) FILTER (WHERE p.data_backend_id IS NOT NULL)::int AS attached
      FROM projects p JOIN companies c ON c.id=p.company_id AND c.workspace_id=p.workspace_id
      WHERE p.workspace_id=$1 AND p.created_by=$2 AND c.user_id=$2 AND p.status<>'archived'
        AND ($3::text IS NULL OR p.company_id=$3::text)
    ) SELECT count(*)::int AS total, count(*) FILTER (WHERE b.status='ready')::int AS ready,
      count(*) FILTER (WHERE b.status<>'ready')::int AS attention,
      coalesce(sum(e.total),0)::int AS "totalEnvironments", coalesce(sum(e.ready),0)::int AS "readyEnvironments",
      sum(e.tables)::int AS tables, count(e.tables)::int AS "tableCountsKnown",
      (SELECT attached FROM project_stats) AS "attachedProjects", (SELECT total FROM project_stats) AS "totalProjects"
      FROM owned b LEFT JOIN environment_stats e ON e.backend_id=b.id`, values),
  ]);
  const rows = page.rows.slice(0, limit);
  const ids = rows.map(row => row.id);
  const environments = ids.length ? (await pool.query<EnvironmentSummary>(`
    SELECT e.backend_id AS "backendId",e.environment,e.status,e.sync_status AS "syncStatus",
      e.schema_fingerprint AS "schemaFingerprint",${tableCount} AS "tableCount",e.updated_at::text AS "measuredAt"
    FROM data_backend_environments e JOIN data_backends b ON b.id=e.backend_id
      AND b.workspace_id=e.workspace_id AND b.company_id=e.company_id
    WHERE b.workspace_id=$1 AND b.created_by=$2 AND b.id=ANY($3::text[]) ORDER BY e.backend_id,e.environment`,
  [ctx.workspaceId, ctx.userId, ids])).rows : [];
  const last = rows.at(-1);
  return {
    companies,
    items: rows.map(row => {
      const list = environments.filter(env => env.backendId === row.id);
      return { ...row, environments: list, tableCount: list.find(env => env.environment === "dev")?.tableCount ?? null };
    }),
    stats: statistics.rows[0]!,
    pagination: { total: count.rows[0]?.total ?? 0, nextCursor: page.rows.length > limit && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id, scope })).toString("base64url") : null },
  };
}

export async function readDataStudioWorkspace(pool: Pick<Pool, "query">, ctx: AuthContext, companyId: string, backendId: string) {
  const backend = (await pool.query<CatalogItem>(`${owned}
    SELECT b.id,b.name,b.company_id AS "companyId",b.company_name AS "companyName",b.provider,b.status,
      b.created_at::text AS "createdAt",b.updated_at::text AS "updatedAt",b.remove_after::text AS "removeAfter"
    FROM owned b WHERE b.id=$4::text`, [ctx.workspaceId, ctx.userId, companyId, backendId])).rows[0];
  if (!backend) throw new DataStudioError(404, "workspace", "Database not found", false, "BACKEND_NOT_FOUND");
  const [projects, environments] = await Promise.all([
    pool.query(`SELECT id,name,type,status,company_id AS "companyId",data_backend_id AS "dataBackendId"
      FROM projects WHERE workspace_id=$1 AND created_by=$2 AND company_id=$3 AND status<>'archived'
      ORDER BY created_at DESC,id`, [ctx.workspaceId, ctx.userId, companyId]),
    pool.query<EnvironmentSummary>(`SELECT e.backend_id AS "backendId",e.environment,e.status,e.sync_status AS "syncStatus",
      e.schema_fingerprint AS "schemaFingerprint",${tableCount} AS "tableCount",e.updated_at::text AS "measuredAt"
      FROM data_backend_environments e WHERE e.workspace_id=$1 AND e.company_id=$2 AND e.backend_id=$3 ORDER BY e.environment`,
    [ctx.workspaceId, companyId, backendId]),
  ]);
  return { backend, projects: projects.rows, environments: environments.rows };
}
