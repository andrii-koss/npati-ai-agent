export default String.raw`
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS company_knowledge_documents (
 id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 company_id text NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'uploaded' CHECK(status IN('uploaded','processing','ready','failed','deleted')),
 error_message text, chunk_count integer NOT NULL DEFAULT 0, embedding_model text, embedding_dimensions integer,
 idempotency_key text, attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), worker_id text, lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 CONSTRAINT company_knowledge_documents_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE,
 CONSTRAINT company_knowledge_documents_file_scope_unique UNIQUE(file_id,workspace_id,company_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS company_knowledge_documents_idempotency_idx ON company_knowledge_documents(workspace_id,user_id,company_id,idempotency_key) WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS company_knowledge_documents_list_idx ON company_knowledge_documents(workspace_id,user_id,company_id,created_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS company_knowledge_documents_recovery_idx ON company_knowledge_documents(status,next_attempt_at,lease_expires_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS company_knowledge_chunks (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, company_id text NOT NULL,
 document_id uuid NOT NULL REFERENCES company_knowledge_documents(id) ON DELETE CASCADE,
 chunk_index integer NOT NULL, content text NOT NULL, content_hash text NOT NULL, token_count integer NOT NULL DEFAULT 0,
 embedding vector, embedding_model text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT company_knowledge_chunks_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE,
 CONSTRAINT company_knowledge_chunks_order_unique UNIQUE(document_id,chunk_index),
 CONSTRAINT company_knowledge_chunks_hash_unique UNIQUE(document_id,content_hash)
);
CREATE INDEX IF NOT EXISTS company_knowledge_chunks_scope_idx ON company_knowledge_chunks(workspace_id,company_id,document_id);
CREATE TABLE IF NOT EXISTS company_memories (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, company_id text NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, content text NOT NULL, source text NOT NULL DEFAULT 'manual',
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 CONSTRAINT company_memories_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS company_memories_list_idx ON company_memories(workspace_id,user_id,company_id,updated_at DESC,id) WHERE deleted_at IS NULL;
`;
