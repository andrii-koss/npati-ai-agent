import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { registerProjectRoutes } from "../apps/agent-api/src/project-routes";
import { rewriteBrowserApiUrl } from "../apps/agent-api/src/web-frontend";
import { projectCatalogQuery } from "../packages/workspace/src/postgres-project-catalog";

const owner: AuthContext = { workspaceId: "catalog-ws", userId: "catalog-owner", permissions: ["workspace:read", "business:manage"] };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture() {
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  const a = await store.createCompany(owner, { name: "A" }, "company-a");
  const b = await store.createCompany(owner, { name: "B" }, "company-b");
  for (let i = 0; i < 61; i++) {
    const company = i % 2 ? a : b;
    const { project } = await store.createProject(owner, company.id, { name: `Project ${i}`, description: i === 3 ? "needle 100%_" : "", type: "code_project", kind: i % 2 ? "game" : "api" }, `project-${i}`);
    if (i === 5) await store.archiveProject(owner, company.id, project.id, project.revision);
    if (i === 6) await store.softDeleteProject(owner, company.id, project.id);
  }
  let context = owner;
  const app = Fastify({ rewriteUrl: rewriteBrowserApiUrl }); apps.push(app);
  registerProjectRoutes(app, new ProjectService(store), { authenticate: async () => context });
  return { app, store, a, b, setContext: (next: AuthContext) => { context = next; } };
}
describe("Projects server catalog", () => {
  it("bounds the PostgreSQL query to six cards plus one cursor lookahead row", () => {
    const query = projectCatalogQuery(owner, { search: "bakery", kind: "website" });
    expect(query.text).toContain("ORDER BY p.created_at DESC,p.id ASC LIMIT 7");
    expect(query.text).toContain("p.created_by=$2");
    expect(query.values).toContain("%bakery%");
  });
  it("serves the browser's /api/projects/catalog URL through the production URL rewrite", async () => {
    const { app } = await fixture();
    const response = await app.inject({ url: "/api/projects/catalog?status=all" });
    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toHaveLength(6);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
  it("pages 6 items with no duplicates, hides deleted projects and retains archived in All", async () => {
    const { app } = await fixture();
    const seen = new Set<string>(); let cursor: string | null = null;
    do {
      const response = await app.inject({ url: `/projects/catalog${cursor ? `?cursor=${cursor}` : ""}` });
      expect(response.statusCode).toBe(200);
      const page = response.json(); expect(page.projects.length).toBeLessThanOrEqual(6);
      for (const row of page.projects) { expect(seen.has(row.id)).toBe(false); seen.add(row.id); expect(row).not.toHaveProperty("sandboxId"); }
      cursor = page.pagination.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(60);
    expect((await app.inject({ url: "/projects/catalog?status=archived" })).json().projects).toHaveLength(1);
  });
  it("searches and filters server-side and rejects cursors reused with another filter", async () => {
    const { app, a } = await fixture();
    expect((await app.inject({ url: "/projects/catalog?search=100%25_" })).json().projects).toHaveLength(1);
    const first = (await app.inject({ url: `/projects/catalog?companyId=${a.id}&kind=game` })).json();
    expect(first.projects).toHaveLength(6);
    expect(first.projects.every((p: { companyId: string; kind: string }) => p.companyId === a.id && p.kind === "game")).toBe(true);
    expect((await app.inject({ url: `/projects/catalog?cursor=${first.pagination.nextCursor}` })).statusCode).toBe(400);
    expect((await app.inject({ url: "/projects/catalog?kind=unknown" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/projects/catalog?cursor=broken" })).statusCode).toBe(400);
  });
  it("enforces RBAC, workspace, ownership and scoped credentials on every page", async () => {
    const { app, a, b, setContext } = await fixture();
    setContext({ ...owner, permissions: [] }); expect((await app.inject({ url: "/projects/catalog" })).statusCode).toBe(403);
    setContext({ ...owner, userId: "other" }); expect((await app.inject({ url: "/projects/catalog" })).json().projects).toEqual([]);
    setContext({ ...owner, workspaceId: "other" }); expect((await app.inject({ url: "/projects/catalog" })).json().projects).toEqual([]);
    setContext({ ...owner, companyId: a.id });
    expect((await app.inject({ url: "/projects/catalog" })).json().projects.every((p: { companyId: string }) => p.companyId === a.id)).toBe(true);
    expect((await app.inject({ url: `/projects/catalog?companyId=${b.id}` })).statusCode).toBe(403);
  });
});
