import type { PoolClient } from "pg";

/**
 * Migration 082 — C10 session durability: the conversation cursor, the recovery notice and the two
 * operation ledgers (rewind, fork). Additive: four new tables, their indexes and one append-only trigger.
 * No existing table is altered, and no foreign key points at a C12 structure that does not exist yet.
 *
 * Why each table exists, in the order the guarantee appears:
 *
 *   1. `code_session_heads` is the **conversation cursor**. Rewinding a conversation cannot be expressed by
 *      deleting rows: the replay bundle (`code_replay_bundles`/`_steps`, 078) and the compaction summaries
 *      (`code_context_summaries`, 079) are append-only **at the database level**, and deleting evidence of what
 *      the model was shown is exactly what those triggers forbid. A rewind therefore moves a pointer and every
 *      reader of the transcript applies it. One row per session (`UNIQUE (company_id, session_id)`), versioned
 *      by `revision` so two concurrent rewinds cannot silently overwrite each other, and carrying the
 *      `operation_id` that produced it so a retried request is recognisable as the same operation.
 *      It is the one table here with a foreign key, and deliberately so: a cursor without its session is
 *      meaningless, and `ON DELETE CASCADE` means deleting a project (which cascades to its sessions) cannot
 *      leave a cursor pointing at a session that is gone.
 *   2. `code_run_recovery_notices` is where the reconciler's notice finally lands. Until C10 that notice lived
 *      only inside the reconciliation report: `app.ts` discarded it, so the one place that knows *why* a run
 *      stopped and *which* tool calls are in doubt was unreachable from any API. The row is append-only
 *      (`created_at` ordered) because a notice describes a moment: a rewritten notice would misrepresent what
 *      the model was told. `retention_class` defaults to `short`, mirroring 079 — a notice is derived evidence,
 *      not a compliance record.
 *   3. `code_session_rewinds` is the rewind **operation ledger**. A rewind creates a pre-rewind checkpoint and
 *      restores the workspace; doing that twice must not leave two safety checkpoints and two audit entries, so
 *      the operation is *claimed* first (`UNIQUE (company_id, operation_id)`) and only then performed. The row
 *      is the idempotency key, the durable record of what was rolled back, and the place a repeated call reads
 *      its answer from.
 *   4. `code_session_forks` is the fork ledger: which session was forked from which, at which checkpoint and
 *      conversation turn, and under which operation id. `code_sessions.parent_session_id` already exists and
 *      already validates "same project", but nothing read it, and `createCodeSession` mints a `randomUUID()`
 *      with no idempotency at all — so a repeated fork request used to create a second session. The unique
 *      `operation_id` is what makes the fork idempotent; the row is also the lineage a reader consults.
 *
 * Deliberate omissions:
 *   - no foreign key from the two ledgers or the notices to `code_sessions`: those rows are evidence, and
 *     evidence must survive the deletion of what it describes (the same rule 075/078/081 follow). The service
 *     layer checks that the session exists, which is also what keeps "another tenant's session" and "no such
 *     session" indistinguishable.
 *   - no update/delete path for the notices: `REVOKE UPDATE, DELETE, TRUNCATE` plus a trigger, repeating the
 *     066/076/079 pattern.
 *   - `data_classification` and `retention_class` are NOT NULL with the established CHECK vocabulary on every
 *     table, so a direct SQL write cannot invent a class, and `company_id` is NOT NULL so every row is
 *     tenant-scoped.
 */
