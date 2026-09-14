import type { PoolClient } from "pg";

export async function runMigration034(client:PoolClient):Promise<void>{
 await client.query(`
  CREATE TABLE IF NOT EXISTS company_memory_wiki_pages(
   id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
   company_id text NOT NULL,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   path text NOT NULL,title text NOT NULL,content text NOT NULL,tags jsonb NOT NULL DEFAULT '[]'::jsonb,
   outbound_links jsonb NOT NULL DEFAULT '[]'::jsonb,revision integer NOT NULL DEFAULT 1,
   created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT company_memory_wiki_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE,
   CONSTRAINT company_memory_wiki_path_unique UNIQUE(workspace_id,company_id,user_id,path)
  );
  CREATE INDEX IF NOT EXISTS company_memory_wiki_scope_idx ON company_memory_wiki_pages(workspace_id,company_id,user_id,updated_at DESC);
  CREATE TABLE IF NOT EXISTS company_dreaming_cycles(
   id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
   company_id text NOT NULL,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   idempotency_key text NOT NULL,status text NOT NULL CHECK(status IN('completed','failed')),
   result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT company_dreaming_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE,
   CONSTRAINT company_dreaming_idempotency_unique UNIQUE(workspace_id,company_id,user_id,idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS company_action_memory_rules(
   id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
   company_id text NOT NULL,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   action_name text NOT NULL,title text NOT NULL,instruction text NOT NULL,
   risk_level text NOT NULL DEFAULT 'medium' CHECK(risk_level IN('low','medium','high')),
   revision integer NOT NULL DEFAULT 1,idempotency_key text NOT NULL,
   created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
   CONSTRAINT company_action_memory_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE,
   CONSTRAINT company_action_memory_idempotency_unique UNIQUE(workspace_id,company_id,user_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS company_action_memory_scope_idx ON company_action_memory_rules(workspace_id,company_id,user_id,action_name) WHERE deleted_at IS NULL;
 `);
}
export default runMigration034;
