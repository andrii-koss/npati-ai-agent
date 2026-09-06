export default `
CREATE TABLE IF NOT EXISTS workspace_user_settings (
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  setting_key text NOT NULL CHECK (length(setting_key) BETWEEN 1 AND 120),
  value jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, setting_key),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members(workspace_id, user_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_user_settings_updated_idx
  ON workspace_user_settings(workspace_id, user_id, updated_at DESC);
`;
