CREATE TABLE IF NOT EXISTS research_jobs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  business_id uuid NOT NULL,
  user_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('search','fetch','crawl','competitor_analysis')),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS research_jobs_scope_created_idx
  ON research_jobs(workspace_id, business_id, user_id, created_at DESC);