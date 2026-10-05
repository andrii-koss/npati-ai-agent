export type DataEnvironmentName = "dev" | "prod";
export type DataProviderKind = "shared_postgres" | "external_postgres";
export type DatabaseRole = "provisioner" | "migrator" | "runtime";
/** Roles whose credentials can live in Core secret storage (D7 adds external database owners). */
export type StoredDatabaseRole = "migrator" | "runtime" | "signing" | "external_admin" | "external_owner";

export interface DataBackend {
  id: string;
  workspaceId: string;
  companyId: string;
  createdBy: string;
  name: string;
  provider: DataProviderKind;
  status: "provisioning" | "ready" | "unavailable" | "archived" | "deleting";
  /** Two-phase removal: set when the backend is scheduled for purge after snapshot retention. */
  removeAfter?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataBackendEnvironment {
  id: string;
  workspaceId: string;
  companyId: string;
  backendId: string;
  environment: DataEnvironmentName;
  providerConfig: Record<string, unknown>;
  migratorSecretRef?: string | null;
  runtimeSecretRef?: string | null;
  signingKeyRef?: string | null;
  status: "provisioning" | "ready" | "unavailable" | "archived";
  schemaFingerprint?: string | null;
  expectedSchema?: unknown | null;
  syncStatus: "synced" | "drift_detected" | "reconciliation_required";
  /** Quota overrides for this environment (see QuotaService). */
  limits?: Record<string, number>;
  /** Backup schedule for this environment (see BackupService). */
  backupPolicy?: BackupPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface BackupPolicy {
  /** Interval between automatic snapshots in minutes; 0 disables scheduled backups. */
  intervalMinutes?: number;
  /** How many automatic snapshots to keep (manual and pre-migration ones use retention days). */
  keep?: number;
}

export type SnapshotKind = "manual" | "scheduled" | "pre_migration" | "pre_promote" | "pre_restore";

export interface ProjectDatabaseConnection {
  database: string;
  host: string;
  port: number;
  user: string;
  password: string;
  ssl?: boolean;
}

export interface ProjectSnapshot {
  id: string;
  backendId: string;
  environment: DataEnvironmentName;
  path: string;
  createdAt: string;
  kind?: SnapshotKind;
  reason?: string | null;
  sizeBytes?: number | null;
}

export interface ProjectDatabaseUsage {
  bytes: number;
  connections: number;
}

export interface DataBackendPromotion {
  id: string;
  workspaceId: string;
  companyId: string;
  backendId: string;
  targetEnvironment: DataEnvironmentName;
  status: "previewed" | "applied" | "failed" | "rejected";
  diff: unknown[];
  flags: { destructive: boolean; requiresSnapshot: boolean; reversible: boolean; collections: number; withData: boolean };
  snapshotRef?: string | null;
  withData: boolean;
  approvedBy?: string | null;
  error?: string | null;
  createdAt: string;
  appliedAt?: string | null;
}
