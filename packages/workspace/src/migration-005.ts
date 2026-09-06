export default `
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS create_request_key text;
CREATE UNIQUE INDEX IF NOT EXISTS businesses_create_request_unique_idx
  ON businesses(workspace_id, owner_user_id, create_request_key)
  WHERE create_request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS businesses_company_page_idx
  ON businesses(workspace_id, activation_status, created_at, id);
`;
