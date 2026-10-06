import type { PoolClient } from "pg";

/**
 * Migration 075 — durable run state for the Coding Agent loop (C6a, additive).
 *
 * C6 left two placeholders: no run entity was created, and every piece of loop state (which turn ran, which
 * tool calls completed) lived only in the process that executed it. A restart, a redeploy or a crashed
 * replica therefore lost the boundary between "done" and "maybe done", which is exactly the information a
 * recovery needs in order to never repeat a mutating tool call.
 *
 * Two new tables, nothing else:
 *
 *   - `code_run_states` is one row per run: the coarse status (`running`/`interrupted`/`completed`/
 *     `failed`/`cancelled`), the turn cursor, the monotonic `last_event_seq` used to make every state write
 *     idempotent, and the lease (`lease_owner`, `lease_expires_at`) plus `heartbeat_at` that tell a
 *     reconciler whether the process driving the run is still alive.
 *   - `code_run_turns` is the per-turn boundary: one row per (run, turn) carrying the tool calls of that turn
 *     with their outcome, the checkpoint taken for it and a bounded, metadata-only snapshot of the turn.
 *
 * Deliberate choices, all of them additive:
 *
 *   - **No foreign key to `company_agent_runs`.** A code run does not have a row there yet (the run entity is
 *     C6a's second half), and an FK would reject the very state writes this migration exists to enable. Adding
 *     the constraint later is a separate, additive step.
 *   - **Tool calls live in `jsonb` inside the turn row rather than in a third table.** The recovery unit is the
 *     turn boundary: the reconciler reads one row and knows both which calls finished and which are in doubt.
 *     A separate table would add a join and a second write per call without making that read more precise.
 *   - **`outcome` is nullable in the table and non-null once a call finishes**, so "we do not know whether
 *     this write landed" is a first-class value rather than a missing row.
 *   - The `status` CHECK states the vocabulary in the database too, so an unknown status cannot be persisted
 *     even by a direct SQL write — the same reasoning as in 074.
 */
export async function runMigration075(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_run_states (
      run_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('running', 'interrupted', 'completed', 'failed', 'cancelled')),
      turn_index integer NOT NULL DEFAULT 0 CHECK (turn_index >= 0),
      last_event_seq bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
      lease_owner text,
      lease_expires_at timestamptz,
      heartbeat_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      revision integer NOT NULL DEFAULT 1
    )
  `);
  // The reconciler scans for runs that claim to be running; the partial index keeps that scan small even when
  // the table holds years of finished runs.
  await client.query(
    "CREATE INDEX IF NOT EXISTS code_run_states_running_idx" +
    "  ON code_run_states (status, lease_expires_at) WHERE status = 'running'",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS code_run_states_company_idx" +
    "  ON code_run_states (company_id, started_at DESC)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS code_run_states_session_idx" +
    "  ON code_run_states (company_id, session_id, started_at DESC)",
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS code_run_turns (
      run_id text NOT NULL,
      company_id text NOT NULL,
      turn_index integer NOT NULL CHECK (turn_index >= 1),
      status text NOT NULL CHECK (status IN ('running', 'finished', 'failed')),
      outcome text CHECK (outcome IS NULL OR outcome IN ('ok', 'failed', 'unknown_outcome')),
      tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
      messages jsonb NOT NULL DEFAULT '[]'::jsonb,
      results jsonb NOT NULL DEFAULT '[]'::jsonb,
      checkpoint_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      PRIMARY KEY (run_id, turn_index)
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS code_run_turns_company_idx" +
    "  ON code_run_turns (company_id, run_id, turn_index DESC)",
  );
}
