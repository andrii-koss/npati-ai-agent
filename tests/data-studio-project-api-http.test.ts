import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectApiGatewayService } from "../apps/agent-api/src/data-studio/gateway-service";
import { registerProjectApiGatewayRoutes } from "../apps/agent-api/src/data-studio/gateway-routes";
import { ProjectApiKeyManager } from "../apps/agent-api/src/data-studio/api-key-manager";
import { isForbiddenSandboxVariable, PROJECT_API_SANDBOX_VARIABLES } from "../apps/agent-api/src/project-sandbox-service";
import { sandboxAllowedHostsWithProjectApi } from "../apps/agent-api/src/docker-sandbox-provider";

type Env = "dev" | "prod";
interface Statement { text: string; values?: unknown[]; backend: string; env: Env }

const ORIGIN_A = "https://shop-a.example.test";
const ORIGIN_B = "https://shop-b.example.test";
const USER_TOKEN = "user-access-token-a";

function keySet(env: Env) {
  const publishableKey = ProjectApiKeyManager.generatePublishableKey(env);
  const secretKey = ProjectApiKeyManager.generateSecretKey(env);
  return { publishableKey, secretKey };
}

function harness() {
  const keys = {
    "bA:dev": keySet("dev"), "bA:prod": keySet("prod"),
    "bB:dev": keySet("dev"), "bB:prod": keySet("prod"),
  } as Record<string, { publishableKey: string; secretKey: string }>;
  const cors: Record<string, Record<string, string[]>> = {
    bA: { pA: [ORIGIN_A] },
    bB: { pB: [ORIGIN_B] },
  };
  const rateLimits: Record<string, number> = {};
  const projects = new Map<string, Record<string, unknown>>([
    ["pA", { id: "pA", workspaceId: "w1", companyId: "c1", createdBy: "u1", dataBackendId: "bA", status: "active" }],
    ["pB", { id: "pB", workspaceId: "w2", companyId: "c2", createdBy: "u2", dataBackendId: "bB", status: "active" }],
  ]);
  const statements: Statement[] = [];
  const store = {
    projects,
    async getProject(_ctx: unknown, companyId: string, projectId: string) {
      const project = projects.get(projectId);
      if (!project || project.companyId !== companyId) throw new Error("not found");
      return project;
    },
  };
  const repository = {
    async get(_ctx: unknown, _companyId: string, id: string) { return { id, status: "ready" }; },
    async environment(_ctx: unknown, _companyId: string, backendId: string, env: Env) {
      const k = keys[`${backendId}:${env}`]!;
      return {
        status: "ready",
        providerConfig: {
          publishableKey: k.publishableKey,
          secretKeyHash: ProjectApiKeyManager.hashSecretKey(k.secretKey),
          encryptedSecretKey: "encrypted",
          corsOriginsByProject: cors[backendId],
          rateLimit: { maxRequestsPerMinute: rateLimits[`${backendId}:${env}`] ?? 1000 },
        },
      };
    },
    async setEnvironment() { /* keys are pre-provisioned */ },
    async getAccessPolicies() {
      return [
        { collection: "products", rule: "public", actions: ["select"] },
        { collection: "orders", rule: "owner", actions: ["all"] },
      ];
    },
  };
  const columns: Record<string, string[]> = { products: ["id", "name", "price"], orders: ["id", "owner_id", "total"] };
  const poolFactory = async (backend: { id: string }, env: Env) => ({
    connect: async () => ({
      async query(text: string, values?: unknown[]) {
        statements.push({ text, values, backend: backend.id, env });
        if (text.includes("information_schema.columns")) return { rows: (columns[String(values?.[0])] ?? []).map((column_name) => ({ column_name })) };
        if (text.includes("count(*)")) return { rows: [{ total: "1" }] };
        if (text.startsWith("SELECT") && text.includes('FROM "products"')) return { rows: [{ id: "p1", name: "Sample", price: 10 }], rowCount: 1 };
        if (text.startsWith("INSERT")) return { rows: [{ id: "o1", owner_id: "end-user-1", total: 5 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() { /* pooled */ },
    }),
  });
  const authService = {
    async me(_ctx: unknown, _companyId: string, projectId: string, _env: Env, token: string) {
      if (token === USER_TOKEN && projectId === "pA") return { id: "end-user-1", email: "client@example.test", roles: ["authenticated"] };
      throw new Error("invalid token");
    },
  };
  const workspaceFiles = new Map<string, string>();
  const workspace = {
    async readFile(_ctx: unknown, _companyId: string, _projectId: string, filePath: string) {
      const content = workspaceFiles.get(filePath);
      if (content === undefined) throw new Error("not found");
      return { path: filePath, content, revision: "rev-1" };
    },
    async createFile(_ctx: unknown, _companyId: string, _projectId: string, filePath: string, content: string) {
      workspaceFiles.set(filePath, content);
      return { path: filePath, content, revision: "rev-1" };
    },
    async writeFile(_ctx: unknown, _companyId: string, _projectId: string, filePath: string, content: string) {
      workspaceFiles.set(filePath, content);
      return { path: filePath, content, revision: "rev-1" };
    },
  };
  const gateway = new ProjectApiGatewayService(store as never, repository as never, {} as never, authService as never, undefined, poolFactory as never, workspace as never);
  return { gateway, keys, statements, rateLimits, authService, workspaceFiles };
}

describe("Project API gateway over HTTP (D5)", () => {
  let app: FastifyInstance;
  let h: ReturnType<typeof harness>;

  beforeEach(async () => {
    h = harness();
    app = Fastify();
    registerProjectApiGatewayRoutes(app, h.gateway, h.authService as never);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const pk = (k = "bA:dev") => h.keys[k]!.publishableKey;
  const sk = (k = "bA:dev") => h.keys[k]!.secretKey;

  it("lists public collection rows with the publishable key and runs inside a runtime transaction", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/projects/pA/data/products", headers: { "x-project-key": pk() } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    const texts = h.statements.map((s) => s.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts).toContain("COMMIT");
    for (const s of h.statements.filter((entry) => entry.text.includes("set_config"))) {
      expect(s.text).toMatch(/set_config\('[a-z_.]+', \$1, true\)/);
      expect(s.values).toHaveLength(1);
    }
    expect(texts.some((t) => /SET ROLE|BYPASSRLS|RESET ROLE/i.test(t))).toBe(false);
  });

  it("denies owner collections to anonymous visitors and binds the end-user id for authenticated writes", async () => {
    const anon = await app.inject({ method: "POST", url: "/v1/projects/pA/data/orders", headers: { "x-project-key": pk() }, payload: { total: 5 } });
    expect(anon.statusCode).toBe(403);
    expect(anon.json().error.code).toBe("POLICY_DENIED");

    const authed = await app.inject({ method: "POST", url: "/v1/projects/pA/data/orders", headers: { "x-project-key": pk(), authorization: `Bearer ${USER_TOKEN}` }, payload: { total: 5 } });
    expect(authed.statusCode).toBe(201);
    const userClaim = h.statements.find((s) => s.text.includes("'npati.auth.user_id'"));
    expect(userClaim?.values).toEqual(["end-user-1"]);
  });

  it("uses a unified error envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/projects/pA/data/products" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "MISSING_API_KEY", message: expect.any(String), status: 401 } });
  });

  it("accepts the secret key only server-side and never bypasses RLS", async () => {
    const browser = await app.inject({ method: "GET", url: "/v1/projects/pA/data/products", headers: { "x-project-key": sk(), origin: ORIGIN_A } });
    expect(browser.statusCode).toBe(403);
    expect(browser.json().error.code).toBe("SECRET_KEY_IN_BROWSER");

    const server = await app.inject({ method: "GET", url: "/v1/projects/pA/data/products", headers: { "x-project-key": sk() } });
    expect(server.statusCode).toBe(200);
    const role = h.statements.find((s) => s.text.includes("'npati.auth.user_role'"));
    expect(role?.values).toEqual(["service_role"]);
    expect(h.statements.some((s) => /SET ROLE|BYPASSRLS/i.test(s.text))).toBe(false);
  });

  it("rejects foreign origins and echoes only allowed ones", async () => {
    const foreign = await app.inject({ method: "GET", url: "/v1/projects/pA/data/products", headers: { "x-project-key": pk(), origin: "https://evil.example.test" } });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();

    const allowed = await app.inject({ method: "GET", url: "/v1/projects/pA/data/products", headers: { "x-project-key": pk(), origin: ORIGIN_A } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe(ORIGIN_A);

    const preflight = await app.inject({ method: "OPTIONS", url: "/v1/projects/pA/data/products", headers: { origin: "https://evil.example.test" } });
    expect(preflight.statusCode).toBe(403);
  });

  it("does not allow Project A's origin on another DataBackend", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/projects/pB/data/products", headers: { "x-project-key": pk("bB:dev"), origin: ORIGIN_A } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CORS_ORIGIN_NOT_ALLOWED");
  });

  it("does not accept DataBackend A keys on DataBackend B or dev keys on prod", async () => {
    const crossBackend = await app.inject({ method: "GET", url: "/v1/projects/pB/data/products", headers: { "x-project-key": pk("bA:dev") } });
    expect(crossBackend.statusCode).toBe(401);
    const crossSecret = await app.inject({ method: "GET", url: "/v1/projects/pB/data/products", headers: { "x-project-key": sk("bA:dev") } });
    expect(crossSecret.statusCode).toBe(401);

    const devAsProd = pk("bA:dev").replace("npati_pk_dev_", "npati_pk_prod_");
    const prod = await app.inject({ method: "GET", url: "/v1/projects/pA/data/products", headers: { "x-project-key": devAsProd } });
    expect(prod.statusCode).toBe(401);
    expect(h.statements.some((s) => s.env === "prod" || s.backend === "bB")).toBe(false);
  });

  it("returns 429 once the per-key rate limit is exceeded", async () => {
    h.rateLimits["bA:dev"] = 2;
    const send = () => app.inject({ method: "GET", url: "/v1/projects/pA/data/products", headers: { "x-project-key": pk() } });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("rejects SQL injection through sort, fields, filters and collection names", async () => {
    const headers = { "x-project-key": pk() };
    const attempts = [
      "/v1/projects/pA/data/products?sort=" + encodeURIComponent("name; DROP TABLE products --"),
      "/v1/projects/pA/data/products?fields=" + encodeURIComponent("id,(select password_hash from _npati_auth_users)"),
      "/v1/projects/pA/data/products?filter=" + encodeURIComponent(JSON.stringify({ "name\" OR 1=1 --": "x" })),
      "/v1/projects/pA/data/" + encodeURIComponent("products;drop"),
      "/v1/projects/pA/data/products?filter=not-json",
      "/v1/projects/pA/data/products?fields=password_hash",
    ];
    for (const url of attempts) {
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url).toBeLessThan(500);
    }
    const malicious = "x' OR '1'='1";
    const ok = await app.inject({ method: "GET", url: "/v1/projects/pA/data/products?filter[name]=" + encodeURIComponent(malicious), headers });
    expect(ok.statusCode).toBe(200);
    expect(h.statements.some((s) => s.text.includes(malicious))).toBe(false);
    expect(h.statements.some((s) => s.values?.includes(malicious))).toBe(true);
  });

  it("requires a Project API key for OpenAPI, types and docs", async () => {
    for (const path of ["openapi.json", "types.ts", "docs"]) {
      const res = await app.inject({ method: "GET", url: `/v1/projects/pA/${path}` });
      expect(res.statusCode, path).toBe(401);
    }
  });

  it("logs method, path, status and duration without keys, tokens or query strings", async () => {
    await app.inject({ method: "GET", url: `/v1/projects/pA/data/products?filter[name]=secret-value`, headers: { "x-project-key": pk(), authorization: `Bearer ${USER_TOKEN}` } });
    await app.inject({ method: "GET", url: "/v1/projects/pA/data/products", headers: { "x-project-key": sk() } });
    const logs = await h.gateway.getLogs("pA", "dev");
    expect(logs.length).toBe(2);
    expect(logs[0]).toMatchObject({ method: "GET", path: "/v1/projects/pA/data/products", statusCode: 200 });
    const serialized = JSON.stringify(logs);
    for (const leaked of [pk(), sk(), USER_TOKEN, "secret-value"]) expect(serialized).not.toContain(leaked);
  });
});

describe("Website Builder sandbox integration (D5)", () => {
  it("exposes only PROJECT_API_URL and PROJECT_PUBLISHABLE_KEY to the sandbox", async () => {
    const h = harness();
    const previous = process.env.NPATI_PROJECT_API_PUBLIC_URL;
    process.env.NPATI_PROJECT_API_PUBLIC_URL = "https://api.npati.example.test";
    try {
      const env = await h.gateway.getSandboxEnvironment({ workspaceId: "w1", userId: "u1", permissions: ["*"] }, "c1", "pA");
      expect(Object.keys(env).sort()).toEqual([...PROJECT_API_SANDBOX_VARIABLES].sort());
      expect(env.PROJECT_API_URL).toBe("https://api.npati.example.test/v1/projects/pA");
      expect(env.PROJECT_PUBLISHABLE_KEY).toBe(h.keys["bA:dev"]!.publishableKey);
      expect(JSON.stringify(env)).not.toContain(h.keys["bA:dev"]!.secretKey);
      // The SDK is vendored into the Project workspace so the sandbox can import it locally.
      expect(h.workspaceFiles.get("npati-client.ts")).toContain("export function createProjectClient");
      await expect(h.gateway.getSandboxEnvironment({ workspaceId: "w1", userId: "u1", permissions: ["*"] }, "c1", "pB")).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NPATI_PROJECT_API_PUBLIC_URL; else process.env.NPATI_PROJECT_API_PUBLIC_URL = previous;
    }
  });

  it("strips secret key and database credentials from sandbox environment", () => {
    for (const name of ["PROJECT_SECRET_KEY", "DATABASE_URL", "PGPASSWORD", "PGHOST", "POSTGRES_PASSWORD", "NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD", "SHOP_DB_PASSWORD"]) {
      expect(isForbiddenSandboxVariable(name), name).toBe(true);
    }
    for (const name of ["PROJECT_API_URL", "PROJECT_PUBLISHABLE_KEY", "STRIPE_PUBLIC_KEY"]) {
      expect(isForbiddenSandboxVariable(name), name).toBe(false);
    }
  });

  it("adds only the Project API host to the sandbox egress allowlist", () => {
    expect(sandboxAllowedHostsWithProjectApi("registry.npmjs.org", "https://api.npati.example.test/base")).toBe("registry.npmjs.org,api.npati.example.test");
    expect(sandboxAllowedHostsWithProjectApi("registry.npmjs.org", "postgres://postgres-projects:5432/db")).toBe("registry.npmjs.org");
    expect(sandboxAllowedHostsWithProjectApi("registry.npmjs.org", "http://postgres-projects:8080")).toBe("registry.npmjs.org");
    expect(sandboxAllowedHostsWithProjectApi("registry.npmjs.org", undefined)).toBe("registry.npmjs.org");
  });
});
