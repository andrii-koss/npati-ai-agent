import { databaseCreatedMessage } from "./database-created-i18n";
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
import { createCompanyProjectCleanup, startProjectOrphanSweep } from "./project-orphan-sweep";

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
  /** Where API project workspaces live: `<root>/<companyId>/<projectId>`. */
  projectWorkspaceRoot?: string;
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
    projectWorkspaceRoot,
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
              if (process?.conversationId) {
                const latestUser = (await workspaceStore.getNeutralConversation(ctx, process.conversationId).catch(() => ({ messages: [] as { role: string; content: string }[] })))
                  .messages.filter(message => message.role === "user").at(-1)?.content;
                await workspaceStore.appendNeutralMessage(ctx, process.conversationId, "assistant", databaseCreatedMessage(result.backend.name, latestUser, process.responseLanguage));
              }
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
  const runnerClient = !projectSandbox && sandboxRunnerUrl && sandboxRunnerSecret
    ? new RemoteSandboxProvider(
        sandboxRunnerUrl,
        sandboxRunnerSecret,
        undefined,
        undefined,
        projectRuntimeMode({
          ...process.env,
          ...(config.deploymentType ? { NPATI_DEPLOYMENT_TYPE: config.deploymentType } : {}),
        }),
      )
    : undefined;
  if (runnerClient) {
    projectSandbox = new ProjectSandboxService(
      projectService,
      workspaceStore,
      projectWorkspace,
      runnerClient,
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

  // A project gone from the database leaves no files: deleting a company removes its projects first, and a sweep
  // removes whatever an earlier deletion left in the API workspace or the runner. NPATI_PROJECT_ORPHAN_SWEEP=off stops it.
  const pool = config.databaseUrl ? (workspaceStore as unknown as { pool?: Pool }).pool : undefined;
  const removeCompanyProjects = projectWorkspaceRoot
    ? createCompanyProjectCleanup({
        listProjects: (ctx, companyId) => workspaceStore.listProjects(ctx, companyId, true),
        deleteProject: (ctx, companyId, projectId) => projectService.delete(ctx, companyId, projectId),
        removeWorkspace: (ctx, companyId, projectId) => projectWorkspace.removeProjectWorkspace(ctx, companyId, projectId),
        workspaceRoot: projectWorkspaceRoot,
      })
    : undefined;
  const stopOrphanSweep = pool && projectWorkspaceRoot && process.env.NPATI_PROJECT_ORPHAN_SWEEP !== "off"
    ? startProjectOrphanSweep({
        listProjectIds: async () => (await pool.query<{ id: string }>("SELECT id FROM projects")).rows.map((row) => row.id),
        workspaceRoot: projectWorkspaceRoot,
        runner: runnerClient,
        log,
      }, Math.max(60_000, (Number(process.env.NPATI_PROJECT_ORPHAN_SWEEP_SECONDS) || 600) * 1000))
    : undefined;

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
    removeCompanyProjects,
    stopOrphanSweep,
  };
}
