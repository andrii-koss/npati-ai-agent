import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, CodeRunTurnRecord, WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import {
  canonicalizeJson,
  readReplayBundle,
  type ReplayBundleReadPort,
  type ReplayBundleStepPayload,
} from "./code-replay-bundle";
import { scanTextForSecrets } from "./code-secret-scanner";

/**
 * C7 — the agent stream a Code Workspace renders.
 *
 * Why this surface exists at all: the UI needs "what did the agent say and do, in order". The obvious source,
 * `code_run_turns.messages`, is a dead end — the runner opens turn boundaries with
 * `{ runId, turnIndex, status, outcome }` only and **never persists the assistant text**, so that column is
 * empty by construction (verified in `coding-agent-runner.ts`). The assistant text *is* persisted, per model
 * step, in the C6b replay bundle, because a replay must reproduce exactly what the model returned.
 *
 * So this route reuses that recording instead of inventing a second one:
 *
 * - `source: "replay_bundle"` — the run has a bundle: ordered model steps (assistant text, finish reason,
 *   model/provider, usage, requested tool calls) and ordered tool calls (name, schema version, outcome,
 *   duration, and the canonical settled result the model actually received). Nothing new is written and the
 *   runner is untouched.
 * - `source: "run_state"` with `streamUnavailable: true` — the run has only write-ahead turn records, which
 *   are metadata-only by design (paths, ids, counts). The route says the transcript is unavailable rather
 *   than returning an empty stream, because "the agent said nothing" and "we never stored what it said" are
 *   different answers and only one of them is true for runs recorded before C6b.
 *
 * Three properties are deliberate:
 *
 * 1. **No existence oracle.** An unknown run and another tenant's run produce the *same* 404 with no ids in
 *    the details — the store is tenant-scoped, so both look like "no such run" and a caller cannot probe for
 *    foreign runs by shape. This is the same rule the replay by-id read follows.
 * 2. **Bounded.** Pages are limited (default 50, hard cap 200 turns) and every settled result is bounded with
 *    an explicit `resultTruncated` marker, so one enormous command output cannot take down the UI.
 * 3. **Scanned on the way out.** The bundle was already refused at write time if it contained a credential
 *    (`assertNoSecretsInReplayBundle`), but the response is re-scanned here and refused loudly
 *    (`stream_payload_invalid`) instead of filtered: silently dropping a key would hide a leak from whoever
 *    stored it.
 *
 * Authorization reuses the existing `code.changes.read` action (permission derived from the action, not from
 * a caller-supplied label). No new action is introduced: this is the same read surface the Changes tab uses,
 * and a caller that may read a run's diff may read its stream.
 */

export class CodeRunStreamRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeRunStreamRouteError";
    this.retryable = retryable;
  }
}

/** Actions this surface authorizes. A named action keeps the permission derived from the action. */
export const CODE_RUN_STREAM_ACTIONS = Object.freeze({
  streamRead: "code.changes.read",
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  invalid_stream_cursor: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  run_not_found: 404,
  stream_payload_invalid: 500,
  code_run_stream_request_failed: 500,
};

const STREAM_DEFAULT_LIMIT = 50;
const STREAM_MAX_LIMIT = 200;
/** One settled tool result may not exceed this many characters in the response. */
const MAX_RESULT_CHARS = 4_000;

interface CompanyParams { companyId: string }
interface RunParams extends CompanyParams { runId: string }

export interface CodeRunStreamRouteDeps {
  store: CodeRunStreamStore;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  /**
   * C10: the conversation cursor of the run's session.
   *
   * A rewind cannot delete rows — the replay bundle is append-only in the database — so it moves a pointer, and
   * every reader of the transcript has to apply it. When a rewind is in force for this run, the turns after the
   * cursor are not part of the conversation any more: they are dropped from the response and the response *says
   * so* (`conversationRewoundToTurn`), because a silently shorter transcript would look like data loss.
   *
   * Optional: a deployment without the durability surface (or a caller that never rewound) is unaffected.
   */
  conversationHead?: (companyId: string, sessionId: string) => Promise<{ runId: string | null; turnIndex: number } | null>;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeRunStreamRouteError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceAccessError) return "permission_denied";
  if (error instanceof WorkspaceNotFoundError) return "run_not_found";
  return "code_run_stream_request_failed";
}

function resolveErrorStatus(error: unknown, code: string): number {
  // The code is the contract, so the table wins over an error's own status: a store error carries 403
  // (`WorkspaceAccessError`) while a malformed cursor is a client mistake and must surface as 400.
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
  const message = code === "code_run_stream_request_failed"
    ? "Code run stream request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code run stream request failed");
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

