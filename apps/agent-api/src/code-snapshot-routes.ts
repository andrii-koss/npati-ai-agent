import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, CodeActivityEventRecord, WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError, encodeCodeActivityCursor } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import { readSnapshotForRun } from "./execution-snapshot";
import { assertMetadataOnlyActivityPayload } from "./code-run-activity-sink";

/**
 * C6b — read-only "why did the agent act this way" surface.
 *
 * Three questions, three answers: what environment and policies a run executed under (the immutable
 * ExecutionSnapshot), how two runs differed (the content-safe structural diff), and whether a run can be
 * reproduced (replay metadata). Everything here is a **read**: there is no mutation route in this module, so
 * the surface cannot widen what an agent may do.
 *
 * Two properties are deliberate rather than incidental:
 *
 * 1. A run recorded before C6b has **no** snapshot, and that is a first-class answer
 *    (`legacy_no_snapshot`) with HTTP 200 — old runs must stay readable instead of turning into 500s.
 *    The decision itself comes from `readSnapshotForRun`, the same reader the runner uses, so the two
 *    cannot drift apart.
 * 2. Nothing that could carry content is returned verbatim: the snapshot payload is metadata by
 *    construction, the diff is the store's content-safe structural diff, and Activity payloads are
 *    re-validated on read. A stored payload that violates the metadata-only rule is refused loudly
 *    (`activity_payload_invalid`) rather than filtered: silently dropping the offending key would hide a
 *    leak from whoever wrote it.
 *
 * Authorization goes through the shared C5a gate with **named actions** (`code.snapshot.read`,
 * `code.activity.read`, `code.replay.read`), so the permission is derived from the action and a caller
 * cannot authorize a read by handing in a convenient label.
 *
 * Refusal codes are part of the contract because the UI explains them:
 *   unauthorized · invalid_arguments · invalid_activity_cursor · snapshot_not_found
 *   permission_denied · agent_cannot_change_policy · action_not_mapped · permission_action_mismatch
 *   activity_payload_invalid · code_snapshot_request_failed
 */
export class CodeSnapshotRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeSnapshotRouteError";
    this.retryable = retryable;
  }
}

/** Actions this surface authorizes. Named actions keep the permission derived from the action. */
export const CODE_SNAPSHOT_ACTIONS = Object.freeze({
  snapshotRead: "code.snapshot.read",
  activityRead: "code.activity.read",
  replayRead: "code.replay.read",
});

/** Codes this surface can produce, with the status used when the error carries none. */
const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  invalid_activity_cursor: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  snapshot_not_found: 404,
  code_snapshot_request_failed: 500,
  activity_payload_invalid: 500,
};

/** How many activity events one page may return; the store clamps as well. */
const ACTIVITY_MAX_LIMIT = 200;
/**
 * Page size used when the caller does not name one. A default is required for the cursor to be honest: a
 * cursor may only be handed out when the page is provably full, and "full" is unknowable without a limit.
 */
const ACTIVITY_DEFAULT_LIMIT = 50;

interface CompanyParams { companyId: string }
interface RunParams extends CompanyParams { runId: string }
interface SnapshotParams extends CompanyParams { snapshotId: string }

export interface CodeSnapshotReadStore {
  getSnapshotForRun(companyId: string, runId: string): Promise<Awaited<ReturnType<WorkspaceStore["getSnapshotForRun"]>>>;
  getExecutionSnapshot(companyId: string, snapshotId: string): Promise<Awaited<ReturnType<WorkspaceStore["getExecutionSnapshot"]>>>;
  diffExecutionSnapshots(
    a: NonNullable<Awaited<ReturnType<WorkspaceStore["getSnapshotForRun"]>>>,
    b: NonNullable<Awaited<ReturnType<WorkspaceStore["getSnapshotForRun"]>>>,
  ): ReturnType<WorkspaceStore["diffExecutionSnapshots"]>;
  listCodeActivityEvents(input: Parameters<WorkspaceStore["listCodeActivityEvents"]>[0]): Promise<CodeActivityEventRecord[]>;
  getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<Awaited<ReturnType<WorkspaceStore["getReplayBundle"]>>>;
}

