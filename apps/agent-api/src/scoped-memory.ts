import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type MemoryScopeType = "company" | "api_key" | "session";

export interface ScopedMemoryItem {
  id: string;
  companyId: string;
  tenantId: string;
  apiKeyId?: string | null;
  sessionId?: string | null;
  scopeType: MemoryScopeType;
  category: string;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export class ScopedMemoryEngine {
  private readonly inMemoryStore = new Map<string, ScopedMemoryItem>();

  constructor(private readonly pool?: Pool) {}

  /**
   * Store a memory with specific scope boundaries (company-wide, API key specific, or session specific)
   */
  async storeMemory(params: {
    companyId: string;
    tenantId: string;
    apiKeyId?: string;
    sessionId?: string;
    category?: string;
    title: string;
    content: string;
    tags?: string[];
    confidence?: number;
  }): Promise<ScopedMemoryItem> {
    const id = randomUUID();
    const now = new Date().toISOString();
    
    let scopeType: MemoryScopeType = "company";
    if (params.sessionId) {
      scopeType = "session";
    } else if (params.apiKeyId) {
      scopeType = "api_key";
    }

    const item: ScopedMemoryItem = {
      id,
      companyId: params.companyId,
      tenantId: params.tenantId,
      apiKeyId: params.apiKeyId || null,
      sessionId: params.sessionId || null,
      scopeType,
      category: params.category ?? "fact",
      title: params.title.trim(),
      content: params.content.trim(),
      tags: params.tags ?? [],
      confidence: params.confidence ?? 1.0,
      createdAt: now,
      updatedAt: now,
    };

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO company_scoped_memories (
          id, company_id, tenant_id, api_key_id, session_id, scope_type, category, title, content, tags, confidence, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          item.id,
          item.companyId,
          item.tenantId,
          item.apiKeyId,
          item.sessionId,
          item.scopeType,
          item.category,
          item.title,
          item.content,
          item.tags,
          item.confidence,
          item.createdAt,
          item.updatedAt,
        ]
      );
      return item;
    }

    this.inMemoryStore.set(id, item);
    return item;
  }

  /**
   * Retrieve memories strictly accessible by the caller's context:
   * 1. Company-wide memories are always accessible.
   * 2. If caller provides `apiKeyId`, apiKey-scoped memories for THAT apiKey are accessible.
   * 3. If caller provides `sessionId`, session-scoped memories for THAT session are accessible.
   * 4. Memories belonging to OTHER API keys or OTHER sessions are NEVER returned (Strict Scope Isolation).
   */
  async retrieveMemories(params: {
    companyId: string;
    tenantId: string;
    apiKeyId?: string;
    sessionId?: string;
    query?: string;
    limit?: number;
  }): Promise<ScopedMemoryItem[]> {
    const limit = Math.min(params.limit ?? 50, 200);
    const query = params.query?.trim().toLowerCase();

    if (this.pool) {
      const conditions: string[] = ["company_id = $1", "tenant_id = $2"];
      const values: unknown[] = [params.companyId, params.tenantId];
      let valIdx = 3;

      const scopeFilters: string[] = ["scope_type = 'company'"];

      if (params.apiKeyId) {
        scopeFilters.push(`(scope_type = 'api_key' AND api_key_id = $${valIdx})`);
        values.push(params.apiKeyId);
        valIdx++;
      }

      if (params.sessionId) {
        scopeFilters.push(`(scope_type = 'session' AND session_id = $${valIdx})`);
        values.push(params.sessionId);
        valIdx++;
      }

      conditions.push(`(${scopeFilters.join(" OR ")})`);

      if (query) {
        conditions.push(`(title ILIKE $${valIdx} OR content ILIKE $${valIdx})`);
        values.push(`%${query}%`);
        valIdx++;
      }

      values.push(limit);
      const querySql = `
        SELECT id, company_id AS "companyId", tenant_id AS "tenantId",
               api_key_id AS "apiKeyId", session_id AS "sessionId",
               scope_type AS "scopeType", category, title, content, tags,
               confidence, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM company_scoped_memories
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${valIdx}
      `;

      const res = await this.pool.query(querySql, values);
      return res.rows;
    }

    return Array.from(this.inMemoryStore.values())
      .filter((item) => {
        if (item.companyId !== params.companyId || item.tenantId !== params.tenantId) return false;

        // Check scope access
        let isScopeAllowed = false;
        if (item.scopeType === "company") {
          isScopeAllowed = true;
        } else if (item.scopeType === "api_key" && params.apiKeyId && item.apiKeyId === params.apiKeyId) {
          isScopeAllowed = true;
        } else if (item.scopeType === "session" && params.sessionId && item.sessionId === params.sessionId) {
          isScopeAllowed = true;
        }

        if (!isScopeAllowed) return false;

        if (query) {
          const matchTitle = item.title.toLowerCase().includes(query);
          const matchContent = item.content.toLowerCase().includes(query);
          if (!matchTitle && !matchContent) return false;
        }

        return true;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  /**
   * Delete a scoped memory item
   */
  async deleteMemory(id: string, companyId: string, tenantId: string): Promise<boolean> {
    if (this.pool) {
      const res = await this.pool.query(
        `DELETE FROM company_scoped_memories WHERE id = $1 AND company_id = $2 AND tenant_id = $3`,
        [id, companyId, tenantId]
      );
      return (res.rowCount ?? 0) > 0;
    }

    const item = this.inMemoryStore.get(id);
    if (item && item.companyId === companyId && item.tenantId === tenantId) {
      this.inMemoryStore.delete(id);
      return true;
    }
    return false;
  }
}
