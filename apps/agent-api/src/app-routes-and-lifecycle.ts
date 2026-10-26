import { createOllamaChatHandler } from "./runtime-compat-routes";
import { WorkspaceChatActions } from "./workspace-chat-actions";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { WorkspaceStore, AuthContext } from "@npati/workspace";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import type { ServiceHealth } from "@npati/shared";
import type { AppConfig } from "./app";
import type { AuthProvider } from "./auth";
import type { createCoreServices } from "./core-services";
import type { ProjectOrchestrator } from "./project-orchestrator";
import type { CodeService } from "./code-service";
import type { ProjectService } from "./project-service";
import type { ProjectTerminalEventsRepository } from "./project-terminal-events";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { ProjectPreviewService } from "./project-preview-service";
import type { AutomationScheduler } from "./automation-scheduler";
import type { CodeReaper } from "./code-reaper";
import type { StorageReconciler } from "./storage-reconciler";
import type { EmailInboxWorker } from "./email-worker";
import type { EmailInboxRepository } from "./email-inbox-repository";
import type { BrowserCredentialsRepository } from "./browser-credentials-repository";
import type { CompanyRunQueueProducer } from "./company-run-queue";
import type { CompanyKnowledgeQueue } from "./company-knowledge-queue";
import type { CompanyKnowledgeRepository } from "./company-knowledge";
import type { CompanyAutomationsRepository } from "./automations-repository";
import type { CompanyApprovalsRepository } from "./approvals-repository";
import type { IntegrationsRepository } from "./integrations-repository";
import type { MessagingIntegrationsRepository } from "./messaging-integrations-repository";
import type { AuditRepository } from "./audit-repository";
import type { StorageProtection } from "./storage-protection";
import type { FeatureFlagService } from "./feature-flags";
import type { McpRuntimeCapabilityStore } from "./mcp-runtime-capabilities";
import type { ActiveContextResolver } from "./active-context-resolver";
import type { CompanyDelegationRuntime } from "./company-runtime";
import type { WhatsAppMessagingAdapter } from "./whatsapp-messaging";
import type { DiscordMessagingAdapter } from "./discord-messaging";
import type { SlackMessagingAdapter } from "./slack-messaging";
import type { registerCodeRouteWiring } from "./code-route-wiring";
import type { createRedisHealthWiring } from "./redis-health-wiring";
import type { createAppChatOrchestration } from "./app-chat-orchestration";
import type { createMcpRuntimeRunPath } from "./mcp-run-path";
import type { createMessagingNotificationsWiring } from "./messaging-notifications-wiring";
import type { AIPreferencesStore } from "./ai-preferences";
import { registerHealthRoutes } from "./health-routes";
import { registerCapabilityRoutes } from "./capability-routes";
import { registerMiscRoutes } from "./misc-routes";
import { registerChatRoutes } from "./chat-routes";
import { registerChatDevelopmentRoutes } from "./chat-development-routes";
import { registerChatStreamRoutes } from "./chat-stream-routes";
import { createChatProjectIntentResolver } from "./chat-project-intent";

