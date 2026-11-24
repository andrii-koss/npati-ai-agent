import { randomUUID, createHmac, createHash, createPublicKey, timingSafeEqual, verify as verifySignature, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";
import { isInsecureDefaultSecret, isProductionEnvironment } from "@npati/workspace";

export interface VisualInspectionResult {
  isSafe: boolean;
  violations: string[];
  scrubbedExif: boolean;
  imageDimensions: { width: number; height: number };
  inspectedAt: string;
  format?: "jpeg" | "png";
  removedMetadataChunks?: number;
  sanitizedContent?: Buffer;
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

/**
 * OIDC sign-in exists only when an operator configured it: an issuer, an audience and a key source (JWKS or a shared
 * secret). There is deliberately no default issuer — a default pointed at an unregistered domain, so whoever registered
 * it could publish signing keys and mint tokens for any workspace, with administrator roles, on every installation.
 */
export function configuredOidc(env: NodeJS.ProcessEnv = process.env, overrides: Partial<OidcVerificationConfig> = {}): OidcVerificationConfig | null {
  const expectedIssuer = overrides.expectedIssuer || env.OIDC_ISSUER;
  const expectedAudience = overrides.expectedAudience || env.OIDC_AUDIENCE;
  const jwksUri = overrides.jwksUri || env.OIDC_JWKS_URI;
  const sharedSecret = overrides.sharedSecret || env.OIDC_SHARED_SECRET;
  if (!expectedIssuer || !expectedAudience || (!jwksUri && !sharedSecret)) return null;
  return { expectedIssuer, expectedAudience, jwksUri, sharedSecret, allowedAlgorithms: overrides.allowedAlgorithms || (sharedSecret ? ["RS256", "HS256"] : ["RS256"]) };
}

export interface RemoteAccessToken {
  tokenId: string;
  tenantId: string;
  companyId: string;
  userId: string;
  scopes: string[];
  ipAllowlist?: string[];
  expiresAt: string;
  createdAt: string;
}

export class VisionBridgeGuardrail {
  private static readonly VISUAL_INJECTION_PATTERNS = [
    /\bsystem\s+prompt\b/i,
    /\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b/i,
    /\bdeveloper\s+mode\b/i,
    /\breveal\s+(?:the\s+)?(?:passwords?|secrets?|credentials?|system\s+prompt)\b/i,
    /\bdo\s+not\s+follow\s+(?:the\s+)?(?:system|developer)\b/i,
  ];

  static inspectVisualInput(imageContent: Buffer | string, extractedOcrText?: string): VisualInspectionResult {
    const bytes = this.decodeImage(imageContent);
    const sanitized = this.sanitizeImage(bytes);
    const violations: string[] = [];
    if (extractedOcrText) {
      for (const pattern of this.VISUAL_INJECTION_PATTERNS) {
        const match = pattern.exec(extractedOcrText);
        if (match) violations.push(`visual_prompt_injection: detected '${match[0]}'`);
      }
    }
    return {
      isSafe: violations.length === 0,
      violations: [...new Set(violations)],
      scrubbedExif: true,
      imageDimensions: sanitized.dimensions,
      inspectedAt: new Date().toISOString(),
      format: sanitized.format,
      removedMetadataChunks: sanitized.removed,
      sanitizedContent: sanitized.content,
    };
  }

  private static decodeImage(content: Buffer | string): Buffer {
    if (Buffer.isBuffer(content)) return Buffer.from(content);
    const value = content.trim();
    const dataUrl = /^data:image\/(?:jpeg|jpg|png);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
    const encoded = dataUrl?.[1] ?? value;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(encoded)) throw Object.assign(new Error("Image must be JPEG/PNG bytes or base64."), { status: 400, code: "INVALID_IMAGE" });
    const bytes = Buffer.from(encoded.replace(/\s/g, ""), "base64");
    if (bytes.length === 0) throw Object.assign(new Error("Image is empty."), { status: 400, code: "INVALID_IMAGE" });
    return bytes;
  }

  private static sanitizeImage(bytes: Buffer): { content: Buffer; format: "jpeg" | "png"; dimensions: { width: number; height: number }; removed: number } {
    if (bytes.length > 25 * 1024 * 1024) throw Object.assign(new Error("Image exceeds 25MB."), { status: 413, code: "IMAGE_TOO_LARGE" });
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return this.sanitizeJpeg(bytes);
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return this.sanitizePng(bytes);
    throw Object.assign(new Error("Only valid JPEG and PNG images are accepted."), { status: 415, code: "UNSUPPORTED_IMAGE_FORMAT" });
  }

  private static sanitizePng(bytes: Buffer) {
    const parts: Buffer[] = [bytes.subarray(0, 8)];
    let offset = 8, removed = 0, width = 0, height = 0, sawEnd = false;
    const metadata = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (length > 25 * 1024 * 1024 || end > bytes.length) throw Object.assign(new Error("Malformed PNG chunk."), { status: 400, code: "INVALID_IMAGE" });
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "IHDR") { width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12); }
      if (metadata.has(type)) removed += 1; else parts.push(bytes.subarray(offset, end));
      offset = end;
      if (type === "IEND") { sawEnd = true; break; }
    }
    if (!sawEnd || width < 1 || height < 1 || width * height > 100_000_000) throw Object.assign(new Error("Invalid PNG dimensions or structure."), { status: 400, code: "INVALID_IMAGE" });
    return { content: Buffer.concat(parts), format: "png" as const, dimensions: { width, height }, removed };
  }

  private static sanitizeJpeg(bytes: Buffer) {
    const parts: Buffer[] = [bytes.subarray(0, 2)];
    let offset = 2, removed = 0, width = 0, height = 0;
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) throw Object.assign(new Error("Malformed JPEG marker."), { status: 400, code: "INVALID_IMAGE" });
      const start = offset;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === undefined) break;
      if (marker === 0xd9) { parts.push(bytes.subarray(start, offset)); break; }
      if (marker === 0xda) {
        if (offset + 2 > bytes.length) throw Object.assign(new Error("Malformed JPEG scan."), { status: 400, code: "INVALID_IMAGE" });
        parts.push(bytes.subarray(start));
        offset = bytes.length;
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(bytes.subarray(start, offset)); continue; }
      if (offset + 2 > bytes.length) throw Object.assign(new Error("Malformed JPEG segment."), { status: 400, code: "INVALID_IMAGE" });
      const length = bytes.readUInt16BE(offset);
      const end = offset + length;
      if (length < 2 || end > bytes.length) throw Object.assign(new Error("Malformed JPEG segment length."), { status: 400, code: "INVALID_IMAGE" });
      if (sof.has(marker) && length >= 7) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); }
      if (marker === 0xe1 || marker === 0xed || marker === 0xfe) removed += 1; else parts.push(bytes.subarray(start, end));
      offset = end;
    }
    if (width < 1 || height < 1 || width * height > 100_000_000) throw Object.assign(new Error("Invalid JPEG dimensions or structure."), { status: 400, code: "INVALID_IMAGE" });
    return { content: Buffer.concat(parts), format: "jpeg" as const, dimensions: { width, height }, removed };
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

  constructor(secretKey?: string) {
    const configuredKey = secretKey || process.env.NPATI_REMOTE_ACCESS_TOKEN_SECRET || process.env.NPATI_ENCRYPTION_KEY;
    // NODE_ENV=production OR NPATI_ENV=production: compose runs NODE_ENV=production with NPATI_ENV=development by
    // default, and a check on NPATI_ENV alone accepted the public compose key (audit C1).
    const production = isProductionEnvironment();
    if (!configuredKey && production) {
      throw new Error("NPATI_REMOTE_ACCESS_TOKEN_SECRET_REQUIRED");
    }
    if (production && isInsecureDefaultSecret(configuredKey)) {
      throw new Error("NPATI_REMOTE_ACCESS_TOKEN_SECRET_UNSAFE_DEFAULT");
    }
    this.secretKey = configuredKey || "npati-development-only-remote-token-key";
    if (this.secretKey.length < 32) throw new Error("NPATI_REMOTE_ACCESS_TOKEN_SECRET_TOO_SHORT");
  }

  /**
   * 3. Scoped Remote Access Tokens: Mints short-lived signed tokens for CLI/Remote APIs
   */
  mintRemoteToken(params: {
    tenantId: string;
    companyId: string;
    userId: string;
    scopes: string[];
    ttlSeconds?: number;
    ipAllowlist?: string[];
  }): { token: string; details: RemoteAccessToken } {
    const tokenId = `rat_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const now = new Date();
    const ttl = params.ttlSeconds ?? 3600;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) throw new Error("REMOTE_TOKEN_TTL_OUT_OF_RANGE");
    if (!params.tenantId || !params.companyId || !params.userId || params.scopes.length === 0) throw new Error("REMOTE_TOKEN_CLAIMS_REQUIRED");
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

    const details: RemoteAccessToken = {
      tokenId,
      tenantId: params.tenantId,
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

      if (!signature || signature.length !== expectedSig.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        return { isValid: false, error: "INVALID_SIGNATURE: Token signature mismatch." };
      }

      const details: RemoteAccessToken = JSON.parse(
        Buffer.from(payloadBase64!, "base64url").toString("utf8")
      );

      if (details.tokenId !== tokenId || !details.tenantId || !details.companyId || !details.userId || !Array.isArray(details.scopes) || details.scopes.length === 0) {
        return { isValid: false, error: "INVALID_CLAIMS: Required remote-token claims are missing." };
      }

      // Check Expiration. An unparsable expiry is expired: `NaN < now` is false and used to mean "never expires".
      const expiresAt = new Date(details.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
        return { isValid: false, error: "TOKEN_EXPIRED: Remote token has expired." };
      }

      // Check IP Allowlist
      if (details.ipAllowlist && details.ipAllowlist.length > 0) {
        if (!clientIp || !details.ipAllowlist.includes(clientIp)) {
          return { isValid: false, error: `IP_FORBIDDEN: Client IP '${clientIp}' is not in allowlist.` };
        }
      }

      return { isValid: true, details };
    } catch (err: any) {
      return { isValid: false, error: `VERIFICATION_ERROR: ${err.message}` };
    }
  }
}
