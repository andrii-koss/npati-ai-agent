import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";

export interface CompanyWebhook {
  id: string;
  workspaceId: string;
  companyId: string;
  userId: string;
  name: string;
  secret: string;
  agentId?: string | null;
  promptTemplate: string;
  isActive: boolean;
  lastTriggeredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyMcpServer {
  id: string;
  workspaceId: string;
  companyId: string;
  userId: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  endpoint: string;
  authToken?: string | null;
  scopes: string[];
  isActive: boolean;
  status: "connected" | "unreachable" | "error";
  createdAt: string;
  updatedAt: string;
}

const webhookCols = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  user_id AS "userId", name, secret, agent_id AS "agentId",
  prompt_template AS "promptTemplate", is_active AS "isActive",
  last_triggered_at AS "lastTriggeredAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

const mcpCols = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  user_id AS "userId", name, transport, endpoint, auth_token AS "authToken",
  scopes, is_active AS "isActive", status, created_at AS "createdAt", updated_at AS "updatedAt"`;

export class IntegrationsRepository {
  private pool: Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  // Webhooks
  async listWebhooks(ctx: AuthContext, companyId: string): Promise<CompanyWebhook[]> {
    const result = await this.pool.query<CompanyWebhook>(
      `SELECT ${webhookCols} FROM company_webhooks
       WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3
       ORDER BY created_at DESC LIMIT 50`,
      [ctx.workspaceId, companyId, ctx.userId]
    );
    return result.rows;
  }

  async createWebhook(
    ctx: AuthContext,
    companyId: string,
    input: { name: string; promptTemplate: string; agentId?: string }
  ): Promise<CompanyWebhook> {
    const id = randomUUID();
    const secret = "whsec_" + randomBytes(24).toString("hex");
    const result = await this.pool.query<CompanyWebhook>(
      `INSERT INTO company_webhooks (
         id, workspace_id, company_id, user_id, name, secret, agent_id, prompt_template
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${webhookCols}`,
      [id, ctx.workspaceId, companyId, ctx.userId, input.name.trim(), secret, input.agentId || null, input.promptTemplate.trim()]
    );
    return result.rows[0]!;
  }

  async getWebhookBySecret(secret: string): Promise<CompanyWebhook | null> {
    const result = await this.pool.query<CompanyWebhook>(
      `SELECT ${webhookCols} FROM company_webhooks WHERE secret = $1 AND is_active = true`,
      [secret]
    );
    return result.rows[0] || null;
  }

  async recordWebhookTrigger(webhookId: string): Promise<void> {
    await this.pool.query(
      `UPDATE company_webhooks SET last_triggered_at = now(), updated_at = now() WHERE id = $1`,
      [webhookId]
    );
  }

  async deleteWebhook(ctx: AuthContext, companyId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM company_webhooks WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4`,
      [id, ctx.workspaceId, companyId, ctx.userId]
    );
    return Boolean(result.rowCount);
  }

  // MCP Servers
  async listMcpServers(ctx: AuthContext, companyId: string): Promise<CompanyMcpServer[]> {
    const result = await this.pool.query<CompanyMcpServer>(
      `SELECT ${mcpCols} FROM company_mcp_servers
       WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3
       ORDER BY created_at DESC LIMIT 50`,
      [ctx.workspaceId, companyId, ctx.userId]
    );
    return result.rows;
  }

  async createMcpServer(
    ctx: AuthContext,
    companyId: string,
    input: { name: string; transport: "http" | "sse" | "stdio"; endpoint: string; authToken?: string; scopes?: string[] }
  ): Promise<CompanyMcpServer> {
    const id = randomUUID();
    const result = await this.pool.query<CompanyMcpServer>(
      `INSERT INTO company_mcp_servers (
         id, workspace_id, company_id, user_id, name, transport, endpoint, auth_token, scopes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${mcpCols}`,
      [id, ctx.workspaceId, companyId, ctx.userId, input.name.trim(), input.transport, input.endpoint.trim(), input.authToken || null, input.scopes || []]
    );
    return result.rows[0]!;
  }

  async deleteMcpServer(ctx: AuthContext, companyId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM company_mcp_servers WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4`,
      [id, ctx.workspaceId, companyId, ctx.userId]
    );
    return Boolean(result.rowCount);
  }

  async close() {
    await this.pool.end();
  }
}
