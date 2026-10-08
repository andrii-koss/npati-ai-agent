import type { PoolClient } from "pg";

/**
 * Migration 086 — C15: the **mounted local folder** allowlist.
 *
 * Additive (expand only): one new table, its per-project unique key and two reader indexes. No existing table
 * is touched, so a previous application version keeps working against the new schema — it simply never reads
 * this table, and a project without a row here keeps the managed workspace root it always had.
 *
 * Why a table rather than a column on `projects`. A mount is a security decision about the **host
 * filesystem**: it names a directory outside the managed root and states whether the sandbox may write to it.
 * That decision needs an actor, a time, its own lifetime and — the reason this table exists at all — a reader
 * that is **not** the API. The sandbox runner is where `docker create` really happens, and it must re-read the
 * allowlist itself immediately before the container is created instead of trusting the path the API sent
 * (between the confirmation and the create the path may have become a symlink, or a client may simply have
 * sent a different one). A column on `projects` would be invisible to that re-read, and the product's own
 * project update path could silently repoint a workspace at another directory.
 *
 * The unique key is `(company_id, project_id)`: one project has at most one canonical mounted folder, which is
 * what keeps "the WorkspaceProvider is the single source of truth" true — a second row would be a second
 * answer to "where is this workspace".
 *
 * `path_key` is the comparison key (the canonical path with case folded on case-insensitive platforms) so a
 * lookup never depends on the spelling the caller used; `path` keeps the confirmed spelling for the audit
 * trail and for the operator. `mode` is constrained to the two writability states there are.
 *
 * `revision` is the optimistic token the add/confirm/revoke route requires, so a confirmation cannot silently
 * overwrite a decision another request made in the meantime.
 */
export async function runMigration086(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS project_mounted_folders (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      project_id text NOT NULL,
      path text NOT NULL,
      path_key text NOT NULL,
      mode text NOT NULL CHECK (mode IN ('ro', 'rw')),
      confirmed_by text,
      confirmed_at timestamptz,
      revoked_by text,
      revoked_at timestamptz,
      reason text,
      revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT project_mounted_folders_project_key UNIQUE (company_id, project_id)
    )
  `);

  // The read path is "the mount of one project of one tenant", which is the unique key above; the company
  // index serves the administrative listing of every mount a company has confirmed.
  await client.query(`
    CREATE INDEX IF NOT EXISTS project_mounted_folders_company_idx
      ON project_mounted_folders (workspace_id, company_id)
  `);
  // The runner-side lookup is the same by ids, but the reader has no tenant context; the index is what keeps
  // that read a point lookup rather than a scan on the component that creates containers.
  await client.query(`
    CREATE INDEX IF NOT EXISTS project_mounted_folders_project_idx
      ON project_mounted_folders (company_id, project_id)
  `);
}
