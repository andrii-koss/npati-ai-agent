import { afterEach, describe, expect, it } from "vitest";
import { CryptoVault, assertProductionSecrets, insecureProductionSecrets, isInsecureDefaultSecret } from "@npati/workspace";
import { ScopedRemoteAccessTokenManager } from "../apps/agent-api/src/security-guardrails-and-tokens";

/**
 * Security audit 2026-11-24, C1: the compose file runs NODE_ENV=production with NPATI_ENV=development by default,
 * and the public compose secrets were refused only when NPATI_ENV=production. A forged remote access token for any
 * tenant was accepted. These tests pin the fail-closed behaviour for every "production" signal.
 */
const COMPOSE_DEFAULTS = [
  "npati-local-development-encryption-key-change-before-production",
  "npati-local-development-remote-token-key-change-before-production",
  "npati-local-runner-token-change-before-production",
  "npati-local-browser-worker-token-change-before-production",
  "npati-local-projects-db-change-before-production",
  "npati-local-internal-crawler-token",
  "npati-local-change-me",
  "npati-agent-internal-local",
  "npati-development-only-remote-token-key",
];
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

function productionLike(variant: "node" | "npati") {
  if (variant === "node") { process.env.NODE_ENV = "production"; process.env.NPATI_ENV = "development"; }
  else { process.env.NODE_ENV = "test"; process.env.NPATI_ENV = "production"; }
}

describe("C1: publicly known secrets are refused in production", () => {
  it.each(COMPOSE_DEFAULTS)("recognises the shipped default %s", (value) => {
    expect(isInsecureDefaultSecret(value)).toBe(true);
  });

  it("does not flag a random secret", () => {
    expect(isInsecureDefaultSecret("3f9c1d2e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d")).toBe(false);
  });

  it.each(["node", "npati"] as const)("remote token manager refuses the compose default (%s production signal)", (variant) => {
    productionLike(variant);
    expect(() => new ScopedRemoteAccessTokenManager(COMPOSE_DEFAULTS[1])).toThrow("NPATI_REMOTE_ACCESS_TOKEN_SECRET_UNSAFE_DEFAULT");
    delete process.env.NPATI_REMOTE_ACCESS_TOKEN_SECRET;
    process.env.NPATI_ENCRYPTION_KEY = COMPOSE_DEFAULTS[0];
    expect(() => new ScopedRemoteAccessTokenManager()).toThrow("NPATI_REMOTE_ACCESS_TOKEN_SECRET_UNSAFE_DEFAULT");
  });

  it("a token forged with the public default is not accepted by a correctly configured server", () => {
    const forged = new ScopedRemoteAccessTokenManager(COMPOSE_DEFAULTS[1]).mintRemoteToken({
      tenantId: "workspace:synthetic-victim", companyId: "synthetic-company", userId: "synthetic-user", scopes: ["*"],
    }).token;
    productionLike("node");
    const server = new ScopedRemoteAccessTokenManager("a".repeat(16) + "9f8e7d6c5b4a39281706f5e4d3c2b1a0");
    expect(server.verifyRemoteToken(forged).isValid).toBe(false);
  });

  it.each(["node", "npati"] as const)("CryptoVault refuses the compose default (%s production signal)", (variant) => {
    productionLike(variant);
    expect(() => new CryptoVault(COMPOSE_DEFAULTS[0])).toThrow("NPATI_ENCRYPTION_KEY_UNSAFE_DEFAULT");
  });

  it("startup gate lists every unsafe secret by name, never by value", () => {
    process.env = { NODE_ENV: "production", NPATI_ENV: "development",
      NPATI_ENCRYPTION_KEY: COMPOSE_DEFAULTS[0], NPATI_SANDBOX_RUNNER_SECRET: COMPOSE_DEFAULTS[2],
      OMNIROUTE_API_KEY: COMPOSE_DEFAULTS[7], DATABASE_URL: "postgresql://npati:npati@postgres:5432/npati_agent" };
    const problems = insecureProductionSecrets();
    expect(problems.map((p) => p.split(":")[0])).toEqual(expect.arrayContaining(["NPATI_ENCRYPTION_KEY", "NPATI_SANDBOX_RUNNER_SECRET", "OMNIROUTE_API_KEY", "DATABASE_URL"]));
    expect(() => assertProductionSecrets()).toThrow("NPATI_INSECURE_SECRETS");
    for (const value of COMPOSE_DEFAULTS) expect(problems.join(" ")).not.toContain(value);
  });

  it("startup gate requires an encryption key in production and accepts strong secrets", () => {
    process.env = { NODE_ENV: "production" };
    expect(insecureProductionSecrets()).toEqual(["NPATI_ENCRYPTION_KEY: required in production"]);
    process.env.NPATI_ENCRYPTION_KEY = "f".repeat(8) + "0123456789abcdef0123456789abcdef";
    process.env.DATABASE_URL = "postgresql://npati:7c1e9b0d4a2f6e8c3b5d7a9f1e0c2b4d@postgres:5432/x";
    expect(() => assertProductionSecrets()).not.toThrow();
  });

  it("startup gate is inactive outside production", () => {
    process.env = { NODE_ENV: "test", NPATI_ENCRYPTION_KEY: COMPOSE_DEFAULTS[0] };
    expect(insecureProductionSecrets()).toEqual([]);
  });
});

describe("C1 migration: decrypt-only previous key", () => {
  const oldKey = COMPOSE_DEFAULTS[0];
  const newKey = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978";
  it("reads data written with the retired key and writes with the new one", () => {
    process.env.NODE_ENV = "test";
    const legacy = new CryptoVault(oldKey).encrypt("synthetic secret");
    process.env.NPATI_ENCRYPTION_KEY = newKey;
    process.env.NPATI_ENCRYPTION_KEY_PREVIOUS = oldKey;
    const vault = new CryptoVault();
    expect(vault.decryptWithKeyInfo(legacy)).toEqual({ plaintext: "synthetic secret", usedPreviousKey: true });
    const fresh = vault.encrypt("synthetic secret");
    expect(vault.decryptWithKeyInfo(fresh).usedPreviousKey).toBe(false);
    expect(() => new CryptoVault(oldKey).decrypt(fresh)).toThrow();
  });
});

describe("L4: remote token with an unparsable expiry is expired", () => {
  it("refuses expiresAt that is not a date", () => {
    process.env.NODE_ENV = "test";
    const key = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
    const manager = new ScopedRemoteAccessTokenManager(key);
    const { token } = manager.mintRemoteToken({ tenantId: "t", companyId: "c", userId: "u", scopes: ["chat:use"] });
    const [id, body] = token.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    payload.expiresAt = "never";
    const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const sig = createHmac("sha256", key).update(forgedBody).digest("base64url");
    expect(manager.verifyRemoteToken(`${id}.${forgedBody}.${sig}`).isValid).toBe(false);
  });
});
