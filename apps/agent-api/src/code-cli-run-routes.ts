import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import { ApiVersionError, resolveApiVersion, withApiVersion, API_VERSION_HEADER, apiVersionInfo } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";

/**
 * C15 (owner decision 2 / 3) — **the** run-start surface of the Coding Agent, for a terminal (`npati code`) and,
 * later, for an IDE extension. This is `POST /companies/:companyId/code/runs`.
 *
 * ## Why a new route and not "just call the chat stream"
 *
 * The only way to start a code run until C15 was the chat entry point, `POST /chat/stream` (`app.ts`): it hijacks
 * the response, runs the loop inside the request, and reaches the code branch only when the intent router decides
 * the message is a code intent for the active project (`mode === "run"`, `app.ts:7199-7211`). A terminal is not a
 * chat, and that shape is wrong for it in four concrete ways — each of which is a defect for a CLI, not a taste
 * difference:
 *
 *  1. **The run id is not knowable before the stream opens.** The chat response *is* the stream: the client learns
 *     `runId` from an event after the connection is already open, so it cannot write the id anywhere (a log, a
 *     resume file, a second terminal) before the run starts, and it cannot reconnect to the run it just started if
 *     its own first connection failed. Here the id is minted **by the server** and returned in the `202` body, and
 *     the run is registered before the response is written, so the id is valid the moment the caller has it.
 *  2. **Intent routing is chat semantics.** `resolveChatCodeIntent`/`classifyCodeIntent` decide whether a *message*
 *     is a code request, and answer `routed: "clarify"` (HTTP 200) or `routed: "chat"` for anything ambiguous. A
 *     CLI already knows what it is asking for: `npati code "…"` in a project is a run request, and a reply of
 *     "which project should I work in?" rendered as a *successful* stream is the wrong contract. The project is a
 *     required, typed parameter here, and an unknown or non-code project is a refusal, not a clarification.
 *  3. **Chat side effects.** The chat branch writes conversation history, a neutral message pair and a project card
 *     (`saveChatProjectCard`, `app.ts:7364-7377`). A CLI run has no conversation, and creating a chat thread as a
 *     side effect of a terminal command is data recorded for nobody.
 *  4. **The awaiting-approval case needs a machine-readable outcome.** The chat stream reports a parked run as an
 *     event whose meaning is prose; the `202` body here carries `awaitingApproval` and the CLI then uses the
 *     **existing** `GET /companies/:companyId/approvals` route to show and decide it.
 *
 * ## What is deliberately reused (no second mechanism anywhere)
 *
 *  - **Authorization**: the shared C5a gate, `code.run.start` → `workspace:write` in `CODE_ACTION_PERMISSIONS`.
 *    The caller supplies a label that may only *confirm* the derived permission, an unmapped action is a refusal,
 *    and a principal with the wrong scope is refused — an API key with only `workspace:read` cannot start a run.
 *  - **Feature flags**: the master kill switch (`code.agent`, read through `assertEnabled` exactly like the chat
 *    entry point) and the admission decision are taken **before** the `202`, so a run that cannot start is an HTTP
 *    refusal instead of a success message followed by silence.
 *  - **Admission**: the **existing** `CodeRunQueue` — the same per-user/per-Company caps and the same fair queue the
 *    chat path uses. The slot is acquired before the response and released in the run's own `finally`.
 *  - **Execution**: the **existing** `CodeSessionRunExecutor`, which is also what the chat path drives, so the
 *    cancellation registration, the Stop route's reach and the terminal-status normalisation are one code path.
 *  - **Streaming**: the **existing** `GET /companies/:companyId/code/runs/:runId/background-stream` SSE route over
 *    the **existing** `CodeBackgroundRunRegistry`. No fourth SSE implementation and no run-start-specific stream:
 *    the run is registered with the registry, the registry buffers every event with a monotonic `seq`, and the CLI
 *    either reconnects with `fromSeq` or polls `GET …/background`. Because registration happens before the `202`,
 *    a client that subscribes immediately cannot miss the run's first event.
 *  - **Approvals**: the **existing** `/approvals` list/get/decide routes. This module never decides an approval and
 *    never invents an approval action; see `docs/audit/coding-agent/ide-protocol.md`.
 *  - **Versioning**: `withApiVersion` on every response and `x-npati-api-version` on the way in, through the shared
 *    C1a helper — the version this route answers with is the same `v1` every other code route answers with.
 *
 * ## Tenant isolation
 *
 * `companyId` is a path parameter and the **only** tenant source. The project is loaded through the store with that
 * `companyId` (the store applies its own predicate, so another tenant's project is a `404`), and the run is
 * registered under the same `companyId` that was authorized. The background stream is reached through the registry
 * with `expectedRunId` repeated by the caller, and the registry's records are keyed by a server-minted random run
 * id. A caller cannot ask this route for a run in another tenant, and a caller cannot name another tenant's run
 * id here: there is no parameter that accepts one.
 */

