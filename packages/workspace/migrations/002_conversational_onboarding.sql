ALTER TABLE businesses ADD COLUMN IF NOT EXISTS activation_status text NOT NULL DEFAULT 'active';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS products_services_summary text;

CREATE TABLE IF NOT EXISTS business_onboarding_sessions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scenario text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_step integer NOT NULL DEFAULT 0,
  completed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  skipped_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_workspace_user_idx
  ON business_onboarding_sessions(workspace_id, user_id, status, updated_at DESC);
