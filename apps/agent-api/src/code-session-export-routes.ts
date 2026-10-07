import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, CodeRunTurnRecord } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import {
  canonicalizeJson,
  assertNoSecretsInReplayBundle,
  readReplayBundle,
  type ReplayBundleReadPort,
  type ReplayBundleStepPayload,
} from "./code-replay-bundle";
import { scanTextForSecrets } from "./code-secret-scanner";
import type { CodeRunStreamStore } from "./code-run-stream-routes";

/**
 * C10 (ТЗ item 8) — export one run's session to Markdown, without secrets.
 *
 * The single source of transcript is the same one the Workspace already reads: `GET /code/runs/:runId/turns`,
 * i.e. the C6b replay bundle with `code_run_turns` as the metadata-only fallback. This module therefore
 * **reuses** two things rather than re-implementing them, because both are the security contract:
 *
 *  1. **The same bounds.** `EXPORT_DEFAULT_LIMIT`/`EXPORT_MAX_LIMIT` are the turn bounds of the stream route
 *     (50/200) and `EXPORT_MAX_RESULT_CHARS` is its 4000-character settled-result bound with the same explicit
 *     truncation marker. An export must not become a way to read more than the API is willing to serve.
 *  2. **The same scanners.** The bundle is refused at write time by `assertNoSecretsInReplayBundle`; the export
 *     re-runs that assertion over the material it is about to emit and then scans the **finished Markdown** with
 *     `scanTextForSecrets`. A finding is a refusal (`export_secret_detected`, HTTP 422, kinds only — never the
 *     value, never the redacted preview) and the response carries no document at all. Silently redacting would be
 *     worse: the file would look like a clean transcript while the secret stayed in the workspace, and whoever
 *     exported it would have no reason to rotate the credential.
 *
 * Authorization reuses `code.changes.read`: exporting is reading the run's transcript, which is exactly the data
 * that action already governs, so no new permission is invented for it. The feature flag (`code.export`) is an
 * additional gate, deny by default when the reader throws.
 */

export class CodeSessionExportError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeSessionExportError";
    this.retryable = retryable;
  }
}

export const CODE_SESSION_EXPORT_ACTIONS = Object.freeze({
  export: "code.changes.read",
});

export const CODE_SESSION_EXPORT_FLAG = "code.export";

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  export_disabled: 403,
  run_not_found: 404,
  export_secret_detected: 422,
  code_session_export_request_failed: 500,
};

/** The stream route's page bounds, reused so an export cannot read more turns than the API serves. */
export const EXPORT_DEFAULT_LIMIT = 50;
export const EXPORT_MAX_LIMIT = 200;
/** The stream route's settled-result bound, reused with the same explicit marker. */
export const EXPORT_MAX_RESULT_CHARS = 4_000;

interface CompanyParams { companyId: string }
interface RunParams extends CompanyParams { runId: string }

export interface CodeSessionExportRouteDeps {
  store: CodeRunStreamStore;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  /** `code.export` gate. Optional; when present a throwing reader denies the export. */
  isExportEnabled?: (ctx: AuthContext, companyId: string) => Promise<boolean>;
  /** C10: the conversation cursor, so an export of a rewound session says where it ends. */
  conversationHead?: (companyId: string, sessionId: string) => Promise<{ runId: string | null; turnIndex: number } | null>;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeSessionExportError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceAccessError) return "permission_denied";
  if (error instanceof WorkspaceNotFoundError) return "run_not_found";
  return "code_session_export_request_failed";
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
  const message = code === "code_session_export_request_failed"
    ? "Session export failed"
    : String((error as { message?: unknown } | null)?.message ?? "Session export failed");
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
  if (value === undefined || value === "") return EXPORT_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new CodeSessionExportError("invalid_arguments", "limit must be a positive number", 400, { field: "limit" });
  }
  return Math.min(Math.trunc(parsed), EXPORT_MAX_LIMIT);
}

/** The stream route's bound, with the same `…` marker so a reader can see that a result was cut. */
function boundedResult(value: unknown): { text: string | null; truncated: boolean } {
  if (value === undefined) return { text: null, truncated: false };
  let serialized: string;
  try {
    serialized = canonicalizeJson(value);
  } catch {
    return { text: "[unserializable]", truncated: true };
  }
  if (serialized.length <= EXPORT_MAX_RESULT_CHARS) return { text: serialized, truncated: false };
  return { text: `${serialized.slice(0, EXPORT_MAX_RESULT_CHARS)}…`, truncated: true };
}

