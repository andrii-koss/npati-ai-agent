import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type AuthContext,
  type Project,
  InMemoryWorkspaceStore,
} from "@npati/workspace";
import { ProjectLifecycleService } from "../apps/agent-api/src/project-lifecycle-service";
import { sanitizeSvg } from "../apps/agent-api/src/svg-sanitizer";
import {
  registerCodeProjectLifecycleRoutes,
  type CodeProjectLifecycleDeps,
} from "../apps/agent-api/src/code-project-lifecycle-routes";

const COMPANY = "company-lifecycle-1";
const OTHER_COMPANY = "company-lifecycle-2";
const PROJECT_A = "project-alpha";
const PROJECT_B = "project-beta";
const BACKEND_ID = "backend-shared-123";

function makeContext(companyId = COMPANY, userId = "user-1"): AuthContext {
  return {
    workspaceId: "ws-test",
    companyId,
    userId,
    permissions: ["workspace:read", "workspace:write", "business:manage"],
    role: "owner",
  } as AuthContext;
}

interface Route {
  method: string;
  url: string;
  handler: (request: any, reply: any) => Promise<any>;
}

function fakeInstance(routes: Route[]): FastifyInstance {
  const record = (method: string) => (url: string, handler: Route["handler"]) => {
    routes.push({ method, url, handler });
  };
  return {
    get: record("get"),
    post: record("post"),
    patch: record("patch"),
    delete: record("delete"),
  } as unknown as FastifyInstance;
}

