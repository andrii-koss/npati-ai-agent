import type { AuthContext, CodeSession, DataClassification, RetentionClass } from "@npati/workspace";
import type { ChatRequest, ChatResult } from "@npati/omniroute-adapter";
import type { ExecutionSnapshotProvider } from "./execution-snapshot";
import type { CompactionSummary } from "./code-conversation-compaction";
import type { CodeModelProfile, CodeModelProfileFallbackReason, CodeModelProfileFallbackTrace } from "./code-model-profiles";
import type { CodeToolInvokeFailure, CodeToolInvokeResult } from "./code-tool-runtime";
import type { CodeAgentLimits } from "./code-agent-config";
import type { SelfReviewPersisted } from "./code-self-review";
import type { CodingAgentRunSummary } from "./coding-agent-runner-contracts";

export interface CodingAgentPolicyContext {
  companyId: string;
  projectId: string;
  sessionId?: string;
  dataClassification: DataClassification;
}

export interface CodingAgentChatRequest extends ChatRequest {
  policyContext: CodingAgentPolicyContext;
}

export interface CodeRunToolDescriptor {
  name: string;
  version: number;
  status: string;
  description: string;
  write: boolean;
}

export interface CodeRunRuntimeToolDescriptor {

  name: string;
  version: number;
  status: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write: true;

  risk: string;

  approvalRequired: boolean;
}

export interface CodeRunRuntimeCapabilityContext {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
}

export interface CodeRunRuntimeDiscovery {

  discovered: boolean;

  code?: string;
  tools: readonly CodeRunRuntimeToolDescriptor[];
  toolCount: number;
  connectionCount: number;
  manifestHash: string | null;
  manifestRevision: string | null;
}

export interface CodeRunRuntimeCapabilitiesPort {

  prepareForRun(input: CodeRunRuntimeCapabilityContext): Promise<CodeRunRuntimeDiscovery>;

  invoke(
    input: CodeRunRuntimeCapabilityContext & {
      tool: string;
      args: Record<string, unknown>;
      toolCallId: string;
      leaseOwner?: string;
      agentId?: string;
      signal?: AbortSignal;

      readOnlyIntent?: boolean;

      approvalId?: string;
    },
  ): Promise<CodeToolInvokeResult | CodeToolInvokeFailure>;
}

export interface CodeRunToolSchemaLike {
  name: string;
  version: number;
  status: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CodeRunToolRuntimePort {
  listTools(): CodeRunToolDescriptor[];
  invoke(
    ctx: AuthContext,
    input: {
      companyId: string;
      projectId: string;
      sessionId?: string;
      tool: string;
      args?: unknown;
      toolCallId: string;
      leaseOwner?: string;
      turnId?: string;
      runId?: string;
      agentId?: string;
    },
  ): Promise<CodeToolInvokeResult | CodeToolInvokeFailure>;

  verificationRevision?(ctx: AuthContext, companyId: string, projectId: string, sessionId: string): Promise<string | null>;
  turnSummary?(sessionId: string, turnId: string): {
    files: number;
    linesAdded: number;
    linesRemoved: number;

    checkpointId?: string | null;

    changes: Array<{
      path: string;
      tool: string;
      status?: string;
      diff?: string;
      sha256?: string | null;
      linesAdded?: number;
      linesRemoved?: number;
    }>;
  };
}

export interface CodeRunEnginePort {
  chat(request: CodingAgentChatRequest): Promise<ChatResult>;
  recordedCompletionInputs?(turnIndex: number): string[];

  supportsNativeTools?(model?: string): boolean | Promise<boolean>;
}

export interface CodeRunQuotaPort {
  checkQuota(
    sessionId: string,
    requestedTokens: number,
    estimatedCostUsd: number,

    currentDepth?: number,

    scope?: { userId?: string; companyId?: string },
  ): { allowed: boolean; error?: string; remainingTokens?: number; remainingCostUsd?: number };
  recordUsage(sessionId: string, tokens: number, costUsd: number, scope?: { userId?: string; companyId?: string }): void;
}

export interface CodeRunStatePort {
  startRun(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId: string;
    owner: string;
    runId?: string;

    request?: string | null;
    dataClassification?: DataClassification;
    retentionClass?: RetentionClass;
  }): Promise<{ runId: string }>;
  renewLease(input: { companyId: string; runId: string; owner: string }): Promise<{ held: boolean }>;
  releaseLease?(input: { companyId: string; runId: string; owner: string }): Promise<unknown>;
  markInterrupted?(input: { companyId: string; runId: string; reason: string }): Promise<unknown>;

