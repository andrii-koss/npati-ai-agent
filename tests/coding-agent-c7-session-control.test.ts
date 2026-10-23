import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WorkspaceAccessError, type AuthContext, type CodeSession } from "@npati/workspace";
import { CodeRbac, createRoleRegistry, requiredPermissionForAction, type CodeAuthorizationAuditPort } from "../apps/agent-api/src/code-rbac";
import type { CodeAuditPort } from "../apps/agent-api/src/code-project-trust";
import { CodeRunCancellationRegistry } from "../apps/agent-api/src/code-run-cancellation";
import {
  performSessionStop,
  registerCodeSessionControlRoutes,
  resolveRevertRequest,
  type CodeSessionControlDeps,
} from "../apps/agent-api/src/code-session-control-routes";

/**
 * C7 security-gate: session control (Stop, usage, Changes/Revert, active context).
 *
 * What this suite pins, and why each part matters:
 *  - **Stop reports exactly what it did.** The registry entry, the abort of a live controller and the sandbox
 *    release are three separate facts; a single "stopped" boolean would hide the common case where the run is
 *    owned by another replica and the in-process registry cannot reach it.
 *  - **Stop is idempotent**: a second Stop answers `already_stopping` without error and without a second abort.
 *  - **Usage never invents numbers.** With no accounting source the answer is `unavailable` with a reason — not
 *    zeros that a dashboard would read as "this run used nothing".
 *  - **Changes carry statistics, never content.** The reader also returns a diff body; the response is rebuilt
 *    from named fields, so a canary planted in the reader's `diff` cannot reach the client.
 *  - **Revert validates paths with the canonical validator** before any git call, refuses per-file revert when
 *    the path-scoped restore does not exist (instead of silently doing an all-files hard reset), and reports the
 *    mandatory pre-restore safety checkpoint.
 *  - **Every mutation is journalled before it is applied**, and a failing journal leaves the workspace untouched.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";
const SESSION = "session-1";
const RUN = "run-1";
const SECRET_CANARY = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Route {
  method: string;
  url: string;
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

function fakeInstance(routes: Route[]): FastifyInstance {
  const record = (method: string) => (url: string, handler: Route["handler"]) => { routes.push({ method, url, handler }); };
  return { get: record("get"), post: record("post"), put: record("put") } as unknown as FastifyInstance;
}

function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
  const state = { status: 200, body: undefined as unknown };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply, state };
}

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: SESSION,
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    userId: "user-1",
    mode: "edit",
    status: "active",
    runId: RUN,
    dataClassification: "internal",
    retentionClass: "standard",
    revision: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  } as unknown as CodeSession;
}

interface HarnessOptions {
  role?: string;
  auditFails?: boolean;
  sessionStatus?: CodeSession["status"];
  changes?: CodeSessionControlDeps["changes"];
  usage?: CodeSessionControlDeps["usage"];
  revert?: CodeSessionControlDeps["revert"];
  releaseSandbox?: CodeSessionControlDeps["releaseSandbox"];
  activeContext?: CodeSessionControlDeps["activeContext"];
  sessionsList?: CodeSession[];
  /** The project the fetched session belongs to; used to prove a cross-project session is refused. */
  sessionProjectId?: string;
  getSessionThrows?: unknown;
  contextMissing?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const routes: Route[] = [];
  const order: string[] = [];
  const calls = { audits: 0, reverts: [], stops: 0, controllersAborted: 0 };

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
    record: async (input) => {
      expect(input.workspaceId).toBe("ws-1");
      order.push("audit");
      calls.audits += 1;
      if (options.auditFails) throw new Error("audit_down");
    },
  };

  const cancellation = new CodeRunCancellationRegistry();
  const deps: CodeSessionControlDeps = {
    sessions: {
      get: async (_ctx, _companyId, _sessionId) => {
        if (options.getSessionThrows) throw options.getSessionThrows;
        return session({
          ...(options.sessionStatus ? { status: options.sessionStatus } : {}),
          ...(options.sessionProjectId ? { projectId: options.sessionProjectId } : {}),
        });
      },
      list: async () => options.sessionsList ?? [session()],
    },
    cancellation,
    runState: async () => ({ status: "running", startedAt: "2026-01-02T00:00:00.000Z", heartbeatAt: "2026-01-02T00:01:00.000Z" }),
    ...(options.releaseSandbox ? { releaseSandbox: options.releaseSandbox } : {}),
    ...(options.changes ? { changes: options.changes } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.revert ? { revert: options.revert } : {}),
    ...(options.activeContext ? { activeContext: options.activeContext } : {}),
    audit,
    authorize: (context, companyId, input) => rbac.authorize(context, companyId, input),
    getAuthContext: () => (options.contextMissing ? null : {
      workspaceId: "ws-1",
      userId: "user-1",
      companyId: COMPANY,
      permissions: [],
      role: options.role ?? "developer",
    } as unknown as AuthContext),
  };

  await registerCodeSessionControlRoutes(fakeInstance(routes), deps);
  return { routes, order, calls, cancellation, deps };
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
  query: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const { reply, state } = fakeReply();
  await route(routes, method, url).handler({ params, body, query }, reply);
  return state;
}

