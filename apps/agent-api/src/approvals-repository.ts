import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import { RiskApprovalService } from "@npati/shared";

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
  payloadHash?: string | null;
  expiresAt?: string | null;
  consumedAt?: string | null;
}

export interface CreateApprovalInput {
  runId?: string;
  agentId?: string;
  toolName: string;
  riskLevel?: RiskLevel;
  actionSummary: string;
  inputPayload?: Record<string, unknown>;
  ttlMs?: number;
}

const appCols = `id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
  run_id AS "runId", agent_id AS "agentId", tool_name AS "toolName", risk_level AS "riskLevel",
  action_summary AS "actionSummary", input_payload AS "inputPayload", status,
  decision_notes AS "decisionNotes", requested_at AS "requestedAt",
  responded_at AS "respondedAt", responded_by AS "respondedBy",
  payload_hash AS "payloadHash", expires_at AS "expiresAt", consumed_at AS "consumedAt"`;

export class CompanyApprovalsRepository {
  private pool: Pool;
  private readonly risk = new RiskApprovalService();
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
    const payload = input.inputPayload || {};
    const payloadHash = this.risk.computePayloadHash(payload);
    const expiresAt = new Date(Date.now() + Math.max(1_000, Math.min(input.ttlMs ?? 900_000, 86_400_000)));
    const result = await this.pool.query<CompanyApproval>(
      `INSERT INTO company_approvals (
         id, workspace_id, company_id, user_id, run_id, agent_id,
         tool_name, risk_level, action_summary, input_payload, status, payload_hash, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)
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
        JSON.stringify(payload),
        payloadHash,
        expiresAt,
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
    if (current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) {
      await this.pool.query("UPDATE company_approvals SET status='expired' WHERE id=$1 AND status='pending'", [id]);
      throw Object.assign(new Error("Approval request has expired"), { status: 409, code: "APPROVAL_EXPIRED" });
    }
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

  async consumeApproved(ctx: AuthContext, companyId: string, id: string, params: {
    runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown>;
  }): Promise<CompanyApproval> {
    const payloadHash = this.risk.computePayloadHash(params.inputPayload);
    const result = await this.pool.query<CompanyApproval>(`UPDATE company_approvals SET consumed_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4
        AND run_id=$5 AND agent_id=$6 AND tool_name=$7 AND payload_hash=$8
        AND status='approved' AND consumed_at IS NULL AND expires_at>now()
      RETURNING ${appCols}`, [id, ctx.workspaceId, companyId, ctx.userId, params.runId, params.agentId, params.toolName, payloadHash]);
    if (result.rows[0]) return result.rows[0];
    const current = await this.get(ctx, companyId, id);
    const reason = current.consumedAt ? "Approval has already been consumed"
      : current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now() ? "Approval has expired"
      : current.status !== "approved" ? `Approval is not approved (status: ${current.status})`
      : "Approval context or payload does not match";
    throw Object.assign(new Error(reason), { status: 409, code: current.consumedAt ? "APPROVAL_ALREADY_USED" : "APPROVAL_INVALID" });
  }

  async close() {
    await this.pool.end();
  }
}