export class CodeCliRunError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeCliRunError";
    this.retryable = retryable;
  }
}

/**
 * The action vocabulary of this surface. One action, mapped in `CODE_ACTION_PERMISSIONS` to `workspace:write` —
 * the same permission the chat entry point effectively needs (the loop may edit files and run commands). It is
 * *not* a new permission class: `code.run.start` predates this route (C6 added it for exactly this purpose and
 * nothing called it), so the CLI token is authorized by the same vocabulary as every other code surface.
 */
export const CODE_CLI_RUN_ACTIONS = Object.freeze({
  start: "code.run.start",
});

/** How often the background stream heartbeats. Re-exported so the CLI can size its own idle timeout from it. */
export const CODE_CLI_RUN_HEARTBEAT_MS = 15_000;

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  // C1a: a client that names a version this deployment does not serve is refused with its own code, exactly as the
  // other versioned code routes do, instead of being answered in a version it did not ask for.
  unsupported_api_version: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  service_identity_cannot_operate_production: 403,
  code_runs_disabled: 403,
  project_not_found: 404,
  run_not_found: 404,
  not_a_code_project: 409,
  session_not_found: 404,
  // The run queue's own refusals. `queue_timeout` and `queue_full` are collapsed onto `CodeRunRefusedError`'s
  // codes by the queue itself; both are "come back later", which is what the CLI prints and what `retryable` says.
  queue_timeout: 429,
  queue_cancelled: 409,
  /**
   * R1 (section A, item 1): the **periodic** limit's refusal is "come back later" exactly like the queue's, so it
   * maps onto the same 429 — but under its own code, because the answer to "when" is the window's estimate rather
   * than the queue timeout, and a client that conflates the two would retry into the same refusal.
   */
  rate_limited: 429,
  code_run_start_failed: 500,
};

const ERROR_RETRYABLE = new Set(["queue_timeout", "queue_cancelled", "rate_limited"]);

interface CompanyParams { companyId: string }

/**
 * The project as far as this route is concerned: the id it was asked for and whether it is a code project. The
 * caller (the composition root) loads it through the tenant-scoped store, so `null` already means "not this
 * tenant's project, or no such project" — the two are deliberately indistinguishable.
 */
export interface CodeCliRunProject {
  id: string;
  /** Anything other than `code_project` is refused: the agent loop only ever runs in a code project. */
  type?: string | null;
}

/**
 * What the route needs from the composition root. Deliberately ports, not objects: this module may not reach the
 * store, the sandbox or the runner directly — everything that could touch a workspace goes through an injected
 * function, so the route itself has no ambient authority.
 */