export interface CodeSnapshotRouteDeps {
  store: CodeSnapshotReadStore;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeSnapshotRouteError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceAccessError) {
    // The store rejects a malformed keyset cursor by throwing; that is a client mistake, not a server one.
    return /cursor/i.test(error.message) ? "invalid_activity_cursor" : "permission_denied";
  }
  if (error instanceof WorkspaceNotFoundError) return "snapshot_not_found";
  return "code_snapshot_request_failed";
}

function resolveErrorStatus(error: unknown, code: string): number {
  // The code is the contract, so the table wins over the error's own `status`. A store error carries 403
  // (`WorkspaceAccessError`) but a malformed cursor is a client mistake and must surface as 400 — reading
  // the status first would have reported it as a permission problem.
  const fromCode = ROUTE_ERROR_STATUS[code];
  if (fromCode !== undefined) return fromCode;
  const shaped = error as { httpStatus?: unknown; status?: unknown } | null;
  const explicit = Number(shaped?.httpStatus ?? shaped?.status ?? Number.NaN);
  if (Number.isFinite(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  return 500;
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) {
    return reply.code(error.status ?? 401).send({
      ...withApiVersion({}),
      error: { code: error.code ?? "unauthorized", message: error.message, retryable: false },
    });
  }
  const code = resolveErrorCode(error);
  const status = resolveErrorStatus(error, code);
  const details = (error as { details?: unknown } | null)?.details;
  const message = code === "code_snapshot_request_failed"
    ? "Execution snapshot request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Execution snapshot request failed");
  return reply.code(status).send({
    ...withApiVersion({}),
    error: {
      code,
      message,
      retryable: (error as { retryable?: unknown } | null)?.retryable === true,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function badRequest(message: string, details: Record<string, unknown> = {}): CodeSnapshotRouteError {
  return new CodeSnapshotRouteError("invalid_arguments", message, 400, details);
}

function readLimit(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw badRequest("limit must be a positive number", { field: "limit" });
  return Math.min(Math.trunc(parsed), ACTIVITY_MAX_LIMIT);
}

/** The UI asks for one run's snapshot first, so the "no snapshot" answer carries no error shape at all. */
export const LEGACY_NO_SNAPSHOT_MESSAGE =
  "This run was recorded before execution snapshots existed (legacy_no_snapshot).";

export async function registerCodeSnapshotRoutes(instance: FastifyInstance, deps: CodeSnapshotRouteDeps) {
  const contextOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    return context;
  };

  const authorizeRead = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = contextOrFail(request);
    // The gate derives the required permission from the action and refuses any pair that disagrees, so the
    // only correct call shape is to hand it the derived permission itself. An action it does not know stays
    // `""` and is refused as `action_not_mapped` — deny by default, never a fallback to a convenient label.
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  const loadSnapshot = async (companyId: string, snapshotId: string) => {
    const record = await deps.store.getExecutionSnapshot(companyId, snapshotId);
    if (!record) throw new CodeSnapshotRouteError("snapshot_not_found", "Execution snapshot not found", 404, { snapshotId });
    return record;
  };

  /**
   * The snapshot of a run, with everything the Run Trace view needs to answer "in which environment and
   * with which policies did this execute": the payload plus its identity (version, hash, chain, trigger).
   */
  instance.get<{ Params: RunParams }>("/companies/:companyId/code/runs/:runId/snapshot", async (request, reply) => {
    try {
      const { companyId, runId } = request.params;
      await authorizeRead(request, companyId, CODE_SNAPSHOT_ACTIONS.snapshotRead);
      // Same reader the runner uses, so the legacy decision cannot drift between writer and reader.
      const read = await readSnapshotForRun(
        { getSnapshotForRun: (id, run) => deps.store.getSnapshotForRun(id, run) },
        companyId,
        runId,
      );
      if (read.kind === "legacy_no_snapshot") {
        return reply.send(withApiVersion({ runId, status: "legacy_no_snapshot", message: LEGACY_NO_SNAPSHOT_MESSAGE }));
      }
      const record = await deps.store.getExecutionSnapshot(companyId, read.snapshotId);
      if (!record) {
        // The snapshot vanished between the two reads: report it as missing rather than as an empty success.
        throw new CodeSnapshotRouteError("snapshot_not_found", "Execution snapshot not found", 404, { snapshotId: read.snapshotId });
      }
      return reply.send(withApiVersion({
        status: "snapshot",
        runId,
        snapshot: {
          snapshotId: record.id,
          snapshotVersion: record.snapshotVersion,
          runId: record.runId,
          sessionId: record.sessionId,
          projectId: record.projectId,
          trigger: record.trigger,
          legacy: record.legacy,
          payloadHash: record.payloadHash,
          prevSnapshotId: record.prevSnapshotId,
          prevPayloadHash: record.prevPayloadHash,
          createdBy: record.createdBy,
          createdAt: record.createdAt,
          payload: record.payload,
        },
      }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Structural diff of two snapshots: which component changed, never the values themselves. */
  instance.get<{ Params: CompanyParams; Querystring: { a?: string; b?: string } }>(
    "/companies/:companyId/code/snapshots/compare",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        await authorizeRead(request, companyId, CODE_SNAPSHOT_ACTIONS.snapshotRead);
        const a = String(request.query?.a ?? "").trim();
        const b = String(request.query?.b ?? "").trim();
        if (!a || !b) throw badRequest("a and b snapshot ids are required", { fields: ["a", "b"] });
        const [left, right] = await Promise.all([loadSnapshot(companyId, a), loadSnapshot(companyId, b)]);
        const diff = deps.store.diffExecutionSnapshots(left, right);
        return reply.send(withApiVersion({
          status: "compared",
          a: { snapshotId: left.id, runId: left.runId, snapshotVersion: left.snapshotVersion },
          b: { snapshotId: right.id, runId: right.runId, snapshotVersion: right.snapshotVersion },
          diff,
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** One snapshot by id — the same shape the run route returns, for links from a diff. */
  instance.get<{ Params: SnapshotParams }>("/companies/:companyId/code/snapshots/:snapshotId", async (request, reply) => {
    try {
      const { companyId, snapshotId } = request.params;
      await authorizeRead(request, companyId, CODE_SNAPSHOT_ACTIONS.snapshotRead);
      const record = await loadSnapshot(companyId, snapshotId);
      return reply.send(withApiVersion({
        status: "snapshot",
        snapshot: {
          snapshotId: record.id,
          snapshotVersion: record.snapshotVersion,
          runId: record.runId,
          sessionId: record.sessionId,
          projectId: record.projectId,
          trigger: record.trigger,
          legacy: record.legacy,
          payloadHash: record.payloadHash,
          prevSnapshotId: record.prevSnapshotId,
          prevPayloadHash: record.prevPayloadHash,
          createdBy: record.createdBy,
          createdAt: record.createdAt,
          payload: record.payload,
        },
      }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Activity events of a run, newest first, keyset-paginated. The payload is metadata-only; an event that
   * somehow carries content fails the read loudly instead of being silently cleaned here.
   */
  instance.get<{ Params: RunParams; Querystring: { limit?: string; cursor?: string; snapshotId?: string } }>(
    "/companies/:companyId/code/runs/:runId/activity",
    async (request, reply) => {
      try {
        const { companyId, runId } = request.params;
        await authorizeRead(request, companyId, CODE_SNAPSHOT_ACTIONS.activityRead);
        const limit = readLimit(request.query?.limit) ?? ACTIVITY_DEFAULT_LIMIT;
        const cursor = request.query?.cursor === undefined ? undefined : String(request.query.cursor);
        const snapshotId = request.query?.snapshotId === undefined ? undefined : String(request.query.snapshotId);
        const events = await deps.store.listCodeActivityEvents({
          companyId,
          runId,
          limit,
          ...(cursor === undefined || cursor === "" ? {} : { cursor }),
          ...(snapshotId === undefined || snapshotId === "" ? {} : { snapshotId }),
        });
        for (const event of events) {
          try {
            assertMetadataOnlyActivityPayload(event.payload);
          } catch (error) {
            // Log only the identity: the offending payload is exactly what must not be copied into a log.
            deps.logger?.warn(
              { action: "activity_payload_invalid", eventId: event.id, kind: event.kind, reason: (error as Error).message },
              "code_activity_read_rejected",
            );
            throw new CodeSnapshotRouteError(
              "activity_payload_invalid",
              "A stored activity event carries content and can not be returned",
              500,
              { reason: "activity_payload_must_not_carry_content" },
            );
          }
        }
        const last = events[events.length - 1];
        return reply.send(withApiVersion({
          status: "ok",
          runId,
          limit,
          events,
          // The store's own keyset cursor, and only when the page is provably full: handing one out for a
          // short page would tell the caller there is more when there is not. Paging must never depend on
          // an offset that shifts while new events are appended, and a hand-rolled cursor would silently
          // stop matching the store's reader.
          ...(last && events.length === limit
            ? { nextCursor: encodeCodeActivityCursor({ createdAt: last.createdAt, id: last.id }) }
            : {}),
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Replay metadata for a run: whether a bundle exists, in which mode it may be replayed and how it
   * ended. Counts and hashes only — the recorded steps carry model-visible results and stay behind the
   * replay engine, which is the only caller that needs them.
   */
  instance.get<{ Params: RunParams }>("/companies/:companyId/code/runs/:runId/replay", async (request, reply) => {
    try {
      const { companyId, runId } = request.params;
      await authorizeRead(request, companyId, CODE_SNAPSHOT_ACTIONS.replayRead);
      const bundle = await deps.store.getReplayBundle(companyId, runId);
      if (!bundle) {
        // A run recorded before C6b has no bundle: first-class answer, not an error (same rule as legacy_no_snapshot).
        return reply.send(withApiVersion({
          status: "no_bundle",
          runId,
          message: "This run has no recorded replay bundle (no_bundle).",
        }));
      }
      const stepCounts = bundle.payload?.stepCounts;
      return reply.send(withApiVersion({
        status: "bundle",
        runId,
        replay: {
          bundleId: bundle.id,
          bundleVersion: bundle.bundleVersion,
          replayMode: bundle.replayMode,
          sourceRunId: bundle.sourceRunId,
          sourceSnapshotId: bundle.sourceSnapshotId,
          executionSnapshotId: bundle.executionSnapshotId,
          terminalStatus: bundle.terminalStatus,
          terminalReason: bundle.terminalReason,
          provider: bundle.provider,
          model: bundle.model,
          runnerVersion: bundle.runnerVersion,
          systemPromptVersion: bundle.systemPromptVersion,
          systemPromptContentHash: bundle.systemPromptContentHash,
          modelProfileVersion: bundle.modelProfileVersion,
          replayInputHash: bundle.replayInputHash,
          stepCount: Number(bundle.payload?.stepCount ?? 0),
          ...(stepCounts === undefined ? {} : { stepCounts }),
          dataClassification: bundle.dataClassification,
          retentionClass: bundle.retentionClass,
          createdAt: bundle.createdAt,
          // Best-effort is a property of the mode, so the UI never has to guess it from the name.
          bestEffort: bundle.replayMode === "live_best_effort",
          ...(bundle.replayMode === "live_best_effort"
            ? { notice: "Best-effort reproducibility. External models, registries and services may have changed." }
            : {}),
        },
      }));
    } catch (error) {
      return fail(reply, error);
    }
  });
}
