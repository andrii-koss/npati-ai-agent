import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256" | "plain";
  userId: string;
  tenantId: string;
  scopes: string[];
  expiresAt: number; // timestamp ms
  used: boolean;
}

export class OAuthPkceService {
  private readonly codes = new Map<string, AuthorizationCodeRecord>();

  /**
   * Helper to encode a Buffer to base64url format
   */
  static base64UrlEncode(buffer: Buffer): string {
    return buffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  /**
   * Generates a random PKCE Code Verifier and Code Challenge using S256
   */
  static generatePkcePair(): PkcePair {
    const rawVerifier = randomBytes(32);
    const codeVerifier = this.base64UrlEncode(rawVerifier);
    const hash = createHash("sha256").update(codeVerifier).digest();
    const codeChallenge = this.base64UrlEncode(hash);
    return {
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: "S256",
    };
  }

  /**
   * Verifies if a given code_verifier matches the code_challenge
   */
  static verifyCodeChallenge(
    codeVerifier: string,
    codeChallenge: string,
    method: "S256" | "plain" = "S256"
  ): boolean {
    if (!codeVerifier || !codeChallenge) return false;

    if (method === "plain") {
      const b1 = Buffer.from(codeVerifier);
      const b2 = Buffer.from(codeChallenge);
      return b1.length === b2.length && timingSafeEqual(b1, b2);
    }

    if (method === "S256") {
      const hash = createHash("sha256").update(codeVerifier).digest();
      const computedChallenge = this.base64UrlEncode(hash);
      const b1 = Buffer.from(computedChallenge);
      const b2 = Buffer.from(codeChallenge);
      return b1.length === b2.length && timingSafeEqual(b1, b2);
    }

    return false;
  }

  /**
   * Issue a short-lived authorization code (valid for 5 minutes)
   */
  createAuthorizationCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod?: "S256" | "plain";
    userId: string;
    tenantId: string;
    scopes?: string[];
  }): string {
    const code = `npati_ac_${randomBytes(24).toString("hex")}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    this.codes.set(code, {
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod ?? "S256",
      userId: params.userId,
      tenantId: params.tenantId,
      scopes: params.scopes ?? ["all"],
      expiresAt,
      used: false,
    });

    return code;
  }

  /**
   * Exchange an authorization code for validated auth details with PKCE verification
   */
  exchangeCode(params: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }): { valid: true; userId: string; tenantId: string; scopes: string[] } | { valid: false; error: string } {
    const record = this.codes.get(params.code);

    if (!record) {
      return { valid: false, error: "INVALID_AUTHORIZATION_CODE" };
    }

    if (record.used) {
      return { valid: false, error: "AUTHORIZATION_CODE_ALREADY_USED" };
    }

    if (Date.now() > record.expiresAt) {
      this.codes.delete(params.code);
      return { valid: false, error: "AUTHORIZATION_CODE_EXPIRED" };
    }

    if (record.clientId !== params.clientId) {
      return { valid: false, error: "CLIENT_ID_MISMATCH" };
    }

    if (record.redirectUri !== params.redirectUri) {
      return { valid: false, error: "REDIRECT_URI_MISMATCH" };
    }

    // Verify PKCE Challenge
    const pkceValid = OAuthPkceService.verifyCodeChallenge(
      params.codeVerifier,
      record.codeChallenge,
      record.codeChallengeMethod
    );

    if (!pkceValid) {
      return { valid: false, error: "PKCE_VERIFICATION_FAILED" };
    }

    // Mark as used
    record.used = true;
    this.codes.delete(params.code);

    return {
      valid: true,
      userId: record.userId,
      tenantId: record.tenantId,
      scopes: record.scopes,
    };
  }
}
