
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { registerAIRoutes } from "./ai-routes";
import { registerCodeAgentRoutes } from "./code-agent-routes";
import { registerAuthRoutes } from "./auth-routes";
import { registerCodeRoutes } from "./code-routes";
import { CodeService } from "./code-service";
import { registerCodeToolRoutes } from "./code-tool-routes";
import { CodeToolRuntime } from "./code-tool-runtime";
import { createCoreServices } from "./core-services";
import { createDataBackendServices } from "./data-backend-services";
import { registerProjectAuthRoutes } from "./data-studio/auth-routes";
import { registerProjectApiGatewayRoutes } from "./data-studio/gateway-routes";
import { registerDataBackendRoutes } from "./data-studio/routes";
import { registerDataStudioRoutes } from "./data-studio/studio-routes";
import { FeatureFlagService } from "./feature-flags";
import { registerInstallationAuthRoutes } from "./installation-auth-routes";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { createProductionResilientAIEngine } from "./production-resilient-ai-engine";
import { registerProjectFileRoutes } from "./project-file-routes";
import { ProjectMediaService } from "./project-media-service";
import { registerProjectGitRoutes } from "./project-git-routes";
import { ProjectGitService } from "./project-git-service";
import { registerProjectImportRoutes } from "./project-import-routes";
import { ProjectImportService } from "./project-import-service";
import { registerProjectPreviewRoutes } from "./project-preview-routes";
import { ProjectPreviewService } from "./project-preview-service";
import { registerProjectRoutes } from "./project-routes";
import { ProjectSandboxService } from "./project-sandbox-service";
import { ProjectService } from "./project-service";
import { ProjectTerminalEventsRepository } from "./project-terminal-events";
import { registerProjectTerminalRoutes } from "./project-terminal-routes";
import { registerRuntimeCompatRoutes } from "./runtime-compat-routes";
import { SandboxImagePolicy } from "./sandbox-image-policy";
import { registerSandboxImageRoutes } from "./sandbox-image-routes";
import { registerSessionStreamRoutes } from "./session-stream-routes";
import { registerWorkspaceRoutes } from "./workspace-routes";
import { ActiveSessionRegistry } from "./distributed-session-registry";
import { AgentDataStudioService } from "./data-studio/agent-data-service";
import { DataStudioUiService } from "./data-studio/studio-service";
import { ProjectApiGatewayService } from "./data-studio/gateway-service";
import { AuthContext } from "@npati/workspace";

export interface PlatformBaseRouteDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  activeSessionRegistry: ActiveSessionRegistry;
  agentDataStudioService: AgentDataStudioService | undefined;
  aiEngine: ReturnType<typeof createProductionResilientAIEngine>;
  aiPreferences: ReturnType<typeof createCoreServices>["aiPreferences"];
  codePreferences: ReturnType<typeof createCoreServices>["codePreferences"];
  authClient: ReturnType<typeof createCoreServices>["authClient"];
  authProvider: ReturnType<typeof createCoreServices>["authProvider"];
  backupService: ReturnType<typeof createDataBackendServices>["backupService"];
  beforeDeleteCompany: (context: AuthContext, companyId: string) => Promise<void>;
  chatFiles: ReturnType<typeof createCoreServices>["chatFiles"];
  codeService: CodeService;
  codeToolRuntime: CodeToolRuntime;
  dataBackendRepository: ReturnType<typeof createDataBackendServices>["dataBackendRepository"];
  dataBackendService: ReturnType<typeof createDataBackendServices>["dataBackendService"];
  dataProvider: ReturnType<typeof createDataBackendServices>["dataProvider"];
  dataStudioService: DataStudioUiService | undefined;
  databaseProvisioner: ReturnType<typeof createDataBackendServices>["databaseProvisioner"];
  featureFlagService: FeatureFlagService;
  installationAuthStore: ReturnType<typeof createCoreServices>["installationAuthStore"];
  marketplace: ReturnType<typeof createCoreServices>["marketplace"];
  npatiJwtSecret: ReturnType<typeof createCoreServices>["npatiJwtSecret"];
  projectApiGatewayService: ProjectApiGatewayService | undefined;
  projectAuthService: ReturnType<typeof createDataBackendServices>["projectAuthService"];
  projectGitService: ProjectGitService;
  projectImportService: ProjectImportService;
  projectPreviewService: ProjectPreviewService;
  projectMediaService?: ProjectMediaService;
  projectSandbox: ProjectSandboxService | undefined;
  projectService: ProjectService;
  projectTerminalEvents: ProjectTerminalEventsRepository;
  projectWorkspace: MountedWorkspaceProvider;
  promoteService: ReturnType<typeof createDataBackendServices>["promoteService"];
  quotaService: ReturnType<typeof createDataBackendServices>["quotaService"];
  sandboxImagePolicy: SandboxImagePolicy;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
}

