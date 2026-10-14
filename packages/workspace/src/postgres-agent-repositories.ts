import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuthContext, CompanyAgentEdge } from "./types.js";
import { companyEdgeColumns } from "./postgres-store-schema.js";
import { assertCompany } from "./postgres-store-support.js";
import * as company from "./postgres-company-repositories.js";

export async function setCompanyAgentParent(
  pool: Pool,
  context: AuthContext,
  companyId: string,
  childAgentId: string,
  parentAgentId: string | null,
): Promise<CompanyAgentEdge | null> {
  await assertCompany(pool, context, companyId);
  await company.getCompanyAgent(pool, context, companyId, childAgentId);
  if (parentAgentId === childAgentId) throw new Error("An agent cannot be its own parent");
  if (parentAgentId) await company.getCompanyAgent(pool, context, companyId, parentAgentId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [companyId]);
    await client.query(
      "DELETE FROM company_agent_edges WHERE workspace_id=$1 AND company_id=$2 AND child_agent_id=$3",
      [context.workspaceId, companyId, childAgentId],
    );
    if (!parentAgentId) {
      await client.query("COMMIT");
      return null;
    }
    const cycle = await client.query(
      `WITH RECURSIVE descendants(id) AS (
        SELECT child_agent_id FROM company_agent_edges WHERE workspace_id=$1 AND company_id=$2 AND parent_agent_id=$3
        UNION
        SELECT edge.child_agent_id FROM company_agent_edges edge JOIN descendants d ON edge.parent_agent_id=d.id
        WHERE edge.workspace_id=$1 AND edge.company_id=$2
      ) SELECT 1 FROM descendants WHERE id=$4 LIMIT 1`,
      [context.workspaceId, companyId, childAgentId, parentAgentId],
    );
    if (cycle.rowCount) throw new Error("Circular agent relationships are not allowed");

    const result = await client.query<CompanyAgentEdge>(
      `INSERT INTO company_agent_edges(
        id,workspace_id,company_id,parent_agent_id,child_agent_id,relation_type)
        VALUES ($1,$2,$3,$4,$5,'reports_to') RETURNING ${companyEdgeColumns}`,
      [randomUUID(), context.workspaceId, companyId, parentAgentId, childAgentId],
    );
    await client.query("COMMIT");
    return result.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
