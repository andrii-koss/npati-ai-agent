import type { PoolClient } from "pg";
import { DataStudioError, bindFilter, quoteIdentifier, validateIdentifier } from "./identifier";
import type { GatewayAuthResult, GatewayListOptions } from "./gateway-types";

/** Query complexity bounds for public Project API requests. */
export const MAX_FILTER_CLAUSES = 10;
export const MAX_SORT_CLAUSES = 5;
export const MAX_SELECT_FIELDS = 50;
export const MAX_RELATION_INCLUDES = 5;

export function assertQueryBounds(options: { filter?: unknown; sort?: unknown; fields?: string[]; include?: string[] }): void {
  const filters = Array.isArray(options.filter) ? options.filter.length : options.filter ? Object.keys(options.filter as Record<string, unknown>).length : 0;
  if (filters > MAX_FILTER_CLAUSES) throw new DataStudioError(400, "gateway", `At most ${MAX_FILTER_CLAUSES} filters are allowed`, false, "INVALID_FILTER");
  const sorts = Array.isArray(options.sort) ? options.sort.length : options.sort ? 1 : 0;
  if (sorts > MAX_SORT_CLAUSES) throw new DataStudioError(400, "gateway", `At most ${MAX_SORT_CLAUSES} sort clauses are allowed`, false, "INVALID_QUERY");
  if ((options.fields?.length ?? 0) > MAX_SELECT_FIELDS) throw new DataStudioError(400, "gateway", `At most ${MAX_SELECT_FIELDS} fields may be selected`, false, "INVALID_QUERY");
  if ((options.include?.length ?? 0) > MAX_RELATION_INCLUDES) throw new DataStudioError(400, "gateway", `At most ${MAX_RELATION_INCLUDES} relations may be included`, false, "INVALID_QUERY");
}

export function buildFilterClauses(filter: GatewayListOptions["filter"], values: unknown[]): string[] {
  const filterClauses: string[] = [];
  if (!filter) return filterClauses;
  if (Array.isArray(filter)) {
    for (const item of filter) {
      validateIdentifier(item.field);
      filterClauses.push(bindFilter(item.field, item.operator, item.value, values));
    }
  } else {
    for (const [key, val] of Object.entries(filter)) {
      validateIdentifier(key);
      filterClauses.push(bindFilter(key, "eq", val, values));
    }
  }
  return filterClauses;
}

export function buildOrderClauses(sort: GatewayListOptions["sort"]): string[] {
  const orderClauses: string[] = [];
  if (sort) {
    const items = Array.isArray(sort) ? sort : [sort];
    for (const item of items) {
      if (typeof item === "string") {
        const [field, dir = "asc"] = item.split(":");
        validateIdentifier(field!);
        const direction = dir?.toLowerCase() === "desc" ? "DESC" : "ASC";
        orderClauses.push(`${quoteIdentifier(field!)} ${direction}`);
      } else {
        validateIdentifier(item.field);
        orderClauses.push(`${quoteIdentifier(item.field)} ${item.direction === "desc" ? "DESC" : "ASC"}`);
      }
    }
  }
  if (!orderClauses.length) {
    orderClauses.push(`${quoteIdentifier("id")} ASC`);
  }
  return orderClauses;
}

export async function expandRelations(
  auth: GatewayAuthResult,
  client: PoolClient,
  collection: string,
  rows: Record<string, unknown>[],
  relationNames: string[],
  authorizeCollection: (auth: GatewayAuthResult, targetTable: string, action: "select") => Promise<void>,
): Promise<Record<string, unknown>[]> {
  for (const rel of relationNames) {
    const targetRelation = rel.trim();
    validateIdentifier(targetRelation);

    // Check foreign key column pattern e.g. "category" -> "category_id"
    const fkCandidate = `${targetRelation}_id`;
    const hasFk = rows.some((r) => r[fkCandidate] !== undefined);

    if (hasFk) {
      // Collect target IDs
      const ids = [...new Set(rows.map((r) => r[fkCandidate]).filter((id) => id !== null && id !== undefined))];
      if (ids.length) {
        const plural = targetRelation.endsWith("s") ? targetRelation : `${targetRelation}s`;
        const targetTable = (await client.query<{ exists: boolean }>(
          "SELECT to_regclass($1) IS NOT NULL AS exists", [plural],
        )).rows[0]?.exists ? plural : targetRelation;
        await authorizeCollection(auth, targetTable, "select");
        const relRes = await client.query(
          `SELECT * FROM ${quoteIdentifier(targetTable)} WHERE id = ANY($1)`, [ids],
        );
        const lookup = new Map(relRes.rows.map((r: Record<string, unknown>) => [String(r.id), r]));
        for (const row of rows) {
          const fkVal = row[fkCandidate];
          row[targetRelation] = fkVal ? lookup.get(String(fkVal)) || null : null;
        }
      }
    }
  }
  return rows;
}
