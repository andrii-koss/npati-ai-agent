import type { DataClassification, RetentionClass } from "./retention";

export type CodeActivityEventKind =
  | "code_tool_activity"
  | "policy_decision"
  | "network_decision"
  | "run_activity"
  | "run_reconcile";

export interface CodeActivityEventRecord {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string | null;
  sessionId: string | null;
  runId: string | null;
  /** Snapshot this event belongs to; `null` for events produced before C6b or outside a run. */
  snapshotId: string | null;
  /**
   * C12: the run that delegated this event's run, or `null` for a main run's own event. A **column**, not a
   * payload key, because the delegation tree has to be queryable as a tree: an operator asking "what did the
   * children of this run do" must not have to walk every payload in the tenant. Without it the tree was
   * invisible — every event carried a `run_id` and nothing said which run it belonged *under*.
   */
  parentRunId: string | null;
  /** C12: the `code.agent.spawn` tool call that started this child run. */
  parentToolCallId: string | null;
  /**
   * C12: the Activity event of the parent that this event hangs under, when the recorder knows it. Optional on
   * purpose: it is an ordering convenience, while `parentRunId`/`parentToolCallId` are the identity.
   */
  parentEventId: string | null;
  kind: CodeActivityEventKind;
  /** Metadata only. Content-like keys are rejected before the insert (see `code-run-activity-sink.ts`). */
  payload: Record<string, unknown>;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
  createdAt: Date;
}

export interface CreateCodeActivityEventInput {
  companyId: string;
  workspaceId: string;
  projectId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  snapshotId?: string | null;
  /** C12: the delegation tree. All three are optional so every pre-C12 writer keeps working unchanged. */
  parentRunId?: string | null;
  parentToolCallId?: string | null;
  parentEventId?: string | null;
  kind: CodeActivityEventKind;
  payload: Record<string, unknown>;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface ListCodeActivityEventsInput {
  companyId: string;
  sessionId?: string;
  runId?: string;
  snapshotId?: string;
  /** C12: every event of the children a run delegated, i.e. one level of the delegation tree. */
  parentRunId?: string;
  limit?: number;
  cursor?: string;
}

/** C8: the structured summary produced by conversation compaction (see `code-conversation-compaction.ts`). */
export interface CodeContextSummaryRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string | null;
  runId: string | null;
  snapshotId: string | null;
  turnIndex: number;
  schemaVersion: number;
  summary: Record<string, unknown>;
  summaryText: string;
  contentHash: string;
  dataClassification: DataClassification;
  /** Deliberately shorter than the transcript: a summary is derived, so outliving its source buys nothing. */
  retentionClass: RetentionClass;
  createdAt: Date;
}

export interface CreateCodeContextSummaryInput {
  companyId: string;
  projectId: string;
  sessionId?: string | null;
  runId?: string | null;
  snapshotId?: string | null;
  turnIndex?: number;
  schemaVersion: number;
  summary: Record<string, unknown>;
  summaryText: string;
  contentHash: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface ListCodeContextSummariesInput {
  companyId: string;
  sessionId?: string;
  runId?: string;
  limit?: number;
}

/**
 * Keyset cursor for activity reads: `(created_at, id)`, so paging never depends on an offset that shifts
 * while new events are appended. Malformed input is rejected instead of silently restarting from page one.
 */
export function encodeCodeActivityCursor(input: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: input.createdAt.toISOString(), i: input.id }), "utf8").toString("base64url");
}

// --- C6b replay bundle DTOs ---------------------------------------------------------------------------

/**
 * How a bundle may be replayed. `recorded` is the deterministic one: every model answer and every settled
 * tool result is present, so the same sequence is reproducible. `live_best_effort` means the run is re-issued
 * against a live model: the model, package registries, GitHub and third-party services can all have changed
 * since, so an identical outcome is **not** guaranteed and callers must say so.
 */
