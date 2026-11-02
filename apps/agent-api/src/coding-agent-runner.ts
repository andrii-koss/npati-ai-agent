import { settleCodingTurn } from "./coding-agent-turn-settlement";
import { createHash, randomUUID } from "node:crypto";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import { emitCodingActivity } from "./coding-agent-runner-contracts";
import { providerContinuationFor } from "@npati/omniroute-adapter";
import type {
  ChatMessage,
  ChatResult,
} from "@npati/omniroute-adapter";
import type { CodeSession } from "@npati/workspace";
import { resolveCodeAgentLimits, type CodeAgentLimits } from "./code-agent-config";
import {
  type ResolvedCodeSubagentLimits,
} from "./code-subagent-limits";
import {
  executableToolCalls,
  normalizeToolCalls,
  type KnownTool,
  type NormalizeToolCallsResult,
} from "./code-tool-call-adapter";
import {
  modelProfileFallbackTrace,
  resolveEffectiveToolCallingMode,
  resolveModelProfile,
  type CodeModelProfile,
  type CodeModelProfileFallbackReason,
} from "./code-model-profiles";
import { CODE_DATA_STUDIO_FLAG, WEBSITE_EDIT_TOOL_PATTERN, finishedRunText } from "./code-tool-visibility";
import { resolveModelRequestPressure, type ModelRequestPressure } from "./code-context-budget";
import { validateArguments } from "./code-tool-runtime";
import { replayArgumentsHash } from "./code-replay-bundle";
import {
  EMPTY_SNAPSHOT_ID,
  resolveExecutionSnapshotProvider,
  type ExecutionSnapshotProvider,
} from "./execution-snapshot";
import {
  CodingAgentStopReason,
  CodingAgentRunStatus,
  CodeRunToolDescriptor,
  CodeRunRuntimeToolDescriptor,
  CodeRunRuntimeDiscovery,
  CodeRunActivityEvent,
  CodeRunReplayRecorderPort,
  CodingAgentRunnerPorts,
  CodingAgentRunInput,
  CodingAgentPendingApproval,
  CodingAgentRunSummary,
  CodingAgentRunResult,
  DEFAULT_ESTIMATED_TOKENS_PER_CALL,
  DEFAULT_ESTIMATED_COST_PER_CALL_USD,
  DEFAULT_SELF_REVIEW_DIFF_CHARS,
  assertMetadataOnly,
  chatContentText,
  withCodingReferenceImages,
  toChatToolCall,
  systemPromptStablePrefix,
} from "./coding-agent-runner-contracts";
import { CodingAgentRunPhases } from "./coding-agent-run-phases";
import { CodingAgentReviewPhases } from "./coding-agent-review-phases";
import { CodingAgentToolCatalog, offeredToolsForRun, type ToolCatalogOptions } from "./coding-agent-tool-catalog";
import { startCodingAgentSession } from "./coding-agent-session-starter";
import { buildRunPromptContext } from "./coding-agent-prompt-context";
import { compactConversationContextIfNeeded } from "./coding-agent-context-compactor";
import { CodingAgentInboxManager } from "./coding-agent-inbox-manager";
import { CodingAgentReviewCoordinator } from "./coding-agent-review-coordinator";
import { CodingAgentToolWaves } from "./coding-agent-tool-waves";

export * from "./coding-agent-runner-contracts";

export { WEBSITE_EDIT_TOOL_PATTERN, CODE_DATA_STUDIO_FLAG, CODE_FINISH_TOOL, toolCallSucceeded } from "./code-tool-visibility";

export class CodingAgentRunner {
  private readonly limits: CodeAgentLimits;
  private readonly snapshot: ExecutionSnapshotProvider;
  private readonly now: () => number;
  private readonly estimatedTokensPerCall: number;
  private readonly estimatedCostPerCallUsd: number;
  private readonly selfReviewDiffChars: number;
  private readonly toolCatalog: CodingAgentToolCatalog;
  private readonly reviewPhases: CodingAgentReviewPhases;
  private readonly runPhases: CodingAgentRunPhases;

  constructor(private readonly ports: CodingAgentRunnerPorts) {
    this.limits = { ...resolveCodeAgentLimits(), ...ports.limits };
    this.snapshot = resolveExecutionSnapshotProvider(ports.snapshot);
    this.now = ports.now ?? (() => Date.now());
    this.estimatedTokensPerCall = ports.estimatedTokensPerCall ?? DEFAULT_ESTIMATED_TOKENS_PER_CALL;
    this.estimatedCostPerCallUsd = ports.estimatedCostPerCallUsd ?? DEFAULT_ESTIMATED_COST_PER_CALL_USD;
    this.selfReviewDiffChars = Math.max(1_000, ports.selfReviewDiffChars ?? DEFAULT_SELF_REVIEW_DIFF_CHARS);
    this.toolCatalog = new CodingAgentToolCatalog(this.ports, this.limits);
    this.reviewPhases = new CodingAgentReviewPhases({
      ports: this.ports, limits: this.limits, now: this.now, selfReviewDiffChars: this.selfReviewDiffChars,
    });
    this.runPhases = new CodingAgentRunPhases({
      ports: this.ports, limits: this.limits, now: this.now, selfReviewDiffChars: this.selfReviewDiffChars,
    });
  }

  get subagentLimits(): ResolvedCodeSubagentLimits {
    return this.toolCatalog.subagentLimits;
  }

  toolDescriptors(session: CodeSession, options: ToolCatalogOptions = {}): CodeRunToolDescriptor[] {
    return this.toolCatalog.toolDescriptors(session, options);
  }

