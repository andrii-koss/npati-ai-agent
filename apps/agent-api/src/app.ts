import { createEmailAutomationWiring } from "./email-automation-wiring";
import { createCodeSandboxWiring } from "./code-sandbox-wiring";
import { createCodePortsWiring } from "./code-ports-wiring";
import { createCodeToolRuntimeWiring } from "./code-tool-runtime-wiring";
import { createCodeToolWiring } from "./code-tool-wiring";
import cors from "@fastify/cors";
import { ContextBuilder, NpatiAgent } from "@npati/agent";
import { OmniRouteEngine, OmniRouteMarketplace, type AIEngine, type ChatRequest, type ChatContentPart, type ChatToolCall, type ChatToolDefinition, isChatCapableModel, isNonChatSpecialtyModel } from "@npati/omniroute-adapter";
import { createWebResearch, type ResearchOutcome, type ResearchProgressEvent, type ResearchProgressListener, type WebResearchService, extractTargetUrlOrDomain } from "@npati/web-research";
import type { AgentReply, HealthResponse, ServiceHealth, ServiceStatus } from "@npati/shared";
import { createClient } from "redis";
import { defaultSkillRegistry } from "@npati/skills";
import { InMemoryWorkspaceStore, PostgresWorkspaceStore, type AuthContext, type Business, type OnboardingScenario, type WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError, DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS } from "@npati/workspace";
import Fastify from "fastify";
import path from "node:path";
import { SpreadsheetModifier } from "./spreadsheet-modifier";
import { BusinessActionHandler } from "./business-action-handler";
import { CompanyChatActions } from "./company-chat-actions";
import { CHAT_TOOL_SELECTION_INSTRUCTION, CORE_CHAT_TOOLS, runChatToolLoop, type ChatToolExecutionResult } from "./chat-tool-orchestrator";
import { BUSINESS_PROFILE_TOOL, executeBusinessProfileTool, reconcilePlannedBusinessArgs } from "./business-profile-native";
import { summarizeBusinessProfileChat } from "./business-profile-response";
import { planStructuredChatRequest, businessPlanComplete, companyPlanComplete, type StructuredChatPlan } from "./chat-task-plan";
import { reconcilePlannedCompanyArgs } from "./company-plan-reconciliation";
import { verifyPlannedCompany } from "./company-plan-verification";
import { WorkspaceChatActions } from "./workspace-chat-actions";
import { chatLanguageInstruction, companyChatCopy, detectCompanyChatLanguage, resolveConversationLanguage, type CompanyChatLanguage } from "./company-chat-i18n";
import { compositeCreationCopy, compositeMemoryCopy } from "./composite-chat-i18n";
import { companyDeleteCompletedAll, companyDeleteConfirmAll, isCompanyDeleteConfirmed } from "./company-delete-i18n";
import { pendingCompanyDelete } from "./pending-company-delete";
import { AuthenticationError, NpatiBackendAuthProvider, type AuthProvider } from "./auth";
import { createNpatiAuthClient, type NpatiAuthClient } from "@npati/hub-connector";
import { ProjectService } from "./project-service";
import { DataStudioUiService } from "./data-studio/studio-service";
import { ProjectApiGatewayService } from "./data-studio/gateway-service";
import { bootstrapWebsiteData, isCommerceWebsite } from "./data-studio/website-bootstrap";
import { AgentDataStudioService } from "./data-studio/agent-data-service";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { ProjectWorkspaceBaseResolver, type MountedFolderFlagPort } from "./workspace-base-resolver";
import { RemoteSandboxProvider, projectRuntimeMode } from "./sandbox-provider";
import { ProjectSandboxService } from "./project-sandbox-service";
import { ProjectTerminalEventsRepository } from "./project-terminal-events";
import { ProjectGitService, type HostGitCredentialPort } from "./project-git-service";
import { ProjectImportService } from "./project-import-service";
import { CodeService } from "./code-service";
import { NetworkActivityRecorder } from "./network-activity";
import { PolicyDecisionRecorder } from "./policy-decision-activity";
import { activitySinkForKind, createCodeRunActivitySink } from "./code-run-activity-sink";

import { CodeHookError, createCodeHooksService, createCodeHookPolicyPreflight } from "./code-hooks";
import { globalLifecycleHookManager } from "./automations-routes";
import { deliverWebhook } from "./webhook-destination-policy";
import { defaultResolver as ssrfDefaultResolver } from "./ssrf-safe-http";
import { resolveMigrationTargetConfig } from "./code-shell-runtime";
import { CodeProjectTrustService } from "./code-project-trust";
import { CodeSessionModeService, registerCodeSessionModeRoutes } from "./code-session-mode-routes";
import { CodeMembershipService } from "./code-membership";
import { registerCodeMembershipRoutes } from "./code-membership-routes";
import { registerCodeDataPolicyRoutes } from "./code-data-policy-routes";
import { ProviderDataPolicyAdminService } from "./provider-data-policy-service";
import { ProviderDataPolicyService, type ProviderDataClassification } from "./provider-data-policy";
import {
  CodeProtectedBranchRepository,
  CodeProtectedBranchService,
  resolveProtectedBranchGuardConfig,
} from "./code-protected-branches";
import { CodeStepUp, resolveStepUpConfig, type CodePrivilegedAuditPort } from "./code-step-up";
import { CodeProductionOperations, NullProductionExecutor, registerCodeProductionRoutes } from "./code-prod-operations";
import { resolveAutomationAllowedPermissions, serviceIdentityForAutomation } from "./code-service-identity";
import { CodeRbac } from "./code-rbac";
import { groupForCapability } from "./code-capability-groups";
import { resolveAllowlistForPhase, resolveEgressAllowlist, toProxyAllowedHosts } from "./egress-allowlist";
import { resolveEgressEnforcement } from "./sandbox-egress-enforcement";
import { RunnerReadinessClient, resolveRunnerReadinessTtl } from "./sandbox-runner-readiness-client";
import { assertManifestConsistent, currentToolManifest, CODE_TOOL_SCHEMAS } from "./code-tool-registry";
import { CodingAgentRunner, buildRunnerVersion, createCodeRunEnvironmentHolder, createCodeRunPolicyComposition, type CodeRunPolicyCompositionSources, type CodingAgentRunResult } from "./coding-agent-runner";

import { buildCompanyMemoryBlock, buildProjectContextBlock } from "./code-context-memory";import { registerCodeRunStreamRoutes } from "./code-run-stream-routes";

import { createCodeInstructionsLoader } from "./code-instructions-loader";

import { proposePlan, updateSessionTodos } from "./code-plan-tool";

import { createCodeAskUserService } from "./code-ask-user-service";
import { createCodeUserQuestionReaperPort } from "./code-ask-user-reaper";
import { isRepositoryInstructionsTrusted } from "./code-project-trust";

import { createCodeCommandRegistry } from "./code-command-registry";
import { createCodeSkillsService } from "./code-skills-instructions";
import { SandboxImagePolicy, sandboxImagePolicyConfig } from "./sandbox-image-policy";

import { connectionWantsNotification } from "./code-background-run-notifications";
import { CosignImageSignatureVerifier } from "./sandbox-image-signature";
import { CodeToolRuntime, CodeToolError, createProjectWorkspaceReadPort, createProjectWorkspaceWritePort, currentManifestVersion } from "./code-tool-runtime";
import { buildInstallPlan, registryFromConfig, runInstallPlan } from "./code-deps-policy";
import { runDependencyAudit, shouldBlockCommit } from "./code-deps-audit";
import { classifyDependencySource, findTyposquatTarget, isRegistryAllowed, resolveDepsGuardPolicy, sourceRequiresApproval } from "./code-deps-guard";
import { allCanonicalExecutors, runSandboxPostWriteHook, type CodeVerifyRunnerPort } from "./code-tool-executors";

import { createCodeSubagentChildRunner } from "./code-subagent-child-runner";
import {
  CodeSubagentOperationService,
  type CodeSubagentDetachedRunner,
} from "./code-subagent-operations";
import { gitWriteIntentForTool, sessionBranchName } from "./code-git-workflow";
import { CodeWorkspaceRevisionGuard } from "./code-workspace-revision";
import { buildPullRequestDescription } from "./code-pr-description";
import { CodeShellRuntime, type CodeShellSandboxPort } from "./code-shell-runtime";
import { CodeAsyncProcessService } from "./code-async-process";
import { CodeProcessManager, type CodeProcessSandboxPort } from "./code-process-manager";
import { createCodeProcessControls } from "./code-process-runtime";
import { CodeReaper, asStaleApprovalReaper } from "./code-reaper";