function fakeReply(): { reply: FastifyReply; state: { status: number; body: unknown } } {
  const state = { status: 200, body: undefined as unknown };
  const reply = {
    code(status: number) {
      state.status = status;
      return reply;
    },
    send(payload: unknown) {
      state.body = payload;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, state };
}

async function createTestStore(): Promise<{ store: InMemoryWorkspaceStore; ctx: AuthContext }> {
  const store = new InMemoryWorkspaceStore();
  const timestamp = new Date().toISOString();
  (store as any).companies.set(COMPANY, {
    id: COMPANY,
    workspaceId: "ws-test",
    userId: "user-1",
    name: "Test Co",
    status: "active",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const ctx = makeContext(COMPANY);
  return { store, ctx };
}

describe("Stage 5: Delete Website Lifecycle — Dry Run Delete Plan", () => {
  it("computes exact dedicated and shared resources without modifying project state", async () => {
    const { store, ctx } = await createTestStore();

    const created = await store.createProject(ctx, COMPANY, {
      name: "Alpha Web",
      type: "website",
      dataBackendId: BACKEND_ID,
    }, "key-1");
    const project = created.project;

    const stopPreview = vi.fn();
    const stopSandbox = vi.fn();
    const destroySandbox = vi.fn();
    const detachProjectCors = vi.fn();
    const removeWorkspace = vi.fn();

    const lifecycle = new ProjectLifecycleService({
      store,
      projects: {
        get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id),
      } as any,
      previewService: { stopPreview } as any,
      sandboxService: { stop: stopSandbox, destroy: destroySandbox } as any,
      dataBackendService: { detachProjectCors } as any,
      removeWorkspace,
    });

    const plan = await lifecycle.getDeletePlan(ctx, COMPANY, project.id);

    expect(plan.projectId).toBe(project.id);
    expect(plan.companyId).toBe(COMPANY);
    expect(plan.currentStatus).toBe("ready");
    expect(plan.lifecyclePlan.dryRun).toBe(true);
    expect(plan.lifecyclePlan.retentionDays).toBe(30);

    // Dedicated resources
    const dedicatedTypes = plan.resources.dedicated.map((r) => r.type);
    expect(dedicatedTypes).toContain("sandbox_runtime");
    expect(dedicatedTypes).toContain("workspace_files");
    expect(dedicatedTypes).toContain("media_assets");
    expect(dedicatedTypes).toContain("project_database_records");

    // Shared resources
    const sharedTypes = plan.resources.shared.map((r) => r.type);
    expect(sharedTypes).toContain("data_backend");
    const backendRes = plan.resources.shared.find((r) => r.type === "data_backend");
    expect(backendRes?.details?.preservationGuaranteed).toBe(true);
    expect(backendRes?.details?.dropDatabaseExecuted).toBe(false);

    // Zero mutations executed
    expect(stopPreview).not.toHaveBeenCalled();
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(destroySandbox).not.toHaveBeenCalled();
    expect(detachProjectCors).not.toHaveBeenCalled();
    expect(removeWorkspace).not.toHaveBeenCalled();

    // Project state unchanged
    const current = await store.getProject(ctx, COMPANY, project.id);
    expect(current.status).toBe("ready");
    expect(current.deletedAt).toBeFalsy();
  });
});

describe("Stage 5: Delete Website Lifecycle — Soft Delete (Zero Data Loss)", () => {
  it("stops preview, stops sandbox processes, revokes CORS, but keeps files and DB intact for 30 days", async () => {
    const { store, ctx } = await createTestStore();

    const created = await store.createProject(ctx, COMPANY, {
      name: "Alpha Web",
      type: "website",
      dataBackendId: BACKEND_ID,
    }, "key-soft-1");
    const project = await store.setProjectSandbox(ctx, COMPANY, created.project.id, "sb-soft-123", null);

    const stopPreview = vi.fn().mockResolvedValue({ status: "stopped" });
    const stopSandbox = vi.fn().mockResolvedValue(true);
    const destroySandbox = vi.fn();
    const detachProjectCors = vi.fn().mockResolvedValue({ cleanedOrigins: 2 });
    const removeWorkspace = vi.fn();

    const lifecycle = new ProjectLifecycleService({
      store,
      projects: {
        get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id),
      } as any,
      previewService: { stopPreview } as any,
      sandboxService: { stop: stopSandbox, destroy: destroySandbox } as any,
      dataBackendService: { detachProjectCors } as any,
      removeWorkspace,
    });

    const result = await lifecycle.softDelete(ctx, COMPANY, project.id, { reason: "owner_request" });

    expect(result.status).toBe("soft_deleted");
    expect(result.retentionDays).toBe(30);
    expect(result.actions.previewStopped).toBe(true);
    expect(result.actions.sandboxProcessesStopped).toBe(true);
    expect(result.actions.corsRevoked).toBe(true);
    expect(result.actions.filesPreserved).toBe(true);
    expect(result.actions.databasePreserved).toBe(true);

    // Assert: stop was called, but destroySandbox and removeWorkspace were NEVER called
    expect(stopPreview).toHaveBeenCalledTimes(1);
    expect(stopSandbox).toHaveBeenCalledTimes(1);
    expect(destroySandbox).not.toHaveBeenCalled();
    expect(removeWorkspace).not.toHaveBeenCalled();

    // Verify DB record
    const updated = await store.getProject(ctx, COMPANY, project.id);
    expect(updated.status).toBe("soft_deleted");
    expect(updated.deletedAt).toBeTruthy();
    expect(updated.purgeAfter).toBeTruthy();
    expect(updated.dataBackendId).toBe(BACKEND_ID); // backend attachment preserved for recovery!
  });

  it("soft delete is idempotent on repeat calls", async () => {
    const { store, ctx } = await createTestStore();

    const created = await store.createProject(ctx, COMPANY, { name: "Idempotent Web", type: "website" }, "key-idemp");
    const lifecycle = new ProjectLifecycleService({
      store,
      projects: { get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id) } as any,
    });

    const first = await lifecycle.softDelete(ctx, COMPANY, created.project.id);
    expect(first.status).toBe("soft_deleted");

    const second = await lifecycle.softDelete(ctx, COMPANY, created.project.id);
    expect(second.status).toBe("soft_deleted");
    expect(second.alreadySoftDeleted).toBe(true);
  });
});

