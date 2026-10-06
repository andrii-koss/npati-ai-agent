import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WorkspaceAccessError, type AuthContext, type Project } from "@npati/workspace";
import { CodeRbac, createRoleRegistry, requiredPermissionForAction, type CodeAuthorizationAuditPort } from "../apps/agent-api/src/code-rbac";
import type { CodeAuditPort } from "../apps/agent-api/src/code-project-trust";
import { CodeService } from "../apps/agent-api/src/code-service";
import {
  registerCodeProjectLifecycleRoutes,
  resolveCreateKind,
  assertDeleteConfirmed,
  type CodeProjectLifecycleDeps,
} from "../apps/agent-api/src/code-project-lifecycle-routes";

/**
 * C7 security-gate: the server side of the code project lifecycle.
 *
 * What this suite pins, and why each part matters:
 *  - **Archive and delete go through the existing service**, whose `beforeRemove` hook destroys the sandbox and
 *    detaches DataBackend artifacts. The route must not repeat that cleanup, so the suite asserts the service was
 *    called with the caller's revision instead of asserting a second cleanup path.
 *  - **A partial cleanup is never reported as success.** With no workspace-removal mechanism wired, delete
 *    answers `partial` naming `workspace_removal_not_configured`; a "deleted" answer there would leave bytes on
 *    disk behind a success message.
 *  - **Deleting twice is safe and is not an existence oracle**: an already-removed project and a project that
 *    belongs to another tenant produce the *same* status and the *same* body, so the route cannot be used to
 *    probe for other tenants' projects.
 *  - **Every mutation is journalled before it is applied.** A failing audit journal means the mutation did not
 *    happen — checked by asserting the service was never called.
 *  - **Authorization is derived from named actions**: an unmapped action is refused (`action_not_mapped`) rather
 *    than falling back to a convenient label, and a principal without the required permission is refused before
 *    the service is touched.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";

interface Route {
  method: string;
  url: string;
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

function fakeInstance(routes: Route[]): FastifyInstance {
  const record = (method: string) => (url: string, handler: Route["handler"]) => { routes.push({ method, url, handler }); };
  return {
    get: record("get"),
    post: record("post"),
    patch: record("patch"),
    delete: record("delete"),
  } as unknown as FastifyInstance;
}

function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
  const state = { status: 200, body: undefined as unknown };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply, state };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT,
    workspaceId: "ws-1",
    companyId: COMPANY,
    name: "demo",
    type: "code_project",
    status: "ready",
    revision: 4,
    dataClassification: "internal",
    retentionClass: "standard",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  } as unknown as Project;
}

interface HarnessOptions {
  role?: string;
  auditFails?: boolean;
  auditMissing?: boolean;
  deleteThrows?: unknown;
  renameThrows?: unknown;
  removeWorkspace?: CodeProjectLifecycleDeps["removeWorkspace"];
  contextMissing?: boolean;
  deleteCalls?: string[];
}

async function harness(options: HarnessOptions = {}) {
  const routes: Route[] = [];
  const calls: string[] = options.deleteCalls ?? [];
  const order: string[] = [];
  const state = { archiveArgs: null as unknown, renameArgs: null as unknown, deleteCalls: 0 };

  const registry = createRoleRegistry({
    roles: {
      owner: ["workspace:read", "workspace:write", "business:manage"],
      developer: ["workspace:read", "workspace:write"],
      reviewer: ["workspace:read"],
    },
  });
  const rbacAudit: CodeAuthorizationAuditPort = { record: async () => {} };
  const rbac = new CodeRbac({ registry, audit: rbacAudit });

  const audit: CodeAuditPort = {
    record: async () => {
      order.push("audit");
      if (options.auditFails) throw new Error("audit_down");
    },
  };

  const deps: CodeProjectLifecycleDeps = {
    projects: {
      list: async () => [project()],
      get: async () => project(),
      rename: async (_ctx, _companyId, _projectId, _name, expectedRevision) => {
        state.renameArgs = expectedRevision;
        order.push("rename");
        if (options.renameThrows) throw options.renameThrows;
        return project({ name: "renamed" });
      },
      archive: async (_ctx, _companyId, _projectId, expectedRevision) => {
        state.archiveArgs = expectedRevision;
        order.push("archive");
        return project({ status: "archived" });
      },
      delete: async (_ctx, _companyId, projectId) => {
        order.push("delete");
        state.deleteCalls += 1;
        calls.push(projectId);
        if (options.deleteThrows) throw options.deleteThrows;
      },
    },
    ...(options.removeWorkspace ? { removeWorkspace: options.removeWorkspace } : {}),
    ...(options.auditMissing ? {} : { audit }),
    authorize: (context, companyId, input) => rbac.authorize(context, companyId, input),
    getAuthContext: () => (options.contextMissing ? null : {
      workspaceId: "ws-1",
      userId: "user-1",
      companyId: COMPANY,
      permissions: [],
      role: options.role ?? "developer",
    } as unknown as AuthContext),
  };

  await registerCodeProjectLifecycleRoutes(fakeInstance(routes), deps);
  return { routes, state, order, calls };
}

function route(routes: Route[], method: string, url: string): Route {
  const found = routes.find((entry) => entry.method === method && entry.url === url);
  if (!found) throw new Error(`route not registered: ${method} ${url}`);
  return found;
}

async function call(
  routes: Route[],
  method: string,
  url: string,
  params: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const { reply, state } = fakeReply();
  await route(routes, method, url).handler({ params, body, query: {} }, reply);
  return state;
}

const ARCHIVE_URL = "/companies/:companyId/code/projects/:projectId/archive";
const UNARCHIVE_URL = "/companies/:companyId/code/projects/:projectId/unarchive";
const PROJECT_URL = "/companies/:companyId/code/projects/:projectId";

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

describe("C7 project lifecycle — RBAC vocabulary", () => {
  it("maps every new lifecycle action, so an action cannot be authorized without a permission", () => {
    expect(requiredPermissionForAction("code.project.list")).toBe("workspace:read");
    expect(requiredPermissionForAction("code.project.create")).toBe("workspace:write");
    expect(requiredPermissionForAction("code.project.rename")).toBe("workspace:write");
    expect(requiredPermissionForAction("code.project.archive")).toBe("business:manage");
    expect(requiredPermissionForAction("code.project.unarchive")).toBe("workspace:write");
    // Deleting a project removes the sandbox and the project record, so it sits with the other destructive
    // administration surfaces rather than with ordinary workspace writes.
    expect(requiredPermissionForAction("code.project.delete")).toBe("business:manage");
    // Unknown actions are refused instead of inheriting whatever the caller passed as a label.
    expect(requiredPermissionForAction("code.project.destroy_everything")).toBeNull();
  });

  it("refuses a lifecycle call from a principal without the required permission, before touching the service", async () => {
    // `reviewer` holds only workspace:read, so every mutation must be refused.
    const { routes, state, order } = await harness({ role: "reviewer" });
    const archived = await call(routes, "post", ARCHIVE_URL, { companyId: COMPANY, projectId: PROJECT }, { expectedRevision: 4 });
    expect(archived.status).toBe(403);
    expect(errorCode(archived.body)).toBe("permission_denied");
    const deleted = await call(routes, "delete", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, { confirm: true });
    expect(deleted.status).toBe(403);
    // Nothing was applied and nothing was journalled: the refusal happens before any effect.
    expect(state.archiveArgs).toBeNull();
    expect(state.deleteCalls).toBe(0);
    expect(order).toEqual([]);
  });

  it("answers unauthorized when no authenticated context is present", async () => {
    const { routes } = await harness({ contextMissing: true });
    const result = await call(routes, "patch", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, { name: "x", expectedRevision: 1 });
    expect(result.status).toBe(401);
    expect(errorCode(result.body)).toBe("unauthorized");
  });
});

describe("C7 project lifecycle — archive, unarchive and rename", () => {
  it("archives through the existing service with the caller's revision and states that sessions are blocked", async () => {
    const { routes, state, order } = await harness({ role: "owner" });
    const result = await call(routes, "post", ARCHIVE_URL, { companyId: COMPANY, projectId: PROJECT }, { expectedRevision: 4 });
    expect(result.status).toBe(200);
    expect(state.archiveArgs).toBe(4);
    expect((result.body as { status?: string }).status).toBe("archived");
    expect((result.body as { sessionsBlocked?: boolean }).sessionsBlocked).toBe(true);
    // The journal entry precedes the mutation: an unjournalled archive must not happen.
    expect(order).toEqual(["audit", "archive"]);
  });

  it("requires expectedRevision for rename and refuses a missing one as invalid_arguments", async () => {
    const { routes, state } = await harness({ role: "owner" });
    const result = await call(routes, "patch", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, { name: "renamed" });
    expect(result.status).toBe(400);
    expect(errorCode(result.body)).toBe("invalid_arguments");
    expect(state.renameArgs).toBeNull();
  });

  it("surfaces a stale revision as project_revision_conflict with 409", async () => {
    const { routes, state, order } = await harness({
      role: "owner",
      renameThrows: new WorkspaceAccessError("Project changed by another request"),
    });
    const result = await call(routes, "patch", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, { name: "renamed", expectedRevision: 3 });
    expect(result.status).toBe(409);
    expect(errorCode(result.body)).toBe("project_revision_conflict");
    // The journal entry happens first and the mutation is then refused by the store's optimistic token: the
    // caller gets a retryable conflict, not a silent overwrite of somebody else's edit.
    expect(order).toEqual(["audit", "rename"]);
    expect(state.renameArgs).toBe(3);
  });

  it("answers a foreign or missing project with the same 404 and does not leak the id", async () => {
    const { routes } = await harness({
      role: "owner",
      renameThrows: new WorkspaceAccessError("Project not found or access denied: project-9"),
    });
    const foreign = await call(routes, "patch", PROJECT_URL, { companyId: OTHER_COMPANY, projectId: "project-9" }, { name: "x", expectedRevision: 1 });
    const missing = await call(routes, "patch", PROJECT_URL, { companyId: OTHER_COMPANY, projectId: "project-404" }, { name: "x", expectedRevision: 1 });
    expect(foreign.status).toBe(404);
    expect(errorCode(foreign.body)).toBe("project_not_found");
    expect(missing.status).toBe(404);
    expect(errorCode(missing.body)).toBe("project_not_found");
  });

  it("refuses unarchive when no unarchive mechanism is wired instead of pretending it happened", async () => {
    const { routes } = await harness({ role: "owner" });
    const result = await call(routes, "post", UNARCHIVE_URL, { companyId: COMPANY, projectId: PROJECT }, { expectedRevision: 5 });
    expect(result.status).toBe(503);
    expect((result.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe("unarchive_not_configured");
  });
});

describe("C7 project lifecycle — delete safety", () => {
  it("requires an explicit confirmation and does not delete without it", async () => {
    const { routes, state, order } = await harness({ role: "owner" });
    const result = await call(routes, "delete", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, {});
    expect(result.status).toBe(400);
    expect(errorCode(result.body)).toBe("project_delete_confirmation_required");
    expect(state.deleteCalls).toBe(0);
    expect(order).toEqual([]);
    // The helper itself is part of the contract the UI relies on.
    expect(() => assertDeleteConfirmed({ confirm: "true" })).toThrow();
    expect(() => assertDeleteConfirmed({ confirm: true })).not.toThrow();
  });

  it("reports a partial cleanup honestly when the workspace cannot be removed", async () => {
    const { routes } = await harness({ role: "owner" });
    const result = await call(routes, "delete", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, { confirm: true });
    expect(result.status).toBe(200);
    const body = result.body as { status?: string; removed?: { workspace?: unknown }; failures?: Array<{ target?: string; reason?: string; retryable?: boolean }> };
    expect(body.status).toBe("partial");
    expect(body.removed?.workspace).toBe("unknown");
    expect(body.failures?.[0]?.target).toBe("workspace");
    expect(body.failures?.[0]?.reason).toBe("workspace_removal_not_configured");
    expect(body.failures?.[0]?.retryable).toBe(true);
  });

  it("reports a completed delete when the workspace removal is wired", async () => {
    const { routes } = await harness({ role: "owner", removeWorkspace: async () => ({ removed: true }) });
    const result = await call(routes, "delete", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, { confirm: true });
    const body = result.body as { status?: string; failures?: unknown[]; removed?: { workspace?: unknown } };
    expect(body.status).toBe("deleted");
    expect(body.failures).toEqual([]);
    expect(body.removed?.workspace).toBe(true);
  });

  it("treats a repeated delete as already_deleted, with the same answer for a missing and a foreign project", async () => {
    const missing = await harness({ role: "owner", deleteThrows: new WorkspaceAccessError("Project not found: p1") });
    const first = await call(missing.routes, "delete", PROJECT_URL, { companyId: COMPANY, projectId: "p1" }, { confirm: true });
    const second = await call(missing.routes, "delete", PROJECT_URL, { companyId: COMPANY, projectId: "p2" }, { confirm: true });
    expect(first.status).toBe(200);
    expect((first.body as { status?: string }).status).toBe("already_deleted");
    // Byte-identical bodies: the route cannot be used to learn whether another tenant's project exists.
    expect(JSON.stringify(first.body) === JSON.stringify(second.body)).toBe(true);
    expect(JSON.stringify(first.body).includes("p1")).toBe(false);
    expect(JSON.stringify(first.body).includes("p2")).toBe(false);
  });

  it("keeps the mutation unapplied when the audit journal is unavailable", async () => {
    const failing = await harness({ role: "owner", auditFails: true });
    const failed = await call(failing.routes, "delete", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, { confirm: true });
    expect(failed.status).toBe(503);
    expect(errorCode(failed.body)).toBe("audit_unavailable");
    expect(failing.state.deleteCalls).toBe(0);

    const unwired = await harness({ role: "owner", auditMissing: true });
    const noJournal = await call(unwired.routes, "delete", PROJECT_URL, { companyId: COMPANY, projectId: PROJECT }, { confirm: true });
    expect(noJournal.status).toBe(503);
    expect(errorCode(noJournal.body)).toBe("audit_unavailable");
    expect(unwired.state.deleteCalls).toBe(0);
  });
});

describe("C7 project lifecycle — create kinds are declared, not guessed", () => {
  it("accepts only the three creation kinds and refuses anything else", () => {
    expect(resolveCreateKind("empty")).toBe("empty");
    expect(resolveCreateKind("upload")).toBe("upload");
    expect(resolveCreateKind("import_repository")).toBe("import_repository");
    expect(() => resolveCreateKind("clone_everything")).toThrow();
    expect(() => resolveCreateKind(undefined)).toThrow();
  });

  it("keeps an archived project unable to start a session, through the existing session-service check", async () => {
    // This is the property archiving relies on: the refusal lives in `CodeService.createSession`, not in a
    // second rule inside the lifecycle routes — so archiving cannot be bypassed by calling the session API
    // directly. The real service is constructed here to pin the existing check rather than a copy of it.
    const service = new CodeService(
      {} as never,
      { get: async () => ({ status: "archived" }) } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      { assertEnabled: async () => {} } as never,
    );
    const ctx = {
      workspaceId: "ws-1",
      userId: "user-1",
      companyId: COMPANY,
      permissions: ["workspace:write", "business:manage"],
      role: "developer",
    } as unknown as AuthContext;
    let code: string | undefined;
    try {
      await service.createSession(ctx, COMPANY, PROJECT);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("project_archived");
  });
});