const STOP_URL = "/companies/:companyId/code/sessions/:sessionId/stop";
const USAGE_URL = "/companies/:companyId/code/sessions/:sessionId/usage";
const CHANGES_URL = "/companies/:companyId/code/sessions/:sessionId/changes";
const REVERT_URL = "/companies/:companyId/code/sessions/:sessionId/changes/revert";
const ACTIVE_CONTEXT_URL = "/companies/:companyId/code/active-context";
const PROJECT_SESSIONS_URL = "/companies/:companyId/projects/:projectId/code/sessions";

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

describe("C7 session control — RBAC vocabulary", () => {
  it("maps every new session-control action", () => {
    expect(requiredPermissionForAction("code.session.list")).toBe("workspace:read");
    expect(requiredPermissionForAction("code.session.stop")).toBe("workspace:write");
    expect(requiredPermissionForAction("code.session.usage.read")).toBe("workspace:read");
    expect(requiredPermissionForAction("code.changes.read")).toBe("workspace:read");
    expect(requiredPermissionForAction("code.changes.revert")).toBe("workspace:write");
    expect(requiredPermissionForAction("code.active_context.read")).toBe("workspace:read");
    expect(requiredPermissionForAction("code.active_context.write")).toBe("workspace:write");
    expect(requiredPermissionForAction("code.session.teleport")).toBeNull();
  });
});