  appendTurn(input: {
    companyId: string;
    runId: string;
    turnIndex: number;
    status: "running" | "finished" | "failed";
    outcome?: "ok" | "failed" | "unknown_outcome" | null;
    checkpointId?: string | null;
  }): Promise<unknown>;

  appendToolCall(input: {
    companyId: string;
    runId: string;
    turnIndex: number;
    toolCallId: string;
    tool: string;
    readOnly: boolean;
    outcome: "ok" | "failed" | "unknown_outcome";
    errorCode?: string;
    startedAt?: Date;
    finishedAt?: Date | null;
  }): Promise<unknown>;
  markFinished(input: {
    companyId: string;
    runId: string;
    status: "completed" | "failed" | "cancelled" | "interrupted";
    reason?: string;

    estimate?: {
      tokenCount: number;
      costUsd: number | null;
      turns: number;
      toolCalls: number;
      filesChanged: number;
      diffStats: { files: number; linesAdded: number; linesRemoved: number };

      verification?: CodingAgentRunSummary["verification"];
      scope?: CodingAgentRunSummary["scope"];

      selfReview?: SelfReviewPersisted;
    };
  }): Promise<unknown>;

  markWaitingForUser?(input: {
    companyId: string;
    runId: string;
    questionId: string;
    toolCallId: string;
  }): Promise<unknown>;
}

export interface CodeRunActivityEvent {
  kind: "run_started" | "turn" | "tool_call" | "reminder" | "run_finished" | "session_branch" | "model_call";
  phase?: "started" | "completed" | "failed";
  model?: string;
  provider?: string;
  httpStatus?: number;
  attempt?: number;
  retryScheduled?: boolean;
  modelPurpose?: "self_review";
  companyId: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  turn?: number;
  tool?: string;
  toolCallId?: string;
  ok?: boolean;
  errorCode?: string;
  bytes?: number;
  durationMs?: number;
  reason?: string;
  snapshotId?: string;

  branch?: string;
  branchCreated?: boolean;
  branchSwitched?: boolean;

  modelProfileFallbackReason?: CodeModelProfileFallbackReason;
}

export interface CodeRunSkillProvenance {
  skillId: string;
  version: number;
  hash: string;
  source: string;
  order: number;
}

export interface CodeRunEnvironmentHolder {
  setSandboxImage(image: { digest: string | null; sbomRef?: string | null } | null): void;
  setPolicyComposition(composition: Record<string, unknown> | null): void;
  sandboxImage(): { digest: string | null; sbomRef?: string | null } | null;
  policyComposition(): Record<string, unknown> | null;

  setFeatureFlags(value: Record<string, unknown> | null): void;
  featureFlags(): Record<string, unknown> | null;

  setProviderDataPolicy(value: { version: number | null; classification: string | null } | null): void;
  providerDataPolicy(): { version: number | null; classification: string | null } | null;
  setBaseCommit(value: { branch: string | null; commit: string | null; dirty: boolean } | null): void;
  baseCommit(): { branch: string | null; commit: string | null; dirty: boolean } | null;
  setToolchain(value: Record<string, unknown> | null): void;
  toolchain(): Record<string, unknown> | null;

  setModelSelection(value: { provider: string; model: string } | null): void;
  modelSelection(): { provider: string; model: string } | null;

  setSystemPrompt(value: { version: number | null; contentHash: string | null } | null): void;
  systemPrompt(): { version: number | null; contentHash: string | null } | null;

  setModelProfileVersion(value: string | number | null): void;
  modelProfileVersion(): string | number | null;

