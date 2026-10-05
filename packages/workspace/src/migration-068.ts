import type { PoolClient } from "pg";

/**
 * C1b: sandbox image supply chain.
 *
 * Additive only (expand): `sandbox_images` is the admission catalogue. Every row pins an image by
 * digest (`repo@sha256:<64 hex>`); tags are never stored, because a tag is not an identity. The row
 * also carries the evidence an admission decision needs: signature identity, SBOM path, scan results
 * and an optional signed-off waiver with an owner and an expiry.
 *
 * Revocation is recorded on the row (status + actor + reason + timestamp) so the decision to stop
 * trusting an image is itself reviewable, and `previous_reference` supports rolling back to the
 * digest that was in use before the last promotion.
 */
export async function runMigration068(client: PoolClient) {
  await client.query([
    "CREATE TABLE IF NOT EXISTS sandbox_images (",
    "  id text PRIMARY KEY,",
    "  workspace_id text NOT NULL,",
    "  variant text NOT NULL CHECK (variant IN ('base','node','python','go','rust','java','php')),",
    "  reference text NOT NULL,",
    "  digest text NOT NULL,",
    "  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified','deprecated','revoked')),",
    "  signature text,",
    "  signature_issuer text,",
    "  sbom_path text,",
    "  scan_tool text,",
    "  scan_at timestamptz,",
    "  scan_critical integer NOT NULL DEFAULT 0 CHECK (scan_critical >= 0),",
    "  scan_high integer NOT NULL DEFAULT 0 CHECK (scan_high >= 0),",
    "  waiver_owner text,",
    "  waiver_expires_at timestamptz,",
    "  waiver_reason text,",
    "  previous_reference text,",
    "  revoked_at timestamptz,",
    "  revoked_by text,",
    "  revoke_reason text,",
    "  created_by text NOT NULL,",
    "  created_at timestamptz NOT NULL DEFAULT now(),",
    "  updated_at timestamptz NOT NULL DEFAULT now(),",
    "  CONSTRAINT sandbox_images_reference_key UNIQUE (workspace_id, reference)",
    ");",
    "CREATE INDEX IF NOT EXISTS sandbox_images_variant_idx ON sandbox_images(workspace_id, variant, status);",
    "CREATE INDEX IF NOT EXISTS sandbox_images_status_idx ON sandbox_images(workspace_id, status, created_at DESC);",
  ].join("\n"));
}