export interface CodeCliRunRouteDeps {
  /**
   * The application's auth provider — the same one every other route authenticates with. This surface adds no
   * second authentication path and no per-surface request cache: the handler authenticates once, and every value
   * that depends on the principal (the project, the session) is loaded through it.
   */
  auth: AuthProvider;
  /**
   * The shared RBAC gate. The composition root passes `CodeRbac.authorize`, so this surface cannot authorize
   * differently from the rest of the code API even by accident.
   */
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  /**
   * The master kill switch. A refusal (`FeatureDisabledError`, or any throw) is a `403 code_runs_disabled` — the
   * flag is never bypassed and a flag store that cannot be read means "off", exactly as the chat path treats it.
   */
  isCodeRunsEnabled(ctx: AuthContext, companyId: string): Promise<boolean>;
  /** Loads the project through the tenant-scoped store. `null` for another tenant's project or no such project. */
  loadProject(ctx: AuthContext, companyId: string, projectId: string): Promise<CodeCliRunProject | null>;
  /** Loads a session the caller named, or `null`. The caller's own tenant scope applies. */
  loadSession(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession | null>;
  /** Creates a session when the caller named none. A session is required: the runner refuses to start without one. */
  createSession(ctx: AuthContext, companyId: string, projectId: string): Promise<CodeSession>;
  /**
   * Takes a run slot from the **existing** `CodeRunQueue`. A refusal must throw the queue's own
   * `CodeRunRefusedError`, whose `code` this module maps onto `429`/`409` without re-deriving it.
   */
  admit(ctx: AuthContext, companyId: string, sessionId: string): Promise<{ release(): void }>;
  /**
   * Registers the run with the **existing** `CodeBackgroundRunRegistry` and reports its events. Registration
   * happens before the response, so the id in the `202` body names a run that is already readable and streamable.
   */
  registerRun(input: {
    runId: string;
    ctx: AuthContext;
    companyId: string;
    sessionId: string;
    projectId: string;
  }): CodeRunRegistration;
  /** Drives the run. The composition root passes `CodeSessionRunExecutor`. */
  execute(input: {
    runId: string;
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    session: CodeSession;
    prompt: string;
    /**
     * `true` when the caller asked for a read-only run. It is a **narrowing** flag: the composition root feeds it
     * to `CodingAgentRunInput.readOnlyIntent`, which the tool runtime enforces on the server, so a client can ask
     * for less than the session would allow and never for more. Ignoring it here would silently widen a request.
     */
    readOnlyIntent: boolean;
    registration: CodeRunRegistration;
    /** Releases the queue slot. Called exactly once, after the run settled. */
    releaseSlot: () => void;
    /** Called after the run settled, with what it concluded. Never allowed to fail the run. */
    onSettled: (outcome: { terminalStatus: string; reason: string | null; needsApproval: boolean }) => Promise<void> | void;
  }): Promise<void>;
  /**
   * How the run leaves the request. The default defers to a microtask and swallows nothing: a rejection would be
   * an unhandled rejection in production, so `execute` is expected to resolve and report failures as a terminal
   * status. Injected in tests so a run can be driven deterministically.
   */
  spawn?: (task: () => Promise<void>) => void;
  now?: () => Date;
  logger?: { warn(payload: unknown, message?: string): void };
}

/** The registry handle one registered run exposes. Mirrors the sink `CodeBackgroundRunRegistry.start` returns. */
export interface CodeRunRegistration {
  signal: AbortSignal;
  emitResult(result: unknown): void;
  emitTerminal(status: "completed" | "failed" | "cancelled", reason: string | null): void;
  /** Aborts the run through the registry, so the abort is recorded in the run's own state. */
  abort(reason?: string): boolean;
}

export interface CodeCliRunBody {
  projectId?: unknown;
  sessionId?: unknown;
  prompt?: unknown;
  message?: unknown;
  /** `REVIEW_CODE`/`EXPLAIN_CODE` style read-only runs. Validated against the existing shared vocabulary. */
  readOnly?: unknown;
}

/** The typed, validated request. Every field is present after `parseRunRequest`, so the handler invents nothing. */
export interface CodeCliRunRequest {
  projectId: string;
  sessionId: string | null;
  prompt: string;
  readOnly: boolean;
}

/** The largest prompt this route accepts, in characters. Bounded so one request cannot carry a whole repository. */
export const CODE_CLI_MAX_PROMPT_CHARS = 100_000;

function readOptionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new CodeCliRunError("invalid_arguments", `${field} must be a string`, 400, { field });
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new CodeCliRunError("invalid_arguments", `${field} is too long`, 400, { field, maxLength });
  }
  return trimmed;
}

/**
 * Validates the body. Exported and pure so the refusals are testable without a Fastify instance, and so the "what
 * does this route accept" question has exactly one answer.
 *
 * `prompt` is required and is **not** an intent: the caller has already decided that this is a run. `message` is
 * accepted as an alias because that is the word the chat surface and the UI use, and refusing it would make the
 * CLI's `--message` flag a translation layer with nothing to translate.
 */
