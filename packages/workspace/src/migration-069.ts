import type { PoolClient } from "pg";

/**
 * C4 (owner decision): a Company credential carries an explicit environment marker.
 *
 * Additive only (expand): existing rows and older application versions keep working, and every
 * credential that has no marker stays `unknown`, which the SecretLease policy treats as **not**
 * leasable — an unknown marker must never be read as "safe".
 *
 * Values: `development | staging | production | unknown`.
 */
export async function runMigration069(client: PoolClient): Promise<void> {
  await client.query([
    "ALTER TABLE company_browser_credentials ADD COLUMN IF NOT EXISTS environment text;",
    "UPDATE company_browser_credentials SET environment='unknown' WHERE environment IS NULL;",
    "ALTER TABLE company_browser_credentials ALTER COLUMN environment SET DEFAULT 'unknown';",
    "ALTER TABLE company_browser_credentials ALTER COLUMN environment SET NOT NULL;",
    "ALTER TABLE company_browser_credentials DROP CONSTRAINT IF EXISTS company_browser_credentials_environment_check;",
    "ALTER TABLE company_browser_credentials ADD CONSTRAINT company_browser_credentials_environment_check CHECK (environment IN ('development','staging','production','unknown'));",
    // Lease metadata lookups go through (workspace, company, id); the index keeps the authoritative
    // environment lookup cheap even though the credential table grows per company.
    "CREATE INDEX IF NOT EXISTS idx_company_browser_credentials_environment ON company_browser_credentials(workspace_id, company_id, environment);",
  ].join("\n"));
}

export default runMigration069;
