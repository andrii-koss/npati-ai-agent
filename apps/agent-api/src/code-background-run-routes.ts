import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import type { CodeBackgroundRunEvent, CodeBackgroundRunRegistry } from "./code-background-run-registry";

/**
 * C10 (ТЗ item 5) — "return to the stream" for a run that outlived its tab.
 *
 * Three read shapes over one registry, so a client can pick what its transport supports and none of them can
 * disagree about the run's state:
 *
 *  - `GET /companies/:companyId/code/runs/:runId/background` — a JSON snapshot plus the events after `fromSeq`.
 *    This is the polling fallback: it works through every proxy and is what a mobile client uses.
 *  - `GET /companies/:companyId/code/runs/:runId/background-stream` — the same data as SSE (`event:`/`data:`),
 *    missed events first and then live ones, with heartbeats so an idle run does not look like a dead connection.
 *  - `POST /companies/:companyId/code/runs/:runId/background/abort` — an explicit stop of a background run.
 *
 * The identity check is the anti-oracle: the caller must repeat the run id it is looking for as `expectedRunId`.
 * A foreign run and a nonexistent run both answer the **same** 404 with no ids, so this surface cannot be used to
 * probe another tenant's runs. Authorization is the existing C5a gate on the existing read action
 * (`code.changes.read`): a caller that may read a run's diff may read its live progress — no new permission is
 * invented for the same data.
 */

export class CodeBackgroundRunRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeBackgroundRunRouteError";
    this.retryable = retryable;
  }
}

