import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Secrets that ship in this repository (compose defaults, development fallbacks, test fixtures) are public. They live
 * here, not in `insecure-secrets.ts`, because this module must import nothing but node:crypto (security gate G1);
 * `insecure-secrets.ts` re-exports them. Security audit 2026-11-24, C1.
 */
const INSECURE_SECRET_PATTERNS: readonly RegExp[] = [
  /^npati-local-/i,
  /^npati-development-/i,
  /change-before-production/i,
  /change-me/i,
  /^npati-agent-internal-local$/i,
  /^oidc_test_secret$/i,
  // Placeholders from .env.example / .env.production.example copied verbatim.
  /^replace[-_ ]?with/i,
  /^your[-_]/i,
];
const INSECURE_PASSWORDS = new Set(["npati", "postgres", "password", "admin", "minioadmin", "changeme", "secret"]);

/** True when the value is one of the publicly known defaults shipped with NPATI. */
export function isInsecureDefaultSecret(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return INSECURE_PASSWORDS.has(trimmed.toLowerCase()) || INSECURE_SECRET_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Production is NODE_ENV=production OR NPATI_ENV=production: compose runs every service with NODE_ENV=production
 * while NPATI_ENV defaults to development, and a check keyed on NPATI_ENV alone accepted the public compose keys.
 */
export function isProductionEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.NPATI_ENV === "production";
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const DEVELOPMENT_MASTER_KEY = "npati-development-only-master-key-change-me";

/**
 * The three refusals, spelled once. Their codes are the public contract of this module and are never reworded:
 * an operator reads them out of a log, and a caller switches on them.
 */
const PRODUCTION_KEY_REQUIRED = "NPATI_ENCRYPTION_KEY_REQUIRED: production encryption key is not configured";
const UNSAFE_DEVELOPMENT_KEY = "NPATI_ENCRYPTION_KEY_UNSAFE_DEFAULT: replace the local development key before production";
const KEY_TOO_SHORT = "NPATI_ENCRYPTION_KEY_TOO_SHORT: encryption key must contain at least 32 characters";

export interface EncryptedPayload {
  version: "v1";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * Why a configuration cannot be used, or `null` when it can. One implementation for both callers, so the
 * eagerly validated (explicit key) and the deferred (ambient `process.env` key) paths cannot drift apart.
 */
function detectRefusal(configuredKey: string | undefined, masterKey: string): string | null {
  // Production is NODE_ENV=production OR NPATI_ENV=production: compose runs NODE_ENV=production with NPATI_ENV
  // defaulting to development, and a check on NPATI_ENV alone accepted the public compose default (audit C1).
  const production = isProductionEnvironment();
  if (!configuredKey && production) return PRODUCTION_KEY_REQUIRED;
  if (production && isInsecureDefaultSecret(configuredKey)) return UNSAFE_DEVELOPMENT_KEY;
  if (masterKey.length < 32) return KEY_TOO_SHORT;
  return null;
}

/**
 * Decrypt-only keys (`NPATI_ENCRYPTION_KEY_PREVIOUS`, comma separated) for data written before a key rotation.
 * They may be the leaked development default: that is the case they exist for. New data is always written with
 * the current key, and `scripts/reencrypt-vault-secrets.ts` rewrites old ciphertext so the old key can be removed.
 */
function previousKeys(): string[] {
  return (process.env.NPATI_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((key) => key.trim()).filter(Boolean);
}

export class CryptoVault {
  private readonly masterKey: string;
  /**
   * The reason this vault cannot perform cryptography, already decided when it was built. `null` when it can.
   *
   * It is *stored* rather than thrown because the timing of the refusal is the whole point: this class is
   * constructed at **module load** by `defaultVault` below, so a throw from the constructor is a throw from
   * `import` — which is how a production deployment whose runner merely imports this module (transitively, via
   * the `@npati/workspace` barrel) crash-looped before it ever called `encrypt`. The refusal is therefore raised
   * by `assertUsable()`, i.e. at the first cryptographic operation and only there.
   *
   * The guarantee is unchanged: in production, no key means no ciphertext and no plaintext — an operation on an
   * unusable configuration throws instead of falling back to the development key. What moved is the moment.
   */
  private readonly refusal: string | null;
  /** Decrypt-only keys from before a rotation; only for the ambient (environment) configuration. */
  private readonly decryptOnlyKeys: string[];

  constructor(masterKey?: string, options: { previousKeys?: string[] } = {}) {
    const configuredKey = masterKey || process.env.NPATI_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
    this.masterKey = configuredKey || DEVELOPMENT_MASTER_KEY;
    this.refusal = detectRefusal(configuredKey, this.masterKey);
    this.decryptOnlyKeys = (options.previousKeys ?? (masterKey ? [] : previousKeys())).filter((key) => key !== this.masterKey);
    // A key handed to this constructor explicitly is validated **here**: the caller is asking for that key at
    // that moment, so a bad one is that call's failure and there is nothing to wait for.
    //
    // An ambient key (`process.env`) is not. `new CryptoVault()` is evaluated at module load by every importer of
    // the barrel, including importers that encrypt nothing, so an unusable ambient configuration must not be able
    // to stop a module from loading. `assertUsable()` raises it instead. Note the asymmetry can only make the
    // refusal *earlier*, never later, and never absent.
    if (masterKey && this.refusal !== null) throw new Error(this.refusal);
  }

  /**
   * Fail closed at the only place it matters: every operation that touches key material goes through here, so an
   * unusable configuration can never derive a key and therefore can never encrypt or decrypt. Called before the
   * payload shape is examined, because "this vault has no usable key" is the stronger fact and answering a format
   * question first would answer something the caller did not ask.
   */
  private assertUsable(): void {
    if (this.refusal !== null) throw new Error(this.refusal);
  }

  private deriveKey(salt: Buffer): Buffer {
    this.assertUsable();
    return scryptSync(this.masterKey, salt, KEY_LENGTH);
  }

  /** The same derivation for a decrypt-only previous key; guarded identically. */
  private derivePreviousKey(salt: Buffer, previousKey: string): Buffer {
    this.assertUsable();
    return scryptSync(previousKey, salt, KEY_LENGTH);
  }

  /**
   * Encrypts plaintext string with AES-256-GCM at rest.
   * Produces a formatted string `v1$salt$iv$tag$ciphertext` in hex/base64.
   */
  encrypt(plaintext: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = this.deriveKey(salt);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    let ciphertext = cipher.update(plaintext, "utf8", "hex");
    ciphertext += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    return `v1$${salt.toString("hex")}$${iv.toString("hex")}$${authTag}$${ciphertext}`;
  }

  /**
   * Decrypts AES-256-GCM ciphertext string with authentication tag verification.
   * Throws an error if ciphertext or tag was tampered with.
   */
  decrypt(encryptedString: string): string {
    return this.decryptWithKeyInfo(encryptedString).plaintext;
  }

  /**
   * Decrypts with the current key, then with each decrypt-only previous key. `usedPreviousKey` tells the
   * re-encryption script which values still depend on a key that is being retired.
   */
  decryptWithKeyInfo(encryptedString: string): { plaintext: string; usedPreviousKey: boolean } {
    try {
      return { plaintext: this.decryptWith(encryptedString, this.masterKey), usedPreviousKey: false };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("INVALID_ENCRYPTED_PAYLOAD")) throw error;
      if (error instanceof Error && error.message.startsWith("NPATI_ENCRYPTION_KEY_")) throw error;
      for (const key of this.decryptOnlyKeys) {
        try { return { plaintext: this.decryptWith(encryptedString, key), usedPreviousKey: true }; } catch { /* next key */ }
      }
      throw error;
    }
  }

  private decryptWith(encryptedString: string, masterKey: string): string {
    this.assertUsable();
    const parts = encryptedString.split("$");
    if (parts.length !== 5 || parts[0] !== "v1") {
      throw new Error("INVALID_ENCRYPTED_PAYLOAD_FORMAT");
    }

    const saltHex = parts[1];
    const ivHex = parts[2];
    const authTagHex = parts[3];
    const ciphertextHex = parts[4];

    if (!saltHex || !ivHex || !authTagHex || !ciphertextHex) {
      throw new Error("INVALID_ENCRYPTED_PAYLOAD_COMPONENTS");
    }

    const salt = Buffer.from(saltHex, "hex");
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const key = masterKey === this.masterKey ? this.deriveKey(salt) : this.derivePreviousKey(salt, masterKey);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  /**
   * Helper to safely encrypt an object
   */
  encryptJson(obj: unknown): string {
    return this.encrypt(JSON.stringify(obj));
  }

  /**
   * Helper to safely decrypt a JSON object
   */
  decryptJson<T = unknown>(encryptedString: string): T {
    const jsonStr = this.decrypt(encryptedString);
    return JSON.parse(jsonStr) as T;
  }

  /**
   * Re-encrypts payload using a new master key or new vault instance.
   * Ensures seamless zero-downtime key rotation.
   */
  rotate(encryptedString: string, newVaultOrKey: CryptoVault | string): string {
    const plaintext = this.decrypt(encryptedString);
    const targetVault = typeof newVaultOrKey === "string" ? new CryptoVault(newVaultOrKey) : newVaultOrKey;
    return targetVault.encrypt(plaintext);
  }
}

export const defaultVault = new CryptoVault();
