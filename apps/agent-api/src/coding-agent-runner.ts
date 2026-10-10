/**
 * C6: the Coding Agent's own loop (`CodingAgentRunner`).
 *
 * This is a **separate** loop from `runChatToolLoop` (which serves ordinary chat, Company runs and email).
 * That loop is left untouched: the code loop differs where it matters — it re-checks cancellation between
 * steps, partitions read-only calls from mutating ones, detects loops, resumes after a stream break without
 * re-running tools, and returns a structured stop reason with a summary.
 *
 * Everything that already exists is **reused, never duplicated**:
 * - `CodeToolRuntime.invoke` — tool resolution, sub-flags, argument validation, idempotency by `toolCallId`,
 *   write pre-flight (read-before-write, approval, per-turn checkpoint), data wrapping, Activity and audit.
 * - The PolicyEngine, SecretLease, read tracker and checkpoints live inside that runtime.
 * - The AI engine already carries the C5b `ProviderDataGuard` and the C5b routing filter, so provider
 *   fallback, redaction and eligibility are **not** re-implemented here. Every call carries `policyContext`.
 * - Budget/quota come from the existing `A2AQuotaManager` (injected as a port); limits come from
 *   `resolveCodeAgentLimits()`.
 * - Feature flags, RBAC (`authorizeCodeAction`), sandbox image admission and the ExecutionSnapshot seam are
 *   injected ports.
 */

import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatToolCall,
  ChatToolDefinition,
} from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession, CodeInboxMessage, DataClassification, RetentionClass } from "@npati/workspace";
import { resolveCodeAgentLimits, type CodeAgentLimits } from "./code-agent-config";
import {
  CODE_AGENT_SPAWN_TOOL,
  resolveCodeRunCapabilityScope,
  resolveCodeSubagentLimits,
  subagentDepthForRun,
  type CodeRunCapabilityScope,
  type ResolvedCodeSubagentLimits,
} from "./code-subagent-limits";
import { clampCodeSubagentTurnLimit } from "./code-subagent-types";
import {
  executableToolCalls,
  normalizeToolCalls,
  planToolCallWaves,
  toolCallFeedback,
  type KnownTool,
  type NormalizeToolCallsResult,
  type NormalizedToolCall,
} from "./code-tool-call-adapter";
import {
  modelProfileFallbackTrace,
  resolveEffectiveToolCallingMode,
  resolveModelProfile,
  type CodeModelProfile,
  type CodeModelProfileFallbackReason,
  type CodeModelProfileFallbackTrace,
} from "./code-model-profiles";
import { resolveModelRequestPressure, type ModelRequestPressure } from "./code-context-budget";
import {
  COMPACTION_SCHEMA_VERSION,
  assertNoLeaseValuesInSummary,
  compactConversation,
  renderSummaryMessage,
  type CompactionSummary,
} from "./code-conversation-compaction";
import { COMPANY_MEMORY_HEADER, PROJECT_CONTEXT_HEADER, renderContextBlocks } from "./code-context-memory";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import { MODE_RISK_MATRIX, isPlanSafeTool } from "./code-policy-engine";
import { DEFAULT_CODE_SESSION_MODE_MATRIX } from "./code-rbac";
import { CODE_TOOL_SCHEMAS } from "./code-tool-registry";
import { sha256Hex, validateArguments, type CodeToolInvokeFailure, type CodeToolInvokeResult } from "./code-tool-runtime";
import {
  VERIFICATION_APPROVAL_REQUIRED,
  VERIFICATION_REPAIR_EXHAUSTED,
  VERIFICATION_UNAVAILABLE,
  createVerificationLoop,
  formatRepairInstruction,
  type VerificationCheckReport,
  type VerificationLoop,
  type VerificationReport,
  type VerificationStatus,
} from "./code-verification-loop";
import { analyzeTestIntegrity, type TestIntegrityVerdict } from "./code-test-integrity-guard";
import { evaluateScopeGuard, type ScopeGuardResult } from "./code-scope-guard";
import {
  SELF_REVIEW_SCHEMA_VERSION,
  createSelfReview,
  describeSelfReview,
  selfReviewStopMessage,
  toPersistedSelfReview,
  type SelfReviewFinding,
  type SelfReviewPersisted,
  type SelfReviewState,
  type SelfReviewStatus,
  type SelfReviewVerdict,
} from "./code-self-review";
import {
  canonicalizeSettledToolResult,
  replayArgumentsHash,
  type ReplayBundleStepPayload,
} from "./code-replay-bundle";
import {
  EMPTY_SNAPSHOT_ID,
  resolveExecutionSnapshotProvider,
  type ExecutionSnapshotProvider,
} from "./execution-snapshot";
import { CodingAgentStopReason, CodingAgentRunStatus, CODE_ASK_USER_TOOL, CodeRunToolDescriptor, CodeRunRuntimeToolDescriptor, CodeRunRuntimeDiscovery, CodeRunToolSchemaLike, CodeRunActivityEvent, CodeRunSkillProvenance, CodeRunReplayRecorderPort, CodingAgentRunnerPorts, CodingAgentRunInput, CodingAgentPendingApproval, CodingAgentRunSummary, CodingAgentSelfReviewFinding, CodingAgentRunResult, CODE_RUN_START_ACTION, CODE_RUN_START_PERMISSION, DEFAULT_ESTIMATED_TOKENS_PER_CALL, DEFAULT_ESTIMATED_COST_PER_CALL_USD, LOOP_REPEAT_THRESHOLD, MAX_ARGUMENT_CORRECTIONS, REMINDER_MESSAGE, APPROVED_TOOL_CALLS_RESULT_HEADER, CHECK_TOOL_PREFIXES, DEFAULT_VERIFICATION_TOOLS, DEFAULT_SELF_REVIEW_DIFF_CHARS, assertMetadataOnly, isReadOnlyRunTool, REVIEW_SAFE_RUN_GIT_TOOLS, createCodeRunPolicyComposition, buildSystemPrompt, chatContentText, toolCallSignature, toChatToolCall, bounded } from "./coding-agent-runner-contracts";
export * from "./coding-agent-runner-contracts";


export class CodingAgentRunner {
  private readonly limits: CodeAgentLimits;
  private readonly snapshot: ExecutionSnapshotProvider;
  private readonly now: () => number;
  private readonly estimatedTokensPerCall: number;
  private readonly estimatedCostPerCallUsd: number;
  /**
   * C9 (requirement 4): how much diff text the self-review sees. A bound, not a policy — the review reads text,
   * and a whole repository diff is neither affordable nor useful.
   */
  private readonly selfReviewDiffChars: number;

  constructor(private readonly ports: CodingAgentRunnerPorts) {
    this.limits = { ...resolveCodeAgentLimits(), ...ports.limits };
    this.snapshot = resolveExecutionSnapshotProvider(ports.snapshot);
    this.now = ports.now ?? (() => Date.now());
    this.estimatedTokensPerCall = ports.estimatedTokensPerCall ?? DEFAULT_ESTIMATED_TOKENS_PER_CALL;
    this.estimatedCostPerCallUsd = ports.estimatedCostPerCallUsd ?? DEFAULT_ESTIMATED_COST_PER_CALL_USD;
    this.selfReviewDiffChars = Math.max(1_000, ports.selfReviewDiffChars ?? DEFAULT_SELF_REVIEW_DIFF_CHARS);
  }

  /**
   * C12: the resolved subagent limits of this runner — **readable**, clamped and actually consumed.
   *
   * `subagentDepth` and `subagentParallelism` were dead configuration until now (zero readers): the plan's
   * table said 1 and 4 while the registries defaulted to 4 and 5 and nothing read either value. `maxDepth` is
   * consumed by the capability scope (0 turns delegation off entirely, and it can never exceed the structural
   * limit), and `maxParallelism` is consumed by the project task graph, which admits work in parallel under
   * one parent.
   */
  get subagentLimits(): ResolvedCodeSubagentLimits {
    return resolveCodeSubagentLimits(this.limits);
  }

  /** The deployment's published, active tools — the canonical universe a scope is resolved against. */
  private publishedTools(): CodeRunToolDescriptor[] {
    return this.ports.toolRuntime.listTools().filter((tool) => tool.status === "active");
  }

  /**
   * Tool definitions offered to the model.
   *
   * `plan` mode offers read/search tools plus the narrow, explicit planning list — never a workspace, sandbox
   * or git mutation. The list is separate from the read-only set on purpose: a new read tool must not become
   * available in `plan` just because it is read-only (see PLAN_SAFE_TOOLS).
   *
   * C11 (owner decision 10): a **read-only intent** (`REVIEW_CODE`) offers the review-safe set — the read
   * tools, the plan-safe metadata tools and the read-only git tools, plus the separately approved pull-request
   * comment. This is the courtesy half of the enforcement; the runtime refuses anything else even if the model
   * names it anyway.
   *
   * C12: a **delegated run** is offered neither the delegation tool (depth 1 is structural: a child cannot
   * become a parent) nor anything outside the single `capabilityScope` object the caller computed. The same
   * object travels into the runtime, so what the model sees and what the server enforces cannot drift — and a
   * tool newly added to the general set is not offered to a child merely because it exists.
   *
   * C13: `options.runtimeTools` are the tools discovery just published for **this** run's tenant. They are
   * appended to the published static set and then pass through **every** filter below unchanged — a runtime MCP
   * tool is `write: true`, so a read-only intent and `plan` mode drop it exactly as they drop any other tool of
   * unknown blast radius, and a delegated run's recorded scope does not contain it unless the delegation
   * recorded it. That is the courtesy half; the policy engine is the guarantee.
   */
  toolDescriptors(
    session: CodeSession,
    options: {
      readOnlyIntent?: boolean;
      capabilityScope?: CodeRunCapabilityScope;
      runtimeTools?: readonly CodeRunRuntimeToolDescriptor[];
      asyncProcessesEnabled?: boolean;
      asyncSubagentsEnabled?: boolean;
      asyncAgentControlsEnabled?: boolean;
    } = {},
  ): CodeRunToolDescriptor[] {
    const scope = options.capabilityScope;
    const mayDelegate = scope ? scope.mayDelegate : this.subagentLimits.delegationAllowed;
    const staticTools = this.publishedTools();
    const staticNames = new Set(staticTools.map((tool) => tool.name.toLowerCase()));
    // A runtime tool can never shadow a published static one, and the ordering is fixed (static first, then
    // runtime sorted by id) so the model's tool list is deterministic run to run.
    const runtimeTools = [...(options.runtimeTools ?? [])]
      .filter((tool) => !staticNames.has(tool.name.toLowerCase()))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map<CodeRunToolDescriptor>((tool) => ({
        name: tool.name,
        version: tool.version,
        status: tool.status,
        description: tool.description,
        write: tool.write,
      }));
    let available = [...staticTools, ...runtimeTools];
    if (!options.asyncProcessesEnabled) available = available.filter((tool) => !["code.shell.exec_async", "code.shell.process.wait"].includes(tool.name));
    if (!options.asyncSubagentsEnabled) available = available.filter((tool) => tool.name !== "code.agent.spawn_async");
    if (!options.asyncAgentControlsEnabled) available = available.filter((tool) => !["code.agent.continue", "code.agent.send_message", "code.agent.interrupt"].includes(tool.name));
    // A delegation tool is only ever offered to a run that may delegate, and only while the depth limit allows.
    if (!mayDelegate) available = available.filter((tool) => !tool.name.startsWith("code.agent."));
    if (scope?.tools) {
      const allowed = new Set(scope.tools.map((tool) => tool.toLowerCase()));
      available = available.filter((tool) => allowed.has(tool.name.toLowerCase()));
    }
    if (options.readOnlyIntent === true) {
      return available.filter((tool) => isReadOnlyRunTool(tool.name) || isPlanSafeTool(tool.name) || REVIEW_SAFE_RUN_GIT_TOOLS.has(tool.name));
    }
    if (session.mode === "plan") {
      return available.filter((tool) => isReadOnlyRunTool(tool.name) || isPlanSafeTool(tool.name));
    }
    return available;
  }

  /**
   * The published registry unless the caller injects its own set. Defaulting here (rather than requiring
   * wiring) means the runner always has the canonical schemas: without them the model would be offered no
   * tools and text-mode calls could not be validated.
   */
  private get schemas(): readonly CodeRunToolSchemaLike[] {
    return this.ports.schemas ?? CODE_TOOL_SCHEMAS;
  }

  private chatToolDefinitions(
    tools: readonly CodeRunToolDescriptor[],
    runtimeTools: readonly CodeRunRuntimeToolDescriptor[] = [],
  ): ChatToolDefinition[] {
    const byName = this.toolSchemaByName(runtimeTools);
    const definitions: ChatToolDefinition[] = [];
    for (const tool of tools) {
      const schema = byName.get(tool.name);
      if (!schema) continue; // no schema → the model is not offered the tool (never a guessed schema)
      definitions.push({
        type: "function",
        function: { name: schema.name, description: schema.description, parameters: schema.inputSchema },
      });
    }
    return definitions;
  }

