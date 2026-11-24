import type { PoolClient } from "pg";

/**
 * Security audit 2026-11-24, step-up confirmation: passkeys (WebAuthn credentials) per person, and the single-use
 * challenges that confirm a sensitive action (creating an API key or remote token, revealing a stored secret).
 */
export async function runMigration100(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_passkeys (
      id UUID PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BYTEA NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports JSONB NOT NULL DEFAULT '[]'::jsonb,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS user_passkeys_owner_idx ON user_passkeys(workspace_id, user_id);
    CREATE TABLE IF NOT EXISTS auth_step_up_challenges (
      id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      kind TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auth_step_up_challenges_expiry_idx ON auth_step_up_challenges(expires_at);
  `);
}
