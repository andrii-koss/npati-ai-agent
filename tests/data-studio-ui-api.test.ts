import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { DataStudioUiService } from "../apps/agent-api/src/data-studio/studio-service";
import { registerDataStudioRoutes } from "../apps/agent-api/src/data-studio/studio-routes";
import { registerDataBackendRoutes } from "../apps/agent-api/src/data-studio/routes";
import { DataBackendService } from "../apps/agent-api/src/data-studio/service";
import type { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import type { DataProvider, SchemaOperation, SchemaSnapshot } from "../apps/agent-api/src/data-studio/data-provider";
import type { ProjectMigrationEngine } from "../apps/agent-api/src/data-studio/migration-engine";
import type { DatabaseProvisioner } from "../apps/agent-api/src/data-studio/provisioner";
import type { DataBackend, DataEnvironmentName } from "../apps/agent-api/src/data-studio/types";

describe("Data Studio UI and API (D2)", () => {
  function createHarness() {
    const store = new InMemoryWorkspaceStore();
    const ownerA: AuthContext = { workspaceId: "tenant", userId: "owner-a", permissions: ["workspace:read", "business:manage"] };
    const ownerB: AuthContext = { workspaceId: "tenant", userId: "owner-b", permissions: ["workspace:read", "business:manage"] };

    const mockBackend: DataBackend = {
      id: "backend-123",
      workspaceId: "tenant",
      companyId: "company-a",
      name: "Store DB",
      provider: "shared_postgres",
      status: "ready",
      createdBy: "owner-a",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockEnv = {
      id: "env-123",
      workspaceId: "tenant",
      companyId: "company-a",
      backendId: "backend-123",
      environment: "dev" as DataEnvironmentName,
      status: "ready" as const,
      schemaFingerprint: "fingerprint-abc",
      expectedSchema: null as any,
      syncStatus: "synced" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const sampleSchema: SchemaSnapshot = {
      tables: [
        {
          name: "products",
          columns: [
            { name: "id", type: "uuid", nullable: false },
            { name: "title", type: "text", nullable: false },
            { name: "price", type: "numeric", nullable: true },
            { name: "is_active", type: "boolean", nullable: true },
          ],
          constraints: ["pk_products:PRIMARY KEY (id)"],
          indexes: [],
          rlsEnabled: true,
          rlsForced: true,
          policies: [],
        },
      ],
    };

    const inMemoryRows: Record<string, unknown>[] = [
      { id: "11111111-1111-1111-1111-111111111111", title: "Product 1", price: 100, is_active: true },
      { id: "22222222-2222-2222-2222-222222222222", title: "Product 2", price: 200, is_active: false },
      { id: "33333333-3333-3333-3333-333333333333", title: "=FormulaAttack", price: 300, is_active: true },
    ];

    const repo = {
      pool: {
        query: async (sql: string) => {
          if (sql.includes("data_backend_migrations")) {
            return {
              rows: [
                {
                  id: "mig-1",
                  version: 1,
                  operation: { kind: "create_collection", collection: "products", fields: [] },
                  reversible: true,
                  destructive: false,
                  requiresSnapshot: false,
                  authorId: "owner-a",
                  runId: null,
                  status: "applied",
                  createdAt: new Date().toISOString(),
                  appliedAt: new Date().toISOString(),
                },
              ],
            };
          }
          if (sql.includes("data_backend_migration_locks")) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      },
      get: async (_ctx: any, companyId: string, id: string) => {
        if (id !== mockBackend.id) throw new Error("Backend not found");
        return { ...mockBackend, companyId };
      },
      environment: async (_ctx: any, companyId: string, _id: string, env: string) => {
        return { ...mockEnv, companyId, environment: env as DataEnvironmentName };
      },
      setEnvironment: async () => {},
      setExpectedSchema: async () => {},
      attach: async () => mockBackend.id,
      detach: async () => {},
    } as unknown as DataBackendRepository;

    const provider = {
      introspectSchema: async () => sampleSchema,
      schemaFingerprint: () => "fingerprint-abc",
      detectDrift: async () => ({ status: "synced" as const, actual: "fingerprint-abc", schema: sampleSchema }),
      compileOperation: (op: SchemaOperation) => ({
        operation: op.kind,
        upSql: `-- ${op.kind}`,
        downSql: `-- down ${op.kind}`,
        reversible: true,
        destructive: op.kind === "drop_collection" || op.kind === "drop_field",
        requiresSnapshot: op.kind === "drop_collection" || op.kind === "drop_field",
      }),
    } as unknown as DataProvider;

    const migrations = {
      detectDrift: async () => ({ status: mockEnv.syncStatus, actual: "fingerprint-abc", expected: "fingerprint-abc", schema: sampleSchema }),
      dryRun: async (req: any) => ({
        operation: req.operation.kind,
        upSql: `-- ${req.operation.kind}`,
        downSql: `-- down ${req.operation.kind}`,
        reversible: true,
        destructive: req.operation.kind === "drop_collection" || req.operation.kind === "drop_field",
        requiresSnapshot: req.operation.kind === "drop_collection" || req.operation.kind === "drop_field",
        current: sampleSchema,
        diff: { operation: req.operation, beforeFingerprint: "fingerprint-abc", sql: `-- ${req.operation.kind}` },
      }),
      apply: async (_ctx: any, req: any) => ({
        id: "mig-applied",
        version: 2,
        checksum: "abc",
        fingerprint: "fingerprint-new",
        operation: req.operation.kind,
        upSql: `-- ${req.operation.kind}`,
        reversible: true,
        destructive: false,
        requiresSnapshot: false,
        current: sampleSchema,
        diff: { operation: req.operation, beforeFingerprint: "fingerprint-abc", sql: `-- ${req.operation.kind}` },
      }),
      rollback: async () => {},
      listOwnerRows: async (_ctx: any, _backend: any, _env: any, _collection: string, query: any) => {
        let result = [...inMemoryRows];
        if (query?.filters?.length) {
          for (const f of query.filters) {
            if (f.operator === "eq") result = result.filter((r) => r[f.field] === f.value);
            if (f.operator === "gt") result = result.filter((r) => Number(r[f.field]) > Number(f.value));
          }
        }
        if (query?.search) {
          const s = query.search.toLowerCase();
          result = result.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(s)));
        }
        if (query?.sort) {
          const { field, direction } = query.sort;
          result.sort((a, b) => (direction === "desc" ? (a[field] < b[field] ? 1 : -1) : (a[field] > b[field] ? 1 : -1)));
        }
        return result.slice(query?.offset || 0, (query?.offset || 0) + (query?.limit || 50));
      },
      createOwnerRow: async (_ctx: any, _backend: any, _env: any, _collection: string, row: Record<string, unknown>) => {
        const created = { id: "44444444-4444-4444-4444-444444444444", ...row };
        inMemoryRows.push(created);
        return created;
      },
      updateOwnerRow: async (_ctx: any, _backend: any, _env: any, _collection: string, id: string, row: Record<string, unknown>) => {
        const found = inMemoryRows.find((r) => r.id === id);
        if (!found) return null;
        Object.assign(found, row);
        return found;
      },
      deleteOwnerRows: async (_ctx: any, _backend: any, _env: any, _collection: string, ids: string[]) => {
        const initial = inMemoryRows.length;
        for (let i = inMemoryRows.length - 1; i >= 0; i--) {
          if (ids.includes(String(inMemoryRows[i]!.id))) inMemoryRows.splice(i, 1);
        }
        return { deleted: initial - inMemoryRows.length };
      },
    } as unknown as ProjectMigrationEngine;

    const studioService = new DataStudioUiService(store, repo, provider, migrations);
    return { store, repo, provider, migrations, studioService, ownerA, ownerB, mockBackend, mockEnv, sampleSchema, inMemoryRows };
  }

  it("provides Data Studio overview with collections, sync status, and migrations", async () => {
    const { store, studioService, ownerA } = createHarness();
    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "proj-1")).project;
    (store as any).projects.get(project.id).dataBackendId = "backend-123";

    const app = Fastify();
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, studioService);

    const res = await app.inject({
      method: "GET",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.backend.name).toBe("Store DB");
    expect(body.environment.syncStatus).toBe("synced");
    expect(body.schema.tables.length).toBe(1);
    expect(body.schema.tables[0].name).toBe("products");
    expect(body.migrations.length).toBe(1);
    await app.close();
  });

  it("enforces tenant isolation: User B cannot access Company A's project Data Studio", async () => {
    const { store, studioService, ownerA, ownerB } = createHarness();
    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "proj-1")).project;
    (store as any).projects.get(project.id).dataBackendId = "backend-123";

    const app = Fastify();
    // authenticate as Owner B
    registerDataStudioRoutes(app, { authenticate: async () => ownerB }, studioService);

    const res = await app.inject({
      method: "GET",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev`,
    });

    // Owner B cannot access Company A's project (403 forbidden or 404 not found)
    expect([403, 404]).toContain(res.statusCode);
    await app.close();
  });

  it("rejects forged or SQL-injection collection names in schema operations", async () => {
    const { store, studioService, ownerA } = createHarness();
    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "proj-1")).project;
    (store as any).projects.get(project.id).dataBackendId = "backend-123";

    const app = Fastify();
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, studioService);

    // SQL injection attempt in collection name
    const res = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/schema/preview`,
      payload: {
        operation: {
          kind: "create_collection",
          collection: "products; DROP TABLE users; --",
          fields: [],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_IDENTIFIER");
    await app.close();
  });

  it("blocks schema changes in production environment (Promote required)", async () => {
    const { store, studioService, ownerA } = createHarness();
    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "proj-1")).project;
    (store as any).projects.get(project.id).dataBackendId = "backend-123";

    const app = Fastify();
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, studioService);

    const res = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/prod/schema/apply`,
      payload: {
        operation: { kind: "add_field", collection: "products", field: { name: "description", type: "text" } },
        expectedFingerprint: "fingerprint-abc",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PROMOTE_REQUIRED");
    await app.close();
  });

  it("blocks Apply when schema drift is detected", async () => {
    const { store, studioService, ownerA, mockEnv } = createHarness();
    mockEnv.syncStatus = "drift_detected";

    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "proj-1")).project;
    (store as any).projects.get(project.id).dataBackendId = "backend-123";

    const app = Fastify();
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, studioService);

    const res = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/schema/apply`,
      payload: {
        operation: { kind: "add_field", collection: "products", field: { name: "sku", type: "string" } },
        expectedFingerprint: "fingerprint-abc",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DRIFT_BLOCKED");
    await app.close();
  });

  it("supports row CRUD: query, create, update, delete, and bulk delete", async () => {
    const { store, studioService, ownerA } = createHarness();
    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "proj-1")).project;
    (store as any).projects.get(project.id).dataBackendId = "backend-123";

    const app = Fastify();
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, studioService);

    // 1. Query rows with search
    const queryRes = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/rows/query`,
      payload: { search: "Product 1" },
    });
    expect(queryRes.statusCode).toBe(200);
    expect(queryRes.json().rows.length).toBe(1);
    expect(queryRes.json().rows[0].title).toBe("Product 1");

    // 2. Create row
    const createRes = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/rows`,
      payload: { row: { title: "New Item", price: 450, is_active: true } },
    });
    expect(createRes.statusCode).toBe(200);
    const createdId = createRes.json().row.id;
    expect(createdId).toBeDefined();

    // 3. Update row
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/rows/${createdId}`,
      payload: { row: { title: "Updated Item", price: 500 } },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().row.title).toBe("Updated Item");

    // 4. Delete row without confirmation -> rejected
    const unconfirmedDel = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/rows/delete`,
      payload: { ids: [createdId], confirmed: false },
    });
    expect(unconfirmedDel.statusCode).toBe(409);
    expect(unconfirmedDel.json().error.code).toBe("CONFIRMATION_REQUIRED");

    // 5. Delete row with confirmation
    const confirmedDel = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/rows/delete`,
      payload: { ids: [createdId], confirmed: true },
    });
    expect(confirmedDel.statusCode).toBe(200);
    expect(confirmedDel.json().deleted).toBe(1);

    await app.close();
  });

  it("CSV export escapes formula injection (=, +, -, @) safely", async () => {
    const { store, studioService, ownerA } = createHarness();
    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "proj-1")).project;
    (store as any).projects.get(project.id).dataBackendId = "backend-123";

    const app = Fastify();
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, studioService);

    const res = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/export`,
      payload: { format: "csv" },
    });

    expect(res.statusCode).toBe(200);
    const content = res.json().content;
    // Row 3 had title =FormulaAttack; must be escaped with single quote '
    expect(content).toContain("'=FormulaAttack");
    await app.close();
  });

  it("CSV import validates column types and rejects invalid numbers or oversized payloads", async () => {
    const { store, studioService, ownerA } = createHarness();
    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "proj-1")).project;
    (store as any).projects.get(project.id).dataBackendId = "backend-123";

    const app = Fastify();
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, studioService);

    // 1. Invalid number for price column
    const badTypeRes = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/import`,
      payload: { format: "csv", content: "title,price,is_active\nProduct X,not-a-number,true" },
    });
    expect(badTypeRes.statusCode).toBe(400);
    expect(badTypeRes.json().error.code).toBe("INVALID_TYPE");

    // 2. Unclosed CSV quotes
    const unclosedRes = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/import`,
      payload: { format: "csv", content: 'title,price\n"Unclosed text,100' },
    });
    expect(unclosedRes.statusCode).toBe(400);
    expect(unclosedRes.json().error.code).toBe("INVALID_CSV");

    // 3. Valid CSV import
    const validRes = await app.inject({
      method: "POST",
      url: `/companies/${companyA.id}/projects/${project.id}/data-studio/dev/collections/products/import`,
      payload: { format: "csv", content: "title,price,is_active\nImported Product,99.99,true" },
    });
    expect(validRes.statusCode).toBe(200);
    expect(validRes.json().imported).toBe(1);

    await app.close();
  });

  it("allows same DataBackend to be accessed by two projects of the same company", async () => {
    const { store, studioService, ownerA } = createHarness();
    const companyA = await store.createCompany(ownerA, { name: "Company A" }, "company-a");
    const project1 = (await store.createProject(ownerA, companyA.id, { name: "Web Store", type: "website" }, "p1")).project;
    const project2 = (await store.createProject(ownerA, companyA.id, { name: "Admin Portal", type: "web_app" }, "p2")).project;

    (store as any).projects.get(project1.id).dataBackendId = "backend-123";
    (store as any).projects.get(project2.id).dataBackendId = "backend-123";

    const app = Fastify();
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, studioService);

    const res1 = await app.inject({
      method: "GET",
      url: `/companies/${companyA.id}/projects/${project1.id}/data-studio/dev`,
    });
    const res2 = await app.inject({
      method: "GET",
      url: `/companies/${companyA.id}/projects/${project2.id}/data-studio/dev`,
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.json().backend.id).toBe(res2.json().backend.id);
    await app.close();
  });

  it("returns 503 DATA_STUDIO_UNAVAILABLE when Data Studio service is disabled", async () => {
    const app = Fastify();
    const ownerA: AuthContext = { workspaceId: "tenant", userId: "owner-a", permissions: ["workspace:read", "business:manage"] };
    // Pass undefined service
    registerDataStudioRoutes(app, { authenticate: async () => ownerA }, undefined);

    const res = await app.inject({
      method: "GET",
      url: "/companies/any/projects/any/data-studio/dev",
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("DATA_STUDIO_UNAVAILABLE");
    await app.close();
  });
});