export function parseRunRequest(body: CodeCliRunBody | undefined): CodeCliRunRequest {
  const raw = body ?? {};
  const projectId = readOptionalString(raw.projectId, "projectId", 200);
  if (!projectId) {
    throw new CodeCliRunError("invalid_arguments", "projectId is required", 400, { field: "projectId" });
  }
  const prompt = readOptionalString(raw.prompt, "prompt", CODE_CLI_MAX_PROMPT_CHARS)
    ?? readOptionalString(raw.message, "message", CODE_CLI_MAX_PROMPT_CHARS);
  if (!prompt) {
    throw new CodeCliRunError("invalid_arguments", "prompt is required", 400, { field: "prompt" });
  }
  if (raw.readOnly !== undefined && typeof raw.readOnly !== "boolean") {
    throw new CodeCliRunError("invalid_arguments", "readOnly must be a boolean", 400, { field: "readOnly" });
  }
  return {
    projectId,
    sessionId: readOptionalString(raw.sessionId, "sessionId", 200),
    prompt,
    readOnly: raw.readOnly === true,
  };
}

export function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeCliRunError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  // C1a's refusal carries its own code and status; it is surfaced rather than collapsed into a generic failure.
  if (error instanceof ApiVersionError) return error.code;
  const shaped = error as { code?: unknown } | null;
  const code = typeof shaped?.code === "string" ? shaped.code : "";
  if (code && ROUTE_ERROR_STATUS[code] !== undefined) return code;
  return "code_run_start_failed";
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
  return reply.code(status).send({
    ...withApiVersion({}),
    error: {
      code,
      message: String((error as { message?: unknown } | null)?.message ?? "The run could not be started"),
      retryable: ERROR_RETRYABLE.has(code) || (error as { retryable?: unknown } | null)?.retryable === true,
      ...(details === undefined ? {} : { details }),
    },
  });
}

/**
 * The run id. Server-minted and random: it is the identity the caller repeats as `expectedRunId` on the reconnect
 * stream, so a guessable id (a timestamp, a counter) would be a guessable handle on another tenant's run. The
 * session prefix is present only to make operational logs readable; the entropy is all in the UUID.
 */
export function mintRunId(sessionId: string, uuid: string = randomUUID()): string {
  const prefix = sessionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return `${prefix}:${uuid}`;
}