describe("C7 session control — Stop", () => {
  it("records the cancellation, aborts the live controller, releases the sandbox and journals first", async () => {
    const released: string[] = [];
    const { routes, order, cancellation } = await harness({
      role: "developer",
      releaseSandbox: async (_ctx, input) => { released.push(input.sessionId); return { released: true }; },
    });
    // A live run registers its controller, exactly as the chat path does.
    const controller = new AbortController();
    cancellation.registerController(SESSION, controller);

    const result = await call(routes, "post", STOP_URL, { companyId: COMPANY, sessionId: SESSION }, {});
    expect(result.status).toBe(200);
    const body = result.body as { status?: string; liveRunAborted?: boolean; sandboxReleased?: boolean };
    expect(body.status).toBe("stop_requested");
    expect(body.liveRunAborted).toBe(true);
    expect(body.sandboxReleased).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(released).toEqual([SESSION]);
    expect(cancellation.isSessionCancelled(SESSION)).toBe(true);
    expect(order).toEqual(["audit"]);
  });

  it("is idempotent: a second Stop answers already_stopping and reports honestly", async () => {
    const { routes, calls, cancellation } = await harness({ role: "developer" });
    const first = await call(routes, "post", STOP_URL, { companyId: COMPANY, sessionId: SESSION }, {});
    expect((first.body as { status?: string }).status).toBe("stop_requested");
    const second = await call(routes, "post", STOP_URL, { companyId: COMPANY, sessionId: SESSION }, {});
    expect(second.status).toBe(200);
    expect((second.body as { status?: string }).status).toBe("already_stopping");
    // No live controller was registered in this harness, so the abort count stays zero and the answer says so
    // instead of implying the loop was reached.
    expect((second.body as { liveRunAborted?: boolean }).liveRunAborted).toBe(false);
    expect(cancellation.size()).toBe(1);
    expect(calls.audits).toBe(2);
  });

  it("states that an unwired sandbox release is a deployment gap, not a release", async () => {
    const { routes } = await harness({ role: "developer" });
    const result = await call(routes, "post", STOP_URL, { companyId: COMPANY, sessionId: SESSION }, {});
    const body = result.body as { sandboxReleased?: boolean | null; sandboxReleaseReason?: string };
    expect(body.sandboxReleased).toBeNull();
    expect(body.sandboxReleaseReason).toBe("sandbox_release_not_configured");
  });

  it("refuses to stop an archived session", async () => {
    const { routes, order } = await harness({ role: "developer", sessionStatus: "archived" });
    const result = await call(routes, "post", STOP_URL, { companyId: COMPANY, sessionId: SESSION }, {});
    expect(result.status).toBe(409);
    expect(errorCode(result.body)).toBe("session_archived");
    // Nothing was journalled and no cancellation was recorded for a session that cannot run.
    expect(order).toEqual([]);
  });

  it("refuses Stop from a principal without workspace:write, before recording anything", async () => {
    const { routes, cancellation, calls } = await harness({ role: "reviewer" });
    const result = await call(routes, "post", STOP_URL, { companyId: COMPANY, sessionId: SESSION }, {});
    expect(result.status).toBe(403);
    expect(cancellation.isSessionCancelled(SESSION)).toBe(false);
    expect(calls.audits).toBe(0);
  });

  it("keeps a Stop unapplied when the audit journal fails", async () => {
    const { routes, cancellation } = await harness({ role: "developer", auditFails: true });
    const result = await call(routes, "post", STOP_URL, { companyId: COMPANY, sessionId: SESSION }, {});
    expect(result.status).toBe(503);
    expect(errorCode(result.body)).toBe("audit_unavailable");
    expect(cancellation.isSessionCancelled(SESSION)).toBe(false);
  });

  it("performSessionStop reports the three facts separately", async () => {
    const cancellation = new CodeRunCancellationRegistry();
    const ctx = { workspaceId: "ws-1", userId: "user-1", companyId: COMPANY, permissions: [], role: "developer" } as unknown as AuthContext;
    const outcome = await performSessionStop(
      { cancellation, releaseSandbox: async () => ({ released: false, reason: "sandbox_destroy_failed" }) },
      ctx,
      { companyId: COMPANY, projectId: PROJECT, sessionId: SESSION },
    );
    expect(outcome.status).toBe("stop_requested");
    expect(outcome.liveRunAborted).toBe(false);
    expect(outcome.sandboxReleased).toBe(false);
    expect(outcome.sandboxReleaseReason).toBe("sandbox_destroy_failed");
  });
});

describe("C7 session control — usage, sessions and changes", () => {
  it("answers unavailable with a reason when no accounting source is wired, never zeros", async () => {
    const { routes } = await harness({ role: "developer" });
    const result = await call(routes, "get", USAGE_URL, { companyId: COMPANY, sessionId: SESSION });
    expect(result.status).toBe(200);
    const body = result.body as { status?: string; usage?: unknown; reason?: string };
    expect(body.status).toBe("unavailable");
    expect(body.usage).toBeNull();
    expect(body.reason).toBe("usage_accounting_not_configured");
    expect(JSON.stringify(result.body).includes("\"total\":0")).toBe(false);
  });

  it("returns whatever the accounting source reports when it is wired", async () => {
    const { routes } = await harness({
      role: "developer",
      usage: async () => ({ tokens: { input: 12, output: 34, total: 46 }, costUsd: 0.01, runs: 2, source: "replay_bundle_usage" }),
    });
    const result = await call(routes, "get", USAGE_URL, { companyId: COMPANY, sessionId: SESSION });
    const body = result.body as { status?: string; usage?: { tokens?: { total?: number }; source?: string } };
    expect(body.status).toBe("ok");
    expect(body.usage?.tokens?.total).toBe(46);
    expect(body.usage?.source).toBe("replay_bundle_usage");
  });

  it("lists sessions with the run the session points at and the stop flag", async () => {
    const { routes, cancellation } = await harness({ role: "developer" });
    cancellation.requestSessionCancel({ sessionId: SESSION, companyId: COMPANY, requestedBy: "user-1" });
    const result = await call(routes, "get", PROJECT_SESSIONS_URL, { companyId: COMPANY, projectId: PROJECT });
    const body = result.body as { sessions?: Array<{ sessionId?: string; lastRun?: { runId?: string; status?: string; stopRequested?: boolean } | null }> };
    expect(body.sessions?.length).toBe(1);
    expect(body.sessions?.[0]?.sessionId).toBe(SESSION);
    expect(body.sessions?.[0]?.lastRun?.runId).toBe(RUN);
    expect(body.sessions?.[0]?.lastRun?.status).toBe("running");
    expect(body.sessions?.[0]?.lastRun?.stopRequested).toBe(true);
  });

  it("rebuilds changes from named fields, so a diff body in the reader cannot reach the client", async () => {
    const { routes } = await harness({
      role: "developer",
      changes: async () => ({
        summary: { added: 1, modified: 1, deleted: 0, total: 2 },
        // The reader returns a diff body; the boundary must not forward it.
        changes: [
          { path: "src/a.ts", status: "modified", added: 3, removed: 1, diff: `+ secret ${SECRET_CANARY}` } as never,
        ],
      }),
    });
    const result = await call(routes, "get", CHANGES_URL, { companyId: COMPANY, sessionId: SESSION });
    const serialized = JSON.stringify(result.body);
    expect(result.status).toBe(200);
    expect(serialized.includes("diff")).toBe(false);
    expect(serialized.includes(SECRET_CANARY)).toBe(false);
    const body = result.body as { changes?: Array<{ path?: string; added?: number; removed?: number }> };
    expect(body.changes?.[0]?.path).toBe("src/a.ts");
    expect(body.changes?.[0]?.added).toBe(3);
    expect(body.changes?.[0]?.removed).toBe(1);
  });
});

