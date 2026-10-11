
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

  private readonly selfReviewDiffChars: number;

  constructor(private readonly ports: CodingAgentRunnerPorts) {
    this.limits = { ...resolveCodeAgentLimits(), ...ports.limits };
    this.snapshot = resolveExecutionSnapshotProvider(ports.snapshot);
    this.now = ports.now ?? (() => Date.now());
    this.estimatedTokensPerCall = ports.estimatedTokensPerCall ?? DEFAULT_ESTIMATED_TOKENS_PER_CALL;
    this.estimatedCostPerCallUsd = ports.estimatedCostPerCallUsd ?? DEFAULT_ESTIMATED_COST_PER_CALL_USD;
    this.selfReviewDiffChars = Math.max(1_000, ports.selfReviewDiffChars ?? DEFAULT_SELF_REVIEW_DIFF_CHARS);
  }

  get subagentLimits(): ResolvedCodeSubagentLimits {
    return resolveCodeSubagentLimits(this.limits);
  }

  private publishedTools(): CodeRunToolDescriptor[] {
    return this.ports.toolRuntime.listTools().filter((tool) => tool.status === "active");
  }

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
      if (!schema) continue;
      definitions.push({
        type: "function",
        function: { name: schema.name, description: schema.description, parameters: schema.inputSchema },
      });
    }
    return definitions;
  }

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

    const stepTurnKey = (index: number): string => `${turnId}#turn-${index}`;

    const toolSteps: number[] = [];

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

    this.ports.environment?.setRunSummary(summary);
    let snapshotId: string = EMPTY_SNAPSHOT_ID;

    let replayRecorder: CodeRunReplayRecorderPort | undefined;
    const completionArtifacts: Record<string, unknown>[] = [];
    let model: string | undefined;
    let provider: string | undefined;

    let lastBudget: ModelRequestPressure | null = null;
    let compactionCount = 0;

    const verificationTools = Object.freeze([...(input.verificationTools ?? DEFAULT_VERIFICATION_TOOLS)]);
    const verificationLoop: VerificationLoop = createVerificationLoop({
      maxRepairAttempts: this.limits.repairLoopAttempts,
      requestedTools: verificationTools,
    });

    const verificationDisabled = verificationTools.length === 0;
    let testIntegrity: TestIntegrityVerdict | null = null;
    let scopeGuard: ScopeGuardResult | null = null;

    let selfReviewState: SelfReviewState | null = null;
    let selfReviewVerdict: SelfReviewVerdict | null = null;

    let selfReviewPasses = 0;

    let verifiedSignature: string | null = null;

    let selfReviewFixPending = false;

    let stateRunId: string | undefined;
    const stateOwner = input.runStateOwner ?? this.ports.runStateOwner
      ?? `runner-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    let leaseLost = false;

    let unsettledChildren = false;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    };

    const commandPrompt = await this.resolveCommandPrompt(input, sessionId);
    let prompt = commandPrompt.text;
    let inboxOpened = false;
    let inboxSealed = false;
    let recoveredInbox: CodeInboxMessage[] = [];

    const pendingApprovals: CodingAgentPendingApproval[] = [];

    const finish = (
      status: CodingAgentRunStatus,
      reason: CodingAgentStopReason,
      message: string,
      code?: string,
    ): CodingAgentRunResult => this.buildRunResult({
      input,
      summary,
      pendingApprovals,
      stopHeartbeat,
      status,
      reason,
      message,
      code,
      unsettledChildren,
      snapshotId,
      startedAt,
      stateRunId,
      model,
      provider,
      lastBudget,
      compactionCount,
    });

    const writeState = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch {

      }
    };

    const stop = async (
      status: Exclude<CodingAgentRunStatus, "waiting_for_user">,
      reason: CodingAgentStopReason,
      message: string,
    ): Promise<CodingAgentRunResult> => {
      const stopped = await this.stopRun({
        ctx,
        input,
        session,
        companyId,
        projectId,
        sessionId,
        status,
        reason,
        message,
        inboxOpened,
        stateRunId,
        stateOwner,
        summary,
        snapshotId,
        replayRecorder,
        completionArtifacts,
        compressionArtifacts,
        commandProvenance: commandPrompt.provenance,
        selfReviewVerdict,
        unsettledChildren,
        writeState,
        finish,
      });
      inboxOpened = stopped.inboxOpened;
      return stopped.result;
    };

    const pauseForUser = async (
      question: { questionId: string; toolCallId: string },

      waitingFor: "question" | "approval" = "question",
    ): Promise<CodingAgentRunResult> => {
      const paused = await this.pauseForUserOnce({
        ctx,
        session,
        companyId,
        steps,
        turnId,
        stateRunId,
        stateOwner,
        inboxOpened,
        summary,
        question,
        waitingFor,
        writeState,
        stopHeartbeat,
        turnCheckpointId,
        release,
        finish,
      });
      inboxOpened = paused.inboxOpened;
      return paused.result;
    };

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

      }
    };

    let modelProfileFallbackReason: CodeModelProfileFallbackReason | null = null;

    const record = async (event: CodeRunActivityEvent): Promise<void> => {

      try {

        const withProfileReason = modelProfileFallbackReason === null
          ? event
          : { ...event, modelProfileFallbackReason };
        assertMetadataOnly(withProfileReason as unknown as Record<string, unknown>);
        if (!this.ports.activity) return;
        await this.ports.activity.record({ ...withProfileReason, snapshotId: snapshotId || undefined });
      } catch {

      }
    };

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

        }
      }
      return [...merged.values()];
    };

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

        }
      }
      return { files: paths.size, linesAdded, linesRemoved };
    };

    const turnCheckpointId = (): string | null => {
      if (this.ports.toolRuntime.turnSummary) {
        try {
          const current = this.ports.toolRuntime.turnSummary(sessionId, stepTurnKey(steps)).checkpointId ?? null;
          if (current) lastCheckpointId = current;
        } catch {

        }
      }
      return lastCheckpointId;
    };

    const describeFindings = (findings: ReadonlyArray<{ path: string; kind: string }>): string =>
      findings.slice(0, 5).map((finding) => `${finding.path}:${finding.kind}`).join(", ");

    const evaluateChangeSet = async (): Promise<void> => {
      const evaluated = await this.evaluateChangeSet({
        input,
        companyId,
        projectId,
        sessionId,
        steps,
        prompt,
        summary,
        runChanges,
        record,
      });
      if (!evaluated) return;
      testIntegrity = evaluated.testIntegrity;
      scopeGuard = evaluated.scopeGuard;
    };

    const toCheckReports = (outcome: CodeToolInvokeResult | CodeToolInvokeFailure): VerificationCheckReport[] => {
      if (!outcome.ok) {
        const code = String(outcome.error.code);

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

      return verificationTools.map((tool) => ({ tool, state: "passed" }));
    };

    const runVerification = (): Promise<void> => this.verifyOnce({
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      stateRunId,
      steps,
      turnId,
      verificationTools,
      capabilityScopeFields,
      verificationLoop,
      toCheckReports,
      record,
    });

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

        })),
        ...(integrity
          ? {
              testIntegrity: {
                flagged: integrity.flagged,
                requiresJustification: integrity.requiresJustification,

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

    const verificationStopMessage = (): string => {
      const failed = verificationLoop.report().failedChecks;
      const detail = failed.length
        ? failed.map((check) => `${check.tool}${check.code ? ` (${check.code})` : ""}`).join(", ")
        : "verification did not run";
      return `Stopped: verification still fails after ${verificationLoop.attemptsUsed()} repair attempt(s): ${detail}.`;
    };

    const currentChangeSignature = (): string => {
      const changes = runChanges().slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return changes.map((change) => `${change.path}:${change.status ?? ""}:${sha256Hex(change.diff ?? "")}`).join("|");
    };

    const boundedDiff = (limit: number): string => {
      const parts = runChanges()
        .filter((change) => typeof change.diff === "string" && change.diff.length > 0)
        .map((change) => `--- ${change.path}\n${change.diff ?? ""}`);
      const joined = parts.join("\n");
      const bound = bounded(joined, limit);
      return bound.truncated ? `${bound.text}\n[the diff shown to this review was truncated at ${limit} characters]` : bound.text;
    };

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

        return null;
      }
    };

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

    const runSelfReview = async (): Promise<void> => {
      const verdict = await this.runSelfReviewOnce({
        input,
        session,
        companyId,
        projectId,
        sessionId,
        steps,
        prompt,
        selfReviewState,
        loadApprovedPlan,
        runChanges,
        verificationForReview,
        testIntegrityForReview,
        boundedDiff,
        writeSelfReviewSummary,
        setSelfReviewVerdict: (value) => { selfReviewVerdict = value; },
        record,
      });
      if (verdict) selfReviewVerdict = verdict;
    };
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

    const verifyAndDecide = async (): Promise<"passed" | "repair" | "approval_required" | "unavailable" | "exhausted"> => {
      await runVerification();

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

    const beginSelfReview = async (): Promise<void> => {
      beginSelfReviewState();
      await runSelfReview();
    };

    const afterSelfReview = async (): Promise<{ action: "complete" } | { action: "stop"; reason: CodingAgentStopReason; message: string } | { action: "continue" }> => {
      const verdict = selfReviewVerdict;
      if (!verdict) return { action: "complete" };

      if (verdict.status === "unavailable") {

        return { action: "stop", reason: "self_review_unavailable", message: selfReviewStopMessage(verdict) };
      }

      if (verdict.status === "findings") {
        const instruction = selfReviewState?.applyFix() ?? null;
        if (instruction) {

          messages.push({ role: "system", content: instruction });
          selfReviewFixPending = true;
          await record({
            kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps,
            reason: "self_review_fix",
          });
          return { action: "continue" };
        }

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

    const afterSelfReviewFix = async (): Promise<{ action: "complete" } | { action: "stop"; reason: CodingAgentStopReason; message: string }> => this.afterSelfReviewFixOnce({
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      steps,
      turnId,
      stateRunId,
      verificationTools,
      capabilityScopeFields,
      selfReviewState,
      verificationLoop,
      verifiedSignature,
      currentChangeSignature,
      getSelfReviewVerdict: () => selfReviewVerdict,
      setSelfReviewVerdict: (verdict) => { selfReviewVerdict = verdict; },
      setSelfReviewFixPending: (pending) => { selfReviewFixPending = pending; },
      writeSelfReviewSummary,
      writeVerificationSummary,
      toCheckReports,
      record,
    });

    const admission = await this.admitRun({ ctx, input, session, companyId, projectId, sessionId });
    if (!admission.admitted) {
      return finish(admission.status, admission.reason, admission.message, admission.code);
    }

    await this.ports.runEvents?.append({
      eventKey: `code-run-start:${turnId}`,
      eventType: "started",
      runStatus: "running",
      message: "Coding Agent run started",
    });
    await record({ kind: "run_started", companyId, projectId, sessionId, runId: input.runId, reason: session.mode });

    try {
      await this.ports.lifecycleHooks?.sessionStart({
        ctx, companyId, projectId, sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(stateRunId ? { runId: stateRunId } : {}),
        snapshotId: snapshotId ?? null,
      });
    } catch {

    }

    const useInbox = (!input.subagentScope || input.detachedChildInbox === true) && !!this.ports.inbox && await this.ports.inbox.isEnabled(ctx, companyId);
    if (this.ports.runState) {
      const started = await this.startRunState({
        ctx,
        input,
        session,
        companyId,
        projectId,
        sessionId,
        stateOwner,
        prompt,
        useInbox,
        finish,
      });
      if (!started.ok) return started.result;
      stateRunId = started.runId;

      const heartbeatEveryMs = Math.max(1_000, this.limits.runHeartbeatMs);
      heartbeatTimer = setInterval(() => {
        if (!stateRunId || leaseLost) return;
        void this.ports.runState!.renewLease({ companyId, runId: stateRunId, owner: stateOwner })
          .then((verdict) => { if (!verdict.held) leaseLost = true; })
          .catch(() => undefined);
      }, heartbeatEveryMs);
      heartbeatTimer.unref?.();
    }

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

    const capabilityScopeFields = {
      ...(input.subagentWritePaths ? { subagentWritePaths: input.subagentWritePaths } : {}),
      ...(capabilityScope.tools ? { capabilityScope: capabilityScope.tools } : {}),
      ...(capabilityScope.parentRunId ? { parentRunId: capabilityScope.parentRunId } : {}),
    };

    const delegationDepth = subagentDepthForRun(capabilityScope.parentRunId);

    const runTurnLimit = input.maxTurns === undefined
      ? this.limits.maxStepsPerRun
      : clampCodeSubagentTurnLimit(input.maxTurns, this.limits.maxStepsPerRun);

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

        runtimeDiscovery = null;
        runtimeToolDescriptors = [];
        this.ports.logger?.warn("code_run_runtime_capabilities_failed", {
          companyId,
          code: (error as { code?: string }).code ?? "runtime_capabilities_unavailable",
        });
      }
    }

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

    const modelProviderHint = modelName.includes("/") ? (modelName.split("/")[0] ?? modelName) : modelName;

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

    const resolvedProfileTrace = modelProfileFallbackTrace(profileResolution, { enabledProfileIds: enabledProfileIds ?? null });
    modelProfileFallbackReason = resolvedProfileTrace.fallbackReason;
    this.ports.environment?.setModelProfileTrace(resolvedProfileTrace);
    const schemaByName = this.toolSchemaByName(runtimeToolDescriptors);

    const knownTools: KnownTool[] = tools.map((tool) => ({
      name: tool.name,
      inputSchema: schemaByName.get(tool.name)?.inputSchema ?? {},
    }));
    const definitions = this.chatToolDefinitions(tools, runtimeToolDescriptors);

    let engineSupportsNativeTools = false;
    if (this.ports.engine.supportsNativeTools) {
      try {
        engineSupportsNativeTools = (await this.ports.engine.supportsNativeTools(input.model)) === true;
      } catch {
        engineSupportsNativeTools = false;
      }
    }

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

      toolVersions: Object.fromEntries(
        this.toolDescriptors(session, toolOptions).map((tool) => [tool.name, tool.version]),
      ),
      dataClassification: session.dataClassification,
      retentionClass: session.retentionClass,

      ...(commandPrompt.provenance.length > 0 ? { commandProvenance: commandPrompt.provenance } : {}),
    });

    const toolVersionByName = new Map(
      this.toolDescriptors(session, toolOptions).map((tool) => [tool.name, tool.version] as const),
    );

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

    await this.replayApprovedToolCalls({
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      stateRunId,
      steps,
      runtimeToolByName,
      toolVersionByName,
      messages,
      summary,
      replayRecorder,
      writeState,
      record,
    });

    for (;;) {
      if (leaseLost) {

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

        const verdict = this.ports.quota.checkQuota(input.quotaSessionId ?? sessionId, this.estimatedTokensPerCall, this.estimatedCostPerCallUsd, delegationDepth, { userId: ctx.userId, companyId });
        if (!verdict.allowed) {
          await release("budget_exhausted");
          summary.remaining = verdict.error ?? "Budget exhausted.";
          return stop("stopped", "budget_exhausted", `Stopped: ${verdict.error ?? "the token or cost budget is exhausted"}.`);
        }
      }

      let result: ChatResult;

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

              }
            }
          }
        } catch (error) {

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

        }
      }
      await record({ kind: "turn", companyId, projectId, sessionId, runId: input.runId, turn: steps, bytes: tokens });

      if (result.toolCalls?.length) sawNativeToolCalls = true;

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

        validate: validateArguments,
      });

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

            argumentsHash: replayArgumentsHash(call.function?.arguments),

            arguments: call.function?.arguments ?? "",
          })),
        },
      });

      const callsToRun = executableToolCalls(normalized);
      const assistantText = result.content ?? "";

      const openTurn = async (): Promise<void> => {
        if (!stateRunId || !this.ports.runState) return;

        await writeState(() => this.ports.runState!.appendTurn({
          companyId, runId: stateRunId!, turnIndex: steps, status: "running",
        }));
      };

      if (!callsToRun.length && !normalized.rejected.length) {

        await openTurn();
        if (stateRunId && this.ports.runState) {
          await writeState(() => this.ports.runState!.appendTurn({
            companyId, runId: stateRunId!, turnIndex: steps, status: "finished", outcome: "ok",

            checkpointId: turnCheckpointId(),
          }));
        }

        this.applyTurnSummary(summary, runChanges(), runChangeTotals());

        let useCollectBarrier = false;
        try { useCollectBarrier = !input.subagentScope && !!this.ports.asyncCollect && await this.ports.asyncCollect.enabled(ctx, companyId); }
        catch { return stop("interrupted", "async_collect_unsettled", "The collect barrier flag could not be resolved. Verification has not run."); }
        if (useCollectBarrier && this.ports.asyncCollect) {
          if (!inboxOpened || !stateRunId || !this.ports.completions) {
            return stop("interrupted", "async_collect_unsettled", "The collect barrier requires a durable inbox and completion collector.");
          }

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

        if (verificationDisabled || (changeSet.length === 0 && !input.forceVerification)) {

          selfReviewVerdict = beginSelfReviewState();
          writeSelfReviewSummary();
          await release("completed");
          await this.ports.runEvents?.append({ eventKey: `code-run-completed:${turnId}`, eventType: "completed", runStatus: "completed", message: "Coding Agent run completed" });
          summary.remaining = "The model finished without further tool calls.";
          return stop("completed", "completed", assistantText || "The run finished.");
        }

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

            await release("verification_repair");
            continue;
          }
          if (failing === "approval_required") {

            summary.remaining = VERIFICATION_APPROVAL_REQUIRED;
            summary.turns = steps;
            await release(VERIFICATION_APPROVAL_REQUIRED);
            return stop("stopped", "verification_failed", verificationStopMessage());
          }
          if (failing === "unavailable") {

            summary.remaining = VERIFICATION_UNAVAILABLE;
            summary.turns = steps;
            await release(VERIFICATION_UNAVAILABLE);
            return stop("stopped", "verification_failed", verificationStopMessage());
          }

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

            continue;
          }
        }

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

      const assistantMessage: ChatMessage = { role: "assistant", content: assistantText };
      if (normalized.calls.length) {
        assistantMessage.tool_calls = normalized.calls.map(toChatToolCall);
      }
      messages.push(assistantMessage);

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

          turnId: stepTurnKey(steps),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(stateRunId ? { runId: stateRunId } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),

          ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),

          ...capabilityScopeFields,
        };
        let result: CodeToolInvokeResult | CodeToolInvokeFailure;
        try {

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

      const waveLimit = Math.max(1, Math.min(profile.maxParallelToolCalls, this.limits.parallelReadOnlyCalls));

      let turnHadFailure = false;

      const appendToolResult = async (outcome: { call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure }): Promise<void> => {

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

      if (toolSteps[toolSteps.length - 1] !== steps) toolSteps.push(steps);

      const pending = [...callsToRun];
      while (pending.length) {
        const head = pending.shift();
        if (!head) break;
        if (isReadOnlyRunTool(head.name)) {

          const group: NormalizedToolCall[] = [head];
          while (pending[0] && isReadOnlyRunTool(pending[0].name)) {
            group.push(pending.shift() as NormalizedToolCall);
          }
          for (const wave of planToolCallWaves(group, waveLimit)) {
            const waveOutcomes = await Promise.all(wave.map((call) => execute(call)));
            for (const outcome of waveOutcomes) {
              await appendToolResult(outcome);

              const asked = questionIdFrom(outcome);
              if (asked) return await pauseForUser(asked);
            }
          }
        } else {

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

          const approvalPause = approvalPauseFrom(outcome);
          if (approvalPause) {

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

          if (outcome.call.name === CODE_ASK_USER_TOOL && outcome.result.ok) {
            const asked = questionIdFrom(outcome);
            if (!asked) {
              await release("tool_failure");
              return stop("failed", "tool_failure", "Stopped: code.ask_user reported success without a question id, so the run could not be paused safely.");
            }

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

      if (pendingApprovals.length) {
        return await pauseForUser(
          { questionId: pendingApprovals[0]!.approvalId, toolCallId: pendingApprovals[0]!.toolCallId },
          "approval",
        );
      }

      if (stateRunId && this.ports.runState) {
        await writeState(() => this.ports.runState!.appendTurn({
          companyId,
          runId: stateRunId!,
          turnIndex: steps,
          status: "finished",
          outcome: turnHadFailure ? "failed" : "ok",

          checkpointId: turnCheckpointId(),
        }));
      }
    }
  }

  private applyTurnSummary(
    summary: CodingAgentRunSummary,
    changes: ReadonlyArray<{ path: string }>,
    totals: { files: number; linesAdded: number; linesRemoved: number },
  ): void {
    summary.filesChanged = [...new Set(changes.map((change) => change.path))];
    summary.diffStats = { files: totals.files, linesAdded: totals.linesAdded, linesRemoved: totals.linesRemoved };
  }

  private async replayApprovedToolCalls(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    companyId: string;
    projectId: string;
    sessionId: string;
    stateRunId: string | undefined;
    steps: number;
    runtimeToolByName: { has(name: string): boolean };
    toolVersionByName: { get(name: string): number | undefined };
    messages: ChatMessage[];
    summary: CodingAgentRunSummary;
    replayRecorder: CodeRunReplayRecorderPort | undefined;
    writeState: (operation: () => Promise<unknown>) => Promise<void>;
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<void> {
    const {
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      stateRunId,
      steps,
      runtimeToolByName,
      toolVersionByName,
      messages,
      summary,
      replayRecorder,
      writeState,
      record,
    } = args;
    if (!input.approvedToolCalls?.length) return;
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

      replayRecorder?.recordToolCall({
        turnIndex: steps,
        toolCallId: approved.toolCallId,
        tool: approved.tool,
        toolVersion: toolVersionByName.get(approved.tool) ?? null,

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

  private async admitRun(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
  }): Promise<
    | { admitted: true }
    | { admitted: false; status: CodingAgentRunStatus; reason: CodingAgentStopReason; message: string; code?: string }
  > {
    const { ctx, input, session, companyId, projectId, sessionId } = args;
    try {
      await this.ports.flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId, userId: ctx.userId });

      await this.ports.rbac.authorize(ctx, companyId, {
        action: CODE_RUN_START_ACTION,
        permission: CODE_RUN_START_PERMISSION,
        projectId,
        sessionId,
        mode: session.mode,
      });

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
          return {
            admitted: false,
            status: "failed",
            reason: "refused",
            message: `The deployment is refusing new runs (${code}); the run was not started.`,
            code,
          };
        }
      }

      if (input.imageReference) {
        if (!this.ports.imageAdmission) {
          return {
            admitted: false,
            status: "failed",
            reason: "refused",
            message: "Sandbox image admission policy is not configured; the run was not started.",
          };
        }
        const admitted = await this.ports.imageAdmission.admit(ctx, { companyId, reference: input.imageReference });

        this.ports.environment?.setSandboxImage({
          digest: admitted.digest ?? null,
          ...(admitted.sbomRef !== undefined ? { sbomRef: admitted.sbomRef } : {}),
        });
      }

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
      return { admitted: true };
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return {
        admitted: false,
        status: "failed",
        reason: "refused",
        message: failure.message ?? `The run was refused (${failure.code ?? "refused"}).`,
      };
    }
  }

  private async verifyOnce(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    companyId: string;
    projectId: string;
    sessionId: string;
    stateRunId: string | undefined;
    steps: number;
    turnId: string;
    verificationTools: readonly string[];
    capabilityScopeFields: {
      subagentWritePaths?: CodingAgentRunInput["subagentWritePaths"];
      capabilityScope?: readonly string[];
      parentRunId?: string;
    };
    verificationLoop: VerificationLoop;
    toCheckReports: (outcome: CodeToolInvokeResult | CodeToolInvokeFailure) => VerificationCheckReport[];
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<void> {
    const {
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      stateRunId,
      steps,
      turnId,
      verificationTools,
      capabilityScopeFields,
      verificationLoop,
      toCheckReports,
      record,
    } = args;
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
  }

  private async evaluateChangeSet(args: {
    input: CodingAgentRunInput;
    companyId: string;
    projectId: string;
    sessionId: string;
    steps: number;
    prompt: string;
    summary: CodingAgentRunSummary;
    runChanges: () => Array<{ path: string; tool: string; status?: string; diff?: string }>;
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<{ testIntegrity: TestIntegrityVerdict | null; scopeGuard: ScopeGuardResult | null } | null> {
    const { input, companyId, projectId, sessionId, steps, prompt, summary, runChanges, record } = args;
    const changes = runChanges();
    if (!changes.length) return null;
    const testIntegrity = analyzeTestIntegrity(changes);
    const scopeGuard = evaluateScopeGuard({
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
    return { testIntegrity, scopeGuard };
  }

  private async pauseForUserOnce(args: {
    ctx: AuthContext;
    session: CodeSession;
    companyId: string;
    steps: number;
    turnId: string;
    stateRunId: string | undefined;
    stateOwner: string;
    inboxOpened: boolean;
    summary: CodingAgentRunSummary;
    question: { questionId: string; toolCallId: string };
    waitingFor: "question" | "approval";
    writeState: (operation: () => Promise<unknown>) => Promise<void>;
    stopHeartbeat: () => void;
    turnCheckpointId: () => string | null;
    release: (reason: string) => Promise<void>;
    finish: (
      status: CodingAgentRunStatus,
      reason: CodingAgentStopReason,
      message: string,
      code?: string,
    ) => CodingAgentRunResult;
  }): Promise<{ result: CodingAgentRunResult; inboxOpened: boolean }> {
    const {
      ctx,
      session,
      companyId,
      steps,
      turnId,
      stateRunId,
      stateOwner,
      summary,
      question,
      waitingFor,
      writeState,
      stopHeartbeat,
      turnCheckpointId,
      release,
      finish,
    } = args;
    let inboxOpened = args.inboxOpened;
    if (stateRunId && this.ports.runState) {
      if (this.ports.runState.markWaitingForUser) {
        await writeState(() => this.ports.runState!.markWaitingForUser!({
          companyId, runId: stateRunId!, questionId: question.questionId, toolCallId: question.toolCallId,
        }));
      } else {

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
    return {
      result: finish(
        "waiting_for_user",
        "waiting_for_user",
        waitingFor === "approval"
          ? `Waiting for an approval decision on tool call ${question.toolCallId}.`
          : `Waiting for the user to answer question ${question.questionId}.`,
      ),
      inboxOpened,
    };
  }

  private async startRunState(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
    stateOwner: string;
    prompt: string;
    useInbox: boolean;
    finish: (
      status: CodingAgentRunStatus,
      reason: CodingAgentStopReason,
      message: string,
      code?: string,
    ) => CodingAgentRunResult;
  }): Promise<{ ok: true; runId: string } | { ok: false; result: CodingAgentRunResult }> {
    const { ctx, input, session, companyId, projectId, sessionId, stateOwner, prompt, useInbox, finish } = args;
    try {
      const startedState = await this.ports.runState!.startRun({
        ctx,
        companyId,
        projectId,
        sessionId,
        owner: stateOwner,
        ...(input.runDetails ? { details: input.runDetails } : {}),
        ...(input.runId ? { runId: input.runId } : {}),

        request: prompt,
        dataClassification: session.dataClassification,
        retentionClass: session.retentionClass,
      });
      if (useInbox && !(await this.ports.runState!.renewLease({ companyId, runId: startedState.runId, owner: stateOwner })).held) {
        return {
          ok: false,
          result: finish("interrupted", "interrupted", "Another worker already owns this run. No model or tool was dispatched."),
        };
      }
      const stateRunId = startedState.runId;

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
      return { ok: true, runId: stateRunId };
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return {
        ok: false,
        result: finish(
          "failed",
          "refused",
          failure.message ?? `The run state could not be recorded (${failure.code ?? "state_unavailable"}).`,
        ),
      };
    }
  }

  private buildRunResult(args: {
    input: CodingAgentRunInput;
    summary: CodingAgentRunSummary;
    pendingApprovals: CodingAgentPendingApproval[];
    stopHeartbeat: () => void;
    status: CodingAgentRunStatus;
    reason: CodingAgentStopReason;
    message: string;
    code: string | undefined;
    unsettledChildren: boolean;
    snapshotId: string;
    startedAt: number;
    stateRunId: string | undefined;
    model: string | undefined;
    provider: string | undefined;
    lastBudget: ModelRequestPressure | null;
    compactionCount: number;
  }): CodingAgentRunResult {
    const {
      input,
      summary,
      pendingApprovals,
      stopHeartbeat,
      status,
      reason,
      message,
      code,
      unsettledChildren,
      snapshotId,
      startedAt,
      stateRunId,
      model,
      provider,
      lastBudget,
      compactionCount,
    } = args;
    stopHeartbeat();

    this.ports.environment?.setRunSummary(null);
    const finishedAt = this.now();

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

      ...(summary.verification ? { verification: summary.verification } : {}),
      ...(summary.scope ? { scope: summary.scope } : {}),

      ...(summary.selfReview ? { selfReview: summary.selfReview } : {}),

      ...(pendingApprovals.length ? { pendingApprovals: pendingApprovals.map((entry) => ({ ...entry })) } : {}),
    };
  }

  private async stopRun(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
    status: Exclude<CodingAgentRunStatus, "waiting_for_user">;
    reason: CodingAgentStopReason;
    message: string;
    inboxOpened: boolean;
    stateRunId: string | undefined;
    stateOwner: string;
    summary: CodingAgentRunSummary;
    snapshotId: string;
    replayRecorder: CodeRunReplayRecorderPort | undefined;
    completionArtifacts: Record<string, unknown>[];
    compressionArtifacts: Record<string, unknown>[];
    commandProvenance: readonly Record<string, unknown>[];
    selfReviewVerdict: SelfReviewVerdict | null;
    unsettledChildren: boolean;
    writeState: (operation: () => Promise<unknown>) => Promise<void>;
    finish: (
      status: CodingAgentRunStatus,
      reason: CodingAgentStopReason,
      message: string,
      code?: string,
    ) => CodingAgentRunResult;
  }): Promise<{ result: CodingAgentRunResult; inboxOpened: boolean }> {
    const {
      ctx,
      input,
      session,
      companyId,
      projectId,
      sessionId,
      message,
      stateRunId,
      stateOwner,
      summary,
      snapshotId,
      replayRecorder,
      completionArtifacts,
      compressionArtifacts,
      commandProvenance,
      selfReviewVerdict,
      unsettledChildren,
      writeState,
      finish,
    } = args;
    let status = args.status;
    let reason = args.reason;
    let inboxOpened = args.inboxOpened;
    if (unsettledChildren) { status = "interrupted"; reason = "active_subagent_unsettled"; }
    if (inboxOpened && stateRunId) {
      try {
        if (this.ports.runState && !(await this.ports.runState.renewLease({ companyId, runId: stateRunId, owner: stateOwner })).held) {
          return { result: finish("interrupted", "interrupted", "The run lease changed before settlement. The replacement's state was not modified."), inboxOpened };
        }
        await this.ports.inbox!.transact(session, { kind: "close", runId: stateRunId, owner: stateOwner });
        inboxOpened = false;
      } catch {

        return { result: finish("interrupted", "interrupted", "Durable inbox settlement could not be confirmed. Pending input remains recoverable."), inboxOpened };
      }
    }

    if (replayRecorder) {
      try {
        await replayRecorder.finalize({
          ...(completionArtifacts.length ? { completionArtifacts } : {}),
          terminalStatus: status,
          terminalReason: reason,
          compressionArtifacts,

          commandExpansions: commandProvenance,
        });
      } catch (error) {
        this.ports.logger?.warn("replay_bundle_refused", {
          code: (error as { code?: string })?.code ?? "replay_bundle_error",
          runId: stateRunId ?? input.runId,
        });
      }
    }
    if (stateRunId && this.ports.runState) {

      const stateStatus = status === "cancelled"
        ? "cancelled"
        : status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed";
      if (status === "interrupted" && (input.detachedChildInbox || unsettledChildren || reason === "async_collect_unsettled")) {
        await writeState(() => this.ports.runState!.markInterrupted?.({ companyId, runId: stateRunId!, reason })
          ?? this.ports.runState!.markFinished({ companyId, runId: stateRunId!, status: "interrupted", reason }));
        await writeState(() => this.ports.runState!.releaseLease?.({ companyId, runId: stateRunId!, owner: stateOwner }) ?? Promise.resolve());
      } else await writeState(() => this.ports.runState!.markFinished({
        companyId, runId: stateRunId!, status: stateStatus, reason,

        estimate: {
          tokenCount: summary.tokens,
          costUsd: Number.isFinite(summary.costUsd) ? summary.costUsd : null,
          turns: summary.turns,
          toolCalls: summary.toolCalls,
          filesChanged: summary.filesChanged.length,
          diffStats: summary.diffStats,

          ...(summary.verification ? { verification: summary.verification } : {}),
          ...(summary.scope ? { scope: summary.scope } : {}),

          ...(selfReviewVerdict ? { selfReview: toPersistedSelfReview(selfReviewVerdict) } : {}),
        },
      }));
    }

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

    }
    return { result: finish(status, reason, message), inboxOpened };
  }

  private async runSelfReviewOnce(args: {
    input: CodingAgentRunInput;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
    steps: number;
    prompt: string;
    selfReviewState: SelfReviewState | null;
    loadApprovedPlan: () => Promise<string | null>;
    runChanges: () => Array<{ path: string; tool: string; status?: string; diff?: string }>;
    verificationForReview: () => string;
    testIntegrityForReview: () => string;
    boundedDiff: (limit: number) => string;
    writeSelfReviewSummary: () => void;
    setSelfReviewVerdict: (verdict: SelfReviewVerdict) => void;
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<SelfReviewVerdict | null> {
    const {
      input,
      session,
      companyId,
      projectId,
      sessionId,
      steps,
      prompt,
      selfReviewState,
      loadApprovedPlan,
      runChanges,
      verificationForReview,
      testIntegrityForReview,
      boundedDiff,
      writeSelfReviewSummary,
      setSelfReviewVerdict,
      record,
    } = args;
    const state = selfReviewState;
    if (!state) return null;
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
    setSelfReviewVerdict(verdict);
    writeSelfReviewSummary();
    await record({
      kind: "turn",
      companyId, projectId, sessionId,
      runId: input.runId,
      turn: steps,

      ok: verdict.status === "clean" || verdict.status === "repaired",
      reason: `${describeSelfReview(verdict)} profile=${this.ports.selfReview?.profileId ?? "run-default"}`,
    });
    return verdict;
  }

  private async afterSelfReviewFixOnce(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    companyId: string;
    projectId: string;
    sessionId: string;
    steps: number;
    turnId: string;
    stateRunId: string | undefined;
    verificationTools: readonly string[];
    capabilityScopeFields: {
      subagentWritePaths?: CodingAgentRunInput["subagentWritePaths"];
      capabilityScope?: readonly string[];
      parentRunId?: string;
    };
    selfReviewState: SelfReviewState | null;
    verificationLoop: VerificationLoop;
    verifiedSignature: string | null;
    currentChangeSignature: () => string;
    getSelfReviewVerdict: () => SelfReviewVerdict | null;
    setSelfReviewVerdict: (verdict: SelfReviewVerdict | null) => void;
    setSelfReviewFixPending: (pending: boolean) => void;
    writeSelfReviewSummary: () => void;
    writeVerificationSummary: () => void;
    toCheckReports: (outcome: CodeToolInvokeResult | CodeToolInvokeFailure) => VerificationCheckReport[];
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<{ action: "complete" } | { action: "stop"; reason: CodingAgentStopReason; message: string }> {
    const {
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      steps,
      turnId,
      stateRunId,
      verificationTools,
      capabilityScopeFields,
      selfReviewState,
      verificationLoop,
      verifiedSignature,
      currentChangeSignature,
      getSelfReviewVerdict,
      setSelfReviewVerdict,
      setSelfReviewFixPending,
      writeSelfReviewSummary,
      writeVerificationSummary,
      toCheckReports,
      record,
    } = args;
    const changed = currentChangeSignature() !== verifiedSignature;
    setSelfReviewFixPending(false);
    if (!changed) {

      selfReviewState?.noteFixOutcome(false);
      setSelfReviewVerdict(selfReviewState?.report() ?? getSelfReviewVerdict());
      writeSelfReviewSummary();
      const outstanding = (getSelfReviewVerdict()?.unresolved ?? []).filter((finding) => finding.blocking);
      if (outstanding.length) {
        return { action: "stop", reason: "self_review_unresolved", message: selfReviewStopMessage(getSelfReviewVerdict() ?? undefined) };
      }
      return { action: "complete" };
    }

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

      selfReviewState?.noteFixOutcome(false);
      setSelfReviewVerdict(selfReviewState?.report() ?? getSelfReviewVerdict());
      writeSelfReviewSummary();
      return {
        action: "stop",
        reason: "verification_failed",
        message: `Stopped: the checks still fail after the self-review fix (${failed.map((check) => check.tool).join(", ")}).`,
      };
    }

    selfReviewState?.noteFixOutcome(true);
    setSelfReviewVerdict(selfReviewState?.report() ?? getSelfReviewVerdict());
    writeSelfReviewSummary();
    return { action: "complete" };
  }
}
