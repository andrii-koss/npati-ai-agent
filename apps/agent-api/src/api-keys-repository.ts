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

export interface ApiKeyDeviceRecord {
  id: string;
  keyId: string;
  deviceId: string;
  ip: string;
  userAgent: string;
  platform: string;
  requestsCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DeviceAccessInput {
  ip?: string;
  userAgent?: string;
  platform?: string;
  deviceId?: string;
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
  device?: {
    deviceId: string;
    totalDevicesForKey: number;
    isAnomalous: boolean;
  };
}

export const API_KEY_SCOPES = [
  "workspace:read", "workspace:write", "business:manage", "chat:use",
  "chat:write", "memory:read", "memory:write",
    "mcp:read", "mcp:execute", "agent:exec", "*",
] as const;

export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export function normalizeApiKeyScopes(scopes?: string[]): ApiKeyScope[] {
  const requested = scopes?.length ? [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))] : ["workspace:read"];
  const invalid = requested.filter((scope) => !(API_KEY_SCOPES as readonly string[]).includes(scope));
  if (invalid.length) throw Object.assign(new Error(`Unsupported API key scope: ${invalid.join(", ")}`), { status: 400, code: "INVALID_API_KEY_SCOPE" });
  return requested as ApiKeyScope[];
}

export class ApiKeysRepository {
  private readonly inMemoryKeys = new Map<string, any>();
  private readonly inMemoryDevices = new Map<string, Map<string, ApiKeyDeviceRecord>>();
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
    const scopes = normalizeApiKeyScopes(params.scopes);
    
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

  async authenticate(rawToken: string, deviceInput?: DeviceAccessInput): Promise<ApiKeyAuthResult> {
    if (!rawToken || !rawToken.startsWith("npati_live_")) {
      return { authenticated: false, error: "INVALID_TOKEN_FORMAT" };
    }

    const keyHash = this.hashToken(rawToken);
    const now = new Date();
    const bounded = (value: string | undefined, fallback: string, max: number) => (value?.trim() || fallback).slice(0, max);
    const ip = bounded(deviceInput?.ip, "127.0.0.1", 128);
    const userAgent = bounded(deviceInput?.userAgent, "unknown-agent", 512);
    const platform = bounded(deviceInput?.platform, "unknown", 128);
    const suppliedDeviceId = bounded(deviceInput?.deviceId, "", 160);
    const deviceId = suppliedDeviceId || `auto_${createHash("sha256").update(`${ip}\0${userAgent}\0${platform}`).digest("hex").slice(0, 32)}`;

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
      if (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime()) {
        return { authenticated: false, error: "API_KEY_EXPIRED" };
      }

      // Device telemetry is security-critical: update usage and device state atomically.
      const client = await this.pool.connect();
      let totalDevices: number;
      try {
        await client.query("BEGIN");
        await client.query(`UPDATE company_api_keys SET last_used_at = $1 WHERE id = $2`, [now, key.id]);
        await client.query(
          `INSERT INTO company_api_key_devices (id, key_id, device_id, ip, user_agent, platform, requests_count, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7)
           ON CONFLICT (key_id, device_id)
           DO UPDATE SET requests_count = company_api_key_devices.requests_count + 1,
                         last_seen_at = $7, ip = $4, user_agent = $5, platform = $6`,
          [randomUUID(), key.id, deviceId, ip, userAgent, platform, now]
        );
        const countRes = await client.query(
          `SELECT count(DISTINCT device_id)::int AS count FROM company_api_key_devices WHERE key_id = $1`,
          [key.id]
        );
        totalDevices = Number(countRes.rows[0]?.count ?? 0);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw Object.assign(new Error("API key device tracking failed"), {
          code: "API_KEY_DEVICE_TRACKING_FAILED",
          cause: error,
        });
      } finally {
        client.release();
      }

      const isAnomalous = totalDevices > 5;

      return {
        authenticated: true,
        companyId: key.companyId,
        tenantId: key.tenantId,
        scopes: key.scopes,
        keyId: key.id,
        keyName: key.name,
        userId: key.userId,
        device: {
          deviceId,
          totalDevicesForKey: totalDevices,
          isAnomalous,
        },
      };
    }

