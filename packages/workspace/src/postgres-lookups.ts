/* The cross-domain lookups of the Postgres workspace store, split out in architectural step 1b of
 * docs/refactoring/PLAN.md.
 *
 * Every domain module needs the same two questions answered before it may touch a row - "is this caller a
 * member of the workspace" and "does this company/project/business belong to them" - and the facade answered
 * them with five private methods called from eighty-seven places. They are the coupling that would otherwise
 * make every domain depend on the facade, so they live here as plain functions over the pool: the domain
 * modules import them, the facade delegates to them, and there is still exactly one implementation.
 *
 * The bodies are the previous method bodies with `this.pool` replaced by the `pool` argument and `this.other`
 * by the sibling function; the store's public methods keep their signatures and simply delegate.
 */
import { Pool } from "pg";
import { businessColumns, companyColumns, projectColumns } from "./postgres-store-schema";
import {
  WorkspaceAccessError,
  WorkspaceNotFoundError,
  type AuthContext,
  type Business,
  type Company,
  type Project,
} from "./types";

export async function ensureIdentity(pool: Pool, context: AuthContext) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO users(id, external_subject, display_name) VALUES ($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET external_subject=COALESCE(EXCLUDED.external_subject,users.external_subject), updated_at=now()`, [context.userId, context.externalSubject ?? null, "Dev User"]);
    await client.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [context.workspaceId, "My Workspace", context.userId]);
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING`, [context.workspaceId, context.userId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function assertMember(pool: Pool, context: AuthContext) {
  const result = await pool.query("SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId]);
  if (!result.rowCount) throw new WorkspaceAccessError("Workspace access denied");
  return String(result.rows[0].role);
}

export async function getBusiness(pool: Pool, context: AuthContext, businessId: string) {
  await assertMember(pool, context);
  const result = await pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE id=$1 AND workspace_id=$2`, [businessId, context.workspaceId]);
  if (!result.rowCount) throw new WorkspaceAccessError("Business is not available in this workspace");
  return result.rows[0]!;
}

export async function assertCompany(pool: Pool, context: AuthContext, companyId: string) {
  if (context.companyId && context.companyId !== companyId) throw new WorkspaceAccessError("API key is not valid for this company");
  await assertMember(pool, context);
  const result = await pool.query<Company>(`SELECT ${companyColumns} FROM companies WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, [companyId, context.workspaceId, context.userId]);
  if (!result.rowCount) throw new WorkspaceAccessError("Company is not available to this user");
  return result.rows[0]!;
}

export async function getProject(pool: Pool, context: AuthContext, companyId: string, projectId: string) {
  await assertCompany(pool, context, companyId);
  const result = await pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4`,
    [projectId, context.workspaceId, companyId, context.userId]);
  if (!result.rows[0]) throw new WorkspaceNotFoundError("Project not found");
  return result.rows[0];
}
