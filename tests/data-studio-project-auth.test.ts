import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import {
  ProjectPasswordHasher,
  ProjectKeyManager,
  OpaqueTokenManager,
  AuthRateLimiter,
} from "../apps/agent-api/src/data-studio/auth-crypto";
import {
  UnconfiguredEmailProvider,
  MockEmailProvider,
} from "../apps/agent-api/src/data-studio/email-provider";
import { RlsPolicyCompiler } from "../apps/agent-api/src/data-studio/rls-compiler";
import { ProjectAuthService } from "../apps/agent-api/src/data-studio/auth-service";
import { registerProjectAuthRoutes } from "../apps/agent-api/src/data-studio/auth-routes";
import { AgentDataStudioService } from "../apps/agent-api/src/data-studio/agent-data-service";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";
import type { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import type { DatabaseProvisioner } from "../apps/agent-api/src/data-studio/provisioner";
import type { DataBackend, DataBackendEnvironment, DataEnvironmentName } from "../apps/agent-api/src/data-studio/types";
import type { ProjectAccessPolicy, ProjectAuthSettings } from "@npati/shared";

describe("NPATI Data Studio D4: Project Auth & Access Control", () => {
  async function createHarness() {
    const store = new InMemoryWorkspaceStore();
    const ownerA: AuthContext = {
      workspaceId: "tenant-a",
      userId: "user-a",
      permissions: ["workspace:read", "business:manage"],
    };
    const ownerB: AuthContext = {
      workspaceId: "tenant-b",
      userId: "user-b",
      permissions: ["workspace:read", "business:manage"],
    };

    (store as any).companies.set("company-a", {
      id: "company-a",
      workspaceId: "tenant-a",
      userId: "user-a",
      name: "Company A",
      status: "active",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    (store as any).companies.set("company-b", {
      id: "company-b",
      workspaceId: "tenant-b",
      userId: "user-b",
      name: "Company B",
      status: "active",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const mockBackendA: DataBackend = {
      id: "backend-a",
      workspaceId: "tenant-a",
      companyId: "company-a",
      name: "Store DB",
      provider: "shared_postgres",
      status: "ready",
      createdBy: "user-a",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockBackendB: DataBackend = {
      id: "backend-b",
      workspaceId: "tenant-b",
      companyId: "company-b",
      name: "Other DB",
      provider: "shared_postgres",
      status: "ready",
      createdBy: "user-b",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockEnvA: DataBackendEnvironment = {
      id: "env-a",
      workspaceId: "tenant-a",
      companyId: "company-a",
      backendId: "backend-a",
      environment: "dev" as DataEnvironmentName,
      status: "ready",
      schemaFingerprint: "fp-a",
      expectedSchema: null as any,
      syncStatus: "synced",
      providerConfig: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockEnvB: DataBackendEnvironment = {
      id: "env-b",
      workspaceId: "tenant-b",
      companyId: "company-b",
      backendId: "backend-b",
      environment: "dev" as DataEnvironmentName,
      status: "ready",
      schemaFingerprint: "fp-b",
      expectedSchema: null as any,
      syncStatus: "synced",
      providerConfig: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const inMemoryPolicies: Record<string, ProjectAccessPolicy[]> = {};
    const inMemorySigningKeys: Record<string, any> = {};

    const repository: DataBackendRepository = {
      list: async (_ctx: AuthContext, companyId: string) => {
        if (companyId === "company-a") return [mockBackendA];
        if (companyId === "company-b") return [mockBackendB];
        return [];
      },
      get: async (_ctx: AuthContext, companyId: string, backendId: string) => {
        if (companyId === "company-a" && backendId === "backend-a") return mockBackendA;
        if (companyId === "company-b" && backendId === "backend-b") return mockBackendB;
        throw new Error("Backend not found");
      },
      create: async () => mockBackendA,
      update: async () => mockBackendA,
      archive: async () => {},
      environments: async (_ctx: AuthContext, _companyId: string, backendId: string) => {
        if (backendId === "backend-a") return [mockEnvA];
        if (backendId === "backend-b") return [mockEnvB];
        return [];
      },
      environment: async (_ctx: AuthContext, _companyId: string, backendId: string, env: DataEnvironmentName) => {
        if (backendId === "backend-a" && env === "dev") return mockEnvA;
        if (backendId === "backend-b" && env === "dev") return mockEnvB;
        throw new Error("Environment not found");
      },
      setEnvironment: async (_ctx: AuthContext, _companyId: string, backendId: string, env: DataEnvironmentName, patch: Partial<DataBackendEnvironment>) => {
        const target = backendId === "backend-a" ? mockEnvA : mockEnvB;
        if (patch.providerConfig) target.providerConfig = patch.providerConfig;
      },
      getAccessPolicies: async (_ctx: AuthContext, _companyId: string, backendId: string, collection?: string) => {
        const key = `${backendId}:${collection}`;
        return inMemoryPolicies[key] ?? [];
      },
      setCollectionAccessPolicies: async (_ctx: AuthContext, _companyId: string, backendId: string, collection: string, policies: ProjectAccessPolicy[]) => {
        const key = `${backendId}:${collection}`;
        inMemoryPolicies[key] = policies;
      },
      deleteAccessPolicies: async (_ctx: AuthContext, _companyId: string, backendId: string, collection: string) => {
        const key = `${backendId}:${collection}`;
        delete inMemoryPolicies[key];
      },
      getSigningKeys: async (_ctx: AuthContext, _companyId: string, backendId: string, env: DataEnvironmentName) => {
        const key = `${backendId}:${env}`;
        return inMemorySigningKeys[key] ?? null;
      },
      saveSigningKeys: async (_ctx: AuthContext, _companyId: string, backendId: string, env: DataEnvironmentName, keys: any) => {
        const key = `${backendId}:${env}`;
        inMemorySigningKeys[key] = keys;
      },
    } as any;

    const dbTables: {
      users: any[];
      refresh_tokens: any[];
      verification_tokens: any[];
      reset_tokens: any[];
      roles: any[];
      user_roles: any[];
      orders: any[];
      posts: any[];
    } = {
      users: [],
      refresh_tokens: [],
      verification_tokens: [],
      reset_tokens: [],
      roles: [
        { id: "r1", name: "admin" },
        { id: "r2", name: "member" },
        { id: "r3", name: "user" },
      ],
      user_roles: [],
      orders: [],
      posts: [],
    };

    const executedSqlLog: string[] = [];

    const mockPool = {
      connect: async () => ({
        query: mockPool.query,
        release: () => {},
      }),
      query: async (queryText: string, params: any[] = []) => {
        executedSqlLog.push(queryText);
        const text = queryText.toLowerCase().trim();
        const run = (): { rows?: any[]; rowCount?: number } => {
          // Count queries for rate limiting
          if (text.includes("count(*)") && text.includes("_npati_auth_refresh_tokens")) {
            return { rows: [{ count: "0" }] };
          }

        // Users queries
        if (text.includes("from _npati_auth_users") && text.includes("where email =")) {
          const email = params[0]?.toLowerCase();
          const user = dbTables.users.find((u) => u.email === email);
          return { rows: user ? [user] : [] };
        }
        if (text.includes("select") && text.includes("from _npati_auth_users") && text.includes("where id =")) {
          const id = params[0];
          const user = dbTables.users.find((u) => u.id === id);
          return { rows: user ? [user] : [] };
        }
        if (text.includes("insert into _npati_auth_users")) {
          const newUser = {
            id: "user-" + Math.random().toString(36).substring(2, 9),
            email: params[0],
            password_hash: params[1],
            email_verified: params[2],
            status: params[3],
            metadata: JSON.parse(params[4] ?? "{}"),
            created_at: new Date().toISOString(),
            last_login: null,
          };
          dbTables.users.push(newUser);
          return { rows: [newUser] };
        }
        if (text.includes("update _npati_auth_users set last_login =")) {
          const user = dbTables.users.find((u) => u.id === params[1]);
          if (user) user.last_login = params[0];
          return { rows: user ? [user] : [] };
        }
        if (text.includes("update _npati_auth_users set email_verified = true")) {
          const user = dbTables.users.find((u) => u.id === params[0]);
          if (user) {
            user.email_verified = true;
            user.status = "active";
          }
          return { rows: user ? [user] : [] };
        }
        if (text.includes("update _npati_auth_users set password_hash =")) {
          const user = dbTables.users.find((u) => u.id === params[1]);
          if (user) user.password_hash = params[0];
          return { rows: user ? [user] : [] };
        }
        if (text.includes("update _npati_auth_users set status =")) {
          const user = dbTables.users.find((u) => u.id === params[1]);
          if (user) user.status = params[0];
          return { rows: user ? [user] : [] };
        }
        if (text.includes("from _npati_auth_users u") || text.includes("select u.id, u.email") || text.includes("select u.* from _npati_auth_users") || text.includes("select id, email, email_verified, status")) {
          const rows = dbTables.users.map((u) => ({
            ...u,
            roles: ["user"],
          }));
          return { rows };
        }
        if (text.includes("count(*)") && text.includes("from _npati_auth_users")) {
          return { rows: [{ count: String(dbTables.users.length) }] };
        }
        if (text.includes("delete from _npati_auth_users where id =")) {
          const idx = dbTables.users.findIndex((u) => u.id === params[0]);
          if (idx !== -1) dbTables.users.splice(idx, 1);
          return { rowCount: 1 };
        }

        // Roles queries
        if (text.includes("from _npati_auth_roles where name =")) {
          const role = dbTables.roles.find((r) => r.name === params[0]);
          return { rows: role ? [role] : [] };
        }
        if (text.includes("insert into _npati_auth_user_roles")) {
          dbTables.user_roles.push({ user_id: params[0], role_id: params[1], role: params[2] ?? "user" });
          return { rows: [] };
        }
        if (text.includes("from _npati_auth_user_roles") || text.includes("from _npati_auth_roles r join _npati_auth_user_roles ur")) {
          const userId = params[0];
          const userRoleObjs = dbTables.user_roles.filter((ur) => ur.user_id === userId);
          const roles = userRoleObjs.length ? userRoleObjs.map((ur) => ({ role: ur.role ?? "user" })) : [{ role: "user" }];
          return { rows: roles };
        }
        if (text.includes("delete from _npati_auth_user_roles where user_id =")) {
          dbTables.user_roles = dbTables.user_roles.filter((ur) => ur.user_id !== params[0]);
          return { rowCount: 1 };
        }

        // Refresh Tokens queries
        if (text.includes("insert into _npati_auth_refresh_tokens")) {
          const tok = {
            id: "tok-" + Math.random().toString(36).substring(2, 9),
            token_hash: params[0],
            family_id: params[1],
            user_id: params[2],
            expires_at: params[3],
            rotated_at: null,
            revoked_at: null,
          };
          dbTables.refresh_tokens.push(tok);
          return { rows: [tok] };
        }
        if (text.includes("from _npati_auth_refresh_tokens where token_hash =")) {
          const tok = dbTables.refresh_tokens.find((t) => t.token_hash === params[0]);
          return { rows: tok ? [tok] : [] };
        }
        if (text.includes("update _npati_auth_refresh_tokens set rotated_at = now()")) {
          const tok = dbTables.refresh_tokens.find((t) => t.id === params[0]);
          if (tok) tok.rotated_at = new Date().toISOString();
          return { rows: [] };
        }
        if (text.includes("update _npati_auth_refresh_tokens set revoked_at = now() where family_id =")) {
          for (const t of dbTables.refresh_tokens) {
            if (t.family_id === params[0]) t.revoked_at = new Date().toISOString();
          }
          return { rows: [] };
        }
        if (text.includes("update _npati_auth_refresh_tokens set revoked_at = now() where user_id =")) {
          for (const t of dbTables.refresh_tokens) {
            if (t.user_id === params[0]) t.revoked_at = new Date().toISOString();
          }
          return { rows: [] };
        }

        // Verification Tokens
        if (text.includes("insert into _npati_auth_verification_tokens")) {
          const tok = {
            id: "vtok-" + Math.random().toString(36).substring(2, 9),
            token_hash: params[0],
            user_id: params[1],
            expires_at: params[2],
            used_at: null,
          };
          dbTables.verification_tokens.push(tok);
          return { rows: [tok] };
        }
        if (text.includes("from _npati_auth_verification_tokens where token_hash =")) {
          const tok = dbTables.verification_tokens.find((t) => t.token_hash === params[0]);
          return { rows: tok ? [tok] : [] };
        }
        if (text.includes("update _npati_auth_verification_tokens set used_at = now()")) {
          const tok = dbTables.verification_tokens.find((t) => t.id === params[0]);
          if (tok) tok.used_at = new Date().toISOString();
          return { rows: [] };
        }

        // Reset Tokens
        if (text.includes("insert into _npati_auth_reset_tokens")) {
          const tok = {
            id: "rtok-" + Math.random().toString(36).substring(2, 9),
            token_hash: params[0],
            user_id: params[1],
            expires_at: params[2],
            used_at: null,
          };
          dbTables.reset_tokens.push(tok);
          return { rows: [tok] };
        }
        if (text.includes("from _npati_auth_reset_tokens where token_hash =")) {
          const tok = dbTables.reset_tokens.find((t) => t.token_hash === params[0]);
          return { rows: tok ? [tok] : [] };
        }
        if (text.includes("update _npati_auth_reset_tokens set used_at = now()")) {
          if (text.includes("where id =")) {
            const tok = dbTables.reset_tokens.find((t) => t.id === params[0]);
            if (tok) tok.used_at = new Date().toISOString();
          } else if (text.includes("where user_id =")) {
            for (const t of dbTables.reset_tokens) {
              if (t.user_id === params[0]) t.used_at = new Date().toISOString();
            }
          }
          return { rows: [] };
        }

        // GDPR collections simulation (orders, posts)
        if (text.includes("from information_schema.columns") && text.includes("table_schema = 'public'")) {
          return {
            rows: [
              { table_name: "orders", column_name: "user_id" },
              { table_name: "posts", column_name: "author_id" },
            ],
          };
        }
        if (text.includes("count(*)") && text.includes("from \"orders\"")) {
          const count = dbTables.orders.filter((o) => o.user_id === params[0]).length;
          return { rows: [{ count: String(count) }] };
        }
        if (text.includes("count(*)") && text.includes("from \"posts\"")) {
          const count = dbTables.posts.filter((p) => p.author_id === params[0]).length;
          return { rows: [{ count: String(count) }] };
        }
        if (text.includes("select * from \"orders\" where \"user_id\" =")) {
          return { rows: dbTables.orders.filter((o) => o.user_id === params[0]) };
        }
        if (text.includes("select * from \"posts\" where \"author_id\" =")) {
          return { rows: dbTables.posts.filter((p) => p.author_id === params[0]) };
        }
        if (text.includes("delete from \"orders\" where \"user_id\" =")) {
          const before = dbTables.orders.length;
          dbTables.orders = dbTables.orders.filter((o) => o.user_id !== params[0]);
          return { rowCount: before - dbTables.orders.length };
        }
        if (text.includes("update \"orders\" set \"user_id\" = null")) {
          for (const o of dbTables.orders) {
            if (o.user_id === params[0]) o.user_id = null;
          }
          return { rowCount: 1 };
        }
        if (text.includes("update \"posts\" set \"author_id\" = null")) {
          for (const p of dbTables.posts) {
            if (p.author_id === params[0]) p.author_id = null;
          }
          return { rowCount: 1 };
        }

          return { rows: [] };
        };
        const res = run();
        const rows = res.rows ?? [];
        const rowCount = res.rowCount !== undefined ? res.rowCount : rows.length;
        return { rows, rowCount };
      },
    };

    const provisioner: DatabaseProvisioner = {
      provisionDatabase: async () => {},
      deprovisionDatabase: async () => {},
      getConnection: async () => ({
        host: "localhost",
        port: 5432,
        user: "npati_migrator",
        password: "secret",
        database: "project_db",
      }),
      rotateCredentials: async () => {},
      suspendRuntime: async () => {},
      snapshot: async () => ({} as any),
      restoreSnapshot: async () => {},
      getUsage: async () => ({} as any),
    };

    const mockEmail = new MockEmailProvider();

    const authService = new ProjectAuthService({
      store,
      repository,
      provisioner,
      emailProvider: mockEmail,
      rateLimiter: new AuthRateLimiter(),
      poolFactory: async () => mockPool as any,
    });

    return {
      store,
      repository,
      provisioner,
      authService,
      mockEmail,
      ownerA,
      ownerB,
      mockBackendA,
      mockBackendB,
      dbTables,
      executedSqlLog,
    };
  }

  describe("1. Password Security & Rate Limiting", () => {
    it("hashes password with memory-hard scrypt and verifies correctly", async () => {
      const rawPassword = "StrongPassword#2026";
      const hash = await ProjectPasswordHasher.hash(rawPassword);

      expect(hash).toContain("$scrypt$N=16384,r=8,p=1$");
      expect(hash).not.toContain(rawPassword);

      const isValid = await ProjectPasswordHasher.verify(rawPassword, hash);
      expect(isValid).toBe(true);

      const isWrong = await ProjectPasswordHasher.verify("WrongPass#123", hash);
      expect(isWrong).toBe(false);
    });

    it("enforces password policy according to auth settings", () => {
      const settings: ProjectAuthSettings = {
        allowRegistration: true,
        requireEmailVerification: false,
        minPasswordLength: 10,
        requireNumbers: true,
        requireSymbols: true,
        accessTokenTtlMinutes: 15,
        refreshTokenTtlDays: 30,
      };

      expect(() => ProjectPasswordHasher.validatePolicy("short", settings)).toThrow("at least 10 characters");
      expect(() => ProjectPasswordHasher.validatePolicy("longenoughwithoutnumbersorsymbols", settings)).toThrow("at least one digit");
      expect(() => ProjectPasswordHasher.validatePolicy("longenoughwith123digits", settings)).toThrow("at least one symbol");
      expect(() => ProjectPasswordHasher.validatePolicy("ValidP@ssword123", settings)).not.toThrow();
    });

    it("rate limits brute-force attempts and temporarily locks out without user enumeration", () => {
      const limiter = new AuthRateLimiter();
      const ip = "192.168.1.100";
      const email = "victim@example.com";

      // 5 failed attempts allowed
      for (let i = 0; i < 5; i++) {
        expect(() => limiter.check(`ip:${ip}`)).not.toThrow();
        limiter.recordFailure(`ip:${ip}`);
      }

      // 6th attempt is locked out
      expect(() => limiter.check(`ip:${ip}`)).toThrow("Too many failed attempts");
    });
  });

  describe("2. Cryptographic Tokens: Ed25519 JWT & Opaque Refresh Tokens", () => {
    it("signs JWT with asymmetric Ed25519 and includes kid header", async () => {
      const bundle = ProjectKeyManager.createBundle();
      const claims = {
        iss: "backend-a:dev",
        aud: "project-api:backend-a:dev",
        sub: "user-123",
        role: "user",
        roles: ["user"],
        exp: Math.floor(Date.now() / 1000) + 900,
      };

      const token = ProjectKeyManager.signJwt(claims, bundle);
      expect(typeof token).toBe("string");

      const [headerB64, payloadB64, sigB64] = token.split(".");
      expect(headerB64).toBeDefined();
      expect(payloadB64).toBeDefined();
      expect(sigB64).toBeDefined();

      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
      expect(header.alg).toBe("EdDSA");
      expect(header.typ).toBe("JWT");
      expect(header.kid).toBe(bundle.activeKeyId);

      // Verify token
      const verified = ProjectKeyManager.verifyJwt(token, bundle, "backend-a:dev", "project-api:backend-a:dev");
      expect(verified.sub).toBe("user-123");
      expect(verified.role).toBe("user");
    });

    it("rejects token with wrong iss, aud, or expired timestamp", () => {
      const bundle = ProjectKeyManager.createBundle();
      const claims = {
        iss: "backend-a:dev",
        aud: "project-api:backend-a:dev",
        sub: "user-123",
        role: "user",
        exp: Math.floor(Date.now() / 1000) + 900,
      };

      const token = ProjectKeyManager.signJwt(claims, bundle);

      // Wrong issuer
      expect(() => ProjectKeyManager.verifyJwt(token, bundle, "backend-b:dev", "project-api:backend-a:dev")).toThrow("Invalid token issuer");

      // Wrong audience
      expect(() => ProjectKeyManager.verifyJwt(token, bundle, "backend-a:dev", "project-api:backend-b:dev")).toThrow("Invalid token audience");

      // Expired token
      const expiredClaims = { ...claims, exp: Math.floor(Date.now() / 1000) - 10 };
      const expiredToken = ProjectKeyManager.signJwt(expiredClaims, bundle);
      expect(() => ProjectKeyManager.verifyJwt(expiredToken, bundle, "backend-a:dev", "project-api:backend-a:dev")).toThrow("Token expired");
    });

    it("supports key rotation: old tokens verify until TTL, new tokens sign with new kid", () => {
      const bundle = ProjectKeyManager.createBundle();
      const oldKid = bundle.activeKeyId;

      const oldToken = ProjectKeyManager.signJwt({
        iss: "backend-a:dev",
        aud: "project-api:backend-a:dev",
        sub: "user-123",
        role: "user",
        exp: Math.floor(Date.now() / 1000) + 900,
      }, bundle);

      // Rotate keys
      const newBundle = ProjectKeyManager.rotateKeys(bundle);
      expect(newBundle.activeKeyId).not.toBe(oldKid);

      // Old token can still be verified using new bundle (retaining previous key)
      const verifiedOld = ProjectKeyManager.verifyJwt(oldToken, newBundle, "backend-a:dev", "project-api:backend-a:dev");
      expect(verifiedOld.sub).toBe("user-123");

      // New token has new kid
      const newToken = ProjectKeyManager.signJwt({
        iss: "backend-a:dev",
        aud: "project-api:backend-a:dev",
        sub: "user-456",
        role: "admin",
        exp: Math.floor(Date.now() / 1000) + 900,
      }, newBundle);
      const header = JSON.parse(Buffer.from(newToken.split(".")[0], "base64url").toString());
      expect(header.kid).toBe(newBundle.activeKeyId);
    });

    it("generates opaque refresh tokens and stores only SHA-256 hash", () => {
      const rawToken = OpaqueTokenManager.generate();
      expect(rawToken.length).toBe(64); // 32 bytes in hex

      const hash1 = OpaqueTokenManager.hash(rawToken);
      const hash2 = OpaqueTokenManager.hash(rawToken);
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(rawToken);
    });
  });

  describe("3. Email Provider Abstraction", () => {
    it("fails with EMAIL_SERVICE_UNCONFIGURED if email is not configured", async () => {
      const provider = new UnconfiguredEmailProvider();
      await expect(
        provider.sendVerificationEmail("test@example.com", "tok123", "http://example.com/verify")
      ).rejects.toThrow("EMAIL_SERVICE_UNCONFIGURED");
    });

    it("sends emails correctly via MockEmailProvider", async () => {
      const provider = new MockEmailProvider();
      await provider.sendVerificationEmail("test@example.com", "tok123", "http://example.com/verify");
      expect(provider.sentEmails.length).toBe(1);
      expect(provider.sentEmails[0].to).toBe("test@example.com");
      expect(provider.sentEmails[0].token).toBe("tok123");
    });
  });

  describe("4. RLS Policy Compiler", () => {
    it("compiles public, authenticated, owner, and role access policies into PostgreSQL RLS", () => {
      const policies: ProjectAccessPolicy[] = [
        {
          collection: "articles",
          rule: "public",
          actions: ["select"],
          description: "Anyone can read published articles",
        },
        {
          collection: "articles",
          rule: "role",
          role: "author",
          actions: ["insert", "update"],
          description: "Authors can write articles",
        },
        {
          collection: "profiles",
          rule: "owner",
          ownerField: "user_id",
          actions: ["select", "update"],
          description: "Users own their profile",
        },
      ];

      const rlsStatements = RlsPolicyCompiler.compile("articles", [policies[0], policies[1]]);
      const joined = rlsStatements.sql.join("\n");

      // Verify ENABLE and FORCE ROW LEVEL SECURITY
      expect(joined).toContain('ALTER TABLE "articles" ENABLE ROW LEVEL SECURITY;');
      expect(joined).toContain('ALTER TABLE "articles" FORCE ROW LEVEL SECURITY;');

      // Public policy
      expect(joined).toContain('CREATE POLICY "npati_pol_articles_select" ON "articles" FOR SELECT USING (true);');

      // Role policy with current_setting
      expect(joined).toContain("current_setting('npati.auth.user_role', true) = 'author'");

      // Owner policy
      const ownerStatements = RlsPolicyCompiler.compile("profiles", [policies[2]]).sql.join("\n");
      expect(ownerStatements).toContain('("user_id")::text = current_setting(\'npati.auth.user_id\', true)');
      // WITH CHECK must match owner_id
      expect(ownerStatements).toContain('WITH CHECK (("user_id")::text = current_setting(\'npati.auth.user_id\', true))');
    });

    it("computes a deterministic fingerprint of access policies for drift detection", () => {
      const p1: ProjectAccessPolicy[] = [
        { collection: "posts", rule: "public", actions: ["select"] },
      ];
      const p2: ProjectAccessPolicy[] = [
        { collection: "posts", rule: "public", actions: ["select"] },
      ];
      const p3: ProjectAccessPolicy[] = [
        { collection: "posts", rule: "authenticated", actions: ["select"] },
      ];

      const fp1 = RlsPolicyCompiler.computeFingerprint("posts", p1);
      const fp2 = RlsPolicyCompiler.computeFingerprint("posts", p2);
      const fp3 = RlsPolicyCompiler.computeFingerprint("posts", p3);

      expect(fp1).toBe(fp2);
      expect(fp1).not.toBe(fp3);
    });
  });

  describe("5. End-to-End Auth Flows (Service & DB Level)", () => {
    it("completes registration, email verification, login, refresh with rotation, and logout", async () => {
      const harness = await createHarness();
      const { store, ownerA, authService, dbTables, mockEmail } = harness;

      // Create a test project attached to backend-a
      const { project } = await store.createProject(ownerA, "company-a", {
        name: "Webshop",
        type: "website",
        dataBackendId: "backend-a",
      }, "proj-webshop");

      // Configure auth to require verification
      await authService.updateAuthSettings(ownerA, "company-a", project.id, "dev", {
        requireEmailVerification: true,
      });

      // 1. Register user
      const registerRes = await authService.register(
        ownerA,
        "company-a",
        project.id,
        "dev",
        {
          email: "customer@example.com",
          password: "StrongPass#123",
        },
        "127.0.0.1"
      );

      expect(registerRes.user.email).toBe("customer@example.com");
      expect(registerRes.user.roles).toContain("user");
      expect(registerRes.session).toBeNull();

      // Check DB: password_hash is hashed
      const storedUser = dbTables.users.find((u) => u.email === "customer@example.com");
      expect(storedUser).toBeDefined();
      expect(storedUser.password_hash).toContain("$scrypt$");
      expect(storedUser.password_hash).not.toContain("StrongPass#123");

      // Email was sent
      expect(mockEmail.sentEmails.length).toBe(1);
      const verifyToken = mockEmail.sentEmails[0].token;

      // 2. Email verification
      const verifyRes = await authService.verifyEmail(
        ownerA,
        "company-a",
        project.id,
        "dev",
        verifyToken
      );
      expect(verifyRes.success).toBe(true);

      // Re-using token fails
      await expect(
        authService.verifyEmail(ownerA, "company-a", project.id, "dev", verifyToken)
      ).rejects.toThrow();

      // 3. Login
      const loginRes = await authService.login(
        ownerA,
        "company-a",
        project.id,
        "dev",
        {
          email: "customer@example.com",
          password: "StrongPass#123",
        },
        "127.0.0.1"
      );
      expect(loginRes.user.emailVerified).toBe(true);
      expect(loginRes.accessToken).toBeDefined();
      expect(loginRes.refreshToken).toBeDefined();

      const storedToken = dbTables.refresh_tokens.find((t) => t.user_id === storedUser.id);
      expect(storedToken).toBeDefined();
      expect(storedToken.token_hash).not.toBe(loginRes.refreshToken);

      // 4. Refresh token rotation
      const refreshRes = await authService.refresh(
        ownerA,
        "company-a",
        project.id,
        "dev",
        { refreshToken: loginRes.refreshToken },
      );
      expect(refreshRes.refreshToken).toBeDefined();
      expect(refreshRes.refreshToken).not.toBe(loginRes.refreshToken);

      // 5. Token reuse detection: using old rotated token revokes entire family
      await expect(
        authService.refresh(ownerA, "company-a", project.id, "dev", { refreshToken: loginRes.refreshToken })
      ).rejects.toThrow("Refresh token reuse detected");

      // Even the newly issued token in that family is now revoked
      await expect(
        authService.refresh(ownerA, "company-a", project.id, "dev", { refreshToken: refreshRes.refreshToken })
      ).rejects.toThrow();

      // 6. Logout test with fresh login
      const freshLogin = await authService.login(
        ownerA,
        "company-a",
        project.id,
        "dev",
        {
          email: "customer@example.com",
          password: "StrongPass#123",
        },
        "127.0.0.1"
      );
      const logoutRes = await authService.logout(
        ownerA,
        "company-a",
        project.id,
        "dev",
        { refreshToken: freshLogin.refreshToken }
      );
      expect(logoutRes.success).toBe(true);

      // Refresh after logout fails
      await expect(
        authService.refresh(ownerA, "company-a", project.id, "dev", { refreshToken: freshLogin.refreshToken })
      ).rejects.toThrow();
    });

    it("handles forgot/reset password with one-time hashed token and invalidates reset tokens on password change", async () => {
      const harness = await createHarness();
      const { store, ownerA, authService, mockEmail } = harness;

      const { project } = await store.createProject(ownerA, "company-a", {
        name: "Shop",
        type: "website",
        dataBackendId: "backend-a",
      }, "proj-shop-1");

      await authService.register(
        ownerA,
        "company-a",
        project.id,
        "dev",
        {
          email: "forgot@example.com",
          password: "InitialPass#123",
        },
        "127.0.0.1"
      );

      mockEmail.sentEmails = [];

      // Request password reset
      const forgotRes = await authService.forgotPassword(
        ownerA,
        "company-a",
        project.id,
        "dev",
        "forgot@example.com",
        "127.0.0.1"
      );
      expect(forgotRes.success).toBe(true);
      expect(mockEmail.sentEmails.length).toBe(1);
      const resetToken = mockEmail.sentEmails[0].token;

      // Reset password
      const resetRes = await authService.resetPassword(
        ownerA,
        "company-a",
        project.id,
        "dev",
        {
          token: resetToken,
          newPassword: "NewBrandNewPass#999",
        },
        "127.0.0.1"
      );
      expect(resetRes.success).toBe(true);

      // Cannot reuse reset token
      await expect(
        authService.resetPassword(
          ownerA,
          "company-a",
          project.id,
          "dev",
          { token: resetToken, newPassword: "Another#123" },
          "127.0.0.1"
        )
      ).rejects.toThrow();

      // Can login with new password
      const loginRes = await authService.login(
        ownerA,
        "company-a",
        project.id,
        "dev",
        {
          email: "forgot@example.com",
          password: "NewBrandNewPass#999",
        },
        "127.0.0.1"
      );
      expect(loginRes.user.email).toBe("forgot@example.com");

      // Old password fails
      await expect(
        authService.login(
          ownerA,
          "company-a",
          project.id,
          "dev",
          {
            email: "forgot@example.com",
            password: "InitialPass#123",
          },
          "127.0.0.1"
        )
      ).rejects.toThrow("Invalid email or password");
    });
  });

  describe("6. GDPR User Data Export and Deletion Strategies", () => {
    it("previews affected data across collections with configured strategies and executes non-cascading deletion", async () => {
      const harness = await createHarness();
      const { store, ownerA, authService, dbTables } = harness;

      const { project } = await store.createProject(ownerA, "company-a", {
        name: "Shop",
        type: "website",
        dataBackendId: "backend-a",
      }, "proj-shop-2");

      const reg = await authService.register(
        ownerA,
        "company-a",
        project.id,
        "dev",
        {
          email: "gdpr@example.com",
          password: "Password#123",
        },
        "127.0.0.1"
      );
      const userId = reg.user.id;

      // Seed user data in collections
      dbTables.orders.push({ id: "o1", user_id: userId, total: 150 });
      dbTables.orders.push({ id: "o2", user_id: userId, total: 300 });
      dbTables.posts.push({ id: "p1", author_id: userId, title: "My Blog Post" });

      // 1. Preview affected data before deletion
      const preview = await authService.previewDeleteUser(ownerA, "company-a", project.id, "dev", userId, {
        orders: "retain",
        posts: "detach",
      });

      expect(preview.userId).toBe(userId);
      expect(preview.collections.length).toBe(2);
      const ordersInfo = preview.collections.find((c) => c.collection === "orders");
      expect(ordersInfo?.affectedRows).toBe(2);
      expect(ordersInfo?.strategy).toBe("retain");

      const postsInfo = preview.collections.find((c) => c.collection === "posts");
      expect(postsInfo?.affectedRows).toBe(1);
      expect(postsInfo?.strategy).toBe("detach");

      // 2. Export user data
      const exported = await authService.exportUserData(ownerA, "company-a", project.id, "dev", userId);
      expect(exported.user.email).toBe("gdpr@example.com");
      expect(exported.data.orders.length).toBe(2);
      expect(exported.data.posts.length).toBe(1);

      // 3. Delete user requires confirmed: true
      await expect(
        authService.deleteUser(ownerA, "company-a", project.id, "dev", userId, { confirmed: false })
      ).rejects.toThrow("CONFIRMATION_REQUIRED");

      // Execute deletion with strategies:
      // orders: retain (left untouched)
      // posts: detach (author_id set to null)
      const deleteResult = await authService.deleteUser(ownerA, "company-a", project.id, "dev", userId, {
        confirmed: true,
        strategies: {
          orders: "retain",
          posts: "detach",
        },
      });

      expect(deleteResult.success).toBe(true);

      // Verify user was deleted from users table
      const remainingUser = dbTables.users.find((u) => u.id === userId);
      expect(remainingUser).toBeUndefined();

      // Verify orders were retained
      expect(dbTables.orders.length).toBe(2);

      // Verify posts were detached (author_id is null)
      expect(dbTables.posts[0].author_id).toBeNull();
    });
  });

  describe("7. Tenant Isolation & Route Authorization", () => {
    it("prevents company B from accessing or managing company A's project auth", async () => {
      const harness = await createHarness();
      const { store, ownerA, ownerB, authService } = harness;

      const { project: projectA } = await store.createProject(ownerA, "company-a", {
        name: "Company A Website",
        type: "website",
        dataBackendId: "backend-a",
      }, "proj-comp-a");

      // Owner A can list users
      const listA = await authService.listUsers(ownerA, "company-a", projectA.id, "dev");
      expect(listA.users).toEqual([]);

      // Owner B attempting to access Company A's project auth is rejected
      await expect(
        authService.listUsers(ownerB, "company-a", projectA.id, "dev")
      ).rejects.toThrow();
    });
  });

  describe("8. Agent Capabilities (project.auth.inspect & project.auth.configure)", () => {
    it("allows agent with project.auth.inspect to inspect auth settings without leaking credentials", async () => {
      const harness = await createHarness();
      const { store, ownerA, authService } = harness;

      const { project } = await store.createProject(ownerA, "company-a", {
        name: "Shop",
        type: "website",
        dataBackendId: "backend-a",
      }, "proj-shop-3");

      await authService.register(
        ownerA,
        "company-a",
        project.id,
        "dev",
        {
          email: "agent-user@example.com",
          password: "SecretPassword#123",
        },
        "127.0.0.1"
      );

      const agentDataService = new AgentDataStudioService(
        store,
        harness.repository,
        {} as any,
        {} as any,
        undefined,
        authService,
      );

      const agentInspection = await agentDataService.inspectAuth(ownerA, "company-a", project.id);
      expect(agentInspection.settings).toBeDefined();
      expect(agentInspection.roles).toContain("admin");
      expect(agentInspection.roles).toContain("user");

      // Password hash and tokens MUST NOT be in the output
      const jsonOutput = JSON.stringify(agentInspection);
      expect(jsonOutput).not.toContain("password_hash");
      expect(jsonOutput).not.toContain("SecretPassword");
      expect(jsonOutput).not.toContain("$scrypt$");
    });

    it("allows agent with project.auth.configure to update settings", async () => {
      const harness = await createHarness();
      const { store, ownerA, authService } = harness;

      const { project } = await store.createProject(ownerA, "company-a", {
        name: "Shop",
        type: "website",
        dataBackendId: "backend-a",
      }, "proj-shop-4");

      const agentDataService = new AgentDataStudioService(
        store,
        harness.repository,
        {} as any,
        {} as any,
        undefined,
        authService,
      );

      const updated = await agentDataService.configureAuth(
        ownerA,
        "company-a",
        project.id,
        {
          settings: {
            allowRegistration: false,
            minPasswordLength: 12,
          },
        },
        { approved: true }
      );

      expect(updated.settings!.allowRegistration).toBe(false);
      expect(updated.settings!.minPasswordLength).toBe(12);
    });

    it("dispatches project.auth.inspect and project.auth.configure through CompanyToolRuntime", async () => {
      const harness = await createHarness();
      const { store, ownerA, authService } = harness;

      const { project } = await store.createProject(ownerA, "company-a", {
        name: "Shop",
        type: "website",
        dataBackendId: "backend-a",
      }, "proj-shop-5");

      const agentDataService = new AgentDataStudioService(
        store,
        harness.repository,
        {} as any,
        {} as any,
        undefined,
        authService,
      );

      const mockAiEngine = {
        async executeTool() { return {}; },
      };

      const runtime = new CompanyToolRuntime(
        mockAiEngine as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        agentDataService,
      );

      const company = await store.getCompany(ownerA, "company-a");
      const abortSignal = new AbortController().signal;

      const inspectResult: any = await runtime.execute(
        ownerA,
        company,
        "project.auth.inspect",
        { projectId: project.id },
        abortSignal,
      );

      expect(inspectResult.roles).toContain("admin");

      const configureResult: any = await runtime.execute(
        ownerA,
        company,
        "project.auth.configure",
        { projectId: project.id, settings: { minPasswordLength: 14 } },
        abortSignal,
      );

      expect(configureResult.success).toBe(true);
      expect(configureResult.settings.minPasswordLength).toBe(14);
    });
  });

  describe("9. HTTP Fastify Routes Verification", () => {
    it("registers and calls HTTP admin and client auth endpoints", async () => {
      const harness = await createHarness();
      const { store, ownerA, authService } = harness;

      const { project } = await store.createProject(ownerA, "company-a", {
        name: "Shop",
        type: "website",
        dataBackendId: "backend-a",
      }, "proj-shop-6");

      const app = Fastify();
      registerProjectAuthRoutes(
        app,
        { authenticate: async () => ownerA } as any,
        authService,
      );

      // 1. Client Register via HTTP
      const registerRes = await app.inject({
        method: "POST",
        url: `/companies/company-a/projects/${project.id}/data-studio/dev/auth/register`,
        payload: {
          email: "http-user@example.com",
          password: "SecurePassword#2026",
        },
      });

      expect(registerRes.statusCode).toBe(201);
      const regBody = JSON.parse(registerRes.body);
      expect(regBody.user.email).toBe("http-user@example.com");
      expect(regBody.session.accessToken).toBeDefined();

      // 2. Admin List Users via HTTP
      const listRes = await app.inject({
        method: "GET",
        url: `/companies/company-a/projects/${project.id}/data-studio/dev/auth/users`,
      });

      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body);
      expect(listBody.users.length).toBe(1);
      expect(listBody.users[0].email).toBe("http-user@example.com");
      expect(listBody.users[0].password_hash).toBeUndefined();

      // 3. Admin Update Settings via HTTP
      const settingsRes = await app.inject({
        method: "PUT",
        url: `/companies/company-a/projects/${project.id}/data-studio/dev/auth/settings`,
        payload: {
          allowRegistration: true,
          minPasswordLength: 10,
        },
      });

      expect(settingsRes.statusCode).toBe(200);
      const settingsBody = JSON.parse(settingsRes.body);
      expect(settingsBody.settings.minPasswordLength).toBe(10);
    });
  });
});
