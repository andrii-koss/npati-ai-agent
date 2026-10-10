/* Coding-agent route wiring and registration, extracted from app.ts
 * (step 2c-4 of docs/refactoring/PLAN.md).
 *
 * The route-wiring services of the code surface (rbac, run state, session inbox, cancellation,
 * run executor, queue admission, background runs, data erasure) and the sixteen registrars that
 * consume them, together with the per-route hooks. The block is moved verbatim; the edits are:
 * app.log -> log, AUDIT_SYSTEM_WORKSPACE -> systemWorkspaceId, the three late-bound refs renamed
 * to *Value because buildApp reads them after this call, and the ten wiring services returned
 * instead of staying closure constants (the platform-routes call below consumes four of them).
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { globalQuotaManager } from "./a2a-control-plane-routes";
import { createAuditServices } from "./audit-services";
import { buildInfo } from "./build-info";
import { readCodeActiveContext, writeCodeActiveContext } from "./code-active-context-store";
import { DEFAULT_CODE_AGENT_LIMITS, resolveCodeAgentLimits } from "./code-agent-config";
import { registerCodeAgentControlRoutes } from "./code-agent-controls";
import { CodeApprovalScopeService } from "./code-approval-scope";
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
  projectSandbox: ProjectSandboxService | undefined;
  projectService: ProjectService;
  projectWorkspace: MountedWorkspaceProvider;
  providerDataGuardInstance: ReturnType<typeof createProviderDataGuard> | undefined;
  readRuntimeMcpManifest: (tenant: { workspaceId: string; companyId: string }) => ReturnType<typeof readMcpRuntimeManifest>;
  sandboxImagePolicy: SandboxImagePolicy;
  trackedProcesses: CodeAsyncProcessService | undefined;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
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
  // C6a: durable run state. The log is the single writer of turn boundaries, the write-ahead tool-call records
  // and the lease/heartbeat that let another process decide whether a run is still alive.
  const codeRunStateLog = new CodeRunStateLog({
    store: workspaceStore,
    leaseMs: config.codeAgentLimits?.runLeaseMs ?? DEFAULT_CODE_AGENT_LIMITS.runLeaseMs,
    heartbeatMs: config.codeAgentLimits?.runHeartbeatMs ?? DEFAULT_CODE_AGENT_LIMITS.runHeartbeatMs,
    logger: log,
  });
  // C6b: per-run environment holder + the real snapshot provider. The admitted sandbox image digest and the
  // policy composition exist only for one run, so they are published here and read by the sources below.
  const codeRunEnvironment = createCodeRunEnvironmentHolder();
  const codeSnapshotProvider = createExecutionSnapshotProvider({
    store: workspaceStore,
    // The runner always passes the session's own workspace; this fallback mirrors the audit system workspace.
    workspaceId: systemWorkspaceId,
    sources: {
      // A single `policy_version` does not exist (see `policyComposition` below), so this stays null.
      policyVersion: async () => null,
      policyComposition: async () => codeRunEnvironment.policyComposition(),
      toolManifestVersion: async () => currentManifestVersion(),
      // C6b: the exact prompt and profile of this run, resolved to an immutable version by content hash (the
      // runner publishes them through the holder, because only the runner knows their content).
      modelProfileVersion: async () => codeRunEnvironment.modelProfileVersion(),
      // `parameters` stay absent: the runner passes no generation parameters, so no temperature exists to
      // record. Inventing one would be worse than the honest absence.
      modelSelection: async () => codeRunEnvironment.modelSelection(),
      systemPrompt: async () => codeRunEnvironment.systemPrompt(),
      // The build that executed the run: without it "which runner" is unanswerable.
      runnerVersion: async () => buildRunnerVersion(buildInfo),
      sandboxImage: async () => codeRunEnvironment.sandboxImage(),
      // Per-run facts published by the runner through the holder above.
      featureFlags: async () => codeRunEnvironment.featureFlags(),
      providerDataPolicy: async () => codeRunEnvironment.providerDataPolicy(),
      baseCommit: async () => codeRunEnvironment.baseCommit(),
      // C8 owns project instructions: until it lands the hash is genuinely unknown (`null`), and the trust
      // status is the conservative default rather than a claim that the project was trusted.
      projectInstructions: async () =>
        codeRunEnvironment.projectInstructions() ?? { contentHash: null, trustStatus: "untrusted" as const },
      toolchain: async () => codeRunEnvironment.toolchain(),
      /**
       * C13 (owner decision 6): the **runtime MCP manifest** in force for this run's tenant, published into
       * the snapshot so a run that called a runtime tool records *which* tool set and schema hashes it was
       * admitted under. A tenant with no runtime tools records `null` — the honest absence — and the payload
       * keeps the key set it had before this feature existed, so the snapshot schema version does not move.
       */
      runtimeProviderCapabilities: async ({ workspaceId, companyId }) =>
        readRuntimeMcpManifest({ workspaceId, companyId }),
      /**
       * C14: **why** the conservative model profile was used, from the same per-run holder the profile version
       * comes from. The runner publishes the whole trace (including the id that matched and the ids that were
       * allowed); the snapshot records the reason, because that is the part a reader has to act on — "the
       * deployment enabled no profile" and "this model has no profile" are different incidents.
       */
      modelProfileFallbackReason: async () => codeRunEnvironment.modelProfileTrace()?.fallbackReason ?? null,
    },
    resolveRole: async () => null,
  });
  /**
   * C6b/C10: the readers of the per-run environment facts. They are declared once, as a value, because two
   * callers need the *same* answer: the run snapshot (through the runner) and the resume-time environment
   * re-check (which has to compare the continuation's environment against the run's). Two inline objects would
   * be two definitions of "the policy in force", and a diff between them would be meaningless.
   */
  const codeRunPolicySources: CodeRunPolicyCompositionSources = {
    // C5b project data policy: the version is what changed when someone edited the policy.
    projectPolicyVersion: async ({ ctx, companyId, projectId }) => {
      try {
        const view = await codeDataPolicy.getProjectPolicy(ctx, companyId, projectId);
        return view.policyVersion;
      } catch {
        return null;
      }
    },
    // C5 scoped approval rules: the highest revision in force for this project/session.
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
    // C5a company membership: the highest member revision (a role change bumps it).
    companyMembershipRevision: async ({ ctx, companyId }) => {
      try {
        const members = await codeMembership.listMembers(ctx, companyId);
        return members.reduce((max: number, member: { revision: number }) => Math.max(max, member.revision), 0);
      } catch {
        return null;
      }
    },
    // Resolved flags in force for this run (master + sub-flags with scope/source), never the raw list.
    featureFlags: async ({ ctx, companyId }) => {
      try {
        const described = await featureFlagService.describe(ctx, { companyId, userId: ctx.userId });
        return { master: described.master, flags: described.flags, darkLaunch: described.darkLaunch };
      } catch {
        return null;
      }
    },
    // Effective provider data policy for the run: the version that governs it plus the classification that
    // was actually applied (the strictest of the C5b row and the C1 project record).
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
    // Branch and dirty come from `status`; the HEAD hash comes from the log (never derived from `status`).
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
    // The project's detected toolchain (C1 detector output), recorded as-is.
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
    authorize: (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input) });
  const codeProcessCompletions = trackedProcesses && workspaceStore.codeProcesses ? new CodeProcessCompletionService({
    store: workspaceStore.codeProcesses, processes: trackedProcesses, inbox: codeSessionInbox,
    loadSession: (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId),
    enabled: async (ctx, companyId) => await featureFlagService.isEnabled(ctx, "code.async_processes", { companyId }) && await codeSessionInbox.isEnabled(ctx, companyId),
    /**
     * Step 5: the detached delegations of this session, reconciled by the **child's own** run state. Every parent
     * run that has an unfinished child is asked about separately, because the child's run state — not the parent's —
     * is the oracle: a terminal child is settled from it, a live one is left to its owner, and an interrupted one
     * remains fenced for explicit Continue.
     */
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
    /**
     * Step 5: the parent's fence against a detached child. It reads the same durable delegation record the
     * sandbox-cleanup guard reads, through the service the detached path reserved in — so "a required child is
     * still running" withholds this run's sandbox release instead of letting the parent's terminal path destroy a
     * workspace the child is still writing into. Absent (no process store) the runner behaves exactly as before,
     * and the service is late-bound because the runner is built before it.
     */
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
    /**
     * C13 (owner requirement: fresh-process MCP acceptance): the runtime provider surface of a run.
     *
     * The runner calls `prepareForRun` itself, once, before it builds the model-visible tool list and before the
     * ExecutionSnapshot (`codeSnapshotProvider` above) pins the runtime manifest — so an MCP Integration that is
     * configured and active is discovered by the **run**, with no Inspector request and no warm-up call. A
     * discovery that fails only removes MCP tools: the port answers with a code and an empty list, and the run
     * proceeds on the static tools.
     */
    runtimeCapabilities: mcpRunPath,
    engine: aiEngine,
    schemas: CODE_TOOL_SCHEMAS,
    /**
     * C6/C14: model profiles are configuration, and this is where the deployment's configuration is connected.
     *
     * The port existed since C6 and the runner read it, but nothing ever supplied it: `enabledProfileIds` — the
     * only handle the `code.model_profile.<id>` flags have on profile resolution — never reached
     * `resolveModelProfile`, so the documented flag mechanism could not enable or exclude a single profile and
     * every run silently resolved against the whole built-in registry. The registry is the **existing**
     * `DEFAULT_CODE_MODEL_PROFILES` (no second one is created here) and the enabled ids come from the
     * **existing** `FeatureFlagService`.
     *
     * The flags are resolved **per run**, not once at composition time: the service resolves rows per
     * workspace/company, and a cached-at-boot list would keep honouring a switch an operator has since turned
     * off. A flag that is off excludes its profile, and a flag store that cannot be read enables nothing — the
     * run then continues on the conservative profile instead of the full registry.
     */
    modelProfiles: {
      profiles: DEFAULT_CODE_MODEL_PROFILES,
      enabledProfileIdsForRun: async ({ ctx, companyId }) =>
        resolveEnabledModelProfileIds({ flags: featureFlagService, ctx, companyId }),
    },
    imageAdmission: sandboxImagePolicy,
    runState: codeRunStateLog,
    /**
     * C12: the coding agent's budget. The port and both call sites existed since C6 (`checkQuota` before every
     * model call, `recordUsage` after every answered turn), but nothing ever supplied an implementation, so
     * `budget_exhausted` was unreachable in a real deployment. It is supplied here over the **existing**
     * `A2AQuotaManager` — the same instance the A2A control-plane routes configure — so there is one accounting
     * system, and it is keyed by session: a delegated run belongs to its parent's session, so parent and
     * children draw on one shared `sessionBudget` and a child cannot spend past what the parent has left.
     *
     * R1 (section A, item 2) adds the **daily** allowances (per user, per Company) to the same adapter, and this
     * is where a threshold crossing becomes a **notification**: an Activity event persisted through the existing
     * `codeActivitySink`, plus the structured log line that existed before. Activity is the surface the Coding
     * Agent already shows runs and decisions in, so the 80 % warning and the 100 % stop are visible to the user
     * who hit them rather than scrolling out of a container log. The messaging channels are deliberately not
     * reused: their per-connection switch vocabulary (`automation` / `background_run` / `approval`) is a settings
     * schema of its own, and quietly reusing one of those kinds would send a budget notice under another switch's
     * name.
     */
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
        // Without a tenant there is nothing to scope the record to, and the sink would refuse it. The log line
        // above is then the only notice, which is honest: the caller did not say whose budget it was.
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
    /**
     * C10: the session→run link. `code_sessions.run_id` had a reader (`lastRun`, `usage`) and an update path but
     * **no writer**, so both answers were permanently `null` and a resume had no way to find "the run of this
     * session". The write happens the moment the durable run id exists, and it is best effort: the run row is the
     * source of truth for the run, and a failed link must not abort work that has already been admitted.
     */
    sessionRunLink: async ({ ctx, companyId, sessionId, runId }) => {
      try {
        await workspaceStore.updateCodeSession(ctx, companyId, sessionId, { runId });
        return { linked: true };
      } catch (error) {
        return { linked: false, reason: error instanceof Error ? error.message : "session_run_link_failed" };
      }
    },
    /**
     * C11 (owner decision 8): the session branch. It delegates to the existing `ProjectGitService` through
     * the git executors' own helper, so "does the branch exist" is answered by listing branches (a real git
     * query) rather than by parsing a failed `checkout`. The runner calls it before the first model step and
     * **stops the run** if the branch cannot be established, because continuing would mean working on
     * whatever branch happens to be checked out.
     */
    ensureSessionBranch: async ({ ctx, companyId, projectId, sessionId }) =>
      ensureSessionBranch({ git: projectGitService, ctx, companyId, projectId, sessionId }),
    // C6b: the snapshot is real, not the null provider. The provider is built once per process, so the facts
    // that only exist per run (the admitted image digest and the policy composition) travel through the
    // holder below. Every source that this deployment genuinely cannot answer returns `null` with the reason
    // next to it — a fabricated value would make "policy changed" a lie.
    snapshot: codeSnapshotProvider,
    environment: codeRunEnvironment,
    // C8: the compaction summary is a durable session artifact (migration 079, append-only). The store call is
    // the existing one; the runner treats a failure as non-fatal, because losing the artifact must not abort a
    // run that is otherwise progressing.
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
    // C8: company memory and Website Builder project context, rendered as separate labelled blocks. Both are
    // optional and fail-soft; the labelling is what keeps repository data from looking like tenant rules.
    ...(providerDataGuardInstance
      ? {
          // C8: the compaction summary becomes part of the transcript and therefore provider-bound content, so it
          // goes through the **same** guard instance the chat path uses — same policy resolution, same
          // classification ceiling, same redaction list, same decision recording. A second scanner here would be
          // a second answer to "may this leave NPATI", which is exactly what C5b exists to prevent.
          providerDataGuard: providerDataGuardInstance.providerDataGuard,
        }
      : {}),
    contextBlocks: {
      load: async ({ ctx, companyId, projectId, query }) => {
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
        if (!companyMemory && !projectContext) return null;
        return { companyMemory, projectContext };
      },
    },
    // C6b: the prompt/profile versions come from the existing content-addressed registries, so two runs with
    // identical configuration share a version and any change mints a new one.
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
    // C8: project instructions (NPATI.md / AGENTS.md / the shared PROJECT.md). Loading is fail-soft: an
    // unreadable instruction file yields no block, never an empty "trusted" one.
    projectInstructions: {
      load: async ({ ctx, companyId, projectId }) => {
        try {
          return await codeInstructionsLoader.loadForRun({ ctx, companyId, projectId });
        } catch {
          return null;
        }
      },
    },
    /**
     * C13: the typed Skill Instructions section of the system prompt. `render` produces the section the model
     * reads; `provenance` produces the `skill_id`/`version`/`hash`/`source` the ExecutionSnapshot records. Both
     * read the **same** per-session state, so the snapshot cannot describe a different set of Skills than the
     * prompt contained.
     */
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
    /**
     * C13: the slash-command expansion of the run's prompt. The registry resolves the name with the C13
     * precedence, expands through the one pure builder and answers with the text plus the provenance the replay
     * bundle pins. A prompt that is not a slash command comes back unchanged, so this port cannot alter any
     * existing run.
     */
    commandExpansion: {
      resolvePrompt: async ({ ctx, companyId, projectId, sessionId, prompt }) =>
        codeCommandRegistry.resolvePrompt({ ctx, companyId, projectId, ...(sessionId ? { sessionId } : {}), prompt }),
    },
    // C6b/C10: the readers declared above, shared with the resume-time environment re-check.
    policyCompositionSources: codeRunPolicySources,
    activity: activitySinkForKind(codeActivitySink, "run_activity"),
    /**
     * C13: `SessionStart` and `Stop` for a run, emitted through the project hooks service (which owns the
     * flag/trust/config gates and the existing lifecycle bus). A hook failure is swallowed by the runner: a
     * project's hook can never change a run's outcome.
     */
    lifecycleHooks: {
      sessionStart: (input) => codeHooksService.sessionStart(input),
      stop: (input) => codeHooksService.stop(input),
    },
    // C6a: when the reaper reports disk pressure it refuses new runs. The check runs at run start — after
    // RBAC, before image admission and before any model or tool call — and a gate that throws refuses too
    // (`admission_gate_unavailable`), because "the gate did not answer" must never mean "let it run".
    admissionGate: { isRefusingNewRuns: () => codeReaper.isRefusingNewRuns() },
    /**
     * C6b: record what a deterministic replay needs — every model answer and the canonical, model-visible,
     * settled tool result. The recorder writes one bundle per run (idempotent by run + format version) and its
     * failure never changes the run; a bundle containing a secret is refused instead of silently redacted.
     */
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
          /**
           * C13 (owner decision 6): the runtime MCP manifest this run was admitted under, pinned into the
           * recorded bundle. The run path discovered before the recorder started, so this reads the set the run
           * really had. Until this line the recorder's `runtimeMcpManifest` member existed with **no writer**,
           * which meant `assertReplayRuntimeMcpManifestMatches` could only ever pass: a bundle that replayed a
           * call to a tool whose schema had since changed would have replayed it silently against the new
           * schema. `null` for a run with no runtime tools keeps the pre-C13 bundle shape (and its hash).
           */
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
    logger: { warn: (message, meta) => log.warn(meta ?? {}, message) },
    // C6b: activity is persisted by the shared sink above; the run-entity binding arrives with the run trace.
    runEvents: { append: async (entry) => entry },
  });
  // Replay, lifecycle, session-control, metrics and snapshot routes.
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

  // durability, background and CLI runs, queue, export and data-erasure routes.
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