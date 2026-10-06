import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { decodeCodeActivityCursor, WorkspaceAccessError, type AuthContext } from "@npati/workspace";
import {
  CodeRbac,
  createRoleRegistry,
  type CodeAuthorizationAuditPort,
} from "../apps/agent-api/src/code-rbac";
import {
  LEGACY_NO_SNAPSHOT_MESSAGE,
  registerCodeSnapshotRoutes,
  type CodeSnapshotReadStore,
} from "../apps/agent-api/src/code-snapshot-routes";

/**
 * C6b security-gate: the read-only "why did the agent act this way" surface.
 *
 * What this suite pins, and why each part matters:
 *  - a run recorded before C6b answers `legacy_no_snapshot` with HTTP 200 and **no error shape** — the
 *    whole point of the marker is that history stays readable instead of turning into 500s;
 *  - the snapshot answer carries the identity the Run Trace needs (version, payload hash, chain, trigger),
 *    not just the payload;
 *  - the diff between two snapshots comes from the store's content-safe diff and the response never carries
 *    content: no command/diff/prompt keys and no canary secret value, checked on the serialised body;
 *  - replay metadata is counts and hashes only (the recorded steps hold model-visible results and are not
 *    exposed here), `no_bundle` is again a first-class answer, and a live bundle carries the best-effort
 *    notice the owner required verbatim;
 *  - a stored Activity event that somehow carries content is refused **loudly** (`activity_payload_invalid`)
 *    and its payload is not copied into the response — silently filtering would hide a leak from whoever
 *    wrote it;
 *  - reads go through the real RBAC gate: a principal without `workspace:read` is refused **before** the
 *    store is touched, and a missing context is `unauthorized`;
 *  - every read is tenant-scoped: the store is always asked with the company from the path, and another
 *    company's snapshot is a 404 rather than a leak.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const RUN = "run-1";
const SESSION = "session-1";
const PROJECT = "project-1";
const SECRET_CANARY = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Route {
  method: string;
  url: string;
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

/** Minimal Fastify stand-in: the routes under test are the ones the API actually registers. */
function fakeInstance(routes: Route[]): FastifyInstance {
  return {
    get: (url: string, handler: Route["handler"]) => routes.push({ method: "get", url, handler }),
  } as unknown as FastifyInstance;
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

function snapshotRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "snap-1",
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    snapshotVersion: 3,
    payload: { runnerVersion: "1.0.0+abc+def", featureFlags: { "code.write": true } },
    payloadHash: "sha256:payload-3",
    prevSnapshotId: "snap-0",
    prevPayloadHash: "sha256:payload-2",
    trigger: "run_start",
    legacy: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    createdBy: "user-1",
    ...overrides,
  };
}

function activityEvent(id: string, payload: Record<string, unknown>, createdAt: Date) {
  return {
    id,
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    snapshotId: "snap-1",
    kind: "run_activity" as const,
    payload,
    dataClassification: "confidential" as const,
    retentionClass: "standard" as const,
    createdAt,
  };
}