export function registerPlatformBaseRoutes(app: FastifyInstance, deps: PlatformBaseRouteDeps): void {
  const { activeSessionRegistry, agentDataStudioService, aiEngine, aiPreferences, codePreferences, authClient, authProvider, backupService, beforeDeleteCompany, chatFiles, codeService, codeToolRuntime, config, dataBackendRepository, dataBackendService, dataProvider, dataStudioService, databaseProvisioner, featureFlagService, installationAuthStore, marketplace, npatiJwtSecret, projectApiGatewayService, projectAuthService, projectGitService, projectImportService, projectMediaService, projectPreviewService, projectSandbox, projectService, projectTerminalEvents, projectWorkspace, promoteService, quotaService, sandboxImagePolicy, workspaceStore } = deps;
  registerAuthRoutes(app, {
    authClient,
    workspaceStore,
    authProvider,
    allowLegacyPasswordAuth: config.allowLegacyPasswordAuth ?? false,
    localJwtSigningSecret: npatiJwtSecret,
  });
  registerInstallationAuthRoutes(app, {
    authClient,
    store: installationAuthStore,
    publicDomain: config.agentPublicDomain,
    version: config.agentVersion,
    deploymentType: config.deploymentType,
    hostedRegistrationToken: config.hostedRegistrationToken,
  });
  registerSessionStreamRoutes(app, authProvider, activeSessionRegistry);
  registerAIRoutes(app, marketplace, aiPreferences, authProvider, aiEngine);
  registerCodeAgentRoutes(app, marketplace, codePreferences, aiPreferences, authProvider);
  registerRuntimeCompatRoutes(app, aiEngine, authProvider);
  registerWorkspaceRoutes(app, workspaceStore, authProvider, aiPreferences, {
    beforeDeleteBusiness: async (context,businessId) => { await chatFiles?.deleteBusiness(context,businessId); },
    beforeDeleteCompany,
    beforeDeleteConversation: async (context,_businessId,conversationId) => { await chatFiles?.deleteChat(context,conversationId); },
  });
  registerProjectRoutes(app, projectService, authProvider, projectWorkspace);
  registerDataBackendRoutes(app, authProvider, dataBackendService, { promote: promoteService, backups: backupService, quotas: quotaService });
  registerDataStudioRoutes(app, authProvider, dataStudioService, agentDataStudioService);
  registerProjectAuthRoutes(app, authProvider, projectAuthService);
  registerProjectApiGatewayRoutes(app, projectApiGatewayService, projectAuthService);
  app.addHook("onClose", async () => {
    await projectApiGatewayService?.close();
    await projectAuthService?.close();
    await dataProvider?.close();
    await databaseProvisioner?.close();
    await dataBackendRepository?.close();
  });
  registerProjectFileRoutes(app, projectWorkspace, authProvider, projectMediaService, projectService);
  registerProjectTerminalRoutes(app, authProvider, projectTerminalEvents, projectSandbox);
  registerProjectPreviewRoutes(app, projectPreviewService, projectWorkspace, authProvider, workspaceStore);
  registerProjectGitRoutes(app, projectGitService, authProvider);
  registerProjectImportRoutes(app, projectImportService, authProvider);
  registerCodeRoutes(app, authProvider, codeService, featureFlagService);

  registerSandboxImageRoutes(app, authProvider, sandboxImagePolicy, workspaceStore);

  registerCodeToolRoutes(app, {
    auth: authProvider,
    runtime: codeToolRuntime,
    assertCompany: async (ctx, companyId) => { await workspaceStore.getCompany(ctx, companyId); },
  });
}
