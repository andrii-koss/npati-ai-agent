import type { PoolClient } from "pg";

/**
 * Security audit 2026-11-24, L8: messaging pairing by an unguessable deep-link token, and a limit on wrong 6-digit codes.
 * Both columns are additive; existing pending connections keep their 6-digit code until it expires or is re-issued.
 */
export async function runMigration099(client: PoolClient) {
  await client.query(`ALTER TABLE messaging_connections
    ADD COLUMN IF NOT EXISTS pairing_link_hash TEXT,
    ADD COLUMN IF NOT EXISTS pairing_failed_attempts INTEGER NOT NULL DEFAULT 0`);
}
