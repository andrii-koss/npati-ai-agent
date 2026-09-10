import type { PoolClient } from "pg";

export async function runMigration027(client:PoolClient):Promise<void>{
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_guardrail_policies (
      company_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      block_prompt_injection BOOLEAN NOT NULL DEFAULT TRUE,
      redact_pii BOOLEAN NOT NULL DEFAULT TRUE,
      redact_credentials BOOLEAN NOT NULL DEFAULT TRUE,
      custom_blocked_terms TEXT[] NOT NULL DEFAULT '{}',
      max_input_characters INTEGER NOT NULL DEFAULT 100000 CHECK(max_input_characters BETWEEN 1000 AND 1000000),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS company_guardrail_policies_scope_idx
      ON company_guardrail_policies(workspace_id,user_id,company_id);
  `);
}
