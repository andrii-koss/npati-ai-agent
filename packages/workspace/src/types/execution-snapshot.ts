export type ExecutionSnapshotTrigger =
  | "session_start"
  | "run_start"
  | "config_change"
  | "resume"
  | "recovery";

export type SnapshotConfigKind = "system_prompt" | "model_profiles";

export interface ExecutionSnapshotRecord {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string | null;
  snapshotVersion: number;
  payload: Record<string, unknown>;
  payloadHash: string;
  prevSnapshotId: string | null;
  prevPayloadHash: string | null;
  trigger: ExecutionSnapshotTrigger;
  legacy: boolean;
  createdAt: Date;
  createdBy: string;
}

export interface CreateExecutionSnapshotInput {
  companyId: string;
  workspaceId: string;
  projectId: string;
  sessionId: string;
  runId?: string | null;
  payload: Record<string, unknown>;
  trigger: ExecutionSnapshotTrigger;
  createdBy: string;
  legacy?: boolean;
  /** Injectable clock so tests never depend on wall time. */
  now?: Date;
  /** Injectable id generator; production uses a random id, tests use a deterministic one. */
  id?: string;
}

export interface ListExecutionSnapshotsInput {
  companyId: string;
  sessionId?: string;
  projectId?: string;
  limit: number;
}

export interface SnapshotFieldChange {
  field: string;
  /** Rendered as a short, secret-free string ("v1 -> v2", "false -> true", "changed", "added", "removed"). */
  from: string;
  to: string;
}

export interface ExecutionSnapshotDiff {
  fromSnapshotId: string;
  toSnapshotId: string;
  fromVersion: number;
  toVersion: number;
  changes: SnapshotFieldChange[];
  unchanged: string[];
}

export interface SnapshotConfigVersionRecord {
  id: string;
  workspaceId: string;
  companyId: string;
  kind: SnapshotConfigKind;
  version: number;
  contentHash: string;
  content: Record<string, unknown>;
  createdAt: Date;
  createdBy: string;
}

export interface CreateSnapshotConfigVersionInput {
  companyId: string;
  workspaceId: string;
  kind: SnapshotConfigKind;
  content: Record<string, unknown>;
  contentHash: string;
  createdBy: string;
  now?: Date;
  id?: string;
}

/** Raised when a caller tries to mutate an append-only snapshot or config version. */
export class ExecutionSnapshotImmutableError extends Error {
  readonly code = "snapshot_immutable";
  readonly httpStatus = 409;
  constructor(operation: string) {
    super(`Execution snapshots are append-only: ${operation} is not permitted`);
    this.name = "ExecutionSnapshotImmutableError";
  }
}

// --- C6b Activity event persistence -------------------------------------------------------------------

/**
 * The Activity event families the Coding Agent produces. The database CHECK states the same vocabulary in
 * migration 077, so an unknown kind cannot be persisted even by a direct SQL write.
 */
