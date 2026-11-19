import type { Pool } from "pg";
import {
  countMemoryTypes, MEMORY_CATEGORIES, MEMORY_PAGE_SIZE, memoryPageCursor, type MemoryPageData, type MemoryPageQuery,
} from "./memory-page";
import { memoryColumns } from "./postgres-store-schema";
import { assertMember, businessCredentialScopeSql, getBusiness } from "./postgres-store-support";
import type { AuthContext, MemoryItem } from "./types";

export async function listMemoryPage(pool: Pool, context: AuthContext, query: MemoryPageQuery): Promise<MemoryPageData> {
  const limit = query.limit ?? MEMORY_PAGE_SIZE;
  if (query.businessId) await getBusiness(pool, context, query.businessId);
  else await assertMember(pool, context);
  const result = await pool.query<{ items: MemoryItem[]; counts: Record<string, number> | null; matchingTotal: number | null }>(
    `WITH scope AS MATERIALIZED (
      SELECT id, type, updated_at
      FROM memory_items
      WHERE workspace_id=$1 AND business_id IN (
        SELECT id FROM businesses WHERE workspace_id=$1 AND owner_user_id=$2
          AND ${businessCredentialScopeSql(3)}
          AND (($4::text IS NULL AND activation_status='active') OR id=$4)
      )
    ), matching AS (
        SELECT id, updated_at FROM scope
        WHERE ($5::text[] IS NULL OR type=ANY($5))
          AND ($6::text IS NULL OR type=ANY($7::text[]) OR EXISTS (
            SELECT 1 FROM memory_items AS entry WHERE entry.id=scope.id
              AND (strpos(lower(entry.title), lower($6)) > 0 OR strpos(lower(entry.content), lower($6)) > 0
                OR strpos(lower(entry.source), lower($6)) > 0)
          ))
    ), page AS (
      SELECT ${memoryColumns} FROM memory_items WHERE id IN (
        SELECT id FROM matching
        WHERE ($8::timestamptz IS NULL OR (date_trunc('milliseconds',updated_at), id) < ($8,$9::text))
        ORDER BY date_trunc('milliseconds',updated_at) DESC, id DESC LIMIT $10
      )
    )
    SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY date_trunc('milliseconds',"updatedAt") DESC, id DESC), '[]'::jsonb) FROM page) AS items,
      CASE WHEN $8::timestamptz IS NULL THEN (SELECT count(*)::int FROM matching) END AS "matchingTotal",
      CASE WHEN $8::timestamptz IS NULL THEN (
        SELECT COALESCE(jsonb_object_agg(type, total), '{}'::jsonb)
        FROM (SELECT type, count(*) AS total FROM scope GROUP BY type) AS by_type
      ) END AS counts`,
    [context.workspaceId, context.userId, context.companyId ?? null, query.businessId ?? null,
      query.category ? MEMORY_CATEGORIES[query.category] : null, query.search || null, query.searchTypes ?? [],
      query.after?.updatedAt ?? null, query.after?.id ?? null, limit + 1],
  );
  const { items, counts, matchingTotal } = result.rows[0]!;
  const page = items.slice(0, limit);
  return {
    items: page,
    counts: counts && countMemoryTypes(new Map(Object.entries(counts))),
    ...(matchingTotal === null ? {} : { matchingTotal }),
    nextCursor: items.length > limit ? memoryPageCursor(page.at(-1)!) : null,
  };
}