describe("Stage 5: Delete Website Lifecycle — Restore", () => {
  it("restores soft-deleted project to ready, clears purge schedule, and preserves data backend", async () => {
    const { store, ctx } = await createTestStore();

    const created = await store.createProject(ctx, COMPANY, {
      name: "Recoverable Web",
      type: "website",
      dataBackendId: BACKEND_ID,
    }, "key-rec-1");

    const lifecycle = new ProjectLifecycleService({
      store,
      projects: { get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id) } as any,
      dataBackendService: { get: vi.fn().mockResolvedValue({ id: BACKEND_ID, status: "ready" }) } as any,
    });

    // 1. Soft delete
    await lifecycle.softDelete(ctx, COMPANY, created.project.id);
    const softDeleted = await store.getProject(ctx, COMPANY, created.project.id);
    expect(softDeleted.status).toBe("soft_deleted");

    // 2. Restore
    const restored = await lifecycle.restore(ctx, COMPANY, created.project.id);
    expect(restored.status).toBe("ready");
    expect(restored.restored).toBe(true);
    expect(restored.restoredAt).toBeTruthy();

    const restoredProject = await store.getProject(ctx, COMPANY, created.project.id);
    expect(restoredProject.status).toBe("ready");
    expect(restoredProject.deletedAt).toBeNull();
    expect(restoredProject.purgeAfter).toBeNull();
    expect(restoredProject.dataBackendId).toBe(BACKEND_ID);
  });

  it("refuses to restore an active project", async () => {
    const { store, ctx } = await createTestStore();

    const created = await store.createProject(ctx, COMPANY, { name: "Active Web", type: "website" }, "key-act-1");
    const lifecycle = new ProjectLifecycleService({
      store,
      projects: { get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id) } as any,
    });

    await expect(lifecycle.restore(ctx, COMPANY, created.project.id)).rejects.toThrow(/Cannot restore project/);
  });
});

describe("Stage 5: Delete Website Lifecycle — Hard Purge", () => {
  it("refuses hard purge when retention has not expired unless force: true is specified", async () => {
    const { store, ctx } = await createTestStore();

    const created = await store.createProject(ctx, COMPANY, { name: "Purge Guard Web", type: "website" }, "key-guard-1");
    const lifecycle = new ProjectLifecycleService({
      store,
      projects: { get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id) } as any,
    });

    await lifecycle.softDelete(ctx, COMPANY, created.project.id);

    // Normal purge without force -> refused because 30 days have not passed
    await expect(lifecycle.hardPurge(ctx, COMPANY, created.project.id)).rejects.toThrow(/retention has not expired/);
  });

  it("refuses force: true hard purge if caller is not an owner or admin (e.g. developer or agent)", async () => {
    const { store, ctx } = await createTestStore();
    const devCtx: AuthContext = { ...ctx, role: "developer" };

    const created = await store.createProject(ctx, COMPANY, { name: "Dev Guard Web", type: "website" }, "key-dev-guard");
    const lifecycle = new ProjectLifecycleService({
      store,
      projects: { get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id) } as any,
    });

    await lifecycle.softDelete(ctx, COMPANY, created.project.id);

    // Developer tries force: true -> forbidden!
    await expect(lifecycle.hardPurge(devCtx, COMPANY, created.project.id, { force: true })).rejects.toThrow(/restricted to company owners and administrators/);
  });

  it("executes hard purge when force: true, cleaning dedicated files, MinIO media and preserving DataStudio DB", async () => {
    const { store, ctx } = await createTestStore();

    const created = await store.createProject(ctx, COMPANY, {
      name: "Purge Complete Web",
      type: "website",
      dataBackendId: BACKEND_ID,
    }, "key-purge-1");

    const purgeProjectMedia = vi.fn().mockResolvedValue({ deletedCount: 5, deletedBytes: 25000 });
    const destroySandbox = vi.fn().mockResolvedValue(true);
    const removeWorkspace = vi.fn().mockResolvedValue({ removed: true });
    const detachProjectArtifacts = vi.fn().mockResolvedValue({ detached: true, cleanedOrigins: 1, cleanedRedirects: 0 });

    const lifecycle = new ProjectLifecycleService({
      store,
      projects: { get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id) } as any,
      mediaService: { purgeProjectMedia } as any,
      sandboxService: { destroy: destroySandbox } as any,
      dataBackendService: { detachProjectArtifacts } as any,
      removeWorkspace,
    });

    await lifecycle.softDelete(ctx, COMPANY, created.project.id);

    const result = await lifecycle.hardPurge(ctx, COMPANY, created.project.id, { force: true });

    expect(result.status).toBe("purged");
    expect(result.purged.mediaObjects).toBe(5);
    expect(result.purged.mediaBytes).toBe(25000);
    expect(result.purged.sandboxDestroyed).toBe(true);
    expect(result.purged.workspaceRemoved).toBe(true);
    expect(result.purged.dataBackendPreserved).toBe(true);

    expect(purgeProjectMedia).toHaveBeenCalledWith(ctx, COMPANY, created.project.id);
    expect(destroySandbox).toHaveBeenCalledTimes(1);
    expect(removeWorkspace).toHaveBeenCalledWith(ctx, COMPANY, created.project.id);
    expect(detachProjectArtifacts).toHaveBeenCalledWith(ctx, COMPANY, created.project.id);

    // Project is gone from store
    await expect(store.getProject(ctx, COMPANY, created.project.id)).rejects.toThrow(/not found/i);

    // Repeat purge is idempotent
    const repeat = await lifecycle.hardPurge(ctx, COMPANY, created.project.id, { force: true });
    expect(repeat.status).toBe("purged");
    expect(repeat.alreadyPurged).toBe(true);
  });
});

