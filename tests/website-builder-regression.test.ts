import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext, Project } from "@npati/workspace";
import { registerProjectFileRoutes } from "../apps/agent-api/src/project-file-routes";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";

/**
 * C7 security-gate: Website Builder regression behind the shared project-files surface.
 *
 * Why this suite exists: C7 pointed the code workspace at the *same* project-files surface the Website Builder
 * uses (`ProjectWorkspace` behind `project-file-routes`). Sharing a surface is exactly the change that can break
 * the original consumer, so this suite drives the real routes over the **real** `LocalProjectWorkspace`
 * implementation (not a stub) and asserts:
 *  - the surface still round-trips a write, a tree listing and a read with its revision (Website Builder);
 *  - one `website` project and one `code_project` are served by that same surface, which is the actual claim of
 *    the shared adapter: one implementation, two consumers;
 *  - `workspace:read` is still required, another tenant's project yields no content, a secret-looking path is
 *    still refused (`secret_path`) and traversal is still refused (`invalid_path`). Because the code workspace
 *    now reads through this surface, these are its protections too — a regression here would widen both pages.
 *
 * The suite is deliberately route-level: it imports the routes and the service, not `buildApp`. The existing
 * whole-application mechanism (`tests/manual-product-e2e-web.test.ts`, `buildApp` + `InMemoryWorkspaceStore`)
 * cannot be a gate member because `app.ts` pulls a dependency that a value-imports a type-only symbol, which
 * only the bundler elides; that is why that suite is not in `scripts/run-security-gate.mjs`.
 */

const COMPANY = "company-wb-1";
const OTHER_COMPANY = "company-wb-2";
const WEBSITE = "project-website-1";
const CODE_PROJECT = "project-code-1";

interface Route {
  method: string;
  url: string;
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

function fakeInstance(routes: Route[]): FastifyInstance {
  const record = (method: string) => (url: string, handler: Route["handler"]) => {
    routes.push({ method, url, handler });
  };
  return { get: record("get"), post: record("post"), patch: record("patch"), delete: record("delete") } as unknown as FastifyInstance;
}

function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
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
  };
  return { reply, state };
}

function projectFor(projectId: string, companyId: string, type: "website" | "code_project") {
  return {
    id: projectId,
    companyId,
    workspaceId: "ws-wb-1",
    status: "ready",
    type,
    revision: 1,
  } as unknown as Pick<Project, "id" | "companyId" | "workspaceId" | "status" | "repositoryBranch" | "sandboxId" | "revision">;
}

let root: string;
let routes: Route[];
let permissions: string[];
let authProvider: AuthProvider;

/**
 * Built once, lazily, and cleaned up on process exit: the gate and the local harness run suites without
 * lifecycle hooks for the whole file, so setup cannot rely on `beforeAll`.
 */
