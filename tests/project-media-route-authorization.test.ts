import { Readable } from "node:stream";
import { createC3ProofFixture } from "./support/c3-workspace-proof";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceAccessError, type AuthContext } from "@npati/workspace";
import { registerProjectFileRoutes } from "../apps/agent-api/src/project-file-routes";
import type { ProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import type { ProjectMediaService } from "../apps/agent-api/src/project-media-service";
import type { ProjectService } from "../apps/agent-api/src/project-service";

describe("Project media route authorization", () => {
  const base: AuthContext = { userId: "owner", workspaceId: "workspace", companyId: "company-a", permissions: ["workspace:read"] };
  async function request(context: AuthContext, deniedProject = false) {
    const app = Fastify();
    const listMedia = vi.fn(async () => ({ items: [] }));
    const get = vi.fn(async () => {
      if (deniedProject) throw new WorkspaceAccessError("Project is outside caller workspace");
      return {};
    });
    registerProjectFileRoutes(app, {} as ProjectWorkspace, { authenticate: async () => context },
      { listMedia } as unknown as ProjectMediaService, { get } as unknown as ProjectService);
    try {
      const response = await app.inject({ method: "GET", url: "/companies/company-a/projects/project-b/media" });
      return { response, listMedia, get };
    } finally { await app.close(); }
  }
  it("rejects a foreign company before accessing media", async () => {
    const { response, listMedia, get } = await request({ ...base, companyId: "company-other" });
    expect(response.statusCode).toBe(403);
    expect(listMedia).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it("preserves an optional trusted-provider project scope restriction", async () => {
    const scoped: AuthContext & { projectId: string } = { ...base, projectId: "project-a" };
    const { response, listMedia, get } = await request(scoped);
    expect(response.statusCode).toBe(403);
    expect(listMedia).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it("requires the existing project ownership lookup for an ordinary platform context", async () => {
    const { response, listMedia, get } = await request(base, true);
    expect(response.statusCode).toBe(403);
    expect(get).toHaveBeenCalledWith(base, "company-a", "project-b");
    expect(listMedia).not.toHaveBeenCalled();
  });
  it("allows an authorized project after the ownership lookup", async () => {
    const { response, listMedia, get } = await request(base);
    expect(response.statusCode).toBe(200);
    expect(get).toHaveBeenCalledWith(base, "company-a", "project-b");
    expect(listMedia).toHaveBeenCalledWith("company-a", "project-b", undefined);
  });
});

describe("Public project media lifecycle boundary", () => {
  async function request(state: "ready" | "soft_deleted" | "purging" | "deleted" | "unavailable", mimeType = "image/png") {
    const f = await createC3ProofFixture();
    const app = Fastify();
    const bytes = mimeType === "image/svg+xml" ? Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>") : Buffer.from([0, 128, 255, 13, 10]);
    const getMedia = vi.fn(async () => ({ stream: Readable.from(bytes), mimeType }));
    try {
      if (state !== "ready" && state !== "unavailable") await f.store.softDeleteProject(f.ctx, f.company.id, f.project.id, "test");
      if (state === "purging") await f.store.transitionProjectToPurging(f.ctx, f.company.id, f.project.id);
      if (state === "deleted") await f.store.deleteProject(f.ctx, f.company.id, f.project.id);
      if (state === "unavailable") vi.spyOn(f.store, "getProjectForSystem").mockRejectedValue(new Error("metadata unavailable"));
      const projects = { store: f.store, get: (ctx: typeof f.ctx, companyId: string, projectId: string) => f.store.getProject(ctx, companyId, projectId) } as unknown as ProjectService;
      registerProjectFileRoutes(app, f.workspace, { authenticate: async () => f.ctx }, { getMedia } as unknown as ProjectMediaService, projects);
      const response = await app.inject({ method: "GET", url: "/api/projects/" + f.project.id + "/media/assets/logo.png" });
      return { response, getMedia, bytes };
    } finally { await app.close(); await f.cleanup(); }
  }
  it.each(["soft_deleted", "purging", "deleted"] as const)("refuses %s media even when the project directory still exists", async state => {
    const { response, getMedia } = await request(state);
    expect(response.statusCode).toBe(404);
    expect(getMedia).not.toHaveBeenCalled();
  });
  it("fails closed when authoritative project state cannot be read", async () => {
    const { response, getMedia } = await request("unavailable");
    expect(response.statusCode).toBe(503);
    expect(getMedia).not.toHaveBeenCalled();
  });
  it.each(["image/png", "image/svg+xml"])("serves active %s bytes with browser security headers", async mimeType => {
    const { response, bytes } = await request("ready", mimeType);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    if (mimeType === "image/svg+xml") expect(response.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'");
  });
});