export async function registerCodeCliRunRoutes(instance: FastifyInstance, deps: CodeCliRunRouteDeps) {
  const now = deps.now ?? (() => new Date());
  const spawn = deps.spawn ?? ((task) => { void task(); });

  instance.post<{ Params: CompanyParams; Body: CodeCliRunBody }>(
    "/companies/:companyId/code/runs",
    // The same Fastify-level version config the other versioned code routes carry (`code-intent-routing.ts`), in
    // addition to the `apiVersion` field every response body already includes.
    { config: { apiVersion: "v1" } },
    async (request, reply) => {
      const companyId = String((request.params as CompanyParams).companyId ?? "");
      let releaseSlot: (() => void) | null = null;
      try {
        const ctx = await deps.auth.authenticate(request as never);
        /**
         * C1a: an unsupported version is a structured refusal, not a silent downgrade — the same check the other
         * versioned code routes make (`code-routes.ts`, `code-tool-routes.ts`). It runs before the flag and RBAC so a
         * client that speaks a version this deployment does not serve is told that, rather than being told it is
         * unauthorized.
         */
        resolveApiVersion((request as { headers?: Record<string, string | string[] | undefined> }).headers ?? {});

        // The flag first, then RBAC, then the project: a disabled or unauthorized caller learns nothing about
        // whether the project it named exists.
        const enabled = await deps.isCodeRunsEnabled(ctx, companyId).catch(() => false);
        if (!enabled) {
          throw new CodeCliRunError(
            "code_runs_disabled",
            "The Coding Agent is not enabled for this Company.",
            403,
            { flag: CODE_AGENT_MASTER_FLAG },
          );
        }
        const action = CODE_CLI_RUN_ACTIONS.start;
        await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });

        const parsed = parseRunRequest((request as { body?: CodeCliRunBody }).body);
        const project = await deps.loadProject(ctx, companyId, parsed.projectId);
        if (!project) {
          // A foreign project and a nonexistent one answer the same 404 with no ids, so this cannot be an oracle.
          throw new CodeCliRunError("project_not_found", "Project not found", 404, {});
        }
        if (project.type !== "code_project") {
          throw new CodeCliRunError("not_a_code_project", "This project is not a code project", 409, {
            projectId: project.id,
            type: typeof project.type === "string" ? project.type : null,
          });
        }

        const session = parsed.sessionId
          ? await deps.loadSession(ctx, companyId, parsed.sessionId)
          : await deps.createSession(ctx, companyId, project.id);
        /**
         * A named session is usable only when it is still open **and** it is a session of the project this request
         * was authorized for. The port's contract is "the caller's session, or `null`", but a route that trusted
         * that literally would run a prompt in an archived session, or in a session of a *different* project of
         * the same Company — the caller names the session id and the project id, so the two are this route's to
         * reconcile, and a composition root cannot be the only place it happens.
         *
         * The status rule is the one the production loader already applies (`app.ts` resolves an archived session
         * to `null`); stating it here as well makes it a property of the route instead of a property of one
         * wiring. Both refusals answer `session_not_found` (404) with no ids, exactly like a session in another
         * tenant — so this cannot be turned into an existence oracle, and a caller who did not name a session
         * never reaches here (that path *creates* one, which is a decision the caller made).
         */
        if (!session || session.status === "archived" || session.projectId !== project.id) {
          throw new CodeCliRunError("session_not_found", "Code session not found", 404, {});
        }

        // Admission before the response: a run that cannot be admitted is an HTTP refusal, never a success
        // message followed by nothing. The queue's own refusal code is carried through unchanged.
        const lease = await deps.admit(ctx, companyId, session.id);
        releaseSlot = () => lease.release();

        const runId = mintRunId(session.id);
        const registration = deps.registerRun({
          runId,
          ctx,
          companyId,
          sessionId: session.id,
          projectId: project.id,
        });

        /**
         * The run leaves the request **after** the response is written. Everything that could have failed for the
         * caller has already failed above; what remains is the run itself, whose outcome is reported through the
         * registry's own events and terminal state — the CLI is already subscribed by then.
         */
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          releaseSlot?.();
          releaseSlot = null;
        };
        spawn(async () => {
          try {
            await deps.execute({
              runId,
              ctx,
              companyId,
              projectId: project.id,
              session,
              prompt: parsed.prompt,
              readOnlyIntent: parsed.readOnly,
              registration,
              releaseSlot: settle,
              onSettled: (outcome) => {
                const status = outcome.terminalStatus === "completed" ? "completed" : outcome.terminalStatus === "cancelled" ? "cancelled" : "failed";
                registration.emitTerminal(status, outcome.reason);
                settle();
              },
            });
          } catch (error) {
            // `execute` is expected to report a failure as a terminal status. Reaching here means the run died
            // before it could, so the registry is told rather than left holding a run that looks live forever.
            deps.logger?.warn({ err: error, runId, code: resolveErrorCode(error) }, "code_cli_run_execute_failed");
            try {
              registration.emitTerminal("failed", "run_failed");
            } catch { /* the registry refused the event because the run already finished */ }
          } finally {
            settle();
          }
        });

        return reply.code(202).send(withApiVersion({
          status: "accepted",
          run: {
            runId,
            sessionId: session.id,
            projectId: project.id,
            companyId,
            status: "running" as const,
            live: true,
            startedAt: now().toISOString(),
            heartbeatMs: CODE_CLI_RUN_HEARTBEAT_MS,
            readOnly: parsed.readOnly,
          },
          /**
           * Where the events are. The URL is built for the client rather than left for it to assemble, so the
           * `expectedRunId` the stream demands (the run id repeated by the caller, which is what makes the stream
           * unable to act as an existence oracle) cannot be forgotten by a client that only read `runId`.
           */
          stream: {
            kind: "sse" as const,
            method: "GET" as const,
            path: `/companies/${companyId}/code/runs/${runId}/background-stream`,
            expectedRunId: runId,
            fromSeqParam: "fromSeq",
          },
          poll: {
            method: "GET" as const,
            path: `/companies/${companyId}/code/runs/${runId}/background`,
            expectedRunId: runId,
          },
          apiVersionHeader: API_VERSION_HEADER,
          version: apiVersionInfo(now()),
        }));
      } catch (error) {
        // A run that never left the request must not keep its slot: the queue would leak capacity for a run that
        // does not exist.
        releaseSlot?.();
        releaseSlot = null;
        deps.logger?.warn({ companyId, code: resolveErrorCode(error) }, "code_cli_run_start_failed");
        return fail(reply, error);
      }
    },
  );
}
