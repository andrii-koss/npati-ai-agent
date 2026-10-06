import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { WorkspaceNotFoundError, type AuthContext, type Project } from "@npati/workspace";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { CodeRbac, createRoleRegistry, type CodeAuthorizationAuditPort } from "../apps/agent-api/src/code-rbac";
import { registerCodeProjectLifecycleRoutes, type CodeProjectLifecycleDeps } from "../apps/agent-api/src/code-project-lifecycle-routes";

/**
 * C7 security-gate: real removal of a project's on-disk workspace.
 *
 * What this suite pins, and why each assertion is here:
 *  - **A delete that leaves bytes behind must not say "deleted".** The route reports `partial` with the
 *    outstanding target, and the workspace field reflects the state of the disk, not the attempt.
 *  - **Idempotence is a security property**, not convenience: a repeated delete of a project that is already gone
 *    must succeed without touching anything, otherwise operators retry into unrelated state.
 *  - **Symlinks are refused, never followed.** A workspace directory replaced by a link must abort the call and
 *    leave the link target intact — following it would turn "delete my project" into "delete whatever it points
 *    at", which is the classic destructive escalation.
 *  - **Scope is exactly one project**: a sibling project of the same company survives, and the shared parent
 *    directory is never removed recursively.
 *  - **The route stays useless as a cross-tenant probe**: a project that does not exist and a project of another
 *    tenant produce the same status and the same body.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";

function context(permissions: string[] = ["business:manage"]): AuthContext {
  return { workspaceId: "ws-1", userId: "user-1", companyId: COMPANY, permissions, role: "owner" } as unknown as AuthContext;
}

/** Harness-proof rejection probe: the shim does not implement regex matchers for `toThrow`. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const typed = error as { message?: string; code?: string };
    return `${typed.code ?? ""} ${typed.message ?? ""}`.trim();
  }
}

async function workspaceRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "npati-c7-cleanup-"));
}

function workspace(root: string, project: Partial<Project> = {}) {
  const record = {
    id: PROJECT,
    companyId: COMPANY,
    workspaceId: "ws-1",
    status: "ready",
    revision: 1,
    ...project,
  } as unknown as Project;
  return new LocalProjectWorkspace({ get: async () => record }, { root });
}

describe("[C7] [security-gate] project workspace removal", () => {
  it("removes the project directory and reports the state of the disk", async () => {
    const root = await workspaceRoot();
    try {
      const dir = path.join(root, COMPANY, PROJECT);
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "index.ts"), "export const a = 1;\n", "utf8");

      const outcome = await workspace(root).removeProjectWorkspace(context("owner"), COMPANY, PROJECT);

      expect(outcome.removed).toBe(true);
      expect(outcome.alreadyAbsent).toBe(false);
      expect(existsSync(dir)).toBe(false);
      // The parent company directory may be pruned only when empty, and the root itself always survives.
      expect(existsSync(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: a second removal succeeds and reports that nothing was left to do", async () => {
    const root = await workspaceRoot();
    try {
      const dir = path.join(root, COMPANY, PROJECT);
      await mkdir(dir, { recursive: true });
      const instance = workspace(root);

      const first = await instance.removeProjectWorkspace(context("owner"), COMPANY, PROJECT);
      const second = await instance.removeProjectWorkspace(context("owner"), COMPANY, PROJECT);

      expect(first.removed).toBe(true);
      expect(first.alreadyAbsent).toBe(false);
      expect(second.removed).toBe(true);
      expect(second.alreadyAbsent).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never touches a sibling project of the same company", async () => {
    const root = await workspaceRoot();
    try {
      const target = path.join(root, COMPANY, PROJECT);
      const sibling = path.join(root, COMPANY, "project-2");
      await mkdir(sibling, { recursive: true });
      await writeFile(path.join(sibling, "keep.txt"), "keep\n", "utf8");
      await mkdir(target, { recursive: true });

      await workspace(root).removeProjectWorkspace(context("owner"), COMPANY, PROJECT);

      expect(existsSync(sibling)).toBe(true);
      expect(await readFile(path.join(sibling, "keep.txt"), "utf8")).toBe("keep\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses without a write permission and removes nothing", async () => {
    const root = await workspaceRoot();
    try {
      const dir = path.join(root, COMPANY, PROJECT);
      await mkdir(dir, { recursive: true });

      const denied = await rejection(workspace(root).removeProjectWorkspace(context(["workspace:read"]), COMPANY, PROJECT));
      expect(denied.includes("denied")).toBe(true);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses invalid identifiers instead of building a path from them", async () => {
    const root = await workspaceRoot();
    try {
      const instance = workspace(root);
      expect((await rejection(instance.removeProjectWorkspace(context(), COMPANY, "../escape"))).includes("identifier")).toBe(true);
      expect((await rejection(instance.removeProjectWorkspace(context(), "../escape", PROJECT))).includes("identifier")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked workspace and leaves the link target untouched", async () => {
    const root = await workspaceRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "npati-c7-outside-"));
    try {
      const victim = path.join(outside, "precious");
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, "data.txt"), "precious\n", "utf8");
      await mkdir(path.join(root, COMPANY), { recursive: true });
      await symlink(victim, path.join(root, COMPANY, PROJECT), "junction");

      // The link is refused — through the reparse-point check, because a Windows junction is not always reported
      // as a symbolic link by `lstat`. Asserting the refusal is what matters; how the check catches it is not.
      const refused = await rejection(workspace(root).removeProjectWorkspace(context(), COMPANY, PROJECT));
      expect(refused.toLowerCase().includes("symlink")).toBe(true);

      expect(await readFile(path.join(victim, "data.txt"), "utf8")).toBe("precious\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses when the workspace path is a file rather than a directory", async () => {
    const root = await workspaceRoot();
    try {
      await mkdir(path.join(root, COMPANY), { recursive: true });
      const file = path.join(root, COMPANY, PROJECT);
      await writeFile(file, "not a workspace\n", "utf8");

      const refused = await rejection(workspace(root).removeProjectWorkspace(context(), COMPANY, PROJECT));
      expect(refused.includes("not a directory")).toBe(true);
      expect(await readFile(file, "utf8")).toBe("not a workspace\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --- route level -----------------------------------------------------------------------------------------

interface Route { method: string; url: string; handler: (request: unknown, reply: unknown) => Promise<unknown> }

function fakeInstance(routes: Route[]): FastifyInstance {
  const record = (method: string) => (url: string, handler: Route["handler"]) => { routes.push({ method, url, handler }); };
  return { get: record("get"), post: record("post"), patch: record("patch"), delete: record("delete") } as unknown as FastifyInstance;
}

function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
  const state = { status: 200, body: undefined as unknown };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply, state };
}

async function deleteHarness(removeWorkspace: CodeProjectLifecycleDeps["removeWorkspace"], deleteThrows?: unknown) {
  const routes: Route[] = [];
  const registry = createRoleRegistry({
    roles: { owner: ["workspace:read", "workspace:write", "business:manage"], developer: ["workspace:read", "workspace:write"] },
  });
  const rbac = new CodeRbac({ registry, audit: { record: async () => {} } as CodeAuthorizationAuditPort });
  const deps: CodeProjectLifecycleDeps = {
    projects: {
      list: async () => [],
      get: async () => ({ id: PROJECT, companyId: COMPANY, workspaceId: "ws-1", status: "ready" }) as unknown as Project,
      rename: async () => ({ id: PROJECT }) as unknown as Project,
      archive: async () => ({ id: PROJECT }) as unknown as Project,
      delete: async () => { if (deleteThrows) throw deleteThrows; },
    },
    ...(removeWorkspace ? { removeWorkspace } : {}),
    audit: { record: async () => {} },
    authorize: (ctx, companyId, input) => rbac.authorize(ctx, companyId, input),
    getAuthContext: () => context(),
  };
  await registerCodeProjectLifecycleRoutes(fakeInstance(routes), deps);
  const route = routes.find((entry) => entry.method === "delete");
  if (!route) throw new Error("delete route was not registered");
  return route;
}

describe("[C7] [security-gate] delete route reports the real workspace state", () => {
  it("answers deleted only when the workspace is provably gone", async () => {
    const route = await deleteHarness(async () => ({ removed: true, alreadyAbsent: false }));
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY, projectId: PROJECT }, body: { confirm: true } }, reply);
    const body = state.body as { status: string; removed: { workspace: unknown } };
    expect(body.status).toBe("deleted");
    expect(body.removed.workspace).toBe(true);
  });

  it("answers partial with the outstanding target when bytes remain", async () => {
    const route = await deleteHarness(async () => ({ removed: false, reason: "workspace_removal_incomplete", outstanding: ["workspace"] }));
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY, projectId: PROJECT }, body: { confirm: true } }, reply);
    const body = state.body as { status: string; removed: { workspace: unknown }; failures: Array<{ target: string; reason: string }> };
    expect(body.status).toBe("partial");
    expect(body.removed.workspace).toBe(false);
    expect(body.failures.length).toBe(1);
    expect(body.failures[0]!.reason).toBe("workspace_removal_incomplete");
  });

  it("treats a thrown removal as a failure, not as success", async () => {
    const route = await deleteHarness(async () => { throw new Error("disk_offline"); });
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY, projectId: PROJECT }, body: { confirm: true } }, reply);
    const body = state.body as { status: string; removed: { workspace: unknown } };
    expect(body.status).toBe("partial");
    expect(body.removed.workspace).toBe(false);
  });

  it("still cleans the workspace on a repeated delete and is not a cross-tenant probe", async () => {
    // A real `WorkspaceNotFoundError`, because the route distinguishes "does not exist / not yours" by type, not by
    // message text — a plain object would be treated as an unexpected failure instead.
    const harness = await deleteHarness(async () => ({ removed: true, alreadyAbsent: true }), new WorkspaceNotFoundError("Project not found"));
    const first = fakeReply();
    await harness.handler({ params: { companyId: COMPANY, projectId: "project-missing" }, body: { confirm: true } }, first.reply);
    const second = fakeReply();
    await harness.handler({ params: { companyId: COMPANY, projectId: "project-of-another-tenant" }, body: { confirm: true } }, second.reply);

    expect((first.state.body as { status: string }).status).toBe("already_deleted");
    expect(JSON.stringify(first.state.body)).toBe(JSON.stringify(second.state.body));
    expect(JSON.stringify(first.state.body).includes("project-of-another-tenant")).toBe(false);
    expect(JSON.stringify(first.state.body).includes("project-missing")).toBe(false);
  });
});
