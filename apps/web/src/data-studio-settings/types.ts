import type { FieldDefinition, FieldType, SchemaOperation } from "../data-studio/types";

export type { FieldDefinition, FieldType, SchemaOperation };

export interface CompanySummary {
  id: string;
  name: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  type?: string;
  status?: string;
  framework?: string | null;
  dataBackendId?: string | null;
  /** Tagged on load: the Project list merges every company of the workspace. */
  companyId?: string;
}

export interface BackendSummary {
  id: string;
  name: string;
  provider: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  removeAfter?: string | null;
  /** Tagged on load: the database list merges every company of the workspace. */
  companyId: string;
  companyName: string;
}

export interface TransferResult {
  transferred: boolean;
  backendId: string;
  backendName: string;
  targetCompanyId: string;
  targetCompanyName: string;
  detachedProjects: number;
  environments: number;
}

export interface BackendEnvironment {
  environment: "dev" | "prod";
  status: string;
  syncStatus: string;
  schemaFingerprint?: string | null;
}

export interface QuotaReport {
  environment: string;
  usage: { bytes: number; connections: number };
  limits: { maxDatabaseBytes: number; maxConnections?: number };
  state: "ok" | "warning" | "exceeded";
  databasePercent: number;
  writesBlocked: boolean;
}

export interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableSummary {
  name: string;
  columns: TableColumn[];
  constraints: string[];
  indexes: string[];
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: string[];
}

export interface Overview {
  backend: { id: string; name: string; provider: string; status: string };
  environment: {
    environment: "dev" | "prod";
    status: string;
    syncStatus: "synced" | "drift_detected" | "reconciliation_required";
    schemaFingerprint?: string | null;
  };
  schema: { tables: TableSummary[] } | null;
  expectedSchema: unknown | null;
  drift: { actual: string; expected: string; tables: { added: string[]; removed: string[]; changed: string[] } } | null;
  lock: { held: boolean; createdAt?: string; expiresAt?: string };
  migrations: Array<{ id: string; version: number }>;
}

export interface TemplateCollection {
  name: string;
  fields: number;
  fieldNames: string[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  collections: TemplateCollection[];
}

export interface PreviewResult {
  operation: string;
  upSql: string;
  downSql?: string;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
  diff: { operation: SchemaOperation; beforeFingerprint: string; sql: string };
}

export interface AppliedMigration {
  id: string;
  version: number;
  fingerprint: string;
}

export type Feedback = { message: string; type: "success" | "info" | "error" };
export type DatabaseFilter = "all" | "ready" | "attention";

export const FIELD_TYPES: FieldType[] = ["string", "text", "integer", "decimal", "boolean", "date", "datetime", "json", "uuid", "enum"];
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const MAX_ROW_COUNT_TABLES = 50;
/** The list merges every company: table counts are only fetched for the visible slice. */
export const MAX_TABLE_COUNT_BACKENDS = 10;
/** Environment badges are one request per database, so very large workspaces skip the tail. */
export const MAX_ENVIRONMENT_BACKENDS = 30;
export const ALL_COMPANIES = "all";
