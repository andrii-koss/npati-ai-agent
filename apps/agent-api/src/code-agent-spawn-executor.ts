import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import { normalizeWorkspacePath } from "./code-tools-path";
import { SubagentToolPolicyGuard } from "./subagent-tool-policy";
import {
  resolveEffectiveToolSet,
} from "./code-subagent-limits";
import {
  CODE_SUBAGENT_TYPES,
  resolveCodeSubagentType,
  type CodeSubagentType,
  type ResolvedCodeSubagentType,
} from "./code-subagent-types";
import {
  buildCodeSubagentHandoffDigest,
  CodeSubagentHandoffError,
  emptyCodeSubagentHandoffDigest,
  type CodeSubagentHandoffDigest,
} from "./code-subagent-handoff";
import type { CodeModelProfile } from "./code-model-profiles";
import type { CodeActivityEventIdentity } from "./code-run-activity-sink";

/**
 * C12: the `code.agent.spawn` executor — the single place a parent hands work to a coding sub-agent.
 *
 * It is an **adapter**, in the same sense the eleven `code.git.*` executors are adapters over
 * `ProjectGitService`: it contains no loop, no planner and no scheduler. The child run is produced by the
 * existing `CodingAgentRunner` (through the narrow `CodeSubagentChildRunner` port), the tool set is produced
 * by the existing `SubagentToolPolicyGuard`, the model profile by the existing `code-model-profiles.ts`, the
 * claim "how many children may be in flight" by `clampCodeSubagentParallelism` in the canonical limits module,
 * and the record of the delegation by the existing C6b Activity sink. A second engine here would be exactly
 * what `docs/coding-agent/00-audit.md:476-477` forbids.
 *
 * The four things this file is responsible for, in the order they happen:
 *
 *  1. **Refuse, loudly, before anything is started.** An unknown type, a `summaryOnly: false`, an unusable
 *     path, a tool outside the published registry and a request for the delegation tool itself are all
 *     structured refusals with their own codes — not silent narrowing — because a model that asked for
 *     something it may not have must be told which of its assumptions was wrong.
 *  2. **Compute the intersection once.** `SubagentToolPolicyGuard.evaluateSubagentTools` receives the parent's
 *     grant (`*` for a main run, which is why a wildcard is resolved against the published registry and grants
 *     nothing without it), the child type's profile and the requested list. Only the resulting `permittedTools`
 *     are handed to the child, inside `CodingAgentRunInput.subagentScope.allowedTools` — the one interface the
 *     runner already reads. The requested list is never the grant.
 *  3. **Run the child through the existing runner**, with a **deterministic run id** derived from
 *     `(parentRunId, toolCallId)`. That is what makes a repeated call the *same* delegation rather than a
 *     second child: the run-state log is already idempotent by run id (C10), so a retry after a crash lands on
 *     the run it already started instead of doubling the spend.
 *  4. **Return a digest, never a transcript.** The child's answer is parsed for named metadata fields and the
 *     parent receives findings, paths, symbols and counts. A child that fails produces a **successful tool
 *     result** whose `status` is `failed`: the tool call did what it was asked to do — it delegated and
 *     reported — so the parent's loop continues instead of being taken down by a sub-agent's error.
 */

/** One level of the tree, named once: the tool that grows it. */
export { CODE_AGENT_SPAWN_TOOL } from "./code-subagent-limits";

/** The Activity kind a delegation is recorded under; the tree, not a sixth event family. */
const DELEGATION_ACTIVITY_KIND = "run_activity" as const;

/** The closest existing Activity event family: a delegation is a run lifecycle fact of the parent. */
export interface CodeSubagentActivityRecorder {
  record(identity: CodeActivityEventIdentity, payload: Record<string, unknown>): Promise<{ persisted: boolean; id?: string; errorCode?: string; errorMessage?: string }>;
}

