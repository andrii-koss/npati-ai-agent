import type { PoolClient } from "pg";

/**
 * Migration 085 — C13 (owner decision 5): the durable record of an **owner/admin risk decision** for one
 * runtime MCP tool. Additive (expand only): one new table, its unique key and one reader index. No existing
 * table is touched, so a previous application version keeps working against the new schema — it simply never
 * reads this table, and the fail-closed default (`high` + approval required, assigned in
 * `mcp-runtime-capabilities.ts`) is what every tool keeps without a row here.
 *
 * Why a table rather than a key in an existing row. `company_mcp_servers` (migration 017) describes the
 * **connection** — name, transport, endpoint, token, scopes — and the product's own POST/DELETE routes
 * rewrite it. A risk decision is a *policy* fact about one tool of one connection: it has an actor, a time, an
 * AuditLog entry and a lifetime independent of the connection's configuration. Storing it inside the
 * connection row would let a later configuration PATCH erase a security decision without an audit entry, and
 * would make "who lowered this risk, and when" unanswerable.
 *
 * The unique key is `(workspace_id, company_id, connection_id, tool_name)`:
 *   - `workspace_id`/`company_id` are the tenant, so one Company's decision can never reach another's lookup;
 *   - `connection_id` + `tool_name` are the runtime tool identity (`mcp:<connectionId>/<toolName>`), so a
 *     **re-discovery** of the same connection re-applies the same decision instead of inventing a second one —
 *     which is what makes the runtime manifest hash stable across a discovery that changed nothing.
 *
 * `risk` is constrained to the capability vocabulary with `unknown` deliberately absent: the fail-closed word
 * for "we do not know" is `high`, not a fifth class a reader would have to interpret.
 */
export async function runMigration085(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_mcp_tool_policies (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      company_id text NOT NULL,
      user_id text NOT NULL,
      connection_id text NOT NULL,
      tool_name text NOT NULL,
      risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
      approval_required boolean NOT NULL DEFAULT true,
      risk_source text NOT NULL DEFAULT 'owner_policy' CHECK (risk_source = 'owner_policy'),
      actor text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // The read path is "every policy of one tenant" (hydrated before a runtime listing is served), so the key
  // is the tenant plus the runtime tool identity.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS company_mcp_tool_policies_key
      ON company_mcp_tool_policies (workspace_id, company_id, connection_id, tool_name)
  `);
}
