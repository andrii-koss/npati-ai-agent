export default `
ALTER TABLE company_agent_runs DROP CONSTRAINT IF EXISTS company_agent_runs_main_agent_fk;
ALTER TABLE company_agent_run_steps DROP CONSTRAINT IF EXISTS company_agent_run_steps_agent_fk;
ALTER TABLE company_agent_tool_audit DROP CONSTRAINT IF EXISTS company_agent_tool_audit_agent_fk;
`;
