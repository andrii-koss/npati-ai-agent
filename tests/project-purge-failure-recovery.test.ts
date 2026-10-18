import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, WorkspaceAccessError, type AuthContext } from "@npati/workspace";
import { ProjectLifecycleService } from "../apps/agent-api/src/project-lifecycle-service";
import type { ProjectService } from "../apps/agent-api/src/project-service";
import type { ProjectMediaService } from "../apps/agent-api/src/project-media-service";

async function fixture() {
  const ctx: AuthContext = { workspaceId: "purge-test", userId: "owner", role: "owner", permissions: ["workspace:read", "workspace:write", "business:manage"] };
  const store = new InMemoryWorkspaceStore();
  await store.initialize(ctx);
  const company = await store.createCompany(ctx, { name: "Disposable purge fixture" }, "company");
  const { project } = await store.createProject(ctx, company.id, { name: "Disposable site", type: "website" }, "project");
  await store.softDeleteProject(ctx, company.id, project.id, "test", new Date(0).toISOString());
  const projects = { get: (c: AuthContext, co: string, id: string) => store.getProject(c, co, id) } as ProjectService;
  return { ctx, store, company, project, projects };
}

describe("security-gate: Project purge failure recovery", () => {
  it("retains project metadata after media failure and retries without claiming false success", async () => {
    const f = await fixture();
    const purgeProjectMedia = vi.fn().mockRejectedValueOnce(new Error("storage offline")).mockResolvedValue({ deletedCount: 1, deletedBytes: 12 });
    const deleteProject = vi.spyOn(f.store, "deleteProject");
    const service = new ProjectLifecycleService({ store: f.store, projects: f.projects, mediaService: { purgeProjectMedia } as unknown as ProjectMediaService });
    await expect(service.hardPurge(f.ctx, f.company.id, f.project.id)).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect(deleteProject).not.toHaveBeenCalled();
    expect((await f.store.getProject(f.ctx, f.company.id, f.project.id)).status).toBe("purging");
    await expect(service.hardPurge(f.ctx, f.company.id, f.project.id)).resolves.toMatchObject({ status: "purged", purged: { mediaObjects: 1 } });
    expect(deleteProject).toHaveBeenCalledTimes(1);
  });
  it("retains project metadata when workspace removal reports an incomplete result", async () => {
    const f = await fixture();
    const removeWorkspace = vi.fn().mockResolvedValue({ removed: false, reason: "busy" });
    const service = new ProjectLifecycleService({ store: f.store, projects: f.projects, removeWorkspace });
    await expect(service.hardPurge(f.ctx, f.company.id, f.project.id)).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect(await f.store.getProject(f.ctx, f.company.id, f.project.id)).toMatchObject({ status: "purging" });
  });
  it("does not turn authorization failures into an already-purged success", async () => {
    const f = await fixture();
    const error = new WorkspaceAccessError("Foreign project");
    const projects = { get: vi.fn().mockRejectedValue(error) } as unknown as ProjectService;
    const service = new ProjectLifecycleService({ store: f.store, projects });
    await expect(service.hardPurge(f.ctx, f.company.id, f.project.id)).rejects.toBe(error);
  });
  it("does not begin cleanup when the purging-state write fails", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "transitionProjectToPurging").mockRejectedValue(new Error("database unavailable"));
    const removeWorkspace = vi.fn().mockResolvedValue({ removed: true });
    const service = new ProjectLifecycleService({ store: f.store, projects: f.projects, removeWorkspace });
    await expect(service.hardPurge(f.ctx, f.company.id, f.project.id)).rejects.toThrow("database unavailable");
    expect(removeWorkspace).not.toHaveBeenCalled();
    expect((await f.store.getProject(f.ctx, f.company.id, f.project.id)).status).toBe("soft_deleted");
  });
  it("a restarted retention worker retries interrupted purging projects", async () => {
    const f = await fixture();
    const purgeProjectMedia = vi.fn().mockRejectedValueOnce(new Error("storage offline")).mockResolvedValue({ deletedCount: 1, deletedBytes: 12 });
    const deps = { store: f.store, projects: f.projects, mediaService: { purgeProjectMedia } as unknown as ProjectMediaService };
    await expect(new ProjectLifecycleService(deps).purgeExpiredProjects(f.ctx)).resolves.toEqual({ processed: 0, errors: 1 });
    expect((await f.store.getProject(f.ctx, f.company.id, f.project.id)).status).toBe("purging");
    await expect(new ProjectLifecycleService(deps).purgeExpiredProjects(f.ctx)).resolves.toEqual({ processed: 1, errors: 0 });
    await expect(f.store.getProject(f.ctx, f.company.id, f.project.id)).rejects.toThrow(/not found/i);
  });
});
