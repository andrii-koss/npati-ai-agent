export class DataStudioError extends Error {
  constructor(
    readonly status: number,
    readonly step: string,
    message: string,
    readonly retryable = false,
    readonly code = "DATA_STUDIO_ERROR",
  ) { super(message); this.name = "DataStudioError"; }
}

const reserved = new Set([
  "all", "and", "as", "asc", "by", "case", "check", "column", "constraint", "create", "cross",
  "current_user", "date", "default", "delete", "desc", "distinct", "drop", "else", "end", "except",
  "exists", "false", "for", "foreign", "from", "full", "grant", "group", "having", "in", "index",
  "inner", "insert", "into", "is", "join", "key", "left", "limit", "not", "null", "offset", "on",
  "or", "order", "outer", "primary", "references", "returning", "right", "schema", "select",
  "set", "table", "then", "to", "true", "union", "unique", "update", "user", "using", "values",
  "when", "where", "with",
  "authorization", "binary", "both", "collation", "concurrently", "current_catalog", "current_date", "current_role",
  "current_schema", "current_time", "current_timestamp", "current_user", "do", "fetch", "freeze", "ilike",
  "initially", "lateral", "leading", "localtime", "localtimestamp", "natural", "notnull", "offset", "only",
  "overlaps", "placing", "returning", "session_user", "similar", "some", "symmetric", "tablesample",
  "trailing", "treat", "variadic", "verbose", "window",
]);

export function validateIdentifier(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value) ||
    reserved.has(value) || value.startsWith("_npati_") || value.startsWith("pg_") ||
    value.startsWith("information_schema")) {
    throw new DataStudioError(400, "validate_identifier", "Invalid database identifier", false, "INVALID_IDENTIFIER");
  }
  return value;
}

export function quoteIdentifier(value: string): string {
  return '"' + validateIdentifier(value) + '"';
}

export function bindFilter(field: string, operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte", value: unknown, values: unknown[]): string {
  const op = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[operator];
  if (!op) throw new DataStudioError(400, "filter", "Invalid filter operator", false, "INVALID_FILTER");
  values.push(value);
  return quoteIdentifier(field) + " " + op + " $" + values.length;
}
