export type FieldType =
  | "string"
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "json"
  | "uuid"
  | "enum"
  | "file_reference";

export interface FieldDefinition {
  name: string;
  type: FieldType;
  required?: boolean;
  default?: string | number | boolean | null;
  options?: string[];
}

export type RelationCardinality = "many-to-one" | "one-to-many" | "many-to-many";

export type SchemaOperation =
  | { kind: "create_collection"; collection: string; fields: FieldDefinition[] }
  | { kind: "drop_collection"; collection: string }
  | { kind: "rename_collection"; collection: string; next: string }
  | { kind: "add_field"; collection: string; field: FieldDefinition }
  | { kind: "alter_field"; collection: string; field: FieldDefinition }
  | { kind: "drop_field"; collection: string; field: string }
  | { kind: "create_relation"; collection: string; target: string; name: string; cardinality: RelationCardinality }
  | { kind: "drop_relation"; collection: string; name: string; cardinality: RelationCardinality }
  | { kind: "create_index"; collection: string; fields: string[]; unique?: boolean };

export interface SchemaSnapshot {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; nullable: boolean }>;
    constraints: string[];
    indexes: string[];
    rlsEnabled: boolean;
    rlsForced: boolean;
    policies: string[];
  }>;
}

export interface MigrationItem {
  id: string;
  version: number;
  operation: SchemaOperation;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
  authorId: string;
  runId?: string | null;
  status: string;
  createdAt: string;
  appliedAt?: string | null;
}

export interface OverviewData {
  backend: { id: string; name: string; status: string; provider: string };
  environment: {
    environment: "dev" | "prod";
    status: string;
    syncStatus: "synced" | "drift_detected" | "reconciliation_required";
    schemaFingerprint?: string | null;
  };
  schema: SchemaSnapshot | null;
  expectedSchema: unknown | null;
  drift: {
    actual: string;
    expected: string;
    tables: { added: string[]; removed: string[]; changed: string[] };
  } | null;
  lock: { held: boolean; createdAt?: string; expiresAt?: string; ownerToken?: string };
  migrations: MigrationItem[];
}

export interface PreviewDiff {
  operation: string;
  upSql: string;
  downSql?: string;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
  diff: { operation: SchemaOperation; beforeFingerprint: string; sql: string };
}

export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export interface FilterItem {
  field: string;
  operator: FilterOperator;
  value: string;
}
