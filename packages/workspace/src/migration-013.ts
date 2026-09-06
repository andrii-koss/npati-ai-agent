export default `
ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_missing_at timestamptz;
CREATE INDEX IF NOT EXISTS files_reconciliation_idx ON files(id) WHERE storage_deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS storage_reconciliation_audit (
  id uuid PRIMARY KEY,
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('minio_orphan_removed','database_object_missing','scan')),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','failed','skipped')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS storage_reconciliation_audit_created_idx ON storage_reconciliation_audit(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS storage_reconciliation_audit_object_idx ON storage_reconciliation_audit(bucket,object_key,created_at DESC);
`;
