import cors from "@fastify/cors";
import Fastify from "fastify";
import path from "node:path";
import { OmniRouteEngine, type OmniRouteMarketplace, type AIEngine } from "@npati/omniroute-adapter";
import { type WebResearchService } from "@npati/web-research";
import { type ServiceHealth } from "@npati/shared";
import { type AuthContext, type WorkspaceStore } from "@npati/workspace";
import { AuthenticationError, NpatiBackendAuthProvider, type AuthProvider } from "./auth";
import { type NpatiAuthClient } from "@npati/hub-connector";
import { ProjectService } from "./project-service";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { ProjectWorkspaceBaseResolver, type MountedFolderFlagPort } from "./workspace-base-resolver";
import { ProjectSandboxService } from "./project-sandbox-service";
import { ProjectGitService, type HostGitCredentialPort } from "./project-git-service";
import { ProjectImportService } from "./project-import-service";
import { CodeService } from "./code-service";
import { type CodingAgentRunner } from "./coding-agent-runner";
import { type createCodeUserQuestionReaperPort } from "./code-ask-user-reaper";
import { SandboxImagePolicy, sandboxImagePolicyConfig } from "./sandbox-image-policy";
import { CosignImageSignatureVerifier } from "./sandbox-image-signature";
import { type CodeSubagentOperationService, type CodeSubagentDetachedRunner } from "./code-subagent-operations";
import { CodeWorkspaceRevisionGuard } from "./code-workspace-revision";
import { FeatureFlagService } from "./feature-flags";
import { type CodeAgentLimits } from "./code-agent-config";
import { ProjectFileLeaseManager } from "./project-file-lock";
import { ProjectPreviewService } from "./project-preview-service";
import { registerReliabilityAndOperationsRoutes, globalAdmissionQueue } from "./reliability-and-operations-routes";
import { createProductionResilientAIEngine } from "./production-resilient-ai-engine";
import { createProviderDataGuard } from "./provider-data-guard";
import { type createEnginePolicyResolver, type OutboundPolicySnapshot } from "./provider-data-policy-resolver";
import { BrowserCredentialsRepository } from "./browser-credentials-repository";
import { BrowserUseClient } from "./browser-tool";
import { CompanyApprovalsRepository } from "./approvals-repository";
import { type McpApprovalReleaseReason } from "./mcp-approval";
import { type McpIntegrationSource } from "./mcp-runtime-transport";
import { EmailInboxRepository } from "./email-inbox-repository";
import { EmailAgentTools } from "./email-agent-tools";
import { EmailAttachmentStorage } from "./email-attachment-storage";
import { type ObjectStorage } from "./object-storage";
import { type FileMetadataRepository } from "./file-metadata";
import { type StorageProtection } from "./storage-protection";
import { type StorageReconcilerOptions } from "./storage-reconciler";
import { SecurityPolicyViolation } from "./security-guardrails";
import { type ActiveSessionRegistry } from "./distributed-session-registry";
import { isSpreadsheetEditRequest, mapColumnDirectiveFromProposal } from "./chat-text-directives";
import type { AuditLogService } from "./audit-log";
import { createAuditServices } from "./audit-services";
import { createCoreServices } from "./core-services";
import { createDataBackendServices } from "./data-backend-services";
import { registerPlatformRoutes } from "./platform-routes";
import { registerPlatformBaseRoutes } from "./platform-base-routes";
import { registerCodeRouteWiring } from "./code-route-wiring";
import { ProjectLifecycleService } from "./project-lifecycle-service";
import { createCompanyCodingDelegation } from "./code-company-delegation";
import { createRedisHealthWiring } from "./redis-health-wiring";
import { registerWebFrontend, rewriteBrowserApiUrl } from "./web-frontend";
import { createAppSandboxServices } from "./app-sandbox-services";
import { createAppCodeEngineWiring } from "./app-code-engine-wiring";
import { createAppProcessAndShellWiring } from "./app-process-and-shell-wiring";
import { createAppCodeToolRuntimeWiring } from "./app-code-tool-runtime-wiring";
import { createAppCompanyAutomationsWiring } from "./app-company-automations";
import { createAppChatOrchestration } from "./app-chat-orchestration";
import { registerAppRoutesAndLifecycle } from "./app-routes-and-lifecycle";
import type { GitWriteIntent } from "./code-git-write-policy";
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
  webDistDirectory?: string;
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
  auditLogService?: AuditLogService;
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
  const app = Fastify({ rewriteUrl: rewriteBrowserApiUrl, logger: process.env.NODE_ENV !== "test" ? {redact:{paths:["req.headers.authorization","req.headers.x-npati-api-key","req.body.password","req.body.apiKey","req.body.token","req.body.imapConfig.password","req.body.smtpConfig.password","req.body.imapConfig.accessToken","req.body.smtpConfig.accessToken","req.body.imapConfig.refreshToken","req.body.smtpConfig.refreshToken","req.body.imapConfig.clientSecret","req.body.smtpConfig.clientSecret"],censor:"[REDACTED]"}} : false, bodyLimit: 30 * 1024 * 1024 });

  if (config.webDistDirectory) registerWebFrontend(app, config.webDistDirectory);

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
    codePreferences,
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
    auditLogService: config.auditLogService,
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

  const sandboxServices = createAppSandboxServices({
    config,
    log: app.log,
    workspaceStore,
    projectService,
    projectWorkspace,
    dataBackendRepository,
    databaseProvisioner,
    dataProvider,
    projectAuthService,
    quotaService,
    projectMigrationEngine,
    promoteService,
    browserCredentials,
    initialProjectSandbox: config.projectSandbox,
  });
  const {
    projectApiGatewayService,
    dataStudioService,
    agentDataStudioService,
    projectTerminalEvents,
    sandboxRunnerSecret,
    sandboxRunnerUrl,
    sandboxIdleTimer,
    sandboxRetentionTimer,
  } = sandboxServices;
  projectSandbox = sandboxServices.projectSandbox;
  const projectPreviewService = new ProjectPreviewService(
    projectService,
    workspaceStore,
    projectWorkspace,
    projectSandbox,
    process.env.NPATI_PREVIEW_SECRET,
    async (ctx, companyId, projectId, origin) => {
      try {
        await dataStudioService?.registerPreviewCorsOrigin(ctx, companyId, projectId, "dev", origin);
      } catch (err) {
        console.warn(`[onPreviewStart] Failed to register preview CORS origin ${origin} for project ${projectId}:`, err);
      }
    },
  );

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

  const featureFlagService = new FeatureFlagService(workspaceStore, auditLogService, { enabledByDefault: config.deploymentType !== undefined, allowPreGateRollout: selfHosted }, async (ctx, companyId) => {

    let stopped = 0;
    try {
      const sessions = await workspaceStore.listCodeSessions(ctx, companyId, undefined, { includeArchived: true });
      for (const session of sessions) {
        if (!["active", "paused", "awaiting_approval", "suspended_by_flag"].includes(session.status)) continue;
        codeRunCancellation.requestSessionCancel({ sessionId: session.id, companyId, projectId: session.projectId,
          runId: session.runId, requestedBy: ctx.userId, reason: "feature_disabled" });
        codeRunCancellation.abortLiveRuns(session.id, { code: "feature_disabled" });
      }
    } catch { app.log.warn({ companyId }, "code_flag_run_cancellation_incomplete"); }
    for (const lease of secretLeases.list({ state: "active" }).filter(lease => lease.companyId === companyId)) {
      await secretLeases.revoke(lease.leaseId, "feature_disabled").catch(() => {
        app.log.warn({ companyId, leaseId: lease.leaseId }, "code_flag_secret_lease_audit_failed");
      });
    }
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


  let mcpIntegrationSourceForRuntime: McpIntegrationSource | null = null;

  const codeEngineWiring = createAppCodeEngineWiring({
    app,
    config,
    log: app.log,
    systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE,
    agent,
    approvalsRepo,
    auditLogService,
    authProvider,
    browserCredentials,
    codeWorkspaceRevisions,
    featureFlagService,
    projectGitService,
    projectSandbox,
    projectWorkspace,
    sandboxRunnerSecret,
    sandboxRunnerUrl,
    workspaceStore,
    getMcpIntegrationSource: () => mcpIntegrationSourceForRuntime,
  });

  hostGitCredentialLease = codeEngineWiring.hostGitCredentialLease;
  codeGitPolicyBoundary = codeEngineWiring.codeGitPolicyBoundary;
  engineDataPolicyResolver = codeEngineWiring.engineDataPolicyResolver;
  refreshOutboundPolicySnapshot = codeEngineWiring.refreshOutboundPolicySnapshot;

  const {
    codeReadTracker,
    codeTurnTracker,
    codeCheckpointPort,
    codeApprovalPort,
    codeProjectWorkspaceWritePort,
    mcpToolPolicyStore,
    mcpRuntimeCapabilities,
    readRuntimeMcpManifest,
    enrichedPolicyEngine,
    mcpRunPath,
    discoverRuntimeMcpCapabilities,
    codeSandboxExecPort,
    secretLeases,
    runnerReadiness,
    egressEnforcement,
    runnerReadinessTimer,
    codeActivitySink,
    networkActivity,
    egressAllowlist,
    codeApprovalScope,
    policyDecisionActivity,
    codePrivilegedAudit,
    automationAllowedPermissions,
    codeMembership,
    codeProtectedBranches,
    codeProjectTrust,
    codeSessionModes,
    codeDataPolicy,
    codeDataPolicyStoreService,
  } = codeEngineWiring;

  const processAndShellWiring = createAppProcessAndShellWiring({
    app,
    config,
    log: app.log,
    agent,
    projectSandbox,
    workspaceStore,
    featureFlagService,
    enrichedPolicyEngine,
    auditLogService,
    secretLeases,
  });
  const {
    trackedProcesses,
    codeProcessManager,
    codeShellRuntime,
  } = processAndShellWiring;

  let codeUserQuestionReaperPort: ReturnType<typeof createCodeUserQuestionReaperPort> | null = null;
  let mcpApprovalPauseRelease:
    | ((input: { companyId: string; runId: string; approvalId: string; reason: McpApprovalReleaseReason; answeredBy?: string }) => Promise<unknown>)
    | null = null;

  let codingAgentRunnerRef: CodingAgentRunner | undefined;
  let codeSubagentOperationsRef: (() => CodeSubagentOperationService) | undefined;
  let subagentChildRunnerWithAck: CodeSubagentDetachedRunner | undefined;
  let codeRunEnvironment: unknown;

  const codeToolRuntimeWiring = createAppCodeToolRuntimeWiring({
    config,
    log: app.log,
    systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE,
    workspaceStore,
    approvalsRepo,
    codeActivitySink,
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
    getCodeRunEnvironment: () => codeRunEnvironment,
    agentDataStudioService,
    auditLogService,
    codeApprovalPort,
    codeApprovalScope,
    codeCheckpointPort,
    codeProjectWorkspaceWritePort,
    codeProtectedBranches,
    codeReadTracker,
    codeService,
    codeTurnTracker,
    codeWorkspaceRevisions,
    enrichedPolicyEngine,
    projectGitService,
    subagentChildRunnerWithAck,
    codeSubagentOperationsRef,
  });
  const {
    codeDataRetention,
    codeReaper,
    codeShellRuntimePort,
    codeVerifyRunnerPort,
    codeInstructionsLoader,
    codeHooksService,
    codeCommandRegistry,
    codeSkillsService,
    describeCodeRunForPullRequest,
    codeToolRuntime,
    codeToolRuntimeRef,
  } = codeToolRuntimeWiring;

  const projectFileLeaseManager = new ProjectFileLeaseManager();
  const companyAutomationsWiring = createAppCompanyAutomationsWiring({
    config,
    log: app.log,
    aiEngine,
    workspaceStore,
    projectService,
    projectGitService,
    browserCredentials,
    projectPreviewService,
    projectSandbox,
    researchBundle,
    attachmentDirectory,
    chatFiles,
    knowledgeRepo,
    emailAgentTools,
    browserTool,
    projectWorkspace,
    projectFileLeaseManager,
    agentDataStudioService,
    projectApiGatewayService,
    objectStorage,
    fileRepository,
    memoryEngines,
    scopedMemory,
    guardrailPolicies,
    approvalsRepo,
    auditRepo,
    memoryDocuments,
    aiPreferences,
    agent,
    codeVerifyRunnerPort,
    dataBackendRepository,
    dataBackendService,
    dataProvider,
    dataStudioService,
    emailAttachmentStorage,
    projectAuthService,
    projectMigrationEngine,
    projectRedirectRepository,
    emailInboxRepo,
    automationAllowedPermissions,
  });
  const {
    projectDeployService,
    projectBrowserQaService,
    projectMediaService,
    companyToolRuntime,
    knowledgeProcessor,
    companyRuntime,
    automationsRepo,
    projectOrchestrator,
    companyRunQueue,
    emailAutomationHooks,
    emailInboxWorker,
    knowledgeQueue,
    messagingIntegrationsRepo,
    whatsappMessagingAdapter,
    discordMessagingAdapter,
    slackMessagingAdapter,
    messagingGateway,
    messagingScopeRouter,
    notifyMessagingConnections,
    runAutomation,
    automationScheduler,
    contentLibrary,
    integrationsRepo,
  } = companyAutomationsWiring;

  const chatOrchestrationWiring = createAppChatOrchestration({
    config,
    log: app.log,
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
  const {
    getAIContext,
    persistAutomaticCompanyMemory,
    beforeDeleteCompany,
    runBusinessMessage,
    runNeutralMessage,
  } = chatOrchestrationWiring;

  app.register(cors, { origin: config.webOrigin ?? true });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthenticationError) {
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof SecurityPolicyViolation) {
      return reply.code(error.status).send({
        error: { code: error.code, reasonCode: error.reasonCode, message: error.message },
      });
    }
    return reply.send(error);
  });

  registerPlatformBaseRoutes(app, {
    config, log: app.log, activeSessionRegistry, agentDataStudioService, aiEngine, aiPreferences,
    codePreferences,
    authClient, authProvider, backupService, beforeDeleteCompany, chatFiles, codeService, codeToolRuntime,
    dataBackendRepository, dataBackendService, dataProvider, dataStudioService,
    databaseProvisioner, featureFlagService, installationAuthStore, marketplace, npatiJwtSecret,
    projectApiGatewayService, projectAuthService, projectGitService, projectImportService,
    projectMediaService,
    projectPreviewService, projectSandbox, projectService, projectTerminalEvents, projectWorkspace,
    promoteService, quotaService, sandboxImagePolicy, workspaceStore,
  });

  const projectLifecycleService = new ProjectLifecycleService({
    store: workspaceStore,
    projects: projectService,
    previewService: projectPreviewService,
    sandboxService: projectSandbox,
    mediaService: projectMediaService,
    dataBackendService,
    removeWorkspace: async (ctx, companyId, projectId) => projectWorkspace.removeProjectWorkspace(ctx, companyId, projectId),
    auditLog: codePrivilegedAudit ? async (entry) => {
      await codePrivilegedAudit.record({
        action: entry.action,
        actor: entry.ctx.userId ?? "system",
        companyId: entry.companyId,
        resourceType: "project",
        resourceId: entry.resourceId,
        metadata: entry.metadata,
      }).catch(() => undefined);
    } : undefined,
    logger: app.log,
  });

  const lifecycleRetentionTimer = setInterval(() => {
    void projectLifecycleService.purgeExpiredProjects({
      workspaceId: AUDIT_SYSTEM_WORKSPACE,
      userId: "system-retention-worker",
      companyId: "",
      role: "admin",
      permissions: ["code.project.hard_purge", "business:manage"],
    }).catch((err) => {
      app.log.warn({ err }, "project_lifecycle_retention_sweep_failed");
    });
  }, Math.max(30_000, (Number(process.env.NPATI_PROJECT_RETENTION_TICK_SECONDS) || 3600) * 1000));
  lifecycleRetentionTimer.unref?.();

  const codeRoutes = registerCodeRouteWiring(app, {
    config, log: app.log, systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE, activeContextResolver, agent,
    aiEngine, aiPreferences, codePreferences, marketplace, auditLogService, authProvider, codeActivitySink, codeApprovalScope,
    codeCommandRegistry, codeDataPolicy, codeDataPolicyStoreService, codeHooksService,
    codeInstructionsLoader, codeMembership, codePrivilegedAudit, codeProcessManager, codeReaper,
    codeService, codeSkillsService, codeToolRuntime, codeTurnTracker, featureFlagService,
    mcpRunPath, notifyMessagingConnections, projectGitService, projectPreviewService, projectSandbox,
    projectService, projectWorkspace, providerDataGuardInstance, readRuntimeMcpManifest,
    sandboxImagePolicy, trackedProcesses, workspaceStore, lifecycleService: projectLifecycleService,
  });

  const {
    codeRbacForRun, codeRunStateLog, codeSessionInbox, codeRunCancellation,
    codeSessionRunExecutor, codeRunQueueLimits, codeRunAdmission, codeBackgroundRuns,
    codeErasureContexts, codeDataErasure,
  } = codeRoutes;
  codeRunEnvironment = codeRoutes.codeRunEnvironment;

  companyToolRuntime.setCodingDelegation(createCompanyCodingDelegation({
    flags: featureFlagService, code: codeService, executor: codeSessionRunExecutor, admission: codeRunAdmission,
  }));
  codingAgentRunnerRef = codeRoutes.codingAgentRunnerRef;
  codeSubagentOperationsRef = codeRoutes.codeSubagentOperationsRef;
  subagentChildRunnerWithAck = codeRoutes.subagentChildRunnerWithAck;

  const platformRoutes = registerPlatformRoutes(app, {
    config, log: app.log, systemWorkspaceId: AUDIT_SYSTEM_WORKSPACE, agent, aiEngine, apiKeysRepo,
    approvalsRepo, auditLogService, auditRepo, authProvider, automationScheduler, automationsRepo,
    browserCredentials, browserTool, chatFiles, codeActivitySink, codeApprovalScope,
    codeDataErasure, codeErasureContexts, codeInstructionsLoader, codePrivilegedAudit,
    codeProjectTrust, codeRbacForRun, codeRunStateLog, codeService, codeSessionModes,
    companyRunQueue, companyRuntime, companyToolRuntime, contentLibrary, egressAllowlist,
    egressEnforcement, emailAttachmentStorage, emailAutomationHooks, emailInboxRepo,
    emailInboxWorker, featureFlagService, fileRepository, guardrailPolicies, integrationsRepo,
    knowledgeProcessor, knowledgeQueue, knowledgeRepo, mcpRuntimeCapabilities,
    mcpToolPolicyStore, memoryDocuments, messagingGateway, messagingIntegrationsRepo,
    messagingScopeRouter, networkActivity, objectStorage, persistAutomaticCompanyMemory,
    persistBusinessLogo, projectBrowserQaService, projectDeployService, projectWorkspaceRoot,
    runAutomation, runNeutralMessage, scopedMemory, workspaceStore,
  });
  codeUserQuestionReaperPort = platformRoutes.codeUserQuestionReaperPort;

  registerAppRoutesAndLifecycle({
    app, config, log: app.log, boundedResponseChunks, aiEngine, hub, workspaceStore, researchBundle,
    objectStorage, redisHealthCheck, coreBackendHealthCheck, agent, authProvider,
    discoverRuntimeMcpCapabilities, featureFlagService, mcpRuntimeCapabilities,
    activeContextResolver, chatFiles, activeChatStreams, companyRuntime, getAIContext, marketplace,
    persistAutomaticCompanyMemory, projectOrchestrator, runBusinessMessage, runNeutralMessage,
    codeService, projectService, projectTerminalEvents, codeSessionRunExecutor, codeRunAdmission,
    codeBackgroundRuns, codeSessionInbox, projectSandbox, projectPreviewService, codeRunCancellation,
    activeSessionRegistry, aiPreferences, codePreferences, codeRunQueueLimits, notifyMessagingConnections,
    automationScheduler, codeReaper, sandboxIdleTimer, sandboxRetentionTimer, lifecycleRetentionTimer, backupTimer,
    auditVerifyTimer, auditAnchorTimer, runnerReadinessTimer, storageReconciler,
    whatsappMessagingAdapter, discordMessagingAdapter, slackMessagingAdapter, emailInboxWorker,
    emailInboxRepo, browserCredentials, companyRunQueue, knowledgeQueue, knowledgeRepo,
    automationsRepo, approvalsRepo, integrationsRepo, messagingIntegrationsRepo, auditRepo,
    storageProtection,
  });

  return app;
}
