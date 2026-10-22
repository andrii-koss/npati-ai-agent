/**
 * C6 tool-call adapter: one normalised shape for every provider's tool calling.
 *
 * Providers disagree about tool calls: OpenAI-style `tool_calls[].function.arguments` is a **JSON string**,
 * the Responses API returns `function_call` items with `call_id`, and smaller/local models do not support
 * native tool calling at all and emit prose instead. The loop must not care. This module turns all of that
 * into `NormalizedToolCall[]` plus an explicit list of rejections that are safe to hand back to the model.
 *
 * Two rules drive every decision here:
 *
 * 1. **Nothing unparsed is ever executed.** Unparseable or truncated arguments are marked `partial` (the
 *    caller waits for the rest) or rejected; they are never treated as `{}` and never run.
 * 2. **Normalising does not raise trust.** A tool call — especially one parsed out of model prose — is
 *    still *data*. This module only describes the call; executing it remains the job of the runtime, which
 *    must pass the PolicyEngine, RBAC, the feature flags and the approval gate. `trustedAsInstruction` is
 *    a literal `false` so that no caller can read a normalised call as an instruction.
 *
 * A note on what the current engine exposes (verified in `packages/omniroute-adapter`): `ChatResult` has no
 * reasoning field, `stream()` yields plain text chunks only, and the engine sends
 * `parallel_tool_calls: false` for both wire formats. Reasoning passed in separately is carried through
 * untouched (never turned into a tool call); the absence of a wire-level reasoning field is a recorded
 * limitation, not something this module papers over.
 */

import {
  resolveEffectiveToolCallingMode,
  type CodeModelProfile,
  type CodeToolCallingMode,
} from "./code-model-profiles";

export type NormalizedToolCallSource = "native" | "text";

export type ToolCallRejectionCode =
  | "unknown_tool"
  | "invalid_tool_arguments"
  | "partial_tool_call"
  | "malformed_native_tool_call"
  | "invalid_text_tool_call"
  | "validator_not_configured";

export interface ToolSchemaLike {
  name: string;
  inputSchema: Record<string, unknown>;
}

export type KnownTool = ToolSchemaLike | string;

export interface RawNativeToolCall {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown } | null;
  name?: unknown;
  arguments?: unknown;
  tool?: unknown;
}

export interface RawToolCallPayload {
  toolCalls?: readonly RawNativeToolCall[] | null;
  content?: string | null;
  finishReason?: string | null;
  /** Reasoning is passed through for multi-turn context; it never becomes a tool call. */
  reasoning?: string | null;
  reasoningContent?: string | null;
}

export interface NormalizeToolCallsInput {
  payload: RawToolCallPayload;
  profile: Pick<CodeModelProfile, "id" | "toolCallingMode" | "maxParallelToolCalls">;
  /** Explicit override of the profile mode (used by callers that already know the wire format). */
  mode?: CodeToolCallingMode;
  knownTools: readonly KnownTool[];
  /**
   * Canonical JSON-schema validator (`validateArguments` in `code-tool-runtime`). Required for text-mode
   * calls: without it a prose-parsed call is refused rather than executed unvalidated.
   */
  validate?: (schema: Record<string, unknown>, args: unknown, toolName?: string) => Record<string, unknown>;
}

export interface NormalizedToolCall {
  /** Provider call id when the provider supplied one; otherwise a deterministic `text:` id. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** `true` means the arguments were incomplete: the caller MUST wait and MUST NOT execute this call. */
  partial: boolean;
  source: NormalizedToolCallSource;
  /** Raw fragment for diagnostics; never contains a secret because it is the model's own arguments text. */
  rawFragment?: string;
  /** Literal `false`: a normalised tool call is data, never an instruction. */
  trustedAsInstruction: false;
}

export interface RejectedToolCall {
  code: ToolCallRejectionCode;
  message: string;
  name?: string;
  id?: string;
  source: NormalizedToolCallSource;
  rawFragment?: string;
  /** Safe to return to the model as the tool result so it can correct itself. */
  modelFeedback: { error: { code: ToolCallRejectionCode; message: string } };
}

export interface NormalizeToolCallsResult {
  mode: NormalizedToolCallSource;
  calls: NormalizedToolCall[];
  rejected: RejectedToolCall[];
  warnings: string[];
  /** Reasoning carried through untouched (empty when the provider/engine exposed none). */
  reasoning: string[];
}

export class ToolCallAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ToolCallAdapterError";
  }
}

