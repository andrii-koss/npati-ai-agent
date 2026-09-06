export default String.raw`
CREATE TABLE IF NOT EXISTS company_webhooks (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  secret text NOT NULL UNIQUE,
  agent_id text,
  prompt_template text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_webhooks_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS company_webhooks_secret_idx ON company_webhooks(secret) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS company_webhooks_list_idx ON company_webhooks(workspace_id,company_id,created_at DESC);

CREATE TABLE IF NOT EXISTS company_mcp_servers (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  transport text NOT NULL DEFAULT 'http' CHECK(transport IN('http','sse','stdio')),
  endpoint text NOT NULL,
  auth_token text,
  scopes text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'connected' CHECK(status IN('connected','unreachable','error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_mcp_servers_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS company_mcp_servers_list_idx ON company_mcp_servers(workspace_id,company_id,created_at DESC);
`;
