import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { DataStudioError, bindFilter, quoteIdentifier, validateIdentifier } from "./identifier";
import type { DatabaseProvisioner } from "./provisioner";
import type { DataBackend, DataEnvironmentName } from "./types";

export type FieldType = "string" | "text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "json" | "uuid" | "enum" | "file_reference";
export interface FieldDefinition { name: string; type: FieldType; required?: boolean; default?: string | number | boolean | null; options?: string[]; }
export type SchemaOperation =
  | { kind: "create_collection"; collection: string; fields: FieldDefinition[] }
  | { kind: "drop_collection"; collection: string }
  | { kind: "rename_collection"; collection: string; next: string }
  | { kind: "add_field"; collection: string; field: FieldDefinition }
  | { kind: "alter_field"; collection: string; field: FieldDefinition }
  | { kind: "drop_field"; collection: string; field: string }
  | { kind: "create_relation"; collection: string; target: string; name: string; cardinality: "many-to-one" | "one-to-many" | "many-to-many" }
  | { kind: "drop_relation"; collection: string; name: string; cardinality: "many-to-one" | "one-to-many" | "many-to-many" }
  | { kind: "create_index"; collection: string; fields: string[]; unique?: boolean };
export interface SchemaChange {
  operation: string;
  upSql: string;
  downSql?: string;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
}
export interface DataFilter { field: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: unknown; }
export interface DataQuery { filters?: DataFilter[]; sort?: { field: string; direction: "asc" | "desc" }[]; limit?: number; offset?: number; }
export interface SchemaSnapshot { tables: Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean }>; constraints: string[]; indexes: string[]; rlsEnabled: boolean; rlsForced: boolean; policies: string[] }> }

export interface DataProvider {
  compileOperation(operation: SchemaOperation): SchemaChange;
  createCollection(name: string, fields: FieldDefinition[]): SchemaChange;
  dropCollection(name: string): SchemaChange;
  renameCollection(from: string, to: string): SchemaChange;
  addField(collection: string, field: FieldDefinition): SchemaChange;
  alterField(collection: string, field: FieldDefinition): SchemaChange;
  dropField(collection: string, field: string): SchemaChange;
  createRelation(source: string, target: string, name: string, cardinality: "many-to-one" | "one-to-many" | "many-to-many"): SchemaChange;
  dropRelation(source: string, name: string, cardinality?: "many-to-one" | "one-to-many" | "many-to-many"): SchemaChange;
  createIndex(collection: string, fields: string[], unique?: boolean): SchemaChange;
  assertLimits(operation: string, current: SchemaSnapshot, usageBytes: number, target?: string): void;
  introspectSchema(backend: DataBackend, environment: DataEnvironmentName): Promise<SchemaSnapshot>;
  schemaFingerprint(snapshot: SchemaSnapshot): string;
  detectDrift(backend: DataBackend, environment: DataEnvironmentName, expected: string): Promise<{ status: "synced" | "drift_detected"; actual: string; schema: SchemaSnapshot }>;
  list(backend: DataBackend, environment: DataEnvironmentName, collection: string, query?: DataQuery, userId?: string): Promise<Record<string, unknown>[]>;
  get(backend: DataBackend, environment: DataEnvironmentName, collection: string, id: string, userId?: string): Promise<Record<string, unknown> | null>;
  create(backend: DataBackend, environment: DataEnvironmentName, collection: string, values: Record<string, unknown>, userId?: string): Promise<Record<string, unknown>>;
  update(backend: DataBackend, environment: DataEnvironmentName, collection: string, id: string, values: Record<string, unknown>, userId?: string): Promise<Record<string, unknown> | null>;
  delete(backend: DataBackend, environment: DataEnvironmentName, collection: string, id: string, userId?: string): Promise<boolean>;
}

const sqlTypes: Record<FieldType, string> = {
  string: "varchar(255)", text: "text", integer: "bigint", decimal: "numeric(20,6)", boolean: "boolean",
  date: "date", datetime: "timestamptz", json: "jsonb", uuid: "uuid", enum: "text", file_reference: "uuid",
};

