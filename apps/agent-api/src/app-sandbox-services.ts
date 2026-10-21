import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { WorkspaceStore } from "@npati/workspace";
import type { AppConfig } from "./app";
import type { createDataBackendServices } from "./data-backend-services";
import type { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import type { ProjectService } from "./project-service";
import type { BrowserCredentialsRepository } from "./browser-credentials-repository";
import { ProjectApiGatewayService } from "./data-studio/gateway-service";
import { DataStudioUiService } from "./data-studio/studio-service";
import { AgentDataStudioService } from "./data-studio/agent-data-service";
import { ProjectTerminalEventsRepository } from "./project-terminal-events";
import { ProjectSandboxService } from "./project-sandbox-service";
import { RemoteSandboxProvider, projectRuntimeMode } from "./sandbox-provider";

export interface AppSandboxServicesDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  workspaceStore: WorkspaceStore;
  projectService: ProjectService;
  projectWorkspace: MountedWorkspaceProvider;
  dataBackendService?: ReturnType<typeof createDataBackendServices>["dataBackendService"];
  dataBackendRepository?: ReturnType<typeof createDataBackendServices>["dataBackendRepository"];
  databaseProvisioner?: ReturnType<typeof createDataBackendServices>["databaseProvisioner"];
  dataProvider?: ReturnType<typeof createDataBackendServices>["dataProvider"];
  projectAuthService?: ReturnType<typeof createDataBackendServices>["projectAuthService"];
  quotaService?: ReturnType<typeof createDataBackendServices>["quotaService"];
  projectMigrationEngine?: ReturnType<typeof createDataBackendServices>["projectMigrationEngine"];
  promoteService?: ReturnType<typeof createDataBackendServices>["promoteService"];
  browserCredentials?: BrowserCredentialsRepository;
  initialProjectSandbox?: ProjectSandboxService;
}

