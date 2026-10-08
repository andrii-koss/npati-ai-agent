import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { createMockNpatiJwt, NpatiBackendAuthProvider, type AuthProvider, type WorkspaceInitFailure } from "../apps/agent-api/src/auth";
import { buildApp } from "../apps/agent-api/src/app";

/**
 * C10 security-gate suite: the **built** application actually authenticates the code surfaces it registers.
 *
 * The defect this suite exists for: every code surface follows one pattern — a path-scoped `preHandler` writes the
 * authenticated context into a per-surface `WeakMap`, and the route module is handed
 * `getAuthContext: (request) => contexts.get(request)`. `codeSnapshotContexts` was declared and read but **never
 * written**, so in the composed application the snapshot, Activity and GET-replay routes authenticated as `null` and
 * answered 401 to every request. `tests/coding-agent-c6b-snapshot-api.test.ts` stayed green because it builds those
 * routes with its own deps and its own context function — a whole class of defect that per-module tests
 * structurally cannot see.
 *
 * Two guards, because they fail differently:
 *
 *  1. **Behaviour on the real app.** `buildApp` is composed from the same stores and auth provider production uses,
 *     and the routes are called over the real request pipeline. With no snapshot row the route answers
 *     500 `code_snapshot_request_failed`; the only wrong answer is 401, which is what a missing context produces.
 *     The auth provider is deliberately lenient and tenant-independent, so the assertion is about the *pipeline*
 *     (is the context ever set?) and not about RBAC.
 *  2. **Source wiring.** Every `*Contexts = new WeakMap<object, AuthContext>()` in `app.ts` must be written by at
 *     least one `.set(`. This one scales: a future surface that forgets its `preHandler` fails here even before
 *     anyone writes a route test for it.
 */

const appSource = readFileSync(new URL("../apps/agent-api/src/app.ts", import.meta.url), "utf8");

const context = (): AuthContext => ({
  workspaceId: "workspace-context",
  userId: "user-context",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
});

/**
 * One real application. The caller closes it: the suites registered in the security gate run under a minimal
 * harness that has no `afterEach` hook, so cleanup lives in the test rather than in a global hook.
 */
function realApp() {
  const authProvider: AuthProvider = { authenticate: async () => context() };
  const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
  const aiEngine = {
    chat: async () => ({ content: "ok" }),
    stream: async function* () { yield "ok"; },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => ({}),
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"],
    healthCheck: async () => ({ status: "ok" as const }),
  } as unknown as AIEngine;
  return buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, marketplace, aiEngine });
}

