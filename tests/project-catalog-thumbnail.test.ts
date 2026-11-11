import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { ProjectBrowserQaService } from "../apps/agent-api/src/project-browser-qa-service";
import { registerProjectQaRoutes } from "../apps/agent-api/src/project-qa-routes";
const owner: AuthContext = { workspaceId: "thumb-ws", userId: "thumb-owner", permissions: ["workspace:read", "business:manage"] };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture() {
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  const company = await store.createCompany(owner, { name: "Thumbnails" }, "thumb-company");
  const { project } = await store.createProject(owner, company.id, { name: "Site", type: "website" }, "thumb-project");
  const service = new ProjectBrowserQaService(new ProjectService(store), store);
  const inspect = vi.spyOn(service, "inspect");
  let context = owner;
  const app = Fastify(); apps.push(app); registerProjectQaRoutes(app, service, { authenticate: async () => context });
  return { store, company, project, inspect, app, setContext: (ctx: AuthContext) => { context = ctx; }, url: `/companies/${company.id}/projects/${project.id}/qa/thumbnail` };
}
describe("saved catalog screenshots", () => {
  it("returns a missing snapshot without starting preview or browser inspection", async () => {
    const f = await fixture();
    const response = await f.app.inject({ url: f.url });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ thumbnail: null }); expect(f.inspect).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
  it.each(["image/png", "image/webp"])("serves saved %s captures and keeps project ownership and credential scope", async mimeType => {
    const f = await fixture();
    const screenshot = { name: "desktop", viewport: { width: 1280, height: 800 }, mimeType, hasDetail: true, base64Data: "test-fixture", sizeBytes: 12, captureMode: "visual" as const };
    await f.store.createProjectQaReport(owner, f.company.id, f.project.id, { status: "passed", targetUrl: "/preview", summary: "Screenshot", issues: [], metrics: {} as never, screenshots: [screenshot] });
    const response = await f.app.inject({ url: f.url });
    expect(response.json().thumbnail.dataUrl).toBe(`data:${mimeType};base64,test-fixture`);
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.headers.vary).toBe("Authorization");
    await f.store.createProjectQaReport(owner, f.company.id, f.project.id, { status: "passed", targetUrl: "/preview", summary: "Console check only", issues: [], metrics: {} as never, screenshots: [] });
    expect((await f.app.inject({ url: f.url })).json().thumbnail.dataUrl).toBe(`data:${mimeType};base64,test-fixture`);
    f.setContext({ ...owner, userId: "other" }); expect((await f.app.inject({ url: f.url })).statusCode).toBe(403);
    f.setContext({ ...owner, companyId: "other-company" }); expect((await f.app.inject({ url: f.url })).statusCode).toBe(403);
    f.setContext({ ...owner, permissions: [] }); expect((await f.app.inject({ url: f.url })).statusCode).toBe(403);
  });
  it("requires an explicit authorized capture and requests actual pixels", async () => {
    const f = await fixture();
    f.setContext({ ...owner, permissions: ["workspace:read"] });
    expect((await f.app.inject({ method: "POST", url: f.url })).statusCode).toBe(403); expect(f.inspect).not.toHaveBeenCalled();
    f.setContext(owner);
    f.inspect.mockResolvedValueOnce({ report: { createdAt: "2026-10-29" }, screenshots: [{ captureMode: "visual", mimeType: "image/webp", base64Data: "pixels" }] } as never);
    const response = await f.app.inject({ method: "POST", url: f.url });
    expect(response.statusCode).toBe(200);
    expect(response.json().thumbnail.dataUrl).toBe("data:image/webp;base64,pixels");
    expect(f.inspect).toHaveBeenCalledWith(owner, f.company.id, expect.objectContaining({ projectId: f.project.id, screenshotMode: "visual", checks: ["screenshot"], maxScreenshotBytes: 2_000_000 }));
  });
});
