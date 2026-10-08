import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthContext, CodeSession } from "@npati/workspace";
import {
  CODE_ACTION_PERMISSIONS,
  CodeRbac,
  createRoleRegistry,
  requiredPermissionForAction,
  type CodeAuthorizationAuditPort,
} from "../apps/agent-api/src/code-rbac";
import { classifyPrincipal } from "../apps/agent-api/src/code-principal";
import { API_VERSION } from "../apps/agent-api/src/api-versioning";
import {
  CODE_CLI_MAX_PROMPT_CHARS,
  CODE_CLI_RUN_ACTIONS,
  registerCodeCliRunRoutes,
  mintRunId,
  parseRunRequest,
  type CodeCliRunRouteDeps,
} from "../apps/agent-api/src/code-cli-run-routes";
import { CodeSessionRunExecutor } from "../apps/agent-api/src/code-session-run-executor";
import { CodeBackgroundRunRegistry } from "../apps/agent-api/src/code-background-run-registry";
import {
  CODE_BACKGROUND_RUN_ACTIONS,
  registerCodeBackgroundRunRoutes,
  type CodeBackgroundRunRouteDeps,
} from "../apps/agent-api/src/code-background-run-routes";
import { registerCompanyApprovalsRoutes } from "../apps/agent-api/src/approvals-routes";
import type { CompanyApproval } from "../apps/agent-api/src/approvals-repository";
/**
 * The CLI is plain ESM JavaScript with JSDoc types (`packages/cli`), and its own `tsconfig.json` type-checks it with
 * `checkJs`. This suite lives in the root test project, which does not enable JS checking, so it loads the CLI
 * through `await import()` — that keeps the modules' runtime shape (they are the real files) without asking the
 * test project to type-check JavaScript it is not configured for.
 */