/**
 * Escapes a value for a Markdown **table cell**: a `|` would end the cell and a newline would end the row, so a
 * tool name or a model answer could otherwise restructure the document it is quoted in.
 */
function cell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function fenced(value: string, language = ""): string {
  // The fence must be longer than the longest run of backticks inside the value, or the value could close its own
  // fence and inject Markdown into the document.
  const longest = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

interface ExportTurn {
  turnIndex: number;
  assistant?: { content: string; finishReason: unknown; model: unknown; provider: unknown; toolCalls: Array<{ id: unknown; name: unknown }> };
  toolCalls: Array<{
    toolCallId: unknown;
    tool: unknown;
    toolVersion: unknown;
    outcome: unknown;
    errorCode?: unknown;
    truncated: boolean;
    durationMs?: unknown;
    resultText: string | null;
    resultTruncated: boolean;
  }>;
}

function toExportTurn(step: ReplayBundleStepPayload): Partial<ExportTurn> {
  if (step.kind === "model_step") {
    const response = (step as { response?: Record<string, unknown> }).response ?? {};
    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    return {
      assistant: {
        content: typeof response.content === "string" ? response.content : "",
        finishReason: response.finishReason,
        model: response.model,
        provider: response.provider,
        toolCalls: toolCalls.map((call) => {
          const shaped = call as { id?: unknown; name?: unknown };
          return { id: shaped.id, name: shaped.name };
        }),
      },
    };
  }
  const shaped = step as Record<string, unknown>;
  const bounded = boundedResult(shaped.settledResult);
  return {
    toolCalls: [{
      toolCallId: shaped.toolCallId,
      tool: shaped.tool,
      toolVersion: shaped.toolVersion,
      outcome: shaped.outcome,
      ...(shaped.errorCode === undefined ? {} : { errorCode: shaped.errorCode }),
      truncated: shaped.truncated === true,
      ...(shaped.durationMs === undefined ? {} : { durationMs: shaped.durationMs }),
      resultText: bounded.text,
      resultTruncated: bounded.truncated,
    }],
  };
}

function groupExportTurns(steps: ReplayBundleStepPayload[]): ExportTurn[] {
  const turns = new Map<number, ExportTurn>();
  for (const step of steps) {
    const turnIndex = Number(step.turnIndex);
    const existing = turns.get(turnIndex) ?? { turnIndex, toolCalls: [] };
    const partial = toExportTurn(step);
    if (partial.assistant) existing.assistant = partial.assistant;
    if (partial.toolCalls) existing.toolCalls.push(...partial.toolCalls);
    turns.set(turnIndex, existing);
  }
  return Array.from(turns.values()).sort((a, b) => a.turnIndex - b.turnIndex);
}

/** Metadata-only fallback for a run recorded before C6b: turn boundaries and tool outcomes, no assistant text. */
function fromRunStateTurns(turns: CodeRunTurnRecord[]): ExportTurn[] {
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
        durationMs: null,
        resultText: null,
        resultTruncated: false,
      })),
    }));
}

export interface CodeSessionExportDocument {
  markdown: string;
  fileName: string;
  turns: number;
  source: "replay_bundle" | "run_state";
}

/**
 * Renders the Markdown. Exported as a pure function so the format is testable without a transport, and so the
 * secret refusal can be asserted on the exact string a user would download.
 */