export class PostgresDataProvider implements DataProvider {
  private readonly pools = new Map<string, Pool>();
  readonly maxCollections: number;
  readonly maxFields: number;
  readonly maxRows: number;
  readonly maxDatabaseBytes: number;
  readonly maxQueriesPerMinute: number;
  private readonly requestCounts = new Map<string, { minute: number; count: number }>();

  constructor(limits: { maxCollections?: number; maxFields?: number; maxRows?: number; maxDatabaseBytes?: number; maxQueriesPerMinute?: number } = {}, private readonly provisioner?: DatabaseProvisioner) {
    this.maxCollections = limits.maxCollections ?? 50;
    this.maxFields = limits.maxFields ?? 100;
    this.maxRows = limits.maxRows ?? 100;
    this.maxDatabaseBytes = limits.maxDatabaseBytes ?? 1_000_000_000;
    this.maxQueriesPerMinute = limits.maxQueriesPerMinute ?? 600;
  }

  assertLimits(operation: string, current: SchemaSnapshot, usageBytes: number, target?: string): void {
    if (usageBytes >= this.maxDatabaseBytes) throw new DataStudioError(409, "quota", "Database size limit reached", false, "DATABASE_QUOTA");
    if (operation === "add_field" && (current.tables.find((table) => table.name === target)?.columns.length ?? 0) >= this.maxFields) {
      throw new DataStudioError(409, "quota", "Field limit reached", false, "FIELD_QUOTA");
    }
    if (operation === "create_collection" && current.tables.length >= this.maxCollections) {
      throw new DataStudioError(409, "quota", "Collection limit reached", false, "COLLECTION_QUOTA");
    }
  }

  private countQuery(backend: DataBackend, environment: DataEnvironmentName): void {
    const key = backend.id + ":" + environment;
    const minute = Math.floor(Date.now() / 60000);
    const previous = this.requestCounts.get(key);
    const count = previous?.minute === minute ? previous.count + 1 : 1;
    this.requestCounts.set(key, { minute, count });
    if (count > this.maxQueriesPerMinute) throw new DataStudioError(429, "query", "Query rate limit reached", true, "QUERY_LIMIT");
  }
  private fieldSql(field: FieldDefinition): string {
    const name = quoteIdentifier(field.name);
    const type = sqlTypes[field.type];
    if (!type || field.name === "id") throw new DataStudioError(400, "field", "Invalid field type or name", false, "INVALID_FIELD");
    if ((field.type === "enum" && (!field.options || field.options.length < 1 || field.options.length > 50)) || (field.options && (field.type !== "enum" ||
      field.options.some((value) => !/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(value))))) {
      throw new DataStudioError(400, "field", "Invalid enum options", false, "INVALID_ENUM");
    }
    let sql = name + " " + type + (field.required ? " NOT NULL" : "");
    if (field.default !== undefined && field.default !== null) {
      if (typeof field.default === "number" && Number.isFinite(field.default) && ["integer", "decimal"].includes(field.type)) sql += " DEFAULT " + String(field.default);
      else if (typeof field.default === "boolean" && field.type === "boolean") sql += " DEFAULT " + (field.default ? "true" : "false");
      else throw new DataStudioError(400, "field", "Unsupported field default", false, "INVALID_DEFAULT");
    }
    if (field.type === "enum") sql += " CHECK (" + name + " IN (" + field.options!.map((value) => "'" + value + "'").join(",") + "))";
    return sql;
  }

