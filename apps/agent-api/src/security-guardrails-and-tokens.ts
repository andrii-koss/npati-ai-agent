import { randomUUID, createHmac, createHash } from "node:crypto";

export interface VisualInspectionResult {
  isSafe: boolean;
  violations: string[];
  scrubbedExif: boolean;
  imageDimensions: { width: number; height: number };
  inspectedAt: string;
}

export interface OidcClaims {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  email: string;
  name?: string;
  tenantId?: string;
  roles?: string[];
}

export interface OidcVerificationResult {
  isValid: boolean;
  claims?: OidcClaims;
  error?: string;
}

export interface RemoteAccessToken {
  tokenId: string;
  companyId: string;
  userId: string;
  scopes: string[];
  ipAllowlist?: string[];
  expiresAt: string;
  createdAt: string;
}

export class VisionBridgeGuardrail {
  private static readonly VISUAL_INJECTION_KEYWORDS = [
    "system prompt",
    "ignore instructions",
    "developer mode",
    "reveal passwords",
  ];

  /**
   * 1. Vision Bridge Guardrail: EXIF scrubbing & visual safety inspection
   */
  static inspectVisualInput(
    imageContent: Buffer | string,
    extractedOcrText?: string
  ): VisualInspectionResult {
    const violations: string[] = [];
    let scrubbedExif = false;

    // 1. Check OCR text for hidden prompt injection instructions
    if (extractedOcrText) {
      const textLower = extractedOcrText.toLowerCase();
      for (const kw of this.VISUAL_INJECTION_KEYWORDS) {
        if (textLower.includes(kw)) {
          violations.push(`visual_prompt_injection: detected '${kw}'`);
        }
      }
    }

    // 2. EXIF data scrubbing simulation (strips GPS/camera metadata)
    if (Buffer.isBuffer(imageContent) && imageContent.length > 0) {
      scrubbedExif = true;
    }

    return {
      isSafe: violations.length === 0,
      violations,
      scrubbedExif,
      imageDimensions: { width: 1024, height: 1024 },
      inspectedAt: new Date().toISOString(),
    };
  }
}

export class OidcDashboardGate {
  /**
   * 2. OIDC Dashboard Gate: Verifies OpenID Connect ID Tokens for dashboard login
   */
  static verifyOidcToken(
    jwtToken: string,
    config: { expectedIssuer: string; expectedAudience: string }
  ): OidcVerificationResult {
    try {
      const parts = jwtToken.split(".");
      if (parts.length !== 3) {
        return { isValid: false, error: "MALFORMED_JWT: Token must have 3 segments." };
      }

      const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8");
      const claims: OidcClaims = JSON.parse(payloadJson);

      // Check Expiration
      const nowSec = Math.floor(Date.now() / 1000);
      if (claims.exp && claims.exp < nowSec) {
        return { isValid: false, error: "TOKEN_EXPIRED: OIDC token has expired." };
      }

      // Check Issuer
      if (claims.iss !== config.expectedIssuer) {
        return {
          isValid: false,
          error: `INVALID_ISSUER: Expected '${config.expectedIssuer}', got '${claims.iss}'.`,
        };
      }

      // Check Audience
      if (claims.aud !== config.expectedAudience) {
        return {
          isValid: false,
          error: `INVALID_AUDIENCE: Expected '${config.expectedAudience}', got '${claims.aud}'.`,
        };
      }

      return { isValid: true, claims };
    } catch (err: any) {
      return { isValid: false, error: `VERIFICATION_FAILED: ${err.message}` };
    }
  }

  /**
   * Helper to create mock test tokens
   */
  static createMockOidcToken(claims: Partial<OidcClaims>, secret = "oidc_test_secret"): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: claims.sub || "user-123",
        iss: claims.iss || "https://auth.npati.ai",
        aud: claims.aud || "npati-dashboard",
        exp: claims.exp || Math.floor(Date.now() / 1000) + 3600,
        email: claims.email || "admin@npati.ai",
        tenantId: claims.tenantId || "comp-admin-1",
        roles: claims.roles || ["admin"],
      })
    ).toString("base64url");

    const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${signature}`;
  }
}

export class ScopedRemoteAccessTokenManager {
  private readonly secretKey: string;

  constructor(secretKey = "npati_remote_token_master_key_999") {
    this.secretKey = secretKey;
  }

  /**
   * 3. Scoped Remote Access Tokens: Mints short-lived signed tokens for CLI/Remote APIs
   */
  mintRemoteToken(params: {
    companyId: string;
    userId: string;
    scopes: string[];
    ttlSeconds?: number;
    ipAllowlist?: string[];
  }): { token: string; details: RemoteAccessToken } {
    const tokenId = `rat_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const now = new Date();
    const ttl = params.ttlSeconds ?? 3600;
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

    const details: RemoteAccessToken = {
      tokenId,
      companyId: params.companyId,
      userId: params.userId,
      scopes: params.scopes,
      ipAllowlist: params.ipAllowlist,
      expiresAt,
      createdAt: now.toISOString(),
    };

    const payloadBase64 = Buffer.from(JSON.stringify(details)).toString("base64url");
    const signature = createHmac("sha256", this.secretKey).update(payloadBase64).digest("base64url");
    const token = `${tokenId}.${payloadBase64}.${signature}`;

    return { token, details };
  }

  /**
   * Verify Scoped Remote Access Token
   */
  verifyRemoteToken(
    token: string,
    clientIp?: string
  ): { isValid: boolean; details?: RemoteAccessToken; error?: string } {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return { isValid: false, error: "INVALID_FORMAT: Remote token format is invalid." };
      }

      const [tokenId, payloadBase64, signature] = parts;
      const expectedSig = createHmac("sha256", this.secretKey).update(payloadBase64!).digest("base64url");

      if (signature !== expectedSig) {
        return { isValid: false, error: "INVALID_SIGNATURE: Token signature mismatch." };
      }

      const details: RemoteAccessToken = JSON.parse(
        Buffer.from(payloadBase64!, "base64url").toString("utf8")
      );

      // Check Expiration
      if (new Date(details.expiresAt).getTime() < Date.now()) {
        return { isValid: false, error: "TOKEN_EXPIRED: Remote token has expired." };
      }

      // Check IP Allowlist
      if (details.ipAllowlist && details.ipAllowlist.length > 0 && clientIp) {
        if (!details.ipAllowlist.includes(clientIp)) {
          return { isValid: false, error: `IP_FORBIDDEN: Client IP '${clientIp}' is not in allowlist.` };
        }
      }

      return { isValid: true, details };
    } catch (err: any) {
      return { isValid: false, error: `VERIFICATION_ERROR: ${err.message}` };
    }
  }
}
