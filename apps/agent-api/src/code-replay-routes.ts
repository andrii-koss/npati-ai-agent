/**
 * C6b: replay endpoints.
 *
 * Two routes only — starting a replay and reading its status. Reading snapshots belongs to the snapshot
 * surface, and the Run Trace view is a separate read-only surface.
 *
 * Authorization goes through the shared server-side gate (`authorizeCodeAction`) with the action
 * `code.replay.run`; the permission is derived from the action by the RBAC map, so a caller cannot authorise a
 * replay by handing in a convenient label, and an action missing from the map is refused by default.
 * Cancellation is the existing run-level mechanism: a live replay is an ordinary run, so the existing cancel
 * endpoint and `run.cancelRequested` flag apply to it unchanged.
 */

import type { FastifyInstance } from "fastify";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { ReplayBundleReadResult } from "./code-replay-bundle";
import {
  assertReplayClean,
  compareRuntimeMcpManifestForReplay,
  replayLive,
  replayRecorded,
  CodeReplayError,
  CODE_REPLAY_CODES,
  type LiveReplayRecord,
  type LiveReplayResult,
  type RecordedReplayResult,
} from "./code-replay-engine";

export const CODE_REPLAY_RUN_ACTION = "code.replay.run";
export const CODE_REPLAY_READ_ACTION = "code.replay.read";
/** Replay executes the loop again (it may edit and run commands), so it is a workspace write surface. */
export const CODE_REPLAY_RUN_PERMISSION = "workspace:write";
export const CODE_REPLAY_READ_PERMISSION = "workspace:read";

export interface CodeReplayServiceDeps {
  /** The shared RBAC gate (`CodeRbac.authorize`). */
  authorize(
    ctx: AuthContext,
    companyId: string,
    input: { action: string; permission: string; projectId?: string; sessionId?: string; mode?: string },
  ): Promise<unknown>;
  /** Reads the recorded bundle through the replay-bundle module's reader (migration 078). */
  loadRecording(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<{
    recording: ReplayBundleReadResult;
    bundleVersion?: number | null;
    terminalStatus?: string | null;
  }>;
  loadSession(ctx: AuthContext, companyId: string, projectId: string, sessionId?: string | null): Promise<CodeSession | null>;
  /** The current schema version per tool name (the published registry in production). */
  toolVersions?(toolName: string): number | null;
  /**
   * C13 (owner decision 6, corrected): the run-path manifest reader, used by **live replay only**.
   *
   * A deterministic replay never calls it — it verifies the run against the manifest its own bundle recorded,
   * which is why a recorded replay of an MCP-using run works in a fresh process with an empty in-process
   * overlay and with zero dials. Live replay is the one mode that really discovers the current tool set, and
   * there a difference from the recording (or an unanswerable port) is refused with 409.
   */
  loadRuntimeMcpManifest?(ctx: AuthContext, companyId: string, projectId: string, runId: string): Promise<Record<string, unknown> | null>;
  /** Live replay: how the source run is resolved and how a new run is started. */
  live?: {
    loadSourceRun(ctx: AuthContext, companyId: string, runId: string): Promise<{
      projectId: string;
      sessionId?: string | null;
      snapshotId?: string | null;
      prompt?: string | null;
    } | null>;
    startRun(input: {
      ctx: AuthContext;
      companyId: string;
      projectId: string;
      session: CodeSession;
      prompt: string;
      sourceRunId: string;
      sourceSnapshotId: string | null;
    }): Promise<{ runId: string; snapshotId?: string | null; status: string; reason?: string }>;
    recordReplay?(record: LiveReplayRecord): Promise<void>;
  };
  /**
   * Replay status/metadata by id (the owner's requirement 5). It is the bundle module's by-id reader, which
   * answers `no_bundle` for an unknown **and** for a foreign id, so this route cannot become an existence
   * oracle.
   */
  loadReplayById(ctx: AuthContext, companyId: string, replayId: string): Promise<ReplayBundleReadResult>;
  onActivity?(event: Record<string, unknown> & { kind: string }): void | Promise<void>;
  now?(): number;
}

export type CodeReplayStartResult =
  | { mode: "recorded"; replay: RecordedReplayResult }
  | { mode: "live_best_effort"; replay: LiveReplayResult };

/**
 * What the status route answers: identity, mode, how the run ended and whether the recording is intact. It
 * carries no recorded step and no replay input — those would widen the leak surface for no benefit here.
 */
export interface CodeReplayStatus {
  replayId: string;
  runId: string;
  bundleId: string | null;
  replayMode: string | null;
  terminalStatus: string | null;
  terminalReason: string | null;
  truncated: boolean;
  integrity: { replayInputHashMatched: boolean; truncated: boolean };
}

/** A recorded reason is a short run-level string; it is bounded so no long text rides along in a status read. */
const REPLAY_REASON_LIMIT = 200;

function boundReplayReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  return reason.length > REPLAY_REASON_LIMIT ? `${reason.slice(0, REPLAY_REASON_LIMIT)}…` : reason;
}