  /**
   * C13: the schema universe of one run — the deployment's published tool schemas plus the **discovered**
   * runtime provider schemas of this tenant.
   *
   * One map, used for both the model's tool definitions and the argument validator, for the reason the static
   * half has always used one: a definition and a validator that read different schemas would let the model be
   * offered arguments the validator then refuses (or worse, the reverse). A runtime tool never displaces a
   * published static schema of the same name.
   */
  private toolSchemaByName(
    runtimeTools: readonly CodeRunRuntimeToolDescriptor[] = [],
  ): Map<string, CodeRunToolSchemaLike> {
    const byName = new Map(this.schemas.map((schema) => [schema.name, schema]));
    for (const tool of runtimeTools) {
      if (byName.has(tool.name)) continue;
      byName.set(tool.name, {
        name: tool.name,
        version: tool.version,
        status: tool.status,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    return byName;
  }

  /**
   * C13: resolves the run's prompt through the **existing** command registry.
   *
   * Deliberately narrow: this method decides nothing about commands, reads no file, checks no trust and expands
   * no template — it asks the port for the text and the provenance and records both. A failure resolves to the
   * caller's own prompt with the failure recorded as a code, because "the expansion could not be produced" must
   * not silently become "a different prompt was used": the provenance list travels with the run either way.
   */
  private async resolveCommandPrompt(input: CodingAgentRunInput, sessionId: string): Promise<{
    text: string;
    provenance: readonly Record<string, unknown>[];
    refusals: readonly string[];
  }> {
    const port = this.ports.commandExpansion;
    if (!port) return { text: input.prompt, provenance: [], refusals: [] };
    try {
      const resolved = await port.resolvePrompt({
        ctx: input.ctx,
        companyId: input.session.companyId,
        projectId: input.session.projectId,
        sessionId,
        prompt: input.prompt,
      });
      if (!resolved) return { text: input.prompt, provenance: [], refusals: [] };
      if (typeof resolved.text !== "string" || resolved.text.length === 0) {
        return { text: input.prompt, provenance: [], refusals: ["command_expansion_empty"] };
      }
      return {
        text: resolved.text,
        provenance: resolved.provenance ?? [],
        refusals: resolved.refusals ?? [],
      };
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "command_expansion_failed";
      this.ports.logger?.warn("code_command_expansion_failed", { code, sessionId });
      return { text: input.prompt, provenance: [], refusals: [code] };
    }
  }

  async run(input: CodingAgentRunInput): Promise<CodingAgentRunResult> {
    const startedAt = this.now();
    const { ctx, session } = input;
    const companyId = session.companyId;
    const projectId = session.projectId;
    const sessionId = session.id;
    const turnId = input.turnId ?? `run-${startedAt}`;
    /**
     * C10: the key a **step** of this run uses in `CodeTurnTracker`.
     *
     * Before C10 every tool call of a whole run was invoked with the same `turnId`, so the tracker's per-turn
     * entry — and therefore the per-turn checkpoint — was created once for the whole run: the first write took
     * the checkpoint, every later turn reused it, and `code_run_turns.checkpoint_id` (had anything written it)
     * could only ever have named the state *before the run*. A rewind "to turn 5" would then have restored the
     * state before turn 1 while claiming to be about turn 5.
     *
     * Each assistant step is a turn: it is one model exchange and one batch of tool calls. Keying the tracker by
     * the step is what makes "the checkpoint of turn N" mean "the workspace as it was before turn N wrote
     * anything", which is exactly what a rewind to turn N must restore. `turnId` itself keeps its meaning for
     * everything else — run events, idempotency keys and the verification tool-call ids — so no recorded
     * identifier moves, and `applyTurnSummary` below aggregates the steps so the run summary is unchanged.
     */
    const stepTurnKey = (index: number): string => `${turnId}#turn-${index}`;
    /**
     * The steps whose tool calls actually ran. The run summary and the change set are aggregated over exactly
     * these, so a step with no calls (the closing assistant answer) cannot count twice.
     */
    const toolSteps: number[] = [];
    /** Monotonic carry-forward of the last checkpoint a turn was based on (see `turnCheckpointId`). */
    let lastCheckpointId: string | null = null;
    const summary: CodingAgentRunSummary = {
      filesChanged: [],
      diffStats: { files: 0, linesAdded: 0, linesRemoved: 0 },
      checksRun: [],
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      costUsd: 0,
      remaining: "",
    };
    /**
     * C11 (owner decision 11): the run's own summary is published to the environment holder as soon as it
     * exists, so `code.git.pr.create` can generate the pull-request description from **this** run's summary
     * rather than from a second format. The reference is live — the loop mutates the same object — so a pull
     * request opened at the end of the run sees the change set and the verification result as they stand.
     */
    this.ports.environment?.setRunSummary(summary);
    let snapshotId: string = EMPTY_SNAPSHOT_ID;
    /**
     * C6b: the replay recorder, assigned once the run id, the snapshot id and the environment facts exist.
     * Declared here (not inside the `try`) because `stop` closes it on every terminal path.
     */
    let replayRecorder: CodeRunReplayRecorderPort | undefined;
    const completionArtifacts: Record<string, unknown>[] = [];
    let model: string | undefined;
    let provider: string | undefined;
    /**
     * C8: context pressure of the last model request and how many compactions happened.
     *
     * Declared **here**, above `finish`, and not next to the loop where they are computed: `finish` reports them
     * on every terminal path, and the refusal paths (feature flag, RBAC, admission gate, image admission) return
     * through `finish` **before** the loop is ever reached. Declaring them below those returns made every refusal
     * throw `Cannot access 'lastBudget' before initialization` — a fail-closed path that failed, which is the one
     * kind of bug this project must never ship. The values stay `null`/`0` for a refused run, which is exactly
     * what a run that never called a model should report.
     */
    let lastBudget: ModelRequestPressure | null = null;
    let compactionCount = 0;
    /**
     * C9: the verification/repair state machine. Built here, **above** `finish`, for exactly the reason
     * `lastBudget` is: every terminal path reports it, and the refusal paths (feature flag, RBAC, admission
     * gate, image admission) return through `finish` before the loop is ever reached. Declaring this below
     * those returns would put every refusal into the temporal dead zone — the C8 defect that turned a refusal
     * into a thrown exception.
     */
    const verificationTools = Object.freeze([...(input.verificationTools ?? DEFAULT_VERIFICATION_TOOLS)]);
    const verificationLoop: VerificationLoop = createVerificationLoop({
      maxRepairAttempts: this.limits.repairLoopAttempts,
      requestedTools: verificationTools,
    });
    /** True when the caller explicitly opted out (an empty list) — then the loop must not fabricate a run. */
    const verificationDisabled = verificationTools.length === 0;
    let testIntegrity: TestIntegrityVerdict | null = null;
    let scopeGuard: ScopeGuardResult | null = null;
    /**
     * C9 (requirement 4): the self-review. Declared here, above `finish`, for exactly the reason
     * `verificationLoop` is: every terminal path reports it, and the refusal paths return through `finish`
     * before the loop is reached. Declaring it lower would put those paths into the temporal dead zone and
     * turn a refusal into a thrown exception — the C8 defect this ordering already exists to prevent.
     *
     * `selfReviewState` is created **once** per run and the pass is executed at most once. `selfReviewVerdict`
     * is the frozen verdict every summary reads, so a later reader cannot observe a different verdict than the
     * one the review produced.
     */
    let selfReviewState: SelfReviewState | null = null;
    let selfReviewVerdict: SelfReviewVerdict | null = null;
    /** How many times the review-of-the-change was attempted. The cap is one, enforced in the module. */
    let selfReviewPasses = 0;
    /**
     * The change-set signature recorded by the **last** verification. If the review-driven fix leaves the
     * change set identical to this, running the checks again would re-verify bytes that were already verified,
     * so the runner skips it and says so. If it differs, verification runs **again** — that branch is mandatory,
     * not an optimisation, which is why it is a comparison of the tree rather than a claim by the model.
     */
    let verifiedSignature: string | null = null;
    /** True while the single self-review-driven fix iteration is in flight. */
    let selfReviewFixPending = false;

    // C6a: durable run state. `stateRunId` stays undefined until the run is admitted, so a refused run
    // leaves no state row behind; from then on every exit path writes a terminal state.
    let stateRunId: string | undefined;
    const stateOwner = input.runStateOwner ?? this.ports.runStateOwner
      ?? `runner-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    /** Set by the heartbeat when a renewal is refused: another process owns the run. */
    let leaseLost = false;
    /**
     * Step 5: set when the sandbox was **withheld** because a delegated child of this run had not settled. The
     * run's own outcome is then interrupted — `active_subagent_unsettled` — because a parent that ended
     * while a child it started is still working has not finished the work it accepted.
     */
    let unsettledChildren = false;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    };

    /**
     * C13: the **model-visible prompt** of this run, resolved exactly once and before every reader of the
     * prompt below (`stop` records the command provenance, the loop builds the transcript from the text, the
     * review and the scope guard read the goal). It is the expanded text when the caller's prompt was a slash
     * command and the caller's own text otherwise — which is what makes "replay sees the same model-visible
     * text" true by construction instead of by convention: there is one variable, not five call sites that
     * could disagree.
     */
    const commandPrompt = await this.resolveCommandPrompt(input, sessionId);
    let prompt = commandPrompt.text;
    let inboxOpened = false;
    let inboxSealed = false;
    let recoveredInbox: CodeInboxMessage[] = [];

    /**
     * C13 (owner blocker 1): the runtime MCP calls this run asked a human about and could not execute.
     *
     * The list is the run's own account of why it is paused, and it travels in the result of **every** exit path
     * (see `finish`), because a caller that receives `waiting_for_user` has to know which records to approve and
     * which call each of them belongs to. It is metadata only — the record id, the call id, the tool id and the
     * two hashes the approval is bound to (schema and arguments) — never the arguments themselves.
     */
    const pendingApprovals: CodingAgentPendingApproval[] = [];

    const finish = (
      status: CodingAgentRunStatus,
      reason: CodingAgentStopReason,
      message: string,
      code?: string,
    ): CodingAgentRunResult => {
      stopHeartbeat();
      /**
       * C11: the live summary is cleared on every terminal path. Leaving it behind would let a *later* run —
       * or a direct tool call outside any run — read a finished run's summary and generate a pull-request
       * description that describes somebody else's change set.
       */
      this.ports.environment?.setRunSummary(null);
      const finishedAt = this.now();
      /**
       * Step 5: a withheld sandbox is a real outcome, not a detail. A run that "completed" while a child it started
       * is still required would make the caller's next step run against a session whose work is half done, so the
       * status remains interrupted with its own reason. The child keeps its own run, its own lease and its own
       * completion; nothing here cancels it.
       */
      const reportedStatus: CodingAgentRunStatus = unsettledChildren && status !== "waiting_for_user" ? "interrupted" : status;
      const reportedReason: CodingAgentStopReason = unsettledChildren && status !== "waiting_for_user"
        ? "active_subagent_unsettled"
        : reason;
      return {
        status: reportedStatus,
        reason: reportedReason,
        message: unsettledChildren && status !== "waiting_for_user"
          ? `The run ended while a delegated sub-agent was still required; its completion has not been collected (${message})`
          : message,
        summary,
        snapshotId,
        startedAt,
        finishedAt,
        ...(code ? { code } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(stateRunId ? { runId: stateRunId } : {}),
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        // C8: reported so a caller can see how full the window was and whether compaction ran.
        ...(lastBudget
          ? {
              context: {
                currentTokens: lastBudget.currentTokens,
                maxContextTokens: lastBudget.maxContextTokens,
                utilizationRatio: lastBudget.utilizationRatio,
                compactions: compactionCount,
              },
            }
          : {}),
        // C9: reported on every terminal path once verification ran, so a caller never has to read the log to
        // learn that the change was never verified.
        ...(summary.verification ? { verification: summary.verification } : {}),
        ...(summary.scope ? { scope: summary.scope } : {}),
        // C9 (requirement 4): the self-review travels at the top level as well as in the summary, so a caller
        // that reads only one of the two still learns that the review was unavailable or left findings open.
        ...(summary.selfReview ? { selfReview: summary.selfReview } : {}),
        /**
         * C13 (owner blocker 1): why this run is paused on a human decision, on every exit path that has one.
         * It is present exactly when at least one runtime MCP call is waiting for an approval, so a caller
         * reads `status: "waiting_for_user"` and the records to approve from the same answer.
         */
        ...(pendingApprovals.length ? { pendingApprovals: pendingApprovals.map((entry) => ({ ...entry })) } : {}),
      };
    };

    /** Best-effort state write: a state-store hiccup must not change the run's outcome. */
    const writeState = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch {
        // Swallowed on purpose: durability is a guarantee of the store, not a gate for the loop. The one
        // exception is the lease, which is checked separately because a lost lease must stop the run.
      }
    };

    /**
     * Terminal exit from the loop: the run state is stamped before the result is returned, so a process that
     * finishes a run never leaves it looking like it is still running.
     */
    const stop = async (
      status: Exclude<CodingAgentRunStatus, "waiting_for_user">,
      reason: CodingAgentStopReason,
      message: string,
    ): Promise<CodingAgentRunResult> => {
      if (unsettledChildren) { status = "interrupted"; reason = "active_subagent_unsettled"; }
      if (inboxOpened && stateRunId) {
        try {
          if (this.ports.runState && !(await this.ports.runState.renewLease({ companyId, runId: stateRunId, owner: stateOwner })).held) {
            return finish("interrupted", "interrupted", "The run lease changed before settlement. The replacement's state was not modified.");
          }
          await this.ports.inbox!.transact(session, { kind: "close", runId: stateRunId, owner: stateOwner });
          inboxOpened = false;
        } catch {
          // Do not report success or keep a heartbeat alive when durable settlement is uncertain.
          return finish("interrupted", "interrupted", "Durable inbox settlement could not be confirmed. Pending input remains recoverable.");
        }
      }
      // C6b: every terminal exit goes through here, so the bundle is always closed with a status and reason.
      // A bundle failure (including a refused secret) is reported but never turns into a failed run: the
      // recording is evidence about the run, not a gate for it.
      if (replayRecorder) {
        try {
          await replayRecorder.finalize({
            ...(completionArtifacts.length ? { completionArtifacts } : {}),
            terminalStatus: status,
            terminalReason: reason,
            compressionArtifacts,
            // C13: the command expansions this run applied, pinned by provenance so a replay expands the
            // recorded version rather than resolving `/name` against today's templates.
            commandExpansions: commandPrompt.provenance,
          });
        } catch (error) {
          this.ports.logger?.warn("replay_bundle_refused", {
            code: (error as { code?: string })?.code ?? "replay_bundle_error",
            runId: stateRunId ?? input.runId,
          });
        }
      }
      if (stateRunId && this.ports.runState) {
        // `waiting_for_user` is excluded from this parameter on purpose (see the signature): it is the one status
        // that must never be written by the terminal path, so the mapping below cannot silently turn a pause into
        // a completion.
        const stateStatus = status === "cancelled"
          ? "cancelled"
          : status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed";
        if (status === "interrupted" && (input.detachedChildInbox || unsettledChildren || reason === "async_collect_unsettled")) {
          await writeState(() => this.ports.runState!.markInterrupted?.({ companyId, runId: stateRunId!, reason })
            ?? this.ports.runState!.markFinished({ companyId, runId: stateRunId!, status: "interrupted", reason }));
          await writeState(() => this.ports.runState!.releaseLease?.({ companyId, runId: stateRunId!, owner: stateOwner }) ?? Promise.resolve());
        } else await writeState(() => this.ports.runState!.markFinished({
          companyId, runId: stateRunId!, status: stateStatus, reason,
          // Persisted as an estimate, never as metering: `costUsd` is the loop's own number and the provider may
          // have reported no usage at all, so a reader must be able to tell the two apart.
          estimate: {
            tokenCount: summary.tokens,
            costUsd: Number.isFinite(summary.costUsd) ? summary.costUsd : null,
            turns: summary.turns,
            toolCalls: summary.toolCalls,
            filesChanged: summary.filesChanged.length,
            diffStats: summary.diffStats,
            // C9: additive, and each part carries its own schema version.
            ...(summary.verification ? { verification: summary.verification } : {}),
            ...(summary.scope ? { scope: summary.scope } : {}),
            /**
             * C9 (requirement 4): the self-review travels in its metadata-only form. `writeSelfReviewSummary`
             * has already run on every terminal path that reached the review, so this is the same verdict the
             * run result carries — only without the reviewer's prose, which is conversation, not state.
             */
            ...(selfReviewVerdict ? { selfReview: toPersistedSelfReview(selfReviewVerdict) } : {}),
          },
        }));
      }
      /**
       * C13: `Stop`. Every terminal exit passes through here (the replay bundle, the durable run state and
       * the run result are all stamped), so this is the one place a project can learn that the run is over —
       * with the status and reason it really ended with. Best effort: a hook can never change the outcome.
       */
      try {
        await this.ports.lifecycleHooks?.stop({
          ctx, companyId, projectId, sessionId,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(stateRunId ? { runId: stateRunId } : {}),
          snapshotId: snapshotId ?? null,
          status,
          reason,
        });
      } catch {
        // A hook never changes a run's outcome.
      }
      return finish(status, reason, message);
    };

    /**
     * C9: the non-terminal exit. The run asked the user a question, so it stops **without finishing**:
     *
     *   - `markFinished` is never called. A paused run has no outcome, and stamping `finished_at` would make the
     *     answer — which arrives later, from another process — apply to a run that no longer exists as live work.
     *   - `markWaitingForUser` is written here rather than left to the tool service, because the runner is what
     *     owns the run state and the lease, and because the pause must be recorded on the same path that stops the
     *     loop: a deployment that wires the service without a run-state port must still produce `waiting_for_user`,
     *     or C6a would later "recover" a run that is simply waiting.
     *   - the turn is closed (`finished`) before returning. Every turn that opened must close, otherwise a waiting
     *     run leaves an unfinished turn behind and the resume in C10 would treat the question as re-runnable.
     *   - the replay bundle is deliberately **not** finalized: the run is not over, so its recording is not either.
     *
     * The sandbox is released (the pause can last hours and a held sandbox is a leaked one); a resume takes a
     * fresh one.
     */
    const pauseForUser = async (
      question: { questionId: string; toolCallId: string },
      /**
       * C13 (owner blocker 1): what the pause is waiting for. A question (`code.ask_user`) and an approval of a
       * runtime MCP call are the **same state** — `waiting_for_user`, released by the same transitions — so the
       * only difference is the wording a human reads. The approval record id travels in the question slot, so
       * there is one pause state and one thing to decide, never a second mechanism.
       */
      waitingFor: "question" | "approval" = "question",
    ): Promise<CodingAgentRunResult> => {
      if (stateRunId && this.ports.runState) {
        if (this.ports.runState.markWaitingForUser) {
          await writeState(() => this.ports.runState!.markWaitingForUser!({
            companyId, runId: stateRunId!, questionId: question.questionId, toolCallId: question.toolCallId,
          }));
        } else {
          // No terminal state is written instead: a run that cannot be marked waiting must be visible as such.
          this.ports.logger?.warn("run_state_pause_unsupported", {
            runId: stateRunId, questionId: question.questionId,
          });
        }
        await writeState(() => this.ports.runState!.appendTurn({
          companyId, runId: stateRunId!, turnIndex: steps, status: "finished", outcome: "ok",
          checkpointId: turnCheckpointId(),
        }));
      }
      stopHeartbeat();
      /**
       * N1: the paused run is **not driving** the session any more, although it keeps its inbox task (its
       * admitted messages must still be recoverable by a resume of this same run id). Recording that fact here
       * is what lets a continuation that mints a new run id take the session instead of being refused by the
       * lease fence while this run's C6a lease is still `live`. Best effort, like every other settlement write:
       * a failure leaves the pre-N1 behaviour (a continuation waits for the lease to expire) rather than
       * corrupting the task.
       */
      if (inboxOpened && stateRunId) {
        try {
          await this.ports.inbox!.transact(session, { kind: "pause", runId: stateRunId, owner: stateOwner });
          inboxOpened = false;
        } catch {
          this.ports.logger?.warn("inbox_pause_not_recorded");
        }
      }
      await release("waiting_for_user");
      await this.ports.runEvents?.append({
        eventKey: `code-run-waiting-for-user:${turnId}`,
        eventType: "waiting_for_user",
        runStatus: "waiting_for_user",
        message: waitingFor === "approval"
          ? "Coding Agent run is waiting for an approval decision"
          : "Coding Agent run is waiting for the user to answer a question",
      });
      summary.turns = steps;
      summary.remaining = waitingFor === "approval"
        ? "The run is waiting for an approval decision."
        : "The run is waiting for the user to answer a question.";
      return finish(
        "waiting_for_user",
        "waiting_for_user",
        waitingFor === "approval"
          ? `Waiting for an approval decision on tool call ${question.toolCallId}.`
          : `Waiting for the user to answer question ${question.questionId}.`,
      );
    };

    /**
     * C13 (owner blocker 1): reads the **approval pause** out of a settled runtime MCP result.
     *
     * The shape is checked here rather than trusted, because this value decides whether the loop stops: the run
     * path sets `pauseForApproval` exactly when the policy engine refused the call with `approval_required` and
     * created a real record for it, and the record id has to be present for the pause to be answerable at all.
     * A result without an id is **not** a pause — it stays the ordinary refusal the model already receives.
     */
    const approvalPauseFrom = (
      outcome: { call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure },
    ): CodingAgentPendingApproval | null => {
      if (outcome.result.ok) return null;
      const error = outcome.result.error as { code?: string; details?: Record<string, unknown> };
      if (error.code !== "approval_required") return null;
      const details = error.details ?? {};
      if (details.pauseForApproval !== true) return null;
      const approvalId = details.approvalId;
      if (typeof approvalId !== "string" || approvalId.length === 0) return null;
      const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
      return {
        approvalId,
        toolCallId: outcome.call.id,
        tool: outcome.call.name,
        connectionId: asString(details.connectionId),
        toolName: asString(details.toolName),
        schemaHash: asString(details.schemaHash),
        argsHash: asString(details.argsHash),
      };
    };

    /**
     * Reads the question id out of a settled `code.ask_user` result. Only the envelope's `data` is consulted —
     * never `code_run_states.details`, which is written with `COALESCE` and can therefore hold an earlier
     * snapshot — and the shape is checked here rather than trusted, because this value decides whether the loop
     * stops. `null` means "this call asked nothing", which the caller turns into a refusal.
     */
    const questionIdFrom = (outcome: { call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure }): { questionId: string; toolCallId: string } | null => {
      if (outcome.call.name !== CODE_ASK_USER_TOOL || !outcome.result.ok) return null;
      const envelope = outcome.result.result;
      if (!envelope || typeof envelope !== "object") return null;
      const data = (envelope as { data?: unknown }).data;
      if (!data || typeof data !== "object") return null;
      const questionId = (data as { questionId?: unknown }).questionId;
      if (typeof questionId !== "string" || questionId.length === 0) return null;
      return { questionId, toolCallId: outcome.call.id };
    };

    const release = async (reason: string): Promise<void> => {
      try {
        if (stateRunId && this.ports.activeChildren?.settle
          && !await this.ports.activeChildren.settle({ ctx, companyId, projectId, sessionId, runId: stateRunId, cancel: reason !== "completed" })) {
          unsettledChildren = true; return;
        }
        /**
         * Step 5: the sandbox is **not** released while a delegated child of this run is still required. The
         * child is not this run's process, so the process cleanup fence cannot see it, and destroying the sandbox
         * under a child that is still writing would fail the child for a reason nobody chose. The run is settled
         * by the caller as `active_subagent_unsettled`, which is the honest answer: the parent is over, its
         * delegation is not, and the child's completion is still on its way to the inbox.
         */
        if (stateRunId && this.ports.activeChildren
          && await this.ports.activeChildren.isUnsettled({ ctx, companyId, projectId, sessionId, runId: stateRunId })) {
          unsettledChildren = true;
          return;
        }
      } catch {
        // An unreadable fence must not release the sandbox either: the safe direction is to keep it.
        unsettledChildren = true;
        return;
      }
      if (!this.ports.sandbox) return;
      try {
        await this.ports.sandbox.release({ ctx, companyId, projectId, sessionId, reason });
      } catch {
        // Releasing the sandbox is best effort on the stop path; the stop reason is what the caller needs.
      }
    };

    /**
     * C14: the profile degradation of this run, as a closed vocabulary — `null` until the profile is resolved
     * and whenever the model matched a profile. It is a `let` in the run's own scope, read by `record` **at call
     * time**, so every event written after the resolution carries the reason and every event written before it
     * (the refusal paths, `run_started`, `session_branch`) honestly carries none: at that point there was no
     * profile yet, and inventing one would be a claim about a decision that had not been made.
     */
    let modelProfileFallbackReason: CodeModelProfileFallbackReason | null = null;

    const record = async (event: CodeRunActivityEvent): Promise<void> => {
      // Activity is a log, never a gate: a rejected shape or a failing sink must not change the run.
      try {
        // C14: the reason travels with the event rather than being written once, because a reader of a single
        // event (a timeline row, a support ticket) must not have to find and correlate an earlier one.
        const withProfileReason = modelProfileFallbackReason === null
          ? event
          : { ...event, modelProfileFallbackReason };
        assertMetadataOnly(withProfileReason as unknown as Record<string, unknown>);
        if (!this.ports.activity) return;
        await this.ports.activity.record({ ...withProfileReason, snapshotId: snapshotId || undefined });
      } catch {
        // Swallowed on purpose; the metadata-only property is asserted directly in the security-gate suite.
      }
    };

    /**
     * C9/C10: the run's change set, as the per-turn tracker knows it.
     *
     * Best effort by design: a missing tracker means "no changes are known", which disables the guards for
     * this run rather than failing it. The alternative — treating an unreadable tracker as a change set — would
     * make the guards fire on no evidence.
     *
     * C10: the tracker is now keyed by **step**, so the run-wide change set is the merge of every step that ran
     * tool calls, deduplicated by path (the last write of a path wins, which is the state a guard must judge).
     * The merge is computed here rather than accumulated in a field so it stays live: `currentChangeSignature`
     * asks exactly this function "did the review-driven fix change anything?", and a cached value would answer
     * with the state from before the fix.
     */
    let collectedChanges: Array<{ path: string; tool: string; status?: string; diff?: string }> = [];
    const runChanges = (): Array<{ path: string; tool: string; status?: string; diff?: string }> => {
      const merged = new Map(collectedChanges.map((change) => [change.path, change]));
      if (!this.ports.toolRuntime.turnSummary) return [...merged.values()];
      for (const index of toolSteps) {
        try {
          const summaryForTurn = this.ports.toolRuntime.turnSummary(sessionId, stepTurnKey(index));
          for (const change of summaryForTurn?.changes ?? []) {
            merged.set(change.path, {
              path: change.path,
              tool: change.tool,
              ...(change.status !== undefined ? { status: change.status } : {}),
              ...(change.diff !== undefined ? { diff: change.diff } : {}),
            });
          }
        } catch {
          // A single unreadable step must not discard the changes the other steps reported.
        }
      }
      return [...merged.values()];
    };

    /**
     * C10: the totals the run summary reports. Summed over the steps that ran, exactly like the pre-C10 code
     * read them from the single run-scoped tracker entry — the tracker's own `files`/`linesAdded`/`linesRemoved`
     * are used rather than recomputed from `changes`, because they are the numbers the write runtime counted.
     */
    const runChangeTotals = (): { files: number; linesAdded: number; linesRemoved: number } => {
      const paths = new Set<string>();
      let linesAdded = 0;
      let linesRemoved = 0;
      for (const change of collectedChanges) {
        paths.add(change.path);
        for (const line of (change.diff ?? "").split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
          if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
        }
      }
      if (!this.ports.toolRuntime.turnSummary) return { files: paths.size, linesAdded, linesRemoved };
      for (const index of toolSteps) {
        try {
          const summaryForTurn = this.ports.toolRuntime.turnSummary(sessionId, stepTurnKey(index));
          for (const change of summaryForTurn?.changes ?? []) paths.add(change.path);
          linesAdded += summaryForTurn?.linesAdded ?? 0;
          linesRemoved += summaryForTurn?.linesRemoved ?? 0;
        } catch {
          // Same reasoning as `runChanges`: one unreadable step is not evidence about the others.
        }
      }
      return { files: paths.size, linesAdded, linesRemoved };
    };

    /**
     * C10: the checkpoint the turn that just closed should be linked to.
     *
     * It is the checkpoint of **this step** when the step wrote something (the tracker created it during the
     * write pre-flight, before the first byte landed). When the step wrote nothing, the answer is the last
     * checkpoint that was in force — carrying it forward is what makes the column useful to a reader: a turn
     * with a checkpoint names the state to compare against, and a null would mean "unknown", not "unchanged".
     */
    const turnCheckpointId = (): string | null => {
      if (this.ports.toolRuntime.turnSummary) {
        try {
          const current = this.ports.toolRuntime.turnSummary(sessionId, stepTurnKey(steps)).checkpointId ?? null;
          if (current) lastCheckpointId = current;
        } catch {
          // A tracker that cannot answer leaves the previously observed checkpoint in place.
        }
      }
      return lastCheckpointId;
    };

    /** C9: one-line, metadata-only description of a finding — never the diff itself. */
    const describeFindings = (findings: ReadonlyArray<{ path: string; kind: string }>): string =>
      findings.slice(0, 5).map((finding) => `${finding.path}:${finding.kind}`).join(", ");

    /**
     * C9: evaluates the change set against the scope guard and the test-integrity guard.
     *
     * Both are pure functions of the change set, so this is reproducible and cannot depend on the model's own
     * description of what it did. The result is written into the run summary and, when something was found,
     * into Activity — where a human reviewing the run will actually see it.
     */
    const evaluateChangeSet = async (): Promise<void> => {
      const changes = runChanges();
      if (!changes.length) return;
      testIntegrity = analyzeTestIntegrity(changes);
      scopeGuard = evaluateScopeGuard({
        changedPaths: changes.map((change) => change.path),
        requestText: prompt,
        maxChangedFiles: this.limits.maxChangedFiles,
      });
      summary.scope = {
        changedFiles: scopeGuard.changedFiles,
        limit: scopeGuard.limit,
        exceeded: scopeGuard.exceeded,
        severity: scopeGuard.severity,
        unrelatedPaths: scopeGuard.unrelatedPaths,
        relatednessUnknown: scopeGuard.relatednessUnknown,
        warnings: scopeGuard.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
          severity: warning.severity,
          paths: warning.paths,
        })),
      };
      for (const warning of scopeGuard.warnings) {
        // `turn` is reused rather than adding a new event kind: the Activity kind vocabulary is constrained by
        // the C6b table's CHECK constraint, and a telemetry kind is not worth a migration.
        await record({
          kind: "turn",
          companyId, projectId, sessionId,
          runId: input.runId,
          turn: steps,
          ok: warning.severity !== "critical",
          reason: warning.code,
        });
      }
      if (testIntegrity.flagged) {
        await record({
          kind: "turn",
          companyId, projectId, sessionId,
          runId: input.runId,
          turn: steps,
          ok: false,
          reason: "test_integrity_flagged",
        });
      }
    };

    /** Maps the verify tool's result onto per-check reports without inventing detail it did not provide. */
    const toCheckReports = (outcome: CodeToolInvokeResult | CodeToolInvokeFailure): VerificationCheckReport[] => {
      if (!outcome.ok) {
        const code = String(outcome.error.code);
        /**
         * Only "the check could not be run at all" is `unavailable`; everything else is a failure. The
         * conservative reading matters here: calling an unknown failure "unavailable" would let a genuine
         * broken build be reported as a deployment gap.
         */
        const state = code === "approval_required"
          ? "approval_required"
          : code === "tool_not_configured" || code === "feature_disabled"
            ? "unavailable"
            : "failed";
        return verificationTools.map((tool) => ({
          tool,
          state,
          code,
          message: outcome.error.message,
        }));
      }
      const payload = outcome.result as { checks?: unknown } | null | undefined;
      const reported = Array.isArray(payload?.checks) ? payload.checks : [];
      const mapped: VerificationCheckReport[] = [];
      for (const entry of reported) {
        if (!entry || typeof entry !== "object") continue;
        const value = entry as Record<string, unknown>;
        const tool = typeof value.tool === "string" ? value.tool : typeof value.name === "string" ? value.name : "unknown";
        const passed = value.ok === true || value.passed === true || value.state === "passed" || value.status === "passed";
        mapped.push({
          tool,
          state: passed ? "passed" : value.state === "unavailable" ? "unavailable" : "failed",
          ...(typeof value.code === "string" ? { code: value.code } : {}),
        });
      }
      if (mapped.length) return mapped;
      // The runner reported success without per-check detail; recording the requested kinds as passed is the
      // truthful reading of `ok: true` and nothing more.
      return verificationTools.map((tool) => ({ tool, state: "passed" }));
    };

    /**
     * C9: runs the requested checks through the **canonical** tool runtime rather than a private path, so the
     * PolicyEngine, RBAC, approval handling and audit all still apply to an automatically triggered
     * verification. A check that needs approval is reported as `approval_required` and stops the loop: the
     * runner must never work around a human decision.
     */
    const runVerification = async (): Promise<void> => {
      const attempt = verificationLoop.report().verificationRuns + 1;
      let outcome: CodeToolInvokeResult | CodeToolInvokeFailure;
      try {
        outcome = await this.ports.toolRuntime.invoke(ctx, {
          companyId,
          projectId,
          sessionId,
          tool: "code.verify.run",
          args: { tools: [...verificationTools], changedOnly: true },
          toolCallId: `verify:${turnId}:${attempt}`,
          turnId,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(stateRunId ? { runId: stateRunId } : {}),
          ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
          ...capabilityScopeFields,
        });
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        outcome = {
          ok: false,
          error: {
            code: (failure.code ?? "verify_error") as CodeToolInvokeFailure["error"]["code"],
            status: 500,
            message: failure.message ?? "Verification failed to run",
            tool: "code.verify.run",
            step: "execute",
            retryable: false,
          },
        };
      }
      const checks = toCheckReports(outcome);
      verificationLoop.record(checks);
      await record({
        kind: "tool_call",
        companyId, projectId, sessionId,
        runId: input.runId,
        turn: steps,
        tool: "code.verify.run",
        toolCallId: `verify:${turnId}:${attempt}`,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { errorCode: String(outcome.error.code) }),
      });
    };

    /**
     * C9: writes the verification outcome into the run summary.
     *
     * The one judgement made here: a verification that passed over a change set that removed or weakened tests
     * is **not** reported as a clean pass. It is `passed_with_unjustified_test_changes`, because a green check
     * mark over a weakened suite is exactly the outcome this guard exists to prevent. Nothing tries to parse a
     * justification out of the model's prose — the flag records that none was seen.
     */
    const writeVerificationSummary = (): void => {
      if (verificationDisabled) return;
      const report: VerificationReport = verificationLoop.report();
      if (report.status === "not_run" && !testIntegrity) return;
      const integrity = testIntegrity;
      const unjustified = integrity?.requiresJustification === true && report.status === "passed";
      summary.verification = {
        schemaVersion: report.schemaVersion,
        status: unjustified ? "passed_with_unjustified_test_changes" : report.status,
        attemptsUsed: report.attemptsUsed,
        maxAttempts: report.maxAttempts,
        verificationRuns: report.verificationRuns,
        requestedTools: [...report.requestedTools],
        failedChecks: report.failedChecks.map((check) => ({
          tool: check.tool,
          ...(check.code ? { code: check.code } : {}),
          /**
           * The check's own message is deliberately **not** copied here. The summary is persisted into the run
           * state, and a verifier's message can quote file content; the model-facing repair instruction carries
           * it instead, where it is conversation and not a metadata record.
           */
        })),
        ...(integrity
          ? {
              testIntegrity: {
                flagged: integrity.flagged,
                requiresJustification: integrity.requiresJustification,
                // No justification was observed. Claiming one was seen would be the fabrication this whole
                // step is about.
                justificationProvided: false,
                findings: integrity.findings.map((finding) => ({
                  path: finding.path,
                  kind: finding.kind,
                  detail: finding.detail,
                })),
                testFilesTouched: [...integrity.testFilesTouched],
                testFilesDeleted: [...integrity.testFilesDeleted],
              },
            }
          : {}),
      };
    };

    /** C9: the message a human reads when verification never passed. Metadata only: tools and codes. */
    const verificationStopMessage = (): string => {
      const failed = verificationLoop.report().failedChecks;
      const detail = failed.length
        ? failed.map((check) => `${check.tool}${check.code ? ` (${check.code})` : ""}`).join(", ")
        : "verification did not run";
      return `Stopped: verification still fails after ${verificationLoop.attemptsUsed()} repair attempt(s): ${detail}.`;
    };

    // ---------------------------------------------------------------------------------------------------
    // C9 (requirement 4): the self-review pass
    // ---------------------------------------------------------------------------------------------------

    /**
     * A stable signature of the current change set: every path with its status and the hash of its diff. It is
     * the input to the one decision the post-review path has to make — "did the fix actually change anything?"
     * — and it is computed from the same tracker the guards read, so it cannot disagree with them.
     */
    const currentChangeSignature = (): string => {
      const changes = runChanges().slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return changes.map((change) => `${change.path}:${change.status ?? ""}:${sha256Hex(change.diff ?? "")}`).join("|");
    };

    /** The diff text handed to the review: bounded, with the truncation stated rather than hidden. */
    const boundedDiff = (limit: number): string => {
      const parts = runChanges()
        .filter((change) => typeof change.diff === "string" && change.diff.length > 0)
        .map((change) => `--- ${change.path}\n${change.diff ?? ""}`);
      const joined = parts.join("\n");
      const bound = bounded(joined, limit);
      return bound.truncated ? `${bound.text}\n[the diff shown to this review was truncated at ${limit} characters]` : bound.text;
    };

    /** The plan block for the review. `null` (no block) is what an absent or unreadable plan yields. */
    const loadApprovedPlan = async (): Promise<string | null> => {
      const port = this.ports.sessionPlan;
      if (!port) return null;
      try {
        const plan = await port.load({ ctx, companyId, projectId, sessionId });
        if (!plan) return null;
        const lines = [
          `revision: ${plan.revision} (status: ${plan.status})`,
          `execution mode chosen by the user: ${plan.executionMode ?? "not recorded"}`,
          "files:",
          ...(plan.plan.files.length ? plan.plan.files.map((file) => `- ${file}`) : ["- (none listed)"]),
          "steps:",
          ...(plan.plan.steps.length ? plan.plan.steps.map((step, index) => `${index + 1}. ${step}`) : ["(none listed)"]),
          "risks:",
          ...(plan.plan.risks.length ? plan.plan.risks.map((risk) => `- ${risk}`) : ["- (none listed)"]),
          `test strategy: ${plan.plan.testStrategy || "(not stated)"}`,
        ];
        return lines.join("\n");
      } catch {
        // Fail-soft with an honest record: the review is told it has no plan (`inputs.approvedPlan: false`)
        // rather than being handed a fabricated one, and an unreadable plan never stops a run.
        return null;
      }
    };

    /** The verification input as text for the review. Metadata only: tools, codes and counts. */
    const verificationForReview = (): string => {
      const report = verificationLoop.report();
      if (!summary.verification && report.verificationRuns === 0) return "verification did not run for this change";
      const status = summary.verification?.status ?? report.status;
      const failed = report.failedChecks.map((check) => `${check.tool}${check.code ? ` (${check.code})` : ""}`);
      return [
        `status: ${status}`,
        `verification runs: ${report.verificationRuns}`,
        `repair attempts used: ${report.attemptsUsed} of ${report.maxAttempts}`,
        `requested checks: ${report.requestedTools.join(", ") || "(none)"}`,
        `failing checks: ${failed.join(", ") || "(none)"}`,
      ].join("\n");
    };

    /** The test-integrity input as text for the review. Metadata only: paths, kinds and counts. */
    const testIntegrityForReview = (): string => {
      const integrity = testIntegrity;
      if (!integrity) return "test integrity did not run (no change set was inspected)";
      return [
        `flagged: ${integrity.flagged}`,
        `requires justification: ${integrity.requiresJustification}`,
        `test files touched: ${integrity.testFilesTouched.join(", ") || "(none)"}`,
        `test files deleted: ${integrity.testFilesDeleted.join(", ") || "(none)"}`,
        `findings: ${integrity.findings.map((finding) => `${finding.path}:${finding.kind}`).join(", ") || "(none)"}`,
      ].join("\n");
    };

    const toFindingSummary = (finding: SelfReviewFinding): CodingAgentSelfReviewFinding => ({
      id: finding.id,
      category: finding.category,
      severity: finding.severity,
      file: finding.file,
      reason: finding.reason,
      suggestedFix: finding.suggested_fix,
      blocking: finding.blocking,
    });

    /** Writes the verdict into the run summary. Every terminal path calls this once verification ran. */
    const writeSelfReviewSummary = (): void => {
      const verdict = selfReviewVerdict;
      if (!verdict) return;
      summary.selfReview = {
        schemaVersion: SELF_REVIEW_SCHEMA_VERSION,
        status: verdict.status,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        ...(verdict.detail ? { detail: verdict.detail } : {}),
        ran: verdict.ran,
        reviewRuns: verdict.reviewRuns,
        iterationsUsed: verdict.iterationsUsed,
        maxIterations: verdict.maxIterations,
        fixApplied: verdict.fixApplied,
        findingsCount: verdict.findings.length,
        blocking: verdict.blocking,
        unresolved: verdict.unresolved.length,
        findings: verdict.findings.map(toFindingSummary),
        inputs: verdict.inputs,
        reviewHash: verdict.reviewHash,
      };
    };

    /**
     * Runs the one self-review pass of this run.
     *
     * `selfReviewPasses` is checked **here in addition to** the module's own single-pass guard. Both are
     * deliberate: the module makes a second pass impossible, and this counter makes it observable — a test can
     * assert that the runner only ever asked once, rather than having to reason about the module's internals.
     *
     * The pass is never gated on verification passing. The verification result is one of its six inputs, so a
     * review of a change whose checks failed is exactly what the input is for; what the review must never do is
     * run before verification, because then it would review a change nobody checked.
     */
    const runSelfReview = async (): Promise<void> => {
      const state = selfReviewState;
      if (!state) return;
      const verdict = await state.execute({
        input: {
          originalGoal: prompt,
          approvedPlan: await loadApprovedPlan(),
          finalDiff: boundedDiff(this.selfReviewDiffChars),
          changedFiles: runChanges().map((change) => ({
            path: change.path,
            tool: change.tool,
            ...(change.status !== undefined ? { status: change.status } : {}),
          })),
          verification: verificationForReview(),
          testIntegrity: testIntegrityForReview(),
        },
        reviewRequest: state.request(),
        chat: async (request) => {
          try {
            const result = await this.ports.engine.chat({
              messages: request.messages,
              // No tools: the review reads and reports. Offering the tool list would let the review act, and
              // the whole point of this pass is that its output is data.
              model: input.model,
              ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
              signal: input.signal,
              idempotencyKey: request.idempotencyKey,
              policyContext: {
                companyId,
                projectId,
                sessionId,
                dataClassification: session.dataClassification,
              },
            });
            return { ok: true as const, content: result.content ?? "" };
          } catch (error) {
            const failure = error as { code?: string; message?: string };
            return { ok: false as const, code: failure.code ?? "review_call_failed", message: failure.message };
          }
        },
        // The review request is provider-bound content, so it passes the **existing** C5b guard — the same
        // policy resolution, classification ceiling, content-type rules, private-code rule and redaction list
        // as a real call. There is deliberately no second scanner here, and a refused text is refused rather
        // than sanitised: the guard's whole contract is that a placeholder must never be substituted in.
        ...(this.ports.providerDataGuard
          ? {
              guardPrompt: async (text: string) => {
                await this.ports.providerDataGuard!.guardProviderBoundText(text, {
                  model: input.model,
                  policyContext: {
                    companyId,
                    projectId,
                    sessionId,
                    dataClassification: session.dataClassification,
                  },
                });
              },
            }
          : {}),
      });
      selfReviewVerdict = verdict;
      writeSelfReviewSummary();
      await record({
        kind: "turn",
        companyId, projectId, sessionId,
        runId: input.runId,
        turn: steps,
        // A metadata-only line: counts, categories, status and the profile that produced them. `describeSelfReview`
        // never carries a finding's reason, and the reason vocabulary is closed, so nothing content-shaped can
        // reach the Activity table.
        ok: verdict.status === "clean" || verdict.status === "repaired",
        reason: `${describeSelfReview(verdict)} profile=${this.ports.selfReview?.profileId ?? "run-default"}`,
      });
    };

    /**
     * Creates the run's **single** review state. Called exactly twice in this method, and both call sites are
     * mutually exclusive: the "nothing to verify and nothing to review" exit, and the one pass that follows
     * verification. `selfReviewPasses` makes a third call impossible even by accident, and the state's own
     * `execute` is a no-op after its first call — belt and braces, because this is the property the owner asked
     * for in so many words.
     */
    const beginSelfReviewState = (): SelfReviewVerdict | null => {
      if (selfReviewPasses > 0 && selfReviewState) return selfReviewState.report();
      selfReviewPasses += 1;
      selfReviewState = createSelfReview({
        input: { finalDiff: boundedDiff(this.selfReviewDiffChars) },
        ...(this.ports.selfReview?.maxFixIterations !== undefined
          ? { maxFixIterations: this.ports.selfReview.maxFixIterations }
          : { maxFixIterations: this.limits.selfReviewFixIterations }),
        ...(this.ports.selfReview?.enabled !== undefined ? { enabled: this.ports.selfReview.enabled } : {}),
      });
      return selfReviewState.report();
    };

    /**
     * Runs the checks once and turns the loop's decision into the outcomes the caller has to tell apart:
     *
     * - `repair` — a repair round is available; the instruction has been pushed onto the transcript.
     * - `approval_required` — a check needs a human; the run stops without reviewing, because the review cannot
     *   change an approval-gated outcome.
     * - `unavailable` — the checks could not run at all; the run stops without reviewing, because reviewing a
     *   change nobody could check would not make the check happen.
     * - `exhausted` — the repair budget is gone and the checks still fail; the caller goes on to review and then
     *   stops with `verification_failed`.
     * - `passed` — the checks passed (with the test-integrity caveat already applied to the summary).
     */
    const verifyAndDecide = async (): Promise<"passed" | "repair" | "approval_required" | "unavailable" | "exhausted"> => {
      await runVerification();
      /**
       * The signature is recorded from the change set that the checks just saw. It is the baseline the
       * post-review comparison uses, so "the review fix changed nothing" is measured against the exact tree
       * that was verified rather than against a tree captured at some other moment.
       */
      verifiedSignature = currentChangeSignature();
      writeVerificationSummary();
      const decision = verificationLoop.decide();
      if (decision.decision === "repair") {
        messages.push({ role: "system", content: formatRepairInstruction(verificationLoop.report()) });
        await record({
          kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps,
          reason: "verification_repair",
        });
        return "repair";
      }
      if (decision.decision === "complete") return "passed";
      if (decision.code === VERIFICATION_APPROVAL_REQUIRED) return "approval_required";
      if (decision.code === VERIFICATION_UNAVAILABLE) return "unavailable";
      return "exhausted";
    };

    /**
     * The single self-review pass. Runs the state's one `execute`, which rebuilds the request from the sources
     * known now and calls the model once.
     *
     * `selfReviewPasses` is incremented by `beginSelfReviewState` before this runs, so a hypothetical second
     * call would still go through the state — whose `execute` returns the first verdict without a model call.
     * Two independent mechanisms, one outcome: one pass per run.
     */
    const beginSelfReview = async (): Promise<void> => {
      beginSelfReviewState();
      await runSelfReview();
    };

    /**
     * The post-review path, and the only place a self-review-driven fix can be started.
     *
     * The order is the owner's, exactly: implement → verify → repair (≤3) → **self-review once** → optionally
     * **one** fix iteration → **re-verify if the review changed the code** → finish. Everything that could
     * re-open the review is absent by construction: there is no second `beginSelfReview` call on this path, and
     * `selfReviewState.execute` is a no-op after its first call.
     */
    const afterSelfReview = async (): Promise<{ action: "complete" } | { action: "stop"; reason: CodingAgentStopReason; message: string } | { action: "continue" }> => {
      const verdict = selfReviewVerdict;
      if (!verdict) return { action: "complete" };

      if (verdict.status === "unavailable") {
        // "We did not check" is never "clean". The run stops and says why; the summary keeps the reason.
        return { action: "stop", reason: "self_review_unavailable", message: selfReviewStopMessage(verdict) };
      }

      if (verdict.status === "findings") {
        const instruction = selfReviewState?.applyFix() ?? null;
        if (instruction) {
          // The single fix iteration. The instruction goes back to the model as conversation, and the run
          // continues so the model can act on it.
          messages.push({ role: "system", content: instruction });
          selfReviewFixPending = true;
          await record({
            kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps,
            reason: "self_review_fix",
          });
          return { action: "continue" };
        }
        // No fix iteration available (the budget is zero, or findings are non-blocking only). Findings that
        // nobody may fix are reported as unresolved rather than quietly completed.
        const blocking = verdict.findings.filter((finding) => finding.blocking);
        if (blocking.length) {
          selfReviewState?.noteFixOutcome(false);
          selfReviewVerdict = selfReviewState?.report() ?? verdict;
          writeSelfReviewSummary();
          return { action: "stop", reason: "self_review_unresolved", message: selfReviewStopMessage(selfReviewVerdict) };
        }
        return { action: "complete" };
      }

      if (verdict.status === "unresolved") {
        return { action: "stop", reason: "self_review_unresolved", message: selfReviewStopMessage(verdict) };
      }

      return { action: "complete" };
    };

    /**
     * Closes the fix iteration once the model has stopped calling tools again.
     *
     * The comparison against `verifiedSignature` is what decides whether a second verification runs, and it is a
     * fact about the tree rather than the model's claim about it. A fix that changed nothing must not silently
     * pass for "verified after the review": it is reported as `unresolved` instead, because the findings the
     * review raised are still standing over exactly the tree that was already checked.
     */
    const afterSelfReviewFix = async (): Promise<{ action: "complete" } | { action: "stop"; reason: CodingAgentStopReason; message: string }> => {
      const changed = currentChangeSignature() !== verifiedSignature;
      selfReviewFixPending = false;
      if (!changed) {
        /**
         * The model answered the review without changing anything. The findings stand, and a run whose review
         * found something blocking is not allowed to call itself complete — so no re-verification is run for a
         * tree that was already checked, and the verdict is closed against the findings.
         */
        selfReviewState?.noteFixOutcome(false);
        selfReviewVerdict = selfReviewState?.report() ?? selfReviewVerdict;
        writeSelfReviewSummary();
        const outstanding = (selfReviewVerdict?.unresolved ?? []).filter((finding) => finding.blocking);
        if (outstanding.length) {
          return { action: "stop", reason: "self_review_unresolved", message: selfReviewStopMessage(selfReviewVerdict ?? undefined) };
        }
        return { action: "complete" };
      }

      /**
       * The review changed the code, so the checks run **again** — unconditionally, and before anything else is
       * concluded. This is the mandatory re-verification, and it is deliberately not the same decision as the
       * pre-review one: there is no repair budget consumed here, because the review fix is not a repair round
       * and a run must not be able to buy repairs by looping through reviews.
       *
       * The verdict is closed only **after** this run, because "the fix resolved the blocking findings" is a
       * claim the checks have to support: `noteFixOutcome(true)` is what turns the review's findings into
       * `repaired`, and it is called only when the re-verification passes.
       */
      const runAttempt = verificationLoop.report().verificationRuns + 1;
      let outcome: CodeToolInvokeResult | CodeToolInvokeFailure;
      try {
        outcome = await this.ports.toolRuntime.invoke(ctx, {
          companyId,
          projectId,
          sessionId,
          tool: "code.verify.run",
          args: { tools: [...verificationTools], changedOnly: true },
          toolCallId: `verify:self-review:${turnId}:${runAttempt}`,
          turnId,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(stateRunId ? { runId: stateRunId } : {}),
          ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
          ...capabilityScopeFields,
        });
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        outcome = {
          ok: false,
          error: {
            code: (failure.code ?? "verify_error") as CodeToolInvokeFailure["error"]["code"],
            status: 500,
            message: failure.message ?? "Verification failed to run",
            tool: "code.verify.run",
            step: "execute",
            retryable: false,
          },
        };
      }
      const checks = toCheckReports(outcome);
      // The loop records the checks so the summary reports what the checks said after the review fix. Its repair
      // budget is deliberately **not** consumable here: the single self-review fix is not a repair round, so a
      // failed re-verification stops the run instead of buying another round. The loop is closed for repairs
      // before anything else can ask it for one.
      verificationLoop.record(checks);
      verificationLoop.blockFurtherRepairs();
      writeVerificationSummary();
      await record({
        kind: "tool_call",
        companyId, projectId, sessionId,
        runId: input.runId,
        turn: steps,
        tool: "code.verify.run",
        toolCallId: `verify:self-review:${turnId}:${runAttempt}`,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { errorCode: String(outcome.error.code) }),
        reason: "self_review_reverify",
      });

      const failed = checks.filter((check) => check.state !== "passed");
      if (failed.length) {
        /**
         * Still failing after the review-driven change: the fixing pass did not resolve the findings, so the
         * verdict is closed **against** them (`noteFixOutcome(false)`) and the run stops rather than looping.
         * There is no second self-review and no further fix iteration, so this is the honest end of the road —
         * and the blocking findings the review raised stay visible in the summary next to the verification
         * failure, instead of being dropped because a fix was attempted.
         */
        selfReviewState?.noteFixOutcome(false);
        selfReviewVerdict = selfReviewState?.report() ?? selfReviewVerdict;
        writeSelfReviewSummary();
        return {
          action: "stop",
          reason: "verification_failed",
          message: `Stopped: the checks still fail after the self-review fix (${failed.map((check) => check.tool).join(", ")}).`,
        };
      }
      // The checks passed again over the changed tree, so the blocking findings were acted on. This is what turns
      // the verdict into `repaired`; it is called after the checks, never before them.
      selfReviewState?.noteFixOutcome(true);
      selfReviewVerdict = selfReviewState?.report() ?? selfReviewVerdict;
      writeSelfReviewSummary();
      return { action: "complete" };
    };

    try {
      // (1) Feature flag: the master switch gates everything, deny by default when unconfigured.
      await this.ports.flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId, userId: ctx.userId });
      // (2) RBAC: the permission is derived from the action, never from a caller-supplied label.
      await this.ports.rbac.authorize(ctx, companyId, {
        action: CODE_RUN_START_ACTION,
        permission: CODE_RUN_START_PERMISSION,
        projectId,
        sessionId,
        mode: session.mode,
      });
      // (3a) Deployment admission (C6a reaper): the flag is read here so it is actionable, not decorative.
      // A gate that cannot answer refuses the run: an unavailable verdict must never let work through.
      if (this.ports.admissionGate) {
        let refusing = false;
        let code = "disk_pressure";
        try {
          refusing = this.ports.admissionGate.isRefusingNewRuns() === true;
          code = this.ports.admissionGate.refusalCode?.() ?? code;
        } catch {
          refusing = true;
          code = "admission_gate_unavailable";
        }
        if (refusing) {
          return finish(
            "failed",
            "refused",
            `The deployment is refusing new runs (${code}); the run was not started.`,
            code,
          );
        }
      }
      // (3) Sandbox image admission (C1b). Absent policy or a refusal stops the run before any model call.
      if (input.imageReference) {
        if (!this.ports.imageAdmission) {
          return finish("failed", "refused", "Sandbox image admission policy is not configured; the run was not started.");
        }
        const admitted = await this.ports.imageAdmission.admit(ctx, { companyId, reference: input.imageReference });
        // C6b: the admitted digest is the only reproducible identity of the environment, so it is handed to
        // the snapshot sources (the provider is per-process, the digest is per-run).
        this.ports.environment?.setSandboxImage({
          digest: admitted.digest ?? null,
          ...(admitted.sbomRef !== undefined ? { sbomRef: admitted.sbomRef } : {}),
        });
      }
      // (3b) Policy composition + per-run environment facts for the snapshot. Every reader is fail-soft: a
      // reader that cannot answer leaves **its own** field null, never the whole environment.
      const readerInput = {
        ctx,
        companyId,
        projectId,
        ...(sessionId ? { sessionId } : {}),
        ...(input.model ? { model: input.model } : {}),
      };
      const readFact = async <T>(read: (() => Promise<T | null>) | undefined): Promise<T | null> => {
        if (!read) return null;
        try {
          return await read();
        } catch {
          return null;
        }
      };
      const policyComposition = await createCodeRunPolicyComposition({
        ctx,
        companyId,
        projectId,
        ...(sessionId ? { sessionId } : {}),
        ...(this.ports.policyCompositionSources ? { sources: this.ports.policyCompositionSources } : {}),
      });
      this.ports.environment?.setPolicyComposition(policyComposition);
      const factSources = this.ports.policyCompositionSources;
      this.ports.environment?.setFeatureFlags(
        await readFact(factSources?.featureFlags ? () => factSources.featureFlags!(readerInput) : undefined),
      );
      this.ports.environment?.setProviderDataPolicy(
        await readFact(
          factSources?.providerDataPolicy ? () => factSources.providerDataPolicy!(readerInput) : undefined,
        ),
      );
      this.ports.environment?.setBaseCommit(
        await readFact(
          factSources?.baseCommit
            ? () => factSources.baseCommit!({ ctx, companyId, projectId })
            : undefined,
        ),
      );
      this.ports.environment?.setToolchain(
        await readFact(
          factSources?.toolchain ? () => factSources.toolchain!({ ctx, companyId, projectId }) : undefined,
        ),
      );
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return finish("failed", "refused", failure.message ?? `The run was refused (${failure.code ?? "refused"}).`);
    }

    await this.ports.runEvents?.append({
      eventKey: `code-run-start:${turnId}`,
      eventType: "started",
      runStatus: "running",
      message: "Coding Agent run started",
    });
    await record({ kind: "run_started", companyId, projectId, sessionId, runId: input.runId, reason: session.mode });

    /**
     * C13: `SessionStart`. Emitted here, not earlier, because everything above is a refusal path: the master
     * flag, RBAC, deployment admission and image admission have all passed, so this is the first moment at
     * which "the run is really starting" is true. A refused run therefore never fires a project hook, which
     * is the same rule the tool path applies to a denied call.
     */
    try {
      await this.ports.lifecycleHooks?.sessionStart({
        ctx, companyId, projectId, sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(stateRunId ? { runId: stateRunId } : {}),
        snapshotId: snapshotId ?? null,
      });
    } catch {
      // A hook never changes a run's outcome.
    }

    // (5) C6a: durable run state + lease. A run whose state cannot be recorded is refused rather than run
    // "invisibly": without the row there is no turn boundary, and a crash would leave a mutating tool call
    // with no record that it ever started. This is the only state write that is allowed to fail the run.
    const useInbox = (!input.subagentScope || input.detachedChildInbox === true) && !!this.ports.inbox && await this.ports.inbox.isEnabled(ctx, companyId);
    if (this.ports.runState) {
      try {
        const startedState = await this.ports.runState.startRun({
          ctx,
          companyId,
          projectId,
          sessionId,
          owner: stateOwner,
          ...(input.runDetails ? { details: input.runDetails } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          /**
           * C10: the run's **original request**, written by the same statement that creates the run. Until this
           * existed the request lived only in the live request body — the replay bundle records the model's side
           * (its answers and the settled tool results) and is written once, on the terminal path, so a run that
           * crashed mid-flight left no copy of what the user asked for at all and a resume could not
           * reconstruct it.
           *
           * It is stored here, before the first model step and before any tool call, so a process that dies
           * immediately after start still leaves the request behind. Only the first `startRun` of a run id can
           * write it (the store's create is idempotent by run id), so a resume re-entering the loop with the
           * reconstructed continuation prompt cannot overwrite the user's own words. The class travels with it
           * from the session, which is the same source the replay bundle and the snapshots copy theirs from.
           */
          /**
           * C13: the **expanded** prompt is what is stored, not the raw `/name args` line. A resume rebuilds the
           * continuation from this value, so recording the raw line would make the resumed run see different
           * text than the run it is continuing — the exact drift the rest of this file works to prevent. The
           * expansion is a deterministic function of the raw prompt and the recorded command version, so the
           * stored text is reproducible rather than merely convenient.
           */
          request: prompt,
          dataClassification: session.dataClassification,
          retentionClass: session.retentionClass,
        });
        if (useInbox && !(await this.ports.runState.renewLease({ companyId, runId: startedState.runId, owner: stateOwner })).held) {
          return finish("interrupted", "interrupted", "Another worker already owns this run. No model or tool was dispatched.");
        }
        stateRunId = startedState.runId;
        /**
         * C10: link the session to its run. `code_sessions.run_id` had a reader (`lastRun`, `usage`) and an
         * update path, but no writer, so both were permanently `null` and a resume could not find "the run of
         * this session" without being told. Best effort: the run row above is the source of truth for the run
         * itself, and a failed link must not abort work that is already admitted.
         */
        if (this.ports.sessionRunLink && session.runId !== stateRunId) {
          try {
            const link = await this.ports.sessionRunLink({
              ctx, companyId, projectId, sessionId, runId: stateRunId,
            });
            if (!link.linked) {
              this.ports.logger?.warn("code_session_run_link_failed", {
                sessionId, runId: stateRunId, reason: link.reason ?? "unknown",
              });
            }
          } catch (error) {
            this.ports.logger?.warn("code_session_run_link_error", {
              sessionId, runId: stateRunId, reason: (error as Error).message,
            });
          }
        }
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        return finish(
          "failed",
          "refused",
          failure.message ?? `The run state could not be recorded (${failure.code ?? "state_unavailable"}).`,
        );
      }
      // The lease is renewed on a timer, not only between turns: a single long shell command must not let the
      // lease expire and hand the run to a reconciler while this process is still working.
      const heartbeatEveryMs = Math.max(1_000, this.limits.runHeartbeatMs);
      heartbeatTimer = setInterval(() => {
        if (!stateRunId || leaseLost) return;
        void this.ports.runState!.renewLease({ companyId, runId: stateRunId, owner: stateOwner })
          .then((verdict) => { if (!verdict.held) leaseLost = true; })
          .catch(() => undefined);
      }, heartbeatEveryMs);
      heartbeatTimer.unref?.();
    }

    /**
     * C12: the **one** capability-scope object this run uses, computed before anything is offered or executed.
     *
     * Every decision below reads this object and nothing else: which tools the model is offered (`tools`), whether
     * the delegation tool exists for this run (`mayDelegate`, false for any run with a parent), what travels into
     * the tool runtime on every call (`tools` again), and which depth the shared budget is checked at. One object,
     * one source of truth — the shape C11 gave the read-only intent, applied to delegation.
     *
     * A delegated run whose record is missing or whose grant was an unresolvable wildcard is **refused**, not
     * quietly widened: inheriting the parent's whole surface is precisely the escalation this step removes.
     */
    const capabilityScope = resolveCodeRunCapabilityScope({
      parentRunId: input.subagentScope?.parentRunId ?? null,
      allowedTools: input.subagentScope?.allowedTools ?? null,
      canonicalTools: this.publishedTools().map((tool) => tool.name),
      maxDepth: this.subagentLimits.maxDepth,
    });
    if (capabilityScope.source === "subagent_scope_missing" || capabilityScope.source === "subagent_wildcard_unresolved") {
      const detail = capabilityScope.source === "subagent_scope_missing"
        ? "no capability scope was recorded for it"
        : "its recorded capability scope was a wildcard with no published tool universe to resolve against";
      return finish(
        "failed",
        "refused",
        `The delegated run was not started: ${detail}. A subagent run receives the intersection its delegation recorded, never its parent's full tool set.`,
      );
    }
    /**
     * The runtime fields every tool call of this run carries. Spread into each call site so the enforcement half
     * cannot be forgotten at one of them: the tool runtime refuses a delegation tool for a run with a parent and
     * any tool outside the recorded scope, before the sub-flag, the arguments, the approval and the executor.
     */
    const capabilityScopeFields = {
      ...(input.subagentWritePaths ? { subagentWritePaths: input.subagentWritePaths } : {}),
      ...(capabilityScope.tools ? { capabilityScope: capabilityScope.tools } : {}),
      ...(capabilityScope.parentRunId ? { parentRunId: capabilityScope.parentRunId } : {}),
    };
    /** C12: this run's depth in the delegation tree (1 = main run, 2 = its child) for the shared budget. */
    const delegationDepth = subagentDepthForRun(capabilityScope.parentRunId);

    /**
     * C12: this run's assistant-turn ceiling. A delegated run may be given a smaller budget than the
     * deployment's global `maxStepsPerRun` (the sub-agent type's limit); a run that asked for nothing keeps the
     * global limit **exactly** as it was, because defaulting a root run into the canonical sub-agent ceiling
     * would silently shorten every ordinary run.
     */
    const runTurnLimit = input.maxTurns === undefined
      ? this.limits.maxStepsPerRun
      : clampCodeSubagentTurnLimit(input.maxTurns, this.limits.maxStepsPerRun);

    /**
     * C11 (owner decision 8): a coding session works on its own branch, never on the repository's main branch.
     *
     * The step runs **before** the first model step and before any tool call, so there is no window in which
     * the agent could already have written to main. It is skipped for a read-only intent: a review must not
     * change the checkout either.
     *
     * A failure to establish the branch **stops the run**. That is the fail-closed direction: the alternative
     * is to keep working on whatever branch happens to be checked out, which is the outcome this step exists
     * to prevent — and a run that silently worked on main would be indistinguishable from one that honoured
     * the rule until somebody looked at the repository.
     */
    let sessionBranch: { branch: string; created: boolean; switched: boolean; previousBranch: string | null } | null = null;
    if (this.ports.ensureSessionBranch && input.readOnlyIntent !== true) {
      try {
        sessionBranch = await this.ports.ensureSessionBranch({ ctx, companyId, projectId, sessionId });
        await record({
          kind: "session_branch",
          companyId,
          projectId,
          sessionId,
          ...(stateRunId ? { runId: stateRunId } : {}),
          branch: sessionBranch.branch,
          branchCreated: sessionBranch.created,
          branchSwitched: sessionBranch.switched,
          reason: sessionBranch.previousBranch ? `from:${sessionBranch.previousBranch}` : "from:none",
        });
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        return finish(
          "failed",
          "refused",
          `The session branch could not be established, so the run was not started (${failure.code ?? "branch_unavailable"}): ${failure.message ?? "unknown error"}`,
        );
      }
    }

    /**
     * C13 (owner requirement: **fresh-process MCP acceptance**): discovery happens here, on the run path,
     * **once per run**, and nothing about it is conditional on a Capability Inspector having been opened or on
     * any other warm-up call. This is the last moment before the model-visible tool list is built and before
     * the ExecutionSnapshot (which pins the runtime manifest) is created, so:
     *
     *   discovery -> risk assignment -> the tenant's overlay -> *these* descriptors -> snapshot -> model call.
     *
     * Failure is deliberately **not** fail-open and deliberately **not** fatal to the run:
     *   - the port answers with an empty tool list and a `code` for "no integration", "`code.mcp` off", "the
     *     server could not be listed" or "the pass failed"; that code is recorded by the port (Activity,
     *     metadata only) and logged here, so a swallowed error would be visible rather than silent;
     *   - a port that throws is treated the same way and cannot stop the run, because a runtime provider is an
     *     *additional* capability surface: losing it costs MCP tools, never the task;
     *   - what is **not** possible is an empty answer that looks like "everything is fine": the discovery code
     *     travels in the run's result and in the Activity event, and the overlay is left empty rather than
     *     stale, so an MCP tool is neither offered to the model nor executable.
     */
    let runtimeToolDescriptors: readonly CodeRunRuntimeToolDescriptor[] = [];
    let runtimeDiscovery: CodeRunRuntimeDiscovery | null = null;
    if (this.ports.runtimeCapabilities) {
      try {
        runtimeDiscovery = await this.ports.runtimeCapabilities.prepareForRun({
          ctx,
          companyId,
          projectId,
          ...(sessionId ? { sessionId } : {}),
          ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
        });
        runtimeToolDescriptors = runtimeDiscovery.tools;
        if (runtimeDiscovery.code) {
          this.ports.logger?.warn("code_run_runtime_capabilities_degraded", {
            companyId,
            code: runtimeDiscovery.code,
            toolCount: runtimeDiscovery.toolCount,
          });
        }
      } catch (error) {
        // A throwing port adds no capability and does not remove any of the static ones: fail closed on MCP,
        // keep the run.
        runtimeDiscovery = null;
        runtimeToolDescriptors = [];
        this.ports.logger?.warn("code_run_runtime_capabilities_failed", {
          companyId,
          code: (error as { code?: string }).code ?? "runtime_capabilities_unavailable",
        });
      }
    }
    /**
     * Every later use of the tool list (the system prompt, the model definitions, the argument validator, the
     * replay recorder's tool versions and the execution dispatch below) reads this one object, so the offered
     * tools and the executable tools cannot drift within a run.
     */
    const toolOptions = {
      asyncProcessesEnabled: !!this.ports.asyncProcessesEnabled && await this.ports.asyncProcessesEnabled(ctx, companyId, projectId),
      asyncSubagentsEnabled: !!this.ports.asyncSubagentsEnabled && await this.ports.asyncSubagentsEnabled(ctx, companyId),
      asyncAgentControlsEnabled: !!this.ports.asyncAgentControlsEnabled && await this.ports.asyncAgentControlsEnabled(ctx, companyId),
      readOnlyIntent: input.readOnlyIntent === true,
      capabilityScope,
      runtimeTools: runtimeToolDescriptors,
    };

    const tools = this.toolDescriptors(session, toolOptions);
    const modelName = input.model ?? "auto";
    /**
     * C6b/C14: the provider this run is about to use, derived from the engine/model id (`anthropic/claude-…`
     * -> `anthropic`). It is computed **here**, before the profile is resolved, for one reason: a profile may
     * match on the provider (`profileMatchSpecificity` ranks an exact model above a pattern above a provider),
     * and the same value is what the ExecutionSnapshot records as `modelSelection.provider`. Deriving it once
     * keeps the profile the model was driven with and the provider the run claims in step.
     */
    const modelProviderHint = modelName.includes("/") ? (modelName.split("/")[0] ?? modelName) : modelName;
    /**
     * C6/C14: which registry profiles this run may match. The composition supplies a per-run resolver over the
     * `code.model_profile.<id>` flags; a deployment that supplies only the static list keeps working, and a
     * resolver that throws narrows to **no** profile instead of widening to all of them.
     */
    let enabledProfileIds = this.ports.modelProfiles?.enabledProfileIds;
    if (this.ports.modelProfiles?.enabledProfileIdsForRun) {
      try {
        const resolved = await this.ports.modelProfiles.enabledProfileIdsForRun({
          ctx,
          companyId,
          projectId,
          ...(sessionId ? { sessionId } : {}),
        });
        if (resolved) enabledProfileIds = resolved;
      } catch {
        // Fail closed: an unreadable flag store disables every profile, so the run continues on the
        // conservative default (one call at a time, auto-detected tool calling) rather than the whole registry.
        enabledProfileIds = [];
      }
    }
    // Profiles come from configuration (injected registry/overrides/enabled ids); an unknown model with no
    // configuration falls back to the conservative profile rather than a guessed capability set.
    const profileResolution = resolveModelProfile({
      provider: modelProviderHint,
      model: modelName,
      ...(this.ports.modelProfiles?.profiles ? { profiles: this.ports.modelProfiles.profiles } : {}),
      ...(this.ports.modelProfiles?.overrides ? { overrides: this.ports.modelProfiles.overrides } : {}),
      // An empty list is a real answer ("nothing is enabled"), so it is passed on: `undefined` would mean
      // "no filter", which is the widening this port exists to prevent.
      ...(enabledProfileIds ? { enabledProfileIds } : {}),
    });
    const profile: CodeModelProfile = profileResolution.profile;
    /**
     * C14: which profile this run got, how it matched, and — when it is the conservative one — **why**.
     *
     * The reason is the whole point: `conservative-default` reads the same whether the operator has not enabled
     * a profile yet (`profile_flag_disabled`) or the model simply has none (`no_matching_profile`), and those two
     * need different actions. It is published through the holder (the snapshot's source) *and* kept for the
     * Activity events of this run, so a degradation is visible in both records rather than only in the log.
     */
    const resolvedProfileTrace = modelProfileFallbackTrace(profileResolution, { enabledProfileIds: enabledProfileIds ?? null });
    modelProfileFallbackReason = resolvedProfileTrace.fallbackReason;
    this.ports.environment?.setModelProfileTrace(resolvedProfileTrace);
    const schemaByName = this.toolSchemaByName(runtimeToolDescriptors);
    // The canonical schemas feed both the tool definitions and the argument validator. A tool without a
    // published schema is offered with an empty one, which the canonical validator treats as "no
    // constraints" — it never invents a schema the registry does not have. A runtime MCP tool's schema comes
    // from the discovery, which is the only schema the server actually declared.
    const knownTools: KnownTool[] = tools.map((tool) => ({
      name: tool.name,
      inputSchema: schemaByName.get(tool.name)?.inputSchema ?? {},
    }));
    const definitions = this.chatToolDefinitions(tools, runtimeToolDescriptors);
    // The engine can tell us whether the wire format supports native tool calls; `auto` mode uses that as
    // evidence instead of guessing. A failed probe leaves the conservative text protocol in place.
    let engineSupportsNativeTools = false;
    if (this.ports.engine.supportsNativeTools) {
      try {
        engineSupportsNativeTools = (await this.ports.engine.supportsNativeTools(input.model)) === true;
      } catch {
        engineSupportsNativeTools = false;
      }
    }

    // C8: load the effective project instructions before the prompt is built, and remember the *same* value so
    // the snapshot describes exactly the block the model received. A failure here yields no block at all: an
    // unreadable instruction file must neither stop the run nor quietly become an empty "trusted" one.
    let projectInstructions: { body: string; contentHash: string | null; trusted: boolean } | null = null;
    if (this.ports.projectInstructions) {
      try {
        projectInstructions = await this.ports.projectInstructions.load({ ctx, companyId, projectId });
      } catch {
        projectInstructions = null;
      }
    }
    this.ports.environment?.setProjectInstructions(      projectInstructions
        ? { contentHash: projectInstructions.contentHash, trustStatus: projectInstructions.trusted ? "trusted" : "untrusted" }
        : null,
    );

    /**
     * C8: company memory and Website Builder project context. Both are optional and fail-soft, and they are
     * rendered as **separate labelled blocks** (trusted tenant rules vs repository data) so repository content
     * never appears with the authority of the tenant's own rules. Neither can influence permissions: the only
     * thing done with them here is insertion into the prompt, below the data invariant.
     */
    let contextBlocks: string | null = null;
    if (this.ports.contextBlocks) {
      try {
        const loaded = await this.ports.contextBlocks.load({
          ctx,
          companyId,
          projectId,
          query: prompt.slice(0, 500),
        });
        if (loaded) {
          contextBlocks = renderContextBlocks([
            loaded.companyMemory ? { header: COMPANY_MEMORY_HEADER, body: loaded.companyMemory, chars: loaded.companyMemory.length, truncated: false } : null,
            loaded.projectContext ? { header: PROJECT_CONTEXT_HEADER, body: loaded.projectContext, chars: loaded.projectContext.length, truncated: false } : null,
          ]) || null;
        }
      } catch {
        contextBlocks = null;
      }
    }

    /**
     * C13: the typed Skill Instructions of this session, rendered **before** the prompt is built so the section
     * the model receives and the provenance the snapshot records come from one call. Fail-soft exactly like the
     * project instructions: an unreadable section yields no section, never a stale one.
     */
    let skillInstructions: string | null = null;
    let skillProvenance: readonly CodeRunSkillProvenance[] = [];
    if (this.ports.skillInstructions) {
      try {
        skillInstructions = await this.ports.skillInstructions.render({ ctx, companyId, projectId, sessionId });
        skillProvenance = skillInstructions
          ? await this.ports.skillInstructions.provenance({ ctx, companyId, projectId, sessionId })
          : [];
      } catch {
        skillInstructions = null;
        skillProvenance = [];
      }
    }
    this.ports.environment?.setSkillInstructions(skillProvenance.length > 0 ? skillProvenance : null);

    const systemPrompt = buildSystemPrompt({
      session,
      tools,
      environment: {
        os: process.platform,
        cwd: `/workspace/${projectId}`,
        date: new Date(startedAt).toISOString().slice(0, 10),
      },
      limits: { ...this.limits, maxStepsPerRun: runTurnLimit },
      ...(projectInstructions ? { instructions: projectInstructions.body } : {}),
      ...(contextBlocks ? { contextBlocks } : {}),
      ...(skillInstructions ? { skillInstructions } : {}),
      ...(input.extraSystemPromptLines ? { extraLines: input.extraSystemPromptLines } : {}),
    });

    // (6) C6b: the configuration facts only exist now that the prompt and the profile are resolved, so they are
    // published first; the snapshot that references them is created immediately after. The snapshot is created
    // **after** the run row exists (its `run_id` is the durable run id and `getSnapshotForRun` finds it), and
    // before the first model call. A failure here never aborts the run: the empty id is honest.
    this.ports.environment?.setModelSelection({ provider: modelProviderHint, model: modelName });
    if (this.ports.snapshotConfigVersions) {
      const configVersions = this.ports.snapshotConfigVersions;
      const configInput = { ctx, companyId, projectId, workspaceId: session.workspaceId, ...(sessionId ? { sessionId } : {}) };
      try {
        const ref = await configVersions.ensureSystemPromptVersion({ ...configInput, promptText: systemPrompt, profileId: profile.id });
        this.ports.environment?.setSystemPrompt(ref ? { version: ref.version, contentHash: ref.contentHash } : null);
      } catch {
        this.ports.environment?.setSystemPrompt(null);
      }
      try {
        this.ports.environment?.setModelProfileVersion(
          await configVersions.ensureModelProfilesVersion({ ...configInput, profile }),
        );
      } catch {
        this.ports.environment?.setModelProfileVersion(null);
      }
    }
    try {
      const snapshot = await this.snapshot.create({
        companyId,
        projectId,
        sessionId,
        workspaceId: session.workspaceId,
        runId: stateRunId ?? input.runId,
        actor: ctx.userId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      snapshotId = snapshot.snapshotId;
    } catch {
      snapshotId = EMPTY_SNAPSHOT_ID;
    }

    /**
     * C6b: the replay recorder is created here, after the run id and the snapshot id exist and after the
     * environment facts were published, so the bundle names the exact environment the run executed in.
     */
    replayRecorder = this.ports.replayBundle?.start({
      companyId,
      projectId,
      sessionId,
      workspaceId: session.workspaceId,
      runId: stateRunId ?? input.runId ?? "",
      ...(snapshotId ? { snapshotId } : {}),
      modelSelection: this.ports.environment?.modelSelection() ?? null,
      systemPrompt: this.ports.environment?.systemPrompt() ?? null,
      modelProfileVersion: this.ports.environment?.modelProfileVersion() ?? null,
      // C13: the same tool list the model was offered, so a runtime MCP call is recorded with the schema
      // version it was made under instead of resolving to `null` (an unresolvable version reads as "the
      // contract did not exist", which would make a replay of that call look like a divergence).
      toolVersions: Object.fromEntries(
        this.toolDescriptors(session, toolOptions).map((tool) => [tool.name, tool.version]),
      ),
      dataClassification: session.dataClassification,
      retentionClass: session.retentionClass,
      // C13: the command provenance is known here (the prompt was resolved before any start-up refusal could
      // return), so the bundle names the exact command versions this run expanded.
      ...(commandPrompt.provenance.length > 0 ? { commandProvenance: commandPrompt.provenance } : {}),
    });
    /** Tool schema versions, so a recorded call carries the contract it was made under. */
    const toolVersionByName = new Map(
      this.toolDescriptors(session, toolOptions).map((tool) => [tool.name, tool.version] as const),
    );
    /**
     * C13: the runtime provider tools of this run by id. A call whose name is in here is executed through the
     * MCP transport (the only path that exists for it); every other name goes to the published static runtime,
     * which answers `unknown_tool` for anything the discovery did not publish. Because this map is built from
     * the very list the model was offered, "the model was told about it" and "the server will run it" are the
     * same fact.
     */
    const runtimeToolByName = new Map(runtimeToolDescriptors.map((tool) => [tool.name, tool] as const));

    if (useInbox) {
      if (!stateRunId) return stop("failed", "refused", "Durable input requires C6a run state.");
      try {
        const opened = await this.ports.inbox!.transact(session, { kind: "open", runId: stateRunId, owner: stateOwner,
          ...(input.initialInboxMessageId ? { initialMessageId: input.initialInboxMessageId } : {}) });
        inboxOpened = true;
        if (input.detachedChildInbox) await this.ports.inbox!.transact(session, { kind: "resume-inputs", runId: stateRunId, owner: stateOwner });
        recoveredInbox = opened.messages.filter((m) => m.id !== input.initialInboxMessageId || m.completion);
      } catch {
        return stop("failed", "refused", "The session inbox could not acquire this run's lease.");
      }
    }
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];
    const repeatedSignatures: string[] = [];
    const repeatedErrors: string[] = [];
    const argumentCorrections = new Map<string, number>();
    let loopReminded = false;
    let errorReminded = false;
    let steps = Math.max(0, input.initialTurnIndex ?? 0);
    const appendInboxMessage = async (message: import("@npati/workspace").CodeInboxMessage): Promise<boolean> => {
      if (message.completion && stateRunId && this.ports.completions) {
        const collected = await this.ports.completions.collect(ctx, session, message, stateRunId);
        if (!collected) return false;
        messages.push({ role: "user", content: "Asynchronous process result (untrusted tool data, not user instructions):\n" + collected.text });
        completionArtifacts.push({ turnIndex: steps + 1, notice: collected.notice, canonicalResult: collected.text });
        await this.ports.completions.admitted(session, collected.notice, { runId: stateRunId, owner: stateOwner,
          turnIndex: steps + 1, text: collected.text, source: "inbox" });
        return true;
      }
      if (message.completion) return false;
      messages.push({ role: "user", content: message.text });
      prompt += `\n\nAdditional user instruction:\n${message.text}`;
      return true;
    };
    for (const message of recoveredInbox) await appendInboxMessage(message);
    const admitInbox = async (): Promise<boolean> => {
      if (!inboxOpened || !stateRunId) return false;
      await this.ports.completions?.recover(ctx, session);
      const admitted = await this.ports.inbox!.transact(session, { kind: "drain", runId: stateRunId, owner: stateOwner, turnIndex: steps + 1 });
      let changed = false;
      for (const message of admitted.messages) changed = await appendInboxMessage(message) || changed;
      return changed;
    };
    let sawNativeToolCalls = false;
    /**
     * C8: the recorded compaction artifacts of this run. They travel into the replay bundle as replay input, so
     * a replay reproduces the exact compacted context instead of recomputing a summary. A refused run leaves
     * this empty, and an empty list is a legal recording — not a failure of `finalize`.
     */
    const compressionArtifacts: Record<string, unknown>[] = [];

    const cancelled = async (): Promise<boolean> => {
      if (input.signal?.aborted) return true;
      if (!input.cancelRequested) return false;
      try {
        return await input.cancelRequested();
      } catch {
        return false;
      }
    };

    /**
     * C13 (owner blocker 1): the approved pending calls of a **resumed** run, executed here — before the next
     * model step — because they were announced by the model in the turn that paused the run, and the run cannot
     * ask the model for anything before that turn is settled.
     *
     * Three properties, and each one is a refusal rather than a convention:
     *
     *  - **the capability surface is the resumed run's own.** A name this run did not just discover is refused
     *    without being executed (`unknown_tool`), so an approval cannot smuggle a tool past the discovery;
     *  - **the one-shot record is what authorises the call**, presented to the same MCP run path an ordinary call
     *    goes through. The record is matched by the durable store against the run, the agent, the tool and the
     *    canonical payload hash of *this* call — so a record for another call, another run or another agent is
     *    refused (`APPROVAL_INVALID`) and a spent one is refused (`APPROVAL_ALREADY_USED`);
     *  - **the outcome is evidence.** The write-ahead record, the terminal record, the Activity event and the
     *    replay bundle all carry the call, whether it succeeded, was refused or failed.
     */
    if (input.approvedToolCalls?.length) {
      const approvedLines: string[] = [];
      for (const approved of input.approvedToolCalls) {
        const startedCall = this.now();
        if (stateRunId && this.ports.runState) {
          await writeState(() => this.ports.runState!.appendToolCall({
            companyId, runId: stateRunId!, turnIndex: steps,
            toolCallId: approved.toolCallId, tool: approved.tool, readOnly: false,
            outcome: "unknown_outcome", startedAt: new Date(startedCall), finishedAt: null,
          }));
        }
        let outcome: CodeToolInvokeResult | CodeToolInvokeFailure;
        if (!runtimeToolByName.has(approved.tool) || !this.ports.runtimeCapabilities) {
          // The same answer a typo would get, and the same answer a tool of another run gets: no execution.
          outcome = {
            ok: false,
            error: {
              code: "unknown_tool", status: 404, step: "resolve", retryable: false,
              message: `The approved call names a runtime MCP tool this run does not offer: ${approved.tool}`,
              tool: approved.tool,
            },
          };
        } else {
          try {
            outcome = await this.ports.runtimeCapabilities.invoke({
              ctx,
              companyId,
              projectId,
              ...(sessionId ? { sessionId } : {}),
              ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
              ...(input.agentId ? { agentId: input.agentId } : {}),
              ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
              tool: approved.tool,
              args: approved.args,
              toolCallId: approved.toolCallId,
              approvalId: approved.approvalId,
            });
          } catch (error) {
            const failure = error as { code?: string; message?: string; status?: number; step?: string; details?: Record<string, unknown> };
            outcome = {
              ok: false,
              error: {
                code: (failure.code ?? "tool_error") as CodeToolInvokeFailure["error"]["code"],
                status: failure.status ?? 500,
                message: failure.message ?? "The approved runtime MCP call failed",
                tool: approved.tool,
                step: failure.step ?? "execute",
                retryable: false,
                ...(failure.details ? { details: failure.details } : {}),
              },
            };
          }
        }
        if (stateRunId && this.ports.runState) {
          await writeState(() => this.ports.runState!.appendToolCall({
            companyId, runId: stateRunId!, turnIndex: steps,
            toolCallId: approved.toolCallId, tool: approved.tool, readOnly: false,
            outcome: outcome.ok ? "ok" : "failed",
            ...(outcome.ok ? {} : { errorCode: outcome.error.code }),
            startedAt: new Date(startedCall), finishedAt: new Date(this.now()),
          }));
        }
        summary.toolCalls += 1;
        const text = canonicalizeSettledToolResult({
          ok: outcome.ok,
          tool: approved.tool,
          ...(outcome.ok ? { result: outcome.result } : {}),
          ...(outcome.ok ? { truncated: outcome.truncated } : {}),
          ...(outcome.ok ? {} : { error: outcome.error }),
          limit: this.limits.toolOutputChars,
        });
        // The recording and the Activity event carry the call exactly like an ordinary one, so a resumed
        // execution is not a hole in the evidence.
        replayRecorder?.recordToolCall({
          turnIndex: steps,
          toolCallId: approved.toolCallId,
          tool: approved.tool,
          toolVersion: toolVersionByName.get(approved.tool) ?? null,
          /**
           * C14 (arguments-hash blocker): the **same** derivation the model step used, through the one canonical
           * conversion (`replayArgumentsHash`). The model step holds the provider's argument text and this step
           * holds the admitted object; hashing either of them directly made one call carry two hashes, and
           * `code-replay-engine.ts` compares them — so a runner-recorded bundle could never replay. The
           * authoritative material is the argument *value*, canonicalised once for both sides.
           */
          argumentsHash: replayArgumentsHash(approved.args),
          settledResult: text,
          outcome: outcome.ok ? "ok" : "failed",
          ...(outcome.ok ? {} : { errorCode: outcome.error.code }),
          ...(outcome.ok ? { truncated: outcome.truncated === true } : {}),
        });
        await record({
          kind: "tool_call",
          companyId,
          projectId,
          sessionId,
          runId: input.runId,
          turn: steps,
          tool: approved.tool,
          toolCallId: approved.toolCallId,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { errorCode: outcome.error.code }),
          durationMs: this.now() - startedCall,
        });
        approvedLines.push(text);
      }
      if (approvedLines.length) {
        messages.push({ role: "system", content: `${APPROVED_TOOL_CALLS_RESULT_HEADER}\n${approvedLines.join("\n")}` });
      }
    }

    // The loop. Each iteration is one assistant turn.
    for (;;) {
      if (leaseLost) {
        // Another process owns this run: stop before touching the workspace again. The exit is `interrupted`
        // rather than `failed` because nothing is known to be broken — the run simply moved elsewhere.
        await release("interrupted");
        return stop(
          "interrupted",
          "interrupted",
          "Stopped: this process lost the run lease (another worker took over). No further changes were made.",
        );
      }
      if (await cancelled()) {
        if (input.detachedChildInbox && (input.signal?.reason as { code?: string } | undefined)?.code === "subagent_interrupt") {
          return stop("interrupted", "interrupted", "The child was interrupted at a safe boundary and can be continued.");
        }
        await release("cancelled");
        await this.ports.runEvents?.append({ eventKey: `code-run-cancelled:${turnId}`, eventType: "cancelled", runStatus: "cancelled", message: "Coding Agent run cancelled by the user" });
        return stop("cancelled", "cancelled", "The run was cancelled. Any running processes were stopped and the sandbox was released.");
      }
      for (const content of this.ports.engine.recordedCompletionInputs?.(steps + 1) ?? []) messages.push({ role: "user", content });
      if (inboxOpened) {
        try {
          if (inboxSealed && stateRunId) {
            await this.ports.inbox!.transact(session, { kind: "open", runId: stateRunId, owner: stateOwner });
            inboxSealed = false;
          }
          await admitInbox();
        }
        catch { return stop("interrupted", "interrupted", "Stopped: durable inbox admission failed. Pending input remains recoverable."); }
      }
      if (steps >= runTurnLimit) {
        await release("step_limit");
        summary.remaining = "Step limit reached; the task may be unfinished.";
        return stop("stopped", "step_limit", `Stopped after ${runTurnLimit} turns: the step limit was reached.`);
      }
      if (this.now() - startedAt > this.limits.maxRunMinutes * 60_000) {
        await release("time_limit");
        summary.remaining = "Time limit reached; the task may be unfinished.";
        return stop("stopped", "time_limit", `Stopped after ${this.limits.maxRunMinutes} minutes: the time limit was reached.`);
      }
      if (this.ports.quota) {
        /**
         * C12: the depth travels with the check, and the budget is keyed by **session** — so a parent and its
         * children draw on one allowance (a delegated coding run is a run of the same session) and a depth past
         * the canonical limit cannot obtain an allowance even if a delegation somehow slipped through.
         */
        const verdict = this.ports.quota.checkQuota(input.quotaSessionId ?? sessionId, this.estimatedTokensPerCall, this.estimatedCostPerCallUsd, delegationDepth, { userId: ctx.userId, companyId });
        if (!verdict.allowed) {
          await release("budget_exhausted");
          summary.remaining = verdict.error ?? "Budget exhausted.";
          return stop("stopped", "budget_exhausted", `Stopped: ${verdict.error ?? "the token or cost budget is exhausted"}.`);
        }
      }

      let result: ChatResult;
      /**
       * C8: context pressure, measured on the **whole model request** and checked before every model call.
       *
       * Three deliberate choices. The window comes from the resolved profile (`profile.contextWindow`), never
       * from a heuristic on the model name (global rule 7). The threshold is
       * `NPATI_CODE_CONTEXT_COMPRESSION_RATIO` — configuration that existed since C1 and that nothing read
       * until now. And the measured quantity is the full request (system prompt, tool schemas, project
       * instructions, memory/context blocks and the conversation) because in a code run the first four are a
       * large, permanent share: measuring the messages alone would let a session run into provider truncation
       * before compaction ever triggered. The calculation is a pure function of that content, so the decision
       * to compact is reproducible and can be part of replayed input rather than an out-of-band surprise.
       */
      lastBudget = resolveModelRequestPressure({
        systemPrompt,
        toolSchemas: JSON.stringify(definitions),
        ...(projectInstructions ? { projectInstructions: projectInstructions.body } : {}),
        ...(contextBlocks ? { contextBlocks } : {}),
        messages: messages.map((message) => ({ role: message.role, content: chatContentText(message.content) })),
        contextWindow: profile.contextWindow,
        compressionRatio: this.limits.contextCompressionRatio,
      });
      if (lastBudget.actionRequired) {
        const compactable = messages.map((message) => {
          const carrier = message as unknown as { toolCallId?: string; name?: string; toolVersion?: number };
          return {
            role: message.role as string,
            content: chatContentText(message.content),
            ...(carrier.toolCallId ? { toolCallId: carrier.toolCallId } : {}),
            ...(carrier.name ? { toolName: carrier.name } : {}),
            ...(carrier.toolVersion !== undefined ? { toolVersion: carrier.toolVersion } : {}),
          };
        });
        try {
          const compaction = compactConversation({ messages: compactable });
          const summaryText = renderSummaryMessage(compaction.summary);
          /**
           * C8: the summary is provider-bound content — it is inserted into the transcript and therefore sent
           * on every later model call — so it passes the **existing** ProviderDataGuard (C5b) before it is used
           * anywhere. The guard resolves the project's real policy, applies its classification ceiling, its
           * content-type rules, its private-code rule and its redaction list, and records the decision; there is
           * deliberately no second scanner here. A text the guard would have to redact is **refused** rather than
           * accepted in sanitised form, because the sanitised version would carry a `REDACTED:` placeholder into
           * the persisted artifact and into the recorded model-visible state, and placeholders are references
           * that must never reach disk (`assertNoPlaceholderInWrite`). The guard is optional: a deployment
           * without it keeps the C4a secret scan that `compactConversation` already performs as its floor.
           */
          if (this.ports.providerDataGuard) {
            await this.ports.providerDataGuard.guardProviderBoundText(summaryText, {
              model: input.model,
              policyContext: {
                companyId,
                projectId,
                sessionId,
                dataClassification: session.dataClassification,
              },
            });
          }
          /**
           * C8: a SecretLease value is not recognisable by shape — it is an opaque string by construction — so a
           * pattern scanner cannot be the only check. When the deployment can name the values it issued to this
           * session, the summary is compared against them with the **existing** `redactLeaseValues` helper, and a
           * text that would have to be redacted is refused for the same reason a pattern-matched secret is: the
           * sanitised form would carry a placeholder into the artifact and into the recorded model-visible state.
           */
          if (this.ports.secretLeaseValues) {
            const values = await this.ports.secretLeaseValues({ sessionId, companyId, projectId });
            assertNoLeaseValuesInSummary(summaryText, values ?? []);
          }
          const rebuilt: ChatMessage[] = compaction.messages.map((message) => ({
            role: message.role as ChatMessage["role"],
            content: message.content,
          }));
          if (rebuilt.length === messages.length) {
            messages.length = 0;
            messages.push(...rebuilt);
            // The structured summary is inserted as its own message, immediately after the system prompt and
            // the original goal, so a reader can still tell which part of the transcript is a summary.
            messages.splice(2, 0, { role: "system", content: summaryText } as ChatMessage);
            compactionCount += 1;
            compressionArtifacts.push(compaction.artifact as unknown as Record<string, unknown>);
            await record({
              kind: "turn",
              companyId,
              projectId,
              sessionId,
              ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
              turn: steps,
              ok: true,
              errorCode: "context_compacted",
              reason: `stubbed=${compaction.stubbed} tokens=${compaction.tokensBefore}->${compaction.tokensAfter} hash=${compaction.contentHash}`,
            });
            if (this.ports.contextSummaryStore) {
              try {
                await this.ports.contextSummaryStore.persist({
                  companyId,
                  projectId,
                  sessionId,
                  runId: stateRunId ?? input.runId ?? "",
                  snapshotId,
                  turnIndex: steps,
                  schemaVersion: COMPACTION_SCHEMA_VERSION,
                  summary: compaction.summary,
                  summaryText,
                  contentHash: compaction.contentHash,
                  dataClassification: session.dataClassification,
                  retentionClass: session.retentionClass,
                });
              } catch {
                // Losing the artifact never aborts a run that is otherwise progressing; the same summary is on
                // the run result, and the Activity event above records that compaction happened.
              }
            }
          }
        } catch (error) {
          /**
           * A refused compaction never stops the run: the transcript simply stays as it is. It is recorded,
           * though, because "we declined to compact" and "there was nothing to compact" must not look the same —
           * a guard refusal in particular means the summary carried something that must not reach a provider,
           * and hiding that would be exactly the silent behaviour the project refuses everywhere else.
           */
          await record({
            kind: "turn",
            companyId,
            projectId,
            sessionId,
            ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
            turn: steps,
            ok: false,
            errorCode: "context_compaction_refused",
            reason: String((error as { code?: string })?.code ?? "context_compaction_failed"),
          });
        }
      }
      try {
        result = await this.ports.engine.chat({
          messages,
          ...(definitions.length ? { tools: definitions } : {}),
          ...(definitions.length ? { toolChoice: "auto" as const } : {}),
          model: input.model,
          ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
          signal: input.signal,
          idempotencyKey: `${sessionId}:${turnId}:${steps}`,
          policyContext: {
            companyId,
            projectId,
            sessionId,
            dataClassification: session.dataClassification,
          },
        });
      } catch (error) {
        // Provider errors are handled by the engine's own routing/fallback; reaching here means the whole
        // chain failed. The runner never invents retries.
        if (input.detachedChildInbox && (input.signal?.reason as { code?: string } | undefined)?.code === "subagent_interrupt") {
          return stop("interrupted", "interrupted", "The child was interrupted during its model request and can be continued.");
        }
        if (input.detachedChildInbox && input.signal?.aborted) {
          await release("cancelled");
          return stop("cancelled", "cancelled", "The delegated run was cancelled.");
        }
        const failure = error as { code?: string; message?: string };
        await release("provider_error");
        await this.ports.runEvents?.append({ eventKey: `code-run-failed:${turnId}`, eventType: "failed", runStatus: "failed", message: "Coding Agent run failed" });
        return stop("failed", "provider_error", failure.message ?? `The model provider failed (${failure.code ?? "provider_error"}).`);
      }

      steps += 1;
      summary.turns = steps;
      model = result.model ?? model;
      provider = result.telemetry?.provider ?? provider;
      const tokens = result.usage?.totalTokens ?? 0;
      summary.tokens += tokens;
      const costUsd = result.telemetry?.costUsd ?? 0;
      summary.costUsd += costUsd;
      if (this.ports.quota && (tokens > 0 || costUsd > 0)) {
        try {
          this.ports.quota.recordUsage(input.quotaSessionId ?? sessionId, tokens, costUsd, { userId: ctx.userId, companyId });
        } catch {
          // Usage accounting must not abort a run; the budget pre-flight remains the gate.
        }
      }
      await record({ kind: "turn", companyId, projectId, sessionId, runId: input.runId, turn: steps, bytes: tokens });

      if (result.toolCalls?.length) sawNativeToolCalls = true;
      // `auto` resolves to native only with evidence: native calls in this exchange, or an engine that
      // reports native tool support. Otherwise the text protocol is used, which fails loudly instead of
      // losing tool calls silently.
      const mode = resolveEffectiveToolCallingMode(profile, {
        sawNativeToolCalls: sawNativeToolCalls || engineSupportsNativeTools,
      });
      const normalized: NormalizeToolCallsResult = normalizeToolCalls({
        payload: {
          toolCalls: result.toolCalls ?? null,
          content: result.content ?? null,
          finishReason: result.finishReason ?? null,
        },
        profile,
        mode,
        knownTools,
        // Always injected: text mode without a validator executes nothing (`validator_not_configured`).
        validate: validateArguments,
      });
      // C6b: the recorded answer is the answer that actually came back — content, finish reason, usage and the
      // tool calls with a hash of their arguments (the arguments themselves live in the canonical tool result).
      replayRecorder?.recordModelStep({
        turnIndex: steps,
        request: {
          model: input.model ?? null,
          messageCount: messages.length,
          toolNames: definitions.map((definition) => definition.function.name),
          idempotencyKey: `${sessionId}:${turnId}:${steps}`,
          dataClassification: session.dataClassification,
        },
        response: {
          content: result.content ?? "",
          finishReason: result.finishReason ?? null,
          model: result.model ?? null,
          provider: result.telemetry?.provider ?? null,
          usage: result.usage
            ? {
              totalTokens: result.usage.totalTokens,
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
            }
            : null,
          toolCalls: (result.toolCalls ?? []).map((call) => ({
            id: call.id,
            name: call.function?.name ?? "",
            /**
             * The provider's own argument text, converted to the canonical argument value by the **same**
             * function the tool step uses (`replayArgumentsHash`). Hashing the raw text here and the parsed
             * object there produced two hashes for one call, which is exactly what made a runner-recorded
             * bundle diverge at `arguments_hash` on replay.
             */
            argumentsHash: replayArgumentsHash(call.function?.arguments),
            /**
             * C14 (provider cassette): the argument text beside its hash. Additive and optional in the recorded
             * format (the format version therefore stays 3), and the only way the cassette can hand a consumer
             * the same call instead of an invented one. The whole recording — these bytes included — goes
             * through the existing secret scan, so a credential here refuses the bundle loudly rather than
             * being stripped.
             */
            arguments: call.function?.arguments ?? "",
          })),
        },
      });

      // `normalized.reasoning` is a pass-through only: the wire types carry no reasoning field and `stream()`
      // returns text alone, so C6 never fabricates one. It is deliberately not echoed into `messages`.

      const callsToRun = executableToolCalls(normalized);
      const assistantText = result.content ?? "";

      /**
       * C6a: the turn boundary is opened **before** the calls run, and the cursor moves with it. A process
       * that dies during this turn therefore leaves a `running` turn whose pending calls are exactly the ones
       * whose result nobody observed.
       */
      const openTurn = async (): Promise<void> => {
        if (!stateRunId || !this.ports.runState) return;
        // `appendTurn` moves the run cursor together with the turn boundary, under one sequence, so there is no
        // window where a turn exists while the run still claims to be on an earlier one.
        await writeState(() => this.ports.runState!.appendTurn({
          companyId, runId: stateRunId!, turnIndex: steps, status: "running",
        }));
      };

      if (!callsToRun.length && !normalized.rejected.length) {
        // The final assistant turn is still a turn: it gets a boundary that closes as finished before the run is
        // marked completed, so a recovery never has to guess whether the last turn even started.
        await openTurn();
        if (stateRunId && this.ports.runState) {
          await writeState(() => this.ports.runState!.appendTurn({
            companyId, runId: stateRunId!, turnIndex: steps, status: "finished", outcome: "ok",
            // C10: the closing assistant turn carries the checkpoint in force, so the boundary a recovery
            // resumes from names the exact state to compare the workspace against.
            checkpointId: turnCheckpointId(),
          }));
        }
        // The sandbox is **not** released here any more: C9 may still need it for the verification run and for
        // the repair turns that follow a failed check. Releasing before the decision would leave the repair
        // loop with nothing to run in, and it would announce completion for a run that is about to stop.
        this.applyTurnSummary(summary, runChanges(), runChangeTotals());

        /**
         * C9: the model has stopped asking for tools, which in C6 meant "done". It is not done until the change
         * verifies and the run has reviewed its own work. The order is deliberate — inspect the change set first
         * (scope and test integrity, both pure functions of it), then run the checks, then decide — because the
         * decision must not depend on the model's account of what it changed.
         *
         * Requirement 4 adds the last two stages and nothing else: **one** self-review pass after verification
         * settles, and **one** fix iteration if it found something blocking. Both are structural: the review
         * state is created once per run and its `execute` is a no-op afterwards, and `applyFix` consumes its
         * single budget on first use.
         */
        // Final proposal cutoff is atomic with inbox admission. Before this cutoff steering
        // continues this task; after it the API explicitly receipts next-turn. C9 is unchanged.
        let useCollectBarrier = false;
        try { useCollectBarrier = !input.subagentScope && !!this.ports.asyncCollect && await this.ports.asyncCollect.enabled(ctx, companyId); }
        catch { return stop("interrupted", "async_collect_unsettled", "The collect barrier flag could not be resolved. Verification has not run."); }
        if (useCollectBarrier && this.ports.asyncCollect) {
          if (!inboxOpened || !stateRunId || !this.ports.completions) {
            return stop("interrupted", "async_collect_unsettled", "The collect barrier requires a durable inbox and completion collector.");
          }
          // Join producers before sealing the inbox or reading the C9 change set. Poll durable state
          // under the existing heartbeat; waiting spends neither model turns nor a second quota.
          const deadline = Date.now() + Math.max(0, Math.min(this.ports.asyncCollect.timeoutMs ?? 30_000,
            this.limits.maxRunMinutes * 60_000 - (this.now() - startedAt)));
          let collectedInput = false;
          try {
            for (;;) {
              if (await cancelled()) {
                await release("cancelled");
                return stop("cancelled", "cancelled", "The run was cancelled during result collection.");
              }
              if (!await this.ports.asyncCollect.enabled(ctx, companyId)) throw new Error("collect_barrier_disabled");
              if (this.ports.runState && !(await this.ports.runState.renewLease({ companyId, runId: stateRunId, owner: stateOwner })).held) {
                throw new Error("collect_barrier_lease_lost");
              }
              await this.ports.completions.barrier(ctx, session, stateRunId, stateOwner);
              await this.ports.inbox!.transact(session, { kind: "collect-completions", runId: stateRunId, owner: stateOwner });
              collectedInput = await admitInbox() || collectedInput;
              const barrier = await this.ports.completions.barrier(ctx, session, stateRunId, stateOwner);
              if (barrier.ready) {
                collectedChanges = await this.ports.asyncCollect.changes(ctx, session, barrier.operations);
                this.applyTurnSummary(summary, runChanges(), runChangeTotals());
                break;
              }
              if (barrier.blocked || Date.now() >= deadline) throw new Error("collect_barrier_pending");
              await new Promise<void>((resolve) => setTimeout(resolve, 250));
            }
          } catch {
            // Keep the workspace fence and the same C10 run identity. An uncertain result is never
            // verification success, and a paused child is never silently resumed or cancelled here.
            return stop("interrupted", "async_collect_unsettled", "Result collection is incomplete. Verification and self-review have not run; the same run can be continued.");
          }
          if (collectedInput) continue;
        }
        if (inboxOpened && stateRunId) {
          try {
            if (await admitInbox()) continue;
            const proposal = await this.ports.inbox!.transact(session, { kind: "seal", runId: stateRunId, owner: stateOwner });
            if (!proposal.sealed) continue;
          } catch { return stop("interrupted", "interrupted", "Stopped: the inbox finalization cutoff could not be recorded."); }
          inboxSealed = true;
        }
        await evaluateChangeSet();
        const changeSet = runChanges();
        /**
         * The caller's opt-out (`verificationTools: []`) turns off the whole verify-and-review stage. The review
         * is not silently skipped in that case: its verdict is computed and says `not_run`, which is what the
         * summary reports — "we did not review this" is visible, never dressed up as clean.
         */
        if (verificationDisabled || (changeSet.length === 0 && !input.forceVerification)) {
          // The state exists so the verdict is explicit rather than an absent field: `not_run` with its reason
          // ("no changes to review", "disabled by configuration"). "We did not review this" is visible, never
          // dressed up as clean.
          selfReviewVerdict = beginSelfReviewState();
          writeSelfReviewSummary();
          await release("completed");
          await this.ports.runEvents?.append({ eventKey: `code-run-completed:${turnId}`, eventType: "completed", runStatus: "completed", message: "Coding Agent run completed" });
          summary.remaining = "The model finished without further tool calls.";
          return stop("completed", "completed", assistantText || "The run finished.");
        }

        /**
         * The settle stage. There are exactly two ways to arrive here, and the branch is what keeps the repair
         * budget and the review budget apart:
         *
         * - a **model turn** (the ordinary case): the checks run, the repair loop may ask for one more round, and
         *   the self-review pass then runs once;
         * - the **single review-driven fix turn** (`selfReviewFixPending`): the checks already ran on the
         *   pre-review tree, so they are not run a third time here — `afterSelfReviewFix` compares the tree and
         *   re-verifies exactly once if the fix changed it, then re-reads the review's own verdict. Running the
         *   repair loop here instead would let the review buy extra repair rounds, which is precisely what the
         *   owner's "at most one fix iteration" rule forbids.
         */
        let verificationExhausted = false;
        if (selfReviewFixPending) {
          const outcome = await afterSelfReviewFix();
          if (outcome.action === "stop") {
            summary.remaining = outcome.reason;
            summary.turns = steps;
            await release(outcome.reason);
            return stop("stopped", outcome.reason, outcome.message);
          }
        } else {
          const failing = await verifyAndDecide();
          if (failing === "repair") {
            /**
             * The failure goes back to the model with the failing checks named, and the run continues. The
             * instruction also states the two things that are not allowed: weakening a test, and claiming a pass
             * that is not there.
             *
             * The sandbox is released here exactly as it was before this step existed: the run state is durable,
             * a repair turn is a new turn, and the release is idempotent. What matters is the *order* — the repair
             * instruction is already in the transcript and the run is still live.
             */
            await release("verification_repair");
            continue;
          }
          if (failing === "approval_required") {
            /**
             * A check needs a human decision. The review has nothing to add — the change cannot be accepted
             * whatever a reviewer thinks of it — and running it would spend a model call to reach a conclusion
             * that is already settled. This is exactly the C9 behaviour the existing suite pins, and
             * requirement 4 does not change it: self-review is the *last* stage of a run that is otherwise ready
             * to finish.
             */
            summary.remaining = VERIFICATION_APPROVAL_REQUIRED;
            summary.turns = steps;
            await release(VERIFICATION_APPROVAL_REQUIRED);
            return stop("stopped", "verification_failed", verificationStopMessage());
          }
          if (failing === "unavailable") {
            /**
             * The checks could not be run at all (no verification runner, or a disabled check). This is the one
             * settled outcome the review does not follow, and deliberately so: the review's whole point is to
             * look at a **checked** change, and spending a model call to review a tree nobody could check would
             * not make the verification happen. The stop reason is the existing `verification_failed`, so this
             * is byte-for-byte the behaviour C9 already had.
             */
            summary.remaining = VERIFICATION_UNAVAILABLE;
            summary.turns = steps;
            await release(VERIFICATION_UNAVAILABLE);
            return stop("stopped", "verification_failed", verificationStopMessage());
          }
          /**
           * `failing === "exhausted"` keeps going into the review on purpose: it is the run's last chance to say
           * *what* is wrong in its own words before stopping, and its verdict travels with the verification
           * failure in the summary. The stop reason stays `verification_failed`, so nothing about an exhausted
           * repair loop changes because a review also ran.
           */
          verificationExhausted = failing === "exhausted";
          if (verificationExhausted) summary.remaining = VERIFICATION_REPAIR_EXHAUSTED;
          await beginSelfReview();

          const outcome = await afterSelfReview();
          if (outcome.action === "stop") {
            summary.remaining = outcome.reason;
            summary.turns = steps;
            await release(outcome.reason);
            return stop("stopped", outcome.reason, outcome.message);
          }
          if (outcome.action === "continue") {
            // The single review-driven fix iteration: the model acts on the findings and the loop resumes.
            continue;
          }
        }

        /**
         * A settled verification failure still stops the run after the review — the review is extra reporting,
         * never a way to overturn the checks.
         */
        if (verificationExhausted) {
          summary.turns = steps;
          await release("verification_failed");
          return stop("stopped", "verification_failed", verificationStopMessage());
        }

        await release("completed");
        await this.ports.runEvents?.append({ eventKey: `code-run-completed:${turnId}`, eventType: "completed", runStatus: "completed", message: "Coding Agent run completed" });
        summary.remaining = "The model finished without further tool calls.";
        return stop("completed", "completed", assistantText || "The run finished.");
      }

      await openTurn();

      // The assistant turn is echoed back verbatim (including native calls) so the model sees its own plan.
      const assistantMessage: ChatMessage = { role: "assistant", content: assistantText };
      if (normalized.calls.length) {
        assistantMessage.tool_calls = normalized.calls.map(toChatToolCall);
      }
      messages.push(assistantMessage);

      // Partial calls are never executed: a truncated stream has to continue without re-running anything.
      for (const rejected of normalized.rejected) {
        if (rejected.code === "partial_tool_call") {
          messages.push({
            role: "tool",
            tool_call_id: rejected.id ?? `partial:${messages.length}`,
            content: JSON.stringify(toolCallFeedback(rejected)),
          });
          continue;
        }
        const key = `${rejected.name ?? "unknown"}:${rejected.code}`;
        const count = (argumentCorrections.get(key) ?? 0) + 1;
        argumentCorrections.set(key, count);
        if (count > MAX_ARGUMENT_CORRECTIONS) {
          await release("invalid_arguments_exhausted");
          return stop("stopped", "invalid_arguments_exhausted", `Stopped: the model kept sending unusable arguments for ${rejected.name ?? "a tool"} (${rejected.code}).`);
        }
        messages.push({
          role: "tool",
          tool_call_id: rejected.id ?? `rejected:${messages.length}`,
          content: JSON.stringify({
            ...toolCallFeedback(rejected),
            hint: `Fix the arguments and retry (attempt ${count} of ${MAX_ARGUMENT_CORRECTIONS}).`,
          }),
        });
        await record({ kind: "tool_call", companyId, projectId, sessionId, runId: input.runId, turn: steps, tool: rejected.name, toolCallId: rejected.id, ok: false, errorCode: rejected.code });
      }

      if (!callsToRun.length) continue;

      // Loop detection: the same call three times in a row, or the same error three times in a row.
      const signatures = callsToRun.map(toolCallSignature);
      repeatedSignatures.push(...signatures);
      while (repeatedSignatures.length > LOOP_REPEAT_THRESHOLD) repeatedSignatures.shift();
      if (repeatedSignatures.length === LOOP_REPEAT_THRESHOLD && new Set(repeatedSignatures).size === 1) {
        if (loopReminded) {
          await release("loop_detected");
          return stop("stopped", "loop_detected", `Stopped: the same tool call (${callsToRun[0]?.name ?? "unknown"}) was repeated without progress.`);
        }
        loopReminded = true;
        messages.push({ role: "system", content: REMINDER_MESSAGE });
        await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "repeated_call" });
      }

      const execute = async (call: NormalizedToolCall): Promise<{ call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure }> => {
        const startedCall = this.now();
        const readOnlyCall = isReadOnlyRunTool(call.name);
        /**
         * C6a write-ahead record: the call is persisted as `unknown_outcome` **before** it runs, so a crash
         * mid-call leaves evidence that it started. Without this, a mutating call that was interrupted would be
         * invisible after a restart, and a recovery could not tell "never started" from "may have landed" —
         * which is the difference between replaying it safely and corrupting the repository.
         */
        if (stateRunId && this.ports.runState) {
          await writeState(() => this.ports.runState!.appendToolCall({
            companyId, runId: stateRunId!, turnIndex: steps,
            toolCallId: call.id, tool: call.name, readOnly: readOnlyCall,
            outcome: "unknown_outcome", startedAt: new Date(startedCall), finishedAt: null,
          }));
        }
        const invokeInput = {
          leaseOwner: stateOwner,
          companyId,
          projectId,
          sessionId,
          tool: call.name,
          args: call.arguments,
          toolCallId: call.id,
          /**
           * C10: the **step-scoped** turn key, not the run-scoped `turnId`. This is what makes the runtime's
           * per-turn checkpoint belong to the turn that produced it: `ensureTurnCheckpoint` keys the checkpoint
           * by this value, the write-ahead diff tool reads the step's own changes, and `code.fs.undo_last_turn`
           * restores the step it was asked about instead of the whole run. Every other use of `turnId` (run
           * events, idempotency keys, verification tool-call ids) is unchanged, so no recorded identifier moves.
           */
          turnId: stepTurnKey(steps),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(stateRunId ? { runId: stateRunId } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          /**
           * C11 (owner decision 10): the read-only intent travels with every call, so the runtime refuses a
           * write even when the model names a tool the session was never offered. Offering less is a
           * courtesy; this flag is the guarantee.
           */
          ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
          /**
           * C12: the same capability scope the model was offered, per call. Offering less is a courtesy; this
           * is the guarantee, and it sits in the runtime before the sub-flag, the arguments, the approval and
           * the executor — so no approval, rule or mode can buy a tool a delegation did not record.
           */
          ...capabilityScopeFields,
        };
        let result: CodeToolInvokeResult | CodeToolInvokeFailure;
        try {
          /**
           * C13: a discovered runtime provider (MCP) tool is executed by the **existing** MCP transport through
           * the port, never by the static tool runtime — which has no schema, no executor and no client for it,
           * and would answer `unknown_tool`. The port asks the policy engine for the exact call before it dials
           * anything, so `code.mcp`, the session mode, the capability lookup and the fail-closed approval
           * requirement are all enforced on the server even for a call the model was not offered.
           */
          const runtimeTool = runtimeToolByName.get(call.name);
          result = runtimeTool && this.ports.runtimeCapabilities
            ? await this.ports.runtimeCapabilities.invoke({
                ctx,
                companyId,
                projectId,
                ...(sessionId ? { sessionId } : {}),
                ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
                ...(input.agentId ? { agentId: input.agentId } : {}),
                ...(input.signal ? { signal: input.signal } : {}),
                ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
                tool: call.name,
                args: call.arguments,
                toolCallId: call.id,
              })
            : await this.ports.toolRuntime.invoke(ctx, invokeInput);
        } catch (error) {
          const failure = error as { code?: string; message?: string; status?: number; retryable?: boolean; step?: string; details?: Record<string, unknown> };
          result = {
            ok: false,
            error: {
              code: (failure.code ?? "tool_error") as CodeToolInvokeFailure["error"]["code"],
              status: failure.status ?? 500,
              message: failure.message ?? "Tool execution failed",
              tool: call.name,
              step: failure.step ?? "execute",
              retryable: failure.retryable ?? false,
              ...(failure.details ? { details: failure.details } : {}),
            },
          };
        }
        // The terminal record replaces the write-ahead one for the same `toolCallId`.
        if (stateRunId && this.ports.runState) {
          await writeState(() => this.ports.runState!.appendToolCall({
            companyId, runId: stateRunId!, turnIndex: steps,
            toolCallId: call.id, tool: call.name, readOnly: readOnlyCall,
            outcome: result.ok ? "ok" : "failed",
            ...(result.ok ? {} : { errorCode: result.error.code }),
            startedAt: new Date(startedCall), finishedAt: new Date(this.now()),
          }));
        }
        summary.toolCalls += 1;
        if (CHECK_TOOL_PREFIXES.some((prefix) => call.name.startsWith(prefix)) && result.ok) {
          if (!summary.checksRun.includes(call.name)) summary.checksRun.push(call.name);
        }
        await record({
          kind: "tool_call",
          companyId,
          projectId,
          sessionId,
          runId: input.runId,
          turn: steps,
          tool: call.name,
          toolCallId: call.id,
          ok: result.ok,
          ...(result.ok ? {} : { errorCode: result.error.code }),
          durationMs: this.now() - startedCall,
        });
        return { call, result };
      };

      // Read-only calls are batched into waves through the adapter's `planToolCallWaves`, bounded by both
      // the model profile and `parallelReadOnlyCalls`; mutating, shell and unknown tools run strictly one at
      // a time in the model's order. The engine currently sends `parallel_tool_calls: false`, so waves are a
      // safety net for providers that return several calls anyway — never a promise of concurrency.
      const waveLimit = Math.max(1, Math.min(profile.maxParallelToolCalls, this.limits.parallelReadOnlyCalls));

      /** C6a: whether any call of this turn failed — the turn outcome recorded at the boundary. */
      let turnHadFailure = false;

      /** Appends one tool result and feeds the repeated-error detector. */
      const appendToolResult = async (outcome: { call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure }): Promise<void> => {
        /**
         * C6b: one canonicalisation, shared with the recorder. The text appended here **is** the model-visible
         * settled result, so recording it from a second code path would let the bundle and the conversation
         * drift apart — and replay would then reproduce a different conversation than the one that ran.
         */
        const text = canonicalizeSettledToolResult({
          ok: outcome.result.ok,
          tool: outcome.call.name,
          ...(outcome.result.ok ? { result: outcome.result.result } : {}),
          ...(outcome.result.ok ? { truncated: outcome.result.truncated } : {}),
          ...(outcome.result.ok ? {} : { error: outcome.result.error }),
          limit: this.limits.toolOutputChars,
        });
        replayRecorder?.recordToolCall({
          turnIndex: steps,
          toolCallId: outcome.call.id,
          tool: outcome.call.name,
          toolVersion: toolVersionByName.get(outcome.call.name) ?? null,
          argumentsHash: replayArgumentsHash(outcome.call.arguments),
          settledResult: text,
          outcome: outcome.result.ok ? "ok" : "failed",
          ...(outcome.result.ok ? {} : { errorCode: outcome.result.error.code }),
          ...(outcome.result.ok ? { truncated: outcome.result.truncated === true } : {}),
        });
        messages.push({ role: "tool", tool_call_id: outcome.call.id, content: text });
        if (outcome.result.ok && stateRunId && ["code.shell.exec_async", "code.shell.process.wait"].includes(outcome.call.name)) {
          const notice = await this.ports.completions?.admittedTool(ctx, session, outcome.result.result,
            { runId: stateRunId, owner: stateOwner, turnIndex: steps, text }, outcome.result.processReceipt);
          if (notice) {
            const metadataText = "Asynchronous result reference (metadata only): " + JSON.stringify(notice);
            messages.push({ role: "user", content: metadataText });
            completionArtifacts.push({ turnIndex: steps + 1, notice, source: "wait", metadataText });
          }
        }
        if (!outcome.result.ok) {
          turnHadFailure = true;
          repeatedErrors.push(`${outcome.call.name}:${outcome.result.error.code}`);
          while (repeatedErrors.length > LOOP_REPEAT_THRESHOLD) repeatedErrors.shift();
        } else {
          repeatedErrors.length = 0;
        }
      };

      /**
       * C10: this step is about to run tool calls, so it takes part in the aggregated change set and may create
       * its own checkpoint. Recorded **before** the calls execute, because the checkpoint is created during the
       * first write's pre-flight and the turn boundary that closes later must find it.
       */
      if (toolSteps[toolSteps.length - 1] !== steps) toolSteps.push(steps);

      const pending = [...callsToRun];
      while (pending.length) {
        const head = pending.shift();
        if (!head) break;
        if (isReadOnlyRunTool(head.name)) {
          // Consume the consecutive read-only run, then let the adapter decide the waves.
          const group: NormalizedToolCall[] = [head];
          while (pending[0] && isReadOnlyRunTool(pending[0].name)) {
            group.push(pending.shift() as NormalizedToolCall);
          }
          for (const wave of planToolCallWaves(group, waveLimit)) {
            const waveOutcomes = await Promise.all(wave.map((call) => execute(call)));
            for (const outcome of waveOutcomes) {
              await appendToolResult(outcome);
              // `code.ask_user` is not read-only, so it never lands in a wave today; the check is here anyway so
              // that a future classification mistake cannot turn the pause into "ask and keep going".
              const asked = questionIdFrom(outcome);
              if (asked) return await pauseForUser(asked);
            }
          }
        } else {
          /**
           * C13 (owner blocker 1): once a call of this turn is waiting for a human, the run is pausing, so only
           * **runtime MCP** calls continue to be evaluated — each of them asks its own human — and every other
           * call is reported as not executed, exactly like the `code.ask_user` pause below. Creating a request is
           * not executing a tool: that is why the MCP calls still run through the policy engine here.
           */
          if (pendingApprovals.length && !runtimeToolByName.has(head.name)) {
            await appendToolResult({
              call: head,
              result: {
                ok: false,
                error: {
                  code: "tool_failed", status: 409, tool: head.name, step: "execute", retryable: true,
                  message: "Not executed: the run paused to ask a human to approve a runtime MCP tool call.",
                },
              },
            });
            continue;
          }
          const outcome = await execute(head);
          await appendToolResult(outcome);
          /**
           * C13 (owner blocker 1): the **approval pause**. The engine already created exactly one durable
           * approval record for this call and refused to execute it; the run path reported that as
           * `approval_required` with `pauseForApproval`. The pause itself is written after the whole turn is
           * resolved (see below), so that two runtime MCP calls in one turn are two decisions for the human
           * rather than one — and the call is **not** retried, so the one-shot record cannot be spent twice.
           */
          const approvalPause = approvalPauseFrom(outcome);
          if (approvalPause) {
            /**
             * A pause is only a pause if it can be **written down**: the run state row is what a human's decision
             * is matched against, and a run that claimed `waiting_for_user` without one could never be continued.
             * A deployment that wired no run-state port therefore keeps the plain refusal — the model is told an
             * approval is required and the call was not executed, which is exactly the pre-C13 answer, and nothing
             * is executed without an approval either way.
             */
            if (stateRunId && this.ports.runState?.markWaitingForUser) {
              pendingApprovals.push(approvalPause);
              continue;
            }
            this.ports.logger?.warn("approval_pause_unsupported", {
              runId: stateRunId,
              tool: outcome.call.name,
              approvalId: approvalPause.approvalId,
            });
          }
          /**
           * C9: the pause. The question row and the run state already exist by the time the tool result is
           * settled, so the only decision left here is the loop's: it stops **before** the next model call. Nothing
           * after this point runs — no further tool call of this turn, no next turn — which is what makes
           * "the model cannot answer its own question" structural rather than a convention.
           *
           * A successful `code.ask_user` whose result carries no question id is refused rather than treated as an
           * ordinary result: continuing would run the model past a question nobody can find or answer.
           */
          if (outcome.call.name === CODE_ASK_USER_TOOL && outcome.result.ok) {
            const asked = questionIdFrom(outcome);
            if (!asked) {
              await release("tool_failure");
              return stop("failed", "tool_failure", "Stopped: code.ask_user reported success without a question id, so the run could not be paused safely.");
            }
            /**
             * A turn can carry several calls, and the assistant message above already announced all of them, so
             * the ones the pause stopped still need a result — otherwise the transcript would carry an
             * unanswered tool call that no replay could reconstruct. They are reported as **not executed**; the
             * point of the pause is that nothing else runs.
             */
            for (const rest of pending) {
              await appendToolResult({
                call: rest,
                result: {
                  ok: false,
                  error: {
                    code: "tool_failed", status: 409, tool: rest.name, step: "execute", retryable: true,
                    message: "Not executed: the run paused to ask the user a question.",
                  },
                },
              });
            }
            pending.length = 0;
            return await pauseForUser(asked);
          }
        }

        if (repeatedErrors.length === LOOP_REPEAT_THRESHOLD && new Set(repeatedErrors).size === 1) {
          if (errorReminded) {
            await release("loop_detected");
            return stop("stopped", "loop_detected", `Stopped: the same error (${repeatedErrors[0] ?? "unknown"}) kept repeating.`);
          }
          errorReminded = true;
          messages.push({ role: "system", content: REMINDER_MESSAGE });
          await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "repeated_error" });
        }
      }

