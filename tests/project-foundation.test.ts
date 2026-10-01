import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { registerProjectRoutes } from "../apps/agent-api/src/project-routes";
import { runMigration054, rollbackMigration054 } from "../packages/workspace/src/migration-054";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function setup() {
  const store = new InMemoryWorkspaceStore();
  const owner: AuthContext = { workspaceId: "workspace-1", userId: "owner-1", permissions: ["workspace:read", "business:manage"] };
  const other: AuthContext = { workspaceId: "workspace-1", userId: "owner-2", permissions: ["workspace:read", "business:manage"] };
  const companyA = await store.createCompany(owner, { name: "Company A" }, "company-a");
  const companyB = await store.createCompany(other, { name: "Company B" }, "company-b");
  let context = owner;
  const auth: AuthProvider = { authenticate: async () => context };
  const app = Fastify();
  registerProjectRoutes(app, new ProjectService(store), auth);
  apps.push(app);
  await app.ready();
  const path = (companyId: string) => "/companies/" + companyId + "/projects";
  return { app, store, owner, other, companyA, companyB, path, as: (next: AuthContext) => { context = next; } };
}

describe("Project foundation", () => {
  it("creates, reads, renames, archives, lists, and deletes a project", async () => {
    const { app, companyA, path } = await setup();
    const base = path(companyA.id);
    const created = await app.inject({ method: "POST", url: base, headers: { "idempotency-key": "project-create-001" },
      payload: { name: "  Landing Page  ", type: "landing_page", description: "A page" } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({ name: "Landing Page", type: "landing_page", status: "ready", revision: 1 });
    const repeated = await app.inject({ method: "POST", url: base, headers: { "idempotency-key": "project-create-001" },
      payload: { name: "Landing Page", type: "landing_page" } });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().id).toBe(project.id);
    expect((await app.inject({ method: "GET", url: base })).json().projects).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: base + "/" + project.id })).json().id).toBe(project.id);

    const renamed = await app.inject({ method: "PATCH", url: base + "/" + project.id,
      payload: { name: "New Name", expectedRevision: 1 } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "New Name", revision: 2 });
    expect((await app.inject({ method: "PATCH", url: base + "/" + project.id,
      payload: { name: "Stale", expectedRevision: 1 } })).statusCode).toBe(409);

    const archived = await app.inject({ method: "POST", url: base + "/" + project.id + "/archive",
      payload: { expectedRevision: 2 } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("archived");
    expect((await app.inject({ method: "GET", url: base })).json().projects).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: base + "?includeArchived=true" })).json().projects).toHaveLength(1);
    expect((await app.inject({ method: "PATCH", url: base + "/" + project.id,
      payload: { name: "Cannot rename", expectedRevision: 3 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: base + "/" + project.id })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: base + "/" + project.id })).statusCode).toBe(404);
  });

  it("rejects cross-company and cross-user project IDs for every operation", async () => {
    const { app, companyA, companyB, owner, other, path, as } = await setup();
    const created = await app.inject({ method: "POST", url: path(companyA.id), headers: { "idempotency-key": "project-owner-001" },
      payload: { name: "Private", type: "website" } });
    const projectId = created.json().id;
    as(other);
    expect((await app.inject({ method: "GET", url: path(companyA.id) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: path(companyA.id), headers: { "idempotency-key": "project-owner-002" },
      payload: { name: "Intrusion", type: "website" } })).statusCode).toBe(403);
    for (const request of [
      { method: "GET" as const, url: path(companyB.id) + "/" + projectId },
      { method: "PATCH" as const, url: path(companyB.id) + "/" + projectId, payload: { name: "Intrusion", expectedRevision: 1 } },
      { method: "POST" as const, url: path(companyB.id) + "/" + projectId + "/archive", payload: { expectedRevision: 1 } },
      { method: "DELETE" as const, url: path(companyB.id) + "/" + projectId },
    ]) expect((await app.inject(request)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: path(companyB.id) })).json().projects).toHaveLength(0);
    as(owner);
    expect((await app.inject({ method: "GET", url: path(companyA.id) + "/" + projectId })).statusCode).toBe(200);
  });

  it("requires Company permissions and rejects forged project fields", async () => {
    const { app, companyA, owner, path, as } = await setup();
    as({ ...owner, permissions: ["workspace:read"] });
    expect((await app.inject({ method: "POST", url: path(companyA.id), headers: { "idempotency-key": "project-no-write" },
      payload: { name: "Blocked", type: "website" } })).statusCode).toBe(403);
    as(owner);
    const forged = await app.inject({ method: "POST", url: path(companyA.id), headers: { "idempotency-key": "project-forged" },
      payload: { name: "Forged", type: "website", workspaceId: "other", companyId: "other" } });
    expect(forged.statusCode).toBe(201);
    expect(forged.json()).toMatchObject({ workspaceId: owner.workspaceId, companyId: companyA.id, createdBy: owner.userId });
  });

  it("has reversible migration operations", async () => {
    const statements: string[] = [];
    const client = { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 }; } };
    await runMigration054(client as never);
    await rollbackMigration054(client as never);
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS projects");
    expect(statements[0]).toContain("company_agent_runs_project_fk");
    expect(statements[1]).toContain("DROP TABLE IF EXISTS projects");
    expect(statements[1]).toContain("DROP COLUMN IF EXISTS project_id");
  });
});

