import { smallWorkspaceContext } from "./code-small-workspace-context";
import { withTransientModelRetry } from "./coding-agent-provider-retry";
import { createCodeRunVisionPort } from "./coding-agent-image-delivery";
import { resolveConfirmedVisionModel } from "./chat-inference-candidates";
import { buildWebsiteStyleContext, websiteEditMemory } from "./website-style-context";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { globalQuotaManager } from "./a2a-control-plane-routes";
import { createAuditServices } from "./audit-services";
import { buildInfo } from "./build-info";
import { readCodeActiveContext, writeCodeActiveContext } from "./code-active-context-store";
import { DEFAULT_CODE_AGENT_LIMITS, resolveCodeAgentLimits } from "./code-agent-config";
import { registerCodeAgentControlRoutes } from "./code-agent-controls";
import { CodeApprovalScopeService } from "./code-approval-scope";
import type { CodePreferencesStore } from "./code-preferences";
import type { OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { collectAsyncOperationChanges } from "./code-async-collect-changes";
import { CodeAsyncWorkspaceService, registerCodeAsyncWorkspaceRoutes } from "./code-async-workspace";
import { CodeBackgroundRunRegistry } from "./code-background-run-registry";
import { registerCodeBackgroundRunRoutes } from "./code-background-run-routes";
import { finishCodeChatWebsite, hasCodeChatPreview, isCodeChatWebsite } from "./code-chat-website";
import { registerCodeCliRunRoutes } from "./code-cli-run-routes";
import { createCodeCommandRegistry } from "./code-command-registry";
import { buildCompanyMemoryBlock, buildProjectContextBlock } from "./code-context-memory";
import { CodeDataErasureService } from "./code-data-erasure";
import { createCodeHooksService } from "./code-hooks";
import { createCodeInstructionsLoader } from "./code-instructions-loader";
import { registerCodeIntentRoutes } from "./code-intent-routing";
import { CodeMembershipService } from "./code-membership";
import { collectCodeMetrics } from "./code-metrics";
import { registerCodeMetricsRoutes } from "./code-metrics-routes";
import { DEFAULT_CODE_MODEL_PROFILES, resolveEnabledModelProfileIds } from "./code-model-profiles";
import { CodeProcessCompletionService } from "./code-process-completions";
import { CodeProcessManager } from "./code-process-manager";
import { registerCodeProjectLifecycleRoutes } from "./code-project-lifecycle-routes";
import { registerCodeQueueStatusRoutes } from "./code-queue-status-routes";
import { CodeRbac } from "./code-rbac";
import { CodeReaper } from "./code-reaper";
import { ReplayBundleReadPort, ReplayBundleRecorder, getReplayBundleById, readReplayBundle } from "./code-replay-bundle";
import { CodeReplayService, registerCodeReplayRoutes } from "./code-replay-routes";
import { activitySinkForKind, createCodeRunActivitySink } from "./code-run-activity-sink";
import { createCodeRunAdmission } from "./code-run-admission";
import { CodeRunCancellationRegistry } from "./code-run-cancellation";
import { CodeRunQueue, resolveCodeRunQueueLimits } from "./code-run-queue";
import { CodeRunSharedQuota } from "./code-run-quota";
import { CodeRunRateLimiter, resolveCodeRunRateLimits } from "./code-run-rate-limit";
import { CodeRunReconciler } from "./code-run-reconciler";
import { CodeRunStateLog, readRunEstimate } from "./code-run-state";
import { CodeService } from "./code-service";
import { registerCodeSessionControlRoutes } from "./code-session-control-routes";
import { registerCodeSessionDurabilityRoutes } from "./code-session-durability-routes";
import type { ProjectLifecycleService } from "./project-lifecycle-service";
import { registerCodeSessionExportRoutes } from "./code-session-export-routes";
import { CodeSessionForkService } from "./code-session-fork";
import { CodeSessionInboxService } from "./code-session-inbox";
import { registerCodeSessionInboxRoutes } from "./code-session-inbox-routes";
import { CodeSessionResumeService } from "./code-session-resume";
import { CodeSessionRewindService } from "./code-session-rewind";
import { CodeSessionRunExecutor } from "./code-session-run-executor";
import { collectCodeSessionUsage } from "./code-session-usage";
import { createCodeSkillsService } from "./code-skills-instructions";
import { registerCodeSnapshotRoutes } from "./code-snapshot-routes";
import { ensureModelProfilesVersion, ensureSystemPromptVersion } from "./code-snapshot-versioning";
import { CodePrivilegedAuditPort } from "./code-step-up";
import { createCodeSubagentChildRunner } from "./code-subagent-child-runner";
import { ensureSessionBranch } from "./code-tool-git-executors";
import { CODE_TOOL_SCHEMAS } from "./code-tool-registry";
import { CodeToolRuntime, currentManifestVersion } from "./code-tool-runtime";
import { CodeTurnTracker } from "./code-workspace-checkpoint";
import { CodeRunPolicyCompositionSources, CodingAgentRunner, buildRunnerVersion, createCodeRunEnvironmentHolder, createCodeRunPolicyComposition } from "./coding-agent-runner";
import { createCoreServices } from "./core-services";
import { createExecutionSnapshotProvider, createResumeEnvironmentAdmission } from "./execution-snapshot";
import { CODE_AGENT_MASTER_FLAG, FeatureFlagService } from "./feature-flags";
import { createMcpRuntimeRunPath } from "./mcp-run-path";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { createProductionResilientAIEngine } from "./production-resilient-ai-engine";
import { ProjectGitService } from "./project-git-service";
import { ProjectPreviewService } from "./project-preview-service";
import { ProjectSandboxService } from "./project-sandbox-service";
import { ProjectService } from "./project-service";
import { ProviderDataPolicyService } from "./provider-data-policy";
import { ProviderDataPolicyAdminService } from "./provider-data-policy-service";
import { SandboxImagePolicy } from "./sandbox-image-policy";
import { isChatCapableModel, isNonChatSpecialtyModel } from "@npati/omniroute-adapter";
import { codeIntentIsReadOnly } from "@npati/shared";
import { AuthContext, CodeSession } from "@npati/workspace";
import path from "node:path";
import { CodeSubagentOperationService } from "./code-subagent-operations";
import { CodeSubagentDetachedRunner } from "./code-subagent-operations";
import { CodeAsyncProcessService } from "./code-async-process";
import { createProviderDataGuard } from "./provider-data-guard";
import { readMcpRuntimeManifest } from "./mcp-run-path";
import { registerCodeRunStreamRoutes } from "./code-run-stream-routes";
import { registerCodeRunRoutes } from "./code-route-runs";
import { registerCodeLifecycleRoutes } from "./code-route-lifecycle";

export interface CodeRouteDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  systemWorkspaceId: string;
  activeContextResolver: ReturnType<typeof createCoreServices>["activeContextResolver"];
  agent: ReturnType<typeof createCoreServices>["agent"];
  aiEngine: ReturnType<typeof createProductionResilientAIEngine>;
  aiPreferences: ReturnType<typeof createCoreServices>["aiPreferences"];
  codePreferences?: CodePreferencesStore;
  marketplace?: OmniRouteMarketplace;
  auditLogService: ReturnType<typeof createAuditServices>["auditLogService"];
  authProvider: ReturnType<typeof createCoreServices>["authProvider"];
  codeActivitySink: ReturnType<typeof createCodeRunActivitySink>;
  codeApprovalScope: CodeApprovalScopeService;
  codeCommandRegistry: ReturnType<typeof createCodeCommandRegistry>;
  codeDataPolicy: ProviderDataPolicyAdminService;
  codeDataPolicyStoreService: ProviderDataPolicyService;
  codeHooksService: ReturnType<typeof createCodeHooksService>;
  codeInstructionsLoader: ReturnType<typeof createCodeInstructionsLoader>;
  codeMembership: CodeMembershipService;
  codePrivilegedAudit: CodePrivilegedAuditPort | undefined;
  codeProcessManager: CodeProcessManager;
  codeReaper: CodeReaper;
  codeService: CodeService;
  codeSkillsService: ReturnType<typeof createCodeSkillsService>;
  codeToolRuntime: CodeToolRuntime;
  codeTurnTracker: CodeTurnTracker;
  featureFlagService: FeatureFlagService;
  mcpRunPath: ReturnType<typeof createMcpRuntimeRunPath>;
  notifyMessagingConnections: (input: { workspaceId: string; userId: string; companyId: string; agentId?: string | null; kind: "automation" | "background_run" | "approval"; title: string; detail: string }) => Promise<void>;
  projectGitService: ProjectGitService;
  projectPreviewService: ProjectPreviewService;
  projectBrowserQaService?: import("./project-browser-qa-service").ProjectBrowserQaService;
  projectSandbox: ProjectSandboxService | undefined;
  projectService: ProjectService;
  projectWorkspace: MountedWorkspaceProvider;
  providerDataGuardInstance: ReturnType<typeof createProviderDataGuard> | undefined;
  readRuntimeMcpManifest: (tenant: { workspaceId: string; companyId: string }) => ReturnType<typeof readMcpRuntimeManifest>;
  sandboxImagePolicy: SandboxImagePolicy;
  trackedProcesses: CodeAsyncProcessService | undefined;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
  lifecycleService?: ProjectLifecycleService;
}

