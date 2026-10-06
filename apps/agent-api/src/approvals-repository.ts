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
  /**
   * C5a (additive). `self` (default) keeps today's behaviour exactly: the request is only visible to and
   * decidable by its requester. `role` makes it visible to another holder of `audienceRole`, which is what
   * step-up / two-person confirmation and reviewer flows need.
   */
  audience?: "self" | "role";
  /** Role required to see and decide a `role`-audience request. */
  audienceRole?: string;
}

/**
 * Reserved payload keys are approval metadata: they are stored with the payload but **excluded from the
 * payload hash**, so a payload that carries them still matches a requester that passes the same payload —
 * and payloads without them hash exactly as before (no regression for existing approvals).
 */
export const RESERVED_APPROVAL_PAYLOAD_KEYS = ["__approvalAudience"] as const;

/** Payload the hash is computed over: the caller's payload minus reserved approval metadata. */
export function approvalPayloadForHash(payload: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...payload };
  for (const key of RESERVED_APPROVAL_PAYLOAD_KEYS) delete clone[key];
  return clone;
}

export interface ApprovalAudienceMetadata {
  kind: "role";
  role: string;
  requestedBy: string;
}

/** The audience recorded with a request, or `null` for the default self-only audience. */
export function approvalAudienceOf(approval: Pick<CompanyApproval, "inputPayload">): ApprovalAudienceMetadata | null {
  const raw = (approval.inputPayload ?? {})["__approvalAudience"];
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<ApprovalAudienceMetadata>;
  if (candidate.kind !== "role" || typeof candidate.role !== "string" || typeof candidate.requestedBy !== "string") return null;
  return { kind: "role", role: candidate.role, requestedBy: candidate.requestedBy };
}

/**
 * Audit port for approval decisions (C5a debt from the C5 audit: decisions did not reach
 * `company_audit_logs`). Optional so existing constructions and suites are unaffected; `app.ts` injects it,
 * and when it is present a decision is journalled **before** it is applied (fail closed).
 */
