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

type MemoryAccess = {
  companyId: string;
  tenantId: string;
  apiKeyId?: string;
  sessionId?: string;
};

const columns = `id, company_id AS "companyId", tenant_id AS "tenantId",
  api_key_id AS "apiKeyId", session_id AS "sessionId", scope_type AS "scopeType",
  category, title, content, tags, confidence, created_at AS "createdAt", updated_at AS "updatedAt"`;

function required(value: string, name: string, max: number) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(name + " is required");
  if (normalized.length > max) throw new Error(name + " exceeds " + max + " characters");
  return normalized;
}

export class ScopedMemoryEngine {
  private readonly inMemoryStore = new Map<string, ScopedMemoryItem & { idempotencyKey?: string }>();

  constructor(private readonly pool?: Pool) {}

  async storeMemory(params: MemoryAccess & {
    category?: string;
    title: string;
    content: string;
    tags?: string[];
    confidence?: number;
    idempotencyKey?: string;
  }): Promise<ScopedMemoryItem> {
    const companyId = required(params.companyId, "Company id", 100);
    const tenantId = required(params.tenantId, "Tenant id", 100);
    const apiKeyId = params.apiKeyId ? required(params.apiKeyId, "API key id", 100) : undefined;
    const sessionId = params.sessionId ? required(params.sessionId, "Session id", 100) : undefined;
    const scopeType: MemoryScopeType = sessionId ? "session" : apiKeyId ? "api_key" : "company";
    const idempotencyKey = params.idempotencyKey ? required(params.idempotencyKey, "Idempotency key", 160) : undefined;
    const confidence = Math.max(0, Math.min(1, Number.isFinite(params.confidence) ? Number(params.confidence) : 1));
    const now = new Date().toISOString();
    const item: ScopedMemoryItem = {
      id: randomUUID(),
      companyId,
      tenantId,
      apiKeyId: apiKeyId ?? null,
      sessionId: sessionId ?? null,
      scopeType,
      category: required(params.category ?? "fact", "Category", 80),
      title: required(params.title, "Title", 240),
      content: required(params.content, "Content", 8_000),
      tags: [...new Set((params.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 32),
      confidence,
      createdAt: now,
      updatedAt: now,
    };

    if (this.pool) {
      if (idempotencyKey) {
        const existing = await this.pool.query<ScopedMemoryItem>(
          `SELECT ${columns} FROM company_scoped_memories
           WHERE tenant_id=$1 AND company_id=$2 AND scope_type=$3
             AND api_key_id IS NOT DISTINCT FROM $4 AND session_id IS NOT DISTINCT FROM $5
             AND idempotency_key=$6 AND deleted_at IS NULL`,
          [tenantId, companyId, scopeType, apiKeyId ?? null, sessionId ?? null, idempotencyKey],
        );
        if (existing.rows[0]) return existing.rows[0];
      }
      try {
        const stored = await this.pool.query<ScopedMemoryItem>(
          `INSERT INTO company_scoped_memories
            (id,company_id,tenant_id,api_key_id,session_id,scope_type,category,title,content,tags,confidence,idempotency_key,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING ${columns}`,
          [item.id, companyId, tenantId, apiKeyId ?? null, sessionId ?? null, scopeType, item.category,
            item.title, item.content, item.tags, confidence, idempotencyKey ?? null, now, now],
        );
        return stored.rows[0]!;
      } catch (error) {
        if (!idempotencyKey || (error as { code?: string }).code !== "23505") throw error;
        const existing = await this.pool.query<ScopedMemoryItem>(
          `SELECT ${columns} FROM company_scoped_memories
           WHERE tenant_id=$1 AND company_id=$2 AND scope_type=$3
             AND api_key_id IS NOT DISTINCT FROM $4 AND session_id IS NOT DISTINCT FROM $5
             AND idempotency_key=$6 AND deleted_at IS NULL`,
          [tenantId, companyId, scopeType, apiKeyId ?? null, sessionId ?? null, idempotencyKey],
        );
        if (!existing.rows[0]) throw error;
        return existing.rows[0];
      }
    }

    if (idempotencyKey) {
      const existing = [...this.inMemoryStore.values()].find((candidate) =>
        candidate.tenantId === tenantId && candidate.companyId === companyId &&
        candidate.scopeType === scopeType && candidate.apiKeyId === (apiKeyId ?? null) &&
        candidate.sessionId === (sessionId ?? null) && candidate.idempotencyKey === idempotencyKey);
      if (existing) return existing;
    }
    this.inMemoryStore.set(item.id, { ...item, idempotencyKey });
    return item;
  }

  async retrieveMemories(params: MemoryAccess & { query?: string; limit?: number }): Promise<ScopedMemoryItem[]> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const query = params.query?.trim();
    const searchTerms = query
      ? [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])
          .map((term) => term.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean))].slice(0,24)
      : [];
    const ftsQuery = searchTerms.join(" | ");
    const keyId = params.apiKeyId?.trim() || undefined;
    const sessionId = params.sessionId?.trim() || undefined;
    if (this.pool) {
      const values: unknown[] = [required(params.companyId, "Company id", 100), required(params.tenantId, "Tenant id", 100)];
      const scopes = ["scope_type='company'"];
      if (keyId) {
        values.push(keyId);
        scopes.push(`(scope_type='api_key' AND api_key_id=$${values.length})`);
      }
      if (sessionId) {
        values.push(sessionId);
        const sessionParam = values.length;
        values.push(keyId ?? null);
        const keyParam = values.length;
        scopes.push(`(scope_type='session' AND session_id=$${sessionParam} AND api_key_id IS NOT DISTINCT FROM $${keyParam})`);
      }
      const filters = ["company_id=$1", "tenant_id=$2", "deleted_at IS NULL", `(${scopes.join(" OR ")})`];
      if (query && ftsQuery) {
        values.push(ftsQuery);
        const queryParam = values.length;
        values.push(query);
        const exactParam = values.length;
        filters.push(`(to_tsquery('simple',$${queryParam}) @@ to_tsvector('simple',title||' '||content)
          OR title ILIKE '%'||$${exactParam}||'%' OR content ILIKE '%'||$${exactParam}||'%')`);
      }
      values.push(limit);
      const result = await this.pool.query<ScopedMemoryItem>(
        `SELECT ${columns} FROM company_scoped_memories
         WHERE ${filters.join(" AND ")}
         ORDER BY updated_at DESC,id DESC LIMIT $${values.length}`,
        values,
      );
      return result.rows;
    }

    return [...this.inMemoryStore.values()].filter((item) => {
      if (item.companyId !== params.companyId || item.tenantId !== params.tenantId) return false;
      const allowed = item.scopeType === "company" ||
        (item.scopeType === "api_key" && Boolean(keyId) && item.apiKeyId === keyId) ||
        (item.scopeType === "session" && Boolean(sessionId) && item.sessionId === sessionId &&
          item.apiKeyId === (keyId ?? null));
      if (!allowed) return false;
      const searchable=(item.title+" "+item.content).toLowerCase();
      return !searchTerms.length || searchTerms.some((term)=>searchable.includes(term));
    }).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,limit);
  }

  async deleteMemory(params: MemoryAccess & { id: string; owner?: boolean }): Promise<boolean> {
    const filters = ["id=$1", "company_id=$2", "tenant_id=$3", "deleted_at IS NULL"];
    const values: unknown[] = [params.id, params.companyId, params.tenantId];
    if (!params.owner) {
      values.push(params.apiKeyId ?? null);
      filters.push(`api_key_id IS NOT DISTINCT FROM $${values.length}`);
      if (params.sessionId) {
        values.push(params.sessionId);
        filters.push(`session_id=$${values.length}`);
      } else {
        filters.push("scope_type='api_key' AND session_id IS NULL");
      }
    }
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE company_scoped_memories SET deleted_at=now(),updated_at=now() WHERE ${filters.join(" AND ")}`,
        values,
      );
      return Boolean(result.rowCount);
    }
    const item = this.inMemoryStore.get(params.id);
    if (!item || item.companyId !== params.companyId || item.tenantId !== params.tenantId) return false;
    if (!params.owner) {
      if (item.apiKeyId !== (params.apiKeyId ?? null)) return false;
      if (params.sessionId ? item.sessionId !== params.sessionId : item.scopeType !== "api_key" || item.sessionId !== null) return false;
    }
    this.inMemoryStore.delete(params.id);
    return true;
  }

  async purgeCompany(companyId: string, tenantId: string) {
    if (this.pool) {
      await this.pool.query("DELETE FROM company_scoped_memories WHERE company_id=$1 AND tenant_id=$2", [companyId, tenantId]);
      return;
    }
    for (const [id,item] of this.inMemoryStore) if (item.companyId===companyId && item.tenantId===tenantId) this.inMemoryStore.delete(id);
  }
}
