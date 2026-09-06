import { describe, expect, it } from "vitest";
import { CryptoVault, defaultVault } from "@npati/workspace";
import { ApiKeysRepository } from "../apps/agent-api/src/api-keys-repository";
import { McpScopeGuard } from "../apps/agent-api/src/mcp-scopes";

describe("AES-256-GCM At Rest Encryption (CryptoVault)", () => {
  it("encrypts and decrypts strings correctly with authenticated integrity", () => {
    const vault = new CryptoVault("test-master-key-32-chars-long-12345");
    const secret = "sk-live-super-secret-api-key-123456789";
    const encrypted = vault.encrypt(secret);

    expect(encrypted).toMatch(/^v1\$[0-9a-f]+\$[0-9a-f]+\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(encrypted).not.toContain(secret);

    const decrypted = vault.decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it("produces unique ciphertexts and IVs for identical plaintexts", () => {
    const vault = new CryptoVault("test-key-32-chars-for-testing-123");
    const plaintext = "identical-secret-value";

    const enc1 = vault.encrypt(plaintext);
    const enc2 = vault.encrypt(plaintext);

    expect(enc1).not.toBe(enc2);
    expect(vault.decrypt(enc1)).toBe(plaintext);
    expect(vault.decrypt(enc2)).toBe(plaintext);
  });

  it("throws an error when ciphertext or authentication tag is tampered with", () => {
    const vault = new CryptoVault("test-key-32-chars-for-testing-123");
    const encrypted = vault.encrypt("sensitive-payload");

    const parts = encrypted.split("$");
    // Tamper with the ciphertext
    const tamperedCiphertext = parts[4].slice(0, -2) + (parts[4].endsWith("0") ? "1" : "0");
    const tampered = [parts[0], parts[1], parts[2], parts[3], tamperedCiphertext].join("$");

    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it("encrypts and decrypts complex JSON objects", () => {
    const vault = new CryptoVault("json-testing-key-32-characters-123");
    const payload = {
      provider: "anthropic",
      apiKey: "sk-ant-api03-123456789",
      webhookUrl: "https://example.com/webhook",
      allowedIps: ["127.0.0.1", "192.168.1.1"],
    };

    const encrypted = vault.encryptJson(payload);
    const decrypted = vault.decryptJson(encrypted);

    expect(decrypted).toEqual(payload);
  });
});

describe("API Key Authentication (ApiKeysRepository)", () => {
  it("creates, hashes, lists, and authenticates API keys with tenant scope", async () => {
    const repo = new ApiKeysRepository();
    const companyId = "company-sec-1";
    const tenantId = "tenant-sec-1";

    const created = await repo.createApiKey({
      companyId,
      tenantId,
      name: "CI/CD Integration Key",
      scopes: ["mcp:read", "mcp:execute"],
      expiresInDays: 30,
    });

    expect(created.rawToken).toMatch(/^npati_live_[0-9a-f]{48}$/);
    expect(created.keyPrefix).toBe(created.rawToken.slice(0, 16));
    expect(created.scopes).toEqual(["mcp:read", "mcp:execute"]);
    expect(created.expiresAt).toBeDefined();

    // Authenticate with valid raw token
    const authResult = await repo.authenticate(created.rawToken);
    expect(authResult.authenticated).toBe(true);
    expect(authResult.companyId).toBe(companyId);
    expect(authResult.tenantId).toBe(tenantId);
    expect(authResult.scopes).toEqual(["mcp:read", "mcp:execute"]);

    // List keys (should not leak raw token)
    const keys = await repo.listApiKeys(companyId, tenantId);
    expect(keys.length).toBe(1);
    expect(keys[0].id).toBe(created.id);
    expect(keys[0].name).toBe("CI/CD Integration Key");
    expect((keys[0] as any).rawToken).toBeUndefined();
    expect((keys[0] as any).keyHash).toBeUndefined();
  });

  it("revokes API keys and rejects subsequent authentication attempts", async () => {
    const repo = new ApiKeysRepository();
    const created = await repo.createApiKey({
      companyId: "company-revoke",
      tenantId: "tenant-revoke",
      name: "Temporary Worker Key",
    });

    // Authenticate before revoking
    const before = await repo.authenticate(created.rawToken);
    expect(before.authenticated).toBe(true);

    // Revoke
    const revoked = await repo.revokeApiKey(created.id, "company-revoke", "tenant-revoke");
    expect(revoked).toBe(true);

    // Authenticate after revoking
    const after = await repo.authenticate(created.rawToken);
    expect(after.authenticated).toBe(false);
    expect(after.error).toBe("API_KEY_REVOKED");
  });

  it("rejects invalid or malformed tokens", async () => {
    const repo = new ApiKeysRepository();
    const badToken = await repo.authenticate("invalid-token-string");
    expect(badToken.authenticated).toBe(false);
    expect(badToken.error).toBe("INVALID_TOKEN_FORMAT");

    const notFound = await repo.authenticate("npati_live_0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(notFound.authenticated).toBe(false);
    expect(notFound.error).toBe("API_KEY_NOT_FOUND");
  });
});

describe("MCP Authorization Scopes (McpScopeGuard)", () => {
  it("determines required scopes based on tool names and actions", () => {
    expect(McpScopeGuard.getRequiredScope("get_customer_info")).toBe("mcp:read");
    expect(McpScopeGuard.getRequiredScope("create_invoice")).toBe("mcp:write");
    expect(McpScopeGuard.getRequiredScope("delete_account")).toBe("mcp:admin");
    expect(McpScopeGuard.getRequiredScope("custom_action")).toBe("mcp:execute");
  });

  it("authorizes actions matching granted wildcard or specific scopes", () => {
    // Wildcard matches everything
    const authWildcard = McpScopeGuard.authorize({
      toolName: "delete_database",
      grantedScopes: ["*"],
    });
    expect(authWildcard.granted).toBe(true);

    // Specific match
    const authRead = McpScopeGuard.authorize({
      toolName: "list_repositories",
      grantedScopes: ["mcp:read"],
    });
    expect(authRead.granted).toBe(true);

    // Admin scope satisfies execute/write/read
    const authAdmin = McpScopeGuard.authorize({
      toolName: "update_profile",
      grantedScopes: ["mcp:admin"],
    });
    expect(authAdmin.granted).toBe(true);
  });

  it("denies unauthorized MCP execution and provides clear explanation", () => {
    const authDenied = McpScopeGuard.authorize({
      toolName: "delete_cluster",
      grantedScopes: ["mcp:read"],
    });

    expect(authDenied.granted).toBe(false);
    expect(authDenied.requiredScope).toBe("mcp:admin");
    expect(authDenied.reason).toContain("INSUFFICIENT_MCP_SCOPE");
  });
});