function replayBundle(overrides: Record<string, unknown> = {}) {
  return {
    id: "bundle-1",
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    executionSnapshotId: "snap-1",
    bundleVersion: 1,
    runnerVersion: "1.0.0+abc+def",
    systemPromptVersion: 1,
    systemPromptContentHash: "sha256:prompt-1",
    modelProfileVersion: 1,
    provider: "auto",
    model: "auto",
    replayMode: "recorded",
    sourceRunId: null,
    sourceSnapshotId: null,
    terminalStatus: "completed",
    terminalReason: null,
    payload: { stepCount: 4, stepCounts: { model_step: 2, tool_call: 2 }, secretValue: SECRET_CANARY },
    payloadHash: "sha256:bundle-1",
    replayInputHash: "sha256:replay-input-1",
    dataClassification: "confidential" as const,
    retentionClass: "standard" as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface Harness {
  routes: Route[];
  calls: { runLookups: string[]; snapshotLookups: string[]; diffs: number; activity: number; bundles: number };
  storeSnapshots: Map<string, ReturnType<typeof snapshotRecord>>;
  storeRuns: Map<string, string>;
  storeActivity: Map<string, ReturnType<typeof activityEvent>[]>;
  storeBundles: Map<string, ReturnType<typeof replayBundle>>;
  lastActivityInput: Record<string, unknown> | undefined;
  registeredError: unknown;
}

/** Real RBAC gate + scripted store: a realistic refusal is produced by the gate, not by a fake. */
async function harness(options: { role?: string; contextMissing?: boolean } = {}): Promise<Harness> {
  const routes: Route[] = [];
  const calls = { runLookups: [] as string[], snapshotLookups: [] as string[], diffs: 0, activity: 0, bundles: 0 };
  const storeSnapshots = new Map<string, ReturnType<typeof snapshotRecord>>();
  const storeRuns = new Map<string, string>();
  const storeActivity = new Map<string, ReturnType<typeof activityEvent>[]>();
  const storeBundles = new Map<string, ReturnType<typeof replayBundle>>();
  const state: Harness = {
    routes,
    calls,
    storeSnapshots,
    storeRuns,
    storeActivity,
    storeBundles,
    lastActivityInput: undefined,
    registeredError: undefined,
  };

  const store: CodeSnapshotReadStore = {
    async getSnapshotForRun(companyId, runId) {
      calls.runLookups.push(`${companyId}:${runId}`);
      const id = storeRuns.get(`${companyId}:${runId}`);
      return id ? storeSnapshots.get(id) ?? null : null;
    },
    async getExecutionSnapshot(companyId, snapshotId) {
      calls.snapshotLookups.push(`${companyId}:${snapshotId}`);
      const record = storeSnapshots.get(snapshotId);
      if (!record || record.companyId !== companyId) return null;
      return record;
    },
    diffExecutionSnapshots(a, b) {
      calls.diffs += 1;
      // Shape of the store's content-safe diff: component paths, never values.
      return {
        changed: ["featureFlags.code.write"],
        unchanged: ["toolManifestVersion"],
        a: a.id,
        b: b.id,
      } as unknown as ReturnType<CodeSnapshotReadStore["diffExecutionSnapshots"]>;
    },
    async listCodeActivityEvents(input) {
      calls.activity += 1;
      state.lastActivityInput = input as unknown as Record<string, unknown>;
      if (input.cursor === "malformed") throw new WorkspaceAccessError("Invalid activity cursor");
      const events = storeActivity.get(`${input.companyId}:${input.runId}`) ?? [];
      const limit = input.limit ?? events.length;
      return events.slice(0, limit) as never;
    },
    async getReplayBundle(companyId, runId) {
      calls.bundles += 1;
      return (storeBundles.get(`${companyId}:${runId}`) ?? null) as never;
    },
  };

  const registry = createRoleRegistry({
    roles: {
      owner: ["workspace:read", "workspace:write"],
      developer: ["workspace:read", "workspace:write"],
      reviewer: ["tools:read"],
    },
  });
  const audit: CodeAuthorizationAuditPort = { record: async () => {} };
  const rbac = new CodeRbac({ registry, audit });
  const ctx = {
    workspaceId: "ws-1",
    userId: "user-1",
    companyId: COMPANY,
    permissions: [],
    role: options.role ?? "developer",
  } as unknown as AuthContext;

  await registerCodeSnapshotRoutes(fakeInstance(routes), {
    store,
    authorize: (context, companyId, input) => rbac.authorize(context, companyId, input),
    getAuthContext: () => (options.contextMissing ? null : ctx),
  });
  return state;
}

function route(harnessState: Harness, url: string): Route {
  const found = harnessState.routes.find((entry) => entry.url === url);
  if (!found) throw new Error(`route not registered: ${url}`);
  return found;
}

const RUN_SNAPSHOT_URL = "/companies/:companyId/code/runs/:runId/snapshot";
const COMPARE_URL = "/companies/:companyId/code/snapshots/compare";
const ACTIVITY_URL = "/companies/:companyId/code/runs/:runId/activity";
const RUN_REPLAY_URL = "/companies/:companyId/code/runs/:runId/replay";

async function call(
  harnessState: Harness,
  url: string,
  params: Record<string, string>,
  query: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { reply, state } = fakeReply();
  await route(harnessState, url).handler({ params, query }, reply);
  return { status: state.status, body: (state.body ?? {}) as Record<string, unknown> };
}

describe("security-gate: C6b snapshot read API", () => {
  it("returns the snapshot of a run together with the identity Run Trace needs", async () => {
    const h = await harness();
    h.storeSnapshots.set("snap-1", snapshotRecord());
    h.storeRuns.set(`${COMPANY}:${RUN}`, "snap-1");

    const { status, body } = await call(h, RUN_SNAPSHOT_URL, { companyId: COMPANY, runId: RUN });
    expect(status).toBe(200);
    expect(body.apiVersion).toBe("v1");
    expect(body.status).toBe("snapshot");
    const snapshot = body.snapshot as Record<string, unknown>;
    expect(snapshot.snapshotId).toBe("snap-1");
    expect(snapshot.snapshotVersion).toBe(3);
    expect(snapshot.payloadHash).toBe("sha256:payload-3");
    expect(snapshot.prevPayloadHash).toBe("sha256:payload-2");
    expect(snapshot.trigger).toBe("run_start");
    // The environment answer is in the payload, which is metadata by construction.
    expect((snapshot.payload as Record<string, unknown>).runnerVersion).toBe("1.0.0+abc+def");
  });

  it("answers legacy_no_snapshot with 200 and no error shape for a run recorded before C6b", async () => {
    const h = await harness();
    const { status, body } = await call(h, RUN_SNAPSHOT_URL, { companyId: COMPANY, runId: "old-run" });
    expect(status).toBe(200);
    expect(body.status).toBe("legacy_no_snapshot");
    expect(body.message).toBe(LEGACY_NO_SNAPSHOT_MESSAGE);
    // A missing snapshot must not look like a failure: no error envelope at all.
    expect(body.error).toBeUndefined();
  });

  it("compares two snapshots through the store's content-safe diff and never returns content", async () => {
    const h = await harness();
    h.storeSnapshots.set("snap-1", snapshotRecord());
    h.storeSnapshots.set("snap-2", snapshotRecord({ id: "snap-2", runId: "run-2", payload: { note: SECRET_CANARY } }));

    const { status, body } = await call(h, COMPARE_URL, { companyId: COMPANY }, { a: "snap-1", b: "snap-2" });
    expect(status).toBe(200);
    expect(h.calls.diffs).toBe(1);
    expect(body.status).toBe("compared");
    expect((body.diff as Record<string, unknown>).changed).toEqual(["featureFlags.code.write"]);

    const serialised = JSON.stringify(body);
    // The diff names the changed component; neither the canary value nor any content key may appear.
    expect(serialised).not.toContain(SECRET_CANARY);
    // `diff` itself is this API's field name for the structural diff, so the check is about keys that would
    // carry content *inside* an answer, not about the name of the answer's own field.
    for (const key of ["command", "content", "stdout", "stderr", "token", "secret", "password", "prompt", "patch"]) {
      expect(serialised).not.toContain(`"${key}"`);
    }
    // Stronger than a key check: the diff carries component paths, never values.
    const diff = body.diff as { changed: unknown[]; unchanged: unknown[] };
    for (const entry of [...diff.changed, ...diff.unchanged]) {
      expect(typeof entry).toBe("string");
      expect(String(entry)).toMatch(/^[A-Za-z][A-Za-z0-9_.]*$/);
    }
  });

  it("refuses a compare without both ids instead of guessing one", async () => {
    const h = await harness();
    const { status, body } = await call(h, COMPARE_URL, { companyId: COMPANY }, { a: "snap-1" });
    expect(status).toBe(400);
    expect((body.error as Record<string, unknown>).code).toBe("invalid_arguments");
    expect(h.calls.diffs).toBe(0);
  });

  it("returns replay metadata as counts and hashes, with the best-effort notice for a live bundle", async () => {
    const h = await harness();
    h.storeBundles.set(`${COMPANY}:${RUN}`, replayBundle());
    const recorded = await call(h, RUN_REPLAY_URL, { companyId: COMPANY, runId: RUN });
    expect(recorded.status).toBe(200);
    expect(recorded.body.status).toBe("bundle");
    const replay = recorded.body.replay as Record<string, unknown>;
    expect(replay.replayMode).toBe("recorded");
    expect(replay.bestEffort).toBe(false);
    expect(replay.notice).toBeUndefined();
    expect(replay.terminalStatus).toBe("completed");
    expect(replay.replayInputHash).toBe("sha256:replay-input-1");
    // Metadata only: the bundle payload's own values are not echoed back.
    expect(JSON.stringify(recorded.body)).not.toContain(SECRET_CANARY);

    h.storeBundles.set(`${COMPANY}:${RUN}`, replayBundle({
      id: "bundle-2",
      replayMode: "live_best_effort",
      sourceRunId: "run-0",
      sourceSnapshotId: "snap-0",
    }));
    const live = await call(h, RUN_REPLAY_URL, { companyId: COMPANY, runId: RUN });
    const liveReplay = live.body.replay as Record<string, unknown>;
    expect(liveReplay.bestEffort).toBe(true);
    expect(liveReplay.notice).toBe("Best-effort reproducibility. External models, registries and services may have changed.");
    expect(liveReplay.sourceRunId).toBe("run-0");
    expect(liveReplay.sourceSnapshotId).toBe("snap-0");
    // Never called deterministic: the mode name is the contract.
    expect(liveReplay.replayMode).toBe("live_best_effort");
  });

  it("answers no_bundle without an error for a run with no recording", async () => {
    const h = await harness();
    const { status, body } = await call(h, RUN_REPLAY_URL, { companyId: COMPANY, runId: "old-run" });
    expect(status).toBe(200);
    expect(body.status).toBe("no_bundle");
    expect(body.error).toBeUndefined();
  });

  it("lists activity events with their snapshot id and a decodable keyset cursor", async () => {
    const h = await harness();
    const first = activityEvent("event-2", { tool: "code.fs.read", bytes: 12 }, new Date("2026-01-02T00:00:00.000Z"));
    const second = activityEvent("event-1", { tool: "code.fs.edit", bytes: 30 }, new Date("2026-01-01T00:00:00.000Z"));
    h.storeActivity.set(`${COMPANY}:${RUN}`, [first, second]);

    const { status, body } = await call(h, ACTIVITY_URL, { companyId: COMPANY, runId: RUN }, { limit: "2" });
    expect(status).toBe(200);
    expect(body.apiVersion).toBe("v1");
    const events = body.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0]!.snapshotId).toBe("snap-1");
    // The cursor must be the store's own format, or paging would silently stop matching its reader.
    const cursor = decodeCodeActivityCursor(String(body.nextCursor));
    expect(cursor.id).toBe("event-1");
    expect(cursor.createdAt).toBe("2026-01-01T00:00:00.000Z");

    const fullPage = await call(h, ACTIVITY_URL, { companyId: COMPANY, runId: RUN }, {});
    expect(fullPage.body.nextCursor).toBeUndefined();
  });

  it("clamps an oversized activity limit instead of asking the store for everything", async () => {
    const h = await harness();
    await call(h, ACTIVITY_URL, { companyId: COMPANY, runId: RUN }, { limit: "5000" });
    expect(h.lastActivityInput?.limit).toBe(200);
  });

  it("refuses to return a stored event that carries content and does not copy it into the response", async () => {
    const h = await harness();
    h.storeActivity.set(`${COMPANY}:${RUN}`, [
      activityEvent("event-1", { command: "rm -rf /important" }, new Date("2026-01-01T00:00:00.000Z")),
    ]);
    const { status, body } = await call(h, ACTIVITY_URL, { companyId: COMPANY, runId: RUN });
    expect(status).toBe(500);
    expect((body.error as Record<string, unknown>).code).toBe("activity_payload_invalid");
    // Loud refusal, and the offending value never travels to the client.
    expect(JSON.stringify(body)).not.toContain("rm -rf");
  });

  it("maps a malformed cursor to a client error rather than restarting from page one", async () => {
    const h = await harness();
    const { status, body } = await call(h, ACTIVITY_URL, { companyId: COMPANY, runId: RUN }, { cursor: "malformed" });
    expect(status).toBe(400);
    expect((body.error as Record<string, unknown>).code).toBe("invalid_activity_cursor");
  });

  it("requires authentication before touching the store", async () => {
    const h = await harness({ contextMissing: true });
    const { status, body } = await call(h, RUN_SNAPSHOT_URL, { companyId: COMPANY, runId: RUN });
    expect(status).toBe(401);
    expect((body.error as Record<string, unknown>).code).toBe("unauthorized");
    expect(h.calls.runLookups).toHaveLength(0);
  });

  it("refuses a principal without workspace:read and reads nothing from the store", async () => {
    const h = await harness({ role: "reviewer" });
    const { status, body } = await call(h, RUN_SNAPSHOT_URL, { companyId: COMPANY, runId: RUN });
    expect(status).toBe(403);
    expect((body.error as Record<string, unknown>).code).toBe("permission_denied");
    expect(h.calls.runLookups).toHaveLength(0);
    expect(h.calls.activity).toBe(0);
    expect(h.calls.bundles).toBe(0);
  });

  it("stays tenant-scoped: the store is asked with the company from the path and a foreign snapshot is a 404", async () => {
    const h = await harness();
    h.storeSnapshots.set("snap-foreign", snapshotRecord({ id: "snap-foreign", companyId: OTHER_COMPANY }));

    const foreign = await call(h, "/companies/:companyId/code/snapshots/:snapshotId", {
      companyId: COMPANY,
      snapshotId: "snap-foreign",
    });
    expect(foreign.status).toBe(404);
    expect((foreign.body.error as Record<string, unknown>).code).toBe("snapshot_not_found");
    expect(h.calls.snapshotLookups).toEqual([`${COMPANY}:snap-foreign`]);

    h.storeRuns.set(`${OTHER_COMPANY}:${RUN}`, "snap-foreign");
    const run = await call(h, RUN_SNAPSHOT_URL, { companyId: COMPANY, runId: RUN });
    expect(run.body.status).toBe("legacy_no_snapshot");
    expect(h.calls.runLookups).toEqual([`${COMPANY}:${RUN}`]);
  });
});