export interface AppRoutesAndLifecycleDeps {
  app: FastifyInstance;
  config: AppConfig;
  log: FastifyBaseLogger;
  boundedResponseChunks: (value: string, maxCharacters?: number) => Iterable<string>;
  aiEngine: AIEngine;
  hub: ReturnType<typeof createCoreServices>["hub"];
  workspaceStore: WorkspaceStore;
  researchBundle?: ReturnType<typeof createCoreServices>["researchBundle"];
  objectStorage?: ReturnType<typeof createCoreServices>["objectStorage"];
  redisHealthCheck: () => Promise<ServiceHealth>;
  coreBackendHealthCheck: () => Promise<ServiceHealth>;
  agent: ReturnType<typeof createCoreServices>["agent"];
  authProvider: AuthProvider;
  discoverRuntimeMcpCapabilities: (ctx: AuthContext, companyId: string) => ReturnType<ReturnType<typeof createMcpRuntimeRunPath>["discover"]>;
  featureFlagService: FeatureFlagService;
  mcpRuntimeCapabilities: McpRuntimeCapabilityStore;
  activeContextResolver: ActiveContextResolver;
  chatFiles?: ReturnType<typeof createCoreServices>["chatFiles"];
  projectMediaService?: import("./project-media-service").ProjectMediaService;
  activeChatStreams: ReturnType<typeof createRedisHealthWiring>["activeChatStreams"];
  companyRuntime: CompanyDelegationRuntime;
  getAIContext: ReturnType<typeof createAppChatOrchestration>["getAIContext"];
  marketplace: OmniRouteMarketplace;
  persistAutomaticCompanyMemory: ReturnType<typeof createAppChatOrchestration>["persistAutomaticCompanyMemory"];
  projectOrchestrator: ProjectOrchestrator;
  runBusinessMessage: ReturnType<typeof createAppChatOrchestration>["runBusinessMessage"];
  runNeutralMessage: ReturnType<typeof createAppChatOrchestration>["runNeutralMessage"];
  codeService: CodeService;
  projectService: ProjectService;
  projectTerminalEvents: ProjectTerminalEventsRepository;
  codeSessionRunExecutor: ReturnType<typeof registerCodeRouteWiring>["codeSessionRunExecutor"];
  codeRunAdmission: ReturnType<typeof registerCodeRouteWiring>["codeRunAdmission"];
  codeBackgroundRuns: ReturnType<typeof registerCodeRouteWiring>["codeBackgroundRuns"];
  codeSessionInbox: ReturnType<typeof registerCodeRouteWiring>["codeSessionInbox"];
  projectSandbox?: ProjectSandboxService;
  projectPreviewService: ProjectPreviewService;
  codeRunCancellation: ReturnType<typeof registerCodeRouteWiring>["codeRunCancellation"];
  activeSessionRegistry: ReturnType<typeof createRedisHealthWiring>["activeSessionRegistry"];
  aiPreferences: AIPreferencesStore;
  codePreferences?: ReturnType<typeof createCoreServices>["codePreferences"];
  codeRunQueueLimits: ReturnType<typeof registerCodeRouteWiring>["codeRunQueueLimits"];
  notifyMessagingConnections: ReturnType<typeof createMessagingNotificationsWiring>["notifyMessagingConnections"];
  automationScheduler: AutomationScheduler;
  codeReaper: CodeReaper;
  sandboxIdleTimer?: NodeJS.Timeout;
  sandboxRetentionTimer?: NodeJS.Timeout;
  lifecycleRetentionTimer?: NodeJS.Timeout;
  backupTimer?: NodeJS.Timeout;
  auditVerifyTimer?: NodeJS.Timeout;
  auditAnchorTimer?: NodeJS.Timeout;
  runnerReadinessTimer?: NodeJS.Timeout;
  storageReconciler?: StorageReconciler;
  whatsappMessagingAdapter: WhatsAppMessagingAdapter;
  discordMessagingAdapter: DiscordMessagingAdapter;
  slackMessagingAdapter: SlackMessagingAdapter;
  emailInboxWorker: EmailInboxWorker;
  emailInboxRepo: EmailInboxRepository;
  browserCredentials?: BrowserCredentialsRepository;
  companyRunQueue?: CompanyRunQueueProducer;
  knowledgeQueue?: CompanyKnowledgeQueue;
  knowledgeRepo?: CompanyKnowledgeRepository;
  automationsRepo?: CompanyAutomationsRepository;
  approvalsRepo?: CompanyApprovalsRepository;
  integrationsRepo?: IntegrationsRepository;
  messagingIntegrationsRepo: MessagingIntegrationsRepository;
  auditRepo?: AuditRepository;
  storageProtection: StorageProtection;
}