/** What the child runner is told. Everything here is a server fact; nothing comes from a model argument. */
export interface CodeSubagentChildRunRequest {
  ctx: CodeToolExecutionContext["ctx"];
  companyId: string;
  projectId: string;
  /** The parent's session. A delegated run is a run of the same session, which is what shares the budget. */
  sessionId: string;
  /** The run that delegated: the fact that makes the child a child and forbids it from delegating further. */
  parentRunId: string;
  /** The parent's `code.agent.spawn` tool call: the idempotency key of this delegation. */
  toolCallId: string;
  /** Deterministic child run id, so a repeated call resumes the same delegation instead of starting another. */
  runId: string;
  agentType: CodeSubagentType;
  capabilityProfile: string;
  task: string;
  /** Validated workspace-relative scope. Empty means "no declared scope". */
  paths: readonly string[];
  /** Model the child should use, or `null` for the deployment's own default for the type. */
  model: string | null;
  maxTurns: number;
  readOnly: boolean;
  summaryOnly: boolean;
  /**
   * The intersection the delegation recorded. This is what the caller puts into
   * `CodingAgentRunInput.subagentScope.allowedTools` — and a child run without it is refused by the runner,
   * not handed the parent's whole surface.
   */
  allowedTools: readonly string[];
  /** The ExecutionSnapshot of the parent run, so the child's own events can name it. */
  snapshotId?: string | null;
  /** Advisory tool-calling mode the type resolved (native/text), for the child's provider layer. */
  toolCallingMode: string;
}

/** What the child runner reports back. Deliberately small: the digest is built from named fields only. */
export interface CodeSubagentChildOutcome {
  runId?: string | null;
  status: "completed" | "failed";
  /** The child's own refusal code, carried through so the parent sees why it failed. */
  errorCode?: string | null;
  /** Bounded, content-free explanation of `errorCode`. */
  errorMessage?: string | null;
  /** The child's answer. Parsed for metadata; never forwarded verbatim. */
  answer?: string | null;
  /** Paths the child changed, from its own run summary. Validated as paths by the digest. */
  filesChanged?: readonly string[];
  toolCalls?: number;
  turns?: number;
}

/** The child runner. Implemented over the existing `CodingAgentRunner`; a test supplies a small fake. */
export interface CodeSubagentChildRunner {
  run(request: CodeSubagentChildRunRequest): Promise<CodeSubagentChildOutcome>;
}

export interface CodeAgentSpawnExecutorOptions {
  /**
   * The child runner. Absent means the tool fails closed with `tool_not_configured` rather than appearing to
   * delegate — a published tool with no wiring is the `runCtags` defect class.
   *
   * A getter, not a value, because the composition builds the executors before the runner: the same
   * late-binding idiom `createCodeRunEnvironmentHolder` uses, so `code.agent.spawn` cannot capture a runner
   * that does not exist yet.
   */
  childRunner?: () => CodeSubagentChildRunner | undefined;
  /**
   * The deployment's canonical tool universe — `CodeToolRuntime.listTools()`, i.e. the **published** registry.
   * It is the only thing a parent's `*` grant may expand to; without it the wildcard grants nothing and the
   * delegation is refused with `subagent_parent_scope_unresolved` instead of inheriting everything.
   */
  canonicalTools?: () => readonly string[];
  /** Records the delegation as a nested Activity event. Absent means no event is written (never a crash). */
  activity?: CodeSubagentActivityRecorder;
  /** The model-profile registry the runner resolves profiles from. */
  modelProfiles?: {
    profiles?: readonly CodeModelProfile[];
    overrides?: readonly CodeModelProfile[];
    enabledProfileIds?: readonly string[];
  };
  env?: NodeJS.ProcessEnv;
  guard?: SubagentToolPolicyGuard;
  now?: () => Date;
}

/** The parent's grant for a main run. It is a wildcard, and the guard may resolve it **only** into canonical names. */
const ROOT_RUN_TOOL_GRANT: readonly string[] = Object.freeze(["*"]);

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CodeToolError("invalid_arguments", `Missing required argument: ${field}`, 400, "validate_arguments", false, "code.agent.spawn");
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new CodeToolError("invalid_arguments", `Argument ${field} exceeds the maximum length`, 400, "validate_arguments", false, "code.agent.spawn");
  }
  return trimmed;
}

/**
 * The JSON-schema validator in the runtime enforces `items` types, `enum`, `minimum`/`maximum` and string
 * bounds, but **not** `maxItems` (it is a minimal validator, deliberately). The two list bounds are therefore
 * enforced here, where they can also produce a code the model can act on.
 */
