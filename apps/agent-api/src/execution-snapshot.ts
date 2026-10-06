/**
 * C6: the `ExecutionSnapshotProvider` seam.
 *
 * Every run must have an ExecutionSnapshot (rule 19) and every Activity event must reference it (C6b).
 * C6 does **not** implement the snapshot itself: it declares the interface, uses a `NullSnapshotProvider`
 * (which yields the empty id, i.e. "no snapshot available yet") and threads the id through the events it
 * writes. C6b replaces the provider with the real implementation and nothing else has to change.
 *
 * The id is optional everywhere it is used, which keeps every already-persisted event shape valid.
 */

export interface ExecutionSnapshotRef {
  snapshotId: string;
}

export interface ExecutionSnapshotCreateInput {
  companyId: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  /** The actor that started the run (a user, never the agent). */
  actor: string;
  agentId?: string;
}

export interface ExecutionSnapshotProvider {
  create(input: ExecutionSnapshotCreateInput): Promise<ExecutionSnapshotRef>;
}

/** The C6 placeholder: an honest empty id rather than a fabricated one. */
export const EMPTY_SNAPSHOT_ID = "";

export class NullSnapshotProvider implements ExecutionSnapshotProvider {
  async create(): Promise<ExecutionSnapshotRef> {
    return { snapshotId: EMPTY_SNAPSHOT_ID };
  }
}

/**
 * Never returns `undefined`: a missing provider means "no snapshot support in this deployment", which is
 * exactly what the null provider expresses. A run therefore cannot fail because C6b is not wired yet.
 */
export function resolveExecutionSnapshotProvider(
  provider?: ExecutionSnapshotProvider | null,
): ExecutionSnapshotProvider {
  return provider ?? new NullSnapshotProvider();
}

/** True when a snapshot id is usable (non-empty). Callers may attach `snapshotId` only when this holds. */
export function hasSnapshotId(snapshotId: string | undefined | null): snapshotId is string {
  return typeof snapshotId === "string" && snapshotId.length > 0;
}
