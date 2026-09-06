export default `
ALTER TABLE files ADD COLUMN IF NOT EXISTS business_id text;
ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_deleted_at timestamptz;
ALTER TABLE files ADD COLUMN IF NOT EXISTS delete_attempts integer NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS businesses_workspace_id_id_files_key ON businesses(workspace_id, id);

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_business_tenant_fk') THEN
    ALTER TABLE files ADD CONSTRAINT files_business_tenant_fk
      FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE RESTRICT;
  END IF;
END \$\$;

CREATE INDEX IF NOT EXISTS files_business_created_idx
  ON files(workspace_id,business_id,created_at DESC,id DESC)
  WHERE business_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS files_storage_cleanup_idx
  ON files(updated_at,id) WHERE deleted_at IS NOT NULL AND storage_deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS file_audit (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('upload','download','delete','migrate','cleanup')),
  outcome text NOT NULL CHECK (outcome IN ('requested','succeeded','failed','denied')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS file_audit_tenant_idx ON file_audit(workspace_id,user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS file_audit_file_idx ON file_audit(file_id,created_at DESC,id DESC);
`;