/** Fenced blocks first (```json … ```), then the explicit marker line. Both are the documented protocol. */
export const TEXT_TOOL_CALL_MARKER = "NPATI_TOOL_CALL:";
const FENCED_BLOCK = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
/** The marker takes the rest of its line, so nested arguments need no bracket gymnastics. */
const MARKER_LINE = /^[ \t]*NPATI_TOOL_CALL:[ \t]*(.+?)[ \t]*$/gm;

function truncateFragment(value: string, limit = 512): string {
  const text = typeof value === "string" ? value : "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function resolveKnownTool(
  knownTools: readonly KnownTool[],
  candidateName: string,
): { name: string; schema: Record<string, unknown> } | undefined {
  const wanted = candidateName.trim().toLowerCase();
  // 1. Direct match
  for (const tool of knownTools) {
    const tName = typeof tool === "string" ? tool : tool.name;
    if (tName.trim().toLowerCase() === wanted) {
      return { name: tName, schema: typeof tool === "string" ? {} : tool.inputSchema };
    }
  }
  // 2. Normalized match (strip hex suffixes, npati prefixes, and handle underscore/missing fs)
  let cleaned = wanted
    .replace(/_[0-9a-f]{7,32}$/i, "")
    .replace(/^npati[._]/i, "")
    .replace(/_/g, ".");

  const shorthands: Record<string, string> = {
    "code.write": "code.fs.write",
    "code.edit": "code.fs.edit",
    "code.read": "code.fs.read",
    "code.tree": "code.fs.tree",
    "code.list": "code.fs.list",
    "code.grep": "code.fs.grep",
  };
  const targetShorthand = shorthands[cleaned];
  if (targetShorthand) {
    cleaned = targetShorthand;
  }

  for (const tool of knownTools) {
    const tName = typeof tool === "string" ? tool : tool.name;
    const tNormalized = tName.trim().toLowerCase().replace(/_/g, ".");
    if (tNormalized === cleaned) {
      return { name: tName, schema: typeof tool === "string" ? {} : tool.inputSchema };
    }
  }
  return undefined;
}

function toolSchemaFor(knownTools: readonly KnownTool[], name: string): Record<string, unknown> | undefined {
  return resolveKnownTool(knownTools, name)?.schema;
}

function isKnownTool(knownTools: readonly KnownTool[], name: string): boolean {
  return resolveKnownTool(knownTools, name) !== undefined;
}

/**
 * Is this text an *incomplete* JSON value rather than a wrong one? Only used to choose between "wait for
 * the rest of the stream" and "this is invalid"; both outcomes refuse execution.
 */
export function looksTruncatedJson(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
  }
  if (inString) return true;
  if (depth !== 0) return true;
  return /[,:]\s*$/.test(value);
}

function rejection(
  code: ToolCallRejectionCode,
  message: string,
  source: NormalizedToolCallSource,
  extra: { name?: string; id?: string; rawFragment?: string } = {},
): RejectedToolCall {
  return {
    code,
    message,
    source,
    ...extra,
    modelFeedback: { error: { code, message } },
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Arguments may arrive as a JSON string (OpenAI wire format) or already parsed (some proxies). */
function readNativeArguments(
  raw: unknown,
  name: string,
  id: string,
): { args?: Record<string, unknown>; partial?: boolean; rejection?: RejectedToolCall } {
  if (raw === undefined || raw === null) return { args: {} };
  if (typeof raw === "object") {
    if (Array.isArray(raw)) {
      return {
        rejection: rejection("invalid_tool_arguments", `Tool ${name} arguments must be an object, not an array`, "native", { name, id }),
      };
    }
    return { args: raw as Record<string, unknown> };
  }
  if (typeof raw !== "string") {
    return {
      rejection: rejection("invalid_tool_arguments", `Tool ${name} arguments must be a JSON string or an object`, "native", {
        name,
        id,
        rawFragment: truncateFragment(String(raw)),
      }),
    };
  }
  const text = raw.trim();
  if (!text) return { args: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        rejection: rejection("invalid_tool_arguments", `Tool ${name} arguments must decode to an object`, "native", {
          name,
          id,
          rawFragment: truncateFragment(text),
        }),
      };
    }
    return { args: parsed as Record<string, unknown> };
  } catch {
    if (looksTruncatedJson(text)) return { partial: true };
    return {
      rejection: rejection("invalid_tool_arguments", `Tool ${name} returned invalid JSON arguments`, "native", {
        name,
        id,
        rawFragment: truncateFragment(text),
      }),
    };
  }
}

