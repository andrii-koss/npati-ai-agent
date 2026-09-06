export default `
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_business_tenant_fk;
ALTER TABLE files ADD CONSTRAINT files_business_tenant_fk
  FOREIGN KEY (workspace_id, business_id)
  REFERENCES businesses(workspace_id, id)
  ON DELETE SET NULL (business_id);
`;