  setModelProfileTrace(value: CodeModelProfileFallbackTrace | null): void;
  modelProfileTrace(): CodeModelProfileFallbackTrace | null;

  setProjectInstructions(value: { contentHash: string | null; trustStatus: "trusted" | "untrusted" } | null): void;
  projectInstructions(): { contentHash: string | null; trustStatus: "trusted" | "untrusted" } | null;

  setSkillInstructions(value: readonly CodeRunSkillProvenance[] | null): void;
  skillInstructions(): readonly CodeRunSkillProvenance[] | null;

  setRunSummary(value: CodingAgentRunSummary | null): void;
  runSummary(): CodingAgentRunSummary | null;
}

export function createCodeRunEnvironmentHolder(): CodeRunEnvironmentHolder {
  let image: { digest: string | null; sbomRef?: string | null } | null = null;
  let composition: Record<string, unknown> | null = null;
  let flags: Record<string, unknown> | null = null;
  let policy: { version: number | null; classification: string | null } | null = null;
  let commit: { branch: string | null; commit: string | null; dirty: boolean } | null = null;
  let toolchain: Record<string, unknown> | null = null;
  let modelSelection: { provider: string; model: string } | null = null;
  let systemPrompt: { version: number | null; contentHash: string | null } | null = null;
  let modelProfileVersion: string | number | null = null;
  let profileTrace: CodeModelProfileFallbackTrace | null = null;
  let projectInstructions: { contentHash: string | null; trustStatus: "trusted" | "untrusted" } | null = null;
  let skillInstructions: readonly CodeRunSkillProvenance[] | null = null;
  let runSummary: CodingAgentRunSummary | null = null;
  return {
    setSandboxImage(next) { image = next; },
    setPolicyComposition(next) { composition = next; },
    sandboxImage() { return image; },
    policyComposition() { return composition; },
    setFeatureFlags(next) { flags = next; },
    featureFlags() { return flags; },
    setProviderDataPolicy(next) { policy = next; },
    providerDataPolicy() { return policy; },
    setBaseCommit(next) { commit = next; },
    baseCommit() { return commit; },
    setToolchain(next) { toolchain = next; },
    toolchain() { return toolchain; },
    setModelSelection(next) { modelSelection = next; },
    modelSelection() { return modelSelection; },
    setSystemPrompt(next) { systemPrompt = next; },
    systemPrompt() { return systemPrompt; },
    setModelProfileVersion(next) { modelProfileVersion = next; },
    modelProfileVersion() { return modelProfileVersion; },
    setModelProfileTrace(next) { profileTrace = next; },
    modelProfileTrace() { return profileTrace; },
    setProjectInstructions(next) { projectInstructions = next; },
    projectInstructions() { return projectInstructions; },
    setSkillInstructions(next) { skillInstructions = next; },
    skillInstructions() { return skillInstructions; },
    setRunSummary(next) { runSummary = next; },
    runSummary() { return runSummary; },
  };
}

export interface CodeRunPolicyCompositionSources {
  projectPolicyVersion?(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<number | null>;
  approvalRulesRevision?(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId?: string }): Promise<number | null>;
  companyMembershipRevision?(input: { ctx: AuthContext; companyId: string }): Promise<number | null>;

  featureFlags?(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; model?: string }): Promise<Record<string, unknown> | null>;

  providerDataPolicy?(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; model?: string }): Promise<{ version: number | null; classification: string | null } | null>;

  baseCommit?(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<{ branch: string | null; commit: string | null; dirty: boolean } | null>;

  toolchain?(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<Record<string, unknown> | null>;
}

export interface CodeRunSnapshotConfigVersions {
  ensureSystemPromptVersion(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    workspaceId: string;
    sessionId?: string;
    promptText: string;
    profileId: string;
  }): Promise<{ version: number | null; contentHash: string | null } | null>;
  ensureModelProfilesVersion(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    workspaceId: string;
    sessionId?: string;
    profile: CodeModelProfile;
  }): Promise<string | number | null>;
}