function harness(): void {
  if (routes) return;
  root = mkdtempSync(join(tmpdir(), "npati-wb-regression-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));

  permissions = ["workspace:read", "workspace:write", "business:manage"];
  authProvider = { authenticate: async () => ({ workspaceId: "ws-wb-1", userId: "usr-wb-1", permissions: [...permissions] }) };

  const workspace = new LocalProjectWorkspace(
    {
      get: async (_ctx: AuthContext, companyId: string, projectId: string) => {
        if (projectId === WEBSITE) return projectFor(WEBSITE, COMPANY, "website");
        if (projectId === CODE_PROJECT) return projectFor(CODE_PROJECT, COMPANY, "code_project");
        if (projectId === "project-foreign") return projectFor("project-foreign", OTHER_COMPANY, "website");
        throw Object.assign(new Error("project not found"), { code: "not_found", status: 404 });
      },
    },
    { root },
  );

  routes = [];
  registerProjectFileRoutes(fakeInstance(routes), workspace, authProvider);
}

function route(method: string, url: string): Route {
  harness();
  const found = routes.find((entry) => entry.method === method && entry.url === url);
  if (!found) throw new Error(`route not registered: ${method} ${url}`);
  return found;
}

async function call(
  method: string,
  url: string,
  input: { params: Record<string, string>; query?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: any }> {
  const { reply, state } = fakeReply();
  const request = { params: input.params, query: input.query ?? {}, body: input.body ?? {}, headers: {} };
  // Fastify serialises a returned value, and `reply.send(...)` also returns the reply object — so a handler
  // that sends explicitly would otherwise be read as "returned the reply", hiding its body. Prefer the sent
  // body in that case and the returned value otherwise.
  const returned = await route(method, url).handler(request, reply);
  const body = returned === undefined || returned === reply ? state.body : returned;
  return { status: state.status, body };
}

describe("C7 [security-gate]: Website Builder file surface regression", () => {

  it("round-trips a write, a tree listing and a read with its revision", async () => {
    const write = await call("post", "/companies/:companyId/projects/:projectId/files/write", {
      params: { companyId: COMPANY, projectId: WEBSITE },
      body: { path: "src/index.ts", content: "export const answer = 42;\n" },
    });
    expect([200, 201], JSON.stringify(write.body)).toContain(write.status);
    const revision = write.body?.revision as string;
    expect(revision, "a write must return the revision the editor compares against").toBeTruthy();

    const tree = await call("get", "/companies/:companyId/projects/:projectId/files/tree", {
      params: { companyId: COMPANY, projectId: WEBSITE },
    });
    expect(tree.status, JSON.stringify(tree.body)).toBe(200);
    expect((tree.body.files as Array<{ path: string }>).map((entry) => entry.path)).toContain("src/index.ts");

    const read = await call("get", "/companies/:companyId/projects/:projectId/files/read", {
      params: { companyId: COMPANY, projectId: WEBSITE },
      query: { path: "src/index.ts" },
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.content).toContain("answer = 42");
    expect(read.body.revision).toBe(revision);
  });

  it("serves a code_project through the same one surface as a website project", async () => {
    for (const projectId of [WEBSITE, CODE_PROJECT]) {
      const write = await call("post", "/companies/:companyId/projects/:projectId/files/write", {
        params: { companyId: COMPANY, projectId },
        body: { path: "README.md", content: `# ${projectId}\n` },
      });
      expect([200, 201], JSON.stringify(write.body)).toContain(write.status);

      const read = await call("get", "/companies/:companyId/projects/:projectId/files/read", {
        params: { companyId: COMPANY, projectId },
        query: { path: "README.md" },
      });
      expect(read.status).toBe(200);
      expect(read.body.content).toContain(projectId);
    }
  });

  it("still requires workspace:read and still hides another tenant's project", async () => {
    // `business:manage` is deliberately *not* used as the negative case: the file surface grants read to a
    // business manager by design, so it cannot demonstrate a refusal. A permission set with nothing relevant
    // in it is the honest negative control.
    permissions = ["research:execute"];
    const denied = await call("get", "/companies/:companyId/projects/:projectId/files/read", {
      params: { companyId: COMPANY, projectId: WEBSITE },
      query: { path: "src/index.ts" },
    });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain("answer = 42");

    permissions = ["workspace:read", "workspace:write", "business:manage"];
    const foreign = await call("get", "/companies/:companyId/projects/:projectId/files/read", {
      params: { companyId: OTHER_COMPANY, projectId: "project-foreign" },
      query: { path: "src/index.ts" },
    });
    expect([403, 404]).toContain(foreign.status);
    expect(JSON.stringify(foreign.body)).not.toContain("answer = 42");
  });

  it("keeps the service's path protections for the new consumer too", async () => {
    const traversal = await call("get", "/companies/:companyId/projects/:projectId/files/read", {
      params: { companyId: COMPANY, projectId: WEBSITE },
      query: { path: "../outside.txt" },
    });
    expect(traversal.status).toBeGreaterThanOrEqual(400);
    expect(traversal.body?.error?.code).toBe("invalid_path");

    for (const secretPath of [".env", ".ssh/id_rsa", "config/credentials.json", "certs/server.pem"]) {
      const refused = await call("get", "/companies/:companyId/projects/:projectId/files/read", {
        params: { companyId: COMPANY, projectId: WEBSITE },
        query: { path: secretPath },
      });
      expect(refused.status, secretPath).toBe(403);
      expect(refused.body?.error?.code, secretPath).toBe("secret_path");
    }
  });
});