export function createAppSandboxServices(deps: AppSandboxServicesDeps) {
  const {
    config,
    log,
    workspaceStore,
    projectService,
    projectWorkspace,
    dataBackendService,
    dataBackendRepository,
    databaseProvisioner,
    dataProvider,
    projectAuthService,
    quotaService,
    projectMigrationEngine,
    promoteService,
    browserCredentials,
    initialProjectSandbox,
  } = deps;

  const projectApiGatewayService =
    dataBackendRepository && databaseProvisioner
      ? new ProjectApiGatewayService(
          workspaceStore,
          dataBackendRepository,
          databaseProvisioner,
          projectAuthService as never,
          dataProvider as never,
          undefined,
          projectWorkspace,
          quotaService,
        )
      : undefined;

  const dataStudioService =
    dataBackendRepository && databaseProvisioner && dataProvider && projectMigrationEngine
      ? new DataStudioUiService(
          workspaceStore,
          dataBackendRepository,
          dataProvider as never,
          projectMigrationEngine,
          projectApiGatewayService,
        )
      : undefined;

  const agentDataStudioService =
    dataBackendRepository && dataProvider && projectMigrationEngine
      ? new AgentDataStudioService(
          workspaceStore,
          dataBackendRepository,
          dataProvider as never,
          projectMigrationEngine,
          projectWorkspace,
          projectAuthService as never,
          promoteService,
          dataBackendService ? async (ctx, companyId, projectId, name) => {
            const result = await dataBackendService.ensureForProject(ctx, companyId, projectId, name, async backend => {
              await projectAuthService?.ensureInitialized(ctx, backend, "dev");
              const environment = await projectApiGatewayService?.getSandboxEnvironment(ctx, companyId, projectId) ?? {};
              const origin = process.env.NPATI_WEB_ORIGIN;
              if (origin) await dataStudioService?.registerPreviewCorsOrigin(ctx, companyId, projectId, "dev", new URL(origin).origin);
              return environment;
            });
            const environment = result.environment ?? {};
            if (result.created) {
              const setting = await workspaceStore.getUserSetting(ctx, "chat-development-processes:v1");
              const processes = Array.isArray(setting?.value) ? setting.value as import("@npati/shared").DevelopmentProcess[] : [];
              const process = processes.find(item => item.projectId === projectId && item.companyId === companyId);
              if (process?.conversationId) await workspaceStore.appendNeutralMessage(ctx, process.conversationId, "assistant",
                process.responseLanguage === "uk" ? "\u0421\u0442\u0432\u043e\u0440\u0435\u043d\u043e \u0431\u0430\u0437\u0443 \u0434\u0430\u043d\u0438\u0445 \u00ab" + result.backend.name + "\u00bb \u0434\u043b\u044f \u0446\u044c\u043e\u0433\u043e \u043f\u0440\u043e\u0454\u043a\u0442\u0443." : "Created database: " + result.backend.name + ".");
            }
            return { ...result, environment };
          } : undefined,
        )
      : undefined;

  const projectTerminalEvents = new ProjectTerminalEventsRepository(
    projectService,
    config.databaseUrl ? (workspaceStore as unknown as { pool: Pool }).pool : undefined,
  );

  let projectSandbox: ProjectSandboxService | undefined = initialProjectSandbox;
  const sandboxRunnerUrl = process.env.NPATI_SANDBOX_RUNNER_URL;
  const sandboxRunnerSecret = process.env.NPATI_SANDBOX_RUNNER_SECRET;
  if (!projectSandbox && sandboxRunnerUrl && sandboxRunnerSecret) {
    projectSandbox = new ProjectSandboxService(
      projectService,
      workspaceStore,
      projectWorkspace,
      new RemoteSandboxProvider(
        sandboxRunnerUrl,
        sandboxRunnerSecret,
        fetch,
        undefined,
        projectRuntimeMode({
          ...process.env,
          ...(config.deploymentType ? { NPATI_DEPLOYMENT_TYPE: config.deploymentType } : {}),
        }),
      ),
      projectTerminalEvents,
      browserCredentials,
      {
        commandTimeoutMs: Number(process.env.NPATI_TERMINAL_TIMEOUT_MS) || undefined,
        installBuildTimeoutMs: Number(process.env.NPATI_TERMINAL_BUILD_TIMEOUT_MS) || undefined,
        outputLimitBytes: Number(process.env.NPATI_TERMINAL_OUTPUT_LIMIT_BYTES) || undefined,
        inactivityMs: Number(process.env.NPATI_SANDBOX_IDLE_MS) || undefined,
        syncMaxFiles: Number(process.env.NPATI_SANDBOX_SYNC_MAX_FILES) || undefined,
        syncMaxBytes: Number(process.env.NPATI_SANDBOX_SYNC_MAX_BYTES) || undefined,
        retentionMs: Number(process.env.NPATI_SANDBOX_RETENTION_MS) || undefined,
      },
      projectApiGatewayService
        ? async (ctx, companyId, projectId) => {
            const project = await projectService.get(ctx, companyId, projectId);
            return project.dataBackendId
              ? projectApiGatewayService.getSandboxEnvironment(ctx, companyId, projectId)
              : {};
          }
        : undefined,
    );
  }

  const sandboxIdleTimer = projectSandbox
    ? setInterval(() => {
        void projectSandbox?.stopInactive();
      }, 60_000)
    : undefined;
  sandboxIdleTimer?.unref();

  const sandboxRetentionTimer = projectSandbox
    ? setInterval(() => {
        void (async () => {
          try {
            const refs = await workspaceStore.listCodeProjectRefs({ companyId: null, limit: 500 });
            for (const ref of refs.items) {
              const project = await workspaceStore
                .getProjectForSystem(ref.companyId, ref.projectId)
                .catch(() => null);
              if (project) {
                await projectSandbox!.trackForRetention(
                  { workspaceId: project.workspaceId, userId: project.createdBy, permissions: [] },
                  project,
                );
              }
            }
          } catch (error) {
            log.warn({ err: error }, "sandbox_retention_tracking_failed");
          }
          const result = await projectSandbox!.sweepRetention().catch((error) => {
            log.warn({ err: error }, "sandbox_retention_sweep_failed");
            return null;
          });
          if (result && result.destroyed > 0) log.info(result, "sandbox_retention_swept");
        })();
      }, 60_000)
    : undefined;
  sandboxRetentionTimer?.unref();

  return {
    projectApiGatewayService,
    dataStudioService,
    agentDataStudioService,
    projectTerminalEvents,
    projectSandbox,
    sandboxRunnerUrl,
    sandboxRunnerSecret,
    sandboxIdleTimer,
    sandboxRetentionTimer,
  };
}