export interface CodeRunReplayStartInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  workspaceId: string;
  runId: string;
  snapshotId?: string;
  modelSelection?: { provider: string; model: string } | null;
  systemPrompt?: { version: number | null; contentHash: string | null } | null;
  modelProfileVersion?: string | number | null;

  toolVersions?: Record<string, number>;

  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;

  commandProvenance?: readonly Record<string, unknown>[];
}

export interface CodeRunReplayRecorderPort {
  recordModelStep(step: {
    turnIndex: number;
    request: {

      model: string | null;
      messageCount: number;
      toolNames: string[];
      idempotencyKey?: string;
      dataClassification?: string;
    };
    response: {
      content: string;
      finishReason?: string | null;
      model?: string | null;
      provider?: string | null;
      usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number } | null;
      toolCalls: Array<{
        id: string;
        name: string;
        argumentsHash: string;

        arguments?: string;
      }>;
    };
  }): void;
  recordToolCall(step: {
    turnIndex: number;
    toolCallId: string;
    tool: string;
    toolVersion?: string | number | null;
    argumentsHash: string;
    settledResult: string;
    outcome: "ok" | "failed";
    errorCode?: string;
    truncated?: boolean;
    durationMs?: number;
  }): void;
  finalize(input: {
    terminalStatus: string;
    terminalReason: string;

    compressionArtifacts?: readonly Record<string, unknown>[];
    completionArtifacts?: readonly Record<string, unknown>[];

    commandExpansions?: readonly Record<string, unknown>[];
  }): Promise<{ written: boolean; bundleId?: string; errorCode?: string }>;
}

export interface CodeRunReplayPort {
  start(input: CodeRunReplayStartInput): CodeRunReplayRecorderPort;
}

export interface CodingAgentRunnerPorts {

  inbox?: import("./code-session-inbox").CodeSessionInboxService;
  completions?: import("./code-process-completions").CodeProcessCompletionService;

  asyncCollect?: {
    enabled(ctx: AuthContext, companyId: string): Promise<boolean>;
    timeoutMs?: number;
    changes(ctx: AuthContext, session: CodeSession, operations: readonly import("@npati/workspace").DurableCodeProcess[]): Promise<Array<{ path: string; tool: string; status?: string; diff?: string }>>;
  };
  flags: {
    assertEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<unknown>;
    executionModes?: { assertToolAllowed(ctx: AuthContext, companyId: string, projectId: string | undefined, tool: string): Promise<void> };
  };

  rbac: {
    authorize(ctx: AuthContext, companyId: string, input: { action: string; permission: string; projectId?: string; sessionId?: string; mode?: string }): Promise<unknown>;
  };
  toolRuntime: CodeRunToolRuntimePort;

  runtimeCapabilities?: CodeRunRuntimeCapabilitiesPort;
  engine: CodeRunEnginePort;

  schemas?: readonly CodeRunToolSchemaLike[];
  imageAdmission?: {

    admit(
      ctx: AuthContext,
      input: { companyId: string; reference: string },
    ): Promise<{ reference: string; dev: boolean; digest?: string | null; sbomRef?: string | null }>;
  };
  quota?: CodeRunQuotaPort;

  runState?: CodeRunStatePort;