export interface CodeRouteOutputs {
  codeRbacForRun: CodeRbac;
  codeRunStateLog: CodeRunStateLog;
  codeSessionInbox: CodeSessionInboxService;
  codeRunCancellation: CodeRunCancellationRegistry;
  codeSessionRunExecutor: CodeSessionRunExecutor;
  codeRunQueueLimits: ReturnType<typeof resolveCodeRunQueueLimits>;
  codeRunAdmission: ReturnType<typeof createCodeRunAdmission>;
  codeBackgroundRuns: CodeBackgroundRunRegistry;
  codeErasureContexts: WeakMap<object, AuthContext>;
  codeDataErasure: CodeDataErasureService;
  codingAgentRunnerRef: CodingAgentRunner | undefined;
  codeSubagentOperationsRef: (() => CodeSubagentOperationService) | undefined;
  subagentChildRunnerWithAck: CodeSubagentDetachedRunner | undefined;
  codeRunEnvironment: ReturnType<typeof createCodeRunEnvironmentHolder>;
}

export function registerCodeRouteWiring(app: FastifyInstance, deps: CodeRouteDeps): CodeRouteOutputs {
  const { log, systemWorkspaceId, activeContextResolver, agent, aiEngine, aiPreferences, auditLogService, authProvider, codeActivitySink, codeApprovalScope, codeCommandRegistry, codeDataPolicy, codeDataPolicyStoreService, codeHooksService, codeInstructionsLoader, codeMembership, codePrivilegedAudit, codeProcessManager, codeReaper, codeService, codeSkillsService, codeToolRuntime, codeTurnTracker, config, featureFlagService, mcpRunPath, notifyMessagingConnections, projectGitService, projectPreviewService, projectSandbox, projectService, projectWorkspace, providerDataGuardInstance, readRuntimeMcpManifest, sandboxImagePolicy, trackedProcesses, workspaceStore } = deps;
  let codeSessionResumeService!: CodeSessionResumeService;
  let codeRunQueueLimits!: ReturnType<typeof resolveCodeRunQueueLimits>;
  let codeRunAdmission!: ReturnType<typeof createCodeRunAdmission>;
  let codeBackgroundRuns!: CodeBackgroundRunRegistry;
  let codeErasureContexts!: WeakMap<object, AuthContext>;
  let codeDataErasure!: CodeDataErasureService;
  let codingAgentRunnerRefValue: CodingAgentRunner | undefined;
  let codeSubagentOperationsRefValue: (() => CodeSubagentOperationService) | undefined;
  let subagentChildRunnerWithAckValue: CodeSubagentDetachedRunner | undefined;
  const codeRbacForRun = new CodeRbac({ ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}), logger: log });

  const codeRunStateLog = new CodeRunStateLog({
    store: workspaceStore,
    leaseMs: config.codeAgentLimits?.runLeaseMs ?? DEFAULT_CODE_AGENT_LIMITS.runLeaseMs,
    heartbeatMs: config.codeAgentLimits?.runHeartbeatMs ?? DEFAULT_CODE_AGENT_LIMITS.runHeartbeatMs,
    logger: log,
  });

  const codeRunEnvironment = createCodeRunEnvironmentHolder();
  const codeSnapshotProvider = createExecutionSnapshotProvider({
    store: workspaceStore,

    workspaceId: systemWorkspaceId,
    sources: {

      policyVersion: async () => null,
      policyComposition: async () => codeRunEnvironment.policyComposition(),
      toolManifestVersion: async () => currentManifestVersion(),

      modelProfileVersion: async () => codeRunEnvironment.modelProfileVersion(),

      modelSelection: async () => codeRunEnvironment.modelSelection(),
      systemPrompt: async () => codeRunEnvironment.systemPrompt(),

      runnerVersion: async () => buildRunnerVersion(buildInfo),
      sandboxImage: async () => codeRunEnvironment.sandboxImage(),

      featureFlags: async () => codeRunEnvironment.featureFlags(),
      providerDataPolicy: async () => codeRunEnvironment.providerDataPolicy(),
      baseCommit: async () => codeRunEnvironment.baseCommit(),

      projectInstructions: async () =>
        codeRunEnvironment.projectInstructions() ?? { contentHash: null, trustStatus: "untrusted" as const },
      toolchain: async () => codeRunEnvironment.toolchain(),

      runtimeProviderCapabilities: async ({ workspaceId, companyId }) =>
        readRuntimeMcpManifest({ workspaceId, companyId }),

      modelProfileFallbackReason: async () => codeRunEnvironment.modelProfileTrace()?.fallbackReason ?? null,
    },
    resolveRole: async () => null,
  });

  const codeRunPolicySources: CodeRunPolicyCompositionSources = {

    projectPolicyVersion: async ({ ctx, companyId, projectId }) => {
      try {
        const view = await codeDataPolicy.getProjectPolicy(ctx, companyId, projectId);
        return view.policyVersion;
      } catch {
        return null;
      }
    },

    approvalRulesRevision: async ({ ctx, companyId, projectId, sessionId }) => {
      try {
        const rules = await codeApprovalScope.listRules(ctx, companyId, {
          projectId,
          ...(sessionId ? { sessionId } : {}),
        });
        return rules.reduce((max: number, rule: { revision: number }) => Math.max(max, rule.revision), 0);
      } catch {
        return null;
      }
    },

    companyMembershipRevision: async ({ ctx, companyId }) => {
      try {
        const members = await codeMembership.listMembers(ctx, companyId);
        return members.reduce((max: number, member: { revision: number }) => Math.max(max, member.revision), 0);
      } catch {
        return null;
      }
    },

    featureFlags: async ({ ctx, companyId }) => {
      try {
        const described = await featureFlagService.describe(ctx, { companyId, userId: ctx.userId });
        return { master: described.master, flags: described.flags, darkLaunch: described.darkLaunch };
      } catch {
        return null;
      }
    },

    providerDataPolicy: async ({ ctx, companyId, projectId, model }) => {
      try {
        const providerId = (model ?? "auto").split("/")[0] || "auto";
        const resolved = await codeDataPolicyStoreService.resolveForCompany({
          companyId,
          providerId,
          model: model ?? null,
          providerKind: null,
        });
        let classification: string | null = null;
        try {
          classification = (await codeDataPolicy.getProjectPolicy(ctx, companyId, projectId)).effectiveClassification;
        } catch {
          classification = null;
        }
        return { version: resolved.policyVersion ?? null, classification };
      } catch {
        return null;
      }
    },

    baseCommit: async ({ ctx, companyId, projectId }) => {
      try {
        const status = await projectGitService.status(ctx, companyId, projectId);
        let commit: string | null = null;
        try {
          const entries = await projectGitService.log(ctx, companyId, projectId, 1);
          commit = entries[0]?.hash ?? null;
        } catch {
          commit = null;
        }
        return { branch: status.branch ?? null, commit, dirty: status.clean === false };
      } catch {
        return null;
      }
    },

    toolchain: async ({ ctx, companyId, projectId }) => {
      try {
        const project = await projectService.get(ctx, companyId, projectId);
        const toolchain = (project as { toolchain?: unknown } | null)?.toolchain;
        return toolchain && typeof toolchain === "object" ? (toolchain as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
  };
  const codeSessionInbox = new CodeSessionInboxService({
    logger: { warn: (code) => log.warn({ code }, "code_inbox_dispatch_error") },
    store: workspaceStore.codeInbox,
    ownsLocalRun: (sessionId) => codeRunCancellation.hasLiveRun(sessionId),
    flags: featureFlagService,
    loadSession: (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId),
    loadRunState: (companyId, runId) => codeRunStateLog.loadRunState(companyId, runId),
    audit: async (ctx, companyId, sessionId, kind) => {
      if (!auditLogService) throw Object.assign(new Error("audit_unavailable"), { code: "audit_unavailable", status: 503 });
      await auditLogService.record(ctx, { companyId, actor: ctx.userId, actorRole: "human",
        action: `code.session.inbox.${kind}`, resourceType: "code_session", resourceId: sessionId, decision: "allowed" });
    },
  });
  registerCodeSessionInboxRoutes(app, { service: codeSessionInbox, auth: authProvider,
    runFinished: async (companyId, runId) => ["interrupted", "failed", "cancelled", "completed"].includes((await workspaceStore.getCodeRunState(companyId, runId))?.status ?? ""),
    authorize: (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input) });
  const codeProcessCompletions = trackedProcesses && workspaceStore.codeProcesses ? new CodeProcessCompletionService({
    store: workspaceStore.codeProcesses, processes: trackedProcesses, inbox: codeSessionInbox,
    loadSession: (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId),
    enabled: async (ctx, companyId) => await featureFlagService.isEnabled(ctx, "code.async_processes", { companyId }) && await codeSessionInbox.isEnabled(ctx, companyId),

    subagents: async (ctx, session) => {
      const operations = codeSubagentOperationsRefValue?.();
      if (!operations) return;
      const parents = await operations.listChildren({
        companyId: session.companyId, projectId: session.projectId, sessionId: session.id,
        dataClassification: session.dataClassification, retentionClass: session.retentionClass,
      });
      for (const parentRunId of [...new Set(parents.map((child) => child.runId))]) {
        await operations.recover({ ctx, companyId: session.companyId, sessionId: session.id, parentRunId });
      }
    },
    progress: (scope, notice) => codeBackgroundRuns.operationProgress(scope, { kind: "operation.settled", notice }),
    warn: (code) => log.warn({ code }, "code_completion_delivery_warning"),
  }) : undefined;
  if (codeProcessCompletions) {
    trackedProcesses!.setSettlementObserver((ctx, op) => codeProcessCompletions.settled(ctx, op));
    codeSessionInbox.setCompletionRecovery((ctx, session) => codeProcessCompletions.recover(ctx, session));
    app.addHook("onClose", async () => { await codeProcessCompletions.close(); });
  }
  const codingAgentRunner = new CodingAgentRunner({
    completions: codeProcessCompletions,
    asyncCollect: {
      enabled: (ctx, companyId) => featureFlagService.isEnabled(ctx, "code.async_collect_barrier", { companyId }),
      changes: (ctx, session, operations) => collectAsyncOperationChanges({
        session, operations,
        childChanges: (sessionId) => codeTurnTracker.sessionChanges(sessionId),
        childFileCount: async (runId) => {
          const state = await codeRunStateLog.loadRunState(session.companyId, runId);
          const estimate = state?.details.estimate as { filesChanged?: unknown } | undefined;
          return typeof estimate?.filesChanged === "number" && Number.isSafeInteger(estimate.filesChanged) && estimate.filesChanged >= 0 ? estimate.filesChanged : null;
        },
        listFiles: () => projectWorkspace.listFiles(ctx, session.companyId, session.projectId),
        readFile: (file) => projectWorkspace.readFile(ctx, session.companyId, session.projectId, file).catch((error) => {
          if ((error as { status?: number }).status === 404) return null;
          throw error;
        }),
        diff: (file) => projectGitService.diff(ctx, session.companyId, session.projectId, { file }),
      }),
    },

    ...(workspaceStore.codeProcesses ? {
      activeChildren: {
        settle: async (input) => await codeSubagentOperationsRefValue?.()?.settleChildren({ ...input, parentRunId: input.runId }) ?? true,
        isUnsettled: async (input: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string; runId: string }) =>
          await codeSubagentOperationsRefValue?.()?.hasRequiredChild({
            ctx: input.ctx, companyId: input.companyId, sessionId: input.sessionId, parentRunId: input.runId,
          }) ?? false,
      },
    } : {}),
    asyncProcessesEnabled: async (ctx, companyId, projectId) => !!trackedProcesses &&
      await featureFlagService.isEnabled(ctx, "code.async_processes", { companyId }) &&
      await featureFlagService.isEnabled(ctx, "code.background_runs", { companyId }) &&
      await projectSandbox!.supportsTrackedProcesses(ctx, companyId, projectId),
    asyncSubagentsEnabled: async (ctx, companyId) => !!trackedProcesses && await featureFlagService.isEnabled(ctx, "code.async_subagents", { companyId }) && await codeSessionInbox.isEnabled(ctx, companyId),
    asyncAgentControlsEnabled: async (ctx, companyId) => !!trackedProcesses && await featureFlagService.isEnabled(ctx, "code.async_agent_control", { companyId }) && await codeSessionInbox.isEnabled(ctx, companyId),
    inbox: codeSessionInbox,
    flags: featureFlagService,
    rbac: { authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input) },
    toolRuntime: codeToolRuntime,

    runtimeCapabilities: mcpRunPath,
    // One retry of a model request after a transient provider failure; tool calls run only after a response.
    engine: withTransientModelRetry(aiEngine),
    vision: createCodeRunVisionPort({
      chat: (request) => aiEngine.chat(request),
      preferences: (ctx) => aiPreferences.get(ctx),
      activeModelId: async (ctx) => (await deps.codePreferences?.get(ctx))?.activeModelId ?? null,
      configuredVisionModel: config.omnirouteVisionModel,
      candidates: async (configured, added) => { const id = await resolveConfirmedVisionModel(configured, added, deps.marketplace); return id ? [id] : []; },
    }),
    schemas: CODE_TOOL_SCHEMAS,

    modelProfiles: {
      profiles: DEFAULT_CODE_MODEL_PROFILES,
      enabledProfileIdsForRun: async ({ ctx, companyId }) =>
        resolveEnabledModelProfileIds({ flags: featureFlagService, ctx, companyId }),
    },
    imageAdmission: sandboxImagePolicy,
    runState: codeRunStateLog,

    quota: new CodeRunSharedQuota(globalQuotaManager, {
      onThreshold: (event) => {
        log.warn(
          {
            scope: event.scope,
            level: event.level,
            usedTokens: event.usedTokens,
            maxTokens: event.maxTokens,
            usedCostUsd: event.usedCostUsd,
            maxCostUsd: event.maxCostUsd,
            companyId: event.companyId ?? null,
          },
          "code_run_budget_threshold",
        );

        if (!event.companyId) return;
        void activitySinkForKind<Record<string, unknown>>(codeActivitySink, "run_activity")
          .record({
            companyId: event.companyId,
            ...(event.userId ? { userId: event.userId } : {}),
            event_type: "budget_threshold",
            scope: event.scope,
            level: event.level,
            budgetKey: event.budgetKey,
            usedTokens: event.usedTokens,
            maxTokens: event.maxTokens,
            usedCostUsd: event.usedCostUsd,
            maxCostUsd: event.maxCostUsd,
          })
          .catch(() => undefined);
      },
    }),

    sessionRunLink: async ({ ctx, companyId, sessionId, runId }) => {
      try {
        await workspaceStore.updateCodeSession(ctx, companyId, sessionId, { runId });
        return { linked: true };
      } catch (error) {
        return { linked: false, reason: error instanceof Error ? error.message : "session_run_link_failed" };
      }
    },

    ensureSessionBranch: async ({ ctx, companyId, projectId, sessionId }) =>
      ensureSessionBranch({ git: projectGitService, ctx, companyId, projectId, sessionId }),

    snapshot: codeSnapshotProvider,
    environment: codeRunEnvironment,

    contextSummaryStore: {
      persist: async (input) => workspaceStore.createCodeContextSummary({
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        runId: input.runId,
        snapshotId: input.snapshotId,
        turnIndex: input.turnIndex,
        schemaVersion: input.schemaVersion,
        summary: input.summary as unknown as Record<string, unknown>,
        summaryText: input.summaryText,
        contentHash: input.contentHash,
        dataClassification: input.dataClassification,
        retentionClass: input.retentionClass,
      }),
    },

    ...(providerDataGuardInstance
      ? {

          providerDataGuard: providerDataGuardInstance.providerDataGuard,
        }
      : {}),
    contextBlocks: {
      load: async ({ ctx, companyId, projectId, query, websiteEdit, sessionId }) => {
        let companyMemory: string | null = null;
        try {
          const memories = await workspaceStore.listMemory(ctx, companyId, query, 25);
          companyMemory = buildCompanyMemoryBlock(
            memories.map((memory) => ({
              ...(memory.title ? { title: memory.title } : {}),
              content: memory.content,
              ...(memory.type ? { type: memory.type } : {}),
            })),
          )?.body ?? null;
        } catch {
          companyMemory = null;
        }
        let projectContext: string | null = null;
        try {
          const raw = await projectWorkspace.readFile(ctx, companyId, projectId, "PROJECT.md");
          projectContext = buildProjectContextBlock(raw.content)?.body ?? null;
        } catch {
          projectContext = null;
        }
        try {
          const small = await smallWorkspaceContext(await projectWorkspace.listFiles(ctx, companyId, projectId), async (path) => (await projectWorkspace.readFile(ctx, companyId, projectId, path)).content);
          if (small) projectContext = [projectContext, small].filter(Boolean).join("\n\n");
        } catch { /* the agent can still list the folder itself */ }
        if (websiteEdit) {
          try {
            const files = await projectWorkspace.listFiles(ctx, companyId, projectId);
            const styles = await buildWebsiteStyleContext(files, async path => (await projectWorkspace.readFile(ctx, companyId, projectId, path)).content);
            const summaries = sessionId ? await workspaceStore.listCodeContextSummaries({ companyId, sessionId, limit: 10 }).catch(() => []) : [];
            const memory = websiteEditMemory(summaries, files, projectId);
            projectContext = [projectContext, styles, memory].filter(Boolean).join("\n\n");
          } catch { /* Optional repository hints never block an edit. */ }
        }
        if (!companyMemory && !projectContext) return null;
        return { companyMemory, projectContext };
      },
    },

    snapshotConfigVersions: {
      ensureSystemPromptVersion: async ({ ctx, companyId, projectId, workspaceId, promptText, profileId }) => {
        try {
          const ref = await ensureSystemPromptVersion({
            store: workspaceStore,
            companyId,
            workspaceId,
            createdBy: ctx.userId,
            content: { runnerVersion: buildRunnerVersion(buildInfo), profileId, projectId },
            promptText,
          });
          return { version: ref.version, contentHash: ref.contentHash };
        } catch {
          return null;
        }
      },
      ensureModelProfilesVersion: async ({ ctx, companyId, workspaceId, profile }) => {
        try {
          const ref = await ensureModelProfilesVersion({
            store: workspaceStore,
            companyId,
            workspaceId,
            createdBy: ctx.userId,
            content: { profile },
          });
          return ref.version;
        } catch {
          return null;
        }
      },
    },

    projectInstructions: {
      load: async ({ ctx, companyId, projectId }) => {
        try {
          return await codeInstructionsLoader.loadForRun({ ctx, companyId, projectId });
        } catch {
          return null;
        }
      },
    },

    skillInstructions: {
      render: async ({ sessionId }) => {
        try {
          return codeSkillsService.renderInstructions(sessionId);
        } catch {
          return null;
        }
      },
      provenance: async ({ sessionId }) => codeSkillsService.provenance(sessionId),
    },

    commandExpansion: {
      resolvePrompt: async ({ ctx, companyId, projectId, sessionId, prompt }) =>
        codeCommandRegistry.resolvePrompt({ ctx, companyId, projectId, ...(sessionId ? { sessionId } : {}), prompt }),
    },

    policyCompositionSources: codeRunPolicySources,
    activity: activitySinkForKind(codeActivitySink, "run_activity"),

    lifecycleHooks: {
      sessionStart: (input) => codeHooksService.sessionStart(input),
      stop: (input) => codeHooksService.stop(input),
    },

    admissionGate: { isRefusingNewRuns: () => codeReaper.isRefusingNewRuns() },

    replayBundle: {
      start: (replayInput) => new ReplayBundleRecorder({
        store: workspaceStore,
        context: {
          workspaceId: replayInput.workspaceId,
          companyId: replayInput.companyId,
          projectId: replayInput.projectId,
          sessionId: replayInput.sessionId,
          runId: replayInput.runId,
          executionSnapshotId: replayInput.snapshotId ?? null,
          runnerVersion: buildRunnerVersion(buildInfo),
          systemPromptVersion: replayInput.systemPrompt?.version ?? null,
          systemPromptContentHash: replayInput.systemPrompt?.contentHash ?? null,
          modelProfileVersion:
            typeof replayInput.modelProfileVersion === "number" ? replayInput.modelProfileVersion : null,
          provider: replayInput.modelSelection?.provider ?? null,
          model: replayInput.modelSelection?.model ?? null,
          replayMode: "recorded",

          runtimeMcpManifest: readRuntimeMcpManifest({
            workspaceId: replayInput.workspaceId,
            companyId: replayInput.companyId,
          }),
          ...(replayInput.dataClassification ? { dataClassification: replayInput.dataClassification } : {}),
          ...(replayInput.retentionClass ? { retentionClass: replayInput.retentionClass } : {}),
        },
        toolOutputChars: resolveCodeAgentLimits().toolOutputChars,
        logger: { warn: (message, meta) => log.warn(meta ?? {}, message) },
      }),
    },
    logger: { warn: (message, meta) => log.warn(meta ?? {}, message), info: (message, meta) => log.info(meta ?? {}, message) },

    runEvents: { append: async (entry) => entry },
  });

  const lifecycleRoutes = registerCodeLifecycleRoutes(app, {
    ...deps,
    codeRbacForRun,
    codeRunStateLog,
    codeSessionInbox,
    codeProcessCompletions,
    codingAgentRunner,
    getCodeSessionResumeService: () => codeSessionResumeService,
  });
  codingAgentRunnerRefValue = lifecycleRoutes.codingAgentRunnerRefValue;
  codeSubagentOperationsRefValue = lifecycleRoutes.codeSubagentOperationsRefValue;
  subagentChildRunnerWithAckValue = lifecycleRoutes.subagentChildRunnerWithAckValue;
  const { codeRunCancellation, codeSessionRunExecutor } = lifecycleRoutes;

  const runRoutes = registerCodeRunRoutes(app, {
    ...deps,
    codeRbacForRun,
    codeRunStateLog,
    codeRunPolicySources,
    codeSessionInbox,
    codeProcessCompletions,
    codeRunCancellation,
    codeSessionRunExecutor,
  });
  codeSessionResumeService = runRoutes.codeSessionResumeService;
  codeRunQueueLimits = runRoutes.codeRunQueueLimits;
  codeRunAdmission = runRoutes.codeRunAdmission;
  codeBackgroundRuns = runRoutes.codeBackgroundRuns;
  codeErasureContexts = runRoutes.codeErasureContexts;
  codeDataErasure = runRoutes.codeDataErasure;
  return {
    codeRbacForRun,
    codeRunStateLog,
    codeSessionInbox,
    codeRunCancellation,
    codeSessionRunExecutor,
    codeRunQueueLimits,
    codeRunAdmission,
    codeBackgroundRuns,
    codeErasureContexts,
    codeDataErasure,
    codingAgentRunnerRef: codingAgentRunnerRefValue,
    codeSubagentOperationsRef: codeSubagentOperationsRefValue,
    subagentChildRunnerWithAck: subagentChildRunnerWithAckValue,
    codeRunEnvironment,
  };
}