import { CodeDataRetention } from "./code-data-retention";
import { SecretLeaseProvider } from "./code-secret-lease";
import { isAgentPrincipal, isReviewSafeTool, matrixModeFor, PolicyEngine } from "./code-policy-engine";
import type { GitWriteIntent } from "./code-git-write-policy";
import { classifyShellCommand } from "./code-shell-classifier";
import { detectVerifyTool, parseVerifyOutput } from "./code-verify-parser";

import { CodeTurnTracker, codeCheckpointPortFromGit, approvalsBackedPort, resolveTurnTrackingOptions } from "./code-workspace-checkpoint";
import { resolveApprovalPolicy } from "./code-edit-approval";
import { CodeApprovalScopeService, resolveApprovalTimeoutMs } from "./code-approval-scope";
import { ReadTracker, resolveReadTrackerOptions } from "./code-read-tracker";
import { FeatureFlagService } from "./feature-flags";
import { DEFAULT_CODE_AGENT_LIMITS, resolveCodeAgentLimits, type CodeAgentLimits } from "./code-agent-config";
import { ProjectDeployService } from "./project-deploy-service";
import { ProjectBrowserQaService } from "./project-browser-qa-service";
import { ProjectPreviewService } from "./project-preview-service";
import { ProjectFileLeaseManager } from "./project-file-lock";
import { ProjectOrchestrator, ProjectOrchestrationError } from "./project-orchestrator";
import { isCodeChatWebsite, hasCodeChatPreview, finishCodeChatWebsite } from "./code-chat-website";
import { CompanyDelegationRuntime, companyRunTelemetryHeaders } from "./company-runtime";
import { CompanyKnowledgeProcessor,CompanyKnowledgeRepository } from "./company-knowledge";
import { CompanyKnowledgeQueue } from "./company-knowledge-queue";
import { registerReliabilityAndOperationsRoutes, globalAdmissionQueue } from "./reliability-and-operations-routes";
import { createProductionResilientAIEngine } from "./production-resilient-ai-engine";
import { createProviderDataGuard } from "./provider-data-guard";
import { createEnginePolicyResolver, OutboundPolicySnapshot, resolveOutboundPolicyFromSnapshot, type ProviderDataPolicyLookupPort } from "./provider-data-policy-resolver";
import { AdmissionError, type PriorityTier } from "./resilience-admission-queue";
import { BrowserCredentialsRepository } from "./browser-credentials-repository";
import { BrowserUseClient } from "./browser-tool";
import { CompanyAutomationsRepository } from "./automations-repository";
import { AutomationScheduler, computeNextCronDate } from "./automation-scheduler";
import { ContentLibraryStore } from "./content-library-store";
import { CompanyApprovalsRepository } from "./approvals-repository";
import { IntegrationsRepository } from "./integrations-repository";

import { lookupCapability } from "./mcp-runtime-capabilities";
import { McpRuntimeCapabilityStore } from "./mcp-runtime-capabilities";
import { McpToolPolicyStore } from "./mcp-tool-policy-repository";
import {
  McpRuntimeTransport,
  configuredIntegrationsFrom,
  type McpIntegrationSource,
} from "./mcp-runtime-transport";
import { createMcpRuntimeRunPath, readMcpRuntimeManifest } from "./mcp-run-path";
import { mcpApprovalRunIdOf, releaseMcpApprovalPause, type McpApprovalReleaseReason } from "./mcp-approval";
import { MessagingIntegrationsRepository } from "./messaging-integrations-repository";
import { MessagingGateway, TelegramMessagingAdapter, formatTelegramCards, type GatewayOutboundAttachment } from "./messaging-gateway";
import { WhatsAppMessagingAdapter } from "./whatsapp-messaging";
import { DiscordMessagingAdapter } from "./discord-messaging";
import { SlackMessagingAdapter } from "./slack-messaging";
import { MessagingScopeRouter } from "./messaging-scope-router";
import { EmailInboxRepository } from "./email-inbox-repository";
import { EmailChatActions } from "./email-chat-actions";
import { EmailInboxWorker } from "./email-worker";
import { EmailMessagingAdapter, emailEnvelopeToGatewayMessage } from "./email-messaging-adapter";
import { EmailAgentTools } from "./email-agent-tools";
import { EmailAttachmentStorage } from "./email-attachment-storage";
import { ApiKeysRepository } from "./api-keys-repository";
import { ScopedMemoryEngine } from "./scoped-memory";
import { CompanyToolRuntime } from "./company-tool-runtime";
import { CompanyRunQueueProducer } from "./company-run-queue";
import { InMemoryObjectStorage, type ObjectStorage } from "./object-storage";
import { InMemoryFileMetadataRepository, PostgresFileMetadataRepository, type FileMetadataRepository } from "./file-metadata";
import { InMemoryStorageProtection, RedisStorageProtection, StorageRateLimitError, type StorageProtection } from "./storage-protection";
import { StorageReconciler, type StorageReconcilerOptions } from "./storage-reconciler";
import { PerRequestNoMemoryGate, type NoMemoryEvaluationResult } from "./ephemeral-no-memory-and-rtk";
import {SecurityPolicyEngine,SecurityPolicyViolation} from "./security-guardrails";
import { assertOutboundAllowed, createOutboundGuard, setOutboundGuard } from "./outbound-exfiltration-guard";
import {GuardrailPolicyRepository} from "./guardrail-policy-repository";
import {WasmExecSandbox} from "./wasm-exec-sandbox";
import { InMemoryActiveSessionRegistry, RedisActiveSessionRegistry, type ActiveSessionLease, type ActiveSessionRegistry } from "./distributed-session-registry";
import { ContextCompactor } from "./context-compactor";
import { AutomaticMemoryExtractor } from "./automatic-memory-extractor";
import { MemoryDocumentService, memoryDocumentPrompt } from "./memory-documents";
import { extractDocumentText } from "./document-extractor";

import { conversationTitle, inferOnboardingScenario, isCompositeBusinessCompanyCreation, isLikelyOnboardingAside, isShortAffirmativeReply, isSimpleGreeting, normalizeNewBusinessDirective, onboardingGoalQuestion, quickOnboardingReply, requestsBusinessGoal, requestsBusinessMemory, requestsCompositeCompanyDeletionIntent, requestsNewBusinessIdea, resolveContextualCompanyFollowUp } from "./chat-intent-helpers";
import { ChatAttachmentInput, prepareChatAttachments, safeAttachmentName } from "./chat-attachments";
import { attachResearchSources, publicChatError, publicCompanyRunMessage } from "./chat-public-errors";
import { addColumnDirectiveFromMarkdown, explicitlyRequestsWebResearch, isSpreadsheetEditRequest, mapColumnDirectiveFromProposal, spreadsheetEditedMessage } from "./chat-text-directives";
import { defaultCoreBackendHealthCheck, withHealthTimeout } from "./backend-health-probe";
import { createAuditServices } from "./audit-services";
import { createCoreServices } from "./core-services";
import { createDataBackendServices } from "./data-backend-services";
import { registerHealthRoutes } from "./health-routes";
import { registerPlatformRoutes } from "./platform-routes";
import { registerPlatformBaseRoutes } from "./platform-base-routes";
import { registerCodeRouteWiring } from "./code-route-wiring";
import { registerCapabilityRoutes } from "./capability-routes";
import { registerMiscRoutes } from "./misc-routes";
import { registerChatStreamRoutes } from "./chat-stream-routes";
import { registerChatRoutes } from "./chat-routes";
import { createChatOrchestration } from "./chat-orchestration";
import { createCodePolicyWiring } from "./code-policy-wiring";
import { createAutomationExecutor } from "./automation-executor-wiring";
import { createRedisHealthWiring } from "./redis-health-wiring";
import { createEnrichedPolicyEngineWiring } from "./enriched-policy-engine-wiring";
import { createShellSandboxPortWiring } from "./shell-sandbox-port-wiring";
import { createProcessSandboxPortWiring } from "./process-sandbox-port-wiring";
import { createCodeSessionWiring } from "./code-session-wiring";
import { createMessagingNotificationsWiring } from "./messaging-notifications-wiring";

export { isSpreadsheetEditRequest, mapColumnDirectiveFromProposal };

function* boundedResponseChunks(value:string,maxCharacters=1_024){
  for(let offset=0;offset<value.length;){
    let end=Math.min(value.length,offset+maxCharacters);
    if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]!))end-=1;
    if(end<=offset)end=Math.min(value.length,offset+maxCharacters+1);
    yield value.slice(offset,end);offset=end;
  }
}

