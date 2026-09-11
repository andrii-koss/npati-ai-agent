export default `
CREATE TABLE IF NOT EXISTS company_agent_run_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id text NOT NULL,
  run_id text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('queued','claimed','started','retry_scheduled','completed','failed','cancelled')),
  run_status text NOT NULL CHECK (run_status IN ('queued','planning','running','completed','failed','cancelling','cancelled')),
  worker_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_agent_run_events_run_fk FOREIGN KEY (run_id)
    REFERENCES company_agent_runs(id) ON DELETE CASCADE,
  CONSTRAINT company_agent_run_events_idempotency UNIQUE (run_id, event_key)
);

CREATE INDEX IF NOT EXISTS company_agent_run_events_tenant_idx
  ON company_agent_run_events(workspace_id, company_id, run_id, created_at, id);
`;