  private readonly visualContexts = new Map<string, { images: NonNullable<CodingAgentRunInput["images"]>; model?: string; extraSystemPromptLines?: readonly string[]; websiteEdit: true }>();
  private visualContextKey(ctx: CodingAgentRunInput["ctx"], session: CodeSession, runId: string): string {
    return JSON.stringify([ctx.workspaceId, ctx.userId, session.companyId, session.projectId, session.id, runId]);
  }
  referenceContext(ctx: CodingAgentRunInput["ctx"], session: CodeSession, parentRunId: string) {
    return this.visualContexts.get(this.visualContextKey(ctx, session, parentRunId));
  }
  async run(input: CodingAgentRunInput): Promise<CodingAgentRunResult> {
    if (!input.images?.length) return this.runOwned(input);
    input = { ...input, runId: input.runId ?? randomUUID(), runDetails: { ...input.runDetails, referenceImageCount: input.images.length } };
    const key = this.visualContextKey(input.ctx, input.session, input.runId!);
    this.visualContexts.set(key, { images: input.images!, model: input.model, extraSystemPromptLines: input.extraSystemPromptLines, websiteEdit: true });
    try { return await this.runOwned(input); }
    finally { this.visualContexts.delete(key); }
  }
  private async runOwned(input: CodingAgentRunInput): Promise<CodingAgentRunResult> {
    const startedAt = this.now();
    const { ctx, session } = input;
    const companyId = session.companyId;
    const projectId = session.projectId;
    const sessionId = session.id;
    const turnId = input.turnId ?? `run-${startedAt}`;

    const stepTurnKey = (index: number): string => `${turnId}#turn-${index}`;
    const toolSteps: number[] = [];

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

    this.ports.environment?.setRunSummary(summary);
    let snapshotId: string = EMPTY_SNAPSHOT_ID;
    let replayRecorder: CodeRunReplayRecorderPort | undefined;
    const completionArtifacts: Record<string, unknown>[] = [];
    const compressionArtifacts: Record<string, unknown>[] = [];
    let model: string | undefined;
    let provider: string | undefined;

    let lastBudget: ModelRequestPressure | null = null;
    let compactionCount = 0;
    let stateRunId: string | undefined;
    const stateOwner = input.runStateOwner ?? this.ports.runStateOwner
      ?? `runner-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

    let stopHeartbeat = (): void => {};
    let unsettledChildren = false;
    const pendingApprovals: CodingAgentPendingApproval[] = [];

    const finish = (
      status: CodingAgentRunStatus, reason: CodingAgentStopReason, message: string, code?: string,
    ): CodingAgentRunResult => this.runPhases.buildRunResult({
      input, summary, pendingApprovals, stopHeartbeat, status, reason, message, code,
      unsettledChildren, snapshotId, startedAt, stateRunId, model, provider, lastBudget, compactionCount,
    });

    const writeState = async (operation: () => Promise<unknown>): Promise<void> => {
      try { await operation(); } catch { /* Ignored */ }
    };

    let reviewCoordinator: CodingAgentReviewCoordinator | undefined;
    let inboxManager: CodingAgentInboxManager | undefined;

    const stop = async (
      status: Exclude<CodingAgentRunStatus, "waiting_for_user">, reason: CodingAgentStopReason, message: string,
    ): Promise<CodingAgentRunResult> => (await this.runPhases.stopRun({
      ctx, input, session, companyId, projectId, sessionId, status, reason, message,
      inboxOpened: inboxManager?.isOpened ?? false, stateRunId, stateOwner, summary,
      snapshotId, replayRecorder, completionArtifacts, compressionArtifacts,
      commandProvenance: commandPrompt.provenance, selfReviewVerdict: reviewCoordinator?.verdict ?? null,
      unsettledChildren, writeState, finish,
    })).result;

    let steps = Math.max(0, input.initialTurnIndex ?? 0);

    const pauseForUser = async (
      question: { questionId: string; toolCallId: string }, waitingFor: "question" | "approval" = "question",
    ): Promise<CodingAgentRunResult> => (await this.runPhases.pauseForUserOnce({
      ctx, session, companyId, steps, turnId, stateRunId, stateOwner,
      inboxOpened: inboxManager?.isOpened ?? false, summary, question, waitingFor,
      writeState, stopHeartbeat, turnCheckpointId: () => reviewCoordinator?.turnCheckpointId(steps) ?? null,
      release, finish,
    })).result;

    const release = async (reason: string): Promise<void> => {
      try {
        if (stateRunId && this.ports.activeChildren?.settle
          && !await this.ports.activeChildren.settle({ ctx, companyId, projectId, sessionId, runId: stateRunId, cancel: reason !== "completed" })) {
          unsettledChildren = true;
          return;
        }
        if (stateRunId && this.ports.activeChildren
          && await this.ports.activeChildren.isUnsettled({ ctx, companyId, projectId, sessionId, runId: stateRunId })) {
          unsettledChildren = true;
          return;
        }
      } catch {
        unsettledChildren = true;
        return;
      }
      if (!this.ports.sandbox) return;
      try {
        await this.ports.sandbox.release({ ctx, companyId, projectId, sessionId, reason });
      } catch {
        // Ignored
      }
    };

    let modelProfileFallbackReason: CodeModelProfileFallbackReason | null = null;

    const record = async (event: CodeRunActivityEvent): Promise<void> => {
      try {
        const withProfileReason = modelProfileFallbackReason === null ? event : { ...event, modelProfileFallbackReason };
        assertMetadataOnly(withProfileReason as unknown as Record<string, unknown>);
        if (!this.ports.activity) return;
        await this.ports.activity.record({ ...withProfileReason, runId: stateRunId ?? withProfileReason.runId, snapshotId: snapshotId || undefined });
      } catch {
        // Ignored
      }
    };

    const commandPrompt = await this.toolCatalog.resolveCommandPrompt(input, sessionId);
    let prompt = commandPrompt.text;

    const sessionStart = await startCodingAgentSession({
      ctx, session, input, ports: this.ports, limits: this.limits, runPhases: this.runPhases,
      toolCatalog: this.toolCatalog, companyId, projectId, sessionId, turnId, stateOwner, prompt,
      snapshotId, record, finish,
    });
    if (!sessionStart.ok) return sessionStart.result;

    const sessionState = sessionStart.state;
    stateRunId = sessionState.stateRunId;
    const { capabilityScope, capabilityScopeFields, delegationDepth, runTurnLimit, runMinuteLimit, leaseState } = sessionState;
    if (sessionState.heartbeatTimer) {
      stopHeartbeat = () => {
        if (sessionState.heartbeatTimer) { clearInterval(sessionState.heartbeatTimer); sessionState.heartbeatTimer = null; }
      };
    }

    let runtimeToolDescriptors: readonly CodeRunRuntimeToolDescriptor[] = [];
    let runtimeDiscovery: CodeRunRuntimeDiscovery | null = null;
    if (this.ports.runtimeCapabilities) {
      try {
        runtimeDiscovery = await this.ports.runtimeCapabilities.prepareForRun({
          ctx, companyId, projectId, ...(sessionId ? { sessionId } : {}),
          ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
        });
        runtimeToolDescriptors = runtimeDiscovery.tools;
        if (runtimeDiscovery.code) {
          this.ports.logger?.warn("code_run_runtime_capabilities_degraded", { companyId, code: runtimeDiscovery.code, toolCount: runtimeDiscovery.toolCount });
        }
      } catch (error) {
        runtimeDiscovery = null;
        runtimeToolDescriptors = [];
        this.ports.logger?.warn("code_run_runtime_capabilities_failed", { companyId, code: (error as { code?: string }).code ?? "runtime_capabilities_unavailable" });
      }
    }

    const toolOptions: ToolCatalogOptions = {
      asyncProcessesEnabled: !!this.ports.asyncProcessesEnabled && await this.ports.asyncProcessesEnabled(ctx, companyId, projectId),
      asyncSubagentsEnabled: !!this.ports.asyncSubagentsEnabled && await this.ports.asyncSubagentsEnabled(ctx, companyId),
      asyncAgentControlsEnabled: !!this.ports.asyncAgentControlsEnabled && await this.ports.asyncAgentControlsEnabled(ctx, companyId),
      readOnlyIntent: input.readOnlyIntent === true,
      capabilityScope,
      runtimeTools: runtimeToolDescriptors,
    };

    const tools = this.toolDescriptors(session, toolOptions).filter(tool => !input.websiteEdit || WEBSITE_EDIT_TOOL_PATTERN.test(tool.name));
    const modelName = input.model ?? "auto";
    const modelProviderHint = modelName.includes("/") ? (modelName.split("/")[0] ?? modelName) : modelName;

    let enabledProfileIds = this.ports.modelProfiles?.enabledProfileIds;
    if (this.ports.modelProfiles?.enabledProfileIdsForRun) {
      try {
        const resolved = await this.ports.modelProfiles.enabledProfileIdsForRun({ ctx, companyId, projectId, ...(sessionId ? { sessionId } : {}) });
        if (resolved) enabledProfileIds = resolved;
      } catch {
        enabledProfileIds = [];
      }
    }

    const profileResolution = resolveModelProfile({
      provider: modelProviderHint,
      model: modelName,
      ...(this.ports.modelProfiles?.profiles ? { profiles: this.ports.modelProfiles.profiles } : {}),
      ...(this.ports.modelProfiles?.overrides ? { overrides: this.ports.modelProfiles.overrides } : {}),
      ...(enabledProfileIds ? { enabledProfileIds } : {}),
    });
    const profile: CodeModelProfile = profileResolution.profile;

    // Profile tool tiers decide what the model is offered (main runs only; a sub-agent keeps its granted scope).
    let offeredTools = tools;
    if (!capabilityScope.isSubagent) {
      const dataStudioEnabled = await this.ports.flags.assertEnabled(ctx, CODE_DATA_STUDIO_FLAG, { companyId, userId: ctx.userId })
        .then(() => true, () => false);
      const { tools: visibleTools, decision: visibility } = await offeredToolsForRun({ tools, profile, run: input, sessionMode: session.mode, dataStudioEnabled });
      offeredTools = visibleTools;
      await record({
        kind: "tool_visibility", companyId, projectId, sessionId, runId: input.runId, turn: 0,
        profileId: profile.id, offeredCount: offeredTools.length, catalogCount: tools.length,
        contextualTools: visibility.contextual, intentGroups: visibility.intentGroups,
        degradedTools: visibility.hidden.filter(entry => entry.reason === "degraded").map(entry => entry.name),
      });
    }

    const resolvedProfileTrace = modelProfileFallbackTrace(profileResolution, { enabledProfileIds: enabledProfileIds ?? null });
    modelProfileFallbackReason = resolvedProfileTrace.fallbackReason;
    this.ports.environment?.setModelProfileTrace(resolvedProfileTrace);
    const schemaByName = this.toolCatalog.toolSchemaByName(runtimeToolDescriptors, session);

    const knownTools: KnownTool[] = offeredTools.map((tool) => ({ name: tool.name, inputSchema: schemaByName.get(tool.name)?.inputSchema ?? {} }));
    const definitions = this.toolCatalog.chatToolDefinitions(offeredTools, runtimeToolDescriptors, session)
      // Keep the runtime registry intact; advertise the tools needed to implement
      // a new project instead of repeatedly paying for unrelated admin schemas.
      .filter(tool => !input.requireImplementation || WEBSITE_EDIT_TOOL_PATTERN.test(tool.function.name));

    let engineSupportsNativeTools = false;
    if (this.ports.engine.supportsNativeTools) {
      try { engineSupportsNativeTools = (await this.ports.engine.supportsNativeTools(input.model)) === true; } catch { engineSupportsNativeTools = false; }
    }

    const { systemPrompt } = await buildRunPromptContext({
      ctx, session, input, ports: this.ports, limits: this.limits, companyId, projectId, sessionId,
      prompt, startedAt, runTurnLimit, tools: offeredTools, profile,
    });

    this.ports.environment?.setModelSelection({ provider: modelProviderHint, model: modelName });

    try {
      const snapshot = await this.snapshot.create({
        companyId, projectId, sessionId, workspaceId: session.workspaceId,
        runId: stateRunId ?? input.runId, actor: ctx.userId, ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      snapshotId = snapshot.snapshotId;
    } catch {
      await release("snapshot_unavailable");
      return { ...await stop("failed", "refused", "Execution snapshot could not be persisted. No model request or tool call was executed."), code: "snapshot_unavailable" };
    }

    replayRecorder = this.ports.replayBundle?.start({
      companyId, projectId, sessionId, workspaceId: session.workspaceId, runId: stateRunId ?? input.runId ?? "",
      ...(snapshotId ? { snapshotId } : {}),
      modelSelection: this.ports.environment?.modelSelection() ?? null,
      systemPrompt: this.ports.environment?.systemPrompt() ?? null,
      modelProfileVersion: this.ports.environment?.modelProfileVersion() ?? null,
      toolVersions: Object.fromEntries(offeredTools.map((tool) => [tool.name, tool.version])),
      dataClassification: session.dataClassification, retentionClass: session.retentionClass,
      ...(commandPrompt.provenance.length > 0 ? { commandProvenance: commandPrompt.provenance } : {}),
    });

    const toolVersionByName = new Map(offeredTools.map((tool) => [tool.name, tool.version] as const));
    const runtimeToolByName = new Map(runtimeToolDescriptors.map((tool) => [tool.name, tool] as const));

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    inboxManager = new CodingAgentInboxManager({
      ctx, session, input, ports: this.ports, stateRunId, stateOwner,
      useInbox: sessionState.useInbox, messages, completionArtifacts,
      onUserInstruction: (text) => { prompt += `\n\nAdditional user instruction:\n${text}`; },
    });

    const initialInbox = await inboxManager.setupInitialInbox();
    if (!initialInbox.ok) return stop("failed", "refused", initialInbox.error);
    for (const message of initialInbox.recovered) await inboxManager.appendInboxMessage(message, 0);

    reviewCoordinator = new CodingAgentReviewCoordinator({
      ports: this.ports, limits: this.limits, reviewPhases: this.reviewPhases,
      selfReviewDiffChars: this.selfReviewDiffChars, input, ctx, session, companyId,
      projectId, sessionId, turnId, stepTurnKey, toolSteps, capabilityScopeFields,
      summary, messages, record, release, stop,
    });

    const toolWaves = new CodingAgentToolWaves({
      ports: this.ports, limits: this.limits, now: this.now, input, ctx, session,
      companyId, projectId, sessionId, turnId, stepTurnKey, stateRunId, stateOwner,
      toolSteps, capabilityScopeFields, summary, messages, runtimeToolByName,
      toolVersionByName, completionArtifacts, replayRecorder, pendingApprovals,
      reviewCoordinator, record, release, writeState, stop, pauseForUser,
    });

    const cancelled = async (): Promise<boolean> => {
      if (input.signal?.aborted) return true;
      if (!input.cancelRequested) return false;
      try { return await input.cancelRequested(); } catch { return false; }
    };

    const suspendByFlag = async (): Promise<CodingAgentRunResult> => {
      await release("feature_disabled");
      return { ...await stop("suspended_by_flag", "feature_disabled", "The run was suspended by the Coding Agent kill switch."), code: "feature_disabled" };
    };

    const stopIfFlagDisabled = async (): Promise<CodingAgentRunResult | null> => {
      try {
        await this.ports.flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId, userId: ctx.userId });
        return null;
      } catch (error) {
        const code = (error as { code?: string }).code === "feature_disabled" ? "feature_disabled" : "feature_gate_unavailable";
        if (code === "feature_disabled") return suspendByFlag();
        await release(code);
        const result = await stop("interrupted", "refused", "The Coding Agent flag no longer permits this run. No further model or tool call was dispatched.");
        return { ...result, code };
      }
    };

    await this.reviewPhases.replayApprovedToolCalls({
      ctx, input, companyId, projectId, sessionId, stateRunId, steps,
      runtimeToolByName, toolVersionByName, messages, summary, replayRecorder, writeState, record,
    });

    let sawNativeToolCalls = false;
    let inspectionTurns = 0;
    let noProgressTurns = 0;
    let lastProgressFingerprint = "";
    /** A turn that executed a mutating tool is progress even when the changed-file set stays the same. */
    let lastTurnMutated = false;
    let inspectedStyles = false;
    let inspectionReminderSent = false;
    let emptyImplementationReplies = 0;
    let initialTokenBudget: number | undefined;
    let budgetReminderSent = false;

    for (;;) {
      if (leaseState.lost) {
        await release("interrupted");
        return stop("interrupted", "interrupted", "Stopped: this process lost the run lease (another worker took over). No further changes were made.");
      }
      if (await cancelled()) {
        if ((input.signal?.reason as { code?: string } | undefined)?.code === "feature_disabled") return suspendByFlag();
        if (input.detachedChildInbox && (input.signal?.reason as { code?: string } | undefined)?.code === "subagent_interrupt") {
          return stop("interrupted", "interrupted", "The child was interrupted at a safe boundary and can be continued.");
        }
        await release("cancelled");
        await this.ports.runEvents?.append({ eventKey: `code-run-cancelled:${turnId}`, eventType: "cancelled", runStatus: "cancelled", message: "Coding Agent run cancelled by the user" });
        return stop("cancelled", "cancelled", "The run was cancelled. Any running processes were stopped and the sandbox was released.");
      }
      const flagStop = await stopIfFlagDisabled();
      if (flagStop) return flagStop;
      for (const content of this.ports.engine.recordedCompletionInputs?.(steps + 1) ?? []) messages.push({ role: "user", content });

      if (inboxManager.isOpened) {
        try {
          await inboxManager.reopenIfSealed();
          await inboxManager.admitInbox(steps);
        } catch {
          return stop("interrupted", "interrupted", "Stopped: durable inbox admission failed. Pending input remains recoverable.");
        }
      }

      if (runTurnLimit > 0 && steps >= runTurnLimit) {
        await release("step_limit");
        summary.remaining = "Step limit reached; the task may be unfinished.";
        return stop("stopped", "step_limit", `Stopped after ${runTurnLimit} turns: the step limit was reached.`);
      }
      if (runMinuteLimit > 0 && this.now() - startedAt > runMinuteLimit * 60_000) {
        await release("time_limit");
        summary.remaining = "Time limit reached; the task may be unfinished.";
        return stop("stopped", "time_limit", `Stopped after ${runMinuteLimit} minutes: the time limit was reached.`);
      }
      let quotaRemaining: number | undefined;
      if (this.ports.quota) {
        const verdict = this.ports.quota.checkQuota(input.quotaSessionId ?? sessionId, 0, this.estimatedCostPerCallUsd, delegationDepth, { userId: ctx.userId, companyId });
        quotaRemaining = verdict.remainingTokens;
        initialTokenBudget ??= quotaRemaining;
        if (input.requireImplementation && !budgetReminderSent && quotaRemaining !== undefined && initialTokenBudget !== undefined && quotaRemaining < initialTokenBudget * 0.4) {
          budgetReminderSent = true;
          messages.push({ role: "system", content: "Less than 40% of the token budget remains. Stop broad inspection and optional refinements. Finish the requested working interactions in the next implementation steps, then provide your final response so the system can run the production build, repairs and Live Preview. State any unfinished requirements honestly; do not spend the verification reserve on repeated reads." });
        }
        if (!verdict.allowed) {
          await release("budget_exhausted");
          summary.remaining = verdict.error ?? "Budget exhausted.";
          return stop("stopped", "budget_exhausted", `Stopped: ${summary.remaining}`);
        }
      }

      const compaction = await compactConversationContextIfNeeded({
        ports: this.ports, limits: this.limits, input, session, companyId, projectId,
        sessionId, stateRunId, snapshotId, steps, systemPrompt, definitions, messages,
        profile, quotaRemaining, estimatedTokensPerCall: this.estimatedTokensPerCall,
        compressionArtifacts, record,
      });
      lastBudget = compaction.lastBudget;
      if (compaction.compacted) compactionCount += 1;

      if (this.ports.quota) {
        const requestTokens = resolveModelRequestPressure({
          systemPrompt, toolSchemas: JSON.stringify(definitions),
          messages: messages.slice(1).map((m) => ({ role: m.role, content: chatContentText(m.content) + (m.tool_calls ? JSON.stringify(m.tool_calls) : "") + (m.reasoning_content ?? "") + (m.reasoning_text ?? "") })),
          contextWindow: profile.contextWindow, compressionRatio: this.limits.contextCompressionRatio,
        }).currentTokens;
        const verdict = this.ports.quota.checkQuota(input.quotaSessionId ?? sessionId, requestTokens + this.estimatedTokensPerCall, this.estimatedCostPerCallUsd, delegationDepth, { userId: ctx.userId, companyId });
        if (!verdict.allowed) {
          await release("budget_exhausted");
          summary.remaining = verdict.error ?? "Budget exhausted.";
          return stop("stopped", "budget_exhausted", `Stopped: ${summary.remaining}`);
        }
      }

      const beforeModelStop = await stopIfFlagDisabled();
      if (beforeModelStop) return beforeModelStop;
      // A creation run must progress from inspecting the template to changing source.
      const progressChanges = reviewCoordinator.runChanges();
      const currentChanges = progressChanges.map(change => change.path);
      if (!input.readOnlyIntent && session.mode !== "plan" && (input.websiteEdit || input.requireImplementation)) {
        const fingerprint = JSON.stringify(progressChanges);
        const progressed = steps > 0 && (fingerprint !== lastProgressFingerprint || lastTurnMutated);
        noProgressTurns = progressed ? 0 : noProgressTurns + 1;
        lastProgressFingerprint = fingerprint;
        lastTurnMutated = false;
        if (noProgressTurns === 4) {
          await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "no_source_progress" });
          messages.push({ role: "system", content: input.requireImplementation
            ? "Four model turns produced no source progress. The creation request is still incomplete. Stop rereading your generated styles/components. Implement the user-facing entry page and working actions now using the files already available; state reasonable assumptions for missing details. A scaffold or stylesheet alone is not a delivered application. If blocked, report the concrete blocker. Build/Preview and visual acceptance remain mandatory separate checks."
            : "Four model turns produced no source progress. Stop repeated inspection/planning. Use the files already read to implement the current request; if blocked, report the concrete blocker. Build/Preview and visual acceptance are separate system checks." });
        }
        if (noProgressTurns >= 10) {
          await release("loop_detected");
          return stop("stopped", "loop_detected", "Stopped: ten model turns without source progress. No claim of completed implementation or visual acceptance is made.");
        }
      }
      const needsImplementation = input.requireImplementation && !input.readOnlyIntent && session.mode !== "plan" && currentChanges.length === 0;
      const inspectionLimit = input.allowStylePreview && inspectedStyles ? 1 : 3;
      const implementNow = !input.readOnlyIntent && session.mode !== "plan" && inspectionTurns >= inspectionLimit;
      if (implementNow && !inspectionReminderSent) {
        inspectionReminderSent = true;
        messages.push({ role: "system", content: currentChanges.length ? "Source changes have already been saved. If the requested edit is implemented, finish now so the system can verify and publish Preview. Do not audit unrelated styles or expand the task. Inspect only a concrete unresolved issue." : inspectionLimit === 1 ? "You have already read the relevant stylesheets for this existing-site edit. Use those declarations to implement the requested targeted change now, including any necessary contrast correction, then finish. Do not expand a simple palette change into repeated background searches or a component audit. Inspect further only for a concrete unresolved override or dependency. Read tools remain available." : "You have spent three consecutive turns inspecting files without a source change. Use the relevant content already in context to make the requested targeted edit now. For a visual or color change, prefer editing the existing theme variables and affected selectors instead of rereading the whole stylesheet. Inspection tools remain available when necessary for a safe edit. Do not expand the scope or regenerate existing components." });
      }
      if (input.requireImplementation || currentChanges.length > 0 && !input.readOnlyIntent && session.mode !== "plan") {
        const marker = "Current implementation progress (runtime facts): ";
        const previous = messages.findIndex(message => message.role === "system" && typeof message.content === "string" && message.content.startsWith(marker));
        if (previous >= 0) messages.splice(previous, 1);
        messages.push({ role: "system", content: marker + JSON.stringify(currentChanges) + (input.requireImplementation ? ". These files have already been implemented by this run, even if earlier code was compacted from history. Do not regenerate equivalent providers, catalogs, shared components or scaffolding. Use targeted edits for corrections. Finish the missing user-facing pages and requested working interactions, then finalize so the system can build and start Preview." : ". These files already contain saved changes for the current edit request, even if earlier tool results were compacted. Do not repeat completed edits or broaden the task into a whole-project audit. If the requested change is implemented, finish now; mandatory verification and Live Preview follow automatically. Batch any remaining related changes in one patch.") });
      }
      let result: ChatResult;
      let modelStarted = this.now();
      const thinking = {
        id: `${stateRunId ?? input.runId}:thinking:${steps + 1}`, runId: stateRunId ?? input.runId,
        stage: "model_response", title: "Waiting for the model response", at: new Date(modelStarted).toISOString(),
      };
      await emitCodingActivity(input, { ...thinking, status: "running" });
      await record({kind:"model_call",phase:"started",companyId,projectId,sessionId,turn:steps+1,model:input.model});
      try {
        modelStarted = this.now();
        let providerAttempt=0;
        let firstTokenRecorded=false;
        result = await this.ports.engine.chat({
          /**
           * Step 1: the reasoning override is deliberately NOT sent. Measured on the live provider, disabling
           * reasoning for a tool-bearing turn caps the tool-call arguments at ~21.2 KB and the call arrives with
           * `finish_reason: "tool_calls"` but truncated JSON, which is then rejected as `partial_tool_call`.
           * The same turn with the model's default reasoning produced a valid 50.6 KB argument object. A forced
           * `tool_choice` is also rejected by the provider while reasoning is on, so it stays `"auto"`.
           */
          onGenerationProgress: async event => {
            if (!firstTokenRecorded) {
              firstTokenRecorded=true;
              await record({kind:"model_first_token",companyId,projectId,sessionId,turn:steps+1,model:input.model,firstTokenMs:event.firstTokenMs});
            }
            await emitCodingActivity(input, {...thinking, stage:event.phase === "tool_arguments" ? "model_generation" : "model_output", title:event.phase === "tool_arguments" ? "Generating code" : "The model is responding",status:"running",durationMs:this.now()-modelStarted});
          },
          onProviderAttempt:async(event)=>{
            if(event.phase==="started") providerAttempt++;
            await record({kind:"model_call",companyId,projectId,sessionId,turn:steps+1,attempt:providerAttempt,...event});
          },
          messages: withCodingReferenceImages(messages, input.images),
          /**
           * Step 3: the stable prefix is offered to the adapter. Only providers that require an explicit cache
           * marker use it; everyone else receives the same system string as before (measured: implicit caching
           * already reports cached tokens without a directive, and an unexpected block array can drop the prompt).
           */
          systemCachePrefix: systemPromptStablePrefix(systemPrompt),
          ...(definitions.length ? { tools: definitions } : {}),
          ...(definitions.length ? { toolChoice: "auto" as const } : {}),
          /**
           * Step 5: stream the answer text to the transport as it arrives. Turning streaming on for this request is
           * the same switch the progress counters already use; the adapter reports only `delta.content`, so no tool
           * argument fragment or reasoning text can reach the client.
           */
          ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
          model: input.model,
          ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
          signal: input.signal,
          idempotencyKey: `${sessionId}:${turnId}:${steps}`,
          policyContext: { companyId, projectId, sessionId, dataClassification: session.dataClassification },
        });
      } catch (error) {
        const diagnostic=error as {code?:string;message?:string;status?:number;statusCode?:number;httpStatus?:number};
        await record({kind:"model_call",phase:"failed",companyId,projectId,sessionId,turn:steps+1,model:input.model,durationMs:this.now()-modelStarted,errorCode:diagnostic.code ?? "provider_error",httpStatus:diagnostic.httpStatus ?? diagnostic.statusCode ?? diagnostic.status});
        await emitCodingActivity(input, { ...thinking, status: input.signal?.aborted ? "cancelled" : "failed", durationMs: this.now() - modelStarted,error:diagnostic.message,errorCode:diagnostic.code ?? "provider_error" });
        if (input.detachedChildInbox && (input.signal?.reason as { code?: string } | undefined)?.code === "subagent_interrupt") {
          return stop("interrupted", "interrupted", "The child was interrupted during its model request and can be continued.");
        }
        if (input.signal?.aborted || await cancelled()) {
          if ((input.signal?.reason as { code?: string } | undefined)?.code === "feature_disabled") return suspendByFlag();
          await release("cancelled");
          await this.ports.runEvents?.append({ eventKey: `code-run-cancelled:${turnId}`, eventType: "cancelled", runStatus: "cancelled", message: "Coding Agent run cancelled during model request" });
          return stop("cancelled", "cancelled", "The run was cancelled during its model request.");
        }
        const failure = error as { code?: string; message?: string };
        await release("provider_error");
        await this.ports.runEvents?.append({ eventKey: `code-run-failed:${turnId}`, eventType: "failed", runStatus: "failed", message: "Coding Agent run failed" });
        return stop("failed", "provider_error", failure.message ?? `The model provider failed (${failure.code ?? "provider_error"}).`);
      }

      steps += 1;
      await record({kind:"model_call",phase:"completed",companyId,projectId,sessionId,turn:steps,model:result.model ?? input.model,provider:result.telemetry?.provider,finishReason:result.finishReason,durationMs:this.now()-modelStarted});
      await emitCodingActivity(input, { ...thinking, status: "completed", durationMs: this.now() - modelStarted });
      summary.turns = steps;
      model = result.model ?? model;
      provider = result.telemetry?.provider ?? provider;
      const tokens = result.usage?.totalTokens ?? ((result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0));
      const modelUsage = {
        id: `${stateRunId ?? input.runId}:model:${steps}`,
        turn: steps,
        totalTokens: result.usage ? tokens : undefined,
        inputTokens: result.usage?.promptTokens,
        outputTokens: result.usage?.completionTokens,
        ...(result.usage?.cachedTokens ? { cachedTokens: result.usage.cachedTokens } : {}),
        costUsd: result.telemetry?.costUsd,
        model: result.model ?? input.model,
        provider: result.telemetry?.provider,
        toolCallIds: (result.toolCalls ?? []).map((call) => call.id),
        durationMs: this.now() - modelStarted,
      };
      await emitCodingActivity(input, {
        id: modelUsage.id, runId: stateRunId ?? input.runId, stage: "model_usage",
        title: "Model usage", at: new Date(modelStarted).toISOString(), status: "completed", modelUsage,
      });
      summary.tokens += tokens;
      const costUsd = result.telemetry?.costUsd ?? 0;
      summary.costUsd += costUsd;
      if (this.ports.quota && (tokens > 0 || costUsd > 0)) {
        try { this.ports.quota.recordUsage(input.quotaSessionId ?? sessionId, tokens, costUsd, { userId: ctx.userId, companyId }); } catch { /* Ignored */ }
      }
      await record({ kind: "turn", companyId, projectId, sessionId, runId: input.runId, turn: steps, bytes: tokens });

      this.ports.logger?.info?.("code_settlement_boundary", { runId: stateRunId, stage: "response_recorded", turn: steps });

      // Account for a completed provider response even when cancellation arrived in flight. Never execute its calls.
      if (await cancelled()) {
        if ((input.signal?.reason as { code?: string } | undefined)?.code === "feature_disabled") return suspendByFlag();
        if (input.detachedChildInbox && (input.signal?.reason as { code?: string } | undefined)?.code === "subagent_interrupt") return stop("interrupted", "interrupted", "The child was interrupted after its model request and can be continued.");
        await release("cancelled");
        await this.ports.runEvents?.append({ eventKey: `code-run-cancelled:${turnId}`, eventType: "cancelled", runStatus: "cancelled", message: "Coding Agent run cancelled after model request" });
        return stop("cancelled", "cancelled", "The run was cancelled after its model request. No returned tool calls were executed.");
      }


      const afterModelStop = await stopIfFlagDisabled();
      if (afterModelStop) return afterModelStop;

      if (result.toolCalls?.length) sawNativeToolCalls = true;

      const mode = resolveEffectiveToolCallingMode(profile, { sawNativeToolCalls: sawNativeToolCalls || engineSupportsNativeTools });
      const normalized: NormalizeToolCallsResult = normalizeToolCalls({
        payload: { toolCalls: result.toolCalls ?? null, content: result.content ?? null, finishReason: result.finishReason ?? null },
        profile, mode, knownTools, validate: validateArguments,
      });
      // Text adapters synthesize IDs per response; scope them to this turn before deduplication.
      for (const call of normalized.calls) if (call.source === "text" || call.id.startsWith("text:")) call.id = `${turnId}:${steps}:${call.id}`;
      for (const rejected of normalized.rejected) if (rejected.id?.startsWith("text:")) rejected.id = `${turnId}:${steps}:${rejected.id}`;

      replayRecorder?.recordModelStep({
        turnIndex: steps,
        request: {
          model: input.model ?? null, messageCount: messages.length,
          imageCount: input.images?.length ?? 0,
          imageHashes: input.images?.map(image => createHash("sha256").update(Buffer.from(image.dataBase64, "base64")).digest("hex")) ?? [],
          toolNames: definitions.map((d) => d.function.name), idempotencyKey: `${sessionId}:${turnId}:${steps}`,
          dataClassification: session.dataClassification,
        },
        response: {
          content: result.content ?? "", finishReason: result.finishReason ?? null,
          model: result.model ?? null, provider: result.telemetry?.provider ?? null,
          usage: result.usage ? { totalTokens: result.usage.totalTokens, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens } : null,
          toolCalls: (result.toolCalls ?? []).map((call) => ({
            id: call.id, name: call.function?.name ?? "",
            argumentsHash: replayArgumentsHash(call.function?.arguments),
            arguments: call.function?.arguments ?? "",
          })),
        },
      });

      const callsToRun = executableToolCalls(normalized);
      inspectedStyles = callsToRun.some(call => call.name === "code.fs.read" && typeof call.arguments.path === "string" && /\.css$/i.test(call.arguments.path));
      if (callsToRun.length && callsToRun.every(call => /^code\.fs\.(read|list|tree|search|glob|grep)$/.test(call.name))) inspectionTurns++;
      else if (callsToRun.length) { inspectionTurns = 0; inspectionReminderSent = false; }
      const publishActivity = async (event: import("@npati/shared").DevelopmentProcessProgressItem) => {
        await emitCodingActivity(input, event);
      };
      if (callsToRun.length && result.toolCalls?.length && result.content?.trim() && !/\<\/?(?:think|analysis|tool_call|tool_calls)\b/i.test(result.content)) {
        await publishActivity({
          id: `${stateRunId ?? input.runId}:message:${steps}`, runId: stateRunId ?? input.runId,
          sequence: steps * 1000, kind: "assistant_message", stage: "planning",
          title: result.content, at: new Date(this.now()).toISOString(), status: "completed",
          agentId: input.agentId ?? "NPATI Coding Agent",
        });
      }
      const assistantText = result.content ?? "";

      const openTurn = async (): Promise<void> => {
        if (!stateRunId || !this.ports.runState) return;
        await writeState(() => this.ports.runState!.appendTurn({ companyId, runId: stateRunId!, turnIndex: steps, status: "running" }));
      };

      // Final answer for a reply without tool calls or a successful `code.finish`; `null` keeps the loop going.
      const settleTurn = (finalText: string, turnOpened: boolean) => settleCodingTurn({
        ports: this.ports, companyId, stateRunId, stateOwner, startedAt, steps, prompt,
        inboxManager: inboxManager!, reviewCoordinator: reviewCoordinator!, openTurn, writeState, cancelled, stop,
      }, finalText, turnOpened);

      if (!callsToRun.length && !normalized.rejected.length) {
        if (needsImplementation) {
          if (++emptyImplementationReplies >= 3) {
            await release("refused");
            return stop("failed", "refused", "The agent did not implement the requested project. No source files changed; build and Live Preview were not published.");
          }
          messages.push({ ...providerContinuationFor(result), role: "assistant", content: assistantText }, { role: "system", content: "This is a creation request and no source files changed. Implement the requested features with file tools. Acknowledgement or a plan alone does not complete this task." });
          continue;
        }
        const settled = await settleTurn(assistantText, false);
        if (settled) return settled;
        continue;
      }

      await openTurn();

      const assistantMessage: ChatMessage = { ...providerContinuationFor(result), role: "assistant", content: assistantText };
      const historyCalls = callsToRun.map(toChatToolCall);
      for (const [index, rejected] of normalized.rejected.entries()) {
        rejected.id ??= normalized.calls.find((call) => call.partial && call.name === rejected.name)?.id ?? `rejected:${steps}:${index}`;
        // Rejected calls still need a matching assistant entry before their tool feedback.
        if (!historyCalls.some((call) => call.id === rejected.id)) historyCalls.push({
          id: rejected.id, type: "function", function: { name: rejected.name ?? "invalid_tool_call", arguments: "{}" },
        });
      }
      if (historyCalls.length) assistantMessage.tool_calls = historyCalls;
      messages.push(assistantMessage);

      const waveOutcome = await toolWaves.executeTurnTools({ steps, normalized, callsToRun, profile, modelUsage });
      // Remember whether this turn attempted a source mutation; the guard runs at the start of the next turn.
      lastTurnMutated = callsToRun.some(call => /^code\.fs\.(write|edit|apply_patch|move|delete)$|^code\.deps\.add$|^code\.data\.(schema\.(apply|modify)|rows\.(seed|transfer)|policies\.apply|backend\.(create|attach))$/.test(call.name));
      if (waveOutcome.action === "paused" || waveOutcome.action === "stopped") return waveOutcome.result;

      // `code.finish`: an explicit end of the run. Only a call the runtime accepted counts; a refused or invalid
      // finish is ordinary tool feedback and the loop continues.
      const finishText = finishedRunText(callsToRun, messages, assistantText);
      if (finishText !== null && input.requireImplementation && !input.readOnlyIntent && session.mode !== "plan" && reviewCoordinator.runChanges().length === 0) {
        if (++emptyImplementationReplies >= 3) {
          await release("refused");
          return stop("failed", "refused", "The agent did not implement the requested project. No source files changed; build and Live Preview were not published.");
        }
        messages.push({ role: "system", content: "code.finish was called but this is a creation request and no source files changed. Implement the requested features with file tools before finishing." });
      } else if (finishText !== null) {
        const settled = await settleTurn(finishText, true);
        if (settled) return settled;
      }
    }
  }
}
