import type { PoolClient } from "pg";

/**
 * Migration 087 — R1-C (item 13): classification and retention on the three families that had neither.
 *
 * Expand only, forward only, additive in the strict sense: six columns, six CHECK constraints and three
 * indexes. No table is created, no column is dropped, retyped or renamed, no existing row changes meaning, and
 * no application version breaks — a previous version never reads these columns, and every one of them is
 * NOT NULL **with a default**, so an insert that predates this migration keeps working unchanged.
 *
 * Why these three tables and not others. Every other durable Coding Agent table already carries the pair
 * (065 sessions/projects, 076 snapshots, 077 activity, 078 replay bundles, 079 summaries, 080 goals/plans/
 * todos, 081 questions, 082 heads/notices/ledgers, 083 run state). These three were the gap, and the gap was
 * load-bearing: without a `retention_class` on a row, retention cannot be expressed at all, because the rule
 * is "this row's own class decides its window" — a single company-wide number would make "keep this run's
 * transcript longer" unexpressible and would silently expire evidence a user paid for.
 *
 * The defaults are the honest reading of every existing row rather than a new policy:
 *
 *   - `data_classification` defaults to `confidential`, which is the C1 default everywhere else
 *     (`DEFAULT_DATA_CLASSIFICATION`) and the stricter of the two answers for a row nobody classified.
 *   - `retention_class` defaults to `standard`, which is what migration 065 gave `projects` and 083 gave
 *     `code_run_states` — so `code_run_turns` rows inherit the same window their run's state row states, and
 *     an existing turn is not expired earlier than the run it belongs to.
 *   - `project_checkpoints` gets `standard` as well, and this is deliberately the *conservative* choice: a
 *     checkpoint is restorable state, so defaulting it shorter would expire restore points that nothing asked
 *     to expire.
 *
 * **Why adding these columns to the shared `project_checkpoints` table is safe.** That table is not owned by
 * the Coding Agent: it serves `project.git.checkpoint` / `project.git.restore_checkpoint`
 * (`packages/shared/src/project-git-capabilities.ts`), which any project type can call, and
 * `packages/workspace/src/migration-056.ts` created it before there was a `code_project` type at all. Adding
 * the pair is safe for four reasons, and the fourth is the one that matters:
 *
 *   1. **It is additive.** Two `ADD COLUMN IF NOT EXISTS` statements with NOT NULL defaults: an existing
 *      Website Builder or Data Studio checkpoint gets `confidential`/`standard` and reads exactly as it did —
 *      no application version that never selects these columns can observe them.
 *   2. **No constraint is added that a non-code row could violate.** The CHECK vocabulary is the one 065/083
 *      already use, and both defaults are members of it, so no backfill is needed and no existing row can fail.
 *   3. **No index makes an existing write slower in a way that changes behaviour.** The new index is on
 *      `(retention_class, created_at)`, which a non-code insert extends by one entry.
 *   4. **The columns are not a licence to delete.** The columns say what a row is; the *deletion* is scoped by
 *      the retention SQL in `packages/workspace/src/postgres-store.ts`, which reaches `project_checkpoints`
 *      only through `(company_id, project_id)` for a project whose type is `code_project`. A checkpoint of a
 *      Website Builder project therefore keeps its `standard` class and is never expired, and
 *      `tests/coding-agent-r1c-data-lifecycle-postgres.test.ts` measures that as a negative control.
 *
 * The migration also states the vocabulary in the database, so a direct SQL write cannot invent a class — the
 * same reasoning as 065/074/083.
 *
 * Indexes: retention's whole query is "rows of a class older than a cutoff", so
 * `(retention_class, <age column>)` is the index that keeps it from becoming a table scan on a table that
 * keeps every run forever. The age column is the one the retention rule really measures:
 * `code_run_turns.started_at`, `project_checkpoints.created_at`, `execution_snapshots.created_at`.
 */
export async function runMigration087(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE code_run_turns
      ADD COLUMN IF NOT EXISTS data_classification text NOT NULL DEFAULT 'confidential',
      ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'standard'
  `);
  await client.query(`
    ALTER TABLE project_checkpoints
      ADD COLUMN IF NOT EXISTS data_classification text NOT NULL DEFAULT 'confidential',
      ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'standard'
  `);
  await client.query(`
    ALTER TABLE execution_snapshots
      ADD COLUMN IF NOT EXISTS data_classification text NOT NULL DEFAULT 'confidential',
      ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'standard'
  `);

  // The vocabulary, stated in the database too: a direct SQL write cannot invent a class, and the CHECK is
  // dropped before it is added so a re-run of the chain is idempotent down to the constraint. The statements
  // are written out per table rather than looped over the names, so no table name is ever interpolated into
  // DDL from anything but this literal.
  await client.query("ALTER TABLE code_run_turns DROP CONSTRAINT IF EXISTS code_run_turns_data_classification_check");
  await client.query(
    "ALTER TABLE code_run_turns ADD CONSTRAINT code_run_turns_data_classification_check" +
    " CHECK (data_classification IN ('public','internal','confidential','restricted'))",
  );
  await client.query("ALTER TABLE code_run_turns DROP CONSTRAINT IF EXISTS code_run_turns_retention_class_check");
  await client.query(
    "ALTER TABLE code_run_turns ADD CONSTRAINT code_run_turns_retention_class_check" +
    " CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted'))",
  );

  await client.query("ALTER TABLE project_checkpoints DROP CONSTRAINT IF EXISTS project_checkpoints_data_classification_check");
  await client.query(
    "ALTER TABLE project_checkpoints ADD CONSTRAINT project_checkpoints_data_classification_check" +
    " CHECK (data_classification IN ('public','internal','confidential','restricted'))",
  );
  await client.query("ALTER TABLE project_checkpoints DROP CONSTRAINT IF EXISTS project_checkpoints_retention_class_check");
  await client.query(
    "ALTER TABLE project_checkpoints ADD CONSTRAINT project_checkpoints_retention_class_check" +
    " CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted'))",
  );

  await client.query("ALTER TABLE execution_snapshots DROP CONSTRAINT IF EXISTS execution_snapshots_data_classification_check");
  await client.query(
    "ALTER TABLE execution_snapshots ADD CONSTRAINT execution_snapshots_data_classification_check" +
    " CHECK (data_classification IN ('public','internal','confidential','restricted'))",
  );
  await client.query("ALTER TABLE execution_snapshots DROP CONSTRAINT IF EXISTS execution_snapshots_retention_class_check");
  await client.query(
    "ALTER TABLE execution_snapshots ADD CONSTRAINT execution_snapshots_retention_class_check" +
    " CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted'))",
  );

  // Retention has to find "rows of a class older than a cutoff" without scanning the table, and the class plus
  // the age column is that whole query.
  await client.query(
    "CREATE INDEX IF NOT EXISTS code_run_turns_retention_idx ON code_run_turns (retention_class, started_at)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS project_checkpoints_retention_idx ON project_checkpoints (retention_class, created_at)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS execution_snapshots_retention_idx ON execution_snapshots (retention_class, created_at)",
  );
}
