import { describe, expect, it } from "vitest";
import {
  CloudAgentProviderManager,
  OAuthSubscriptionAuthManager,
  NativeCodexRuntime,
} from "../apps/agent-api/src/cloud-agents-and-codex";

describe("Cloud Agent Provider Manager (CloudAgentProviderManager)", () => {
  it("provisions, queries, and terminates remote cloud developer environments", () => {
    const manager = new CloudAgentProviderManager();
    const companyId = "comp-cloud-1";

    const env = manager.createRemoteEnvironment({
      companyId,
      provider: "e2b",
      cpu: 4,
      ramMb: 8192,
      ttlSeconds: 1800,
    });

    expect(env.envId).toMatch(/^cenv_/);
    expect(env.status).toBe("ready");
    expect(env.specs.cpu).toBe(4);
    expect(env.connectionUrl).toContain("cloud.e2b.internal");

    const fetched = manager.getEnvironment(env.envId);
    expect(fetched?.envId).toBe(env.envId);

    const terminated = manager.terminateEnvironment(env.envId);
    expect(terminated).toBe(true);
    expect(manager.getEnvironment(env.envId)?.status).toBe("terminated");
  });
});

describe("OAuth Subscription Auth Manager (OAuthSubscriptionAuthManager)", () => {
  it("registers and retrieves valid subscription tokens, rejecting expired ones", () => {
    const manager = new OAuthSubscriptionAuthManager();
    const companyId = "comp-oauth-sub";

    // Valid token
    manager.registerSubscriptionToken({
      companyId,
      provider: "github_copilot",
      accessToken: "gho_valid_123",
      tier: "enterprise",
      ttlSeconds: 3600,
    });

    const validToken = manager.getValidToken(companyId, "github_copilot");
    expect(validToken).not.toBeNull();
    expect(validToken?.accessToken).toBe("gho_valid_123");
    expect(validToken?.tier).toBe("enterprise");

    // Expired token
    manager.registerSubscriptionToken({
      companyId,
      provider: "chatgpt_team",
      accessToken: "sess_expired_999",
      tier: "team",
      ttlSeconds: -10, // Expired
    });

    const expiredToken = manager.getValidToken(companyId, "chatgpt_team");
    expect(expiredToken).toBeNull();
  });
});

describe("Native Codex Runtime (NativeCodexRuntime)", () => {
  it("generates unified diff patches and performs syntax verification", () => {
    const result = NativeCodexRuntime.generateCodePatch({
      sourceCode: 'const greeting = "Hello World";',
      instruction: "Add Ukrainian translation",
      replacementCode: 'const greeting = "Привіт Світ!";',
      language: "typescript",
      filename: "greeting.ts",
    });

    expect(result.patchId).toMatch(/^patch_/);
    expect(result.diff).toContain("--- a/greeting.ts");
    expect(result.diff).toContain("+++ b/greeting.ts");
    expect(result.modifiedCode).toBe('const greeting = "Привіт Світ!";');
    expect(result.syntaxValid).toBe(true);
  });
});
