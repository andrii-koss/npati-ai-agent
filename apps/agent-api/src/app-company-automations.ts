import type { FastifyBaseLogger } from "fastify";
import type { WorkspaceStore } from "@npati/workspace";
import { type AIEngine, isChatCapableModel } from "@npati/omniroute-adapter";
import type { AppConfig } from "./app";
import type { createCoreServices } from "./core-services";
import type { createDataBackendServices } from "./data-backend-services";
import type { ProjectFileLeaseManager } from "./project-file-lock";
import type { ProjectGitService } from "./project-git-service";
import type { ProjectPreviewService } from "./project-preview-service";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { ProjectService } from "./project-service";
import type { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import type { BrowserCredentialsRepository } from "./browser-credentials-repository";
import type { BrowserUseClient } from "./browser-tool";
import type { EmailAgentTools } from "./email-agent-tools";
import type { EmailAttachmentStorage } from "./email-attachment-storage";
import type { GuardrailPolicyRepository } from "./guardrail-policy-repository";
import type { CompanyApprovalsRepository } from "./approvals-repository";
import type { AuditRepository } from "./audit-repository";
import type { AIPreferencesStore } from "./ai-preferences";
import type { ScopedMemoryEngine } from "./scoped-memory";
import type { CodeVerifyRunnerPort } from "./code-tool-executors";
import type { AgentDataStudioService } from "./data-studio/agent-data-service";
import type { ProjectApiGatewayService } from "./data-studio/gateway-service";
import type { DataStudioUiService } from "./data-studio/studio-service";
import type { resolveAutomationAllowedPermissions } from "./code-service-identity";
import { ProjectDeployService } from "./project-deploy-service";
import { ProjectBrowserQaService } from "./project-browser-qa-service";
import { ProjectMediaService } from "./project-media-service";
import { CompanyToolRuntime } from "./company-tool-runtime";
import { WasmExecSandbox } from "./wasm-exec-sandbox";
import { CompanyKnowledgeProcessor, CompanyKnowledgeRepository } from "./company-knowledge";
import { CompanyDelegationRuntime } from "./company-runtime";
import { createEmailAutomationWiring } from "./email-automation-wiring";
import { EmailInboxWorker } from "./email-worker";
import { EmailInboxRepository } from "./email-inbox-repository";
import { CompanyKnowledgeQueue } from "./company-knowledge-queue";
import { CompanyAutomationsRepository, type CompanyAutomation } from "./automations-repository";
import { MessagingIntegrationsRepository } from "./messaging-integrations-repository";
import { MessagingGateway, TelegramMessagingAdapter } from "./messaging-gateway";
import { WhatsAppMessagingAdapter } from "./whatsapp-messaging";
import { DiscordMessagingAdapter } from "./discord-messaging";
import { SlackMessagingAdapter } from "./slack-messaging";
import { EmailMessagingAdapter } from "./email-messaging-adapter";
import { MessagingScopeRouter } from "./messaging-scope-router";
import { createAutomationExecutor } from "./automation-executor-wiring";
import { createMessagingNotificationsWiring } from "./messaging-notifications-wiring";
import { AutomationScheduler } from "./automation-scheduler";
import { ContentLibraryStore } from "./content-library-store";
import { IntegrationsRepository } from "./integrations-repository";
import { configuredIntegrationsFrom } from "./mcp-runtime-transport";

export interface AppCompanyAutomationsDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  aiEngine: AIEngine;
  workspaceStore: WorkspaceStore;
  projectService: ProjectService;
  projectGitService: ProjectGitService;
  browserCredentials?: BrowserCredentialsRepository;
  projectPreviewService: ProjectPreviewService;
  projectSandbox?: ProjectSandboxService;
  researchBundle?: ReturnType<typeof createCoreServices>["researchBundle"];
  attachmentDirectory?: string;
  chatFiles?: ReturnType<typeof createCoreServices>["chatFiles"];
  knowledgeRepo?: CompanyKnowledgeRepository;
  emailAgentTools: EmailAgentTools;
  browserTool?: BrowserUseClient;
  projectWorkspace: MountedWorkspaceProvider;
  projectFileLeaseManager: ProjectFileLeaseManager;
  agentDataStudioService?: AgentDataStudioService;
  projectApiGatewayService?: ProjectApiGatewayService;
  objectStorage?: ReturnType<typeof createCoreServices>["objectStorage"];
  fileRepository: ReturnType<typeof createCoreServices>["fileRepository"];
  memoryEngines: ReturnType<typeof createCoreServices>["memoryEngines"];
  scopedMemory: ScopedMemoryEngine;
  guardrailPolicies: GuardrailPolicyRepository;
  approvalsRepo?: CompanyApprovalsRepository;
  auditRepo?: AuditRepository;
  memoryDocuments: ReturnType<typeof createCoreServices>["memoryDocuments"];
  aiPreferences: AIPreferencesStore;
  agent: ReturnType<typeof createCoreServices>["agent"];
  codeVerifyRunnerPort?: CodeVerifyRunnerPort;
  dataBackendRepository?: ReturnType<typeof createDataBackendServices>["dataBackendRepository"];
  dataBackendService?: ReturnType<typeof createDataBackendServices>["dataBackendService"];
  dataProvider?: ReturnType<typeof createDataBackendServices>["dataProvider"];
  dataStudioService?: DataStudioUiService;
  emailAttachmentStorage?: EmailAttachmentStorage;
  projectAuthService?: ReturnType<typeof createDataBackendServices>["projectAuthService"];
  projectMigrationEngine?: ReturnType<typeof createDataBackendServices>["projectMigrationEngine"];
  projectRedirectRepository?: ReturnType<typeof createDataBackendServices>["projectRedirectRepository"];
  emailInboxRepo: EmailInboxRepository;
  automationAllowedPermissions: ReturnType<typeof resolveAutomationAllowedPermissions>;
}