  sessionRunLink?: (input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
  }) => Promise<{ linked: boolean; reason?: string }>;

  runStateOwner?: string;
  snapshot?: ExecutionSnapshotProvider | null;

  environment?: CodeRunEnvironmentHolder;

  policyCompositionSources?: CodeRunPolicyCompositionSources;

  snapshotConfigVersions?: CodeRunSnapshotConfigVersions;

  ensureSessionBranch?: (input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId: string;
  }) => Promise<{ branch: string; created: boolean; switched: boolean; previousBranch: string | null }>;

  projectInstructions?: {
    load(input: {
      ctx: AuthContext;
      companyId: string;
      projectId: string;
      targetPaths?: readonly string[];
    }): Promise<{ body: string; contentHash: string | null; trusted: boolean } | null>;
  };
  activity?: { record(event: CodeRunActivityEvent): Promise<void> };

  skillInstructions?: {
    render(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string }): Promise<string | null>;
    provenance(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string }): Promise<readonly CodeRunSkillProvenance[]>;
  };

  commandExpansion?: {
    resolvePrompt(input: {
      ctx: AuthContext;
      companyId: string;
      projectId: string;
      sessionId: string;
      prompt: string;
    }): Promise<{

      text: string;
      provenance: readonly Record<string, unknown>[];

      refusals?: readonly string[];
    } | null>;
  };

  lifecycleHooks?: {
    sessionStart(input: {
      ctx: AuthContext; companyId: string; projectId: string; sessionId: string;
      runId?: string; snapshotId?: string | null;
    }): Promise<unknown>;
    stop(input: {
      ctx: AuthContext; companyId: string; projectId: string; sessionId: string;
      runId?: string; snapshotId?: string | null; status: string; reason: string;
    }): Promise<unknown>;
  };

  contextBlocks?: {
    load(input: {
      ctx: AuthContext;
      companyId: string;
      projectId: string;
      query?: string;
    }): Promise<{ companyMemory: string | null; projectContext: string | null } | null>;
  };

  contextSummaryStore?: {
    persist(input: {
      companyId: string;
      projectId: string;
      sessionId: string;
      runId: string;
      snapshotId: string | null;
      turnIndex: number;
      schemaVersion: number;
      summary: CompactionSummary;
      summaryText: string;
      contentHash: string;
      dataClassification: DataClassification;
      retentionClass: RetentionClass;
    }): Promise<unknown>;
  };

  providerDataGuard?: {
    guardProviderBoundText(
      text: string,
      input: {
        model?: string;
        policyContext: {
          companyId: string;
          projectId?: string;
          sessionId?: string;
          dataClassification?: DataClassification;
        };
        field?: "content" | "text" | "output";
      },
    ): Promise<{ text: string; changed: boolean; bytes: number }>;
  };

  sessionPlan?: {
    load(input: {
      ctx: AuthContext;
      companyId: string;
      projectId: string;
      sessionId: string;
    }): Promise<{
      revision: number;
      status: string;
      executionMode?: string | null;
      plan: { files: readonly string[]; steps: readonly string[]; risks: readonly string[]; testStrategy: string };
    } | null>;
  };

  secretLeaseValues?: (input: {
    sessionId: string;
    companyId: string;
    projectId: string;
  }) => Promise<readonly string[] | null | undefined> | readonly string[] | null | undefined;

  runEvents?: {
    append(entry: { eventKey: string; eventType: string; runStatus: string; message: string }): Promise<unknown>;
  };

  sandbox?: {
    release(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; reason: string }): Promise<void>;
  };

  activeChildren?: {
    settle?(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string; runId: string; cancel: boolean }): Promise<boolean>;

    isUnsettled(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string; runId: string }): Promise<boolean>;
  };

  admissionGate?: {
    isRefusingNewRuns(): boolean;

    refusalCode?(): string | undefined;
  };

  replayBundle?: CodeRunReplayPort;

  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  limits?: Partial<CodeAgentLimits>;

  asyncProcessesEnabled?: (ctx: AuthContext, companyId: string, projectId: string) => Promise<boolean>;
  asyncSubagentsEnabled?: (ctx: AuthContext, companyId: string) => Promise<boolean>;
  asyncAgentControlsEnabled?: (ctx: AuthContext, companyId: string) => Promise<boolean>;
  modelProfiles?: {
    profiles?: readonly CodeModelProfile[];
    overrides?: readonly CodeModelProfile[];
    enabledProfileIds?: readonly string[];

    enabledProfileIdsForRun?: (input: {
      ctx: AuthContext;
      companyId: string;
      projectId: string;
      sessionId?: string;
    }) => Promise<readonly string[] | null>;
  };

  selfReview?: {
    profileId?: string;

    maxFixIterations?: number;

    enabled?: boolean;
  };

  selfReviewDiffChars?: number;
  now?: () => number;

  estimatedTokensPerCall?: number;
  estimatedCostPerCallUsd?: number;
}
