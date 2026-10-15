/**
 * Data classification and retention classes (C1). The enums live here so every entity created in
 * C1-C6 carries both fields; the real retention windows are decided in R1.
 */
export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export const DATA_CLASSIFICATIONS: readonly DataClassification[] = ["public", "internal", "confidential", "restricted"] as const;
export const DEFAULT_DATA_CLASSIFICATION: DataClassification = "confidential";
export type RetentionClass = "ephemeral" | "short" | "standard" | "extended" | "until_deleted";
export const RETENTION_CLASSES: readonly RetentionClass[] = ["ephemeral", "short", "standard", "extended", "until_deleted"] as const;
export const DEFAULT_RETENTION_CLASS: RetentionClass = "standard";

const classificationRank: Record<DataClassification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
/** True when `value` is at least as strict as `floor`. */
export function isClassificationAtLeast(value: DataClassification, floor: DataClassification): boolean {
  return classificationRank[value] >= classificationRank[floor];
}
/** Returns the stricter of two classifications (used for inheritance). */
export function strictestClassification(a: DataClassification, b: DataClassification): DataClassification {
  return classificationRank[a] >= classificationRank[b] ? a : b;
}

// --- R1-C (item 11/12): data lifecycle — the retention and erasure contract ---------------------------
//
// C1 declared `toolResultRetentionDays` / `transcriptRetentionDays` and never read them, and the three
// families of code rows this module names carried no classification at all, so nothing could expire and
// nothing stated what it was. R1-C makes retention an executed step of the existing reaper and gives it a
// vocabulary it can be expressed in. Both live here, next to `RetentionClass` itself, because the reaper
// (apps/agent-api) and the store (this package) have to agree on the *meaning* of a class rather than each
// keeping its own copy of the numbers.

/**
 * The retention windows, resolved from the existing C1 configuration. The unit is **days**, and every value
 * is derived: nothing here invents a second set of limits next to `DEFAULT_CODE_AGENT_LIMITS`.
 *
 * The mapping from a class to a window is deliberately total and monotone:
 *
 *  - `until_deleted` is **absent from the table on purpose** — a row that says "keep until the user asks"
 *    is never expired by a clock. Retention only touches the four classes below; explicit erasure
 *    (`DELETE /companies/:companyId/code/sessions/:sessionId/data`) is the only thing that removes it.
 */
export interface CodeRetentionWindows {
  /** `toolResultRetentionDays` — tool results are the bulkiest and least durable content of a run. */
  toolResultDays: number;
  /** `transcriptRetentionDays` — turn boundaries and durable run state. */
  transcriptDays: number;
  /** `ephemeral`: a single day, or the shorter configured window when that is already shorter. */
  ephemeralDays: number;
  /** `extended`: three transcript windows, so "extended" is a multiple and not a new constant. */
  extendedDays: number;
}

/** Builds the windows from the two configured limits. Every value is a function of those two numbers. */
export function resolveCodeRetentionWindows(input: { toolResultRetentionDays: number; transcriptRetentionDays: number }): CodeRetentionWindows {
  const toolResultDays = Math.max(1, Math.trunc(input.toolResultRetentionDays));
  const transcriptDays = Math.max(1, Math.trunc(input.transcriptRetentionDays));
  return {
    toolResultDays,
    transcriptDays,
    ephemeralDays: Math.min(1, toolResultDays),
    extendedDays: transcriptDays * 3,
  };
}

/** The retention classes a reaper may expire. `until_deleted` is deliberately not one of them. */
export const EXPIRABLE_RETENTION_CLASSES: readonly RetentionClass[] = ["ephemeral", "short", "standard", "extended"] as const;

/** What an expired row is measured against, in the table that holds it. */
export type CodeDataScope = "session" | "project" | "run";

/**
 * One family of code rows in the data-lifecycle contract.
 *
 * `appendOnly` is the field that makes the honest difference between "we deleted it" and "the database
 * forbids deleting it": a family marked `appendOnly` is reported as `retained` with its reason and is never
 * presented as purged. Three of them are evidence whose whole value is that it cannot be rewritten
 * (`execution_snapshots` 076, `code_replay_bundles`/`code_replay_bundle_steps` 078,
 * `code_context_summaries` 079, plus `code_run_recovery_notices` and `code_activity_events`).
 */
export interface CodeDataFamily {
  /** The table name. Interpolated into SQL only from this closed list, never from caller input. */
  table: string;
  scope: CodeDataScope;
  /** The column the row's age is measured by. `code_goal_criteria` has none and is erased through its parent. */
  timestampColumn: string | null;
  appendOnly: boolean;
  /** Present exactly when `appendOnly`: why the row survives retention. */
  retentionRefusal?: string;
}

/**
 * The families retention may expire (mutable rows carrying their own `retention_class`). A new table is
 * added here deliberately; nothing scans `information_schema` and guesses, because guessing about which
 * table holds user content is how a retention job deletes the wrong thing.
 */
