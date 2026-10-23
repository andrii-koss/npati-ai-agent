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
  private pool?: Pool;
  private memoryWebhooks = new Map<string, CompanyWebhook>();
  private memoryMcpServers = new Map<string, CompanyMcpServer>();

  constructor(databaseUrl?: string, pool?: Pool) {
    if (pool) {
      this.pool = pool;
    } else if (databaseUrl && databaseUrl.trim().length > 0) {
      this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
    }
  }

  // Webhooks
  async listWebhooks(ctx: AuthContext, companyId: string): Promise<CompanyWebhook[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyWebhook>(
        `SELECT ${webhookCols} FROM company_webhooks
         WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3
         ORDER BY created_at DESC LIMIT 50`,
        [ctx.workspaceId, companyId, ctx.userId]
      );
      return result.rows;
    }

    return Array.from(this.memoryWebhooks.values())
      .filter((w) => w.workspaceId === ctx.workspaceId && w.companyId === companyId && w.userId === ctx.userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);
  }

  async createWebhook(
    ctx: AuthContext,
    companyId: string,
    input: { name: string; promptTemplate: string; agentId?: string; isActive?: boolean }
  ): Promise<CompanyWebhook> {
    const id = randomUUID();
    const secret = "whsec_" + randomBytes(24).toString("hex");
    const now = new Date().toISOString();

    if (this.pool) {
      const result = await this.pool.query<CompanyWebhook>(
        `INSERT INTO company_webhooks (
           id, workspace_id, company_id, user_id, name, secret, agent_id, prompt_template, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${webhookCols}`,
        [id, ctx.workspaceId, companyId, ctx.userId, input.name.trim(), secret, input.agentId || null, input.promptTemplate.trim(), input.isActive !== false]
      );
      return result.rows[0]!;
    }

    const item: CompanyWebhook = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      userId: ctx.userId,
      name: input.name.trim(),
      secret,
      agentId: input.agentId || null,
      promptTemplate: input.promptTemplate.trim(),
      isActive: input.isActive !== false,
      lastTriggeredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.memoryWebhooks.set(id, item);
    return item;
  }

  async getWebhookBySecret(secret: string): Promise<CompanyWebhook | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyWebhook>(
        `SELECT ${webhookCols} FROM company_webhooks WHERE secret = $1 AND is_active = true`,
        [secret]
      );
      return result.rows[0] || null;
    }

    for (const item of this.memoryWebhooks.values()) {
      if (item.secret === secret && item.isActive) {
        return item;
      }
    }
    return null;
  }

  async recordWebhookTrigger(webhookId: string): Promise<void> {
    const now = new Date().toISOString();
    if (this.pool) {
      await this.pool.query(
        `UPDATE company_webhooks SET last_triggered_at = now(), updated_at = now() WHERE id = $1`,
        [webhookId]
      );
      return;
    }

    const item = this.memoryWebhooks.get(webhookId);
    if (item) {
      item.lastTriggeredAt = now;
      item.updatedAt = now;
    }
  }

  async deleteWebhook(ctx: AuthContext, companyId: string, id: string): Promise<boolean> {
    if (this.pool) {
      const result = await this.pool.query(
        `DELETE FROM company_webhooks WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4`,
        [id, ctx.workspaceId, companyId, ctx.userId]
      );
      return Boolean(result.rowCount);
    }

    const item = this.memoryWebhooks.get(id);
    if (!item || item.workspaceId !== ctx.workspaceId || item.companyId !== companyId || item.userId !== ctx.userId) {
      return false;
    }
    return this.memoryWebhooks.delete(id);
  }

  async setWebhookActive(ctx: AuthContext, companyId: string, id: string, isActive: boolean): Promise<CompanyWebhook | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyWebhook>(
        `UPDATE company_webhooks SET is_active = $5, updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4
         RETURNING ${webhookCols}`,
        [id, ctx.workspaceId, companyId, ctx.userId, isActive]
      );
      return result.rows[0] || null;
    }

    const item = this.memoryWebhooks.get(id);
    if (!item || item.workspaceId !== ctx.workspaceId || item.companyId !== companyId || item.userId !== ctx.userId) {
      return null;
    }
    item.isActive = isActive;
    item.updatedAt = new Date().toISOString();
    return item;
  }

  async getWebhook(ctx: AuthContext, companyId: string, id: string): Promise<CompanyWebhook | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyWebhook>(
        `SELECT ${webhookCols} FROM company_webhooks WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4`,
        [id, ctx.workspaceId, companyId, ctx.userId]
      );
      return result.rows[0] || null;
    }

    const item = this.memoryWebhooks.get(id);
    if (!item || item.workspaceId !== ctx.workspaceId || item.companyId !== companyId || item.userId !== ctx.userId) {
      return null;
    }
    return item;
  }

  clearWebhooks(): void {
    this.memoryWebhooks.clear();
  }

  // MCP Servers
  async listMcpServers(ctx: AuthContext, companyId: string): Promise<CompanyMcpServer[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyMcpServer>(
        `SELECT ${mcpCols} FROM company_mcp_servers
         WHERE workspace_id = $1 AND company_id = $2 AND user_id = $3
         ORDER BY created_at DESC LIMIT 50`,
        [ctx.workspaceId, companyId, ctx.userId]
      );
      return result.rows;
    }

    return Array.from(this.memoryMcpServers.values())
      .filter((s) => s.workspaceId === ctx.workspaceId && s.companyId === companyId && s.userId === ctx.userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);
  }

  async createMcpServer(
    ctx: AuthContext,
    companyId: string,
    input: { name: string; transport: "http" | "sse" | "stdio"; endpoint: string; authToken?: string; scopes?: string[] }
  ): Promise<CompanyMcpServer> {
    const id = randomUUID();
    const now = new Date().toISOString();

    if (this.pool) {
      const result = await this.pool.query<CompanyMcpServer>(
        `INSERT INTO company_mcp_servers (
           id, workspace_id, company_id, user_id, name, transport, endpoint, auth_token, scopes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${mcpCols}`,
        [id, ctx.workspaceId, companyId, ctx.userId, input.name.trim(), input.transport, input.endpoint.trim(), input.authToken || null, input.scopes || []]
      );
      return result.rows[0]!;
    }

    const item: CompanyMcpServer = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      userId: ctx.userId,
      name: input.name.trim(),
      transport: input.transport,
      endpoint: input.endpoint.trim(),
      authToken: input.authToken || null,
      scopes: input.scopes || [],
      isActive: true,
      status: "connected",
      createdAt: now,
      updatedAt: now,
    };
    this.memoryMcpServers.set(id, item);
    return item;
  }

  async deleteMcpServer(ctx: AuthContext, companyId: string, id: string): Promise<boolean> {
    if (this.pool) {
      const result = await this.pool.query(
        `DELETE FROM company_mcp_servers WHERE id = $1 AND workspace_id = $2 AND company_id = $3 AND user_id = $4`,
        [id, ctx.workspaceId, companyId, ctx.userId]
      );
      return Boolean(result.rowCount);
    }

    const item = this.memoryMcpServers.get(id);
    if (!item || item.workspaceId !== ctx.workspaceId || item.companyId !== companyId || item.userId !== ctx.userId) {
      return false;
    }
    return this.memoryMcpServers.delete(id);
  }

  async close() {
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
    }
  }
}
