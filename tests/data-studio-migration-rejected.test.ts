import { describe, expect, it, vi } from "vitest";

// The migration engine opens its own pg Pool: this fake rejects the migration SQL like PostgreSQL does for a
// foreign key on a column that does not exist (SQLSTATE 42703).
vi.mock("pg", () => {
  class Pool {
    async query() { return { rows: [] }; }
    async connect() {
      return {
        release: () => undefined,
        query: async (sql: string) => {
          if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
          if (sql.includes("max(version)")) return { rows: [{ version: "2" }] };
          if (sql.startsWith("ALTER TABLE")) throw Object.assign(new Error('column "product_id" referenced in foreign key constraint does not exist'), { code: "42703" });
          return { rows: [] };
        },
      };
    }
    async end() { return undefined; }
  }
  return { Pool, default: { Pool } };
});

const { ProjectMigrationEngine } = await import("../apps/agent-api/src/data-studio/migration-engine");
const { PostgresDataProvider } = await import("../apps/agent-api/src/data-studio/data-provider");
const { DataStudioError } = await import("../apps/agent-api/src/data-studio/identifier");

const ctx = { userId: "owner", workspaceId: "workspace", permissions: [] } as never;
const backend = { id: "backend", workspaceId: "workspace", createdBy: "owner", companyId: "company" } as never;

function engine() {
  const provider = new PostgresDataProvider();
  vi.spyOn(provider, "introspectSchema").mockResolvedValue({ collections: [] } as never);
  vi.spyOn(provider, "schemaFingerprint").mockReturnValue("fingerprint");
  vi.spyOn(provider, "assertLimits").mockReturnValue(undefined as never);
  const provisioner = { getConnection: async () => ({}), getUsage: async () => ({ bytes: 0 }), snapshot: async () => undefined };
  const repository = {
    get: async () => ({ status: "ready" }),
    environment: async () => ({ status: "ready", syncStatus: "synced" }),
    acquireLock: async () => true, ownsLock: async () => true, releaseLock: async () => undefined,
    pool: { query: async () => ({ rows: [] }) },
  };
  return new ProjectMigrationEngine(provisioner as never, provider, repository as never);
}

describe("Data Studio migration rejected by PostgreSQL", () => {
  it("reports the database's schema error to the caller instead of an opaque failure", async () => {
    const operation = { kind: "create_relation", collection: "orders", target: "products", name: "order_product", field: "product_id", cardinality: "many-to-one" } as const;
    const failure = await engine().apply(ctx, { backend, environment: "dev", operation, authorId: "owner", expectedFingerprint: "fingerprint" } as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DataStudioError);
    expect(failure).toMatchObject({ status: 400, code: "MIGRATION_REJECTED" });
    expect(String((failure as Error).message)).toContain('column "product_id" referenced in foreign key constraint does not exist');
  });
});