function requireBoundedList(value: unknown, field: string, maxItems: number, tool: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CodeToolError("invalid_arguments", `Argument ${field} must be an array`, 400, "validate_arguments", false, tool);
  }
  if (value.length > maxItems) {
    throw new CodeToolError(
      "invalid_arguments",
      `Argument ${field} carries ${value.length} entries; at most ${maxItems} are accepted`,
      400, "validate_arguments", false, tool,
    );
  }
  return value;
}

/** A child scope path: the canonical validator, mapped onto the delegation's own refusal code. */
export function resolveCodeSubagentPaths(value: unknown): string[] {
  const entries = requireBoundedList(value, "paths", 20, "code.agent.spawn");
  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new CodeToolError("subagent_path_outside_scope", "A sub-agent scope path must be a string", 400, "validate_arguments", false, "code.agent.spawn");
    }
    try {
      const normalized = normalizeWorkspacePath(entry, { tool: "code.agent.spawn", allowEmpty: false });
      if (!paths.includes(normalized)) paths.push(normalized);
    } catch (error) {
      throw new CodeToolError(
        "subagent_path_outside_scope",
        `Sub-agent scope path ${JSON.stringify(entry).slice(0, 120)} is not a workspace-relative path: ${error instanceof Error ? error.message : "invalid path"}`,
        400, "validate_arguments", false, "code.agent.spawn",
      );
    }
  }
  return paths;
}

/**
 * The deterministic child run id. Two properties matter:
 *  - **stable** for one `(parentRunId, toolCallId)`, so a retried call resumes the delegation it started;
 *  - **distinct** from the parent's, so the run-state log, the replay bundle and the budget see a real second
 *    run rather than a second opinion about the first.
 */
