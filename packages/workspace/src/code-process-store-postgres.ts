import type { Pool } from "pg";
import { applyCodeProcess, type CodeProcessScope, type CodeProcessCommand, type CodeProcessStore } from "./code-process-store";
export class PostgresCodeProcessStore implements CodeProcessStore {
  constructor(private readonly pool: Pool) {}
  async transact(scope: CodeProcessScope, command: CodeProcessCommand) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO code_process_projects(company_id,project_id,state,data_classification,retention_class)
        VALUES($1,$2,'{"operations":[],"cleanupToken":null}'::jsonb,$3,$4) ON CONFLICT DO NOTHING`,
        [scope.companyId, scope.projectId, scope.dataClassification, scope.retentionClass]);
      const row = await client.query("SELECT state FROM code_process_projects WHERE company_id=$1 AND project_id=$2 FOR UPDATE", [scope.companyId, scope.projectId]);
      const runs = await client.query(`SELECT run_id,session_id,lease_owner,(status='running' AND lease_expires_at>clock_timestamp()) AS live,
        (status IN ('completed','failed','cancelled')) AS terminal FROM code_run_states WHERE company_id=$1 AND project_id=$2 FOR UPDATE`, [scope.companyId, scope.projectId]);
      const result = applyCodeProcess(row.rows[0].state, scope, command, runs.rows.map((r) => ({ runId: r.run_id, sessionId: r.session_id, owner: r.lease_owner, live: r.live, terminal: r.terminal })), new Date());
      if (command.kind !== "read") await client.query(`UPDATE code_process_projects SET state=$3,updated_at=clock_timestamp(),
        data_classification=(ARRAY['public','internal','confidential','restricted'])[GREATEST(array_position(ARRAY['public','internal','confidential','restricted'],data_classification),array_position(ARRAY['public','internal','confidential','restricted'],$4::text))],
        retention_class=(ARRAY['ephemeral','short','standard','extended','until_deleted'])[GREATEST(array_position(ARRAY['ephemeral','short','standard','extended','until_deleted'],retention_class),array_position(ARRAY['ephemeral','short','standard','extended','until_deleted'],$5::text))]
        WHERE company_id=$1 AND project_id=$2`, [scope.companyId, scope.projectId, result.state, scope.dataClassification, scope.retentionClass]);
      await client.query("COMMIT"); return result.result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
