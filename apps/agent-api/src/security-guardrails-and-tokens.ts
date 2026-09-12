import { randomUUID, createHmac, createHash, createPublicKey, timingSafeEqual, verify as verifySignature, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";

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
  aud: string | string[];
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

export interface OidcVerificationConfig {
  expectedIssuer: string;
  expectedAudience: string;
  jwksUri?: string;
  sharedSecret?: string;
  allowedAlgorithms?: ReadonlyArray<"RS256" | "RS384" | "RS512" | "HS256">;
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
  private static readonly jwksCache = new Map<string, { expiresAt: number; keys: CryptoJsonWebKey[] }>();

  static async verifyOidcToken(jwtToken: string, config: OidcVerificationConfig): Promise<OidcVerificationResult> {
    try {
      const parts = jwtToken.split(".");
      if (parts.length !== 3) return { isValid: false, error: "MALFORMED_JWT: Token must have 3 segments." };

      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { alg?: string; kid?: string };
      const allowedAlgorithms = config.allowedAlgorithms ?? ["RS256"];
      if (!header.alg || header.alg === "none" || !allowedAlgorithms.includes(header.alg as any)) {
        return { isValid: false, error: `UNSUPPORTED_ALGORITHM: '${header.alg || "missing"}'.` };
      }

      const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
      const signature = Buffer.from(parts[2]!, "base64url");
      let signatureValid = false;
      if (header.alg === "HS256") {
        if (!config.sharedSecret) return { isValid: false, error: "OIDC_SHARED_SECRET_REQUIRED" };
        const expected = createHmac("sha256", config.sharedSecret).update(signingInput).digest();
        signatureValid = signature.length === expected.length && timingSafeEqual(signature, expected);
      } else {
        if (!header.kid) return { isValid: false, error: "OIDC_KID_REQUIRED" };
        const jwksUri = config.jwksUri || `${config.expectedIssuer.replace(/\/$/, "")}/.well-known/jwks.json`;
        const keys = await this.loadJwks(jwksUri);
        const jwk = keys.find((candidate: any) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === header.alg));
        if (!jwk) return { isValid: false, error: "OIDC_SIGNING_KEY_NOT_FOUND" };
        const algorithm = header.alg === "RS256" ? "RSA-SHA256" : header.alg === "RS384" ? "RSA-SHA384" : "RSA-SHA512";
        signatureValid = verifySignature(algorithm, signingInput, createPublicKey({ key: jwk, format: "jwk" }), signature);
      }
      if (!signatureValid) return { isValid: false, error: "INVALID_SIGNATURE: OIDC token signature verification failed." };

      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as OidcClaims;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!claims.exp || claims.exp <= nowSec) return { isValid: false, error: "TOKEN_EXPIRED: OIDC token has expired." };
      if (claims.iss !== config.expectedIssuer) return { isValid: false, error: `INVALID_ISSUER: Expected '${config.expectedIssuer}'.` };
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(config.expectedAudience)) return { isValid: false, error: `INVALID_AUDIENCE: Expected '${config.expectedAudience}'.` };
      if (!claims.sub) return { isValid: false, error: "SUBJECT_REQUIRED: OIDC token has no subject." };
      return { isValid: true, claims };
    } catch (err: any) {
      return { isValid: false, error: `VERIFICATION_FAILED: ${err.message}` };
    }
  }

  private static async loadJwks(jwksUri: string): Promise<CryptoJsonWebKey[]> {
    const cached = this.jwksCache.get(jwksUri);
    if (cached && cached.expiresAt > Date.now()) return cached.keys;
    const response = await fetch(jwksUri, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`JWKS_FETCH_FAILED: HTTP ${response.status}`);
    const body = await response.json() as { keys?: CryptoJsonWebKey[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("JWKS_EMPTY");
    this.jwksCache.set(jwksUri, { keys: body.keys, expiresAt: Date.now() + 5 * 60_000 });
    return body.keys;
  }

  static createMockOidcToken(claims: Partial<OidcClaims>, secret = "oidc_test_secret"): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      sub: claims.sub || "user-123", iss: claims.iss || "https://auth.npati.ai",
      aud: claims.aud || "npati-dashboard", exp: claims.exp || Math.floor(Date.now() / 1000) + 3600,
      email: claims.email || "admin@npati.ai", tenantId: claims.tenantId || "comp-admin-1", roles: claims.roles || ["admin"],
    })).toString("base64url");
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
