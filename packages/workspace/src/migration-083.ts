import type { PoolClient } from "pg";

/**
 * Migration 083 — C10: the run's **original request** is durable. Additive (expand only): seven columns on the
 * existing `code_run_states` table, their CHECK constraints, one index. No table is created, no column is
 * dropped, retyped or renamed, and no existing row changes meaning: every new column is nullable or carries a
 * default that says "this run has no recorded request", which is the honest reading of every row written before
 * this migration.
 *
 * Why the request needs a home at all: the Coding Agent's transcript is the C6b replay bundle, and a bundle
 * records what the **model** produced (its answers and the settled tool results). The request the model was
 * given is not in it — `code_run_turns.messages` was declared for that and never written, and the bundle is
 * written once, on the terminal path, so a run that crashes mid-flight leaves neither. The result was that the
 * single most important input of a run existed only in the live request body, and a resume could not
 * reconstruct it. That is the defect this migration closes.
 *
 * Why on `code_run_states` rather than in a new table or in `code_run_turns.messages`:
 *
 *   - **The write is atomic with the run.** `createCodeRunState` is the statement that creates the run row, so
 *     the request is stored by the *same* insert. There is no window in which a run exists and its request does
 *     not, which is exactly the window a crash immediately after start would land in — and that is the failure
 *     the owner named.
 *   - **It cannot be overwritten.** That insert is `ON CONFLICT (run_id) DO NOTHING` because `startRun` is
 *     idempotent by run id. A resume re-runs `startRun` with the continuation prompt, and the database — not a
 *     convention — is what keeps the original text. The request is written once and is immutable for the life of
 *     the run.
 *   - **No fourth transcript.** The replay bundle keeps recording the model's side, the turn rows keep the tool
 *     calls, and this column keeps the request: one canonical source per fact, with no copy of any fact in two
 *     places.
 *   - **`code_run_turns.messages` keeps its documented meaning.** That column is the bounded, metadata-only
 *     snapshot of a turn (paths, ids, counts), its `assertNoSensitiveRunState` guard is a real invariant of the
 *     C6a log, and opening a turn boundary at run start just to hold a request would also change what
 *     `loadTurnBoundary` reports for a run that died before its first model step.
 *   - **The request is content and the table is read by metadata scans.** The lease/status row is scanned by the
 *     reaper and the reconciler, so the request columns are deliberately **not** part of the shared
 *     `code_run_states` select list: `getCodeRunRequest` is the one read that returns them.
 *
 * `request_status` is a first-class value rather than a nullable text: `not_recorded` says "this run has no
 * recorded request" (it predates this migration, or the caller passed no prompt) and `refused_credential` says
 * "a request was offered and was NOT stored, because it looked like it carried a credential". Both are answers a
 * resume must be able to give without inventing a request, and a sensitive value is never silently redacted into
 * the column — the C4a rule is that a secret refuses the write rather than being stripped.
 *
 * `data_classification` and `retention_class` carry the established CHECK vocabulary and are NOT NULL with the
 * same defaults migration 078 used for the replay bundle, so a direct SQL write cannot invent a class and every
 * row states the class it was created under. They are copied from the session at creation, deliberately: this is
 * evidence, and evidence has to stay readable even if the session's class is later raised.
 */
export async function runMigration083(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE code_run_states
      ADD COLUMN IF NOT EXISTS request_status text NOT NULL DEFAULT 'not_recorded',
      ADD COLUMN IF NOT EXISTS request_text text,
      ADD COLUMN IF NOT EXISTS request_sha256 text,
      ADD COLUMN IF NOT EXISTS request_truncated boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS request_recorded_at timestamptz,
      ADD COLUMN IF NOT EXISTS data_classification text NOT NULL DEFAULT 'confidential',
      ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'standard'
  `);

  // The vocabulary and the pairing between the status and the text are stated in the database too, so a direct
  // write cannot claim `recorded` while storing nothing, nor store a request while claiming there is none.
  await client.query("ALTER TABLE code_run_states DROP CONSTRAINT IF EXISTS code_run_states_request_status_check");
  await client.query(
    "ALTER TABLE code_run_states ADD CONSTRAINT code_run_states_request_status_check" +
    " CHECK (request_status IN ('not_recorded','recorded','refused_credential'))",
  );
  await client.query("ALTER TABLE code_run_states DROP CONSTRAINT IF EXISTS code_run_states_request_text_presence_check");
  await client.query(
    "ALTER TABLE code_run_states ADD CONSTRAINT code_run_states_request_text_presence_check" +
    " CHECK ((request_status = 'recorded') = (request_text IS NOT NULL))",
  );
  await client.query("ALTER TABLE code_run_states DROP CONSTRAINT IF EXISTS code_run_states_request_sha256_check");
  await client.query(
    "ALTER TABLE code_run_states ADD CONSTRAINT code_run_states_request_sha256_check" +
    " CHECK ((request_status = 'recorded') = (request_sha256 IS NOT NULL))",
  );
  await client.query("ALTER TABLE code_run_states DROP CONSTRAINT IF EXISTS code_run_states_data_classification_check");
  await client.query(
    "ALTER TABLE code_run_states ADD CONSTRAINT code_run_states_data_classification_check" +
    " CHECK (data_classification IN ('public','internal','confidential','restricted'))",
  );
  await client.query("ALTER TABLE code_run_states DROP CONSTRAINT IF EXISTS code_run_states_retention_class_check");
  await client.query(
    "ALTER TABLE code_run_states ADD CONSTRAINT code_run_states_retention_class_check" +
    " CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted'))",
  );

  // Retention has to be able to find what to purge without scanning every run: the class plus the creation time
  // is the whole query, and it stays cheap on a table that keeps every run forever.
  await client.query(
    "CREATE INDEX IF NOT EXISTS code_run_states_retention_idx" +
    "  ON code_run_states (retention_class, started_at)",
  );
}