export interface ApprovalDecisionAuditPort {
  record(input: {
    action: string;
    actor: string;
    companyId: string;
    resourceType: string;
    resourceId: string;
    decision: "allow" | "deny";
    payloadHash?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
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
  constructor(databaseUrl: string, private readonly audit?: ApprovalDecisionAuditPort) {
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
    const audienceRole = (input.audienceRole ?? "").trim();
    if (input.audience === "role" && !audienceRole) {
      throw Object.assign(new Error("audienceRole is required when audience is \"role\""), {
        status: 400,
        code: "APPROVAL_AUDIENCE_ROLE_REQUIRED",
      });
    }
    // The audience travels inside the payload as reserved metadata, and is excluded from the hash so the
    // payload a caller passes still matches (see `approvalPayloadForHash`).
    const storedPayload: Record<string, unknown> =
      input.audience === "role"
        ? { ...payload, __approvalAudience: { kind: "role", role: audienceRole, requestedBy: ctx.userId } satisfies ApprovalAudienceMetadata }
        : payload;
    const payloadHash = this.risk.computePayloadHash(approvalPayloadForHash(storedPayload));
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
        JSON.stringify(storedPayload),
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
    await this.journal(ctx, companyId, current, decision, notes, "self");

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
    const payloadHash = this.risk.computePayloadHash(approvalPayloadForHash(params.inputPayload));
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

  /**
   * C5a (additive): approvals whose audience is a role, visible to another holder of that role. Requests
   * with the default `self` audience never appear here, so the existing self-only paths are unchanged.
   */
  async listForAudience(
    ctx: AuthContext,
    companyId: string,
    params: { role: string; status?: ApprovalStatus; excludeRequester?: boolean }
  ): Promise<CompanyApproval[]> {
    const statusClause = params.status ? "AND status = $5" : "";
    const excludeClause = params.excludeRequester ? "AND user_id <> $6" : "";
    const values: unknown[] = [ctx.workspaceId, companyId, params.role, "role"];
    if (params.status) values.push(params.status);
    if (params.excludeRequester) values.push(ctx.userId);
    const result = await this.pool.query<CompanyApproval>(
      `SELECT ${appCols} FROM company_approvals
        WHERE workspace_id = $1 AND company_id = $2
          AND input_payload->'__approvalAudience'->>'role' = $3
          AND input_payload->'__approvalAudience'->>'kind' = $4
          ${statusClause} ${excludeClause}
        ORDER BY requested_at DESC LIMIT 50`,
      values
    );
    return result.rows;
  }

  /**
   * C5a (additive): decide a role-audience approval as **another** user holding that role. The requester can
   * never resolve their own request here (that is the point of a two-person confirmation), the role must
   * match the recorded audience, and the decision is journalled before it is applied.
   */
  async decideAsAudience(
    ctx: AuthContext,
    companyId: string,
    id: string,
    decision: "approved" | "rejected",
    params: { role: string; notes?: string }
  ): Promise<CompanyApproval> {
    const row = await this.pool.query<CompanyApproval>(
      `SELECT ${appCols} FROM company_approvals
        WHERE id = $1 AND workspace_id = $2 AND company_id = $3`,
      [id, ctx.workspaceId, companyId]
    );
    const current = row.rows[0];
    if (!current) throw Object.assign(new Error("Approval request not found"), { status: 404 });
    const audience = approvalAudienceOf(current);
    if (!audience || audience.role !== params.role) {
      throw Object.assign(new Error("This approval is not addressed to your role"), {
        status: 403,
        code: "APPROVAL_AUDIENCE_ROLE_MISMATCH",
      });
    }
    if (audience.requestedBy === ctx.userId || current.userId === ctx.userId) {
      throw Object.assign(new Error("The requester cannot resolve their own role-audience approval"), {
        status: 403,
        code: "TWO_PERSON_SAME_USER_DENIED",
      });
    }
    if (current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) {
      await this.pool.query("UPDATE company_approvals SET status='expired' WHERE id=$1 AND status='pending'", [id]);
      throw Object.assign(new Error("Approval request has expired"), { status: 409, code: "APPROVAL_EXPIRED" });
    }
    if (current.status !== "pending") {
      throw Object.assign(new Error(`Approval is already resolved with status "${current.status}"`), {
        status: 409,
        code: "APPROVAL_ALREADY_RESOLVED",
      });
    }
    await this.journal(ctx, companyId, current, decision, params.notes, "role", params.role);
    const result = await this.pool.query<CompanyApproval>(
      `UPDATE company_approvals SET
         status = $3, decision_notes = $4, responded_at = now(), responded_by = $5
       WHERE id = $1 AND company_id = $2 AND status = 'pending'
       RETURNING ${appCols}`,
      [id, companyId, decision, params.notes?.trim() || null, ctx.userId]
    );
    if (!result.rows[0]) {
      throw Object.assign(new Error("Approval was resolved by another request"), { status: 409, code: "APPROVAL_ALREADY_RESOLVED" });
    }
    return result.rows[0];
  }

  /**
   * Journal an approval decision. When the audit port is present this runs **before** the decision is
   * applied, so an unavailable journal refuses the decision instead of leaving it unrecorded (rule 23).
   * Without the port the behaviour is exactly as before this step (the port is injected in `app.ts`).
   */
  private async journal(
    ctx: AuthContext,
    companyId: string,
    approval: CompanyApproval,
    decision: "approved" | "rejected",
    notes: string | undefined,
    audience: "self" | "role",
    audienceRole?: string
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.record({
        action: "company.approval.decided",
        actor: String(ctx.userId),
        companyId,
        resourceType: "company_approval",
        resourceId: approval.id,
        decision: decision === "approved" ? "allow" : "deny",
        ...(approval.payloadHash ? { payloadHash: approval.payloadHash } : {}),
        metadata: {
          toolName: approval.toolName,
          riskLevel: approval.riskLevel,
          requestedBy: approval.userId,
          audience,
          audienceRole: audienceRole ?? null,
          hasNotes: Boolean(notes?.trim()),
        },
      });
    } catch (error) {
      throw Object.assign(new Error("Approval decisions require the audit journal"), {
        status: 503,
        code: "AUDIT_UNAVAILABLE",
        cause: error,
      });
    }
  }

  async close() {
    await this.pool.end();
  }
}