function readLimit(value: unknown): number {
  if (value === undefined || value === "") return STREAM_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new CodeRunStreamRouteError("invalid_arguments", "limit must be a positive number", 400, { field: "limit" });
  }
  return Math.min(Math.trunc(parsed), STREAM_MAX_LIMIT);
}

function readCursor(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CodeRunStreamRouteError("invalid_stream_cursor", "cursor must be a non-negative turn index", 400, {
      field: "cursor",
    });
  }
  return Math.trunc(parsed);
}

/** A settled result is bounded in the response; the marker keeps "short result" and "we cut it" distinct. */
function boundedResult(value: unknown): { result?: unknown; resultTruncated: boolean } {
  if (value === undefined) return { resultTruncated: false };
  let serialized: string;
  try {
    serialized = canonicalizeJson(value);
  } catch {
    return { result: "[unserializable]", resultTruncated: true };
  }
  if (serialized.length <= MAX_RESULT_CHARS) return { result: value, resultTruncated: false };
  return { result: `${serialized.slice(0, MAX_RESULT_CHARS)}…`, resultTruncated: true };
}

interface AssistantStep {
  turnIndex: number;
  content: string;
  finishReason?: unknown;
  model?: unknown;
  provider?: unknown;
  usage?: unknown;
  toolCalls: Array<{ id: unknown; name: unknown; argumentsHash: unknown }>;
}

interface ToolCard {
  turnIndex: number;
  toolCallId: unknown;
  tool: unknown;
  toolVersion: unknown;
  outcome: unknown;
  errorCode?: unknown;
  truncated: boolean;
  durationMs?: unknown;
  result?: unknown;
  resultTruncated: boolean;
}

function toAssistantStep(step: ReplayBundleStepPayload): AssistantStep {
  const response = (step as { response?: Record<string, unknown> }).response ?? {};
  const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  return {
    turnIndex: Number(step.turnIndex),
    content: typeof response.content === "string" ? response.content : "",
    finishReason: response.finishReason,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    toolCalls: toolCalls.map((call) => {
      const shaped = call as { id?: unknown; name?: unknown; argumentsHash?: unknown };
      return { id: shaped.id, name: shaped.name, argumentsHash: shaped.argumentsHash };
    }),
  };
}

function toToolCard(step: ReplayBundleStepPayload): ToolCard {
  const shaped = step as Record<string, unknown>;
  const bounded = boundedResult(shaped.settledResult);
  return {
    turnIndex: Number(step.turnIndex),
    toolCallId: shaped.toolCallId,
    tool: shaped.tool,
    toolVersion: shaped.toolVersion,
    outcome: shaped.outcome,
    ...(shaped.errorCode === undefined ? {} : { errorCode: shaped.errorCode }),
    truncated: shaped.truncated === true,
    ...(shaped.durationMs === undefined ? {} : { durationMs: shaped.durationMs }),
    ...(bounded.result === undefined ? {} : { result: bounded.result }),
    resultTruncated: bounded.resultTruncated,
  };
}

/**
 * Groups the recorded steps into turns: the assistant answer of a turn, then the calls it produced.
 * Steps are already in execution order, so grouping must not reorder them.
 */
function groupSteps(steps: ReplayBundleStepPayload[]): Array<{
  turnIndex: number;
  assistant?: AssistantStep;
  toolCalls: ToolCard[];
}> {
  const turns = new Map<number, { turnIndex: number; assistant?: AssistantStep; toolCalls: ToolCard[] }>();
  for (const step of steps) {
    const turnIndex = Number(step.turnIndex);
    const existing = turns.get(turnIndex) ?? { turnIndex, toolCalls: [] };
    if (step.kind === "model_step") {
      existing.assistant = toAssistantStep(step);
    } else {
      existing.toolCalls.push(toToolCard(step));
    }
    turns.set(turnIndex, existing);
  }
  return Array.from(turns.values()).sort((a, b) => a.turnIndex - b.turnIndex);
}

/** Turns recorded by C6a: metadata only, so they carry no assistant text at all. */
function fromRunStateTurns(turns: CodeRunTurnRecord[]) {
  return turns
    .slice()
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .map((turn) => ({
      turnIndex: turn.turnIndex,
      toolCalls: turn.toolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        tool: call.tool,
        toolVersion: null,
        outcome: call.outcome,
        ...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
        truncated: false,
        resultTruncated: false,
      })),
    }));
}