export class CodeReplayService {
  constructor(private readonly deps: CodeReplayServiceDeps) {}

  /** Deterministic replay of a recorded run. */
  async replayRecordedRun(
    ctx: AuthContext,
    companyId: string,
    runId: string,
    input: { replayId?: string; projectId?: string } = {},
  ): Promise<RecordedReplayResult> {
    await this.deps.authorize(ctx, companyId, {
      action: CODE_REPLAY_RUN_ACTION,
      permission: CODE_REPLAY_RUN_PERMISSION,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    const loaded = await this.deps.loadRecording(ctx, companyId, input.projectId ?? "", runId);
    /**
     * C13 (owner decision 6, corrected): a **deterministic** replay resolves the runtime MCP pin from the
     * recording itself. `loadRuntimeMcpManifest` is deliberately not consulted here: it reads the in-process
     * overlay, which is empty in a fresh process, so consulting it refused every replay of an MCP-using run with
     * `runtime_mcp_manifest_unavailable` while the bundle already carried the manifest. The recorded run
     * verifies against the tool set it was admitted under, with no discovery and no dial (see
     * `compareRuntimeMcpManifestForReplay`); a caller that wants a **live** comparison passes
     * `runtimeMcpManifest` explicitly, and that path is the live mode's own check.
     */
    const result = await replayRecorded({
      recording: loaded.recording,
      ...(loaded.bundleVersion === undefined || loaded.bundleVersion === null
        ? {}
        : { bundleVersion: loaded.bundleVersion }),
      ...(loaded.terminalStatus === undefined ? {} : { recordedTerminalStatus: loaded.terminalStatus }),
      ...(this.deps.toolVersions ? { toolVersions: this.deps.toolVersions } : {}),
      runtimeMcpManifestMode: "recorded",
      ...(this.deps.onActivity ? { onActivity: this.deps.onActivity } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    // The route decides the status code: a clean replay is 200, a divergence is 409 with the first reason.
    return assertReplayClean(result);
  }

  /** Live replay: a new run that really calls the model, explicitly labelled best-effort. */
  async replayLiveRun(
    ctx: AuthContext,
    companyId: string,
    runId: string,
    input: { projectId?: string } = {},
  ): Promise<LiveReplayResult> {
    await this.deps.authorize(ctx, companyId, {
      action: CODE_REPLAY_RUN_ACTION,
      permission: CODE_REPLAY_RUN_PERMISSION,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    if (!this.deps.live) {
      throw new CodeReplayError(CODE_REPLAY_CODES.liveUnavailable, "Live replay is not configured", 503, {
        reason: "replay_live_unavailable",
      });
    }
    const source = await this.deps.live.loadSourceRun(ctx, companyId, runId);
    if (!source) {
      throw new CodeReplayError(CODE_REPLAY_CODES.sourceRunUnavailable, "The source run was not found", 404, {
        reason: "replay_source_run_unavailable",
        runId,
      });
    }
    const session = await this.deps.loadSession(ctx, companyId, source.projectId, source.sessionId ?? null);
    if (!session) {
      throw new CodeReplayError(CODE_REPLAY_CODES.sessionUnavailable, "The source session no longer exists", 404, {
        reason: "replay_session_unavailable",
        sessionId: source.sessionId ?? null,
      });
    }
    /**
     * C13 (owner decision 6, corrected): **live replay is where discovery belongs**, and the mismatch check runs
     * here — before `startRun` — so a moved tool set never starts a run that would work against tools the source
     * run never saw. A run that recorded no runtime MCP manifest skips it, which is the honest reading of "this
     * run used no runtime MCP tool".
     */
    await this.assertLiveRuntimeMcpManifestUnchanged(ctx, companyId, source.projectId, runId);
    return replayLive({
      ctx,
      session,
      source: {
        companyId,
        projectId: source.projectId,
        runId,
        snapshotId: source.snapshotId ?? null,
        sessionId: source.sessionId ?? null,
        prompt: source.prompt ?? null,
      },
      startRun: this.deps.live.startRun,
      ...(this.deps.live.recordReplay ? { recordReplay: this.deps.live.recordReplay } : {}),
    });
  }

  /**
   * The **live** half of the runtime MCP pin (C13, owner decision 6, corrected).
   *
   * It reads the recording's own manifest and the manifest this deployment discovers **now**, then hands both to
   * the single comparison the recorded engine also uses, so the two modes cannot drift into two different rules.
   * A read that fails is treated as "no recorded manifest" — a live replay of a run that has no bundle is the
   * existing behaviour, and the run that *did* record a manifest is the only one this check can protect.
   */
  private async assertLiveRuntimeMcpManifestUnchanged(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<void> {
    let recorded: Record<string, unknown> | null = null;
    try {
      const loaded = await this.deps.loadRecording(ctx, companyId, projectId, runId);
      recorded = loaded.recording.kind === "bundle" ? loaded.recording.runtimeMcpManifest ?? null : null;
    } catch {
      recorded = null;
    }
    if (!recorded) return;
    const current = this.deps.loadRuntimeMcpManifest
      ? await this.deps.loadRuntimeMcpManifest(ctx, companyId, projectId, runId).catch(() => null)
      : null;
    compareRuntimeMcpManifestForReplay({ recorded, current, mode: "live", runId });
  }

  /**
   * Metadata/status of one replay. Reading is `code.replay.read` (`workspace:read`), never the run action.
   *
   * The answer is deliberately thin: the recorded **steps** and the replay input are not included, because a
   * status endpoint does not need them and returning them would widen the leak surface (a caller who needs the
   * recorded content belongs on a separate read-only route). `terminalReason` is a recorded run-level reason,
   * so it is bounded before it leaves the process.
   */
  async getReplay(ctx: AuthContext, companyId: string, replayId: string): Promise<CodeReplayStatus> {
    await this.deps.authorize(ctx, companyId, { action: CODE_REPLAY_READ_ACTION, permission: CODE_REPLAY_READ_PERMISSION });
    const read = await this.deps.loadReplayById(ctx, companyId, replayId);
    if (!read || read.kind !== "bundle") {
      // An unknown id and a foreign id are the same answer, with the same (empty) details: a differing body
      // would turn this route into an existence oracle for another tenant's replay ids.
      throw new CodeReplayError(CODE_REPLAY_CODES.notFound, "Replay record not found", 404, {});
    }
    return {
      replayId: read.bundleId ?? replayId,
      runId: read.runId,
      bundleId: read.bundleId ?? null,
      replayMode: read.replayMode ?? null,
      terminalStatus: read.terminalStatus ?? null,
      terminalReason: boundReplayReason(read.terminalReason),
      truncated: Boolean(read.truncated),
      integrity: { replayInputHashMatched: !read.integrityFailure, truncated: Boolean(read.truncated) },
    };
  }
}

export interface CodeReplayRouteDeps {
  service: CodeReplayService;
  getAuthContext: (request: unknown) => AuthContext | null;
}

const REPLAY_MODES = new Set(["recorded", "live_best_effort"]);

export async function registerCodeReplayRoutes(instance: FastifyInstance, deps: CodeReplayRouteDeps) {
  const authOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new CodeReplayError("unauthorized", "Authentication required", 401, { reason: "unauthorized" });
    return context;
  };
  const fail = (reply: { status(code: number): { send(body: unknown): unknown } }, error: unknown) => {
    const known = error as CodeReplayError;
    return reply.status(known.httpStatus ?? 500).send({
      apiVersion: "v1",
      status: "error",
      code: known.code ?? "replay_failed",
      message: known.message,
      details: known.details ?? {},
    });
  };

  instance.post("/companies/:companyId/code/runs/:runId/replay", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const params = request.params as { companyId: string; runId: string };
      const body = (request.body ?? {}) as { mode?: string; replayId?: string; projectId?: string };
      const mode = String(body.mode ?? "recorded");
      if (!REPLAY_MODES.has(mode)) {
        throw new CodeReplayError(CODE_REPLAY_CODES.invalidMode, "Unknown replay mode", 400, {
          reason: "replay_invalid_mode",
          mode,
          allowed: [...REPLAY_MODES],
        });
      }
      const result =
        mode === "recorded"
          ? await deps.service.replayRecordedRun(context, params.companyId, params.runId, {
              ...(body.replayId ? { replayId: body.replayId } : {}),
              ...(body.projectId ? { projectId: body.projectId } : {}),
            })
          : await deps.service.replayLiveRun(context, params.companyId, params.runId, {
              ...(body.projectId ? { projectId: body.projectId } : {}),
            });
      return reply.send({ apiVersion: "v1", status: "ok", mode, replay: result });
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.get("/companies/:companyId/code/replay/:replayId", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const params = request.params as { companyId: string; replayId: string };
      const replay = await deps.service.getReplay(context, params.companyId, params.replayId);
      return reply.send({ apiVersion: "v1", status: "ok", replay });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
