import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number; // in seconds, e.g. 3600 (1 hour)
  scopes: string[];
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tenantId: string;
  tokenHash: string;
  familyId: string;
  scopes: string[];
  isRevoked: boolean;
  expiresAt: string;
  rotatedAt?: string;
  createdAt: string;
}

export class TokenRefreshManager {
  private readonly inMemoryTokens = new Map<string, RefreshTokenRecord>();

  constructor(private readonly pool?: Pool) {}

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /**
   * Issue a new token pair with a brand new Token Family
   */
  async issueTokenPair(userId: string, tenantId: string, scopes: string[] = ["all"]): Promise<TokenPair> {
    const familyId = randomUUID();
    return this.createTokenInFamily(userId, tenantId, familyId, scopes);
  }

  private async createTokenInFamily(
    userId: string,
    tenantId: string,
    familyId: string,
    scopes: string[]
  ): Promise<TokenPair> {
    const id = randomUUID();
    const rawAccessToken = `npati_at_${randomBytes(24).toString("hex")}`;
    const rawRefreshToken = `npati_rt_${randomBytes(32).toString("hex")}`;
    const tokenHash = this.hashToken(rawRefreshToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const record: RefreshTokenRecord = {
      id,
      userId,
      tenantId,
      tokenHash,
      familyId,
      scopes,
      isRevoked: false,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
    };

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO oauth_refresh_tokens (
          id, user_id, tenant_id, token_hash, family_id, scopes, is_revoked, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, userId, tenantId, tokenHash, familyId, scopes, false, expiresAt, now]
      );
    } else {
      this.inMemoryTokens.set(tokenHash, record);
    }

    return {
      accessToken: rawAccessToken,
      refreshToken: rawRefreshToken,
      tokenType: "Bearer",
      expiresIn: 3600, // 1 hour for access token
      scopes,
    };
  }

  /**
   * Automatically refresh token with single-use rotation and token reuse detection
   */
  async refreshToken(rawRefreshToken: string): Promise<{ success: true; tokens: TokenPair } | { success: false; error: string }> {
    if (!rawRefreshToken || !rawRefreshToken.startsWith("npati_rt_")) {
      return { success: false, error: "INVALID_REFRESH_TOKEN_FORMAT" };
    }

    const tokenHash = this.hashToken(rawRefreshToken);
    let record: RefreshTokenRecord | null = null;

    if (this.pool) {
      const res = await this.pool.query(
        `SELECT id, user_id AS "userId", tenant_id AS "tenantId", token_hash AS "tokenHash",
                family_id AS "familyId", scopes, is_revoked AS "isRevoked", expires_at AS "expiresAt",
                rotated_at AS "rotatedAt", created_at AS "createdAt"
         FROM oauth_refresh_tokens
         WHERE token_hash = $1`,
        [tokenHash]
      );
      if (res.rows.length > 0) record = res.rows[0];
    } else {
      record = this.inMemoryTokens.get(tokenHash) || null;
    }

    if (!record) {
      return { success: false, error: "REFRESH_TOKEN_NOT_FOUND" };
    }

    // SECURITY CHECK: Token Reuse Detection
    // If a token that was ALREADY rotated is used again, it's a replay attack!
    // Revoke the ENTIRE token family immediately!
    if (record.rotatedAt || record.isRevoked) {
      await this.revokeFamily(record.familyId);
      return {
        success: false,
        error: "TOKEN_REUSE_DETECTED: Refresh token was already used. All tokens in this session family have been revoked.",
      };
    }

    // Check expiration
    if (new Date(record.expiresAt) < new Date()) {
      return { success: false, error: "REFRESH_TOKEN_EXPIRED" };
    }

    // Mark current refresh token as rotated
    const now = new Date();
    if (this.pool) {
      await this.pool.query(
        `UPDATE oauth_refresh_tokens
         SET rotated_at = $1
         WHERE id = $2`,
        [now, record.id]
      );
    } else {
      record.rotatedAt = now.toISOString();
    }

    // Issue a brand new token pair in the same family
    const newTokens = await this.createTokenInFamily(
      record.userId,
      record.tenantId,
      record.familyId,
      record.scopes
    );

    return {
      success: true,
      tokens: newTokens,
    };
  }

  /**
   * Revoke all tokens within a token family (e.g. on logout or compromise)
   */
  async revokeFamily(familyId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `UPDATE oauth_refresh_tokens
         SET is_revoked = true
         WHERE family_id = $1`,
        [familyId]
      );
    } else {
      for (const token of this.inMemoryTokens.values()) {
        if (token.familyId === familyId) {
          token.isRevoked = true;
        }
      }
    }
  }
}
