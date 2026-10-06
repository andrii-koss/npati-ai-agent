import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { ReplayBundleReadResult } from "../apps/agent-api/src/code-replay-bundle";
import {
  CODE_REPLAY_READ_ACTION,
  CODE_REPLAY_RUN_ACTION,
  CodeReplayService,
  registerCodeReplayRoutes,
  type CodeReplayServiceDeps,
} from "../apps/agent-api/src/code-replay-routes";
import {
  CODE_REPLAY_CODES,
  assertNotDeterministic,
  LIVE_REPLAY_REPRODUCIBILITY_NOTICE,
  replayLive,
} from "../apps/agent-api/src/code-replay-engine";

/**
 * C6b — live replay is **best effort**, never deterministic.
 *
 * It really calls the model and the tools (through the injected starter), keeps the source run/snapshot as the
 * baseline, labels itself `live_best_effort` and carries the owner's notice verbatim. The forbidden-word guard
 * is asserted directly, so a future field cannot smuggle "deterministic" into the result.
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "session-1",
    workspaceId: "ws-1",
    companyId: "company-1",
    projectId: "project-1",
    userId: "user-1",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function serviceDeps(overrides: Partial<CodeReplayServiceDeps> = {}) {
  const campaigns: Array<{ provider: string; tools: number }> = [];
  const starts: Array<Record<string, unknown>> = [];
  const records: unknown[] = [];
  const deps: CodeReplayServiceDeps = {
    authorize: async () => ({ allowed: true }),
    // This suite is about live replay; a run without a bundle is the recorded path's own business.
    loadRecording: async (_ctx, _companyId, _projectId, runId) => ({
      recording: { kind: "no_bundle", runId, steps: [], replayInput: [] },
      bundleVersion: null,
      terminalStatus: null,
    }),
    loadSession: async () => session(),
    loadReplayById: async (_ctx, _companyId, replayId): Promise<ReplayBundleReadResult> => ({
      kind: "no_bundle",
      runId: "",
      bundleId: replayId,
      steps: [],
      replayInput: [],
    }),
    toolVersions: () => 1,
    live: {
      loadSourceRun: async () => ({ projectId: "project-1", sessionId: "session-1", snapshotId: "snapshot-1", prompt: "fix it" }),
      // A live replay really runs the model and the tools; the injected starter records that it was called.
      startRun: async (input) => {
        starts.push(input as unknown as Record<string, unknown>);
        campaigns.push({ provider: "live-model", tools: 3 });
        return { runId: "run-2", snapshotId: "snapshot-2", status: "completed" };
      },
      recordReplay: async (record) => {
        records.push(record);
      },
    },
    ...overrides,
  };
  return { deps, starts, records, campaigns };
}

interface FakeReply {
  code?: number;
  body?: unknown;
}

function fakeReply(): { reply: unknown; captured: FakeReply } {
  const captured: FakeReply = {};
  const reply = {
    status(code: number) {
      captured.code = code;
      return { send(body: unknown) { captured.body = body; return body; } };
    },
    send(body: unknown) {
      captured.body = body;
      return body;
    },
  };
  return { reply, captured };
}

function fakeInstance() {
  const handlers = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
  const instance = {
    post(path: string, handler: (request: unknown, reply: unknown) => Promise<unknown>) {
      handlers.set(`POST ${path}`, handler);
    },
    get(path: string, handler: (request: unknown, reply: unknown) => Promise<unknown>) {
      handlers.set(`GET ${path}`, handler);
    },
  };
  return { instance, handlers };
}

describe("security-gate: C6b replay — live replay is best effort", () => {
  it("starts a new run, keeps the source references and labels itself best effort", async () => {
    const { deps, starts, records } = serviceDeps();
    const service = new CodeReplayService(deps);
    const result = await service.replayLiveRun(ctx, "company-1", "run-1");

    expect(result.mode).toBe("live_best_effort");
    expect(result.replayMode).toBe("live_best_effort");
    expect(result.reproducibility).toBe("best_effort");
    expect(result.notice).toBe(LIVE_REPLAY_REPRODUCIBILITY_NOTICE);
    expect(result.sourceRunId).toBe("run-1");
    expect(result.sourceSnapshotId).toBe("snapshot-1");
    expect(result.runId).toBe("run-2");
    expect(result.status).toBe("completed");
    // A new run really was started, with the source run and snapshot as the baseline.
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ sourceRunId: "run-1", sourceSnapshotId: "snapshot-1", prompt: "fix it" });
    // The record keeps the mode, so history can never present it as a deterministic replay.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ mode: "live_best_effort", replayMode: "live_best_effort", sourceRunId: "run-1" });
  });

  it("never claims to be deterministic — anywhere in the result", async () => {
    const { deps } = serviceDeps();
    const result = await new CodeReplayService(deps).replayLiveRun(ctx, "company-1", "run-1");

    expect(JSON.stringify(result)).not.toMatch(/deterministic/i);
    expect(result.notice).toContain("Best-effort reproducibility");
    expect(result.notice).toContain("may have changed");
    // The guard itself is asserted, so a future field cannot smuggle the word in.
    expect(() => assertNotDeterministic({ note: "this replay is deterministic" })).toThrow();
  });

  it("really calls the injected model and tools instead of reading a recording", async () => {
    const runLive = vi.fn(async () => ({ runId: "run-9", snapshotId: "snapshot-9", status: "completed" }));
    const { deps } = serviceDeps();
    const live = { ...deps.live!, startRun: runLive };
    await new CodeReplayService({ ...deps, live }).replayLiveRun(ctx, "company-1", "run-1");

    expect(runLive).toHaveBeenCalledTimes(1);
    const input = runLive.mock.calls[0]![0] as unknown as { ctx: AuthContext; session: CodeSession };
    expect(input.session.id).toBe("session-1");
    expect(input.ctx.userId).toBe("user-1");
  });

  it("refuses live replay without a session and without a live starter", async () => {
    const { deps } = serviceDeps({ loadSession: async () => null });
    await expect(new CodeReplayService(deps).replayLiveRun(ctx, "company-1", "run-1")).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.sessionUnavailable,
    });

    const { deps: noLive } = serviceDeps({ live: undefined });
    await expect(new CodeReplayService(noLive).replayLiveRun(ctx, "company-1", "run-1")).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.liveUnavailable,
    });
  });

  it("keeps the source run requirement explicit", async () => {
    const { deps } = serviceDeps();
    const live = { ...deps.live!, loadSourceRun: async () => null };
    await expect(new CodeReplayService({ ...deps, live }).replayLiveRun(ctx, "company-1", "run-1")).rejects.toMatchObject({
      code: CODE_REPLAY_CODES.sourceRunUnavailable,
    });
  });

  it("never starts a run when the shared RBAC gate refuses", async () => {
    const { deps, starts } = serviceDeps({
      authorize: async () => {
        throw Object.assign(new Error("denied"), { code: "permission_denied", httpStatus: 403 });
      },
    });
    await expect(new CodeReplayService(deps).replayLiveRun(ctx, "company-1", "run-1")).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(starts).toHaveLength(0);
  });
});

describe("security-gate: C6b replay — routes", () => {
  it("authorizes with the replay actions and reports the mode in both success and failure", async () => {
    const calls: Array<{ action: string; permission: string }> = [];
    const { deps } = serviceDeps({
      authorize: async (_ctx, _companyId, input) => {
        calls.push({ action: input.action, permission: input.permission });
        return { allowed: true };
      },
    });
    const service = new CodeReplayService(deps);
    const { instance, handlers } = fakeInstance();
    await registerCodeReplayRoutes(instance as unknown as FastifyInstance, {
      service,
      getAuthContext: () => ctx,
    });

    const post = handlers.get("POST /companies/:companyId/code/runs/:runId/replay");
    expect(post).toBeDefined();
    const { reply, captured } = fakeReply();
    await post!({ params: { companyId: "company-1", runId: "run-1" }, body: { mode: "live_best_effort" } }, reply);

    expect(captured.code).toBeUndefined();
    expect(captured.body).toMatchObject({ apiVersion: "v1", status: "ok", mode: "live_best_effort" });
    expect(calls[0]).toEqual({ action: CODE_REPLAY_RUN_ACTION, permission: "workspace:write" });

    // The status route uses the read action, not the run action.
    const get = handlers.get("GET /companies/:companyId/code/replay/:replayId");
    const statusReply = fakeReply();
    await get!({ params: { companyId: "company-1", replayId: "replay-1" } }, statusReply.reply);
    expect(statusReply.captured.code).toBe(404);
    expect(statusReply.captured.body).toMatchObject({ apiVersion: "v1", code: CODE_REPLAY_CODES.notFound });
    expect(calls[1]).toEqual({ action: CODE_REPLAY_READ_ACTION, permission: "workspace:read" });
  });

  it("rejects an unknown replay mode before any work happens", async () => {
    const { deps, starts } = serviceDeps();
    const { instance, handlers } = fakeInstance();
    await registerCodeReplayRoutes(instance as unknown as FastifyInstance, {
      service: new CodeReplayService(deps),
      getAuthContext: () => ctx,
    });
    const post = handlers.get("POST /companies/:companyId/code/runs/:runId/replay")!;
    const { reply, captured } = fakeReply();
    await post({ params: { companyId: "company-1", runId: "run-1" }, body: { mode: "deterministic-ish" } }, reply);

    expect(captured.code).toBe(400);
    expect(captured.body).toMatchObject({ code: CODE_REPLAY_CODES.invalidMode });
    expect(starts).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const { deps } = serviceDeps();
    const { instance, handlers } = fakeInstance();
    await registerCodeReplayRoutes(instance as unknown as FastifyInstance, {
      service: new CodeReplayService(deps),
      getAuthContext: () => null,
    });
    const post = handlers.get("POST /companies/:companyId/code/runs/:runId/replay")!;
    const { reply, captured } = fakeReply();
    await post({ params: { companyId: "company-1", runId: "run-1" }, body: {} }, reply);

    expect(captured.code).toBe(401);
  });
});

describe("security-gate: C6b replay — replay metadata/status route", () => {
  function bundleRead(overrides: Partial<ReplayBundleReadResult> = {}): ReplayBundleReadResult {
    return {
      kind: "bundle",
      runId: "run-1",
      bundleId: "bundle-1",
      replayMode: "recorded",
      terminalStatus: "completed",
      terminalReason: "stop",
      steps: [{ kind: "model_step", turnIndex: 1 }],
      replayInput: [{ kind: "model_step", turnIndex: 1 }],
      replayInputHash: "sha256:input",
      integrityFailure: false,
      truncated: false,
      ...overrides,
    };
  }

  async function statusRoute(deps: CodeReplayServiceDeps) {
    const { instance, handlers } = fakeInstance();
    await registerCodeReplayRoutes(instance as unknown as FastifyInstance, {
      service: new CodeReplayService(deps),
      getAuthContext: () => ctx,
    });
    return handlers.get("GET /companies/:companyId/code/replay/:replayId")!;
  }

  it("returns the recorded status by id and never the recorded content", async () => {
    const calls: Array<{ action: string; permission: string }> = [];
    const { deps } = serviceDeps({
      authorize: async (_ctx, _companyId, input) => {
        calls.push({ action: input.action, permission: input.permission });
        return { allowed: true };
      },
      loadReplayById: async () => bundleRead({ terminalReason: "x".repeat(500) }),
    });
    const get = await statusRoute(deps);
    const { reply, captured } = fakeReply();
    await get({ params: { companyId: "company-1", replayId: "bundle-1" } }, reply);

    expect(captured.code).toBeUndefined();
    expect(captured.body).toMatchObject({
      apiVersion: "v1",
      status: "ok",
      replay: {
        replayId: "bundle-1",
        runId: "run-1",
        bundleId: "bundle-1",
        replayMode: "recorded",
        terminalStatus: "completed",
        truncated: false,
        integrity: { replayInputHashMatched: true, truncated: false },
      },
    });
    // Reading is a read action, not the run action.
    expect(calls[0]).toEqual({ action: CODE_REPLAY_READ_ACTION, permission: "workspace:read" });
    // No recorded steps, no replay input and no content keys anywhere in the answer. The field names are
    // quoted so the legitimate `replayInputHashMatched` integrity flag is not mistaken for the replay input.
    const serialised = JSON.stringify(captured.body);
    expect(serialised).not.toMatch(/"steps"|"replayInput"|"rawArtifact"|"settledResult"|"arguments"|"command"|"stdout"/);
    // A long recorded reason is bounded rather than echoed in full.
    const reason = (captured.body as { replay: { terminalReason: string } }).replay.terminalReason;
    expect(reason.length).toBeLessThanOrEqual(201);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("answers one identical 404 for an unknown id and for another tenant's id", async () => {
    const reads: string[] = [];
    const { deps } = serviceDeps({
      loadReplayById: async (_ctx, companyId, replayId) => {
        reads.push(`${companyId}:${replayId}`);
        // The store scopes by company: a foreign id is `no_bundle`, exactly like an unknown one.
        return { kind: "no_bundle", runId: "", steps: [], replayInput: [] };
      },
    });
    const get = await statusRoute(deps);

    const unknown = fakeReply();
    await get({ params: { companyId: "company-1", replayId: "does-not-exist" } }, unknown.reply);
    const foreign = fakeReply();
    await get({ params: { companyId: "company-1", replayId: "bundle-of-another-company" } }, foreign.reply);

    expect(unknown.captured.code).toBe(404);
    expect(foreign.captured.code).toBe(404);
    // Byte-identical bodies: nothing distinguishes "unknown" from "belongs to someone else".
    expect(JSON.stringify(unknown.captured.body)).toBe(JSON.stringify(foreign.captured.body));
    expect(unknown.captured.body).toMatchObject({ code: CODE_REPLAY_CODES.notFound, details: {} });
    expect(JSON.stringify(unknown.captured.body)).not.toMatch(/does-not-exist|another-company/);
  });

  it("refuses the status read without permission and reads nothing", async () => {
    const readSpy = vi.fn(async () => bundleRead());
    const { deps } = serviceDeps({
      authorize: async () => {
        throw Object.assign(new Error("denied"), { code: "permission_denied", httpStatus: 403 });
      },
      loadReplayById: readSpy,
    });
    const get = await statusRoute(deps);
    const { reply, captured } = fakeReply();
    await get({ params: { companyId: "company-1", replayId: "bundle-1" } }, reply);

    expect(captured.code).toBe(403);
    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe("security-gate: C6b replay — the live engine helper refuses deterministic wording", () => {
  it("labels the result and refuses a caller that smuggles the word in", async () => {
    const result = await replayLive({
      ctx,
      session: session(),
      source: { companyId: "company-1", projectId: "project-1", runId: "run-1", snapshotId: "snapshot-1", sessionId: "session-1" },
      startRun: async () => ({ runId: "run-2", snapshotId: "snapshot-2", status: "completed" }),
    });
    expect(result.mode).toBe("live_best_effort");
    expect(result.notice).toBe(LIVE_REPLAY_REPRODUCIBILITY_NOTICE);
    await expect(
      replayLive({
        ctx,
        session: session(),
        source: { companyId: "company-1", projectId: "project-1", runId: "run-1" },
        // A live run whose reason claims determinism must not be published as-is.
        startRun: async () => ({ runId: "run-3", status: "completed", reason: "deterministic replay" }),
      }),
    ).rejects.toMatchObject({ code: "replay_wording_violation" });
  });
});