  compileOperation(operation: SchemaOperation): SchemaChange {
    switch (operation.kind) {
      case "create_collection": return this.createCollection(operation.collection, operation.fields);
      case "drop_collection": return this.dropCollection(operation.collection);
      case "rename_collection": return this.renameCollection(operation.collection, operation.next);
      case "add_field": return this.addField(operation.collection, operation.field);
      case "alter_field": return this.alterField(operation.collection, operation.field);
      case "drop_field": return this.dropField(operation.collection, operation.field);
      case "create_relation": return this.createRelation(operation.collection, operation.target, operation.name, operation.cardinality);
      case "drop_relation": return this.dropRelation(operation.collection, operation.name, operation.cardinality);
      case "create_index": return this.createIndex(operation.collection, operation.fields, operation.unique);
      default: throw new DataStudioError(400, "schema_operation", "Unsupported schema operation", false, "INVALID_OPERATION");
    }
  }
  createCollection(name: string, fields: FieldDefinition[]): SchemaChange {
    const table = quoteIdentifier(name);
    if (fields.length > this.maxFields || new Set(fields.map((field) => field.name)).size !== fields.length) throw new DataStudioError(400, "create_collection", "Field limit or duplicate field", false, "FIELD_LIMIT");
    const columns = fields.map((field) => this.fieldSql(field));
    return { operation: "create_collection",
      upSql: "CREATE TABLE " + table + " (id uuid PRIMARY KEY DEFAULT gen_random_uuid()" + (columns.length ? ", " + columns.join(", ") : "") + "); " +
        "ALTER TABLE " + table + " ENABLE ROW LEVEL SECURITY; ALTER TABLE " + table + " FORCE ROW LEVEL SECURITY;",
      downSql: "DROP TABLE " + table + ";", reversible: false, destructive: false, requiresSnapshot: false };
  }

  dropCollection(name: string): SchemaChange {
    const table = quoteIdentifier(name);
    return { operation: "drop_collection", upSql: "DROP TABLE " + table + ";", destructive: true, requiresSnapshot: true, reversible: false };
  }

  renameCollection(from: string, to: string): SchemaChange {
    const oldName = quoteIdentifier(from), next = quoteIdentifier(to);
    return { operation: "rename_collection", upSql: "ALTER TABLE " + oldName + " RENAME TO " + next + ";",
      downSql: "ALTER TABLE " + next + " RENAME TO " + oldName + ";", reversible: true, destructive: false, requiresSnapshot: false };
  }

  addField(collection: string, field: FieldDefinition): SchemaChange {
    const table = quoteIdentifier(collection), column = quoteIdentifier(field.name);
    return { operation: "add_field", upSql: "ALTER TABLE " + table + " ADD COLUMN " + this.fieldSql(field) + ";",
      downSql: "ALTER TABLE " + table + " DROP COLUMN " + column + ";", reversible: false, destructive: false, requiresSnapshot: false };
  }

  alterField(collection: string, field: FieldDefinition): SchemaChange {
    const table = quoteIdentifier(collection), column = quoteIdentifier(field.name), type = sqlTypes[field.type];
    if (!type || field.name === "id") throw new DataStudioError(400, "alter_field", "Invalid field", false, "INVALID_FIELD");
    return { operation: "alter_field", upSql: "ALTER TABLE " + table + " ALTER COLUMN " + column + " TYPE " + type + ";",
      destructive: true, requiresSnapshot: true, reversible: false };
  }

  dropField(collection: string, field: string): SchemaChange {
    if (field === "id") throw new DataStudioError(400, "drop_field", "Primary key cannot be dropped", false, "INVALID_FIELD");
    return { operation: "drop_field", upSql: "ALTER TABLE " + quoteIdentifier(collection) + " DROP COLUMN " + quoteIdentifier(field) + ";",
      destructive: true, requiresSnapshot: true, reversible: false };
  }

  createRelation(source: string, target: string, name: string, cardinality: "many-to-one" | "one-to-many" | "many-to-many"): SchemaChange {
    const src = quoteIdentifier(source), dst = quoteIdentifier(target), rel = quoteIdentifier(name);
    if (cardinality === "many-to-one" || cardinality === "one-to-many") {
      const many = cardinality === "many-to-one" ? src : dst;
      const one = cardinality === "many-to-one" ? dst : src;
      return { operation: "create_relation", upSql: "ALTER TABLE " + many + " ADD COLUMN " + rel + " uuid REFERENCES " + one + "(id);",
        downSql: "ALTER TABLE " + many + " DROP COLUMN " + rel + ";", reversible: false, destructive: false, requiresSnapshot: false };
    }
    if (cardinality !== "many-to-many") throw new DataStudioError(400, "relation", "Invalid cardinality", false, "INVALID_RELATION");
    return { operation: "create_relation", upSql: "CREATE TABLE " + rel + " (source_id uuid NOT NULL REFERENCES " + src + "(id), target_id uuid NOT NULL REFERENCES " + dst + "(id), PRIMARY KEY(source_id,target_id)); " +
      "ALTER TABLE " + rel + " ENABLE ROW LEVEL SECURITY; ALTER TABLE " + rel + " FORCE ROW LEVEL SECURITY;",
      downSql: "DROP TABLE " + rel + ";", reversible: false, destructive: false, requiresSnapshot: false };
  }