export function registerAppRoutesAndLifecycle(deps: AppRoutesAndLifecycleDeps) {
  const {
    app,
    config,
    log,
    boundedResponseChunks,
    aiEngine,
    hub,
    workspaceStore,
    researchBundle,
    objectStorage,
    redisHealthCheck,
    coreBackendHealthCheck,
    agent,
    authProvider,
    discoverRuntimeMcpCapabilities,
    featureFlagService,
    mcpRuntimeCapabilities,
    activeContextResolver,
    chatFiles,
    activeChatStreams,
    companyRuntime,
    getAIContext,
    marketplace,
    persistAutomaticCompanyMemory,
    projectOrchestrator,
    runBusinessMessage,
    runNeutralMessage,
    codeService,
    projectService,
    projectTerminalEvents,
    codeSessionRunExecutor,
    codeRunAdmission,
    codeBackgroundRuns,
    codeSessionInbox,
    projectSandbox,
    projectPreviewService,
    codeRunCancellation,
    activeSessionRegistry,
    aiPreferences,
    codePreferences,
    codeRunQueueLimits,
    notifyMessagingConnections,
    automationScheduler,
    codeReaper,
    sandboxIdleTimer,
    sandboxRetentionTimer,
    lifecycleRetentionTimer,
    backupTimer,
    auditVerifyTimer,
    auditAnchorTimer,
    runnerReadinessTimer,
    storageReconciler,
    whatsappMessagingAdapter,
    discordMessagingAdapter,
    slackMessagingAdapter,
    emailInboxWorker,
    emailInboxRepo,
    browserCredentials,
    companyRunQueue,
    knowledgeQueue,
    knowledgeRepo,
    automationsRepo,
    approvalsRepo,
    integrationsRepo,
    messagingIntegrationsRepo,
    auditRepo,
    storageProtection,
  } = deps;

  app.addHook("onClose", async () => {
    automationScheduler.stop();
    codeReaper.stop();
    if (sandboxIdleTimer) clearInterval(sandboxIdleTimer);
    if (sandboxRetentionTimer) clearInterval(sandboxRetentionTimer);
    if (lifecycleRetentionTimer) clearInterval(lifecycleRetentionTimer);
    if (backupTimer) clearInterval(backupTimer);
    if (auditVerifyTimer) clearInterval(auditVerifyTimer);
    if (auditAnchorTimer) clearInterval(auditAnchorTimer);
    if (runnerReadinessTimer) clearInterval(runnerReadinessTimer);
    storageReconciler?.stop();
    await Promise.all([
      whatsappMessagingAdapter.shutdown(),
      discordMessagingAdapter.shutdown(),
      slackMessagingAdapter.shutdown(),
    ]);
    await emailInboxWorker.stop();
    await emailInboxRepo.close();
    await browserCredentials?.close();
    await companyRunQueue?.close();
    await knowledgeQueue?.close();
    await knowledgeRepo?.close();
    await automationsRepo?.close();
    await approvalsRepo?.close();
    await integrationsRepo?.close();
    await messagingIntegrationsRepo.close();
    await auditRepo?.close();
    await chatFiles?.close();
    await storageProtection.close();
    await workspaceStore.close?.();
  });

  app.addHook("onReady", async () => {
    await workspaceStore.initialize();
    await whatsappMessagingAdapter.restore();
    await discordMessagingAdapter.restore();
    await slackMessagingAdapter.restore();
    await emailInboxRepo.encryptLegacyAccountCredentials();
    await objectStorage?.initialize();
    if (chatFiles) {
      const legacy = await chatFiles.migrateLegacy();
      if (legacy.failed) log.warn(legacy, "Some legacy attachments could not be migrated");
      await chatFiles.cleanupPending();
    }
    storageReconciler?.start();

    void codeReaper.run().catch(() => undefined);
    codeReaper.start((summary) => {
      log.warn({ skipped: summary.skipped, errors: summary.errors }, "code_reaper_attention");
    });
    emailInboxWorker.start();
    automationScheduler.start();
  });

  registerHealthRoutes(app, {
    aiEngine: aiEngine as never,
    hub,
    store: workspaceStore,
    researchBundle: researchBundle as never,
    objectStorage,
    redisHealthCheck,
    coreBackendHealthCheck,
  });

  registerCapabilityRoutes(app, {
    config,
    log,
    agent,
    authProvider,
    discoverRuntimeMcpCapabilities,
    featureFlagService,
    mcpRuntimeCapabilities,
    workspaceStore,
  });

  registerMiscRoutes(app, {
    config,
    log,
    activeContextResolver,
    authProvider,
    chatFiles,
    researchBundle,
    workspaceStore,
  });

  const resolveProjectIntent = createChatProjectIntentResolver({ engine: aiEngine, getAIContext, log,
    resolveNamedProject: async (auth, message, companyId) => {
      const current = await activeContextResolver.resolve(auth, { contextType: companyId ? "company" : "none", companyId: companyId ?? null, businessId: null }).catch(() => undefined);
      return current ? (await activeContextResolver.resolveNamedCompany(auth, current, message))?.project?.id : undefined;
    },
    namesOwnedManagementRecord: (auth, message) => WorkspaceChatActions.namesOwnedAutomation(auth, workspaceStore, message, automationsRepo),
    // The 20 most recent owned companies, read in parallel, as in the named-company context resolver.
    listAgentNames: async (auth) => {
      const owned: Awaited<ReturnType<typeof workspaceStore.listCompanies>>["items"] = [];
      let cursor: string | undefined;
      do { const page = await workspaceStore.listCompanies(auth, 100, cursor); owned.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor && owned.length < 500);
      const companies = owned.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 20);
      return (await Promise.all(companies.map(async (company) => (await workspaceStore.listCompanyAgentsPage(auth, company.id, 50)).items.map((agent) => agent.name)))).flat();
    } });
  registerChatRoutes(app, {
    ollamaChat: createOllamaChatHandler(aiEngine, authProvider),
    resolveProjectIntent,
    config,
    log,
    activeChatStreams,
    activeContextResolver,
    agent,
    authProvider,
    companyRuntime,
    getAIContext: getAIContext as never,
    marketplace,
    persistAutomaticCompanyMemory: persistAutomaticCompanyMemory as never,
    projectOrchestrator,
    runBusinessMessage: runBusinessMessage as never,
    runNeutralMessage: runNeutralMessage as never,
    workspaceStore,
    boundedResponseChunks,
  });

  const chatDevelopment = registerChatDevelopmentRoutes(app, {
    engine: aiEngine,
    getAIContext: getAIContext as never,
    resolveProjectIntent,
    auth: authProvider,
    store: workspaceStore,
    code: codeService,
    flags: featureFlagService,
    projects: projectService,
    terminalEvents: projectTerminalEvents,
    preparer: projectOrchestrator,
    executor: codeSessionRunExecutor,
    admission: codeRunAdmission,
    background: codeBackgroundRuns,
    log,
    inbox: codeSessionInbox,
    sandbox: projectSandbox,
    preview: projectPreviewService,
    cancellation: codeRunCancellation,
  });

  registerChatStreamRoutes(app, {
    projectMediaService: deps.projectMediaService,
    aiEngine,
    chatFiles,
    resolveProjectIntent,
    chatDevelopment,
    config,
    log,
    boundedResponseChunks,
    activeChatStreams,
    activeContextResolver,
    activeSessionRegistry,
    agent,
    aiPreferences,
    codePreferences,
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
    getAIContext: getAIContext as never,
    marketplace,
    notifyMessagingConnections: notifyMessagingConnections as never,
    persistAutomaticCompanyMemory: persistAutomaticCompanyMemory as never,
    projectOrchestrator,
    projectPreviewService,
    projectSandbox,
    projectService,
    runBusinessMessage: runBusinessMessage as never,
    runNeutralMessage: runNeutralMessage as never,
    workspaceStore,
  });
}