export const CODE_BACKGROUND_RUN_ACTIONS = Object.freeze({
  read: "code.changes.read",
  /**
   * Stopping a background run is stopping a run, so it reuses the C7 `code.session.stop` action (permission
   * `workspace:write`) instead of inventing a second way to say the same thing. The permission is still derived
   * from the action through the shared gate, so a caller cannot authorize it by handing in a convenient label.
   */
  abort: "code.session.stop",
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  run_not_found: 404,
  background_run_not_found: 404,
  background_runs_disabled: 403,
  code_background_run_request_failed: 500,
};

/** Heartbeat interval of the reconnect stream; the client's own timeout must be longer than this. */
export const BACKGROUND_STREAM_HEARTBEAT_MS = 15_000;

interface CompanyParams { companyId: string }
interface RunParams extends CompanyParams { runId: string }

export interface CodeBackgroundRunRouteDeps {
  registry: CodeBackgroundRunRegistry;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  /**
   * Feature-flag check for `code.background_runs`. Optional: a deployment without the flag service keeps the
   * surface available, but a deployment that has it must be able to refuse — the flag is what makes "runs survive
   * a closed tab" an operator decision rather than a surprise.
   */
  isBackgroundRunsEnabled?: (ctx: AuthContext, companyId: string) => Promise<boolean>;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeBackgroundRunRouteError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  return "code_background_run_request_failed";
}

function resolveErrorStatus(error: unknown, code: string): number {
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
  const message = code === "code_background_run_request_failed"
    ? "Background run request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Background run request failed");
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

function readSeq(value: unknown, field: string): number {
  if (value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CodeBackgroundRunRouteError("invalid_arguments", `${field} must be a non-negative number`, 400, { field });
  }
  return Math.trunc(parsed);
}

/**
 * `expectedRunId` is mandatory and must equal the path id. That is what makes the 404 below indistinguishable
 * between "no such run", "another tenant's run" and "the wrong id for this path".
 */
function requireExpectedRunId(expected: unknown, runId: string): void {
  if (typeof expected !== "string" || expected.trim() === "") {
    throw new CodeBackgroundRunRouteError("invalid_arguments", "expectedRunId is required", 400, { field: "expectedRunId" });
  }
  if (expected !== runId) {
    throw new CodeBackgroundRunRouteError("background_run_not_found", "Background run not found", 404, {});
  }
}

function serializeEvent(event: CodeBackgroundRunEvent): string {
  return `id: ${event.seq}\nevent: ${event.event}\ndata: ${JSON.stringify({ ...(typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : { value: event.data }), seq: event.seq, at: event.at })}\n\n`;
}

export async function registerCodeBackgroundRunRoutes(instance: FastifyInstance, deps: CodeBackgroundRunRouteDeps) {
  const contextOrFail = async (request: unknown, companyId: string): Promise<AuthContext> => {
    const context = deps.getAuthContext(request);
    if (!context) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    if (deps.isBackgroundRunsEnabled) {
      const enabled = await deps.isBackgroundRunsEnabled(context, companyId).catch(() => false);
      if (!enabled) {
        throw new CodeBackgroundRunRouteError(
          "background_runs_disabled",
          "Background code runs are not enabled for this Company.",
          403,
          { flag: "code.background_runs" },
        );
      }
    }
    return context;
  };

  const authorize = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = await contextOrFail(request, companyId);
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  /** One run's snapshot and its missed events. The polling fallback and the SSE route share this read. */
  const readRun = async (request: unknown, companyId: string, runId: string) => {
    await authorize(request, companyId, CODE_BACKGROUND_RUN_ACTIONS.read);
    const query = (request as { query?: Record<string, unknown> }).query ?? {};
    requireExpectedRunId(query.expectedRunId, runId);
    const fromSeq = readSeq(query.fromSeq, "fromSeq");
    const result = deps.registry.read(runId, fromSeq);
    if (result.kind === "unknown") {
      throw new CodeBackgroundRunRouteError("background_run_not_found", "Background run not found", 404, {});
    }
    /**
     * C15 — the tenant barrier on the **stream** path.
     *
     * Until C15 this read was keyed by `runId` alone: the authorization gate asked whether the caller may read
     * *a* run's changes, the anti-oracle compared the id it was given with the id in the path, and nothing compared
     * the run's own tenant with the `companyId` in the path. The record it returns carries `sessionId`, `userId`
     * and `projectId` and the SSE route then streams every event of that run, so a caller who learned another
     * tenant's run id could read that tenant's run by putting its *own* company id in the URL. The id is random and
     * server-minted (which is why this was never reachable in practice), but "unreachable because the id is
     * unguessable" is a property of the id, not an access control — and the run-start route added in C15 makes run
     * ids much easier to obtain legitimately, so the check belongs here.
     *
     * A foreign run answers the **same** 404 with the same empty details as a nonexistent one, so this is not a new
     * oracle: it narrows what a caller can read without telling it anything about what exists.
     */
    if (result.snapshot.companyId !== companyId) {
      throw new CodeBackgroundRunRouteError("background_run_not_found", "Background run not found", 404, {});
    }
    return { result, fromSeq };
  };

  instance.get<{ Params: RunParams }>("/companies/:companyId/code/runs/:runId/background", async (request, reply) => {
    const { companyId, runId } = request.params;
    try {
      const { result } = await readRun(request, companyId, runId);
      return reply.code(200).send(withApiVersion({
        status: result.kind,
        run: result.snapshot,
        events: result.events,
      }));
    } catch (error) {
      deps.logger?.warn({ runId, code: resolveErrorCode(error) }, "code_background_run_read_failed");
      return fail(reply, error);
    }
  });

  /**
   * The reconnect stream. Missed events are written first, then live ones; when the run is already finished the
   * response ends after the terminal event instead of holding the socket open for a run that will never speak
   * again.
   */
  instance.get<{ Params: RunParams }>("/companies/:companyId/code/runs/:runId/background-stream", async (request, reply) => {
    const { companyId, runId } = request.params;
    let detach: (() => void) | null = null;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const { result } = await readRun(request, companyId, runId);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.flushHeaders();
      const write = (chunk: string) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        reply.raw.write(chunk);
      };
      write(`event: state\ndata: ${JSON.stringify({ run: result.snapshot })}\n\n`);
      for (const event of result.events) write(serializeEvent(event));
      if (result.kind === "finished") {
        write("event: end\ndata: {\"reason\":\"run_finished\"}\n\n");
        reply.raw.end();
        return;
      }
      detach = deps.registry.subscribe(runId, (event) => {
        write(serializeEvent(event));
        if (event.event === "terminal") reply.raw.end();
      });
      if (!detach) {
        // The run finished (and was forgotten) between the read and the subscribe: answer honestly and close.
        write("event: end\ndata: {\"reason\":\"run_finished\"}\n\n");
        reply.raw.end();
        return;
      }
      heartbeat = setInterval(() => write(`: heartbeat ${Date.now()}\n\n`), BACKGROUND_STREAM_HEARTBEAT_MS);
      heartbeat.unref?.();
      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        detach?.();
        detach = null;
      };
      reply.raw.once("close", close);
      reply.raw.once("error", close);
    } catch (error) {
      deps.logger?.warn({ runId, code: resolveErrorCode(error) }, "code_background_run_stream_failed");
      if (heartbeat) clearInterval(heartbeat);
      detach?.();
      if (reply.raw.headersSent) {
        if (!reply.raw.writableEnded) reply.raw.end();
        return;
      }
      return fail(reply, error);
    }
  });

  /**
   * An explicit stop. The route only signals: the run's own `finally` writes the terminal status and releases its
   * queue slot, so there is exactly one writer of "this run ended".
   */
  instance.post<{ Params: RunParams }>("/companies/:companyId/code/runs/:runId/background/abort", async (request, reply) => {
    const { companyId, runId } = request.params;
    try {
      await authorize(request, companyId, CODE_BACKGROUND_RUN_ACTIONS.abort);
      const body = (request as { body?: Record<string, unknown> }).body ?? {};
      requireExpectedRunId(body.expectedRunId, runId);
      // Bind the mutation to the same company as reads before signalling the run. A finished foreign run
      // must also use the unknown-run response instead of exposing its snapshot via already_finished.
      const snapshot = deps.registry.startSnapshot(runId);
      if (!snapshot || snapshot.companyId !== companyId) {
        throw new CodeBackgroundRunRouteError("background_run_not_found", "Background run not found", 404, {});
      }
      const aborted = deps.registry.abort(runId);
      if (!aborted) {
        const known = deps.registry.startSnapshot(runId);
        if (!known) throw new CodeBackgroundRunRouteError("background_run_not_found", "Background run not found", 404, {});
        // Already finished: report that instead of pretending a stop happened.
        return reply.code(200).send(withApiVersion({ status: "already_finished", run: known }));
      }
      return reply.code(202).send(withApiVersion({ status: "aborting", runId }));
    } catch (error) {
      deps.logger?.warn({ runId, code: resolveErrorCode(error) }, "code_background_run_abort_failed");
      return fail(reply, error);
    }
  });
}