describe("Stage 5: Multi-Project & Shared Resource Isolation", () => {
  it("deleting project A does NOT affect project B sharing the same DataBackend", async () => {
    const { store, ctx } = await createTestStore();

    const projA = (await store.createProject(ctx, COMPANY, { name: "Project A", type: "website", dataBackendId: BACKEND_ID }, "key-a")).project;
    const projB = (await store.createProject(ctx, COMPANY, { name: "Project B", type: "website", dataBackendId: BACKEND_ID }, "key-b")).project;

    const detachProjectCors = vi.fn().mockResolvedValue({ cleanedOrigins: 1 });
    const lifecycle = new ProjectLifecycleService({
      store,
      projects: { get: async (_c: any, _co: any, id: string) => store.getProject(ctx, COMPANY, id) } as any,
      dataBackendService: { detachProjectCors } as any,
    });

    // Soft delete Project A
    await lifecycle.softDelete(ctx, COMPANY, projA.id);

    // Project A is soft deleted
    const updatedA = await store.getProject(ctx, COMPANY, projA.id);
    expect(updatedA.status).toBe("soft_deleted");

    // Project B is completely untouched and active!
    const updatedB = await store.getProject(ctx, COMPANY, projB.id);
    expect(updatedB.status).toBe("ready");
    expect(updatedB.deletedAt).toBeFalsy();
    expect(updatedB.dataBackendId).toBe(BACKEND_ID);
  });
});

