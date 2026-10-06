import type { PoolClient } from "pg";

/**
 * Migration 074 — ProviderDataPolicy, project classification, policy history and hosted-provider
 * consent (C5b, additive).
 *
 * Nothing here changes an existing table, row, index or query. Four new tables:
 *
 *   - `provider_data_policies` is the policy itself, one row per
 *     (company, provider, model pattern). `company_id` is **nullable on purpose**: a row with
 *     `company_id IS NULL` is a platform default that applies to every company, while a row with a
 *     company id belongs to that tenant only. `model_pattern IS NULL` means "the whole provider".
 *     `policy_version` is monotonic and is what C6b's ExecutionSnapshot and the history table agree on.
 *   - `code_project_data_policies` is the per-project classification: the default is
 *     `confidential` (never `public`), and `path_rules` carries `{ pattern, classification }` entries so a
 *     repository can be classified path by path.
 *   - `provider_data_policy_versions` is append-only history: every accepted upsert writes the full policy
 *     snapshot, so `policy_version` can always be resolved back to what was actually in force.
 *   - `provider_hosted_consent` records the explicit, revocable consent a company gives before a project
 *     is connected to a hosted third-party provider. `revoked_at IS NULL` means "still consented";
 *     anything else must be treated as no consent, never as "assumed".
 *
 * The unique index on the policy table uses `COALESCE` exactly like `code_approval_rules` (070), because
 * in SQL two `NULL`s are not equal and a plain unique constraint would let a platform default and a
 * provider-wide row be duplicated indefinitely.
 *
 * The CHECK constraints state the vocabulary in the database as well as in code: an unknown kind,
 * classification or training policy cannot be persisted even by a direct SQL write, which keeps the
 * fail-closed defaults in `provider-data-policy.ts` meaningful.
 */
export async function runMigration074(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_data_policies (
      id text PRIMARY KEY,
      company_id text,
      provider_id text NOT NULL,
      model_pattern text,
      policy_version integer NOT NULL DEFAULT 1,
      kind text NOT NULL CHECK (kind IN ('hosted_third_party', 'self_hosted', 'local')),
      allow_private_repo_code boolean NOT NULL DEFAULT false,
      max_data_classification text NOT NULL CHECK (max_data_classification IN ('public', 'internal', 'confidential', 'restricted')),
      allow_prompt_caching boolean NOT NULL DEFAULT false,
      external_retention text NOT NULL DEFAULT 'unknown',
      training_policy text NOT NULL CHECK (training_policy IN ('no_training', 'may_train', 'unknown')),
      region text,
      jurisdiction text,
      required_redactions text[] NOT NULL DEFAULT '{}',
      allowed_content_types text[] NOT NULL DEFAULT '{}',
      terms_url text,
      last_reviewed_at timestamptz,
      reviewed_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // One row per (company, provider, model pattern): `COALESCE` makes the NULL tenant (platform default)
  // and the NULL model pattern (provider-wide) participate in uniqueness like any other value.
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS provider_data_policies_unique_idx" +
    "  ON provider_data_policies (COALESCE(company_id,''), provider_id, COALESCE(model_pattern,''))",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS provider_data_policies_company_idx" +
    "  ON provider_data_policies (company_id)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS provider_data_policies_provider_idx" +
    "  ON provider_data_policies (provider_id)",
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS code_project_data_policies (
      company_id text NOT NULL,
      project_id text NOT NULL,
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public', 'internal', 'confidential', 'restricted')),
      path_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
      policy_version integer NOT NULL DEFAULT 1,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, project_id)
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS code_project_data_policies_classification_idx" +
    "  ON code_project_data_policies (company_id, data_classification)",
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_data_policy_versions (
      id text PRIMARY KEY,
      company_id text,
      provider_id text NOT NULL,
      model_pattern text,
      policy_version integer NOT NULL,
      payload jsonb NOT NULL,
      actor text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS provider_data_policy_versions_unique_idx" +
    "  ON provider_data_policy_versions (COALESCE(company_id,''), provider_id, COALESCE(model_pattern,''), policy_version)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS provider_data_policy_versions_lookup_idx" +
    "  ON provider_data_policy_versions (company_id, provider_id, policy_version DESC)",
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_hosted_consent (
      company_id text NOT NULL,
      project_id text NOT NULL,
      provider_id text NOT NULL,
      granted_by text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      PRIMARY KEY (company_id, project_id, provider_id)
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS provider_hosted_consent_provider_idx" +
    "  ON provider_hosted_consent (company_id, provider_id)",
  );
}
