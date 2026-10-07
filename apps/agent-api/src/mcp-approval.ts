import { createHash } from "node:crypto";

/**
 * C13 (owner blocker 1): **one** definition of what a runtime MCP tool call is approved for.
 *
 * The owner's requirement is a normal, one-shot human approval: `approval_required` → the run pauses →
 * a person approves **this exact call** → the approval is consumed **once** → the same run continues → the
 * tool really executes. Two properties make that work, and both live in this module rather than at the call
 * sites:
 *
 *  1. **One payload builder, used by the requesting side and the consuming side.** The C11 defect is the
 *     precedent and the reason this file exists: the request side hashed `buildApprovalPayload({…extra:{git}})`
 *     while the boundary hashed `gitApprovalPayload({…})`, so the two objects differed, the two
 *     `payload_hash`es differed, `CompanyApprovalsRepository.consumeApproved` matched no row, and an approval
 *     that a human had granted could **never** be redeemed. Here the engine builds the payload with
 *     `mcpApprovalPayloadFor(request)` from the policy request it is about to evaluate, and the run path builds
 *     it with the same function from the same request object — so "the same call" cannot mean two different
 *     byte strings. (The store hashes the payload it stores, so the two sides are compared by hash in the
 *     suite, not by "the objects look alike in the source".)
 *  2. **The binding is the call, not the tool.** `providerId`, `connectionId`, `toolName`, `schemaHash` and
 *     `argsHash` are all part of the material, so an approval granted for one tool, one schema or one argument
 *     set can never be spent on another — a change to any of them produces a different payload, therefore a
 *     different hash, therefore `APPROVAL_INVALID`. The raw arguments are deliberately **not** in the material
 *     (only their hash) and never leave the process: the durable approval row stores a hash, exactly like it
 *     already does for every other tool.
 *
 * This module is a leaf on purpose (only `node:crypto`): the policy engine, the MCP run path and the approval
 * release wiring all import it, and a leaf cannot create an import cycle between them. `providerId` is passed
 * in rather than imported so the module stays dependency-free — every caller already has the runtime identity.
 */

/**
 * The marker that makes an approval row recognisable as a runtime MCP one. It is stored **inside** the payload
 * (therefore inside the hash), so a row cannot be re-labelled afterwards without invalidating its own hash.
 */
export const MCP_APPROVAL_KIND = "mcp_runtime_tool_call";

/**
 * How long a paused run waits for a human decision. A pause can outlive a browser tab and a process restart, so
 * the window is the durable approval store's own maximum (24 hours, clamped by it) rather than the 15-minute
 * default that was written for an interactive, blocking wait.
 */
export const MCP_APPROVAL_TTL_MS = 86_400_000;

/** The runtime identity of the call, exactly as the capability lookup and the manifest carry it. */
export interface McpApprovalRuntimeSubject {
  /** `mcp-runtime` — the runtime provider the tool was discovered from. */
  providerId: string;
  /** The configured Integration the call will be dialled for. */
  connectionId: string;
  /** The tool name inside that connection. */
  toolName: string;
  /** The canonical hash of the declared input schema at the time of the call. */
  schemaHash: string;
  /** The canonical hash of the **normalised arguments** of this call. */
  argsHash: string;
}

/**
 * Everything the material is built from. A `PolicyRequest` satisfies this shape structurally, which is what
 * lets the engine pass its own request and the run path pass the very same object.
 */
export interface McpApprovalSubject {
  companyId: string;
  projectId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  toolCallId?: string | null;
  /** The runtime capability id: `mcp:<connectionId>/<toolName>`. */
  tool: string;
  runtimeMcp?: McpApprovalRuntimeSubject | null;
}

/** Stable JSON: keys sorted, `undefined` folded to `null`, so identical values hash identically. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * The hash of one call's **arguments**. Normalised through canonical JSON, so key order and `undefined`
 * members cannot make two identical calls look different — and the value itself never leaves this function.
 */