export const CODE_RETENTION_FAMILIES: readonly CodeDataFamily[] = [
  { table: "code_process_projects", scope: "project", timestampColumn: "updated_at", appendOnly: false },
  { table: "code_session_inboxes", scope: "session", timestampColumn: "updated_at", appendOnly: false },
  { table: "code_run_turns", scope: "run", timestampColumn: "started_at", appendOnly: false },
  { table: "project_checkpoints", scope: "project", timestampColumn: "created_at", appendOnly: false },
  { table: "code_run_states", scope: "session", timestampColumn: "started_at", appendOnly: false },
  { table: "code_session_plans", scope: "session", timestampColumn: "created_at", appendOnly: false },
  { table: "code_goals", scope: "session", timestampColumn: "updated_at", appendOnly: false },
  { table: "code_session_todos", scope: "session", timestampColumn: "updated_at", appendOnly: false },
  { table: "code_session_rewinds", scope: "session", timestampColumn: "created_at", appendOnly: false },
  { table: "code_session_forks", scope: "session", timestampColumn: "created_at", appendOnly: false },
  { table: "code_user_questions", scope: "session", timestampColumn: "created_at", appendOnly: false },
  { table: "code_session_heads", scope: "session", timestampColumn: "created_at", appendOnly: false },
];

/**
 * The families retention must **not** expire, and the reason each one is named. They are listed rather than
 * omitted so a reader can tell "excluded on purpose" from "forgotten", and so the reaper can report the
 * count it left in place instead of a silence that looks identical to a clean sweep.
 */
export const CODE_APPEND_ONLY_EVIDENCE_FAMILIES: readonly CodeDataFamily[] = [
  { table: "execution_snapshots", scope: "session", timestampColumn: null, appendOnly: true, retentionRefusal: "append_only_evidence" },
  { table: "code_replay_bundles", scope: "session", timestampColumn: null, appendOnly: true, retentionRefusal: "append_only_evidence" },
  { table: "code_replay_bundle_steps", scope: "session", timestampColumn: null, appendOnly: true, retentionRefusal: "append_only_evidence" },
  { table: "code_context_summaries", scope: "session", timestampColumn: null, appendOnly: true, retentionRefusal: "append_only_evidence" },
  { table: "code_run_recovery_notices", scope: "session", timestampColumn: null, appendOnly: true, retentionRefusal: "append_only_evidence" },
  { table: "code_activity_events", scope: "session", timestampColumn: null, appendOnly: true, retentionRefusal: "append_only_evidence" },
];

/** Per-family outcome of a retention pass or of an erasure. Counts only, never row content. */
export interface CodeDataFamilyOutcome {
  table: string;
  scope: CodeDataScope;
  /** Rows that matched the age/class rule (in a dry run: rows that *would* have matched). */
  expired: number;
  /** Rows this invocation really deleted. */
  purged: number;
  /**
   * Rows that matched but were deliberately kept, with the reason. Only append-only evidence reaches this
   * today, and it is reported so a retention pass can never claim a clean sweep it did not perform.
   */
  retained: number;
  retainedReason?: string;
}

/** The result of one retention pass, scoped to a single Company. */
export interface CodeDataRetentionReport {
  companyId: string;
  /** The cutoff instant each class was measured against, for the record. */
  windows: CodeRetentionWindows;
  families: CodeDataFamilyOutcome[];
  /** Totals across families. `expired` is what a dry run reports; `purged` is what really happened. */
  expired: number;
  purged: number;
  retained: number;
}

/** What a caller asks to forget. Exactly one target is used; `project` implies the project's sessions. */
export type CodeDataErasureTarget =
  | { kind: "session"; sessionId: string; projectId?: string }
  | { kind: "project"; projectId: string };

/** Per-table erasure outcome. `remaining` is read back after the delete, in the same query family. */
export interface CodeDataErasureOutcome extends CodeDataFamilyOutcome {
  remaining: number;
}

/**
 * The report an erasure must return: what was removed, what is provably gone, and what deliberately
 * survives. `verified` is a measurement (`remaining === 0` for every erasable family), never a claim.
 */
export interface CodeDataErasureReport {
  companyId: string;
  target: CodeDataErasureTarget;
  families: CodeDataErasureOutcome[];
  erased: number;
  /** Families that still hold rows for this target. Empty is the only value that means "nothing left". */
  outstanding: string[];
  /** Families retention/erasure may not touch by design, with the reason. Never empty for append-only data. */
  preserved: Array<{ table: string; reason: string }>;
  verified: boolean;
}

/** The system-scope scans the reaper needs. Retained on the store because only it knows its own schema. */
export interface CodeDataLifecycleStore {
  /**
   * Counts (and, unless `dryRun`, deletes) the code rows that are older than the window their own
   * `retention_class` names. Idempotent: a second pass finds nothing and reports zeros.
   *
   * `companyId` is optional because the reaper is a system sweeper: omitting it means "every Company", which
   * is the sweep the reaper runs. It is never a way to run without a tenant predicate — the statement always
   * carries one, it is simply satisfied by every row.
   */
  planCodeDataRetention(input: {
    companyId?: string;
    windows: CodeRetentionWindows;
    now: Date;
    dryRun: boolean;
  }): Promise<CodeDataRetentionReport>;
  /**
   * Erases the code data of one session (or of one whole code project) and reads back what remains, so the
   * caller can report a verification instead of a success message. Scoped to the Company and to the
   * **code** tables only: the shared `projects` table is touched only for `kind: "project"`.
   */
  eraseCodeData(input: {
    companyId: string;
    target: CodeDataErasureTarget;
  }): Promise<CodeDataErasureReport>;
}

