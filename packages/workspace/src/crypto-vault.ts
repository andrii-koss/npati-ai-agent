import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const DEVELOPMENT_MASTER_KEY = "npati-development-only-master-key-change-me";

export interface EncryptedPayload {
  version: "v1";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class CryptoVault {
  private readonly masterKey: string;

  constructor(masterKey?: string) {
    const configuredKey = masterKey || process.env.NPATI_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
    if (!configuredKey && process.env.NODE_ENV === "production") {
      throw new Error("NPATI_ENCRYPTION_KEY_REQUIRED: production encryption key is not configured");
    }
    if (process.env.NPATI_ENV === "production" && configuredKey?.startsWith("npati-local-development-")) {
      throw new Error("NPATI_ENCRYPTION_KEY_UNSAFE_DEFAULT: replace the local development key before production");
    }
    this.masterKey = configuredKey || DEVELOPMENT_MASTER_KEY;
    if (this.masterKey.length < 32) {
      throw new Error("NPATI_ENCRYPTION_KEY_TOO_SHORT: encryption key must contain at least 32 characters");
    }
  }

  private deriveKey(salt: Buffer): Buffer {
    return scryptSync(this.masterKey, salt, KEY_LENGTH);
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
    const key = this.deriveKey(salt);

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
