export default String.raw`
CREATE TABLE IF NOT EXISTS company_approvals (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id text,
  agent_id text,
  tool_name text NOT NULL,
  risk_level text NOT NULL DEFAULT 'high' CHECK(risk_level IN('low','medium','high','critical')),
  action_summary text NOT NULL,
  input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','expired')),
  decision_notes text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  responded_by text,
  CONSTRAINT company_approvals_company_fk FOREIGN KEY(company_id,workspace_id) REFERENCES companies(id,workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS company_approvals_list_idx ON company_approvals(workspace_id,company_id,status,requested_at DESC);
`;
