import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import type { CapabilityRisk } from "@npati/shared";

/**
 * C13 (owner decision 5): the **durable** record of an owner/admin risk decision for one runtime MCP tool.
 *
 * Why a store at all, and why its own table (migration 085): the default for a new or unknown MCP tool is
 * `high` + approval required, and that default lives in code. A *lowering* is a privileged policy decision
 * with an owner, a time and an audit entry — it has to survive a restart, or the deployment would silently
 * re-raise (or, worse, silently re-lower after a re-discovery) with nothing to compare against. The table is
 * additive and tenant-scoped, and the row is keyed by the connection's own id plus the tool name, so a
 * re-discovery of the same connection re-applies the same decision instead of inventing a new one.
 *
 * Nothing in this module decides anything: `mcp-risk-override.ts` owns the authorization and the
 * audit-before-apply order, and the store is a plain appender/reader.
 */

/** The risk vocabulary a policy row may hold. `unknown` is deliberately absent: `high` is the fail-closed word. */
export const MCP_POLICY_RISKS: readonly CapabilityRisk[] = ["low", "medium", "high", "critical"] as const;

export interface McpToolPolicyRecord {
  connectionId: string;
  toolName: string;
  risk: CapabilityRisk;
  approvalRequired: boolean;
  /** Only `owner_policy` rows change the published risk; anything else is ignored at hydrate time. */
  riskSource: "owner_policy";
  actor: string;
  updatedAt: string;
}

export interface McpToolPolicyRepositoryPort {
  listPolicies(ctx: AuthContext, companyId: string): Promise<McpToolPolicyRecord[]>;
  upsertPolicy(ctx: AuthContext, companyId: string, record: McpToolPolicyRecord): Promise<McpToolPolicyRecord>;
  deletePolicy(ctx: AuthContext, companyId: string, connectionId: string, toolName: string): Promise<boolean>;
}

export type McpToolPolicyRepository = McpToolPolicyRepositoryPort;

const policyCols = `id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
  connection_id AS "connectionId", tool_name AS "toolName", risk, approval_required AS "approvalRequired",
  risk_source AS "riskSource", actor, updated_at AS "updatedAt"`;

interface PolicyRow {
  connectionId: string;
  toolName: string;
  risk: string;
  approvalRequired: boolean;
  riskSource: string;
  actor: string;
  updatedAt: string | Date;
}

function toRecord(row: PolicyRow): McpToolPolicyRecord | null {
  if (row.riskSource !== "owner_policy") return null;
  if (!MCP_POLICY_RISKS.includes(row.risk as CapabilityRisk)) return null;
  return {
    connectionId: String(row.connectionId),
    toolName: String(row.toolName),
    risk: row.risk as CapabilityRisk,
    approvalRequired: row.approvalRequired === true,
    riskSource: "owner_policy",
    actor: String(row.actor),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

/**
 * Postgres-backed when a pool is available, in-memory otherwise (the same shape as
 * `IntegrationsRepository`), so an unconfigured deployment degrades to "no durable override" — which is the
 * fail-closed direction: without a row the tool keeps the `high` + approval default.
 */
export class McpToolPolicyStore implements McpToolPolicyRepositoryPort {
  private pool?: Pool;
  private readonly ownsPool: boolean;
  private readonly memory = new Map<string, McpToolPolicyRecord>();

  constructor(databaseUrl?: string, pool?: Pool) {
    this.ownsPool = !pool && !!databaseUrl?.trim();
    if (pool) this.pool = pool;
    else if (databaseUrl && databaseUrl.trim().length > 0) this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool?.end();
  }

  private memoryKey(ctx: AuthContext, companyId: string, connectionId: string, toolName: string): string {
    return `${ctx.workspaceId}\u0000${companyId}\u0000${connectionId}\u0000${toolName}`;
  }

  async listPolicies(ctx: AuthContext, companyId: string): Promise<McpToolPolicyRecord[]> {
    if (this.pool) {
      const result = await this.pool.query<PolicyRow>(
        `SELECT ${policyCols} FROM company_mcp_tool_policies
         WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3
         ORDER BY updated_at DESC LIMIT 500`,
        [ctx.workspaceId, companyId, ctx.userId],
      );
      return result.rows.map(toRecord).filter((record): record is McpToolPolicyRecord => record !== null);
    }
    return [...this.memory.entries()]
      .filter(([key]) => key.startsWith(`${ctx.workspaceId}\u0000${companyId}\u0000`))
      .map(([, record]) => ({ ...record }));
  }

  async upsertPolicy(ctx: AuthContext, companyId: string, record: McpToolPolicyRecord): Promise<McpToolPolicyRecord> {
    const now = new Date();
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO company_mcp_tool_policies (
           id, workspace_id, company_id, user_id, connection_id, tool_name, risk, approval_required, risk_source, actor, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         ON CONFLICT (workspace_id, company_id, connection_id, tool_name)
         DO UPDATE SET risk = EXCLUDED.risk, approval_required = EXCLUDED.approval_required,
                       risk_source = EXCLUDED.risk_source, actor = EXCLUDED.actor, updated_at = EXCLUDED.updated_at`,
        [
          randomUUID(), ctx.workspaceId, companyId, ctx.userId, record.connectionId, record.toolName,
          record.risk, record.approvalRequired, record.riskSource, record.actor, now,
        ],
      );
      return { ...record, updatedAt: now.toISOString() };
    }
    const key = this.memoryKey(ctx, companyId, record.connectionId, record.toolName);
    const stored: McpToolPolicyRecord = { ...record, updatedAt: now.toISOString() };
    this.memory.set(key, stored);
    return { ...stored };
  }

  async deletePolicy(ctx: AuthContext, companyId: string, connectionId: string, toolName: string): Promise<boolean> {
    if (this.pool) {
      const result = await this.pool.query(
        `DELETE FROM company_mcp_tool_policies
         WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3 AND connection_id = $4 AND tool_name = $5`,
        [ctx.workspaceId, companyId, ctx.userId, connectionId, toolName],
      );
      return Boolean(result.rowCount);
    }
    return this.memory.delete(this.memoryKey(ctx, companyId, connectionId, toolName));
  }

  /** Test/ops helper: forget every in-memory row (the pool path is untouched). */
  clearMemory(): void {
    this.memory.clear();
  }
}
