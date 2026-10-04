import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkspaceStore, type AuthContext } from "@npati/workspace";
import { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import { SharedPostgresProvisioner } from "../apps/agent-api/src/data-studio/provisioner";
import { PostgresDataProvider } from "../apps/agent-api/src/data-studio/data-provider";
import { ProjectMigrationEngine } from "../apps/agent-api/src/data-studio/migration-engine";
import { DataBackendService } from "../apps/agent-api/src/data-studio/service";

const coreUrl = process.env.NPATI_DATA_TEST_CORE_URL;
const adminPassword = process.env.NPATI_DATA_TEST_PROJECTS_ADMIN_PASSWORD;
const adminHost = process.env.NPATI_DATA_TEST_PROJECTS_HOST || "127.0.0.1";
const adminPort = Number(process.env.NPATI_DATA_TEST_PROJECTS_PORT) || 5432;

describe.skipIf(!coreUrl || !adminPassword)("Data Studio PostgreSQL integration", () => {
  it("provisions isolated roles, applies migrations with RLS, detects drift and deprovisions", async () => {
    const suffix = randomUUID().slice(0, 8);
    const store = new PostgresWorkspaceStore(coreUrl!);
    await store.initialize();
    const ownerA: AuthContext = { workspaceId: "data-test-" + suffix, userId: "owner-a", permissions: ["workspace:read", "business:manage"] };
    const ownerB: AuthContext = { workspaceId: "data-test-" + suffix, userId: "owner-b", permissions: ["workspace:read", "business:manage"] };
    const companyA = await store.createCompany(ownerA, { name: "Data A" }, "company-a-" + suffix);
    const companyB = await store.createCompany(ownerB, { name: "Data B" }, "company-b-" + suffix);
    const project1 = (await store.createProject(ownerA, companyA.id, { name: "Site 1", type: "website" }, "site-1-" + suffix)).project;
    const project2 = (await store.createProject(ownerA, companyA.id, { name: "Site 2", type: "website" }, "site-2-" + suffix)).project;
    const projectB = (await store.createProject(ownerB, companyB.id, { name: "Site B", type: "website" }, "site-b-" + suffix)).project;
    const repository = new DataBackendRepository(coreUrl!);
    const provisioner = new SharedPostgresProvisioner({
      host: adminHost, port: adminPort, adminUser: process.env.NPATI_DATA_TEST_PROJECTS_ADMIN_USER || "npati_projects_admin",
      adminPassword: adminPassword!, maintenanceDatabase: "postgres",
      snapshotDirectory: process.env.NPATI_DATA_TEST_SNAPSHOT_DIR || ".data/data-studio-test-snapshots",
    }, repository);
    const provider = new PostgresDataProvider({}, provisioner);
    const service = new DataBackendService(store, repository, provisioner, provider);
    const migrations = new ProjectMigrationEngine(provisioner, provider, repository);
    const backendA = await service.create(ownerA, companyA.id, { name: "Backend A" });
    const backendB = await service.create(ownerB, companyB.id, { name: "Backend B" });
    try {
      expect((await service.attach(ownerA, companyA.id, project1.id, backendA.id)).dataBackendId).toBe(backendA.id);
      expect((await service.attach(ownerA, companyA.id, project2.id, backendA.id)).dataBackendId).toBe(backendA.id);
      await expect(service.attach(ownerA, companyA.id, projectB.id, backendA.id)).rejects.toThrow();
      await expect(service.attach(ownerA, companyA.id, project1.id, backendB.id)).rejects.toThrow();

      const runtimeA = await provisioner.getConnection(backendA, "dev", "runtime");
      const migratorA = await provisioner.getConnection(backendA, "dev", "migrator");
      const runtimePool = new Pool(runtimeA);
      const migratorPool = new Pool(migratorA);
      try {
        const roles = await runtimePool.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user");
        expect(roles.rows[0]).toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
        await expect(runtimePool.query("CREATE TABLE denied(id integer)")).rejects.toThrow();
        const cross = new Pool({ ...runtimeA, database: (await provisioner.getConnection(backendB, "dev", "runtime")).database, connectionTimeoutMillis: 1000 });
        try { await expect(cross.query("SELECT 1")).rejects.toThrow(); } finally { await cross.end(); }

        const created = await migrations.apply(ownerA, {
          backend: backendA, environment: "dev", authorId: ownerA.userId,
          operation: { kind: "create_collection", collection: "items", fields: [{ name: "title", type: "string" }] },
        });
        expect(created.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        await migrations.apply(ownerA, { backend: backendA, environment: "dev", authorId: ownerA.userId,
          operation: { kind: "create_collection", collection: "categories", fields: [{ name: "name", type: "string" }] } });
        await migrations.apply(ownerA, { backend: backendA, environment: "dev", authorId: ownerA.userId,
          operation: { kind: "create_relation", collection: "items", target: "categories", name: "category_id", cardinality: "many-to-one" } });
        const table = await migratorPool.query("SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public' AND tablename='items'");
        expect(table.rows[0].tableowner).toBe(migratorA.user);
        const flags = await migratorPool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='items'");
        expect(flags.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
        await expect(runtimePool.query("SELECT * FROM items")).rejects.toThrow();
        await migratorPool.query("GRANT SELECT,INSERT,UPDATE,DELETE ON items TO " + '"' + runtimeA.user + '"');
        expect((await runtimePool.query("SELECT * FROM items")).rows).toEqual([]);
        const renamed = await migrations.apply(ownerA, {
          backend: backendA, environment: "dev", authorId: ownerA.userId,
          operation: { kind: "rename_collection", collection: "items", next: "renamed_items" },
        });
        await migrations.rollback(ownerA, backendA, "dev", renamed.id);
        await migratorPool.query("CREATE POLICY test_allow ON items FOR ALL TO " + '"' + runtimeA.user + '"' + " USING (true) WITH CHECK (true)");
        await runtimePool.query("INSERT INTO items(title) VALUES($1)", ["x' OR true --"]);
        expect((await runtimePool.query("SELECT title FROM items")).rows).toEqual([{ title: "x' OR true --" }]);
        expect((await migrations.detectDrift(ownerA, backendA, "dev")).status).toBe("drift_detected");
        await expect(migrations.apply(ownerA, {
          backend: backendA, environment: "dev", authorId: ownerA.userId,
          operation: { kind: "add_field", collection: "items", field: { name: "note", type: "text" } },
        })).rejects.toThrow();
      } finally { await runtimePool.end(); await migratorPool.end(); }
      await store.deleteProject(ownerA, companyA.id, project1.id);
      expect((await repository.get(ownerA, companyA.id, backendA.id)).id).toBe(backendA.id);
      await store.deleteProject(ownerA, companyA.id, project2.id);
      await service.remove(ownerA, companyA.id, backendA.id, backendA.name);
      await expect(repository.get(ownerA, companyA.id, backendA.id)).rejects.toThrow();
      await service.archive(ownerB, companyB.id, backendB.id);
      const archivedRuntime = new Pool({ ...await provisioner.getConnection(backendB, "dev", "runtime"), connectionTimeoutMillis: 1000 });
      try { await expect(archivedRuntime.query("SELECT 1")).rejects.toThrow(); } finally { await archivedRuntime.end(); }
    } finally {
      await store.deleteProject(ownerB, companyB.id, projectB.id).catch(() => undefined);
      await service.remove(ownerB, companyB.id, backendB.id, backendB.name).catch(() => undefined);
      await provider.close();
      await provisioner.close();
      await repository.close();
      await store.close?.();
    }
  }, 120_000);
});
