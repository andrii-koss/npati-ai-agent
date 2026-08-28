CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, external_subject text UNIQUE, display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY, name text NOT NULL, owner_user_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner', current_business_id text,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS businesses (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id), name text NOT NULL, business_type text,
  industry text, niche text, country text, market text, website text, business_stage text NOT NULL DEFAULT 'starting',
  team_type text, business_model text, presence_type text, description text, audience_summary text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS businesses_workspace_idx ON businesses(workspace_id);
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_current_business_fk;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_current_business_fk FOREIGN KEY (current_business_id) REFERENCES businesses(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS goals (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, created_by_user_id text NOT NULL REFERENCES users(id),
  title text NOT NULL, description text, status text NOT NULL DEFAULT 'active', target_value numeric,
  target_unit text, current_value numeric, target_date date, priority integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goals_business_idx ON goals(workspace_id, business_id, status);
CREATE TABLE IF NOT EXISTS memory_items (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id),
  type text NOT NULL, title text NOT NULL, content text NOT NULL, source text NOT NULL DEFAULT 'user',
  confidence numeric, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_business_idx ON memory_items(workspace_id, business_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id),
  title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_business_idx ON conversations(workspace_id, business_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