export const STREAM_UNAVAILABLE_MESSAGE =
  "This run has no recorded transcript (recorded before C6b); only turn boundaries and tool outcomes are available.";

export async function registerCodeRunStreamRoutes(instance: FastifyInstance, deps: CodeRunStreamRouteDeps) {
  const contextOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    return context;
  };

  const authorizeRead = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = contextOrFail(request);
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  instance.get(
    "/companies/:companyId/code/runs/:runId/turns",
    async (request, reply) => {
      const { companyId, runId } = request.params as RunParams;
      try {
        await authorizeRead(request, companyId, CODE_RUN_STREAM_ACTIONS.streamRead);
        const query = request.query as { limit?: string; cursor?: string };
        const limit = readLimit(query.limit);
        const cursor = readCursor(query.cursor);

        // The store is tenant-scoped, so a foreign run and an unknown run both answer `null` here. The 404
        // below therefore carries no ids: a caller cannot tell the two apart, which is the point.
        const state = await deps.store.getCodeRunState(companyId, runId);
        if (!state) {
          throw new CodeRunStreamRouteError("run_not_found", "Run not found", 404, {});
        }

        const bundle = await readReplayBundle({ store: deps.store, companyId, runId });
        const hasBundle = bundle.kind === "bundle" && bundle.steps.length > 0;

        const recordedTurns = hasBundle
          ? groupSteps(bundle.steps)
          : fromRunStateTurns(await deps.store.listCodeRunTurns(companyId, runId));

        /**
         * C10: the conversation cursor. It applies only when it points into *this* run: a cursor naming another run
         * means the conversation moved on, and truncating this run's transcript by a position from a different run
         * would be meaningless. A cursor that could not be read is not a rewind either — the read is fail-open
         * because dropping turns on a failed lookup would hide history that is genuinely there.
         */
        let rewindTurn: number | null = null;
        if (deps.conversationHead && state.sessionId) {
          try {
            const head = await deps.conversationHead(companyId, state.sessionId);
            if (head && head.runId === runId) rewindTurn = head.turnIndex;
          } catch {
            rewindTurn = null;
          }
        }
        const allTurns = rewindTurn === null
          ? recordedTurns
          : recordedTurns.filter((turn) => turn.turnIndex <= rewindTurn);
        const turnsOmittedByRewind = recordedTurns.length - allTurns.length;

        const afterCursor = cursor === undefined ? allTurns : allTurns.filter((turn) => turn.turnIndex > cursor);
        const page = afterCursor.slice(0, limit);
        const nextCursor = afterCursor.length > page.length && page.length > 0
          ? String(page[page.length - 1]!.turnIndex)
          : null;

        const stream = {
          runId,
          source: hasBundle ? ("replay_bundle" as const) : ("run_state" as const),
          streamUnavailable: !hasBundle,
          ...(hasBundle
            ? {
                bundleId: bundle.bundleId,
                replayMode: bundle.replayMode,
                terminalStatus: bundle.terminalStatus,
                terminalReason: bundle.terminalReason,
                integrityFailure: bundle.integrityFailure === true,
                truncated: bundle.truncated === true,
              }
            : { message: STREAM_UNAVAILABLE_MESSAGE }),
          // C10: stated rather than implied — a shorter transcript after a rewind is a decision, not a loss.
          conversationRewoundToTurn: rewindTurn,
          turnsOmittedByRewind,
          turns: page,
        };

        // Re-scanned on the way out. A bundle that carried a credential was already refused when it was
        // written; refusing again here means a leak can never be *served* either.
        const findings = scanTextForSecrets(canonicalizeJson(stream)).findings;
        if (findings.length) {
          throw new CodeRunStreamRouteError("stream_payload_invalid", "Stored stream payload contains a credential", 500, {
            kinds: Array.from(new Set(findings.map((finding) => String(finding.kind)))),
          });
        }

        return reply.code(200).send({
          ...withApiVersion({}),
          status: "ok",
          stream,
          page: { limit, nextCursor },
        });
      } catch (error) {
        deps.logger?.warn({ runId, code: resolveErrorCode(error) }, "code_run_stream_route_failed");
        return fail(reply, error);
      }
    },
  );
}

/** The store surface this module reads. Intersected with the bundle port so one store serves both reads. */
export interface CodeRunStreamStore extends ReplayBundleReadPort {
  getCodeRunState(companyId: string, runId: string): Promise<Awaited<ReturnType<WorkspaceStore["getCodeRunState"]>>>;
  listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]>;
}

/** Re-exported for the wiring site so the action name cannot drift from the route. */
export type { ReplayBundleStepPayload };
