import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scrypt,
  sign,
  timingSafeEqual,
  verify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import type { ProjectAuthSettings, ProjectAuthTokenClaims, ProjectAuthTokenHeader } from "@npati/shared";
import { DataStudioError } from "./identifier";

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
}

export interface ProjectSigningKey {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
  createdAt: string;
}

export interface ProjectPreviousKey {
  kid: string;
  publicKeyPem: string;
  expiresAt: number;
}

export interface ProjectKeyBundle {
  activeKey: ProjectSigningKey;
  activeKeyId: string;
  previousKeys: ProjectPreviousKey[];
}

export class ProjectPasswordHasher {
  private static readonly SCRYPT_N = 16384;
  private static readonly SCRYPT_R = 8;
  private static readonly SCRYPT_P = 1;
  private static readonly KEY_LEN = 32;

  static validatePolicy(password: string, settings: ProjectAuthSettings): void {
    if (!password || typeof password !== "string") {
      throw new DataStudioError(400, "password", "Password is required", false, "INVALID_PASSWORD");
    }
    const minLen = Math.max(6, settings.minPasswordLength ?? 8);
    if (password.length < minLen) {
      throw new DataStudioError(400, "password", `Password must be at least ${minLen} characters`, false, "PASSWORD_TOO_SHORT");
    }
    if (settings.requireNumbers && !/\d/.test(password)) {
      throw new DataStudioError(400, "password", "Password must contain at least one digit", false, "PASSWORD_REQUIRES_NUMBER");
    }
    if (settings.requireSymbols && !/[!@#$%^&*(),.?":{}|<>_\-+=[\]\\/]/.test(password)) {
      throw new DataStudioError(400, "password", "Password must contain at least one symbol", false, "PASSWORD_REQUIRES_SYMBOL");
    }
  }

  static async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = (await scryptAsync(password, salt, this.KEY_LEN, {
      N: this.SCRYPT_N,
      r: this.SCRYPT_R,
      p: this.SCRYPT_P,
    })) as Buffer;

    return `$scrypt$N=${this.SCRYPT_N},r=${this.SCRYPT_R},p=${this.SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
  }

  static async verify(password: string, storedHash: string): Promise<boolean> {
    if (!storedHash || typeof storedHash !== "string") return false;

    if (storedHash.startsWith("$scrypt$")) {
      const parts = storedHash.split("$");
      // Format: "", "scrypt", "N=16384,r=8,p=1", salt, hash
      if (parts.length < 5) return false;
      const saltHex = parts[3];
      const keyHex = parts[4];
      if (!saltHex || !keyHex) return false;

      const salt = Buffer.from(saltHex, "hex");
      const expectedKey = Buffer.from(keyHex, "hex");

      const derivedKey = (await scryptAsync(password, salt, expectedKey.length, {
        N: this.SCRYPT_N,
        r: this.SCRYPT_R,
        p: this.SCRYPT_P,
      })) as Buffer;

      return timingSafeEqual(derivedKey, expectedKey);
    }

    // Fallback for argon2id style format if present
    if (storedHash.startsWith("$argon2id$")) {
      const parts = storedHash.split("$");
      if (parts.length < 6) return false;
      const salt = Buffer.from(parts[4] ?? "", "base64");
      const expectedKey = Buffer.from(parts[5] ?? "", "base64");
      const derivedKey = (await scryptAsync(password, salt, expectedKey.length, {
        N: this.SCRYPT_N,
        r: this.SCRYPT_R,
        p: this.SCRYPT_P,
      })) as Buffer;
      return timingSafeEqual(derivedKey, expectedKey);
    }

    return false;
  }

  static async dummyVerify(): Promise<void> {
    const dummySalt = Buffer.alloc(16, 0);
    await scryptAsync("dummy-timing-protection", dummySalt, this.KEY_LEN, {
      N: this.SCRYPT_N,
      r: this.SCRYPT_R,
      p: this.SCRYPT_P,
    });
  }
}

export class ProjectKeyManager {
  static createBundle(): ProjectKeyBundle {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const kid = "kid_" + randomBytes(8).toString("hex");

    return {
      activeKey: {
        kid,
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        createdAt: new Date().toISOString(),
      },
      activeKeyId: kid,
      previousKeys: [],
    };
  }

  static rotateBundle(bundle: ProjectKeyBundle, accessTokenTtlSeconds = 900): ProjectKeyBundle {
    const now = Math.floor(Date.now() / 1000);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const newKid = "kid_" + randomBytes(8).toString("hex");

    const previousKeys: ProjectPreviousKey[] = [
      {
        kid: bundle.activeKey.kid,
        publicKeyPem: bundle.activeKey.publicKeyPem,
        expiresAt: now + accessTokenTtlSeconds + 60,
      },
      ...bundle.previousKeys.filter((k) => k.expiresAt > now),
    ];

    return {
      activeKey: {
        kid: newKid,
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        createdAt: new Date().toISOString(),
      },
      activeKeyId: newKid,
      previousKeys,
    };
  }

  static rotateKeys(bundle: ProjectKeyBundle, accessTokenTtlSeconds = 900): ProjectKeyBundle {
    return this.rotateBundle(bundle, accessTokenTtlSeconds);
  }

  static signJwt(
    claims: Omit<ProjectAuthTokenClaims, "iat" | "jti">,
    bundle: ProjectKeyBundle,
  ): string {
    const header: ProjectAuthTokenHeader = {
      alg: "EdDSA",
      typ: "JWT",
      kid: bundle.activeKey.kid,
    };

    const fullClaims: ProjectAuthTokenClaims = {
      ...claims,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const encodedPayload = Buffer.from(JSON.stringify(fullClaims)).toString("base64url");
    const dataToSign = `${encodedHeader}.${encodedPayload}`;

    const privateKey = createPrivateKey(bundle.activeKey.privateKeyPem);
    const signature = sign(null, Buffer.from(dataToSign), privateKey);
    const encodedSignature = signature.toString("base64url");

    return `${dataToSign}.${encodedSignature}`;
  }

  static verifyJwt(
    token: string,
    bundle: ProjectKeyBundle,
    expectedIss: string,
    expectedAud: string,
  ): ProjectAuthTokenClaims {
    if (!token || typeof token !== "string") {
      throw new DataStudioError(401, "auth", "Invalid token format", false, "INVALID_TOKEN");
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new DataStudioError(401, "auth", "Invalid JWT format", false, "INVALID_TOKEN");
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    let header: ProjectAuthTokenHeader;
    let claims: ProjectAuthTokenClaims;

    try {
      header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    } catch {
      throw new DataStudioError(401, "auth", "Malformed token JSON", false, "MALFORMED_TOKEN");
    }

    if (header.alg !== "EdDSA") {
      throw new DataStudioError(401, "auth", "Unsupported token algorithm", false, "INVALID_ALGORITHM");
    }

    let publicKeyPem: string | undefined;
    if (bundle.activeKey.kid === header.kid) {
      publicKeyPem = bundle.activeKey.publicKeyPem;
    } else {
      const prev = bundle.previousKeys.find((k) => k.kid === header.kid);
      if (prev) {
        publicKeyPem = prev.publicKeyPem;
      }
    }

    if (!publicKeyPem) {
      throw new DataStudioError(401, "auth", "Unknown key identifier (kid)", false, "UNKNOWN_KID");
    }

    const dataToVerify = `${headerB64}.${payloadB64}`;
    const publicKey = createPublicKey(publicKeyPem);
    const signature = Buffer.from(signatureB64!, "base64url");

    const valid = verify(null, Buffer.from(dataToVerify), publicKey, signature);
    if (!valid) {
      throw new DataStudioError(401, "auth", "Invalid token signature", false, "INVALID_SIGNATURE");
    }

    if (claims.iss !== expectedIss) {
      throw new DataStudioError(401, "auth", "Invalid token issuer", false, "INVALID_ISSUER");
    }

    if (claims.aud !== expectedAud) {
      throw new DataStudioError(401, "auth", "Invalid token audience", false, "INVALID_AUDIENCE");
    }

    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now) {
      throw new DataStudioError(401, "auth", "Token expired", false, "TOKEN_EXPIRED");
    }

    return claims;
  }
}

export class OpaqueTokenManager {
  static generate(): string {
    return randomBytes(32).toString("hex");
  }

  static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}

export class AuthRateLimiter {
  private readonly attempts = new Map<string, { count: number; lockedUntil?: number }>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;

  constructor(options: { maxAttempts?: number; windowMs?: number; lockoutMs?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
  }

  check(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry) return;

    const now = Date.now();
    if (entry.lockedUntil && entry.lockedUntil > now) {
      const waitMinutes = Math.ceil((entry.lockedUntil - now) / 60000);
      throw new DataStudioError(
        429,
        "auth_rate_limit",
        `Too many failed attempts. Try again in ${waitMinutes} minute(s).`,
        true,
        "ACCOUNT_TEMPORARILY_LOCKED",
      );
    }
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key) ?? { count: 0 };
    entry.count += 1;

    if (entry.count >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
    }
    this.attempts.set(key, entry);
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  clear(): void {
    this.attempts.clear();
  }
}
