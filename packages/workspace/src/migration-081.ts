import type { PoolClient } from "pg";

/**
 * Migration 081 — C9 `code.ask_user`: the persistent user question (additive).
 *
 * Two changes, and the first one is the one that is easy to miss:
 *
 *   1. `code_run_states.status` gains `waiting_for_user`. A question pauses the run, and the pause has to be a
 *      **state in the database**, not a process that is blocked in memory: C6a's reconciler treats "running with
 *      an expired lease" as a crash and moves it to `interrupted`, so a run waiting for an answer must not be
 *      `running` — otherwise every restart would "recover" a run that is simply waiting, replay work it already
 *      did, and orphan the answer the user is about to give. Extending the allowed set is additive: the previous
 *      application version never writes the new value and keeps working against the new schema.
 *   2. `code_user_questions` holds the question itself, with the answer as a decided transition rather than a
 *      mutable field. The CHECKs below make two owner rules structural: a decided question always carries who
 *      answered it and when, and a question that was *not* answered never carries an answer at all — so no
 *      default, guess or timeout can ever look like a user decision.
 *
 * `(company_id, run_id, tool_call_id)` is unique, which is what makes the tool call idempotent: the model (or a
 * retry) asking twice about the same tool call finds the question it already asked instead of creating a second
 * one the user would have to answer twice.
 */
export async function runMigration081(client: PoolClient): Promise<void> {
  // --- the paused run status --------------------------------------------------------------------------
  // The constraint was declared inline in migration 075, so its name is Postgres's own. Dropping by name would
  // silently do nothing if that name ever differed, and the old, stricter CHECK would then keep rejecting
  // `waiting_for_user` while the code believed it had widened the set. The loop drops whatever CHECK on this
  // table mentions `status`, then re-adds the canonical definition.
  await client.query(`
    DO $$
    DECLARE constraint_row record;
    BEGIN
      FOR constraint_row IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'code_run_states'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format('ALTER TABLE code_run_states DROP CONSTRAINT %I', constraint_row.conname);
      END LOOP;
    END $$;
  `);
  await client.query(`
    ALTER TABLE code_run_states ADD CONSTRAINT code_run_states_status_check
      CHECK (status IN ('running','waiting_for_user','interrupted','completed','failed','cancelled'))
  `);

  // --- the question ------------------------------------------------------------------------------------
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_user_questions (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      run_id text NOT NULL,
      tool_call_id text NOT NULL,
      prompt text NOT NULL,
      choices jsonb NOT NULL DEFAULT '[]'::jsonb,
      allow_free_answer boolean NOT NULL DEFAULT false,
      status text NOT NULL CHECK (status IN ('pending','answered','expired','cancelled')),
      answer jsonb,
      answered_by text,
      answered_at timestamptz,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'short'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
      CONSTRAINT code_user_questions_tool_call_unique UNIQUE (company_id, run_id, tool_call_id),
      -- An answered question names the human who answered it; anything else would be an unattributable decision.
      CONSTRAINT code_user_questions_answered_is_attributed
        CHECK (status <> 'answered' OR (answer IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL)),
      -- And an unanswered question never carries an answer: no timeout, default or guess may look like a decision.
      CONSTRAINT code_user_questions_answer_only_when_answered
        CHECK (status = 'answered' OR (answer IS NULL AND answered_by IS NULL AND answered_at IS NULL))
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_user_questions_run_idx
      ON code_user_questions (company_id, run_id, status)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_user_questions_session_idx
      ON code_user_questions (company_id, session_id, created_at DESC)
  `);
  // The reaper scans pending questions by TTL; without this index that scan is a full table scan per pass.
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_user_questions_pending_expiry_idx
      ON code_user_questions (expires_at) WHERE status = 'pending'
  `);
}