export function renderCodeSessionMarkdown(input: {
  runId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  status: string;
  exportedAt: string;
  source: "replay_bundle" | "run_state";
  limit: number;
  turns: ExportTurn[];
  totalTurns: number;
  rewoundToTurn: number | null;
  turnsOmittedByRewind: number;
  bundle?: { replayMode?: string; terminalStatus?: string | null; terminalReason?: string | null; integrityFailure?: boolean; truncated?: boolean };
}): string {
  const lines: string[] = [];
  lines.push(`# Code session export — run \`${input.runId}\``);
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Company | \`${cell(input.companyId)}\` |`);
  lines.push(`| Project | \`${cell(input.projectId)}\` |`);
  lines.push(`| Session | \`${cell(input.sessionId)}\` |`);
  lines.push(`| Run | \`${cell(input.runId)}\` |`);
  lines.push(`| Run status | ${cell(input.status)} |`);
  lines.push(`| Transcript source | ${input.source === "replay_bundle" ? "recorded replay bundle" : "run state (metadata only)"} |`);
  if (input.bundle?.replayMode) lines.push(`| Replay mode | ${cell(input.bundle.replayMode)} |`);
  if (input.bundle?.terminalStatus) lines.push(`| Terminal status | ${cell(input.bundle.terminalStatus)} |`);
  if (input.bundle?.terminalReason) lines.push(`| Terminal reason | ${cell(input.bundle.terminalReason)} |`);
  lines.push(`| Exported at | ${cell(input.exportedAt)} |`);
  lines.push(`| Turns in this file | ${input.turns.length} of ${input.totalTurns} (limit ${input.limit}) |`);
  lines.push("");
  if (input.source === "run_state") {
    lines.push("> This run was recorded before transcripts were stored: only turn boundaries and tool outcomes are");
    lines.push("> available, and the assistant text of this session was never persisted.");
    lines.push("");
  }
  if (input.bundle?.integrityFailure) {
    lines.push("> **Warning**: the stored replay bundle failed its integrity check, so this transcript may have been");
    lines.push("> altered or truncated after it was recorded.");
    lines.push("");
  }
  if (input.rewoundToTurn !== null) {
    lines.push(`> The conversation was rewound to turn ${input.rewoundToTurn}; ${input.turnsOmittedByRewind} later turn(s)`);
    lines.push("> are still stored but are not part of the conversation any more and are not exported.");
    lines.push("");
  }
  lines.push("> Exported with the same bounds and the same secret scanners as the Code Workspace stream. No secret");
  lines.push("> value is included: a run whose transcript contains a credential is refused rather than redacted.");
  lines.push("");

  for (const turn of input.turns) {
    lines.push(`## Turn ${turn.turnIndex}`);
    lines.push("");
    if (turn.assistant) {
      const meta: string[] = [];
      if (turn.assistant.model) meta.push(`model \`${cell(turn.assistant.model)}\``);
      if (turn.assistant.provider) meta.push(`provider \`${cell(turn.assistant.provider)}\``);
      if (turn.assistant.finishReason) meta.push(`finish reason \`${cell(turn.assistant.finishReason)}\``);
      if (meta.length) {
        lines.push(`_${meta.join(" · ")}_`);
        lines.push("");
      }
      lines.push(turn.assistant.content.trim() ? fenced(turn.assistant.content, "text") : "_The agent returned no text in this turn._");
      lines.push("");
      if (turn.assistant.toolCalls.length) {
        lines.push(`Requested tool calls: ${turn.assistant.toolCalls.map((call) => `\`${cell(call.name)}\``).join(", ")}`);
        lines.push("");
      }
    } else if (input.source === "replay_bundle") {
      lines.push("_No assistant step recorded for this turn._");
      lines.push("");
    }
    if (turn.toolCalls.length) {
      lines.push("| Tool | Outcome | Version | Duration | Result |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const call of turn.toolCalls) {
        const resultNote = call.resultText === null
          ? "not recorded"
          : call.resultTruncated
            ? `bounded at ${EXPORT_MAX_RESULT_CHARS} chars`
            : `${call.resultText.length} chars`;
        lines.push(`| \`${cell(call.tool)}\` | ${cell(call.outcome)}${call.errorCode ? ` (${cell(call.errorCode)})` : ""} | ${cell(call.toolVersion ?? "—")} | ${typeof call.durationMs === "number" ? `${call.durationMs} ms` : "—"} | ${resultNote} |`);
      }
      lines.push("");
      for (const call of turn.toolCalls) {
        if (call.resultText === null) continue;
        lines.push(`### \`${call.tool}\` result${call.resultTruncated ? " (truncated)" : ""}`);
        lines.push("");
        lines.push(fenced(call.resultText, "json"));
        lines.push("");
      }
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(`_Exported by NPATI Agent · schema \`code.session.export.v1\` · ${cell(input.exportedAt)}_`);
  lines.push("");
  return lines.join("\n");
}

/** A conservative file name: ids are store-generated, but the name is built from an allowlist anyway. */
function exportFileName(runId: string, sessionId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "unknown";
  return `code-session-${safe(sessionId)}-${safe(runId)}.md`;
}

