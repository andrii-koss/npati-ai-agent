-- Read-only production inspection. Run with: psql "$DATABASE_URL" -v run_id=<uuid> -f scripts/ops/inspect-terminal-approval.sql
-- Output can contain the original command. Review it for secrets before sharing.
WITH selected_run AS (
  SELECT r.id, r.company_id, r.workspace_id, r.user_id, r.project_id, r.idempotency_key,
         r.requested_mode, r.status, r.error_code, r.error_message, r.pending_plan,
         r.pending_plan->'plan'->'toolRequests'->((r.pending_plan->>'nextToolIndex')::integer) AS pending_tool
  FROM company_agent_runs r
  WHERE r.id = :'run_id'
)
SELECT r.id AS run_id, r.status AS run_status, r.requested_mode AS run_type,
       r.idempotency_key, r.project_id, p.sandbox_id,
       r.pending_tool->>'agentId' AS agent_id,
       r.pending_tool->>'tool' AS tool_name,
       r.pending_tool->'input'->>'command' AS raw_command,
       r.pending_tool->'input'->>'executable' AS executable,
       r.pending_tool->'input'->'args' AS raw_args,
       r.pending_tool->'input'->>'cwd' AS cwd,
       r.pending_tool->'input'->>'action' AS action,
       r.error_code, r.error_message,
       a.id AS approval_id, a.status AS approval_status, a.input_payload AS approval_payload
FROM selected_run r
LEFT JOIN projects p ON p.id = r.project_id AND p.company_id = r.company_id AND p.workspace_id = r.workspace_id
LEFT JOIN LATERAL (
  SELECT id, status, input_payload FROM company_approvals
  WHERE run_id = r.id AND company_id = r.company_id AND workspace_id = r.workspace_id
  ORDER BY requested_at DESC LIMIT 1
) a ON true;
