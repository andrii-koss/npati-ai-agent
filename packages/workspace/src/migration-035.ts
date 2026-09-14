import type{PoolClient}from"pg";
export async function runMigration035(client:PoolClient):Promise<void>{await client.query(`
 CREATE TABLE IF NOT EXISTS company_memory_import_batches(
  id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id text NOT NULL,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,format text NOT NULL,source_name text NOT NULL,
  imported_count integer NOT NULL DEFAULT 0,duplicate_count integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'completed' CHECK(status IN('completed','rolled_back')),rolled_back_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_memory_import_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE,
  CONSTRAINT company_memory_import_idempotency_unique UNIQUE(workspace_id,company_id,user_id,idempotency_key)
 );
 ALTER TABLE company_memories ADD COLUMN IF NOT EXISTS import_hash text;
 ALTER TABLE company_memories ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES company_memory_import_batches(id) ON DELETE SET NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS company_memories_import_hash_unique ON company_memories(workspace_id,company_id,user_id,import_hash) WHERE import_hash IS NOT NULL AND deleted_at IS NULL;
 CREATE INDEX IF NOT EXISTS company_memory_import_scope_idx ON company_memory_import_batches(workspace_id,company_id,user_id,created_at DESC);
`)}
export default runMigration035;