describe("C7 session control — Revert", () => {
  it("validates paths with the canonical validator and refuses escapes before any git call", () => {
    expect(() => resolveRevertRequest({ files: ["../secrets.env"] })).toThrow();
    expect(() => resolveRevertRequest({ files: ["/etc/passwd"] })).toThrow();
    expect(() => resolveRevertRequest({ files: ["~/ .ssh/id_rsa"] })).toThrow();
    expect(() => resolveRevertRequest({ all: true, files: ["src/a.ts"] })).toThrow();
    expect(() => resolveRevertRequest({})).toThrow();
    expect(resolveRevertRequest({ all: true })).toEqual({ all: true, files: [] });
    expect(resolveRevertRequest({ files: ["src/a.ts"] })).toEqual({ all: false, files: ["src/a.ts"] });
  });

  it("refuses a path escape at the route as invalid_arguments and never calls the git service", async () => {
    const { routes, calls } = await harness({
      role: "developer",
      revert: { all: async () => { calls.reverts.push("all"); return { restored: true, files: [], safetyCheckpointId: "cp-1" }; } },
    });
    const result = await call(routes, "post", REVERT_URL, { companyId: COMPANY, sessionId: SESSION }, { files: ["../../etc/passwd"] });
    expect(result.status).toBe(400);
    expect(errorCode(result.body)).toBe("invalid_arguments");
    expect(calls.reverts).toEqual([]);
  });

  it("refuses a per-file revert when the path-scoped restore is not implemented", async () => {
    const { routes, calls, order } = await harness({
      role: "developer",
      revert: { all: async () => { calls.reverts.push("all"); return { restored: true, files: [], safetyCheckpointId: "cp-1" }; } },
    });
    const result = await call(routes, "post", REVERT_URL, { companyId: COMPANY, sessionId: SESSION }, { files: ["src/a.ts"] });
    expect(result.status).toBe(501);
    expect(errorCode(result.body)).toBe("changes_revert_file_unsupported");
    // No hidden all-files hard reset, and not even a journal entry: nothing was applied.
    expect(calls.reverts).toEqual([]);
    expect(order).toEqual([]);
  });

  it("reverts all through the checkpoint service and reports the mandatory safety checkpoint", async () => {
    const { routes, calls, order } = await harness({
      role: "developer",
      revert: {
        all: async () => { calls.reverts.push("all"); return { restored: true, files: [], safetyCheckpointId: "cp-before" }; },
      },
    });
    const result = await call(routes, "post", REVERT_URL, { companyId: COMPANY, sessionId: SESSION }, { all: true });
    expect(result.status).toBe(200);
    const body = result.body as { status?: string; safetyCheckpointId?: string | null };
    expect(body.status).toBe("reverted");
    expect(body.safetyCheckpointId).toBe("cp-before");
    expect(calls.reverts).toEqual(["all"]);
    expect(order).toEqual(["audit"]);
  });

  it("keeps the workspace untouched when the audit journal fails", async () => {
    const { routes, calls } = await harness({
      role: "developer",
      auditFails: true,
      revert: { all: async () => { calls.reverts.push("all"); return { restored: true, files: [], safetyCheckpointId: "cp-1" }; } },
    });
    const result = await call(routes, "post", REVERT_URL, { companyId: COMPANY, sessionId: SESSION }, { all: true });
    expect(result.status).toBe(503);
    expect(errorCode(result.body)).toBe("audit_unavailable");
    expect(calls.reverts).toEqual([]);
  });

  it("refuses Revert from a principal without workspace:write", async () => {
    const { routes, calls } = await harness({ role: "reviewer" });
    const result = await call(routes, "post", REVERT_URL, { companyId: COMPANY, sessionId: SESSION }, { all: true });
    expect(result.status).toBe(403);
    expect(calls.reverts).toEqual([]);
  });
});