export function codeSubagentRunId(parentRunId: string, toolCallId: string): string {
  const material = `${parentRunId}\u0000${toolCallId}`;
  // A local, dependency-free digest: FNV-1a is enough for an identifier and needs no crypto import. It is not
  // a security boundary — the run id is opaque and the store is authoritative — so collisions are handled by
  // the store's own idempotency-by-run-id, not by the width of this hash.
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index++) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const second = (hash ^ material.length) >>> 0;
  return `sub-${hash.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export interface CodeSubagentSpawnOutcome {
  agentType: CodeSubagentType;
  status: "completed" | "failed";
  runId: string | null;
  errorCode: string | null;
  capabilityProfile: string;
  limits: { maxTurns: number; maxParallelism: number };
  tools: string[];
  handoff: CodeSubagentHandoffDigest;
  truncated: boolean;
  /** Metadata for the Activity event and for tests; never part of the tool result envelope's `data`. */
  resolution: ResolvedCodeSubagentType;
  allowedTools: string[];
  deniedTools: Array<{ tool: string; reason: string }>;
}

/**
 * Counts the children currently in flight **per parent run**. A live map, not a durable counter: the ceiling it
 * enforces is about one node's capacity right now, and a durable number would keep refusing work after a
 * restart had freed every slot.
 */
export class CodeSubagentInFlightTracker {
  private readonly inFlight = new Map<string, number>();

  enter(parentRunId: string): void {
    this.inFlight.set(parentRunId, (this.inFlight.get(parentRunId) ?? 0) + 1);
  }

  leave(parentRunId: string): void {
    const current = (this.inFlight.get(parentRunId) ?? 0) - 1;
    if (current > 0) this.inFlight.set(parentRunId, current);
    else this.inFlight.delete(parentRunId);
  }

  count(parentRunId: string): number {
    return this.inFlight.get(parentRunId) ?? 0;
  }
}

/**
 * The delegation core, independent of the tool envelope so a test can drive it directly. Throws
 * `CodeToolError` for the refusals; a **child** failure is not a refusal and comes back as `status: "failed"`.
 */
export async function spawnCodeSubagent(
  input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId: string;
    parentRunId: string;
    toolCallId: string;
    snapshotId?: string | null;
    args: Record<string, unknown>;
  },
  options: CodeAgentSpawnExecutorOptions = {},
  tracker: CodeSubagentInFlightTracker = new CodeSubagentInFlightTracker(),
): Promise<CodeSubagentSpawnOutcome> {
  const tool = "code.agent.spawn";
  const args = input.args;

  // (1) The child's result is a digest by construction. An explicit `false` is refused rather than ignored:
  // the model asked for something the tool cannot do, and silence would teach it the wrong lesson.
  if (args.summaryOnly === false) {
    throw new CodeToolError(
      "subagent_summary_required",
      `${tool} always answers with a metadata-only handoff digest: a sub-agent's transcript, file bodies and tool output never return to this conversation`,
      400, "validate_arguments", false, tool,
    );
  }

  const agentType = requireString(args.agentType, "agentType", 32);
  const task = requireString(args.task, "task", 8000);

  /**
   * (2) The port, before anything is resolved.
   *
   * The order is the one `canonicalGitExecutors` and `canonicalPlanExecutors` already use: a tool with no wiring
   * fails closed with `tool_not_configured` before it evaluates a single argument, so a deployment that never
   * configured a sub-agent runner is told exactly that instead of being handed a policy refusal it cannot act on.
   */
  const childRunner = options.childRunner?.();
  if (!childRunner) {
    throw new CodeToolError("tool_not_configured", `Tool ${tool} has no sub-agent runner configured`, 503, "configure", false, tool);
  }

  const paths = resolveCodeSubagentPaths(args.paths);
  const requested = requireBoundedList(args.tools, "tools", 64, tool);

  const resolution = resolveCodeSubagentType({
    type: agentType,
    model: args.model,
    turnLimit: args.turnLimit,
    ...(options.modelProfiles?.profiles ? { profiles: options.modelProfiles.profiles } : {}),
    ...(options.modelProfiles?.overrides ? { overrides: options.modelProfiles.overrides } : {}),
    ...(options.modelProfiles?.enabledProfileIds ? { enabledProfileIds: options.modelProfiles.enabledProfileIds } : {}),
    ...(options.env ? { env: options.env } : {}),
  });

  // (2) The one capability scope of this delegation. The universe is the **published** registry; a root run's
  // grant is a wildcard, and a wildcard resolves only into those names — with no universe it grants nothing
  // and the delegation is refused, which is the closed escalation hole this call site must keep closed.
  const canonicalTools = options.canonicalTools?.() ?? [];
  if (!canonicalTools.length) {
    throw new CodeToolError(
      "subagent_parent_scope_unresolved",
      `${tool} cannot resolve this run's tool grant: the published tool registry is empty, so a wildcard grant expands to nothing rather than to everything`,
      403, "policy", false, tool,
    );
  }

  // The model's request is resolved against the registry first, so an unpublished name is a refusal the model
  // can act on and a wildcard can never be a universal key. It is then handed to the guard as the *delegation
  // record* — a record is intersected, never granted.
  const rawRequested = requested.map((entry) => String(entry).trim()).filter(Boolean);
  // Naming the delegation tool is an escalation attempt and is refused. A **wildcard** that happens to expand
  // to it is a different matter: `*` means "the tools you may use", and the delegation tool is not one of them,
  // so the expansion drops it and the recorded scope is self-consistent with depth 1.
  if (rawRequested.some((name) => name.toLowerCase() === tool)) {
    throw new CodeToolError(
      "subagent_tool_not_delegable",
      `${tool} cannot be delegated: depth 1 means a sub-agent works, it does not delegate`,
      403, "policy", false, tool,
    );
  }
  const resolvedRequest = resolveEffectiveToolSet(rawRequested, canonicalTools);
  if (resolvedRequest.unknown.length) {
    throw new CodeToolError(
      "subagent_tool_not_published",
      `${tool} was asked for tools this deployment does not publish: ${resolvedRequest.unknown.slice(0, 10).join(", ")}`,
      400, "validate_arguments", false, tool,
    );
  }
  // A child is never offered the delegation tool, so it is removed from the record even when the parent's own
  // wildcard expansion put it there. The removal is belt-and-braces on top of the structural refusal in
  // `resolveCodeRunCapabilityScope`, and it is what makes the recorded scope self-consistent.
  const delegationRecord = (resolvedRequest.tools.length ? resolvedRequest.tools : [...resolution.baseTools])
    .filter((name) => name !== tool);

  const guard = options.guard ?? new SubagentToolPolicyGuard();
  const evaluation = guard.evaluateSubagentTools({
    parentAgentId: input.parentRunId,
    parentAllowedTools: [...ROOT_RUN_TOOL_GRANT],
    childAgentId: `${input.parentRunId}:${resolution.type}`,
    childBaseTools: [...resolution.baseTools],
    delegationAllowedTools: delegationRecord,
    canonicalTools,
  });
  if (evaluation.wildcardUnresolved) {
    throw new CodeToolError(
      "subagent_parent_scope_unresolved",
      `${tool} cannot resolve this run's wildcard tool grant against the published registry`,
      403, "policy", false, tool,
    );
  }
  if (!evaluation.permittedTools.length) {
    throw new CodeToolError(
      "subagent_capability_scope_empty",
      `${tool} resolved an empty capability scope for a "${resolution.type}" sub-agent: the requested tools, the type's profile and this run's grant do not intersect`,
      403, "policy", false, tool,
    );
  }
  const allowedTools = [...evaluation.permittedTools];

  // (3) The fan-out ceiling, clamped by the canonical limits module. Configuration may lower it, never raise it
  // past 4, and the tracker is per parent so two parents do not share one budget of children.
  const parallel = resolution.maxParallelism;
  const inFlight = tracker.count(input.parentRunId);
  if (inFlight >= parallel) {
    throw new CodeToolError(
      "subagent_parallelism_exceeded",
      `${tool} already has ${inFlight} sub-agent(s) in flight for this run; the configured ceiling is ${parallel}`,
      429, "policy", true, tool,
    );
  }

  const runId = codeSubagentRunId(input.parentRunId, input.toolCallId);
  const request: CodeSubagentChildRunRequest = {
    ctx: input.ctx,
    companyId: input.companyId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    parentRunId: input.parentRunId,
    toolCallId: input.toolCallId,
    runId,
    agentType: resolution.type,
    capabilityProfile: resolution.capabilityProfile,
    task,
    paths,
    model: resolution.model,
    maxTurns: resolution.maxTurns,
    readOnly: resolution.readOnly,
    summaryOnly: resolution.summaryOnly,
    allowedTools,
    snapshotId: input.snapshotId ?? null,
    toolCallingMode: resolution.toolCallingMode,
  };

  const now = options.now ?? (() => new Date());
  tracker.enter(input.parentRunId);
  let outcome: CodeSubagentChildOutcome;
  try {
    outcome = await childRunner.run(request);
  } catch (error) {
    // A child that throws is a child that failed. It is **not** the parent's failure: the loop that called this
    // tool keeps going with a structured result, which is the whole point of the delegation being a tool call.
    outcome = {
      runId,
      status: "failed",
      errorCode: typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "subagent_run_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "The sub-agent run failed",
    };
  } finally {
    tracker.leave(input.parentRunId);
  }

  // (4) The digest. A refused handoff is reported, never scrubbed: `buildCodeSubagentHandoffDigest` throws when
  // the result would have to carry content or a credential, and the refusal becomes the child's failure.
  let handoff: CodeSubagentHandoffDigest;
  let handoffErrorCode: string | null = null;
  try {
    handoff = buildCodeSubagentHandoffDigest({
      answer: outcome.answer,
      files: outcome.filesChanged,
      toolCalls: outcome.toolCalls,
      turns: outcome.turns,
    });
  } catch (error) {
    handoffErrorCode = error instanceof CodeSubagentHandoffError ? error.code : "subagent_handoff_content_rejected";
    handoff = emptyCodeSubagentHandoffDigest();
  }

  const status = outcome.status === "completed" && !handoffErrorCode ? "completed" : "failed";
  const errorCode = handoffErrorCode ?? (outcome.status === "completed" ? null : outcome.errorCode ?? "subagent_run_failed");

  const result: CodeSubagentSpawnOutcome = {
    agentType: resolution.type,
    status,
    runId: (outcome.runId ?? runId) || null,
    errorCode,
    capabilityProfile: resolution.capabilityProfile,
    limits: { maxTurns: resolution.maxTurns, maxParallelism: resolution.maxParallelism },
    tools: allowedTools,
    handoff,
    truncated: false,
    resolution,
    allowedTools,
    deniedTools: evaluation.deniedTools,
  };

  /**
   * The delegation is recorded as an Activity event of the **parent** run, carrying the parent linkage and the
   * snapshot. The payload is counts and names only: the task text, the child's answer and every file body stay
   * out of it, which the metadata-only sink enforces anyway (`assertMetadataOnlyActivityPayload`).
   */
  await recordDelegationActivity(options, input, result, now());
  return result;
}