export function mcpApprovalArgsHash(args: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(args ?? {}), "utf8").digest("hex")}`;
}

/**
 * The canonical approval material of one runtime MCP call, or `null` when the subject is not a runtime MCP
 * call at all (no `runtimeMcp`): an ordinary static tool keeps its existing payload and hash untouched.
 *
 * Every field is written unconditionally (absent ids become `null`) so the two sides cannot differ by a key
 * that one of them happened to omit.
 */
export function mcpApprovalPayloadFor(subject: McpApprovalSubject): Record<string, unknown> | null {
  const runtime = subject.runtimeMcp;
  if (!runtime) return null;
  return {
    kind: MCP_APPROVAL_KIND,
    providerId: runtime.providerId,
    connectionId: runtime.connectionId,
    toolName: runtime.toolName,
    tool: subject.tool,
    schemaHash: runtime.schemaHash,
    argsHash: runtime.argsHash,
    companyId: subject.companyId,
    projectId: subject.projectId ?? null,
    sessionId: subject.sessionId ?? null,
    runId: subject.runId ?? null,
    agentId: subject.agentId ?? null,
    toolCallId: subject.toolCallId ?? null,
    // The one-shot scope of this approval is part of the material, so a record cannot be presented later as
    // something wider than it was granted for.
    approvalScope: "once",
  };
}

/** True when a stored approval payload is a runtime MCP one, decided by the marker inside the hash. */
export function isMcpApprovalPayload(payload: unknown): payload is Record<string, unknown> {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload)
    && (payload as Record<string, unknown>).kind === MCP_APPROVAL_KIND;
}

/** The run a stored runtime MCP approval belongs to, or `null` when the payload does not name one. */
export function mcpApprovalRunIdOf(payload: unknown): string | null {
  if (!isMcpApprovalPayload(payload)) return null;
  const runId = (payload as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

/**
 * The two existing durable state transitions a paused run can be released with. Structural: this is the C9
 * `CodeRunStateLog` surface, not a second state machine.
 */
export interface McpApprovalPauseRunState {
  /** C9: the human decided, so the pause is over (the run becomes `interrupted`, continuable). */
  resumeAfterAnswer?(input: { companyId: string; runId: string; questionId: string; answeredBy: string }): Promise<unknown>;
  /** C9: the wait ended without a decision (`approval_timeout`, `approval_cancelled`). */
  markInterrupted?(input: { companyId: string; runId: string; reason: string; owner?: string }): Promise<unknown>;
}

export type McpApprovalReleaseReason = "approved" | "rejected" | "expired" | "cancelled";

/**
 * Releases a run that is paused on a runtime MCP approval, using the state transitions C9 already owns.
 *
 * Why this is not a second mechanism: nothing new is invented here. A decided approval is exactly "the answer
 * arrived", which is `resumeAfterAnswer` (the same call `CodeAskUserService.answer` makes when a user answers a
 * question), and a wait that ended without a decision is exactly the timeout transition the question reaper
 * uses (`markInterrupted` with `ask_user_timeout`). The pause itself was written by the runner through
 * `markWaitingForUser`, so a paused run is released by the very transitions that pause already understands.
 */
export async function releaseMcpApprovalPause(
  runState: McpApprovalPauseRunState | undefined,
  input: { companyId: string; runId: string; approvalId: string; reason: McpApprovalReleaseReason; answeredBy?: string },
): Promise<"released" | "unsupported"> {
  if (!runState) return "unsupported";
  if (input.reason === "approved" || input.reason === "rejected") {
    if (!runState.resumeAfterAnswer) return "unsupported";
    await runState.resumeAfterAnswer({
      companyId: input.companyId,
      runId: input.runId,
      // The pause recorded the approval request id in the question slot (see the runner): one pause state, one
      // thing a human has to decide.
      questionId: input.approvalId,
      answeredBy: input.answeredBy ?? "system",
    });
    return "released";
  }
  if (!runState.markInterrupted) return "unsupported";
  await runState.markInterrupted({
    companyId: input.companyId,
    runId: input.runId,
    reason: input.reason === "expired" ? "approval_timeout" : "approval_cancelled",
  });
  return "released";
}