function buildCall(
  source: NormalizedToolCallSource,
  raw: { id?: string; name: string; args: Record<string, unknown>; partial?: boolean; rawFragment?: string },
): NormalizedToolCall {
  return {
    id: raw.id ?? `text:${raw.name}`,
    name: raw.name,
    arguments: raw.args,
    partial: raw.partial === true,
    source,
    rawFragment: raw.rawFragment,
    trustedAsInstruction: false,
  };
}

/** Fenced/marker payloads may be one object or an array of them. */
function extractTextCandidates(content: string): { candidates: Array<Record<string, unknown>>; unterminated: boolean; malformed: string[] } {
  const candidates: Array<Record<string, unknown>> = [];
  const malformed: string[] = [];

  // Document order matters: the sequence of calls carries the model's intent, so fenced blocks and marker
  // lines are merged by position instead of being processed group by group.
  const entries: Array<{ index: number; text: string }> = [];
  for (const match of content.matchAll(FENCED_BLOCK)) {
    entries.push({ index: match.index ?? 0, text: match[1] ?? "" });
  }
  for (const match of content.matchAll(MARKER_LINE)) {
    entries.push({ index: match.index ?? 0, text: match[1] ?? "" });
  }
  entries.sort((left, right) => left.index - right.index);

  // An odd number of fences means a block was never closed (a split stream): nothing from it is executed.
  let unterminated = content.split("```").length % 2 === 0;

  for (const entry of entries) {
    const text = entry.text.trim();
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item && typeof item === "object" && !Array.isArray(item)) candidates.push(item as Record<string, unknown>);
        else malformed.push(truncateFragment(text));
      }
    } catch {
      if (looksTruncatedJson(text)) unterminated = true;
      else malformed.push(truncateFragment(text));
    }
  }

  return { candidates, unterminated, malformed };
}

function readTextCallName(candidate: Record<string, unknown>): string | undefined {
  const direct = stringField(candidate.tool) ?? stringField(candidate.name);
  if (direct) return direct;
  const fn = candidate.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    return stringField((fn as Record<string, unknown>).name);
  }
  return undefined;
}

function readTextCallArguments(candidate: Record<string, unknown>): unknown {
  if (candidate.arguments !== undefined) return candidate.arguments;
  if (candidate.args !== undefined) return candidate.args;
  const fn = candidate.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    return (fn as Record<string, unknown>).arguments;
  }
  return undefined;
}

/**
 * Normalises one assistant turn's tool calls.
 *
 * Rejections are **not** thrown: they are returned so the caller can hand `modelFeedback` back to the model
 * as the tool result (the model gets a chance to correct itself) while nothing is executed.
 */