    const match = Array.from(this.inMemoryKeys.values()).find((k) => k.keyHash === keyHash);
    if (!match) {
      return { authenticated: false, error: "API_KEY_NOT_FOUND" };
    }
    if (match.revokedAt) {
      return { authenticated: false, error: "API_KEY_REVOKED" };
    }
    if (match.expiresAt && new Date(match.expiresAt).getTime() <= now.getTime()) {
      return { authenticated: false, error: "API_KEY_EXPIRED" };
    }

    match.lastUsedAt = now.toISOString();

    // In-memory device tracking
    let devMap = this.inMemoryDevices.get(match.id);
    if (!devMap) {
      devMap = new Map();
      this.inMemoryDevices.set(match.id, devMap);
    }
    const existingDev = devMap.get(deviceId);
    if (existingDev) {
      existingDev.requestsCount++;
      existingDev.lastSeenAt = now.toISOString();
      existingDev.ip = ip;
    } else {
      devMap.set(deviceId, {
        id: randomUUID(),
        keyId: match.id,
        deviceId,
        ip,
        userAgent,
        platform,
        requestsCount: 1,
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
      });
    }
    const totalDevices = devMap.size;
    const isAnomalous = totalDevices > 5;

    return {
      authenticated: true,
      companyId: match.companyId,
      tenantId: match.tenantId,
      scopes: match.scopes,
      keyId: match.id,
      keyName: match.name,
      userId: match.ownerUserId,
      device: {
        deviceId,
        totalDevicesForKey: totalDevices,
        isAnomalous,
      },
    };
  }

  async listDevices(
    keyId: string,
    companyId: string,
    tenantId: string
  ): Promise<{ devices: ApiKeyDeviceRecord[]; totalDevices: number; isAnomalous: boolean }> {
    if (this.pool) {
      const verifyKey = await this.pool.query(
        `SELECT id FROM company_api_keys WHERE id = $1 AND company_id = $2 AND tenant_id = $3`,
        [keyId, companyId, tenantId]
      );
      if (verifyKey.rows.length === 0) {
        throw new Error("KEY_NOT_FOUND");
      }

      const res = await this.pool.query(
        `SELECT id, key_id AS "keyId", device_id AS "deviceId", ip, user_agent AS "userAgent",
                platform, requests_count AS "requestsCount", first_seen_at AS "firstSeenAt",
                last_seen_at AS "lastSeenAt"
         FROM company_api_key_devices
         WHERE key_id = $1
         ORDER BY last_seen_at DESC`,
        [keyId]
      );
      const devices = res.rows;
      return {
        devices,
        totalDevices: devices.length,
        isAnomalous: devices.length > 5,
      };
    }

    const key = this.inMemoryKeys.get(keyId);
    if (!key || key.companyId !== companyId || key.tenantId !== tenantId) {
      throw new Error("KEY_NOT_FOUND");
    }
    const devices = Array.from(this.inMemoryDevices.get(keyId)?.values() ?? []);
    return {
      devices,
      totalDevices: devices.length,
      isAnomalous: devices.length > 5,
    };
  }

  async rotateSecret(keyId: string, newVaultOrKey: CryptoVault | string): Promise<boolean> {
    const newVault = typeof newVaultOrKey === "string" ? new CryptoVault(newVaultOrKey) : newVaultOrKey;
    if (this.pool) {
      const res = await this.pool.query(
        `SELECT id, encrypted_secret AS "encryptedSecret" FROM company_api_keys WHERE id = $1`,
        [keyId]
      );
      if (res.rows.length === 0 || !res.rows[0].encryptedSecret) return false;
      const reencrypted = this.vault.rotate(res.rows[0].encryptedSecret, newVault);
      await this.pool.query(
        `UPDATE company_api_keys SET encrypted_secret = $1, updated_at = NOW() WHERE id = $2`,
        [reencrypted, keyId]
      );
      return true;
    }

    const key = this.inMemoryKeys.get(keyId);
    if (!key || !key.encryptedSecret) return false;
    key.encryptedSecret = this.vault.rotate(key.encryptedSecret, newVault);
    key.updatedAt = new Date().toISOString();
    return true;
  }
}
