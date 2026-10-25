import { describe, expect, it } from "vitest";
import { ProjectApiKeyManager } from "../apps/agent-api/src/data-studio/api-key-manager";
import { ProjectApiRateLimiter } from "../apps/agent-api/src/data-studio/rate-limiter";
import { ProjectApiGatewayService } from "../apps/agent-api/src/data-studio/gateway-service";

describe("Project API gateway security", () => {
  it("separates keys by type and environment", () => {
    const devKey = ProjectApiKeyManager.generatePublishableKey("dev");
    const prodKey = ProjectApiKeyManager.generatePublishableKey("prod");
    const secretKey = ProjectApiKeyManager.generateSecretKey("dev");
    const config = { publishableKey: devKey, secretKeyHash: ProjectApiKeyManager.hashSecretKey(secretKey) };
    expect(ProjectApiKeyManager.validateKey(devKey, config, "dev").keyType).toBe("publishable");
    expect(ProjectApiKeyManager.validateKey(prodKey, config, "dev").valid).toBe(false);
    expect(ProjectApiKeyManager.validateKey(secretKey, config, "dev").keyType).toBe("secret");
    expect(ProjectApiKeyManager.validateKey(secretKey, config, "prod").valid).toBe(false);
  });

  it("requires an exact configured origin", () => {
    const gateway = new ProjectApiGatewayService({} as never, {} as never, {} as never);
    const allowed = ["https://shop.example.test"];
    expect(gateway.isOriginAllowed(allowed[0]!, allowed, "project-a")).toBe(true);
    expect(gateway.isOriginAllowed("https://shop.example.test.evil.test", allowed, "project-a")).toBe(false);
    expect(gateway.isOriginAllowed("https://preview-project-a.evil.test", allowed, "project-a")).toBe(false);
    expect(gateway.isOriginAllowed("http://localhost:9999", ["http://localhost:3000"], "project-a")).toBe(false);
    expect(gateway.isOriginAllowed("*", allowed, "project-a")).toBe(false);
  });

  it("does not impose a platform request allowance on keys or IPs", () => {
    const limiter = new ProjectApiRateLimiter();
    expect(limiter.check("key:a", 1).allowed).toBe(true);
    expect(limiter.check("key:a", 1).allowed).toBe(true);
    expect(limiter.check("key:b", 1).allowed).toBe(true);
    expect(limiter.check("ip:a", 1).allowed).toBe(true);
    expect(limiter.check("ip:a", 1).allowed).toBe(true);
  });

  it("binds runtime transaction context and filter values", async () => {
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        statements.push({ text, values });
        if (text.includes("information_schema.columns")) return { rows: [{ column_name: "id" }, { column_name: "name" }] };
        if (text.includes("count(*)")) return { rows: [{ total: "1" }] };
        if (text.startsWith("SELECT") && text.includes('FROM "products"')) return { rows: [{ id: "p1", name: "sample" }] };
        return { rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client };
    const repository = { getAccessPolicies: async () => [{ collection: "products", rule: "public", actions: ["select"] }] };
    const gateway = new ProjectApiGatewayService({} as never, repository as never, {} as never, undefined, undefined, async () => pool as never);
    const auth = { project: { id: "p", workspaceId: "w", companyId: "c", createdBy: "u" }, backend: { id: "b" }, environment: "dev", keyType: "publishable", userId: "", userRole: "anon", corsAllowedOrigins: [] };
    const malicious = "x' OR true --";
    const result = await gateway.listRows(auth as never, "products", { filter: { name: malicious } });
    expect(result.data).toHaveLength(1);
    expect(statements.map((entry) => entry.text)).toContain("BEGIN");
    expect(statements.map((entry) => entry.text)).toContain("COMMIT");
    expect(statements.find((entry) => entry.text.includes("npati.project_id"))?.values).toEqual(["p"]);
    expect(statements.find((entry) => entry.text.includes('FROM "products"'))?.values).toContain(malicious);
    expect(statements.some((entry) => entry.text.includes(malicious))).toBe(false);
  });
  it("denies unconfigured collection actions before querying runtime DB", async () => {
    const repository = { getAccessPolicies: async () => [] };
    const gateway = new ProjectApiGatewayService({} as never, repository as never, {} as never);
    const auth = { project: { id: "p", workspaceId: "w", companyId: "c", createdBy: "u" }, backend: { id: "b" }, environment: "dev", keyType: "publishable", userId: "", userRole: "anon", corsAllowedOrigins: [] };
    await expect(gateway.listRows(auth as never, "products")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(gateway.listRows(auth as never, "products;drop_table")).rejects.toMatchObject({ code: "INVALID_IDENTIFIER" });
  });
});
