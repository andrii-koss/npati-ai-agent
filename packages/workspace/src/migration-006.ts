export default `
CREATE UNIQUE INDEX IF NOT EXISTS businesses_workspace_id_id_key ON businesses(workspace_id, id);

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id text,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  website text,
  industry text,
  description text,
  products_services text,
  languages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(languages) = 'array'),
  brand_tone text,
  company_instructions text,
  knowledge jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(knowledge) = 'array'),
  memory jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(memory) = 'object'),
  main_agent_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  create_request_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_business_tenant_fk FOREIGN KEY (workspace_id, business_id)
    REFERENCES businesses(workspace_id, id) ON DELETE SET NULL (business_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_id_id_key ON companies(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS companies_user_create_request_key
  ON companies(workspace_id, user_id, create_request_key) WHERE create_request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS companies_tenant_page_idx
  ON companies(workspace_id, user_id, created_at, id);
CREATE INDEX IF NOT EXISTS companies_business_idx
  ON companies(workspace_id, business_id) WHERE business_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS company_agents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (length(trim(role)) BETWEEN 1 AND 200),
  description text,
  system_instruction text,
  prompt_guidelines text,
  recommended_prompts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recommended_prompts) = 'array'),
  model_id text,
  fallback_model_id text,
  tools_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tools_json) = 'array'),
  is_active boolean NOT NULL DEFAULT true,
  position_x double precision,
  position_y double precision,
  sort_order integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  create_request_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_agents_company_tenant_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES companies(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_agents_company_id_id_key UNIQUE (company_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS company_agents_create_request_key
  ON company_agents(workspace_id, company_id, create_request_key) WHERE create_request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_agents_company_order_idx
  ON company_agents(workspace_id, company_id, sort_order, created_at, id);

CREATE TABLE IF NOT EXISTS company_agent_edges (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  parent_agent_id text NOT NULL,
  child_agent_id text NOT NULL,
  relation_type text NOT NULL DEFAULT 'reports_to',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_agent_edges_no_self CHECK (parent_agent_id <> child_agent_id),
  CONSTRAINT company_agent_edges_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES companies(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_agent_edges_parent_fk FOREIGN KEY (company_id, parent_agent_id)
    REFERENCES company_agents(company_id, id) ON DELETE CASCADE,
  CONSTRAINT company_agent_edges_child_fk FOREIGN KEY (company_id, child_agent_id)
    REFERENCES company_agents(company_id, id) ON DELETE CASCADE,
  CONSTRAINT company_agent_edges_unique_pair UNIQUE (company_id, parent_agent_id, child_agent_id),
  CONSTRAINT company_agent_edges_one_parent UNIQUE (company_id, child_agent_id)
);

CREATE INDEX IF NOT EXISTS company_agent_edges_parent_idx
  ON company_agent_edges(workspace_id, company_id, parent_agent_id);

DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_main_agent_fk'
  ) THEN
    ALTER TABLE companies ADD CONSTRAINT companies_main_agent_fk
      FOREIGN KEY (id, main_agent_id) REFERENCES company_agents(company_id, id)
      ON DELETE SET NULL (main_agent_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
\$\$;
`;
