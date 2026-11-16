import type { Pool } from "pg";
import { applyCodeInbox, emptyCodeInbox, type CodeInboxScope, type CodeInboxCommand, type CodeInboxStore } from "./code-session-inbox";

export class PostgresCodeInboxStore implements CodeInboxStore {
  constructor(private readonly pool: Pool) {}
  async transact(scope: CodeInboxScope, command: CodeInboxCommand) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO code_session_inboxes(company_id,project_id,session_id,data_classification,retention_class,state)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,session_id) DO NOTHING`,
        [scope.companyId, scope.projectId, scope.sessionId, scope.dataClassification, scope.retentionClass, emptyCodeInbox()]);
      const row = await client.query(`SELECT state FROM code_session_inboxes WHERE company_id=$1 AND project_id=$2 AND session_id=$3 FOR UPDATE`,
        [scope.companyId, scope.projectId, scope.sessionId]);
      if (!row.rowCount) throw new Error("inbox_scope_mismatch");
      // Run rows are locked too: heartbeat/takeover cannot change authority during admission.
      const runs = await client.query(`SELECT run_id,lease_owner,
        (status='running' AND lease_expires_at > clock_timestamp()) AS live,
        (status IN ('completed','failed','cancelled')) AS terminal, (status='interrupted') AS interrupted FROM code_run_states
        WHERE company_id=$1 AND session_id=$2 FOR UPDATE`, [scope.companyId, scope.sessionId]);
      const result = applyCodeInbox(row.rows[0].state, command,
        runs.rows.map((r) => ({ runId: r.run_id as string, owner: r.lease_owner as string | null, live: r.live === true, terminal: r.terminal === true, interrupted: r.interrupted === true })), new Date());
      if (command.kind !== "read") await client.query(`UPDATE code_session_inboxes SET state=$4,updated_at=clock_timestamp(),
        data_classification=(ARRAY['public','internal','confidential','restricted'])[GREATEST(
          array_position(ARRAY['public','internal','confidential','restricted'],data_classification),
          array_position(ARRAY['public','internal','confidential','restricted'],$5::text))],
        retention_class=(ARRAY['ephemeral','short','standard','extended','until_deleted'])[GREATEST(
          array_position(ARRAY['ephemeral','short','standard','extended','until_deleted'],retention_class),
          array_position(ARRAY['ephemeral','short','standard','extended','until_deleted'],$6::text))]
        WHERE company_id=$1 AND project_id=$2 AND session_id=$3`,
        [scope.companyId, scope.projectId, scope.sessionId, result.state, scope.dataClassification, scope.retentionClass]);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