describe("Stage 5: SVG Security & Sanitization", () => {
  it("strips malicious script tags from SVG", () => {
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert('xss')</script><circle cx="50" cy="50" r="40"/></svg>`;
    const res = sanitizeSvg(maliciousSvg);

    expect(res.safe).toBe(false);
    expect(res.violations).toContain("script_tag_detected");
    const sanitizedStr = res.sanitized.toString("utf8");
    expect(sanitizedStr).not.toContain("<script");
    expect(sanitizedStr).not.toContain("alert");
    expect(sanitizedStr).toContain("<circle");
  });

  it("strips inline event handlers (onload, onerror, onclick)", () => {
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><image href="pic.png" onerror="stealData()"/><rect width="10" height="10" onclick="evil()"/></svg>`;
    const res = sanitizeSvg(maliciousSvg);

    expect(res.safe).toBe(false);
    expect(res.violations).toContain("inline_event_handler_detected");
    const sanitizedStr = res.sanitized.toString("utf8");
    expect(sanitizedStr).not.toContain("onload=");
    expect(sanitizedStr).not.toContain("onerror=");
    expect(sanitizedStr).not.toContain("onclick=");
  });

  it("strips foreignObject containing embedded HTML", () => {
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="javascript:alert(1)"></iframe></body></foreignObject></svg>`;
    const res = sanitizeSvg(maliciousSvg);

    expect(res.safe).toBe(false);
    expect(res.violations).toContain("foreign_object_detected");
    const sanitizedStr = res.sanitized.toString("utf8");
    expect(sanitizedStr).not.toContain("<foreignObject");
    expect(sanitizedStr).not.toContain("<iframe");
  });

  it("strips XXE and external entity declarations", () => {
    const maliciousSvg = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://internal.service/leak">]><svg><text>&xxe;</text></svg>`;
    const res = sanitizeSvg(maliciousSvg);

    expect(res.safe).toBe(false);
    expect(res.violations).toContain("xxe_entity_detected");
    const sanitizedStr = res.sanitized.toString("utf8");
    expect(sanitizedStr).not.toContain("<!ENTITY");
    expect(sanitizedStr).not.toContain("SYSTEM");
  });

  it("clean SVG passes without modification", () => {
    const cleanSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="blue"/></svg>`;
    const res = sanitizeSvg(cleanSvg);

    expect(res.safe).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(res.sanitized.toString("utf8")).toBe(cleanSvg);
  });
});

describe("Stage 5: HTTP Endpoints & Compatibility Migration", () => {
  it("migrates existing DELETE endpoint to Soft Delete when lifecycleService is configured", async () => {
    const routes: Route[] = [];
    const app = fakeInstance(routes);
    const { store, ctx } = await createTestStore();

    const created = await store.createProject(ctx, COMPANY, { name: "Migrated Delete Web", type: "website" }, "key-mig-1");

    const softDelete = vi.fn().mockResolvedValue({
      status: "soft_deleted",
      projectId: created.project.id,
      retentionDays: 30,
      purgeAfter: "2026-11-16T19:00:00.000Z",
      actions: { previewStopped: true, sandboxProcessesStopped: true, corsRevoked: true, filesPreserved: true, databasePreserved: true },
    });

    const deps: CodeProjectLifecycleDeps = {
      projects: {
        list: vi.fn(),
        get: async () => store.getProject(ctx, COMPANY, created.project.id),
        rename: vi.fn(),
        archive: vi.fn(),
        delete: vi.fn(),
      },
      lifecycleService: {
        softDelete,
      } as any,
      audit: {
        record: vi.fn().mockResolvedValue(undefined),
      },
      authorize: vi.fn().mockResolvedValue(true),
      getAuthContext: () => ctx,
    };

    await registerCodeProjectLifecycleRoutes(app, deps);

    const deleteRoute = routes.find((r) => r.method === "delete" && r.url === "/companies/:companyId/code/projects/:projectId");
    expect(deleteRoute).toBeDefined();

    const req = {
      params: { companyId: COMPANY, projectId: created.project.id },
      body: { confirm: true },
    };
    const { reply, state } = fakeReply();

    await deleteRoute!.handler(req, reply);

    expect(state.status).toBe(200);
    const body = state.body as any;
    expect(body.status).toBe("soft_deleted");
    expect(body.retentionDays).toBe(30);
    expect(body.removed.workspace).toBe("retained_for_soft_delete");

    // softDelete was called, NOT deps.projects.delete!
    expect(softDelete).toHaveBeenCalledTimes(1);
    expect(deps.projects.delete).not.toHaveBeenCalled();
  });
});
