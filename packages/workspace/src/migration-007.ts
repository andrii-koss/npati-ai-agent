export default `
CREATE TABLE IF NOT EXISTS company_agent_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  main_agent_id text NOT NULL,
  idempotency_key text NOT NULL,
  task text NOT NULL CHECK (length(trim(task)) BETWEEN 1 AND 20000),
  requested_mode text NOT NULL DEFAULT 'auto' CHECK (requested_mode IN ('auto','single','pipeline','fusion')),
  execution_mode text CHECK (execution_mode IN ('single','pipeline','fusion')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','planning','running','completed','failed','cancelling','cancelled')),
  selected_agent_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selected_agent_ids) = 'array'),
  omniroute_task_id text,
  omniroute_combo_name text,
  result text,
  error_code text,
  error_message text,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_agent_runs_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES companies(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_agent_runs_idempotency UNIQUE (workspace_id, company_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS company_agent_runs_tenant_page_idx
  ON company_agent_runs(workspace_id, company_id, user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS company_agent_runs_active_idx
  ON company_agent_runs(workspace_id, company_id, status, updated_at)
  WHERE status IN ('queued','planning','running','cancelling');

CREATE TABLE IF NOT EXISTS company_agent_run_steps (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  run_id text NOT NULL,
  agent_id text NOT NULL,
  step_order integer NOT NULL CHECK (step_order >= 0),
  lane integer NOT NULL DEFAULT 0 CHECK (lane >= 0),
  role text NOT NULL DEFAULT 'worker' CHECK (role IN ('manager','worker','reviewer')),
  status text NOT NULL DEFAULT 'selected' CHECK (status IN ('selected','delegated','completed','failed','cancelled')),
  model_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_agent_run_steps_run_fk FOREIGN KEY (run_id)
    REFERENCES company_agent_runs(id) ON DELETE CASCADE,
  CONSTRAINT company_agent_run_steps_unique_agent UNIQUE (run_id, agent_id)
);

CREATE INDEX IF NOT EXISTS company_agent_run_steps_tenant_idx
  ON company_agent_run_steps(workspace_id, company_id, run_id, step_order, lane);

CREATE TABLE IF NOT EXISTS company_agent_tool_audit (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  run_id text NOT NULL,
  agent_id text NOT NULL,
  tool_name text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allowed','denied')),
  status text NOT NULL CHECK (status IN ('requested','succeeded','failed','blocked')),
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_summary) = 'object'),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT company_agent_tool_audit_run_fk FOREIGN KEY (run_id)
    REFERENCES company_agent_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS company_agent_tool_audit_tenant_idx
  ON company_agent_tool_audit(workspace_id, company_id, run_id, created_at, id);
`;