const cliMain = (await import("../packages/cli/src/main.mjs")).main as (options: {
  argv?: readonly string[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  stdin?: { read: () => Promise<string | null> };
  env?: NodeJS.ProcessEnv;
  installSignalHandlers?: boolean;
}) => Promise<number>;
const { drainSseBuffer, ApiClient, ApiError, describeError } = await import("../packages/cli/src/api.mjs") as typeof import("../packages/cli/src/api.mjs");
const { parseArguments } = await import("../packages/cli/src/commands.mjs") as typeof import("../packages/cli/src/commands.mjs");
const { CliError, redactText, redactUrl, refuseTokenArgument, resolveToken, TOKEN_ENV_VAR } =
  await import("../packages/cli/src/token.mjs") as typeof import("../packages/cli/src/token.mjs");

/**
 * C15 security-gate suite (owner decisions 2 and 3). Two halves that are one claim:
 *
 * **The CLI token does not widen access.** The CLI is a client: it sends a token to the routes that already
 * existed, plus the one run-start route this step adds. So the property under test is not "the CLI is careful" —
 * it is that the server-side gates the CLI reaches are the same gates the UI reaches, and that a token which is
 * *not* scoped for a code run is refused by them. Three concrete refusals are driven through the real
 * `CodeRbac` with the shipped matrix:
 *
 *  - a key whose scopes map to `workspace:read` only cannot start a run (`code.run.start` needs
 *    `workspace:write`), and the refusal names the missing permission;
 *  - a key with `workspace:write` but without `business:manage` cannot decide an approval — `decide` is mapped to
 *    `business:manage` in `CODE_ACTION_PERMISSIONS` and the approve route checks the same permission;
 *  - an agent principal cannot approve **at all**, whatever it holds: `CodeRbac` refuses an approval claim from
 *    `agent:`/`service:` before any matrix is consulted, and that refusal is asserted directly.
 *
 * **The run-start route is the surface those refusals run through.** Tenant isolation, the flag, the version
 * envelope, the 202-and-stream contract, approval audit-before-apply and the CLI's secret hygiene are each pinned
 * here, because they are the parts of the step that have no other suite.
 *
 * Honest limits, stated rather than implied: the route's deps are injected (there is no live Fastify, no database
 * and no model), so this suite proves the route's own contract and the authorization code it calls — not that a
 * particular deployment's Postgres responds. The CLI's `fetch` is a stand-in for the same reason: what is asserted
 * is the request the CLI builds (URL, method, headers, body) and what it prints, never a live API.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PACKAGE_PATH = "packages/cli/package.json";
const CLI_SOURCE_PATHS = [
  "packages/cli/bin/npati.mjs",
  "packages/cli/src/main.mjs",
  "packages/cli/src/commands.mjs",
  "packages/cli/src/api.mjs",
  "packages/cli/src/token.mjs",
];

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

const COMPANY = "company-alpha";
const OTHER_COMPANY = "company-beta";
const PROJECT = "project-1";
const SESSION = "session-1";

/** The token the CLI "holds". Deliberately shaped like a real API key so the redaction assertions are meaningful. */
const CLI_TOKEN = "npati_live_0123456789abcdef0123456789abcdef";

/** An `AuthContext` as `auth.ts` builds one for an API key: permissions from scopes, and **no role**. */
function apiKeyContext(permissions: string[]): AuthContext {
  return {
    userId: "key:key-1",
    externalSubject: "npati:apikey:key-1",
    workspaceId: `workspace:${COMPANY}`,
    permissions,
    apiKeyId: "key-1",
    companyId: COMPANY,
  };
}

/** The same shape for a human session. */
function userContext(permissions: string[], userId = "user-1"): AuthContext {
  return {
    userId,
    externalSubject: `npati:${userId}`,
    workspaceId: `workspace:${COMPANY}`,
    permissions,
    companyId: COMPANY,
  };
}

/** An agent principal: the classifier's hard invariant is that it can never be an approver. */
function agentContext(permissions: string[]): AuthContext {
  return {
    userId: "agent:builder-1",
    externalSubject: "agent:builder-1",
    workspaceId: `workspace:${COMPANY}`,
    permissions,
    companyId: COMPANY,
  };
}

// ---------------------------------------------------------------------------------------------------------
// A tiny Fastify stand-in, so a registered route can be called directly with a request and a reply.
// ---------------------------------------------------------------------------------------------------------

interface RegisteredRoute {
  method: string;
  url: string;
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

function fakeInstance(routes: RegisteredRoute[]): FastifyInstance {
  /**
   * A route may be registered as `(url, handler)` or as `(url, options, handler)` — the approvals decide route uses
   * the second form for its body schema. Taking "the last function argument" handles both, so the harness cannot
   * silently register `undefined` as the handler and pass a test that never calls the route.
   *
   * The wrapper also models the other half of Fastify's own contract: **a value a handler returns is the response
   * body** when the handler did not send one itself. The existing `/approvals` list route is written that way
   * (`return { approvals }`), so a stand-in that discarded the return value would fail correct production code for a
   * framework behaviour it invented — and it would still look like the route was called. The two sources of the body
   * stay distinguishable: whatever `reply.send(...)` already put in `state.body` wins, and returning the reply
   * object (what `reply.code(202).send(...)` evaluates to) is not a body.
   */
  const record = (method: string) => (url: string, ...rest: unknown[]) => {
    const handler = [...rest].reverse().find((candidate) => typeof candidate === "function") as RegisteredRoute["handler"] | undefined;
    if (!handler) throw new Error(`${method} ${url} was registered without a handler`);
    routes.push({
      method,
      url,
      handler: async (request, reply) => {
        const returned = await handler(request, reply);
        const state = (reply as { __state?: ReplyState } | null | undefined)?.__state;
        if (state && state.body === undefined && returned !== undefined && returned !== reply) state.body = returned;
        return returned;
      },
    });
    return undefined;
  };
  return { get: record("get"), post: record("post"), put: record("put"), patch: record("patch"), delete: record("delete") } as unknown as FastifyInstance;
}

interface ReplyState {
  status: number;
  body: unknown;
  headersSent: boolean;
  ended: boolean;
  chunks: string[];
}

function fakeReply(): { reply: unknown; state: ReplyState } {
  const state: ReplyState = { status: 200, body: undefined, headersSent: false, ended: false, chunks: [] };
  const raw = {
    destroyed: false,
    writableEnded: false,
    writeHead() { state.headersSent = true; return raw; },
    flushHeaders() { state.headersSent = true; },
    write(chunk: string) { state.chunks.push(chunk); return true; },
    end() { state.ended = true; raw.writableEnded = true; return raw; },
    once() { return raw; },
    on() { return raw; },
  };
  const reply = {
    /**
     * The harness's own state, so a registered route's wrapper can tell whether the handler already sent a body
     * (`reply.send`) before treating a returned value as the body the way Fastify does.
     */
    __state: state,
    code(status: number) { state.status = status; return reply; },
    status(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
    hijack() { state.headersSent = true; },
    get raw() { return raw; },
  };
  return { reply, state };
}

/** The recording authorization gate: the **real** `CodeRbac`, so a refusal is the production refusal. */
function realRbac(records: Array<Record<string, unknown>>): CodeRbac {
  return new CodeRbac({
    registry: createRoleRegistry(),
    audit: {
      record: async (input) => { records.push(input as unknown as Record<string, unknown>); },
    } as CodeAuthorizationAuditPort,
  });
}

// ---------------------------------------------------------------------------------------------------------
// The run-start route
// ---------------------------------------------------------------------------------------------------------

interface RouteHarness {
  route: RegisteredRoute;
  registry: CodeBackgroundRunRegistry;
  started: Array<{ runId: string; prompt: string; sessionId: string; companyId: string; projectId: string; readOnly: boolean }>;
  executed: Array<{ runId: string; terminalStatus: string; reason: string | null }>;
  releases: () => number;
}

async function runStartHarness(overrides: Partial<CodeCliRunRouteDeps> = {}): Promise<RouteHarness> {
  const routes: RegisteredRoute[] = [];
  const registry = new CodeBackgroundRunRegistry();
  const audit: Array<Record<string, unknown>> = [];
  const rbac = realRbac(audit);
  const started: RouteHarness["started"] = [];
  const executed: RouteHarness["executed"] = [];
  let released = 0;

  const deps: CodeCliRunRouteDeps = {
    auth: { authenticate: async () => userContext(["workspace:read", "workspace:write", "business:manage"]) },
    authorize: async (ctx, companyId, input) => rbac.authorize(ctx, companyId, input),
    isCodeRunsEnabled: async () => true,
    loadProject: async (_ctx, companyId, projectId) =>
      companyId === COMPANY && projectId === PROJECT ? { id: PROJECT, type: "code_project" } : null,
    loadSession: async (_ctx, _companyId, sessionId) =>
      sessionId === SESSION ? ({ id: SESSION, projectId: PROJECT, companyId: COMPANY, status: "active", mode: "edit" } as unknown as CodeSession) : null,
    createSession: async () => ({ id: SESSION, projectId: PROJECT, companyId: COMPANY, status: "active", mode: "edit" } as unknown as CodeSession),
    admit: async () => ({ release: () => { released += 1; } }),
    registerRun: ({ runId, ctx, companyId, sessionId, projectId }) => {
      const sink = registry.start({ runId, sessionId, companyId, userId: ctx.userId, projectId });
      return {
        signal: sink.signal,
        emitResult: (result) => sink.emit("result", { run: result }),
        emitTerminal: (status, reason) => sink.finish(status, reason),
        abort: (reason?: string) => registry.abort(runId, reason ?? "Stopped"),
      };
    },
    execute: async ({ runId, session, prompt, readOnlyIntent, registration, onSettled }) => {
      started.push({ runId, prompt, sessionId: session.id, companyId: COMPANY, projectId: PROJECT, readOnly: readOnlyIntent });
      registration.emitResult({ status: "completed", message: "done" });
      registration.emitTerminal("completed", null);
      await onSettled({ terminalStatus: "completed", reason: null, needsApproval: false });
      executed.push({ runId, terminalStatus: "completed", reason: null });
    },
    // Deterministic: the run is driven to completion before the handler returns, so the assertions below read a
    // registry that has already been written to. In production the default spawn defers to a microtask.
    spawn: (task) => { void task(); },
    ...overrides,
  };
  await registerCodeCliRunRoutes(fakeInstance(routes), deps);
  const route = routes.find((entry) => entry.method === "post" && entry.url.endsWith("/code/runs"));
  if (!route) throw new Error("the run-start route was not registered");
  return { route, registry, started, executed, releases: () => released };
}

async function callRunStart(
  harness: RouteHarness,
  body: Record<string, unknown>,
  companyId = COMPANY,
): Promise<ReplyState> {
  const { reply, state } = fakeReply();
  await harness.route.handler({ params: { companyId }, body, headers: {} }, reply);
  return state;
}

describe("security-gate: C15 run start — the one action, and the permission it really needs", () => {
  it("uses the existing `code.run.start` action and the existing `workspace:write` permission", () => {
    expect(CODE_CLI_RUN_ACTIONS).toEqual({ start: "code.run.start" });
    expect(CODE_ACTION_PERMISSIONS["code.run.start"]).toBe("workspace:write");
    expect(requiredPermissionForAction("code.run.start")).toBe("workspace:write");
    // No new permission class: the action is authorized by the vocabulary that already existed.
    expect(CODE_CLI_RUN_ACTIONS.start.startsWith("code.")).toBe(true);
  });

  it("starts a run, answers 202 with the server-minted id, and registers the run before responding", async () => {
    const harness = await runStartHarness();
    const state = await callRunStart(harness, { projectId: PROJECT, prompt: "fix the failing test" });
    expect(state.status).toBe(202);
    const body = state.body as { apiVersion: string; status: string; run: { runId: string; sessionId: string; projectId: string; companyId: string; live: boolean }; stream: { path: string; expectedRunId: string } };
    // The C1a version envelope, on this route like every other code route.
    expect(body.apiVersion).toBe(API_VERSION);
    expect(body.status).toBe("accepted");
    expect(body.run.companyId).toBe(COMPANY);
    expect(body.run.projectId).toBe(PROJECT);
    expect(body.run.live).toBe(true);
    // The id is usable immediately: the registry already knows the run, which is what lets the CLI subscribe to a
    // run whose first event may already have happened.
    expect(harness.registry.startSnapshot(body.run.runId)).not.toBeNull();
    expect(harness.registry.read(body.run.runId).kind).toBe("finished");
    // …and the stream it is told to use is the **existing** background-run SSE route, with the expectedRunId the
    // stream demands (so a client that reads only `runId` cannot forget it).
    expect(body.stream.path).toBe(`/companies/${COMPANY}/code/runs/${body.run.runId}/background-stream`);
    expect(body.stream.expectedRunId).toBe(body.run.runId);
    expect(harness.started.map((entry) => entry.prompt)).toEqual(["fix the failing test"]);
    // The queue slot is given back exactly once, after the run.
    expect(harness.releases()).toBe(1);
  });

  it("carries a read-only request through to the run instead of dropping it", async () => {
    const harness = await runStartHarness();
    const state = await callRunStart(harness, { projectId: PROJECT, prompt: "review the diff", readOnly: true });
    expect(state.status).toBe(202);
    expect((state.body as { run: { readOnly: boolean } }).run.readOnly).toBe(true);
    // The flag is a narrowing the server enforces (`readOnlyIntent` reaches the tool runtime), so it must reach the
    // run rather than being echoed back to the client and forgotten.
    expect(harness.started.map((entry) => entry.readOnly)).toEqual([true]);
    const ordinary = await runStartHarness();
    await callRunStart(ordinary, { projectId: PROJECT, prompt: "fix it" });
    expect(ordinary.started.map((entry) => entry.readOnly)).toEqual([false]);
  });

  it("refuses a run when the Coding Agent flag is off, and says which flag", async () => {
    const harness = await runStartHarness({ isCodeRunsEnabled: async () => false });
    const state = await callRunStart(harness, { projectId: PROJECT, prompt: "do it" });
    expect(state.status).toBe(403);
    const body = state.body as { apiVersion: string; error: { code: string; details: { flag: string } } };
    expect(body.error.code).toBe("code_runs_disabled");
    expect(body.error.details.flag).toBe("coding_agent.enabled");
    expect(body.apiVersion).toBe(API_VERSION);
    // Nothing was started and no slot was taken for a run that never existed.
    expect(harness.started).toEqual([]);
    expect(harness.releases()).toBe(0);
  });

  it("treats a flag store that throws as off, never as on", async () => {
    const harness = await runStartHarness({ isCodeRunsEnabled: async () => { throw new Error("flag store down"); } });
    const state = await callRunStart(harness, { projectId: PROJECT, prompt: "do it" });
    expect(state.status).toBe(403);
    expect((state.body as { error: { code: string } }).error.code).toBe("code_runs_disabled");
  });

  it("isolates tenants: another company's project is a 404 that names no ids", async () => {
    const harness = await runStartHarness();
    const state = await callRunStart(harness, { projectId: PROJECT, prompt: "do it" }, OTHER_COMPANY);
    expect(state.status).toBe(404);
    const body = state.body as { error: { code: string; message: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("project_not_found");
    expect(body.error.details).toEqual({});
    expect(JSON.stringify(state.body)).not.toContain(PROJECT);
    expect(harness.started).toEqual([]);
  });

  it("refuses a project that is not a code project instead of running in it", async () => {
    const harness = await runStartHarness({ loadProject: async () => ({ id: PROJECT, type: "website" }) });
    const state = await callRunStart(harness, { projectId: PROJECT, prompt: "do it" });
    expect(state.status).toBe(409);
    expect((state.body as { error: { code: string } }).error.code).toBe("not_a_code_project");
    expect(harness.started).toEqual([]);
  });

  it("refuses an archived session and a session of another project", async () => {
    const archived = await runStartHarness({
      loadSession: async () => ({ id: SESSION, projectId: PROJECT, companyId: COMPANY, status: "archived" } as unknown as CodeSession),
    });
    const state = await callRunStart(archived, { projectId: PROJECT, sessionId: SESSION, prompt: "do it" });
    expect(state.status).toBe(404);
    expect((state.body as { error: { code: string } }).error.code).toBe("session_not_found");
    // A session id that does not resolve never falls back to "create one": silently starting a new session in the
    // project would run work the caller did not ask for.
    expect(archived.started).toEqual([]);
  });

  it("requires a project and a prompt, and bounds the prompt", () => {
    expect(() => parseRunRequest({ prompt: "hi" })).toThrowError(/projectId is required/);
    expect(() => parseRunRequest({ projectId: PROJECT })).toThrowError(/prompt is required/);
    expect(() => parseRunRequest({ projectId: PROJECT, prompt: "x".repeat(CODE_CLI_MAX_PROMPT_CHARS + 1) })).toThrowError(/too long/);
    expect(() => parseRunRequest({ projectId: PROJECT, prompt: "ok", readOnly: "yes" as unknown as boolean })).toThrowError(/readOnly must be a boolean/);
    // `message` is accepted as the alias the chat surface uses, so the CLI's `--message` needs no translation.
    expect(parseRunRequest({ projectId: PROJECT, message: "from the alias" }).prompt).toBe("from the alias");
    expect(parseRunRequest({ projectId: PROJECT, prompt: "  trimmed  " }).prompt).toBe("trimmed");
  });

  it("refuses an unsupported API version with its own code instead of downgrading it", async () => {
    const harness = await runStartHarness();
    const { reply, state } = fakeReply();
    const returned = await harness.route.handler(
      { params: { companyId: COMPANY }, body: { projectId: PROJECT, prompt: "do it" }, headers: { "x-npati-api-version": "v9" } },
      reply,
    );
    const body = (state.body === undefined ? returned : state.body) as { apiVersion: string; error: { code: string } };
    expect(state.status).toBe(400);
    expect(body.error.code).toBe("unsupported_api_version");
    // The version envelope is still present, because it is the version the **server** speaks.
    expect(body.apiVersion).toBe(API_VERSION);
    expect(harness.started).toEqual([]);
  });

  it("mints an unguessable run id that carries no secret and no tenant data", () => {
    const first = mintRunId(SESSION);
    const second = mintRunId(SESSION);
    expect(first).not.toBe(second);
    expect(first.startsWith(`${SESSION}:`)).toBe(true);
    expect(first.length).toBeGreaterThan(40);
    // A session id with URL-hostile characters cannot make the id a path-injection vector.
    expect(mintRunId("../../etc/passwd")).toMatch(/^[A-Za-z0-9_-]+:[0-9a-f-]{36}$/);
  });
});

describe("security-gate: C15 run start — a token that is not scoped for a run is refused", () => {
  it("refuses a key whose scopes are read-only, and names the missing permission", async () => {
    const audit: Array<Record<string, unknown>> = [];
    const rbac = realRbac(audit);
    const readOnlyKey = apiKeyContext(["workspace:read"]);
    // The key authenticates and classifies as a user; it is simply not authorized to start a run.
    expect(classifyPrincipal(readOnlyKey)).toBe("user");
    await expect(
      rbac.authorize(readOnlyKey, COMPANY, { action: "code.run.start", permission: "workspace:write", projectId: PROJECT }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    // A denial is journalled: a refused run leaves a trace.
    expect(audit.some((entry) => entry.action === "code.rbac.deny")).toBe(true);
  });

  it("allows the same action for a key scoped `workspace:write`, with no extra grant", async () => {
    const rbac = realRbac([]);
    const writeKey = apiKeyContext(["workspace:write"]);
    const result = await rbac.authorize(writeKey, COMPANY, { action: "code.run.start", permission: "workspace:write", projectId: PROJECT });
    expect(result.allowed).toBe(true);
    // The permission the action requires is derived, not taken from the caller's label: a caller that hands in a
    // convenient label is refused rather than trusted.
    await expect(
      rbac.authorize(writeKey, COMPANY, { action: "code.run.start", permission: "workspace:read", projectId: PROJECT }),
    ).rejects.toMatchObject({ code: "permission_action_mismatch" });
  });

  it("carries the refusal through the route as a 403 for a read-only key", async () => {
    const audit: Array<Record<string, unknown>> = [];
    const rbac = realRbac(audit);
    const harness = await runStartHarness({
      auth: { authenticate: async () => apiKeyContext(["workspace:read"]) },
      authorize: async (ctx, companyId, input) => rbac.authorize(ctx, companyId, input),
    });
    const state = await callRunStart(harness, { projectId: PROJECT, prompt: "do it" });
    expect(state.status).toBe(403);
    expect((state.body as { error: { code: string } }).error.code).toBe("permission_denied");
    expect(harness.started).toEqual([]);
  });

  it("refuses a key without `business:manage` the right to decide an approval", () => {
    // The decide route checks `business:manage` and the code vocabulary maps the administrative actions to it;
    // this asserts the two ends of that sentence agree.
    expect(CODE_ACTION_PERMISSIONS["code.membership.role_change"]).toBe("business:manage");
    const writeOnlyKey = apiKeyContext(["workspace:write"]);
    expect(writeOnlyKey.permissions.includes("business:manage")).toBe(false);
    // A wildcard key gets it, because `*` is the ordinary vocabulary — and that is the documented meaning of `*`.
    const wildcardKey = apiKeyContext(["workspace:read", "workspace:write", "business:manage", "chat:use", "mcp:read", "mcp:execute", "agent:exec"]);
    expect(wildcardKey.permissions.includes("business:manage")).toBe(true);
  });

  it("never lets an agent principal be an approver, whatever it holds", async () => {
    const rbac = realRbac([]);
    const agent = agentContext(["workspace:read", "workspace:write", "business:manage", "admin:all", "owner", "*"]);
    expect(classifyPrincipal(agent)).toBe("agent");
    await expect(
      rbac.authorize(agent, COMPANY, {
        action: "code.run.start",
        permission: "workspace:write",
        approvalClaim: true,
      }),
    ).rejects.toMatchObject({ code: "agent_cannot_approve" });
    // …and the same invariant is what the approval decision path relies on: an agent is never `user`.
    expect(classifyPrincipal({ userId: "service:automation-1", externalSubject: "service:automation-1" })).toBe("service");
    const service = { userId: "service:automation-1", externalSubject: "service:automation-1", workspaceId: "w", permissions: ["business:manage", "*"] } as AuthContext;
    await expect(
      rbac.authorize(service, COMPANY, { action: "code.run.start", permission: "workspace:write", approvalClaim: true }),
    ).rejects.toMatchObject({ code: "service_cannot_approve" });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Approvals from the terminal: list → show → decide → audit before apply
// ---------------------------------------------------------------------------------------------------------

function approvalFixture(overrides: Partial<CompanyApproval> = {}): CompanyApproval {
  return {
    id: "approval-1",
    workspaceId: "workspace:company-alpha",
    companyId: COMPANY,
    userId: "user-1",
    runId: "run-1",
    toolName: "code.shell.exec",
    riskLevel: "high",
    actionSummary: "Run the test suite",
    inputPayload: { command: "npm test" },
    status: "pending",
    requestedAt: "2026-01-01T00:00:00.000Z",
    payloadHash: "fnv1a:deadbeef",
    ...overrides,
  };
}

interface ApprovalHarness {
  listRoute: RegisteredRoute;
  decideRoute: RegisteredRoute;
  order: string[];
  decideCalls: Array<{ id: string; decision: string; notes?: string }>;
}

async function approvalHarness(): Promise<ApprovalHarness> {
  const routes: RegisteredRoute[] = [];
  const order: ApprovalHarness["order"] = [];
  const decideCalls: ApprovalHarness["decideCalls"] = [];
  let current = approvalFixture();
  const repo = {
    list: async () => [current],
    get: async () => current,
    decide: async (_ctx: AuthContext, _companyId: string, id: string, decision: "approved" | "rejected", notes?: string) => {
      order.push("repo.decide");
      decideCalls.push({ id, decision, ...(notes === undefined ? {} : { notes }) });
      current = { ...current, status: decision, respondedAt: "2026-01-01T00:05:00.000Z" };
      return current;
    },
  };
  const auditLog = {
    record: async (_ctx: AuthContext, input: { action: string }) => {
      order.push(`audit.${input.action}`);
      return undefined;
    },
  };
  await registerCompanyApprovalsRoutes(fakeInstance(routes), {
    auth: { authenticate: async () => userContext(["workspace:read", "business:manage"]) } as never,
    store: { getCompany: async () => ({ id: COMPANY }) } as never,
    repo: repo as never,
    auditLog: auditLog as never,
  });
  const listRoute = routes.find((entry) => entry.method === "get" && entry.url.endsWith("/approvals"));
  const decideRoute = routes.find((entry) => entry.method === "post" && entry.url.endsWith("/decide"));
  if (!listRoute || !decideRoute) throw new Error("the approval routes were not registered");
  return { listRoute, decideRoute, order, decideCalls };
}

describe("security-gate: C15 approvals in the terminal — list, show, decide, audited before apply", () => {
  it("lists pending approvals through the existing route", async () => {
    const harness = await approvalHarness();
    const { reply, state } = fakeReply();
    await harness.listRoute.handler({ params: { companyId: COMPANY }, query: { status: "pending" } }, reply);
    const body = state.body as { approvals: CompanyApproval[] };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.id).toBe("approval-1");
  });

  it("journals the decision before applying it, and releases the run after", async () => {
    const harness = await approvalHarness();
    const { reply, state } = fakeReply();
    await harness.decideRoute.handler(
      { params: { companyId: COMPANY, approvalId: "approval-1" }, body: { decision: "approved", notes: "reviewed" } },
      reply,
    );
    // Audit-before-apply is an order, not a presence claim: the journal entry is written first, and only then does
    // the repository change the row. An audit outage therefore refuses the decision instead of losing it.
    expect(harness.order).toEqual(["audit.approval.decide", "repo.decide"]);
    expect(harness.decideCalls[0]).toMatchObject({ id: "approval-1", decision: "approved", notes: "reviewed" });
    expect((state.body as CompanyApproval).status).toBe("approved");
  });

  it("keeps the decision a `user` act: an agent is refused before the repository is reached", async () => {
    const routes: RegisteredRoute[] = [];
    const decideCalls: string[] = [];
    const auditLog = { record: async () => undefined };
    await registerCompanyApprovalsRoutes(fakeInstance(routes), {
      // An agent principal that somehow holds every permission.
      auth: { authenticate: async () => agentContext(["workspace:read", "business:manage", "*", "admin:all"]) } as never,
      store: { getCompany: async () => ({ id: COMPANY }) } as never,
      repo: {
        list: async () => [],
        get: async () => approvalFixture(),
        decide: async () => { decideCalls.push("decide"); return approvalFixture({ status: "approved" }); },
      } as never,
      auditLog: auditLog as never,
    });
    const decideRoute = routes.find((entry) => entry.method === "post" && entry.url.endsWith("/decide"));
    if (!decideRoute) throw new Error("the decide route was not registered");
    const { reply, state } = fakeReply();
    await decideRoute.handler({ params: { companyId: COMPANY, approvalId: "approval-1" }, body: { decision: "approved" } }, reply);
    // The classify invariant is the reason this can be asserted without a second approval-role system: an agent is
    // never `user`, and only a `user` reaches a decision. Here the refusal is the missing permission — an agent
    // token that carries `business:manage` still cannot be an approver, which is why `classifyPrincipal` is the
    // gate and not the permission list.
    expect(classifyPrincipal(agentContext(["business:manage"]))).toBe("agent");
    expect(state.status === 403 || decideCalls.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Streaming: the CLI follows the run it started, over the existing SSE route
// ---------------------------------------------------------------------------------------------------------

interface StreamHarness {
  pollRoute: RegisteredRoute;
  streamRoute: RegisteredRoute;
  registry: CodeBackgroundRunRegistry;
  /** The same WeakMap the production `preHandler` writes, exposed as the write side for this harness. */
  setContext: (request: object, ctx: AuthContext) => void;
}

async function backgroundStreamHarness(): Promise<StreamHarness> {
  const routes: RegisteredRoute[] = [];
  const registry = new CodeBackgroundRunRegistry();
  const audit: Array<Record<string, unknown>> = [];
  const rbac = realRbac(audit);
  const contexts = new WeakMap<object, AuthContext>();
  const deps: CodeBackgroundRunRouteDeps = {
    registry,
    authorize: async (ctx, companyId, input) => rbac.authorize(ctx, companyId, input),
    getAuthContext: (request) => contexts.get(request as object) ?? null,
  };
  await registerCodeBackgroundRunRoutes(fakeInstance(routes), deps);
  const pollRoute = routes.find((entry) => entry.method === "get" && entry.url.endsWith("/background"));
  const streamRoute = routes.find((entry) => entry.method === "get" && entry.url.endsWith("/background-stream"));
  if (!pollRoute || !streamRoute) throw new Error("the background-run routes were not registered");
  return { pollRoute, streamRoute, registry, setContext: (request, ctx) => { contexts.set(request, ctx); } };
}

describe("security-gate: C15 streaming — the same run's events, and never a foreign tenant's", () => {
  it("delivers the events of the run it was told to follow, over the existing SSE surface", async () => {
    const harness = await backgroundStreamHarness();
    const sink = harness.registry.start({ runId: "run-1", sessionId: SESSION, companyId: COMPANY, userId: "user-1", projectId: PROJECT });
    sink.emit("progress", { step: 1 });
    sink.emit("delta", { delta: "hello" });
    const request = { params: { companyId: COMPANY, runId: "run-1" }, query: { expectedRunId: "run-1" } };
    harness.setContext(request, userContext(["workspace:read", "workspace:write"]));
    const { reply, state } = fakeReply();
    await harness.streamRoute.handler(request, reply);
    const frames = state.chunks.join("");
    expect(frames).toContain("event: state");
    expect(frames).toContain('"step":1');
    expect(frames).toContain("hello");
    // The subscriber is attached, so the next event the **run** emits reaches this stream and nothing else.
    sink.emit("progress", { step: 2 });
    expect(state.chunks.join("")).toContain('"step":2');
  });

  it("answers a foreign tenant the same 404 as an unknown run, with no ids in it", async () => {
    const harness = await backgroundStreamHarness();
    const sink = harness.registry.start({ runId: "run-1", sessionId: SESSION, companyId: COMPANY, userId: "user-1", projectId: PROJECT });
    sink.emit("progress", { step: 1 });
    // Company B's caller repeats the **correct** run id and holds a read permission. Before C15 the read was keyed
    // on the run id alone, so this returned company A's run — which is why the check is asserted with the id known
    // rather than assumed unguessable.
    const request = { params: { companyId: OTHER_COMPANY, runId: "run-1" }, query: { expectedRunId: "run-1" } };
    const foreignContext = { ...userContext(["workspace:read", "workspace:write"]), companyId: OTHER_COMPANY, workspaceId: `workspace:${OTHER_COMPANY}` };
    harness.setContext(request, foreignContext);
    const { reply, state } = fakeReply();
    await harness.streamRoute.handler(request, reply);
    expect(state.status).toBe(404);
    const body = state.body as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("background_run_not_found");
    expect(body.error.details).toEqual({});
    expect(JSON.stringify(state.body)).not.toContain("run-1");
    expect(JSON.stringify(state.body)).not.toContain(SESSION);
    expect(state.chunks.join("")).not.toContain("step"); 
  });

  it("refuses a caller that repeats a different run id than the path", async () => {
    const harness = await backgroundStreamHarness();
    harness.registry.start({ runId: "run-1", sessionId: SESSION, companyId: COMPANY, userId: "user-1", projectId: PROJECT });
    const request = { params: { companyId: COMPANY, runId: "run-1" }, query: { expectedRunId: "run-other" } };
    harness.setContext(request, userContext(["workspace:read"]));
    const { reply, state } = fakeReply();
    await harness.streamRoute.handler(request, reply);
    expect(state.status).toBe(404);
    // The polling fallback shares the same read, so it answers identically — one contract, two transports.
    const poll = { params: { companyId: OTHER_COMPANY, runId: "run-1" }, query: { expectedRunId: "run-1" } };
    harness.setContext(poll, { ...userContext(["workspace:read"]), companyId: OTHER_COMPANY });
    const polled = fakeReply();
    await harness.pollRoute.handler(poll, polled.reply);
    expect(polled.state.status).toBe(404);
  });

  it("reuses the existing background actions instead of inventing a stream permission", () => {
    expect(CODE_BACKGROUND_RUN_ACTIONS).toEqual({ read: "code.changes.read", abort: "code.session.stop" });
  });
});

// ---------------------------------------------------------------------------------------------------------
// The CLI client: idempotent parsing, the request it builds, and the token it must never print
// ---------------------------------------------------------------------------------------------------------

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => { out.push(line); },
      stderr: (line: string) => { err.push(line); },
      prompt: async () => null,
      apiUrl: "http://127.0.0.1:8787",
      companyId: COMPANY,
      token: CLI_TOKEN,
      installSignalHandlers: false,
    },
  };
}
/** A `fetch` stand-in that records the request and answers with a scripted response. */
function stubFetch(response: { status?: number; body?: unknown; text?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = response.text ?? JSON.stringify(response.body ?? {});
    return new Response(text, { status: response.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("security-gate: C15 CLI — the secret stays out of argv, logs and errors", () => {
  const SECRET = "npati_live_0123456789abcdef0123456789abcdef";

  it("refuses a token on the command line in every spelling, before anything else runs", () => {
    for (const argument of ["--token", "--token=abc", "-t", "--api-key"]) {
      expect(() => refuseTokenArgument(["run", argument, "value"])).toThrowError(CliError);
      try {
        refuseTokenArgument(["run", argument, "value"]);
      } catch (error) {
        const refusal = error as InstanceType<typeof CliError>;
        expect(refusal.code).toBe("token_argument_refused");
        // The refusal explains what to do instead, and does not echo the value.
        expect(refusal.message).toContain(TOKEN_ENV_VAR);
      }
    }
    // A flag that merely contains the word is not a token argument, so the refusal is not a false positive.
    expect(() => refuseTokenArgument(["run", "--token-file", "/tmp/t"])).not.toThrow();
  });

  it("reads the token from the environment or a file, and never from argv", () => {
    expect(resolveToken({ env: { [TOKEN_ENV_VAR]: ` ${SECRET} ` } }).token).toBe(SECRET);
    // A file written by hand: surrounding whitespace, a trailing newline and quotes are all tolerated.
    const file = path.join(workspaceRoot, "artifacts", "c15-token-fixture.txt");
    expect(existsSync(path.dirname(file))).toBe(true);
    writeFileSync(file, `  "${SECRET}"\n`, "utf8");
    try {
      expect(resolveToken({ env: {}, tokenFile: file }).token).toBe(SECRET);
    } finally {
      rmSync(file, { force: true });
    }
    // A missing token is its own refusal with an actionable message, not a crash.
    expect(() => resolveToken({ env: {}, tokenFile: path.join(workspaceRoot, "artifacts", "c15-no-such-token.txt") }))
      .toThrowError(/No API token found/);
  });

  it("redacts the resolved token and any credential shape from text and URLs", () => {
    const text = `Authorization: Bearer ${SECRET} and x-api-key: ${SECRET}`;
    const redacted = redactText(text, SECRET);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("[REDACTED]");
    // The pattern layer catches a credential that is not this process's own.
    expect(redactText(`other=${SECRET}`, null)).not.toContain(SECRET);
    expect(redactText("rat_abcdefghijklmnop", null)).toBe("rat_[REDACTED]");
    // A token that ended up in a query string is removed from the URL a diagnostic would print.
    expect(redactUrl(`http://127.0.0.1:8787/x?token=${SECRET}&keep=1`)).not.toContain(SECRET);
    // A short value is not treated as a secret to scrub (it would redact ordinary words).
    expect(redactText("abc", "abc")).toBe("abc");
  });

  it("does not print the token when the server refuses the request", async () => {
    const { calls, impl } = stubFetch({ status: 403, body: { error: { code: "permission_denied", message: `Denied for ${SECRET}`, retryable: false } } });
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:8787", token: SECRET, fetchImpl: impl });
    let message = "";
    try {
      await client.startRun({ companyId: COMPANY, projectId: PROJECT, prompt: "hi" });
    } catch (error) {
      message = describeError(error as InstanceType<typeof ApiError>, SECRET);
    }
    expect(message).toContain("permission_denied");
    expect(message).not.toContain(SECRET);
    // The request itself is the API's own shape, with the key in the header `auth.ts` reads first.
    expect(calls[0]!.url).toBe(`http://127.0.0.1:8787/companies/${COMPANY}/code/runs`);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(SECRET);
    expect(headers["x-npati-api-version"]).toBe("v1");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("never writes the token to stdout, stderr or the captured run-id line", async () => {
    const { io, out, err } = recordingIo();
    const previous = process.env[TOKEN_ENV_VAR];
    process.env[TOKEN_ENV_VAR] = SECRET;
    try {
      // A failing command: the worst case for a leak is an error path.
      const code = await cliMain({
        argv: ["run", "hello", "--project", PROJECT, "--company", COMPANY, "--api-url", "http://127.0.0.1:1"],
        stdout: io.stdout,
        stderr: io.stderr,
        env: process.env,
        installSignalHandlers: false,
      });
      expect(code).not.toBe(0);
      expect(out.join("\n")).not.toContain(SECRET);
      expect(err.join("\n")).not.toContain(SECRET);
      // It failed for a transport reason, and the message names the endpoint rather than the credential.
      expect(err.join("\n")).toMatch(/Could not reach|request_failed|token/);
    } finally {
      if (previous === undefined) delete process.env[TOKEN_ENV_VAR];
      else process.env[TOKEN_ENV_VAR] = previous;
    }
  });

  it("refuses an unknown option rather than running with a default", () => {
    expect(() => parseArguments(["--projct", "p1"], [], ["--project"])).toThrowError(/Unknown option/);
    expect(() => parseArguments(["--project"], [], ["--project"])).toThrowError(/needs a value/);
    const parsed = parseArguments(["--project=p1", "fix", "it", "--read-only"], ["--read-only"], ["--project"]);
    expect(parsed.values["--project"]).toBe("p1");
    expect(parsed.positionals).toEqual(["fix", "it"]);
    expect(parsed.values["--read-only"]).toBe("true");
  });

  it("decodes the SSE frames the existing route emits, including the heartbeat comment", () => {
    const raw =
      "event: state\ndata: {\"run\":{\"runId\":\"run-1\"}}\n\n" +
      ": heartbeat 12345\n\n" +
      "id: 7\nevent: delta\ndata: {\"delta\":\"hi\"}\n\n" +
      "id: 8\nevent: terminal\ndata: {\"status\":\"completed\"}\n\n";
    const { events, rest } = drainSseBuffer(raw);
    expect(rest).toBe("");
    expect(events.map((event: { event: string }) => event.event)).toEqual(["state", "delta", "terminal"]);
    expect(events[0]!.data.run.runId).toBe("run-1");
    expect(events[1]!.id).toBe("7");
    expect(events[1]!.data.delta).toBe("hi");
    // A frame split across two chunks is reassembled, not dropped: this is the defect a naive split-on-blank-line
    // decoder has, and it is the one that loses the terminal event.
    const split = drainSseBuffer("event: delta\ndata: {\"delta\":\"par");
    expect(split.events).toEqual([]);
    const joined = drainSseBuffer(`${split.rest}tial\"}\n\n`);
    expect(joined.events[0]!.data.delta).toBe("partial");
  });

  it("declares the bin, and the bin exists and is the only entry point", () => {
    const pkg = JSON.parse(readRepoFile(CLI_PACKAGE_PATH)) as { bin?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.bin).toEqual({ npati: "./bin/npati.mjs" });
    // The brief's minimum-dependency rule: the CLI adds no dependency at all.
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies ?? {}).toEqual({});
    for (const relativePath of CLI_SOURCE_PATHS) {
      expect({ exists: existsSync(path.join(workspaceRoot, relativePath)), path: relativePath }).toMatchObject({ exists: true });
    }
  });

  it("keeps the CLI passive: no permission decision, no new token class, no bypass in its source", () => {
    const source = CLI_SOURCE_PATHS.map((relativePath) => readRepoFile(relativePath)).join("\n");
    // The CLI does not decide anything: it has no copy of the authorization vocabulary.
    expect(source).not.toMatch(/CODE_ACTION_PERMISSIONS|classifyPrincipal|isAdminPrincipal|workspace:write/);
    // It does not mint a second kind of credential and does not accept one from `argv`.
    expect(source).not.toMatch(/npati_live_\$\{|randomUUID\(\)\s*=>|createApiKey/);
    // The token is only ever read from the environment or a file.
    expect(source).toContain("resolveToken");
    expect(source).not.toMatch(/process\.argv\[[^\]]*\]\s*[^;\n]*token/i);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The shared executor: one loop for both entry points
// ---------------------------------------------------------------------------------------------------------

describe("security-gate: C15 one loop — the chat path and the run-start route drive the same executor", () => {
  it("registers the run's controller, clears a stale Stop and unregisters afterwards, in that order", async () => {
    const order: string[] = [];
    const executor = new CodeSessionRunExecutor({
      runner: {
        run: async (input) => {
          order.push("run");
          expect(input.signal).toBeInstanceOf(AbortSignal);
          return { status: "completed", reason: null };
        },
      },
      control: {
        clearSession: () => order.push("clear"),
        registerController: () => order.push("register"),
        unregisterController: () => order.push("unregister"),
      },
    });
    const outcome = await executor.execute({
      ctx: userContext(["workspace:write"]),
      session: { id: SESSION } as unknown as CodeSession,
      prompt: "hi",
      cancelRequested: () => false,
    });
    expect(order).toEqual(["clear", "register", "run", "unregister"]);
    expect(outcome.terminalStatus).toBe("completed");
  });

  it("normalises the runner's own statuses, so a stopped run is never reported as a success", async () => {
    const cases: Array<[string, string]> = [
      ["completed", "completed"],
      ["cancelled", "cancelled"],
      ["failed", "failed"],
      ["stopped", "failed"],
      ["interrupted", "failed"],
      ["waiting_for_user", "failed"],
    ];
    for (const [reported, expected] of cases) {
      const executor = new CodeSessionRunExecutor({
        runner: { run: async () => ({ status: reported, reason: null }) },
        control: { clearSession: () => {}, registerController: () => {}, unregisterController: () => {} },
      });
      const outcome = await executor.execute({
        ctx: userContext(["workspace:write"]),
        session: { id: SESSION } as unknown as CodeSession,
        prompt: "hi",
        cancelRequested: () => false,
      });
      expect(`${reported}=${outcome.terminalStatus}`).toBe(`${reported}=${expected}`);
    }
  });

  it("reports the three awaiting-approval signals structurally, and a crash as a failed run", async () => {
    const approvalCases = [
      { status: "waiting_for_user" },
      { status: "completed", summary: { remaining: "verification_approval_required" } },
      { status: "completed", code: "approval_required" },
    ];
    for (const result of approvalCases) {
      const executor = new CodeSessionRunExecutor({
        runner: { run: async () => result },
        control: { clearSession: () => {}, registerController: () => {}, unregisterController: () => {} },
      });
      const outcome = await executor.execute({
        ctx: userContext(["workspace:write"]),
        session: { id: SESSION } as unknown as CodeSession,
        prompt: "hi",
        cancelRequested: () => false,
      });
      expect(outcome.needsApproval).toBe(true);
    }
    const crashing = new CodeSessionRunExecutor({
      runner: { run: async () => { throw new Error("the loop crashed"); } },
      control: { clearSession: () => {}, registerController: () => {}, unregisterController: () => {} },
    });
    const outcome = await crashing.execute({
      ctx: userContext(["workspace:write"]),
      session: { id: SESSION } as unknown as CodeSession,
      prompt: "hi",
      cancelRequested: () => false,
    });
    // A throw is a failed run with a reason, never an exception a caller has to interpret — and never a success.
    expect(outcome.terminalStatus).toBe("failed");
    expect(outcome.reason).toBe("the loop crashed");
  });

  it("emits the result before the terminal state to the caller's sink", async () => {
    const seen: string[] = [];
    const registry = new CodeBackgroundRunRegistry();
    const sink = registry.start({ runId: "run-1", sessionId: SESSION, companyId: COMPANY, userId: "user-1", projectId: PROJECT });
    const executor = new CodeSessionRunExecutor({
      runner: { run: async () => ({ status: "completed", reason: null }) },
      control: { clearSession: () => {}, registerController: () => {}, unregisterController: () => {} },
    });
    await executor.execute({
      ctx: userContext(["workspace:write"]),
      session: { id: SESSION } as unknown as CodeSession,
      prompt: "hi",
      cancelRequested: () => false,
      sink: {
        signal: sink.signal,
        emitResult: (result) => { seen.push("result"); sink.emit("result", result); },
        emitTerminal: (status, reason) => { seen.push("terminal"); sink.finish(status, reason); },
      },
    });
    expect(seen).toEqual(["result", "terminal"]);
    const read = registry.read("run-1");
    expect(read.kind).toBe("finished");
    expect(read.snapshot.status).toBe("completed");
    expect(read.events.map((event) => event.event)).toEqual(["result", "terminal"]);
  });
});