describe("security-gate: C10 route auth wiring — the snapshot surface authenticates on the built app", () => {
  it("never answers 401 when the auth provider succeeds (a missing preHandler would)", async () => {
    const app = realApp();
    try {
      const response = await app.inject({ method: "GET", url: "/companies/company-1/code/runs/run-1/snapshot" });
      // 401 is the signature of `getAuthContext` returning null because nothing wrote the map. Anything else means
      // the context reached the route: 500 (no such snapshot), 403 (RBAC), 200 (a snapshot exists) are all fine.
      expect({ status: response.statusCode }).not.toMatchObject({ status: 401 });
    } finally {
      await app.close();
    }
  });

  it("never answers 401 on the Activity, compare, by-id and replay-metadata routes either", async () => {
    const app = realApp();
    try {
      const paths = [
        "/companies/company-1/code/runs/run-1/activity",
        "/companies/company-1/code/snapshots/compare?a=snap-1&b=snap-2",
        "/companies/company-1/code/snapshots/snap-1",
        "/companies/company-1/code/runs/run-1/replay",
      ];
      for (const url of paths) {
        const response = await app.inject({ method: "GET", url });
        expect({ url, status: response.statusCode }).not.toMatchObject({ status: 401 });
      }
    } finally {
      await app.close();
    }
  });

  it("writes every code-surface context map it declares in app.ts", () => {
    const declared = [...appSource.matchAll(/const\s+(\w+Contexts)\s*=\s*new WeakMap<object,\s*AuthContext>\(\)/g)]
      .map((match) => match[1]!);
    // A regex that silently matched nothing would make this guard vacuous, so the population is asserted too.
    expect(declared.length).toBeGreaterThanOrEqual(10);

    const unwired: string[] = [];
    for (const name of declared) {
      if (!new RegExp(`${name}\\.set\\(`).test(appSource)) unwired.push(name);
    }
    // A map that is only read is a surface that always answers 401 in the built application.
    expect(unwired).toEqual([]);
  });

  it("keeps the snapshot map's writer path-scoped to the snapshot routes", () => {
    const hook = /const codeSnapshotContexts = new WeakMap<object, AuthContext>\(\);([\s\S]{0,1400}?)codeSnapshotContexts\.set\(/.exec(appSource);
    expect(hook).not.toBeNull();
    // The assertion above proves a `.set` exists; this one proves it sits in a path-guarded hook rather than in an
    // unconditional one that would authenticate every request in the process.
    expect(hook![1]).toContain('app.addHook("preHandler"');
    expect(hook![1]).toContain("request.url.split");
    expect(hook![1]).toMatch(/snapshots/);
  });
});

/**
 * G1 (item 4): what the auth provider does when the workspace store cannot be initialized.
 *
 * The provider is the route layer's lazy-init path, and it used to be
 * `.then(() => this.initializedWorkspaces.add(…)).catch(() => undefined)`: the failure was **invisible**, the
 * workspace was never marked initialized, and so every later request retried a migration chain that could not
 * succeed — while nothing anywhere said why the user's requests were failing later. The three properties pinned
 * here are the ones that make the fix a fix rather than a different silence:
 *
 *  1. the reason is reported, and the request still completes (the HTTP contract of the existing routes is
 *     unchanged — this path may not turn a database outage into a new 500 somewhere else);
 *  2. a *transient* failure still retries on the next request, which is the contract
 *     `tests/auth-single-flight.test.ts` pins;
 *  3. a failure that keeps happening stops being retried on every request, and the negative cache says when it
 *     will be tried again.
 */
describe("security-gate: G1 a failed workspace-store initialization is reported, not swallowed", () => {
  const secret = "g1-workspace-init-secret-at-least-32-characters";

  /** A real store whose `initialize()` fails a configured number of times (or always). */
  class FailingWorkspaceStore extends InMemoryWorkspaceStore {
    calls = 0;
    constructor(private readonly failures: number | "always") { super(); }
    override async initialize(): Promise<void> {
      this.calls += 1;
      if (this.failures === "always" || this.calls <= this.failures) {
        throw new Error('migration 014 failed: extension "vector" is not available');
      }
    }
  }

  const request = (userId: string) => ({ headers: { authorization: `Bearer ${createMockNpatiJwt({ userId }, secret)}` } }) as never;

  it("reports the reason and still resolves the request when the store cannot be initialized", async () => {
    const store = new FailingWorkspaceStore("always");
    const reports: WorkspaceInitFailure[] = [];
    const provider = new NpatiBackendAuthProvider({
      jwtSecret: secret,
      workspaceStore: store,
      onWorkspaceInitFailure: (failure) => reports.push(failure),
    });

    const context = await provider.authenticate(request("reported-user"));

    // The request is not turned into a new failure mode: it resolves exactly as it did before the change.
    expect(context.workspaceId).toBe("workspace:reported-user");
    // …and the failure is visible, with the reason the operator needs.
    expect(reports.length).toBe(1);
    expect(reports[0]?.workspaceId).toBe("workspace:reported-user");
    expect(reports[0]?.attempts).toBe(1);
    expect(reports[0]?.message).toContain('extension "vector" is not available');
    expect(reports[0]?.retryAfter).toBeNull();
    expect(provider.isWorkspaceInitialized("workspace:reported-user")).toBe(false);
    expect(provider.workspaceInitializationFailures().map((failure) => failure.attempts)).toEqual([1]);
  });

  it("keeps the pinned retry contract: a later request retries a failure", async () => {
    const store = new FailingWorkspaceStore("always");
    const provider = new NpatiBackendAuthProvider({ jwtSecret: secret, workspaceStore: store, onWorkspaceInitFailure: () => undefined });
    await provider.authenticate(request("retry-user"));
    await provider.authenticate(request("retry-user"));
    // The statement `tests/auth-single-flight.test.ts` makes, held here as well so the negative cache below
    // cannot quietly turn "retry a transient failure" into "never retry".
    expect(store.calls).toBe(2);
  });

  it("stops retrying every request once the attempt budget is spent, and says when it retries again", async () => {
    const store = new FailingWorkspaceStore("always");
    const reports: WorkspaceInitFailure[] = [];
    const provider = new NpatiBackendAuthProvider({
      jwtSecret: secret,
      workspaceStore: store,
      onWorkspaceInitFailure: (failure) => reports.push(failure),
      workspaceInitMaxAttempts: 2,
      workspaceInitRetryMs: 60_000,
    });

    for (let attempt = 0; attempt < 6; attempt += 1) await provider.authenticate(request("cached-user"));

    // Two attempts, then the negative cache holds: six requests, two migration chains tried, two reports.
    expect(store.calls).toBe(2);
    expect(reports.map((failure) => failure.attempts)).toEqual([1, 2]);
    const failure = provider.workspaceInitializationFailures()[0];
    expect(failure?.retryAfter).toBeGreaterThan(Date.now());
    expect(failure?.message).toContain("vector");
  });

  it("clears the failure state and stops reporting once an initialization succeeds", async () => {
    const store = new FailingWorkspaceStore(1);
    const reports: WorkspaceInitFailure[] = [];
    const provider = new NpatiBackendAuthProvider({
      jwtSecret: secret,
      workspaceStore: store,
      onWorkspaceInitFailure: (failure) => reports.push(failure),
    });

    await provider.authenticate(request("recovered-user"));
    expect(provider.workspaceInitializationFailures().length).toBe(1);

    await provider.authenticate(request("recovered-user"));
    expect(store.calls).toBe(2);
    expect(provider.isWorkspaceInitialized("workspace:recovered-user")).toBe(true);
    expect(provider.workspaceInitializationFailures()).toEqual([]);

    // An initialized workspace is not initialized again, and nothing further is reported.
    await provider.authenticate(request("recovered-user"));
    expect(store.calls).toBe(2);
    expect(reports.length).toBe(1);
  });
});