export async function registerCodeSessionExportRoutes(instance: FastifyInstance, deps: CodeSessionExportRouteDeps) {
  instance.get<{ Params: RunParams; Querystring: { limit?: string; format?: string } }>(
    "/companies/:companyId/code/runs/:runId/export",
    async (request, reply) => {
      const { companyId, runId } = request.params;
      try {
        const ctx = deps.getAuthContext(request);
        if (!ctx) throw new AuthenticationError("Authentication required", 401, "unauthorized");
        if (deps.isExportEnabled) {
          const enabled = await deps.isExportEnabled(ctx, companyId).catch(() => false);
          if (!enabled) {
            throw new CodeSessionExportError(
              "export_disabled",
              "Session export is not enabled for this Company.",
              403,
              { flag: CODE_SESSION_EXPORT_FLAG },
            );
          }
        }
        await deps.authorize(ctx, companyId, {
          action: CODE_SESSION_EXPORT_ACTIONS.export,
          permission: requiredPermissionForAction(CODE_SESSION_EXPORT_ACTIONS.export) ?? "",
        });

        const limit = readLimit(request.query?.limit);
        const state = await deps.store.getCodeRunState(companyId, runId);
        if (!state) throw new CodeSessionExportError("run_not_found", "Run not found", 404, {});

        const bundle = await readReplayBundle({ store: deps.store, companyId, runId });
        const hasBundle = bundle.kind === "bundle" && bundle.steps.length > 0;
        const recordedTurns = hasBundle
          ? groupExportTurns(bundle.steps)
          : fromRunStateTurns(await deps.store.listCodeRunTurns(companyId, runId));

        // C10: the cursor applies exactly as it does in the stream route, so an export and the Workspace agree
        // about what the conversation currently is.
        let rewoundToTurn: number | null = null;
        if (deps.conversationHead) {
          try {
            const head = await deps.conversationHead(companyId, state.sessionId);
            if (head && head.runId === runId) rewoundToTurn = head.turnIndex;
          } catch {
            rewoundToTurn = null;
          }
        }
        const visibleTurns = rewoundToTurn === null
          ? recordedTurns
          : recordedTurns.filter((turn) => turn.turnIndex <= rewoundToTurn);
        const turns = visibleTurns.slice(0, limit);

        const markdown = renderCodeSessionMarkdown({
          runId,
          companyId,
          projectId: state.projectId,
          sessionId: state.sessionId,
          status: state.status,
          exportedAt: new Date().toISOString(),
          source: hasBundle ? "replay_bundle" : "run_state",
          limit,
          turns,
          totalTurns: visibleTurns.length,
          rewoundToTurn,
          turnsOmittedByRewind: recordedTurns.length - visibleTurns.length,
          ...(hasBundle
            ? {
                bundle: {
                  ...(bundle.replayMode ? { replayMode: bundle.replayMode } : {}),
                  terminalStatus: bundle.terminalStatus ?? null,
                  terminalReason: bundle.terminalReason ?? null,
                  integrityFailure: bundle.integrityFailure === true,
                  truncated: bundle.truncated === true,
                },
              }
            : {}),
        });

        // The same record-level refusal the recorder applies, re-run on the material being exported: the bundle
        // is not trusted just because it was accepted once.
        if (hasBundle) {
          try {
            assertNoSecretsInReplayBundle({ steps: bundle.steps });
          } catch (error) {
            throw new CodeSessionExportError(
              "export_secret_detected",
              "The recorded session contains a credential and can not be exported",
              422,
              { reason: "replay_bundle_secret_detected", kinds: secretKinds(error) },
            );
          }
        }
        // And the finished document, because rendering can surface a value that the structured scan saw in a
        // different form. Only the kind is reported; the value and the redacted preview stay inside this process.
        const findings = scanTextForSecrets(markdown).findings;
        if (findings.length) {
          throw new CodeSessionExportError(
            "export_secret_detected",
            "The exported session contains a credential and can not be exported",
            422,
            { reason: "markdown_secret_detected", kinds: Array.from(new Set(findings.map((finding) => finding.kind))) },
          );
        }

        const fileName = exportFileName(runId, state.sessionId);
        const wantsDocument = String(request.query?.format ?? "").toLowerCase() === "json";
        if (wantsDocument) {
          return reply.code(200).send(withApiVersion({
            status: "ok",
            fileName,
            contentType: "text/markdown; charset=utf-8",
            turns: turns.length,
            totalTurns: visibleTurns.length,
            source: hasBundle ? "replay_bundle" : "run_state",
            markdown,
          }));
        }
        return reply
          .code(200)
          .header("content-type", "text/markdown; charset=utf-8")
          .header("content-disposition", `attachment; filename="${fileName}"`)
          .header("x-npati-export-turns", String(turns.length))
          .header("x-npati-export-source", hasBundle ? "replay_bundle" : "run_state")
          .send(markdown);
      } catch (error) {
        deps.logger?.warn({ runId, code: resolveErrorCode(error) }, "code_session_export_failed");
        return fail(reply, error);
      }
    },
  );
}

function secretKinds(error: unknown): string[] {
  const kinds = (error as { details?: { kinds?: unknown } } | null)?.details?.kinds;
  return Array.isArray(kinds) ? kinds.map(String) : [];
}