export async function runMigration082(client: PoolClient): Promise<void> {
  // --- 1. the conversation cursor ---------------------------------------------------------------------
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_session_heads (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      run_id text,
      turn_index integer NOT NULL DEFAULT 0,
      reason text NOT NULL CHECK (reason IN ('created','resume','rewind','fork')),
      operation_id text,
      revision integer NOT NULL DEFAULT 1,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'standard'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
      CONSTRAINT code_session_heads_session_unique UNIQUE (company_id, session_id),
      -- A cursor is a position in a run, so it always names the run it points into. A null run would make
      -- "up to which turn" unanswerable, which is the one thing this table exists to answer.
      CONSTRAINT code_session_heads_run_required
        CHECK (reason = 'created' OR run_id IS NOT NULL),
      CONSTRAINT code_session_heads_turn_not_negative CHECK (turn_index >= 0),
      CONSTRAINT code_session_heads_session_fk FOREIGN KEY (session_id) REFERENCES code_sessions(id) ON DELETE CASCADE
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_session_heads_run_idx
      ON code_session_heads (company_id, run_id)
  `);

  // --- 2. the reconciler's notice ---------------------------------------------------------------------
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_run_recovery_notices (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      run_id text NOT NULL,
      reason text NOT NULL,
      last_finished_turn integer NOT NULL DEFAULT 0,
      replayed_read_only jsonb NOT NULL DEFAULT '[]'::jsonb,
      unknown_outcome jsonb NOT NULL DEFAULT '[]'::jsonb,
      workspace_diff jsonb,
      message_for_model text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'short'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
      CONSTRAINT code_run_recovery_notices_turn_not_negative CHECK (last_finished_turn >= 0)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_run_recovery_notices_run_idx
      ON code_run_recovery_notices (company_id, run_id, created_at DESC, id DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_run_recovery_notices_session_idx
      ON code_run_recovery_notices (company_id, session_id, created_at DESC, id DESC)
  `);

  // --- 3. the rewind ledger ---------------------------------------------------------------------------
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_session_rewinds (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      operation_id text NOT NULL,
      target text NOT NULL CHECK (target IN ('code','conversation','both')),
      run_id text,
      turn_index integer,
      checkpoint_id text,
      restored_checkpoint_id text,
      safety_checkpoint_id text,
      previous_head_turn integer,
      head_turn integer,
      status text NOT NULL CHECK (status IN ('pending','completed','partial','failed')),
      failure_reason text,
      requested_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'standard'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
      CONSTRAINT code_session_rewinds_operation_unique UNIQUE (company_id, operation_id),
      -- A finished operation always says when it finished; a pending one never does. Without this a row could
      -- claim to be completed while carrying no time, and a retry could not tell a real result from a claim.
      CONSTRAINT code_session_rewinds_finished_is_stamped
        CHECK ((status = 'pending') = (finished_at IS NULL)),
      -- Only a code-touching rewind can name a safety checkpoint, and any rewind that names a checkpoint to
      -- restore must also have one to restore to.
      CONSTRAINT code_session_rewinds_code_target_has_checkpoint
        CHECK (target = 'conversation' OR checkpoint_id IS NOT NULL)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_session_rewinds_session_idx
      ON code_session_rewinds (company_id, session_id, created_at DESC, id DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_session_rewinds_run_idx
      ON code_session_rewinds (company_id, run_id)
  `);

  // --- 4. the fork ledger -----------------------------------------------------------------------------
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_session_forks (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      parent_session_id text NOT NULL,
      session_id text,
      operation_id text NOT NULL,
      run_id text,
      turn_index integer,
      checkpoint_id text,
      copied_plan boolean NOT NULL DEFAULT false,
      copied_todos boolean NOT NULL DEFAULT false,
      copied_head boolean NOT NULL DEFAULT false,
      copied_goal boolean NOT NULL DEFAULT false,
      plan_revision integer,
      todo_count integer NOT NULL DEFAULT 0,
      status text NOT NULL CHECK (status IN ('pending','completed','failed')),
      failure_reason text,
      requested_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'standard'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
      CONSTRAINT code_session_forks_operation_unique UNIQUE (company_id, operation_id),
      -- A completed fork always names the session it created; a pending one must not pretend to have one, which
      -- is what makes "call the same operation id again" answer with the stored session instead of creating a
      -- second one. A *failed* fork is allowed to name the session it did create: the session exists even when
      -- copying the plan or the todo list into it failed, and hiding that would hide a real half-done fork.
      CONSTRAINT code_session_forks_completed_has_session
        CHECK (status <> 'completed' OR session_id IS NOT NULL),
      CONSTRAINT code_session_forks_finished_is_stamped
        CHECK ((status = 'pending') = (finished_at IS NULL)),
      CONSTRAINT code_session_forks_not_self CHECK (session_id IS NULL OR session_id <> parent_session_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_session_forks_parent_idx
      ON code_session_forks (company_id, parent_session_id, created_at DESC, id DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_session_forks_session_idx
      ON code_session_forks (company_id, session_id)
  `);

  // --- append-only on the notice ----------------------------------------------------------------------
  // Repeating the `audit_log` (066) / `execution_snapshots` (076) / `code_context_summaries` (079) pattern: a
  // notice that can be rewritten afterwards cannot prove what the model and the user were told at recovery.
  await client.query(`
    CREATE OR REPLACE FUNCTION npati_code_run_recovery_notices_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'code_run_recovery_notices is append-only'
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS npati_code_run_recovery_notices_no_update ON code_run_recovery_notices
  `);
  await client.query(`
    CREATE TRIGGER npati_code_run_recovery_notices_no_update
      BEFORE UPDATE OR DELETE ON code_run_recovery_notices
      FOR EACH ROW EXECUTE FUNCTION npati_code_run_recovery_notices_append_only()
  `);
  await client.query(`
    REVOKE UPDATE, DELETE, TRUNCATE ON code_run_recovery_notices FROM PUBLIC
  `);
}
