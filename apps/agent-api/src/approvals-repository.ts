import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface CompanyApproval {
  id: string;
  workspaceId: string;
  companyId: string;
  userId: string;
  runId?: string | null;
  agentId?: string | null;
  toolName: string;
  riskLevel: RiskLevel;
  actionSummary: string;
  inputPayload: Record<string, unknown>;
  status: ApprovalStatus;
  decisionNotes?: string | null;
  requestedAt: string;
  respondedAt?: string | null;
  respondedBy?: string | null;
}

export interface CreateApprovalInput {
  runId?: string;
  agentId?: string;
  toolName: string;
  riskLevel?: RiskLevel;
  actionSummary: string;
  inputPayload?: Record<string, unknown>;
}

const appCols = `id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
  run_id AS "runId", agent_id AS "agentId", tool_name AS "toolName", risk_level AS "riskLevel",
  action_summary AS "actionSummary", input_payload AS "inputPayload", status,
  decision_notes AS "decisionNotes", requested_at AS "requestedAt",
  responded_at AS "respondedAt", responded_by AS "respondedBy"`;

export class CompanyApprovalsRepository {
  private pool: Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  async list(ctx: AuthContext, companyId: string, status?: ApprovalStatus): Promise<CompanyApproval[]> {
    const query = status
      ? `SELECT ${appCols} FROM company_approvals
         WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3 AND status = $4
         ORDER BY requested_at DESC LIMIT 50`
      : `SELECT ${appCols} FROM company_approvals
         WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3
         ORDER BY requested_at DESC LIMIT 50`;
    const params = status
      ? [ctx.workspaceId, companyId, ctx.userId, status]
      : [ctx.workspaceId, companyId, ctx.userId];

    const result = await this.pool.query<CompanyApproval>(query, params);
    return result.rows;
  }

  async get(ctx: AuthContext, companyId: string, id: string): Promise<CompanyApproval> {
    const result = await this.pool.query<CompanyApproval>(
      `SELECT ${appCols} FROM company_approvals
       WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4`,
      [id, ctx.workspaceId, companyId, ctx.userId]
    );
    if (!result.rows[0]) throw Object.assign(new Error("Approval request not found"), { status: 404 });
    return result.rows[0];
  }

  async requestApproval(ctx: AuthContext, companyId: string, input: CreateApprovalInput): Promise<CompanyApproval> {
    const id = randomUUID();
    const result = await this.pool.query<CompanyApproval>(
      `INSERT INTO company_approvals (
         id, workspace_id, company_id, user_id, run_id, agent_id,
         tool_name, risk_level, action_summary, input_payload, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       RETURNING ${appCols}`,
      [
        id,
        ctx.workspaceId,
        companyId,
        ctx.userId,
        input.runId || null,
        input.agentId || null,
        input.toolName,
        input.riskLevel || "high",
        input.actionSummary.trim(),
        JSON.stringify(input.inputPayload || {}),
      ]
    );
    return result.rows[0]!;
  }

  async decide(
    ctx: AuthContext,
    companyId: string,
    id: string,
    decision: "approved" | "rejected",
    notes?: string
  ): Promise<CompanyApproval> {
    const current = await this.get(ctx, companyId, id);
    if (current.status !== "pending") {
      throw new Error(`Approval is already resolved with status "${current.status}"`);
    }

    const result = await this.pool.query<CompanyApproval>(
      `UPDATE company_approvals SET
         status = $5,
         decision_notes = $6,
         responded_at = now(),
         responded_by = $7
       WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4
       RETURNING ${appCols}`,
      [id, ctx.workspaceId, companyId, ctx.userId, decision, notes?.trim() || null, ctx.userId]
    );
    return result.rows[0]!;
  }

  async close() {
    await this.pool.end();
  }
}