async function recordDelegationActivity(
  options: CodeAgentSpawnExecutorOptions,
  input: { companyId: string; projectId: string; sessionId: string; parentRunId: string; toolCallId: string; snapshotId?: string | null },
  result: CodeSubagentSpawnOutcome,
  at: Date,
): Promise<void> {
  if (!options.activity) return;
  try {
    await options.activity.record(
      {
        kind: DELEGATION_ACTIVITY_KIND,
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        // The event belongs to the **child** run: it is what the child did. `parentRunId` is what makes it a
        // tree node rather than another flat entry in the session's stream.
        runId: result.runId,
        snapshotId: input.snapshotId ?? null,
        parentRunId: input.parentRunId,
        parentToolCallId: input.toolCallId,
      },
      {
        at: at.toISOString(),
        action: "subagent_delegated",
        agentType: result.agentType,
        capabilityProfile: result.capabilityProfile,
        status: result.status,
        errorCode: result.errorCode,
        toolCount: result.tools.length,
        deniedToolCount: result.deniedTools.length,
        findingCount: result.handoff.findings.length,
        fileCount: result.handoff.files.length,
        symbolCount: result.handoff.symbols.length,
        droppedCount: result.handoff.dropped,
        maxTurns: result.limits.maxTurns,
      },
    );
  } catch (error) {
    // The event is bookkeeping and must never change the outcome of a delegation that already ran: the sink
    // already reports store failures in its result, so only a programming error (a content-like payload the
    // sink refuses loudly) can arrive here — and it is reported through the recorder's own error channel
    // rather than thrown at the parent.
    const message = error instanceof Error ? error.message : String(error);
    options.activity.record(
      {
        kind: DELEGATION_ACTIVITY_KIND,
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        runId: result.runId,
        parentRunId: input.parentRunId,
        parentToolCallId: input.toolCallId,
      },
      { at: at.toISOString(), action: "subagent_delegated", status: result.status, errorCode: "activity_record_failed", reason: message.slice(0, 120) },
    ).catch(() => undefined);
  }
}