      /**
       * C13 (owner blocker 1): the run pauses on the approvals it asked for, in the **existing**
       * `waiting_for_user` state, before the next model call — the same stop the `code.ask_user` pause makes.
       *
       * Recorded here, after every call of the turn has been resolved, so that one turn with two runtime MCP
       * calls produces **two** records and one pause (never two pauses, never one record for two calls). The
       * first pending record id travels in the question slot of the pause, which is what the release
       * (`resumeAfterAnswer`, driven by the approval decision) matches on; every record of the turn travels in
       * the run result's `pendingApprovals`.
       */
      if (pendingApprovals.length) {
        return await pauseForUser(
          { questionId: pendingApprovals[0]!.approvalId, toolCallId: pendingApprovals[0]!.toolCallId },
          "approval",
        );
      }

      // C6a: every call of this turn has been recorded, so the boundary closes here. This is the turn a
      // recovery will resume from, and `unknown_outcome` can no longer appear inside it.
      if (stateRunId && this.ports.runState) {
        await writeState(() => this.ports.runState!.appendTurn({
          companyId,
          runId: stateRunId!,
          turnIndex: steps,
          status: "finished",
          outcome: turnHadFailure ? "failed" : "ok",
          // C10: `code_run_turns.checkpoint_id` finally has a writer. The value is the checkpoint this turn's
          // writes were based on, so a rewind to this turn rolls the workspace back to exactly that state.
          checkpointId: turnCheckpointId(),
        }));
      }
    }
  }

  /**
   * C10: writes the run's change summary from the caller's aggregation.
   *
   * The aggregation moved into the loop because the per-turn tracker is now keyed by step (see `stepTurnKey`),
   * so no single tracker entry describes the run. The values are the same ones the pre-C10 code read from the
   * one run-scoped entry: the tracker's own counts, and the distinct paths it recorded.
   */
  private applyTurnSummary(
    summary: CodingAgentRunSummary,
    changes: ReadonlyArray<{ path: string }>,
    totals: { files: number; linesAdded: number; linesRemoved: number },
  ): void {
    summary.filesChanged = [...new Set(changes.map((change) => change.path))];
    summary.diffStats = { files: totals.files, linesAdded: totals.linesAdded, linesRemoved: totals.linesRemoved };
  }
}
