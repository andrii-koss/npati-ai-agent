import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CryptoVault, defaultVault } from "@npati/workspace";
import type { Pool } from "pg";

export interface CompanyApiKey {
  id: string;
  companyId: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedApiKey extends CompanyApiKey {
  rawToken: string;
}

export interface ApiKeyAuthResult {
  authenticated: boolean;
  companyId?: string;
  tenantId?: string;
  scopes?: string[];
  keyId?: string;
  keyName?: string;
  userId?: string;
  error?: string;
}

export class ApiKeysRepository {
  private readonly inMemoryKeys = new Map<string, any>();
  private readonly vault: CryptoVault;

  constructor(private readonly pool?: Pool, vault?: CryptoVault) {
    this.vault = vault ?? defaultVault;
  }

  private hashToken(rawToken: string): string {
    return createHash("sha256").update(rawToken).digest("hex");
  }

  async createApiKey(params: {
    companyId: string;
    tenantId: string;
    ownerUserId?: string;
    name: string;
    scopes?: string[];
    expiresInDays?: number;
  }): Promise<CreatedApiKey> {
    const id = randomUUID();
    const entropy = randomBytes(24).toString("hex");
    const rawToken = `npati_live_${entropy}`;
    const keyPrefix = rawToken.slice(0, 16);
    const keyHash = this.hashToken(rawToken);
    const scopes = params.scopes && params.scopes.length > 0 ? params.scopes : ["*"];
    
    let expiresAt: Date | null = null;
    if (params.expiresInDays && params.expiresInDays > 0) {
      expiresAt = new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000);
    }

    const encryptedSecret = this.vault.encrypt(rawToken);
    const now = new Date();

    if (this.pool) {
      const res = await this.pool.query(
        `INSERT INTO company_api_keys (
          id, company_id, tenant_id, name, key_hash, key_prefix, scopes, encrypted_secret, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, company_id AS "companyId", tenant_id AS "tenantId", name, key_prefix AS "keyPrefix",
                  scopes, last_used_at AS "lastUsedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt",
                  created_at AS "createdAt", updated_at AS "updatedAt"`,
        [id, params.companyId, params.tenantId, params.name, keyHash, keyPrefix, scopes, encryptedSecret, expiresAt, now, now]
      );
      return { ...res.rows[0], rawToken };
    }

    const keyRecord = {
      id,
      companyId: params.companyId,
      tenantId: params.tenantId,
      ownerUserId: params.ownerUserId,
      name: params.name,
      keyHash,
      keyPrefix,
      scopes,
      encryptedSecret,
      lastUsedAt: null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      revokedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.inMemoryKeys.set(id, keyRecord);
    return {
      id: keyRecord.id,
      companyId: keyRecord.companyId,
      tenantId: keyRecord.tenantId,
      name: keyRecord.name,
      keyPrefix: keyRecord.keyPrefix,
      scopes: keyRecord.scopes,
      lastUsedAt: keyRecord.lastUsedAt,
      expiresAt: keyRecord.expiresAt,
      revokedAt: keyRecord.revokedAt,
      createdAt: keyRecord.createdAt,
      updatedAt: keyRecord.updatedAt,
      rawToken,
    };
  }

  async listApiKeys(companyId: string, tenantId: string): Promise<CompanyApiKey[]> {
    if (this.pool) {
      const res = await this.pool.query(
        `SELECT id, company_id AS "companyId", tenant_id AS "tenantId", name, key_prefix AS "keyPrefix",
                scopes, last_used_at AS "lastUsedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_api_keys
         WHERE company_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC`,
        [companyId, tenantId]
      );
      return res.rows;
    }

    return Array.from(this.inMemoryKeys.values())
      .filter((k) => k.companyId === companyId && k.tenantId === tenantId)
      .map(({ keyHash, encryptedSecret, ...rest }) => rest)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async revokeApiKey(keyId: string, companyId: string, tenantId: string): Promise<boolean> {
    const now = new Date();
    if (this.pool) {
      const res = await this.pool.query(
        `UPDATE company_api_keys
         SET revoked_at = $1, updated_at = $1
         WHERE id = $2 AND company_id = $3 AND tenant_id = $4 AND revoked_at IS NULL`,
        [now, keyId, companyId, tenantId]
      );
      return (res.rowCount ?? 0) > 0;
    }

    const key = this.inMemoryKeys.get(keyId);
    if (key && key.companyId === companyId && key.tenantId === tenantId && !key.revokedAt) {
      key.revokedAt = now.toISOString();
      key.updatedAt = now.toISOString();
      return true;
    }
    return false;
  }

  async authenticate(rawToken: string): Promise<ApiKeyAuthResult> {
    if (!rawToken || !rawToken.startsWith("npati_live_")) {
      return { authenticated: false, error: "INVALID_TOKEN_FORMAT" };
    }

    const keyHash = this.hashToken(rawToken);
    const now = new Date();

    if (this.pool) {
      const res = await this.pool.query(
        `SELECT k.id, k.company_id AS "companyId", k.tenant_id AS "tenantId", k.name, k.scopes,
                k.expires_at AS "expiresAt", k.revoked_at AS "revokedAt", c.user_id AS "userId"
         FROM company_api_keys k
         JOIN companies c ON c.id = k.company_id AND c.workspace_id = k.tenant_id
         WHERE k.key_hash = $1`,
        [keyHash]
      );

      if (res.rows.length === 0) {
        return { authenticated: false, error: "API_KEY_NOT_FOUND" };
      }

      const key = res.rows[0];
      if (key.revokedAt) {
        return { authenticated: false, error: "API_KEY_REVOKED" };
      }
      if (key.expiresAt && new Date(key.expiresAt) < now) {
        return { authenticated: false, error: "API_KEY_EXPIRED" };
      }

      // Update last_used_at asynchronously
      this.pool.query(`UPDATE company_api_keys SET last_used_at = $1 WHERE id = $2`, [now, key.id]).catch(() => {});

      return {
        authenticated: true,
        companyId: key.companyId,
        tenantId: key.tenantId,
        scopes: key.scopes,
        keyId: key.id,
        keyName: key.name,
        userId: key.userId,
      };
    }

    const match = Array.from(this.inMemoryKeys.values()).find((k) => k.keyHash === keyHash);
    if (!match) {
      return { authenticated: false, error: "API_KEY_NOT_FOUND" };
    }
    if (match.revokedAt) {
      return { authenticated: false, error: "API_KEY_REVOKED" };
    }
    if (match.expiresAt && new Date(match.expiresAt) < now) {
      return { authenticated: false, error: "API_KEY_EXPIRED" };
    }

    match.lastUsedAt = now.toISOString();
    return {
      authenticated: true,
      companyId: match.companyId,
      tenantId: match.tenantId,
      scopes: match.scopes,
      keyId: match.id,
      keyName: match.name,
      userId: match.ownerUserId,
    };
  }
}