const AUDIT_SYSTEM_WORKSPACE = process.env.NPATI_WORKSPACE_ID ?? "dev-workspace";

export interface AppConfig {
  webOrigin?: string;
  omnirouteBaseUrl?: string;
  omnirouteApiKey?: string;
  omnirouteManagementPassword?: string;
  omnirouteTranscriptionModel?: string;
  omnirouteTtsModel?: string;
  omnirouteEmbeddingModel?: string;
  omnirouteRerankModel?: string;
  omnirouteVisionModel?: string;
  dataDirectory?: string;
  projectWorkspaceRoot?: string;

  codeAgentLimits?: Partial<CodeAgentLimits>;
  hubBaseUrl?: string;
  hubApiKey?: string;
  databaseUrl?: string;
  workspaceStore?: WorkspaceStore;
  authProvider?: AuthProvider;
  authClient?: NpatiAuthClient;
  npatiBackendUrl?: string;
  npatiJwtSecret?: string;
  strictAuth?: boolean;
  agentPublicDomain?: string;
  messagingWebhookBaseUrl?: string;
  agentVersion?: string;
  deploymentType?: "self_hosted" | "npati_hosted";
  hostedRegistrationToken?: string;
  allowLegacyPasswordAuth?: boolean;
  aiEngine?: AIEngine;
  marketplace?: OmniRouteMarketplace;
  crawlerBaseUrl?: string;
  webResearch?: WebResearchService;
  companyRunTimeoutMs?: number;
  redisUrl?: string;
  redisHealthCheck?: () => Promise<ServiceHealth>;
  coreBackendHealthCheck?: () => Promise<ServiceHealth>;
  browserUseWorkerUrl?: string;
  browserUseInternalToken?: string;
  objectStorage?: ObjectStorage;
  fileMetadataRepository?: FileMetadataRepository;
  storageProtection?: StorageProtection;
  storageReconcilerOptions?: StorageReconcilerOptions;
  activeSessionRegistry?: ActiveSessionRegistry;
  projectSandbox?: ProjectSandboxService;
}

