import type { PoolClient } from "pg";

/**
 * Migration 084 — C12: the delegation tree of Coding Agent Activity events. Additive (expand only): three
 * nullable columns on `code_activity_events` and one partial index. No table is created, no column is dropped,
 * retyped or renamed, and no existing row changes meaning: every pre-C12 row has no parent, which is exactly
 * what `NULL` in these columns says.
 *
 * Why columns rather than a payload key. `code_activity_events` (migration 077) gave every event a `run_id` and
 * a `snapshot_id` and no way to say **which run an event belongs under**. A sub-agent's tool calls, policy
 * decisions and run transitions therefore all landed in the same flat stream as its parent's, distinguishable
 * only by reading each payload — so "show me the tree of what the children did" was not a query anyone could
 * write. The owner's criterion for C12 is that the tree is *visible*, and a tree that has to be reconstructed by
 * scanning a tenant's payloads is not visible.
 *
 * Putting the parent in the metadata-only `payload` instead would have been cheaper — no migration, no index —
 * and it was the other candidate. It was rejected because it makes the two properties that matter unenforceable:
 *
 *   - **It cannot be indexed.** A payload key can be indexed only with an expression index over `jsonb`, which
 *     the deployment's migration tooling does not review as a schema fact, and every tree query would silently
 *     degrade to a sequential scan of every event the tenant ever wrote.
 *   - **It is not a fact the database can hold.** A payload is free-form metadata; a parent relationship is a
 *     reference. As a column it is `NULL` or an id, and a reader cannot accidentally read a *different* run's
 *     event as a parent because a payload happened to use the key for something else.
 *
 * `parent_event_id` is nullable and deliberately **not** a foreign key: Activity events are append-only and are
 * pruned by retention independently of one another, so a hard reference would make retention fail or force a
 * cascade that deletes a child's evidence because the parent aged out. The identity of the relationship is
 * `parent_run_id` + `parent_tool_call_id`; `parent_event_id` is an ordering convenience on top of it.
 *
 * The index is partial (`WHERE parent_run_id IS NOT NULL`) so it stays small: it holds one entry per delegated
 * event and nothing for the main runs, which are the vast majority of rows.
 */
export async function runMigration084(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE code_activity_events
      ADD COLUMN IF NOT EXISTS parent_run_id text,
      ADD COLUMN IF NOT EXISTS parent_tool_call_id text,
      ADD COLUMN IF NOT EXISTS parent_event_id text
  `);

  // The tree query: "every event recorded under this run". Covering the ordering columns as well keeps the
  // newest-first page of a child run's events off the heap.
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_activity_events_parent_idx
      ON code_activity_events (parent_run_id, created_at DESC, id DESC)
      WHERE parent_run_id IS NOT NULL
  `);
}
