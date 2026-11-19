import type { Pool } from "pg";
import { WorkspaceAccessError, type AuthContext } from "./types";

export type ContentLibraryRun = {
  id: string;
  companyId: string;
  companyName: string;
  task: string;
  result: string;
  createdAt: string;
};

export type ContentLibraryRead = { runs: ContentLibraryRun[]; overrides: unknown };
export const contentRunsPerCompany = 100;

export async function readContentLibrary(pool: Pool, context: AuthContext, settingsKey: string): Promise<ContentLibraryRead> {
  const result = await pool.query<ContentLibraryRead>(
    `SELECT
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('id', run.id, 'companyId', company.id, 'companyName', company.name,
            'task', run.task, 'result', run.result, 'createdAt', run.created_at)
          ORDER BY date_trunc('milliseconds', company.created_at), company.id, run.created_at DESC, run.id DESC
        )
        FROM companies AS company
        CROSS JOIN LATERAL (
          SELECT id, task, result, status, created_at
          FROM company_agent_runs
          WHERE workspace_id=member.workspace_id AND company_id=company.id
            AND left(task, 15)='[NPATI_CONTENT:'
          ORDER BY created_at DESC, id DESC LIMIT $4
        ) AS run
        WHERE company.workspace_id=member.workspace_id AND company.user_id=member.user_id
          AND ($3::text IS NULL OR company.id=$3)
          AND run.status='completed' AND run.result<>''
      ), '[]'::jsonb) AS runs,
      (SELECT value FROM workspace_user_settings
       WHERE workspace_id=member.workspace_id AND user_id=member.user_id AND setting_key=$5) AS overrides
    FROM workspace_members AS member
    WHERE member.workspace_id=$1 AND member.user_id=$2`,
    [context.workspaceId, context.userId, context.companyId ?? null, contentRunsPerCompany, settingsKey],
  );
  const row = result.rows[0];
  if (!row) throw new WorkspaceAccessError("Workspace access denied");
  return row;
}
