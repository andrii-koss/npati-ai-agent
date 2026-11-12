import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { WorkspaceAccessError, type AuthContext } from "@npati/workspace";
import { registerDataBackendRoutes } from "../apps/agent-api/src/data-studio/routes";
import { registerDataStudioRoutes } from "../apps/agent-api/src/data-studio/studio-routes";
import type { DataBackendService } from "../apps/agent-api/src/data-studio/service";
import { DataStudioUiService } from "../apps/agent-api/src/data-studio/studio-service";
import { readDataStudioCatalog, readDataStudioWorkspace } from "../apps/agent-api/src/data-studio/catalog";
import type { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import { PostgresDataProvider } from "../apps/agent-api/src/data-studio/data-provider";
import type { DataProvider } from "../apps/agent-api/src/data-studio/data-provider";
import type { ProjectMigrationEngine } from "../apps/agent-api/src/data-studio/migration-engine";
import type { WorkspaceStore } from "@npati/workspace";

const owner: AuthContext = { workspaceId: "tenant", userId: "owner", permissions: ["workspace:read"] };

it("defaults to ten catalog entries, validates pagination, and authorizes before dispatch", async () => {
  const catalog = vi.fn(async () => ({ items: [], companies: [], stats: {}, pagination: { total: 0, nextCursor: null } }));
  let context = owner;
  const app = Fastify();
  registerDataBackendRoutes(app, { authenticate: async () => context }, { catalog } as unknown as DataBackendService);
  try {
    const first = await app.inject({ method: "GET", url: "/data-studio/catalog" });
    expect(first.statusCode).toBe(200); expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(catalog).toHaveBeenCalledWith(owner, { limit: 10 });
    for (const query of ["limit=0", "limit=51", "status=invalid", `search=${"a".repeat(201)}`]) {
      expect((await app.inject({ method: "GET", url: `/data-studio/catalog?${query}` })).statusCode).toBe(400);
    }
    context = { ...owner, permissions: [] };
    expect((await app.inject({ method: "GET", url: "/data-studio/catalog" })).statusCode).toBe(403);
    expect(catalog).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it("rejects malformed or cross-filter cursors before reading metadata and denies unknown companies", async () => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ id: "owned", name: "Owned" }] }));
  const pool = { query } as unknown as Pool;
  await expect(readDataStudioCatalog(pool, owner, { cursor: "malformed" })).rejects.toThrow("cursor");
  const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-11-12", id: "backend", scope: JSON.stringify([null, "", "all"]) })).toString("base64url");
  await expect(readDataStudioCatalog(pool, owner, { cursor, search: "changed" })).rejects.toThrow("cursor");
  expect(query).not.toHaveBeenCalled();
  await expect(readDataStudioCatalog(pool, owner, { companyId: "foreign" })).rejects.toThrow("Company not found");
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[1]).toEqual([owner.workspaceId, owner.userId]);
});

it("never reads projects or environments when the requested workspace is not owned", async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  await expect(readDataStudioWorkspace({ query } as unknown as Pool, owner, "foreign", "backend")).rejects.toThrow("Database not found");
  expect(query).toHaveBeenCalledTimes(1);
});

it("validates batch count requests and enforces project ownership before the count query", async () => {
  const countOwnerRows = vi.fn(async () => ({ orders: 7, users: 12 }));
  const getProject = vi.fn(async (context: AuthContext) => {
    if (context.userId !== "owner") throw new WorkspaceAccessError("Forbidden project");
    return { dataBackendId: "backend" };
  });
  const service = new DataStudioUiService({ getProject } as unknown as WorkspaceStore,
    { get: async () => ({ id: "backend" }), environment: async () => ({}) } as unknown as DataBackendRepository,
    {} as DataProvider, { countOwnerRows } as unknown as ProjectMigrationEngine);
  const app = Fastify();
  let context = owner;
  registerDataStudioRoutes(app, { authenticate: async () => context }, service);
  const url = "/companies/company/projects/project/data-studio/dev/collections/counts";
  try {
    const response = await app.inject({ method: "POST", url, payload: { collections: ["orders", "users"] } });
    expect(response.statusCode).toBe(200); expect(response.json().counts).toEqual({ orders: 7, users: 12 });
    expect(response.json().exact).toBe(true);
    for (const collections of [[], ["orders", "orders"], ["orders;DROP TABLE users"], Array.from({ length: 51 }, (_, i) => `table_${i}`)]) {
      expect((await app.inject({ method: "POST", url, payload: { collections } })).statusCode).toBe(400);
    }
    context = { ...owner, userId: "intruder" };
    expect((await app.inject({ method: "POST", url, payload: { collections: ["orders"] } })).statusCode).toBe(403);
    expect(countOwnerRows).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it("inspects a multi-table schema in five queries while preserving table metadata and fingerprint shape", async () => {
  const provider = new PostgresDataProvider();
  const table = (name: string) => ({ name, rlsEnabled: true, rlsForced: true });
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM pg_class c JOIN pg_namespace")) return { rows: [table("orders"), table("users")] };
    if (sql.includes("FROM pg_attribute")) return { rows: [{ tableName: "orders", name: "id", type: "uuid", nullable: false }] };
    if (sql.includes("FROM pg_constraint")) return { rows: [{ tableName: "orders", definition: "orders_pkey:PRIMARY KEY (id)" }] };
    if (sql.includes("FROM pg_indexes")) return { rows: [{ tableName: "orders", definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)" }] };
    return { rows: [] };
  });
  const poolSpy = vi.spyOn(provider as unknown as { pool(): Promise<Pool> }, "pool").mockResolvedValue({ query } as unknown as Pool);
  try {
    const schema = await provider.introspectSchema({ id: "backend" } as never, "dev");
    expect(query).toHaveBeenCalledTimes(5);
    expect(schema.tables[0]).toEqual({ ...table("orders"), columns: [{ name: "id", type: "uuid", nullable: false }],
      constraints: ["orders_pkey:PRIMARY KEY (id)"], indexes: ["CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)"], policies: [] });
    expect(schema.tables[1]).toEqual({ ...table("users"), columns: [], constraints: [], indexes: [], policies: [] });
  } finally { poolSpy.mockRestore(); }
});