  dropRelation(source: string, name: string, cardinality: "many-to-one" | "one-to-many" | "many-to-many" = "many-to-one"): SchemaChange {
    return { operation: "drop_relation", upSql: cardinality === "many-to-many" ? "DROP TABLE " + quoteIdentifier(name) + ";" : "ALTER TABLE " + quoteIdentifier(source) + " DROP COLUMN " + quoteIdentifier(name) + ";",
      reversible: false, destructive: true, requiresSnapshot: true };
  }

  createIndex(collection: string, fields: string[], unique = false): SchemaChange {
    if (!fields.length || fields.length > 8) throw new DataStudioError(400, "index", "Invalid index fields", false, "INVALID_INDEX");
    const index = validateIdentifier(("idx_" + collection + "_" + fields.join("_")).slice(0, 63));
    return { operation: "create_index", upSql: "CREATE " + (unique ? "UNIQUE " : "") + "INDEX " + quoteIdentifier(index) + " ON " + quoteIdentifier(collection) +
      " (" + fields.map(quoteIdentifier).join(",") + ");", downSql: "DROP INDEX " + quoteIdentifier(index) + ";",
      reversible: true, destructive: false, requiresSnapshot: false };
  }

  private async pool(backend: DataBackend, environment: DataEnvironmentName): Promise<Pool> {
    if (!this.provisioner) throw new DataStudioError(503, "data_provider", "Project database not configured", true, "PROJECT_DATABASE_UNAVAILABLE");
    const key = backend.id + ":" + environment;
    let pool = this.pools.get(key);
    if (!pool) {
      const connection = await this.provisioner.getConnection(backend, environment, "runtime");
      pool = new Pool({ ...connection, max: 5, connectionTimeoutMillis: 3000 });
      this.pools.set(key, pool);
    }
    return pool;
  }