describe("C7 session control — active context", () => {
  const resolver: CodeSessionControlDeps["activeContext"] = {
    resolve: async (_ctx, requested) => {
      if (requested.projectId === "archived-project") throw new WorkspaceAccessError("Cannot set active context to an archived project");
      if (requested.projectId === "foreign-project") throw new WorkspaceAccessError("Project not found or does not belong to company");
      return { contextType: requested.projectId ? "project" : "company", companyId: COMPANY, projectId: requested.projectId ?? null };
    },
  };

  it("returns the resolved context and the newest session, and says it is derived rather than stored", async () => {
    const { routes } = await harness({ role: "developer", activeContext: resolver });
    const result = await call(routes, "get", ACTIVE_CONTEXT_URL, { companyId: COMPANY }, undefined, { projectId: PROJECT });
    const body = result.body as { activeContext?: { projectId?: string | null }; session?: { sessionId?: string } | null; persisted?: boolean; reason?: string };
    expect(result.status).toBe(200);
    expect(body.activeContext?.projectId).toBe(PROJECT);
    expect(body.session?.sessionId).toBe(SESSION);
    expect(body.persisted).toBe(false);
    expect(body.reason).toBe("active_context_is_derived_not_stored");
  });

  it("validates a PUT and journals it, without claiming persistence that does not exist", async () => {
    const { routes, order } = await harness({ role: "developer", activeContext: resolver });
    const result = await call(routes, "put", ACTIVE_CONTEXT_URL, { companyId: COMPANY }, { projectId: PROJECT });
    const body = result.body as { status?: string; persisted?: boolean; activeContext?: { projectId?: string | null } };
    expect(result.status).toBe(200);
    expect(body.status).toBe("validated");
    expect(body.activeContext?.projectId).toBe(PROJECT);
    expect(body.persisted).toBe(false);
    expect(order).toEqual(["audit"]);
  });

  it("refuses an archived or foreign project as the active context", async () => {
    const { routes } = await harness({ role: "developer", activeContext: resolver });
    const archived = await call(routes, "put", ACTIVE_CONTEXT_URL, { companyId: COMPANY }, { projectId: "archived-project" });
    expect(archived.status).toBe(404);
    expect(errorCode(archived.body)).toBe("session_not_found");
    const foreign = await call(routes, "put", ACTIVE_CONTEXT_URL, { companyId: COMPANY }, { projectId: "foreign-project" });
    expect(foreign.status).toBe(404);
  });

  it("refuses an active session that belongs to another project", async () => {
    const { routes, order } = await harness({
      role: "developer",
      activeContext: resolver,
      sessionProjectId: "other-project",
    });
    const result = await call(routes, "put", ACTIVE_CONTEXT_URL, { companyId: COMPANY }, { projectId: PROJECT, sessionId: SESSION });
    expect(result.status).toBe(400);
    expect(errorCode(result.body)).toBe("invalid_arguments");
    expect(order).toEqual([]);
  });

  it("refuses an archived session as the active session", async () => {
    const { routes } = await harness({ role: "developer", activeContext: resolver, sessionStatus: "archived" });
    const result = await call(routes, "put", ACTIVE_CONTEXT_URL, { companyId: COMPANY }, { projectId: PROJECT, sessionId: SESSION });
    expect(result.status).toBe(409);
    expect(errorCode(result.body)).toBe("session_archived");
  });

  it("refuses the write path for a read-only principal", async () => {
    const { routes, order } = await harness({ role: "reviewer", activeContext: resolver });
    const result = await call(routes, "put", ACTIVE_CONTEXT_URL, { companyId: COMPANY }, { projectId: PROJECT });
    expect(result.status).toBe(403);
    expect(order).toEqual([]);
  });
});
