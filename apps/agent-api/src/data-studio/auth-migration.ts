import { quoteIdentifier } from "./identifier";

export const AUTH_SYSTEM_TABLES = [
  "_npati_auth_users",
  "_npati_auth_refresh_tokens",
  "_npati_auth_verification_tokens",
  "_npati_auth_reset_tokens",
  "_npati_auth_roles",
  "_npati_auth_user_roles",
] as const;

export async function ensureAuthTables(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  runtimeUser?: string,
): Promise<void> {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS _npati_auth_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      email_verified boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );`,
    `CREATE INDEX IF NOT EXISTS idx_npati_auth_users_email ON _npati_auth_users(email);`,

    `CREATE TABLE IF NOT EXISTS _npati_auth_refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text UNIQUE NOT NULL,
      family_id uuid NOT NULL,
      user_id uuid NOT NULL REFERENCES _npati_auth_users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      rotated_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_npati_auth_refresh_family ON _npati_auth_refresh_tokens(family_id);`,
    `CREATE INDEX IF NOT EXISTS idx_npati_auth_refresh_hash ON _npati_auth_refresh_tokens(token_hash);`,

    `CREATE TABLE IF NOT EXISTS _npati_auth_verification_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text UNIQUE NOT NULL,
      user_id uuid NOT NULL REFERENCES _npati_auth_users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_npati_auth_verify_hash ON _npati_auth_verification_tokens(token_hash);`,

    `CREATE TABLE IF NOT EXISTS _npati_auth_reset_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text UNIQUE NOT NULL,
      user_id uuid NOT NULL REFERENCES _npati_auth_users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_npati_auth_reset_hash ON _npati_auth_reset_tokens(token_hash);`,

    `CREATE TABLE IF NOT EXISTS _npati_auth_roles (
      name text PRIMARY KEY,
      description text
    );`,
    `INSERT INTO _npati_auth_roles(name, description) VALUES
      ('admin', 'Project administrator with elevated access'),
      ('member', 'Registered member with authenticated access'),
      ('user', 'Standard project end user')
      ON CONFLICT (name) DO NOTHING;`,

    `CREATE TABLE IF NOT EXISTS _npati_auth_user_roles (
      user_id uuid NOT NULL REFERENCES _npati_auth_users(id) ON DELETE CASCADE,
      role text NOT NULL REFERENCES _npati_auth_roles(name) ON DELETE CASCADE,
      PRIMARY KEY (user_id, role)
    );`,
  ];

  for (const statement of ddl) {
    await client.query(statement);
  }

  if (runtimeUser) {
    const quotedRuntime = quoteIdentifier(runtimeUser);
    for (const table of AUTH_SYSTEM_TABLES) {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO ${quotedRuntime};`);
    }
  }
}
