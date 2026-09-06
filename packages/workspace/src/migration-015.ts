export default String.raw`
CREATE TABLE IF NOT EXISTS company_automations (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id text,
  name text NOT NULL,
  description text,
  prompt text NOT NULL,
  cron_expression text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Kyiv',
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','paused','deleted')),
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  worker_id text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT company_automations_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS company_automations_list_idx ON company_automations(workspace_id,company_id,user_id,status,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS company_automations_tick_idx ON company_automations(status,next_run_at,lease_expires_at) WHERE status='active' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS company_automation_runs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  automation_id uuid NOT NULL REFERENCES company_automations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK(status IN('running','completed','failed','cancelled')),
  result text,
  error_message text,
  duration_ms integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT company_automation_runs_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS company_automation_runs_history_idx ON company_automation_runs(automation_id,started_at DESC);
`;
