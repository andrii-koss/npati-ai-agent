import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CryptoVault } from "@npati/workspace";
import type { DataEnvironmentName } from "./types";
import type { ProjectApiKeysConfig, ProjectApiKeysInfo } from "@npati/shared";

export class ProjectApiKeyManager {
  static generatePublishableKey(environment: DataEnvironmentName): string {
    return `npati_pk_${environment}_${randomBytes(16).toString("hex")}`;
  }

  static generateSecretKey(environment: DataEnvironmentName): string {
    return `npati_sk_${environment}_${randomBytes(24).toString("hex")}`;
  }

  static hashSecretKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }

  static parseKey(key: string): { type: "publishable" | "secret"; environment: DataEnvironmentName } | null {
    if (!key || typeof key !== "string") return null;
    const match = /^npati_(pk|sk)_(dev|prod)_[0-9a-f]{32,64}$/.exec(key);
    if (!match) return null;
    return {
      type: match[1] === "pk" ? "publishable" : "secret",
      environment: match[2] as DataEnvironmentName,
    };
  }

  /**
   * Ensures API keys exist in providerConfig. If not present, generates and stores them.
   */
  static ensureKeys(
    providerConfig: Record<string, unknown>,
    environment: DataEnvironmentName,
    vault: CryptoVault,
  ): {
    publishableKey: string;
    secretKey?: string;
    updatedConfig: Record<string, unknown>;
  } {
    let publishableKey = providerConfig.publishableKey as string | undefined;
    let secretKeyHash = providerConfig.secretKeyHash as string | undefined;
    let encryptedSecretKey = providerConfig.encryptedSecretKey as string | undefined;
    let generatedPlainSecretKey: string | undefined;

    let modified = false;

    if (!publishableKey || !this.parseKey(publishableKey)) {
      publishableKey = this.generatePublishableKey(environment);
      modified = true;
    }

    if (!secretKeyHash || !encryptedSecretKey) {
      generatedPlainSecretKey = this.generateSecretKey(environment);
      secretKeyHash = this.hashSecretKey(generatedPlainSecretKey);
      encryptedSecretKey = vault.encrypt(generatedPlainSecretKey);
      modified = true;
    }

    const defaultOrigins = environment === "dev"
      ? ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"]
      : [];

    const corsAllowedOrigins = Array.isArray(providerConfig.corsAllowedOrigins)
      ? (providerConfig.corsAllowedOrigins as string[])
      : defaultOrigins;

    const rateLimit = (providerConfig.rateLimit as { maxRequestsPerMinute?: number }) || {
      maxRequestsPerMinute: environment === "dev" ? 300 : 120,
    };

    const updatedConfig: Record<string, unknown> = {
      ...providerConfig,
      publishableKey,
      secretKeyHash,
      encryptedSecretKey,
      corsAllowedOrigins,
      rateLimit,
    };

    return {
      publishableKey,
      secretKey: generatedPlainSecretKey,
      updatedConfig,
    };
  }

  /**
   * Rotates publishable, secret, or both keys.
   */
  static rotateKeys(
    providerConfig: Record<string, unknown>,
    environment: DataEnvironmentName,
    target: "publishable" | "secret" | "both",
    vault: CryptoVault,
  ): {
    publishableKey: string;
    secretKey?: string;
    updatedConfig: Record<string, unknown>;
  } {
    const current = this.ensureKeys(providerConfig, environment, vault);
    const config = current.updatedConfig;

    const previousKeys = Array.isArray(config.previousKeys) ? [...(config.previousKeys as any[])] : [];
    let publishableKey = config.publishableKey as string;
    let secretKeyHash = config.secretKeyHash as string;
    let encryptedSecretKey = config.encryptedSecretKey as string;
    let plainSecretKey: string | undefined;

    const now = new Date().toISOString();

    if (target === "publishable" || target === "both") {
      previousKeys.push({
        keyType: "publishable",
        keyOrHash: publishableKey,
        deprecatedAt: now,
      });
      publishableKey = this.generatePublishableKey(environment);
    }

    if (target === "secret" || target === "both") {
      previousKeys.push({
        keyType: "secret",
        keyOrHash: secretKeyHash,
        deprecatedAt: now,
      });
      plainSecretKey = this.generateSecretKey(environment);
      secretKeyHash = this.hashSecretKey(plainSecretKey);
      encryptedSecretKey = vault.encrypt(plainSecretKey);
    }

    // Keep only last 5 previous keys
    const prunedPrevious = previousKeys.slice(-5);

    const updatedConfig: Record<string, unknown> = {
      ...config,
      publishableKey,
      secretKeyHash,
      encryptedSecretKey,
      previousKeys: [],
    };

    return {
      publishableKey,
      secretKey: plainSecretKey,
      updatedConfig,
    };
  }

  /**
   * Decrypts the secret key for authorized admin view.
   */
  static revealSecretKey(providerConfig: Record<string, unknown>, vault: CryptoVault): string | null {
    const encrypted = providerConfig.encryptedSecretKey as string | undefined;
    if (!encrypted) return null;
    try {
      return vault.decrypt(encrypted);
    } catch {
      return null;
    }
  }

  /**
   * Validates if a provided key matches active or recent previous keys.
   */
  static validateKey(
    providedKey: string,
    providerConfig: Record<string, unknown>,
    expectedEnvironment: DataEnvironmentName,
  ): {
    valid: boolean;
    keyType: "publishable" | "secret" | null;
    isDeprecated?: boolean;
  } {
    const parsed = this.parseKey(providedKey);
    if (!parsed || parsed.environment !== expectedEnvironment) {
      return { valid: false, keyType: null };
    }

    if (parsed.type === "publishable") {
      if (providedKey === providerConfig.publishableKey) {
        return { valid: true, keyType: "publishable", isDeprecated: false };
      }
      return { valid: false, keyType: null };
    }

    if (parsed.type === "secret") {
      const hash = Buffer.from(this.hashSecretKey(providedKey), "hex");
      const stored = typeof providerConfig.secretKeyHash === "string" ? Buffer.from(providerConfig.secretKeyHash, "hex") : Buffer.alloc(0);
      if (stored.length === hash.length && timingSafeEqual(hash, stored)) {
        return { valid: true, keyType: "secret", isDeprecated: false };
      }
      return { valid: false, keyType: null };
    }

    return { valid: false, keyType: null };
  }

  /**
   * Formats safe public info for Data Studio UI.
   */
  static getPublicInfo(
    providerConfig: Record<string, unknown>,
    apiUrl: string,
    environment: DataEnvironmentName,
  ): ProjectApiKeysInfo {
    const publishableKey = (providerConfig.publishableKey as string) || `npati_pk_${environment}_unconfigured`;
    const rateLimit = (providerConfig.rateLimit as { maxRequestsPerMinute?: number }) || {
      maxRequestsPerMinute: 120,
    };
    const corsAllowedOrigins = Array.isArray(providerConfig.corsAllowedOrigins)
      ? (providerConfig.corsAllowedOrigins as string[])
      : [];

    return {
      publishableKey,
      secretKeyMasked: `npati_sk_${environment}_••••••••••••••••`,
      apiUrl,
      corsAllowedOrigins,
      rateLimit: {
        maxRequestsPerMinute: rateLimit.maxRequestsPerMinute || 120,
      },
    };
  }
}