export function buildApp(config: AppConfig = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" ? {redact:{paths:["req.headers.authorization","req.headers.x-npati-api-key","req.body.password","req.body.apiKey","req.body.token","req.body.imapConfig.password","req.body.smtpConfig.password","req.body.imapConfig.accessToken","req.body.smtpConfig.accessToken","req.body.imapConfig.refreshToken","req.body.smtpConfig.refreshToken","req.body.imapConfig.clientSecret","req.body.smtpConfig.clientSecret"],censor:"[REDACTED]"}} : false, bodyLimit: 30 * 1024 * 1024 });

  const redisHealthWiring = createRedisHealthWiring({
    config,
    log: app.log,
    app,
  });
  const { activeChatStreams, activeSessionRegistry, redisHealthCheck } = redisHealthWiring;
  const baseAiEngine = config.aiEngine ?? new OmniRouteEngine({
    baseUrl: config.omnirouteBaseUrl,
    apiKey: config.omnirouteApiKey,
    transcriptionModel: config.omnirouteTranscriptionModel,
    ttsModel: config.omnirouteTtsModel,
    embeddingModel: config.omnirouteEmbeddingModel, rerankModel: config.omnirouteRerankModel,
  });

  let engineDataPolicyResolver: ReturnType<typeof createEnginePolicyResolver> | undefined;

  let outboundPolicySnapshot: OutboundPolicySnapshot | undefined;
  let refreshOutboundPolicySnapshot: (() => void) | undefined;
  const resolveEngineDataPolicy = (input: { model?: string; providerId?: string; policyContext?: { companyId: string } }) => {
    const resolver = engineDataPolicyResolver;
    if (!resolver) {

      throw new Error("provider data policy resolver is not wired yet");
    }
    return resolver(input);
  };
  const providerDataGuardInstance = process.env.NPATI_CODE_PROVIDER_DATA_ENFORCEMENT === "true"
    ? createProviderDataGuard(baseAiEngine, { resolvePolicy: (input) => resolveEngineDataPolicy(input) })
    : undefined;
  const guardedAiEngine = providerDataGuardInstance ?? baseAiEngine;
  const aiEngine = createProductionResilientAIEngine(guardedAiEngine, {
    queue: globalAdmissionQueue,
    defaultTier: "pro",

    isModelEligible: providerDataGuardInstance
      ? async (model: string) => {
          try {
            const policy = await resolveEngineDataPolicy({ model });
            if (policy.stale) return { eligible: false, reason: "policy_stale" };
            const projectDefault = "confidential";
            const rank: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
            if ((rank[projectDefault] ?? 3) > (rank[policy.maxDataClassification] ?? 3)) {
              return { eligible: false, reason: `classification_exceeds:${policy.maxDataClassification}` };
            }
            return { eligible: true };
          } catch (error) {
            return { eligible: false, reason: error instanceof Error ? error.message : "policy_unresolved" };
          }
        }
      : undefined,
  });

  const {
    researchBundle,
    webResearch,
    marketplace,
    attachmentDirectory,
    hub,
    agent,
    workspaceStore,
    memoryDocuments,
    objectStorage,
    fileRepository,
    storageProtection,
    chatFiles,
    persistBusinessLogo,
    storageReconciler,
    coreBackendHealthCheck,
    npatiJwtSecret,
    authClient,
    apiKeysRepo,
    installationAuthStore,
    selfHosted,
    authProvider,
    aiPreferences,
    activeContextResolver,
    knowledgeRepo,
    memoryEngines,
    scopedMemory,
    guardrailPolicies,
  } = createCoreServices({ config, log: app.log, baseAiEngine, aiEngine });

  const {
    auditRepo,
    auditLogService,
    approvalDecisionAudit,
    verifyTimer: auditVerifyTimer,
    anchorTimer: auditAnchorTimer,
  } = createAuditServices({
    databaseUrl: config.databaseUrl,
    dataDirectory: config.dataDirectory,
    store: workspaceStore,
    systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE,
    log: app.log,
  });
  const approvalsRepo = config.databaseUrl ? new CompanyApprovalsRepository(config.databaseUrl, approvalDecisionAudit) : undefined;
  const emailInboxRepo = new EmailInboxRepository(config.databaseUrl);
  const emailAgentTools = new EmailAgentTools(emailInboxRepo);
  const browserCredentials = config.databaseUrl ? new BrowserCredentialsRepository(config.databaseUrl) : undefined;
  const browserTool = config.browserUseWorkerUrl && config.browserUseInternalToken
    ? new BrowserUseClient(config.browserUseWorkerUrl, config.browserUseInternalToken, browserCredentials, undefined, chatFiles)
    : undefined;
  const emailAttachmentStorage = objectStorage ? new EmailAttachmentStorage(objectStorage, fileRepository) : undefined;
  let projectSandbox: ProjectSandboxService | undefined = config.projectSandbox;

  const {
    dataBackendRepository,
    databaseProvisioner,
    dataProvider,
    dataBackendService,
    projectMigrationEngine,
    quotaService,
    promoteService,
    backupService,
    projectRedirectRepository,
    projectAuthService,
    backupTimer,
  } = createDataBackendServices({
    config,
    store: workspaceStore,
    log: app.log,
    getProject: (ctx, companyId, projectId) => projectService.get(ctx, companyId, projectId),
  });
  const projectService = new ProjectService(workspaceStore, async (context, project) => {
    if (project.sandboxId && !projectSandbox) throw new Error("Sandbox runner is required to remove this Project");
    await projectSandbox?.destroy(context, project);

    await dataBackendService?.detachProjectArtifacts(context, project.companyId, project.id).catch(() => undefined);
  }, async (context, companyId, projectId) => {

    if (!dataBackendService) return undefined;
    try {
      const project = await workspaceStore.getProject(context, companyId, projectId);
      const created = await dataBackendService.create(context, companyId, { name: `${project.name} data`.slice(0, 200) });
      const backendId = created.id;
      await dataBackendService.attach(context, companyId, projectId, backendId);
      return backendId;
    } catch (error) {
      app.log.warn({ err: error, companyId, projectId }, "project_data_backend_auto_attach_failed");
      return undefined;
    }
  });

  const projectWorkspaceRoot = config.projectWorkspaceRoot ?? path.join(config.dataDirectory ?? ".data", "project-workspaces");

  let mountedFolderFlags: MountedFolderFlagPort | null = null;
  const projectWorkspaceBases = new ProjectWorkspaceBaseResolver({
    root: projectWorkspaceRoot,
    mounts: {
      lookup: async (ctx, companyId, projectId) => workspaceStore.getProjectMountedFolder(ctx, companyId, projectId).catch(() => null),
    },
    flags: {
      isEnabled: async (ctx, flagKey, options) => {
        const flags = mountedFolderFlags;
        if (!flags) throw new Error("The mounted-folder feature flag service is not wired yet");
        return flags.isEnabled(ctx, flagKey, options);
      },
    },
    protectedRoots: config.dataDirectory ? [path.resolve(config.dataDirectory)] : [],
  });
  const projectWorkspace = new MountedWorkspaceProvider(projectService, { root: projectWorkspaceRoot, bases: projectWorkspaceBases, maxFileBytes: Number(process.env.NPATI_PROJECT_MAX_FILE_BYTES) || undefined, maxFiles: Number(process.env.NPATI_PROJECT_MAX_FILES) || undefined });

  const projectApiGatewayService = dataBackendRepository && databaseProvisioner
    ? new ProjectApiGatewayService(workspaceStore, dataBackendRepository, databaseProvisioner, projectAuthService, dataProvider, undefined, projectWorkspace, quotaService)
    : undefined;
  const dataStudioService = dataBackendRepository && databaseProvisioner && dataProvider && projectMigrationEngine
    ? new DataStudioUiService(workspaceStore, dataBackendRepository, dataProvider, projectMigrationEngine, projectApiGatewayService) : undefined;
  const agentDataStudioService = dataBackendRepository && dataProvider && projectMigrationEngine
    ? new AgentDataStudioService(workspaceStore, dataBackendRepository, dataProvider, projectMigrationEngine, projectWorkspace, projectAuthService, promoteService)
    : undefined;
  const projectTerminalEvents = new ProjectTerminalEventsRepository(projectService, config.databaseUrl ? (workspaceStore as any).pool : undefined);
  const sandboxRunnerUrl = process.env.NPATI_SANDBOX_RUNNER_URL;
  const sandboxRunnerSecret = process.env.NPATI_SANDBOX_RUNNER_SECRET;
  if (!projectSandbox && sandboxRunnerUrl && sandboxRunnerSecret) projectSandbox = new ProjectSandboxService(projectService, workspaceStore, projectWorkspace,
    new RemoteSandboxProvider(sandboxRunnerUrl, sandboxRunnerSecret, fetch, undefined,
      projectRuntimeMode({ ...process.env, ...(config.deploymentType ? { NPATI_DEPLOYMENT_TYPE: config.deploymentType } : {}) })), projectTerminalEvents, browserCredentials, {
    commandTimeoutMs: Number(process.env.NPATI_TERMINAL_TIMEOUT_MS) || undefined,
    installBuildTimeoutMs: Number(process.env.NPATI_TERMINAL_BUILD_TIMEOUT_MS) || undefined,
    outputLimitBytes: Number(process.env.NPATI_TERMINAL_OUTPUT_LIMIT_BYTES) || undefined,
    inactivityMs: Number(process.env.NPATI_SANDBOX_IDLE_MS) || undefined,
    syncMaxFiles: Number(process.env.NPATI_SANDBOX_SYNC_MAX_FILES) || undefined,
    syncMaxBytes: Number(process.env.NPATI_SANDBOX_SYNC_MAX_BYTES) || undefined,

    retentionMs: Number(process.env.NPATI_SANDBOX_RETENTION_MS) || undefined,
  }, projectApiGatewayService ? async (ctx, companyId, projectId) => {
    const project = await projectService.get(ctx, companyId, projectId);
    return project.dataBackendId ? projectApiGatewayService.getSandboxEnvironment(ctx, companyId, projectId) : {};
  } : undefined);
  const sandboxIdleTimer = projectSandbox ? setInterval(() => { void projectSandbox?.stopInactive(); }, 60_000) : undefined;
  sandboxIdleTimer?.unref();

  const sandboxRetentionTimer = projectSandbox ? setInterval(() => {
    void (async () => {
      try {
        const refs = await workspaceStore.listCodeProjectRefs({ companyId: null, limit: 500 });
        for (const ref of refs.items) {

          const project = await workspaceStore.getProjectForSystem(ref.companyId, ref.projectId).catch(() => null);
          if (project) await projectSandbox!.trackForRetention({ workspaceId: project.workspaceId, userId: project.createdBy, permissions: [] }, project);
        }
      } catch (error) {
        app.log.warn({ err: error }, "sandbox_retention_tracking_failed");
      }
      const result = await projectSandbox!.sweepRetention().catch((error) => {
        app.log.warn({ err: error }, "sandbox_retention_sweep_failed");
        return null;
      });
      if (result && result.destroyed > 0) app.log.info(result, "sandbox_retention_swept");
    })();
  }, 60_000) : undefined;
  sandboxRetentionTimer?.unref();
  const projectPreviewService = new ProjectPreviewService(projectService, workspaceStore, projectWorkspace, projectSandbox, process.env.NPATI_PREVIEW_SECRET);

  const codeWorkspaceRevisions = new CodeWorkspaceRevisionGuard({
    read: async ({ ctx, companyId, projectId }) => {
      const info = await projectWorkspace.info(ctx, companyId, projectId);
      return { currentRevision: info.currentRevision, currentBranch: info.currentBranch ?? null };
    },
  });

  let codeGitPolicyBoundary: { assertGitWriteAllowed: (ctx: AuthContext, companyId: string, input: GitWriteIntent) => Promise<unknown> } | null = null;
  let hostGitCredentialLease: HostGitCredentialPort | null = null;
  const projectGitService = new ProjectGitService(
    workspaceStore,
    projectService,

    projectWorkspaceBases,
    undefined,
    async (ctx, companyId, credentialId) => { const fields = await browserCredentials?.resolve(ctx, companyId, credentialId); const token = fields?.token; if (!token) throw new Error("GitHub token is unavailable in the Company vault"); return token; },
    undefined,
    {

      assertGitWriteAllowed: (ctx, companyId, input) => {
        const boundary = codeGitPolicyBoundary;
        if (!boundary) throw new Error("The protected-branch policy is unavailable; the git write is refused");
        return boundary.assertGitWriteAllowed(ctx, companyId, input);
      },

      workspaceRevisions: codeWorkspaceRevisions,

      ...(approvalsRepo
        ? {
            approvals: {
              consumeApproved: (ctx: AuthContext, companyId: string, id: string, params: { runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown> }) =>
                approvalsRepo!.consumeApproved(ctx, companyId, id, params as never),
            },
          }
        : {}),

      credentials: {
        acquire: async (input) => {
          const leases = hostGitCredentialLease;
          if (!leases) throw new Error("Git credential leasing is unavailable in this deployment");
          return leases.acquire(input);
        },
        revoke: async (leaseId, reason) => {
          await hostGitCredentialLease?.revoke(leaseId, reason);
        },
      },
    },
  );
  const projectImportService = new ProjectImportService(workspaceStore, projectService, projectWorkspace, projectSandbox, projectPreviewService, projectGitService, browserCredentials);

  const featureFlagService = new FeatureFlagService(workspaceStore, auditLogService, { enabledByDefault: selfHosted, allowPreGateRollout: selfHosted }, async (ctx, companyId) => {

    let stopped = 0;
    try {
      const projects = await projectService.list(ctx, companyId, true);
      for (const project of projects) {
        if (!project.sandboxId || !projectSandbox) continue;
        await projectSandbox.destroy(ctx, project).then((destroyed) => { if (destroyed) stopped += 1; }).catch(() => undefined);
      }
    } catch {  }
    return stopped;
  });

  mountedFolderFlags = featureFlagService;

  const sandboxImageConfig = sandboxImagePolicyConfig(process.env, config.dataDirectory);
  const sandboxImagePolicy = new SandboxImagePolicy(workspaceStore, {
    ...sandboxImageConfig,
    verifier: sandboxImageConfig.signer.identity && sandboxImageConfig.signer.issuer ? new CosignImageSignatureVerifier() : undefined,
    flags: featureFlagService,
    audit: auditLogService,
  });
  const codeService = new CodeService(workspaceStore, projectService, projectWorkspace, projectImportService, config.codeAgentLimits, auditLogService, featureFlagService);

  const codeReadTracker = new ReadTracker(resolveReadTrackerOptions());

  const codeTurnTracker = new CodeTurnTracker(resolveTurnTrackingOptions());
  const codeCheckpointPort = codeCheckpointPortFromGit({
    createCheckpoint: (ctx, companyId, projectId, input) => projectGitService.createCheckpoint(ctx, companyId, projectId, input),
    restoreCheckpoint: (ctx, companyId, projectId, checkpointId, restoreOptions) => projectGitService.restoreCheckpoint(ctx, companyId, projectId, checkpointId, restoreOptions),
    diff: (ctx, companyId, projectId, diffOptions) => projectGitService.diff(ctx, companyId, projectId, diffOptions),
    isLargeChange: (ctx, companyId, projectId) => projectGitService.isLargeChange(ctx, companyId, projectId),
  });
  const codeApprovalPort = approvalsRepo
    ? approvalsBackedPort(approvalsRepo, { defaultTtlMs: resolveApprovalPolicy().ttlMs })
    : undefined;
  const codeProjectWorkspaceWritePort = createProjectWorkspaceWritePort({
    writeFile: (ctx, companyId, projectId, filePath, content, expectedRevision) => projectWorkspace.writeFile(ctx, companyId, projectId, filePath, content, expectedRevision),
    createFile: (ctx, companyId, projectId, filePath, content) => projectWorkspace.createFile(ctx, companyId, projectId, filePath, content),
    editFile: (ctx, companyId, projectId, filePath, find, replacement, expectedRevision) => projectWorkspace.editFile(ctx, companyId, projectId, filePath, find, replacement, expectedRevision),
    moveFile: (ctx, companyId, projectId, from, to, expectedRevision) => projectWorkspace.moveFile(ctx, companyId, projectId, from, to, expectedRevision),
    deleteFile: (ctx, companyId, projectId, filePath) => projectWorkspace.deleteFile(ctx, companyId, projectId, filePath),
  });

  const sandboxWiring = createCodeSandboxWiring({
    config,
    log: app.log,
    app,
    systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE,
    agent,
    auditLogService,
    authProvider,
    browserCredentials,
    codeWorkspaceRevisions,
    projectSandbox,
    sandboxRunnerSecret,
    sandboxRunnerUrl,
    workspaceStore,
  });
  hostGitCredentialLease = sandboxWiring.hostGitCredentialLease;
  const { codeSandboxExecPort, secretLeases, runnerReadiness, egressEnforcement, runnerReadinessTimer, codeActivitySink, networkActivity, egressAllowlist, codeApprovalScope, policyDecisionActivity, codePrivilegedAudit, automationAllowedPermissions, codeMembership, codeProtectedBranches } = sandboxWiring;

  codeGitPolicyBoundary = {
    assertGitWriteAllowed: (ctx: AuthContext, companyId: string, input: GitWriteIntent) =>
      codeProtectedBranches.assertGitWriteAllowed(ctx, companyId, input),
  };

  const mcpToolPolicyStore = new McpToolPolicyStore(config.databaseUrl);
  app.addHook("onClose", async () => { await mcpToolPolicyStore.close(); });
  const mcpRuntimeCapabilities = new McpRuntimeCapabilityStore({ policies: mcpToolPolicyStore });
  const mcpRuntimeTransport = new McpRuntimeTransport({

    allowlist: () => resolveAllowlistForPhase("run", egressAllowlist),
  });

  let mcpIntegrationSourceForRuntime: McpIntegrationSource | null = null;

  const readRuntimeMcpManifest = (tenant: { workspaceId: string; companyId: string }) =>
    readMcpRuntimeManifest(mcpRuntimeCapabilities, tenant);

  const { policyEngine } = createCodePolicyWiring({
    config,
    log: app.log,
    systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE,
    agent,
    approvalsRepo,
    codeApprovalScope,
    codeProtectedBranches,
    egressEnforcement,
    featureFlagService,
    mcpRuntimeCapabilities,
    policyDecisionActivity,
    runnerReadiness,
    workspaceStore,
  });

  const codeProjectTrust = new CodeProjectTrustService({
    store: workspaceStore,
    audit: auditLogService
      ? {
          record: async (input) => {
            await auditLogService.record(
              { workspaceId: AUDIT_SYSTEM_WORKSPACE, userId: input.actor, permissions: [] } as AuthContext,
              {
                companyId: input.companyId, actor: input.actor, actorRole: "owner", action: input.action,
                resourceType: "code_project_trust", resourceId: input.resourceId,

                decision: input.decision === "deny" ? "denied" : "allowed",
                payload: { action: input.action, target: input.resourceId },
                metadata: input.metadata ?? {},
              },
            );
          },
        }
      : undefined,
  });

  const codeSessionModes = new CodeSessionModeService({
    store: workspaceStore,
    audit: auditLogService
      ? {
          record: async (input) => {
            await auditLogService.record(
              { workspaceId: AUDIT_SYSTEM_WORKSPACE, userId: input.actor, permissions: [] } as AuthContext,
              {
                companyId: input.companyId, actor: input.actor, actorRole: "owner", action: input.action,
                resourceType: "code_session", resourceId: input.resourceId,

                decision: input.decision === "deny" ? "denied" : "allowed",
                payload: { action: input.action, target: input.resourceId },
                metadata: input.metadata ?? {},
              },
            );
          },
        }
      : undefined,
    suggestionSink: async (suggestion) => { app.log.info(suggestion, "code_session_mode_suggestion"); },
    logger: app.log,
  });

  const codeSessionModeContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/sessions\/[^/]+\/mode(\/suggest)?$/.test(request.url.split("?")[0] ?? "")) return;
    codeSessionModeContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeSessionModeRoutes(app, {

    store: workspaceStore,
    service: codeSessionModes,
    getAuthContext: (request) => codeSessionModeContexts.get(request as object) ?? null,
  });

  const codeSessionWiring = createCodeSessionWiring({
    config,
    log: app.log,
  });
  const { codeMembershipContexts } = codeSessionWiring;
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/(?:members(?:\/|$)|protected-branches(?:\/|$))/.test(request.url.split("?")[0] ?? "")) return;
    codeMembershipContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeMembershipRoutes(app, {
    service: codeMembership,
    protectedBranches: codeProtectedBranches,
    getAuthContext: (request) => codeMembershipContexts.get(request as object) ?? null,
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),

    findInviteCompanyId: async (tokenHash) =>
      (await workspaceStore.findCompanyInviteByTokenHash(tokenHash))?.companyId ?? null,
    logger: app.log,
  });

  const codeDataPolicyAudit = codePrivilegedAudit
    ? {
        record: async (input: {
          action: string;
          actor: string;
          companyId: string | null;
          resourceType: string;
          resourceId: string;
          metadata?: Record<string, unknown>;
        }) => {
          await codePrivilegedAudit.record({
            action: input.action,
            actor: input.actor,

            companyId: input.companyId ?? AUDIT_SYSTEM_WORKSPACE,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            metadata: input.metadata ?? {},
          });
        },
      }
    : undefined;
  const codeDataPolicyStoreService = new ProviderDataPolicyService({
    store: workspaceStore,
    ...(codeDataPolicyAudit ? { audit: codeDataPolicyAudit } : {}),
  });

  const invalidationWrappedDataPolicyService = new Proxy(codeDataPolicyStoreService, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      if (!/^(?:upsert|update|create|delete|set|revoke|grant)/.test(property)) {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return async (...args: unknown[]) => {
        const result = await (value as (...args: unknown[]) => unknown).apply(target, args);
        refreshOutboundPolicySnapshot?.();
        return result;
      };
    },
  });

  engineDataPolicyResolver = createEnginePolicyResolver(workspaceStore as unknown as ProviderDataPolicyLookupPort);

  outboundPolicySnapshot = new OutboundPolicySnapshot(workspaceStore as unknown as ProviderDataPolicyLookupPort);
  const refreshOutboundSnapshot = () => {
    void outboundPolicySnapshot?.refresh().catch((error) => {
      app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "outbound_policy_snapshot_refresh_failed");
    });
  };
  refreshOutboundPolicySnapshot = refreshOutboundSnapshot;
  setOutboundGuard(createOutboundGuard({
    resolvePolicy: (channel, context) => {
      if (context?.companyId && context.companyId !== outboundPolicySnapshot?.getActiveContext()?.companyId) {
        outboundPolicySnapshot?.setActiveContext({
          companyId: context.companyId,
          ...(context.projectId ? { projectId: context.projectId } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.dataClassification ? { dataClassification: context.dataClassification } : {}),
        });
        refreshOutboundSnapshot();
      } else if (context?.companyId && outboundPolicySnapshot) {
        outboundPolicySnapshot.setActiveContext({
          companyId: context.companyId,
          ...(context.projectId ? { projectId: context.projectId } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.dataClassification ? { dataClassification: context.dataClassification } : {}),
        });
      }
      const resolution = outboundPolicySnapshot
        ? resolveOutboundPolicyFromSnapshot(outboundPolicySnapshot, channel)
        : null;
      if (!resolution) return null;
      if (resolution.kind === "policy") return resolution.resolved.policy;

      return { code: resolution.code, reason: resolution.reason };
    },
    resolveProjectClassification: (_channel, context) => context?.dataClassification,
    record: (event) => { app.log.info(event, "outbound_decision"); },
  }));
  refreshOutboundSnapshot();
  const outboundSnapshotTimer = setInterval(refreshOutboundSnapshot, 60_000);
  outboundSnapshotTimer.unref?.();
  const codeDataPolicy = new ProviderDataPolicyAdminService({
    store: workspaceStore,
    policies: invalidationWrappedDataPolicyService,
    resolveRole: (context, companyId) => codeMembership.resolveRoleForUser(context, companyId),

    projectClassification: {
      readProjectClassification: async (context, companyId, projectId) => {
        const project = await workspaceStore.getProject(context, companyId, projectId);
        return (project?.dataClassification as ProviderDataClassification | undefined) ?? null;
      },
    },
    rbac: { ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}), logger: app.log },
    activity: { record: (event) => { app.log.info(event, "provider_policy_decision"); } },
    logger: app.log,
  });
  const codeDataPolicyContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/data-policy(?:\/|$)/.test(request.url.split("?")[0] ?? "")) return;
    codeDataPolicyContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeDataPolicyRoutes(app, {
    service: codeDataPolicy,
    getAuthContext: (request) => codeDataPolicyContexts.get(request as object) ?? null,
  });

  const codeGroupsForAgent = (tools: readonly string[] | undefined): string[] => {
    const groups = new Set<string>();
    for (const tool of tools ?? []) {
      const group = groupForCapability(tool);
      if (group) groups.add(group);
    }
    return [...groups];
  };

  const enrichedPolicyEngineWiring = createEnrichedPolicyEngineWiring({
    config,
    log: app.log,
    policyEngine,
    agent,
    codeGroupsForAgent,
    codeProjectTrust,
    workspaceStore,
  });
  const { enrichedPolicyEngine } = enrichedPolicyEngineWiring;

  const mcpRunPath = createMcpRuntimeRunPath({
    store: mcpRuntimeCapabilities,
    transport: mcpRuntimeTransport,
    source: () => mcpIntegrationSourceForRuntime,

    flags: featureFlagService,

    policy: enrichedPolicyEngine,

    activity: activitySinkForKind(codeActivitySink, "run_activity"),
    logger: { warn: (message, meta) => app.log.warn(meta ?? {}, message) },
  });
  const discoverRuntimeMcpCapabilities = (ctx: AuthContext, companyId: string) =>
    mcpRunPath.discover(ctx, companyId);

  const shellSandboxPortWiring = createShellSandboxPortWiring({
    config,
    log: app.log,
    agent,
    projectSandbox,
  });
  const { shellSandboxPort } = shellSandboxPortWiring;

  const processSandboxPortWiring = createProcessSandboxPortWiring({
    config,
    log: app.log,
    projectSandbox,
  });
  const { processSandboxPort } = processSandboxPortWiring;
  const trackedProcesses = projectSandbox && workspaceStore.codeProcesses ? new CodeAsyncProcessService({
    store: workspaceStore.codeProcesses, flags: featureFlagService,
    session: (ctx, companyId, sessionId) => workspaceStore.getCodeSession(ctx, companyId, sessionId),
    run: (companyId, runId) => workspaceStore.getCodeRunState(companyId, runId),
    port: {
      supported: (ctx, companyId, projectId) => projectSandbox.supportsTrackedProcesses(ctx, companyId, projectId),
      start: async (ctx, input, op, beforeStart) => projectSandbox.startTrackedProcess(ctx, input.companyId, { ...input, agentId: "system", processId: op.processId }, beforeStart,
        await featureFlagService.isEnabled(ctx, "code.async_collect_barrier", { companyId: input.companyId })),
      status: async (ctx, op) => await projectSandbox.process(ctx, op.companyId, { projectId: op.projectId, sandboxId: op.sandboxId ?? undefined, agentId: "system", processId: op.processId, action: "status" }) as { status: string; exitCode: number | null },
      stop: async (ctx, op) => await projectSandbox.process(ctx, op.companyId, { projectId: op.projectId, sandboxId: op.sandboxId ?? undefined, agentId: "system", processId: op.processId, action: "stop" }) as { status: string; exitCode: number | null },
      output: (ctx, op, offset) => projectSandbox.trackedOutput(ctx, op.companyId, { projectId: op.projectId, sandboxId: op.sandboxId ?? undefined, agentId: "system", processId: op.processId }, offset),
      sync: (ctx, op) => projectSandbox.syncTrackedProcess(ctx, op),
    },
  }) : undefined;
  if (trackedProcesses) {
    projectSandbox!.setProcessCleanupGuard({ acquire: (_ctx, project) => trackedProcesses.cleanupGuard(project.companyId, project.id),
      prepare: (ctx, project) => trackedProcesses.legacyPreparationGuard(ctx, project.companyId, project.id) });
    app.addHook("onClose", async () => { await trackedProcesses.close(); });
  }
  const codeProcessManager = new CodeProcessManager({
    sandbox: processSandboxPort, flags: featureFlagService, audit: auditLogService, leases: secretLeases,
  });
  codeProcessManager.tracked = trackedProcesses;
  const codeShellRuntime = new CodeShellRuntime({
    processes: codeProcessManager,
    sandbox: shellSandboxPort, flags: featureFlagService, audit: auditLogService,
    leases: secretLeases, limits: config.codeAgentLimits, policy: enrichedPolicyEngine,
  });

  let codeUserQuestionReaperPort: ReturnType<typeof createCodeUserQuestionReaperPort> | null = null;

  let mcpApprovalPauseRelease:
    | ((input: { companyId: string; runId: string; approvalId: string; reason: McpApprovalReleaseReason; answeredBy?: string }) => Promise<unknown>)
    | null = null;

  const codeDataRetention = new CodeDataRetention({
    ...(workspaceStore.codeDataLifecycle ? { lifecycle: workspaceStore.codeDataLifecycle } : {}),
    limits: {
      toolResultRetentionDays: config.codeAgentLimits?.toolResultRetentionDays ?? DEFAULT_CODE_AGENT_LIMITS.toolResultRetentionDays,
      transcriptRetentionDays: config.codeAgentLimits?.transcriptRetentionDays ?? DEFAULT_CODE_AGENT_LIMITS.transcriptRetentionDays,
    },
  });

  const ports = createCodePortsWiring({
    config,
    log: app.log,
    approvalsRepo,
    codeActivitySink,
    codeDataRetention,
    codeProcessManager,
    codeProjectTrust,
    codeSandboxExecPort,
    codeShellRuntime,
    codeUserQuestionReaperPort,
    featureFlagService,
    mcpApprovalPauseRelease,
    projectSandbox,
    projectService,
    projectWorkspace,
    secretLeases,
    trackedProcesses,
  });
  const { codeReaper, codeShellRuntimePort, codeVerifyRunnerPort, CODE_DEPS_MANIFESTS, readWorkspaceText, codeInstructionsLoader, codeHooksService } = ports;

  const codeCommandIds = ["review", "explain", "test", "fix"] as const;

  const codeToolWiring = createCodeToolWiring({
    config,
    log: app.log,
    CODE_DEPS_MANIFESTS,
    codeActivitySink,
    codeCommandIds,
    codeInstructionsLoader,
    getCodeRunEnvironment: () => codeRunEnvironment,
    codeShellRuntimePort,
    featureFlagService,
    providerDataGuardInstance,
    readWorkspaceText,
  });
  const { codeCommandRegistry, codeSkillsService, codeDepsPort, describeCodeRunForPullRequest } = codeToolWiring;

  let codeToolRuntimeRef: CodeToolRuntime | undefined;
  let codingAgentRunnerRef: CodingAgentRunner | undefined;

  let codeSubagentOperationsRef: (() => CodeSubagentOperationService) | undefined;

  let subagentChildRunnerWithAck: CodeSubagentDetachedRunner | undefined;

  const codeToolRuntimeWiring = createCodeToolRuntimeWiring({
    config,
    log: app.log,
    approvalsRepo,
    auditLogService,
    codeActivitySink,
    codeApprovalPort,
    codeApprovalScope,
    codeCheckpointPort,
    codeDepsPort,
    codeHooksService,
    codeProjectWorkspaceWritePort,
    codeProtectedBranches,
    codeReadTracker,
    codeSandboxExecPort,
    codeService,
    codeShellRuntimePort,
    codeSubagentOperationsRef,
    codeToolRuntimeRef,
    codeTurnTracker,
    codeVerifyRunnerPort,
    codeWorkspaceRevisions,
    describeCodeRunForPullRequest,
    enrichedPolicyEngine,
    featureFlagService,
    projectGitService,
    projectService,
    projectWorkspace,
    subagentChildRunnerWithAck,
    trackedProcesses,
    workspaceStore,
  });
  const { codeToolRuntime } = codeToolRuntimeWiring;
  codeToolRuntimeRef = codeToolRuntime;

  try {
    assertManifestConsistent();
    const manifest = currentToolManifest();
    void workspaceStore.publishCodeToolManifest(
      { workspaceId: AUDIT_SYSTEM_WORKSPACE, userId: "system", permissions: ["workspace:read"] },
      { version: manifest.version, tools: manifest.tools, checksum: manifest.checksum },
    ).catch(() => undefined);
  } catch (error) { app.log.error({ err: error }, "code_tool_manifest_inconsistent"); }
  const projectFileLeaseManager = new ProjectFileLeaseManager();
  const projectDeployService = new ProjectDeployService(
    workspaceStore,
    projectService,
    projectGitService,
    browserCredentials ? async (ctx, companyId, credentialId) => {
      return browserCredentials.resolve(ctx, companyId, credentialId);
    } : undefined
  );
  const projectBrowserQaService = new ProjectBrowserQaService(
    projectService,
    workspaceStore,
    projectPreviewService,
    projectSandbox,
  );
  const companyToolRuntime = new CompanyToolRuntime(aiEngine, researchBundle?.provider, attachmentDirectory, chatFiles,knowledgeRepo,new WasmExecSandbox(), emailAgentTools, browserTool, projectWorkspace, workspaceStore, projectSandbox, projectPreviewService, projectGitService, projectFileLeaseManager, projectDeployService, projectBrowserQaService, agentDataStudioService, projectApiGatewayService);
  const knowledgeProcessor = knowledgeRepo && objectStorage ? new CompanyKnowledgeProcessor(knowledgeRepo,fileRepository,objectStorage,aiEngine,memoryEngines) : undefined;
  const companyRuntime = new CompanyDelegationRuntime(workspaceStore, aiEngine, config.companyRunTimeoutMs, companyToolRuntime,
    knowledgeProcessor ? async (ctx,companyId,query,scope)=>{
      const [knowledge,scoped]=await Promise.all([
        knowledgeProcessor.retrieveContext(ctx,companyId,query),
        scopedMemory.retrieveMemories({
          companyId,
          tenantId:ctx.workspaceId,
          apiKeyId:scope?.apiKeyId??ctx.apiKeyId,
          sessionId:scope?.sessionId,
          query,
          limit:12,
        }),
      ]);
      return {chunks:knowledge.chunks,memories:[...knowledge.memories,...scoped.map(item=>({content:item.title+": "+item.content}))]};
    } : undefined,undefined,undefined,(ctx,companyId)=>guardrailPolicies.get(ctx,companyId),approvalsRepo,auditRepo,
    async (ctx) => (await memoryDocuments.getUserDocument(ctx))?.markdown,
    async (ctx) => {
      const prefs = await aiPreferences.get(ctx);
      const selected = prefs.addedModels.find((model) => model.id === prefs.routing.defaultModelId);
      return selected && isChatCapableModel(selected) ? [selected] : [];
    }, true);

  const automationWiring = createEmailAutomationWiring({
    config,
    log: app.log,
    getAutomationsRepo: () => automationsRepo,
    agent,
    agentDataStudioService,
    codeVerifyRunnerPort,
    companyRuntime,
    dataBackendRepository,
    dataBackendService,
    dataProvider,
    dataStudioService,
    emailAgentTools,
    emailAttachmentStorage,
    projectApiGatewayService,
    projectAuthService,
    projectBrowserQaService,
    projectDeployService,
    projectFileLeaseManager,
    projectGitService,
    projectMigrationEngine,
    projectPreviewService,
    projectRedirectRepository,
    projectSandbox,
    projectService,
    projectWorkspace,
    workspaceStore,
  });
  const { projectOrchestrator, companyRunQueue, emailAutomationHooks } = automationWiring;
  const emailInboxWorker = new EmailInboxWorker(emailInboxRepo, aiEngine, auditRepo, emailAutomationHooks, undefined, emailAttachmentStorage);
  const knowledgeQueue = knowledgeRepo && config.redisUrl ? new CompanyKnowledgeQueue(config.redisUrl) : undefined;
  const automationsRepo = new CompanyAutomationsRepository(config.databaseUrl);
  const messagingIntegrationsRepo = new MessagingIntegrationsRepository(config.databaseUrl);
  const whatsappMessagingAdapter = new WhatsAppMessagingAdapter(messagingIntegrationsRepo);
  const discordMessagingAdapter = new DiscordMessagingAdapter(messagingIntegrationsRepo);
  const slackMessagingAdapter = new SlackMessagingAdapter(messagingIntegrationsRepo);
  const emailMessagingAdapter = new EmailMessagingAdapter(emailInboxRepo, () => emailInboxWorker.triggerTick());
  const messagingGateway = new MessagingGateway().register(new TelegramMessagingAdapter()).register(whatsappMessagingAdapter).register(discordMessagingAdapter).register(slackMessagingAdapter).register(emailMessagingAdapter);
  const messagingScopeRouter = new MessagingScopeRouter(workspaceStore, messagingIntegrationsRepo);

  const { executeAutomation } = createAutomationExecutor({
    config,
    log: app.log,
    agent,
    automationAllowedPermissions,
    browserCredentials,
    companyRuntime,
    emailInboxRepo,
  });

  const messagingNotificationsWiring = createMessagingNotificationsWiring({
    config,
    log: app.log,
    messagingGateway,
    messagingIntegrationsRepo,
  });
  const { notifyMessagingConnections } = messagingNotificationsWiring;
  const notifyAutomation = async (automation: import("./automations-repository").CompanyAutomation, status: "completed" | "failed", detail: string) => {
    await notifyMessagingConnections({
      workspaceId: automation.workspaceId,
      userId: automation.userId,
      companyId: automation.companyId,
      agentId: automation.agentId,
      kind: "automation",
      title: `Automation ${status}: ${automation.name}`,
      detail,
    });
  };
  const runAutomation = async (automation: import("./automations-repository").CompanyAutomation, executionKey: string) => {
    try {
      const result = await executeAutomation(automation, executionKey);
      await notifyAutomation(automation, "completed", result.result);
      return result;
    } catch (error) {
      await notifyAutomation(automation, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const automationScheduler = new AutomationScheduler(
    automationsRepo,
    (automation) => runAutomation(automation, `automation:${automation.id}:${automation.nextRunAt}`),
  );
  const contentLibrary = new ContentLibraryStore(workspaceStore);
  const integrationsRepo = new IntegrationsRepository(config.databaseUrl);

  mcpIntegrationSourceForRuntime = configuredIntegrationsFrom(integrationsRepo);
  const getAIContext = async (auth: AuthContext) => {
    const preferences = await aiPreferences.get(auth);
    let manualModel = preferences.routing.mode === "manual" && preferences.routing.defaultModelId
      ? preferences.routing.defaultModelId
      : undefined;
    if (manualModel) {
      const added = preferences.addedModels.find((m) => m.id === manualModel);
      if (added ? !isChatCapableModel(added) : isNonChatSpecialtyModel({ id: manualModel })) {
        manualModel = undefined;
      }
    }
    const primaryModel = manualModel ?? preferences.routing.automaticModel ?? "auto";
    const fallbackModel = manualModel ? undefined : (preferences.routing.fallbackOnFailure ? "auto/smart" : undefined);
    return {
      mode: preferences.routing.mode,
      model: primaryModel,
      fallbackModel: fallbackModel !== primaryModel ? fallbackModel : undefined,
      compression: preferences.routing.compression,
    };
  };
  const priorityTierFor = (auth: AuthContext): PriorityTier => auth.permissions.includes("admin:all") ? "enterprise" : auth.permissions.includes("workspace:write") ? "pro" : "free";
  const admissionFor = (auth: AuthContext) => ({ tenantId: auth.workspaceId, tier: priorityTierFor(auth), queueTimeoutMs: 30_000 });

  const chatOrchestration = createChatOrchestration({
    config,
    log: app.log,
    admissionFor,
    agent,
    aiEngine,
    aiPreferences,
    apiKeysRepo,
    auditRepo,
    automationsRepo,
    browserCredentials,
    chatFiles,
    companyRunQueue,
    companyRuntime,
    contentLibrary,
    dataBackendService,
    emailAttachmentStorage,
    emailInboxRepo,
    emailInboxWorker,
    fileRepository,
    getAIContext,
    guardrailPolicies,
    hub,
    knowledgeRepo,
    memoryDocuments,
    objectStorage,
    persistBusinessLogo,
    researchBundle,
    runAutomation,
    scopedMemory,
    webResearch,
    workspaceStore,
  });
  const { persistAutomaticCompanyMemory, beforeDeleteCompany, runBusinessMessage, runNeutralMessage } = chatOrchestration;

  app.register(cors, { origin: config.webOrigin ?? true });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthenticationError) {
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message },
      });
    }
    if(error instanceof SecurityPolicyViolation)return reply.code(error.status).send({error:{code:error.code,reasonCode:error.reasonCode,message:error.message}});
    return reply.send(error);
  });

  registerPlatformBaseRoutes(app, {
    config,
    log: app.log,
    activeSessionRegistry,
    agentDataStudioService,
    aiEngine,
    aiPreferences,
    authClient,
    authProvider,
    backupService,
    beforeDeleteCompany,
    chatFiles,
    codeService,
    codeToolRuntime,
    dataBackendRepository,
    dataBackendService,
    dataProvider,
    dataStudioService,
    databaseProvisioner,
    featureFlagService,
    installationAuthStore,
    marketplace,
    npatiJwtSecret,
    projectApiGatewayService,
    projectAuthService,
    projectGitService,
    projectImportService,
    projectPreviewService,
    projectSandbox,
    projectService,
    projectTerminalEvents,
    projectWorkspace,
    promoteService,
    quotaService,
    sandboxImagePolicy,
    workspaceStore,
  });

  const codeRoutes = registerCodeRouteWiring(app, {
    config,
    log: app.log,
    systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE,
    activeContextResolver,
    agent,
    aiEngine,
    aiPreferences,
    auditLogService,
    authProvider,
    codeActivitySink,
    codeApprovalScope,
    codeCommandRegistry,
    codeDataPolicy,
    codeDataPolicyStoreService,
    codeHooksService,
    codeInstructionsLoader,
    codeMembership,
    codePrivilegedAudit,
    codeProcessManager,
    codeReaper,
    codeService,
    codeSkillsService,
    codeToolRuntime,
    codeTurnTracker,
    featureFlagService,
    mcpRunPath,
    notifyMessagingConnections,
    projectGitService,
    projectPreviewService,
    projectSandbox,
    projectService,
    projectWorkspace,
    providerDataGuardInstance,
    readRuntimeMcpManifest,
    sandboxImagePolicy,
    trackedProcesses,
    workspaceStore,
  });
  const { codeRbacForRun, codeRunStateLog, codeSessionInbox, codeRunCancellation, codeSessionRunExecutor, codeRunQueueLimits, codeRunAdmission, codeBackgroundRuns, codeErasureContexts, codeDataErasure, codeRunEnvironment } = codeRoutes;
  codingAgentRunnerRef = codeRoutes.codingAgentRunnerRef;
  codeSubagentOperationsRef = codeRoutes.codeSubagentOperationsRef;
  subagentChildRunnerWithAck = codeRoutes.subagentChildRunnerWithAck;

  const platformRoutes = registerPlatformRoutes(app, {
    config,
    log: app.log,
    systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE,
    agent,
    aiEngine,
    apiKeysRepo,
    approvalsRepo,
    auditLogService,
    auditRepo,
    authProvider,
    automationScheduler,
    automationsRepo,
    browserCredentials,
    browserTool,
    chatFiles,
    codeActivitySink,
    codeApprovalScope,
    codeDataErasure,
    codeErasureContexts,
    codeInstructionsLoader,
    codePrivilegedAudit,
    codeProjectTrust,
    codeRbacForRun,
    codeRunStateLog,
    codeService,
    codeSessionModes,
    companyRunQueue,
    companyRuntime,
    companyToolRuntime,
    contentLibrary,
    egressAllowlist,
    egressEnforcement,
    emailAttachmentStorage,
    emailAutomationHooks,
    emailInboxRepo,
    emailInboxWorker,
    featureFlagService,
    fileRepository,
    guardrailPolicies,
    integrationsRepo,
    knowledgeProcessor,
    knowledgeQueue,
    knowledgeRepo,
    mcpRuntimeCapabilities,
    mcpToolPolicyStore,
    memoryDocuments,
    messagingGateway,
    messagingIntegrationsRepo,
    messagingScopeRouter,
    networkActivity,
    objectStorage,
    persistAutomaticCompanyMemory,
    persistBusinessLogo,
    projectBrowserQaService,
    projectDeployService,
    projectWorkspaceRoot,
    runAutomation,
    runNeutralMessage,
    scopedMemory,
    workspaceStore,
  });
  codeUserQuestionReaperPort = platformRoutes.codeUserQuestionReaperPort;
  mcpApprovalPauseRelease = platformRoutes.mcpApprovalPauseRelease;
  app.addHook("onClose", async () => { automationScheduler.stop(); codeReaper.stop(); if (sandboxIdleTimer) clearInterval(sandboxIdleTimer); if (sandboxRetentionTimer) clearInterval(sandboxRetentionTimer); if (backupTimer) clearInterval(backupTimer); if (auditVerifyTimer) clearInterval(auditVerifyTimer); if (auditAnchorTimer) clearInterval(auditAnchorTimer); if (runnerReadinessTimer) clearInterval(runnerReadinessTimer); storageReconciler?.stop(); await Promise.all([whatsappMessagingAdapter.shutdown(),discordMessagingAdapter.shutdown(),slackMessagingAdapter.shutdown()]); await emailInboxWorker.stop(); await emailInboxRepo.close(); await browserCredentials?.close(); await companyRunQueue?.close(); await knowledgeQueue?.close(); await knowledgeRepo?.close(); await automationsRepo?.close(); await approvalsRepo?.close(); await integrationsRepo?.close(); await messagingIntegrationsRepo.close(); await auditRepo?.close(); await chatFiles?.close(); await storageProtection.close();  await workspaceStore.close?.(); });
  app.addHook("onReady", async () => {
    await workspaceStore.initialize();
    await whatsappMessagingAdapter.restore();
    await discordMessagingAdapter.restore();
    await slackMessagingAdapter.restore();
    await emailInboxRepo.encryptLegacyAccountCredentials();
    await objectStorage?.initialize();
    if (chatFiles) { const legacy = await chatFiles.migrateLegacy(); if (legacy.failed) app.log.warn(legacy,"Some legacy attachments could not be migrated"); await chatFiles.cleanupPending(); }
    storageReconciler?.start();

    void codeReaper.run().catch(() => undefined);
    codeReaper.start((summary) => { app.log.warn({ skipped: summary.skipped, errors: summary.errors }, "code_reaper_attention"); });
    emailInboxWorker.start();
    automationScheduler.start();
  });

  registerHealthRoutes(app, {
    aiEngine,
    hub,
    store: workspaceStore,
    researchBundle,
    objectStorage,
    redisHealthCheck,
    coreBackendHealthCheck,
  });

  registerCapabilityRoutes(app, {
    config,
    log: app.log,
    agent,
    authProvider,
    discoverRuntimeMcpCapabilities,
    featureFlagService,
    mcpRuntimeCapabilities,
    workspaceStore,
  });

  registerMiscRoutes(app, {
    config,
    log: app.log,
    activeContextResolver,
    authProvider,
    chatFiles,
    researchBundle,
    workspaceStore,
  });

  registerChatRoutes(app, {
    config,
    log: app.log,
    activeChatStreams,
    activeContextResolver,
    agent,
    authProvider,
    companyRuntime,
    getAIContext,
    marketplace,
    persistAutomaticCompanyMemory,
    projectOrchestrator,
    runBusinessMessage,
    runNeutralMessage,
    workspaceStore,
    boundedResponseChunks,
  });

  registerChatStreamRoutes(app, {
    config,
    log: app.log,
    boundedResponseChunks,
    activeChatStreams,
    activeContextResolver,
    activeSessionRegistry,
    agent,
    aiPreferences,
    authProvider,
    codeBackgroundRuns,
    codeRunAdmission,
    codeRunCancellation,
    codeRunQueueLimits,
    codeService,
    codeSessionInbox,
    codeSessionRunExecutor,
    companyRuntime,
    featureFlagService,
    getAIContext,
    marketplace,
    notifyMessagingConnections,
    persistAutomaticCompanyMemory,
    projectOrchestrator,
    projectPreviewService,
    projectSandbox,
    projectService,
    runBusinessMessage,
    runNeutralMessage,
    workspaceStore,
  });

  return app;
}