/**
 * The executor the runtime dispatches to. It wraps `spawnCodeSubagent` in the `code_tool_result` envelope and
 * adds the two facts the parent needs in order to know what it is looking at: the tools the child actually
 * held and the limits it ran under.
 */
export function createCodeAgentSpawnExecutor(
  options: CodeAgentSpawnExecutorOptions = {},
): (input: CodeToolExecutionContext) => Promise<unknown> {
  const tracker = new CodeSubagentInFlightTracker();
  return async (input) => {
    const tool = "code.agent.spawn";
    // The two facts a delegation cannot be formed without. Both are **server** facts: the run that is
    // delegating, and the tool call that is doing it (which is also the idempotency key).
    if (!input.runId) {
      throw new CodeToolError("invalid_arguments", `${tool} requires the run that is delegating`, 400, "validate_arguments", false, tool);
    }
    if (!input.toolCallId) {
      throw new CodeToolError("invalid_arguments", `${tool} requires the tool-call id that identifies the delegation`, 400, "validate_arguments", false, tool);
    }
    if (!input.sessionId) {
      throw new CodeToolError("invalid_arguments", `${tool} requires a session`, 400, "validate_arguments", false, tool);
    }
    const outcome = await spawnCodeSubagent(
      {
        ctx: input.ctx,
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        parentRunId: input.runId,
        toolCallId: input.toolCallId,
        snapshotId: input.snapshotId ?? null,
        args: input.args,
      },
      options,
      tracker,
    );
    return {
      agentType: outcome.agentType,
      status: outcome.status,
      runId: outcome.runId,
      errorCode: outcome.errorCode,
      capabilityProfile: outcome.capabilityProfile,
      limits: outcome.limits,
      tools: outcome.tools,
      handoff: outcome.handoff,
      truncated: outcome.truncated,
    };
  };
}

/** Exported for the Capability Inspector and the tests: the type list, once. */
export const CODE_SUBAGENT_TOOL_TYPES: readonly string[] = CODE_SUBAGENT_TYPES;
