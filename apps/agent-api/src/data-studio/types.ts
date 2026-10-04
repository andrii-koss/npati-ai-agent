export type DataEnvironmentName = "dev" | "prod";
export type DataProviderKind = "shared_postgres" | "external_postgres";
export type DatabaseRole = "provisioner" | "migrator" | "runtime";

export interface DataBackend {
  id: string;
  workspaceId: string;
  companyId: string;
  createdBy: string;
  name: string;
  provider: DataProviderKind;
  status: "provisioning" | "ready" | "unavailable" | "archived" | "deleting";
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
  createdAt: string;
  updatedAt: string;
}

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
}

export interface ProjectDatabaseUsage {
  bytes: number;
  connections: number;
}
