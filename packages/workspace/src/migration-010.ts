export default `
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id text,
  chat_id text REFERENCES conversations(id) ON DELETE SET NULL,
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  checksum text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploading','uploaded','processing','ready','failed','deleted')),
  idempotency_key text,
  scanner_status text NOT NULL DEFAULT 'pending' CHECK (scanner_status IN ('pending','clean','blocked','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT files_company_tenant_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES companies(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (bucket, object_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS files_idempotency_idx ON files(workspace_id,user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS files_tenant_created_idx ON files(workspace_id,user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS files_company_created_idx ON files(workspace_id,company_id,created_at DESC,id DESC) WHERE company_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS files_chat_created_idx ON files(workspace_id,chat_id,created_at,id) WHERE chat_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS files_checksum_idx ON files(workspace_id,checksum) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS files_cleanup_idx ON files(status,updated_at) WHERE status IN ('uploading','failed','deleted');
`;