export function normalizeToolCalls(input: NormalizeToolCallsInput): NormalizeToolCallsResult {
  const warnings: string[] = [];
  const calls: NormalizedToolCall[] = [];
  const rejected: RejectedToolCall[] = [];
  const payload = input.payload ?? {};
  const nativeRaw = (payload.toolCalls ?? []).filter((call) => !!call);
  const sawNativeToolCalls = nativeRaw.length > 0;

  const reasoning: string[] = [];
  for (const value of [payload.reasoning, payload.reasoningContent]) {
    if (typeof value === "string" && value.trim()) reasoning.push(value);
  }

  const requestedMode: CodeToolCallingMode = input.mode ?? input.profile.toolCallingMode;
  const mode: NormalizedToolCallSource = resolveEffectiveToolCallingMode(
    { toolCallingMode: requestedMode },
    { sawNativeToolCalls },
  );
  if (requestedMode === "auto") {
    warnings.push(`tool_calling_mode_auto_resolved:${mode}`);
  }
  if (requestedMode === "native" && !sawNativeToolCalls) {
    // A profile may claim native support and still receive none; the text protocol is then the only way to
    // recover the model's intent, and saying so is better than silently dropping the turn.
    const content = typeof payload.content === "string" ? payload.content : "";
    if (content.trim()) warnings.push("native_mode_but_no_native_tool_calls");
  }

  if (mode === "native") {
    for (const raw of nativeRaw) {
      const fn = raw.function && typeof raw.function === "object" && !Array.isArray(raw.function) ? raw.function : undefined;
      const rawName = stringField(fn?.name) ?? stringField(raw.name) ?? stringField(raw.tool);
      const id = stringField(raw.id);
      if (!rawName) {
        rejected.push(
          rejection("malformed_native_tool_call", "Tool call has no function name and was not executed", "native", {
            id,
            rawFragment: truncateFragment(JSON.stringify(raw)),
          }),
        );
        continue;
      }
      // A provider can leak DSML parameter markup into the native function name.
      // Do not infer missing arguments or replay the batch as a new task.
      /**
       * Runtime MCP capabilities are addressed by their canonical id (`mcp:<connectionId>/<toolName>`, see
       * `mcpToolId`), so `:` and `/` are legitimate name characters for a **known** tool. They are allowed here
       * only because the very next step still resolves the name against `knownTools`: an id nobody published is
       * `unknown_tool`, never executed. Markup characters (`<`, `>`, whitespace, quotes) remain refused.
       */
      if (!/^[a-zA-Z0-9_.:/-]{1,128}$/.test(rawName)) {
        const prefix = rawName.match(/^[a-zA-Z0-9_.-]+/)?.[0];
        const known = prefix ? resolveKnownTool(input.knownTools, prefix) : undefined;
        rejected.push(rejection("malformed_native_tool_call",
          "Provider returned a malformed function name. This call was not executed. Retry only this call with the registered tool name and complete JSON arguments. Preserve successful tool results and saved edits; do not restart the task.",
          "native", { id, name: known?.name ?? "invalid_tool_call", rawFragment: truncateFragment(JSON.stringify(raw)) }));
        continue;
      }
      const resolved = resolveKnownTool(input.knownTools, rawName);
      if (!resolved) {
        rejected.push(
          rejection("unknown_tool", `Unknown tool: ${rawName}`, "native", {
            name: rawName,
            id,
            rawFragment: truncateFragment(JSON.stringify(raw)),
          }),
        );
        continue;
      }
      const name = resolved.name;
      const read = readNativeArguments(fn?.arguments ?? raw.arguments, name, id ?? name);
      if (read.rejection) {
        rejected.push(read.rejection);
        continue;
      }
      if (read.partial) {
        calls.push(
          buildCall("native", {
            id,
            name,
            args: {},
            partial: true,
            rawFragment: truncateFragment(typeof (fn?.arguments ?? raw.arguments) === "string" ? String(fn?.arguments ?? raw.arguments) : ""),
          }),
        );
        rejected.push(
          rejection("partial_tool_call", `Tool ${name} arguments are incomplete and were not executed`, "native", {
            name,
            id,
            rawFragment: truncateFragment(typeof (fn?.arguments ?? raw.arguments) === "string" ? String(fn?.arguments ?? raw.arguments) : ""),
          }),
        );
        warnings.push(`partial_arguments:${name}`);
        continue;
      }
      let args = read.args ?? {};
      if (input.validate) {
        try {
          args = input.validate(toolSchemaFor(input.knownTools, name) ?? {}, args, name);
        } catch (error) {
          rejected.push(
            rejection("invalid_tool_arguments", (error as Error).message, "native", {
              name,
              id,
              rawFragment: truncateFragment(JSON.stringify(args)),
            }),
          );
          continue;
        }
      }
      calls.push(buildCall("native", { id, name, args }));
    }
  } else {
    const content = typeof payload.content === "string" ? payload.content : "";
    const { candidates, unterminated, malformed } = extractTextCandidates(content);
    if (unterminated) {
      calls.push(buildCall("text", { name: "unknown", args: {}, partial: true, rawFragment: truncateFragment(content) }));
      rejected.push(
        rejection("partial_tool_call", "Text tool call block is incomplete and was not executed", "text", {
          rawFragment: truncateFragment(content),
        }),
      );
      warnings.push("partial_text_tool_call_block");
    }
    for (const fragment of malformed) {
      rejected.push(
        rejection("invalid_text_tool_call", "Text tool call is not valid JSON and was not executed", "text", {
          rawFragment: fragment,
        }),
      );
    }
    for (const candidate of candidates) {
      const rawName = readTextCallName(candidate);
      if (!rawName) {
        rejected.push(
          rejection("invalid_text_tool_call", "Text tool call has no tool name and was not executed", "text", {
            rawFragment: truncateFragment(JSON.stringify(candidate)),
          }),
        );
        continue;
      }
      const resolved = resolveKnownTool(input.knownTools, rawName);
      if (!resolved) {
        rejected.push(
          rejection("unknown_tool", `Unknown tool: ${rawName}`, "text", {
            name: rawName,
            rawFragment: truncateFragment(JSON.stringify(candidate)),
          }),
        );
        continue;
      }
      const name = resolved.name;
      if (!input.validate) {
        // Text tool calls come from model prose, so schema validation is mandatory: without the canonical
        // validator nothing is executed rather than executed unchecked.
        rejected.push(
          rejection("validator_not_configured", `Tool ${name} was not executed because no schema validator is configured for text tool calls`, "text", {
            name,
            rawFragment: truncateFragment(JSON.stringify(candidate)),
          }),
        );
        continue;
      }
      const rawArgs = readTextCallArguments(candidate);
      let args: Record<string, unknown>;
      if (rawArgs === undefined || rawArgs === null) {
        args = {};
      } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        args = rawArgs as Record<string, unknown>;
      } else if (typeof rawArgs === "string") {
        const text = rawArgs.trim();
        if (!text) {
          args = {};
        } else {
          try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              rejected.push(
                rejection("invalid_text_tool_call", `Tool ${name} arguments must decode to an object`, "text", {
                  name,
                  rawFragment: truncateFragment(JSON.stringify(candidate)),
                }),
              );
              continue;
            }
            args = parsed as Record<string, unknown>;
          } catch {
            rejected.push(
              rejection("invalid_text_tool_call", `Tool ${name} arguments are not valid JSON`, "text", {
                name,
                rawFragment: truncateFragment(JSON.stringify(candidate)),
              }),
            );
            continue;
          }
        }
      } else {
        rejected.push(
          rejection("invalid_text_tool_call", `Tool ${name} arguments must be an object`, "text", {
            name,
            rawFragment: truncateFragment(JSON.stringify(candidate)),
          }),
        );
        continue;
      }
      try {
        args = input.validate(toolSchemaFor(input.knownTools, name) ?? {}, args, name);
      } catch (error) {
        rejected.push(
          rejection("invalid_tool_arguments", (error as Error).message, "text", {
            name,
            rawFragment: truncateFragment(JSON.stringify(candidate)),
          }),
        );
        continue;
      }
      calls.push(buildCall("text", { name, args }));
    }
    if (!calls.length && !rejected.length) warnings.push("no_text_tool_calls");
  }

  /**
   * Step 1: a response that stopped on the output limit may have been cut inside the last tool call.
   *
   * Some providers report `finish_reason: "length"` for that; when they do, no call from that response is
   * executed, because a syntactically valid object can still carry a half-written file body. The provider that
   * motivated this guard (DeepSeek Flash with reasoning disabled) instead reports `tool_calls` and simply stops
   * mid-string, so the structural JSON check above remains the primary detector and this is the second one.
   */
  if (String(payload.finishReason ?? "").toLowerCase() === "length" && calls.length) {
    let marked = 0;
    for (const call of calls) {
      if (call.partial) continue;
      call.partial = true;
      marked += 1;
      rejected.push(
        rejection(
          "partial_tool_call",
          `Tool ${call.name} arguments may be incomplete: the model stopped at the output limit, so nothing was executed`,
          call.source,
          { name: call.name, id: call.id, rawFragment: call.rawFragment },
        ),
      );
    }
    if (marked) warnings.push("output_limit_tool_calls");
  }

  // Deterministic ids must stay unique even when the model emits the same tool twice in one turn.
  const seen = new Map<string, number>();
  for (const call of calls) {
    const count = (seen.get(call.id) ?? 0) + 1;
    seen.set(call.id, count);
    if (count > 1) call.id = `${call.id}#${count}`;
  }

  const parallelLimit = Math.max(1, Math.floor(input.profile.maxParallelToolCalls || 1));
  if (calls.length > parallelLimit) {
    warnings.push(`parallel_tool_calls_exceeded:${calls.length}>${parallelLimit}`);
  }
  if (rejected.some((entry) => entry.code === "unknown_tool")) {
    warnings.push("unknown_tool_call_detected");
  }

  return { mode, calls, rejected, warnings, reasoning };
}

/**
 * The only calls a caller may execute. Partial calls are excluded by construction so a truncated stream
 * cannot be run by accident.
 */
export function executableToolCalls(result: NormalizeToolCallsResult): NormalizedToolCall[] {
  return result.calls.filter((call) => !call.partial);
}

/**
 * Splits calls into deterministic waves of at most `maxParallelToolCalls`, preserving the model's order.
 * The engine already sends `parallel_tool_calls: false`, so this is the safety net for providers that
 * return several calls anyway.
 */
export function planToolCallWaves(
  calls: readonly NormalizedToolCall[],
  maxParallelToolCalls: number,
): NormalizedToolCall[][] {
  const executable = calls.filter((call) => !call.partial);
  const limit = Math.max(1, Math.floor(maxParallelToolCalls || 1));
  const waves: NormalizedToolCall[][] = [];
  for (let index = 0; index < executable.length; index += limit) {
    waves.push(executable.slice(index, index + limit));
  }
  return waves;
}

/** Shape to return to the model as a `tool` message for a rejected call. */
export function toolCallFeedback(rejectionResult: RejectedToolCall): { error: { code: string; message: string } } {
  return rejectionResult.modelFeedback;
}