export function createAppCompanyAutomationsWiring(deps: AppCompanyAutomationsDeps) {
  const {
    config,
    log,
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
  } = deps;

  const projectDeployService = new ProjectDeployService(
    workspaceStore,
    projectService,
    projectGitService,
    browserCredentials
      ? async (ctx, companyId, credentialId) => {
          return browserCredentials.resolve(ctx, companyId, credentialId);
        }
      : undefined,
  );

  const projectBrowserQaService = new ProjectBrowserQaService(
    projectService,
    workspaceStore,
    projectPreviewService,
    projectSandbox,
  );

  const projectMediaService = objectStorage
    ? new ProjectMediaService(objectStorage, projectWorkspace)
    : undefined;

  const companyToolRuntime = new CompanyToolRuntime(
    aiEngine,
    researchBundle?.provider,
    attachmentDirectory,
    chatFiles,
    knowledgeRepo,
    new WasmExecSandbox(),
    emailAgentTools,
    browserTool,
    projectWorkspace,
    workspaceStore,
    projectSandbox,
    projectPreviewService,
    projectGitService,
    projectFileLeaseManager,
    projectDeployService,
    projectBrowserQaService,
    agentDataStudioService,
    projectApiGatewayService,
    projectMediaService,
  );

  const knowledgeProcessor =
    knowledgeRepo && objectStorage
      ? new CompanyKnowledgeProcessor(knowledgeRepo, fileRepository, objectStorage, aiEngine, memoryEngines)
      : undefined;

  const companyRuntime = new CompanyDelegationRuntime(
    workspaceStore,
    aiEngine,
    config.companyRunTimeoutMs,
    companyToolRuntime,
    knowledgeProcessor
      ? async (ctx, companyId, query, scope) => {
          const [knowledge, scoped] = await Promise.all([
            knowledgeProcessor.retrieveContext(ctx, companyId, query),
            scopedMemory.retrieveMemories({
              companyId,
              tenantId: ctx.workspaceId,
              apiKeyId: scope?.apiKeyId ?? ctx.apiKeyId,
              sessionId: scope?.sessionId,
              query,
              limit: 12,
            }),
          ]);
          return {
            chunks: knowledge.chunks,
            memories: [
              ...knowledge.memories,
              ...scoped.map((item) => ({ content: item.title + ": " + item.content })),
            ],
          };
        }
      : undefined,
    undefined,
    undefined,
    (ctx, companyId) => guardrailPolicies.get(ctx, companyId),
    approvalsRepo,
    auditRepo,
    async (ctx) => (await memoryDocuments.getUserDocument(ctx))?.markdown,
    async (ctx) => {
      const prefs = await aiPreferences.get(ctx);
      const selected = prefs.addedModels.find((model) => model.id === prefs.routing.defaultModelId);
      return selected && isChatCapableModel(selected) ? [selected] : [];
    },
    true,
  );

  const automationsRepo = new CompanyAutomationsRepository(config.databaseUrl);

  const automationWiring = createEmailAutomationWiring({
    config,
    log,
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
    projectRedirectRepository: projectRedirectRepository!,
    projectSandbox,
    projectService,
    projectWorkspace,
    workspaceStore,
  });
  const { projectOrchestrator, companyRunQueue, emailAutomationHooks } = automationWiring;

  const emailInboxWorker = new EmailInboxWorker(
    emailInboxRepo,
    aiEngine,
    auditRepo,
    emailAutomationHooks,
    undefined,
    emailAttachmentStorage,
  );

  const knowledgeQueue = knowledgeRepo && config.redisUrl ? new CompanyKnowledgeQueue(config.redisUrl) : undefined;
  const messagingIntegrationsRepo = new MessagingIntegrationsRepository(config.databaseUrl);
  const whatsappMessagingAdapter = new WhatsAppMessagingAdapter(messagingIntegrationsRepo);
  const discordMessagingAdapter = new DiscordMessagingAdapter(messagingIntegrationsRepo);
  const slackMessagingAdapter = new SlackMessagingAdapter(messagingIntegrationsRepo);
  const emailMessagingAdapter = new EmailMessagingAdapter(emailInboxRepo, () => emailInboxWorker.triggerTick());
  const messagingGateway = new MessagingGateway()
    .register(new TelegramMessagingAdapter())
    .register(whatsappMessagingAdapter)
    .register(discordMessagingAdapter)
    .register(slackMessagingAdapter)
    .register(emailMessagingAdapter);
  const messagingScopeRouter = new MessagingScopeRouter(workspaceStore, messagingIntegrationsRepo);

  const { executeAutomation } = createAutomationExecutor({
    config,
    log,
    agent,
    automationAllowedPermissions,
    browserCredentials,
    companyRuntime,
    emailInboxRepo,
  });

  const messagingNotificationsWiring = createMessagingNotificationsWiring({
    config,
    log,
    messagingGateway,
    messagingIntegrationsRepo,
  });
  const { notifyMessagingConnections } = messagingNotificationsWiring;

  const notifyAutomation = async (
    automation: CompanyAutomation,
    status: "completed" | "failed",
    detail: string,
  ) => {
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

  const runAutomation = async (automation: CompanyAutomation, executionKey: string) => {
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
  const mcpIntegrationSourceForRuntime = configuredIntegrationsFrom(integrationsRepo);

  return {
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
    emailMessagingAdapter,
    messagingGateway,
    messagingScopeRouter,
    notifyMessagingConnections,
    runAutomation,
    automationScheduler,
    contentLibrary,
    integrationsRepo,
    mcpIntegrationSourceForRuntime,
  };
}