  private async transact<T>(backend: DataBackend, environment: DataEnvironmentName, userId: string | undefined, action: (client: PoolClient) => Promise<T>): Promise<T> {
    this.countQuery(backend, environment);
    const client = await (await this.pool(backend, environment)).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('npati.user_id',$1,true)", [userId ?? ""]);
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async list(backend: DataBackend, environment: DataEnvironmentName, collection: string, query: DataQuery = {}, userId?: string): Promise<Record<string, unknown>[]> {
    if ((query.filters?.length ?? 0) > 10 || (query.sort?.length ?? 0) > 5 ||
      (query.sort ?? []).some((item) => item.direction !== "asc" && item.direction !== "desc") ||
      !Number.isSafeInteger(query.offset ?? 0) || (query.offset ?? 0) > 1_000_000) {
      throw new DataStudioError(400, "query", "Query complexity limit exceeded", false, "QUERY_LIMIT");
    }
    const values: unknown[] = [];
    const filters = (query.filters ?? []).map((filter) => bindFilter(filter.field, filter.operator, filter.value, values));
    const order = (query.sort ?? []).map((item) => quoteIdentifier(item.field) + " " + (item.direction === "desc" ? "DESC" : "ASC"));
    const limit = Math.min(Math.max(1, query.limit ?? 50), this.maxRows);
    const offset = Math.max(0, query.offset ?? 0);
    values.push(limit, offset);
    const sql = "SELECT * FROM " + quoteIdentifier(collection) + (filters.length ? " WHERE " + filters.join(" AND ") : "") +
      (order.length ? " ORDER BY " + order.join(",") : "") + " LIMIT $" + (values.length - 1) + " OFFSET $" + values.length;
    return this.transact(backend, environment, userId, async (client) => (await client.query(sql, values)).rows);
  }

  async get(backend: DataBackend, environment: DataEnvironmentName, collection: string, id: string, userId?: string): Promise<Record<string, unknown> | null> {
    const rows = await this.list(backend, environment, collection, { filters: [{ field: "id", operator: "eq", value: id }], limit: 1 }, userId);
    return rows[0] ?? null;
  }

  async create(backend: DataBackend, environment: DataEnvironmentName, collection: string, values: Record<string, unknown>, userId?: string): Promise<Record<string, unknown>> {
    const fields = Object.keys(values);
    if (!fields.length || fields.length > this.maxFields || fields.includes("id")) throw new DataStudioError(400, "create_row", "Invalid row fields", false, "INVALID_ROW");
    const sql = "INSERT INTO " + quoteIdentifier(collection) + " (" + fields.map(quoteIdentifier).join(",") + ") VALUES (" +
      fields.map((_, i) => "$" + (i + 1)).join(",") + ") RETURNING *";
    return this.transact(backend, environment, userId, async (client) => (await client.query(sql, Object.values(values))).rows[0]);
  }

  async update(backend: DataBackend, environment: DataEnvironmentName, collection: string, id: string, values: Record<string, unknown>, userId?: string): Promise<Record<string, unknown> | null> {
    const fields = Object.keys(values);
    if (!fields.length || fields.length > this.maxFields || fields.includes("id")) throw new DataStudioError(400, "update_row", "Invalid row fields", false, "INVALID_ROW");
    const sql = "UPDATE " + quoteIdentifier(collection) + " SET " + fields.map((field, i) => quoteIdentifier(field) + "=$" + (i + 1)).join(",") +
      " WHERE id=$" + (fields.length + 1) + " RETURNING *";
    return this.transact(backend, environment, userId, async (client) => (await client.query(sql, [...Object.values(values), id])).rows[0] ?? null);
  }

  async delete(backend: DataBackend, environment: DataEnvironmentName, collection: string, id: string, userId?: string): Promise<boolean> {
    return this.transact(backend, environment, userId, async (client) => Boolean((await client.query("DELETE FROM " + quoteIdentifier(collection) + " WHERE id=$1", [id])).rowCount));
  }

  async introspectSchema(backend: DataBackend, environment: DataEnvironmentName): Promise<SchemaSnapshot> {
    const pool = await this.pool(backend, environment);
    const tables = await pool.query<{ name: string; rlsEnabled: boolean; rlsForced: boolean }>(
      'SELECT c.relname AS name,c.relrowsecurity AS "rlsEnabled",c.relforcerowsecurity AS "rlsForced" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace ' +
      "WHERE n.nspname='public' AND c.relkind='r' AND left(c.relname,7)<>'_npati_' ORDER BY c.relname",
    );
    const result: SchemaSnapshot = { tables: [] };
    for (const table of tables.rows) {
      const [columns, constraints, indexes, policies] = await Promise.all([
        pool.query<{ name: string; type: string; nullable: boolean }>(
          'SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid ' +
          "WHERE c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", [table.name]),
        pool.query<{ definition: string }>("SELECT conname || ':' || pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname", [table.name]),
        pool.query<{ definition: string }>("SELECT indexdef AS definition FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname", [table.name]),
        pool.query<{ definition: string }>("SELECT policyname || ':' || cmd || ':' || permissive || ':' || array_to_string(roles,',') || ':' || coalesce(qual,'') || ':' || coalesce(with_check,'') AS definition FROM pg_policies WHERE schemaname='public' AND tablename=$1 ORDER BY policyname", [table.name]),
      ]);
      result.tables.push({ ...table, columns: columns.rows, constraints: constraints.rows.map((row) => row.definition),
        indexes: indexes.rows.map((row) => row.definition), policies: policies.rows.map((row) => row.definition) });
    }
    return result;
  }

  schemaFingerprint(snapshot: SchemaSnapshot): string {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }

  async detectDrift(backend: DataBackend, environment: DataEnvironmentName, expected: string) {
    const schema = await this.introspectSchema(backend, environment);
    const actual = this.schemaFingerprint(schema);
    return { status: actual === expected ? "synced" as const : "drift_detected" as const, actual, schema };
  }

  async close() { await Promise.all([...this.pools.values()].map((pool) => pool.end())); }
}
