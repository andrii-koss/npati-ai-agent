/* The project orchestrator and the email automation hooks of app.ts, extracted in step 2c-6g of
 * docs/refactoring/PLAN.md. Moved verbatim inside a factory that returns both.
 * Moved verbatim inside a factory that returns everything app.ts still uses.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { CompanyRunQueueProducer } from "./company-run-queue";
import { CompanyDelegationRuntime } from "./company-runtime";
import { CompanyToolRuntime } from "./company-tool-runtime";
import { createCoreServices } from "./core-services";
import { createDataBackendServices } from "./data-backend-services";
import { bootstrapWebsiteData, isCommerceWebsite } from "./data-studio/website-bootstrap";
import { EmailAgentTools } from "./email-agent-tools";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { ProjectBrowserQaService } from "./project-browser-qa-service";
import { ProjectDeployService } from "./project-deploy-service";
import { ProjectFileLeaseManager } from "./project-file-lock";
import { ProjectGitService } from "./project-git-service";
import { ProjectOrchestrationError, ProjectOrchestrator } from "./project-orchestrator";
import { ProjectPreviewService } from "./project-preview-service";
import { ProjectSandboxService } from "./project-sandbox-service";
import { ProjectService } from "./project-service";
import { AuthContext } from "@npati/workspace";
import { AgentDataStudioService } from "./data-studio/agent-data-service";
import { DataStudioUiService } from "./data-studio/studio-service";
import { ProjectApiGatewayService } from "./data-studio/gateway-service";
import { EmailAttachmentStorage } from "./email-attachment-storage";
import { CompanyAutomationsRepository } from "./automations-repository";
import { createCodePortsWiring } from "./code-ports-wiring";

export interface CreateEmailAutomationWiringDeps {
  config: AppConfig;
  getAutomationsRepo: () => CompanyAutomationsRepository;
  log: FastifyBaseLogger;
  agent: ReturnType<typeof createCoreServices>["agent"];
  agentDataStudioService: AgentDataStudioService | undefined;
  codeVerifyRunnerPort: ReturnType<typeof createCodePortsWiring>["codeVerifyRunnerPort"];
  companyRuntime: CompanyDelegationRuntime;
  dataBackendRepository: ReturnType<typeof createDataBackendServices>["dataBackendRepository"];
  dataBackendService: ReturnType<typeof createDataBackendServices>["dataBackendService"];
  dataProvider: ReturnType<typeof createDataBackendServices>["dataProvider"];
  dataStudioService: DataStudioUiService | undefined;
  emailAgentTools: EmailAgentTools;
  emailAttachmentStorage: EmailAttachmentStorage | undefined;
  projectApiGatewayService: ProjectApiGatewayService | undefined;
  projectAuthService: ReturnType<typeof createDataBackendServices>["projectAuthService"];
  projectBrowserQaService: ProjectBrowserQaService;
  projectDeployService: ProjectDeployService;
  projectFileLeaseManager: ProjectFileLeaseManager;
  projectGitService: ProjectGitService;
  projectMigrationEngine: ReturnType<typeof createDataBackendServices>["projectMigrationEngine"];
  projectPreviewService: ProjectPreviewService;
  projectRedirectRepository: ReturnType<typeof createDataBackendServices>["projectRedirectRepository"];
  projectSandbox: ProjectSandboxService | undefined;
  projectService: ProjectService;
  projectWorkspace: MountedWorkspaceProvider;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
}

export function createEmailAutomationWiring(deps: CreateEmailAutomationWiringDeps) {
  const { config, log, getAutomationsRepo, agent, agentDataStudioService, codeVerifyRunnerPort, companyRuntime, dataBackendRepository, dataBackendService, dataProvider, dataStudioService, emailAgentTools, emailAttachmentStorage, projectApiGatewayService, projectAuthService, projectBrowserQaService, projectDeployService, projectFileLeaseManager, projectGitService, projectMigrationEngine, projectPreviewService, projectRedirectRepository, projectSandbox, projectService, projectWorkspace, workspaceStore } = deps;
  const projectOrchestrator = new ProjectOrchestrator(
    workspaceStore,
    projectService,
    projectWorkspace,
    projectSandbox,
    projectPreviewService,
    companyRuntime,
    projectGitService,
    projectDeployService,
    projectBrowserQaService,
    dataBackendService,
    projectRedirectRepository,
    // C12: the **one** lease manager of the deployment. `CompanyToolRuntime` above already holds this exact
    // instance, so a path locked by the project task graph and the same path locked by a `project.files.*` tool
    // are one lock instead of two managers that cannot see each other.
    projectFileLeaseManager,
    /**
     * C12: the mandatory verification after the merges, over the **same** `codeVerifyRunnerPort` the
     * `code.verify.run` tool uses. There is no second verification path: the final check replays the project's
     * configured `lint`/`typecheck`/`test`/`build` commands exactly as the tool does, and a deployment with no
     * sandbox reports `unavailable` rather than a pass.
     */
    codeVerifyRunnerPort
      ? {
          run: async ({ ctx, companyId, projectId, tools, changedOnly, timeoutMs }) =>
            codeVerifyRunnerPort.run({
              ctx, companyId, projectId, tools: [...tools], changedOnly, timeoutMs,
            }),
        }
      : undefined,
    async (ctx, project, prompt) => {
      if (!dataBackendService || !dataBackendRepository || !dataProvider || !projectMigrationEngine || !agentDataStudioService || !projectAuthService || !projectApiGatewayService || !dataStudioService) {
        if (isCommerceWebsite(prompt)) throw new ProjectOrchestrationError("DATA_STUDIO_UNAVAILABLE", "Project database service is unavailable. Configure Data Studio and postgres-projects before creating the store.", 503);
        return;
      }
      await bootstrapWebsiteData(ctx, project, prompt, { backends: dataBackendService, repository: dataBackendRepository, provider: dataProvider, migrations: projectMigrationEngine, agentData: agentDataStudioService, auth: projectAuthService, gateway: projectApiGatewayService, studio: dataStudioService, workspace: projectWorkspace });
    },
  );
  const companyRunQueue = config.redisUrl ? new CompanyRunQueueProducer(config.redisUrl) : undefined;
  const emailAutomationHooks = {
    createTask: async ({ ctx, companyId, thread, inboundMessage, assignedAgentId }: {
      ctx: AuthContext; companyId: string; thread: import("./email-inbox-types").CompanyEmailThread;
      inboundMessage: import("./email-inbox-types").CompanyEmailMessage; assignedAgentId?: string | null;
    }) => {
      const created = await workspaceStore.createCompanyAgentRun(ctx, companyId, {
        task: `Handle inbound email "${thread.subject}" from ${thread.customerEmail}. Thread: ${thread.id}. Message: ${inboundMessage.id}.${assignedAgentId ? ` Assigned agent: ${assignedAgentId}.` : ""}`,
        requestedMode: assignedAgentId ? "single" as const : "auto" as const,
      }, `email-task:${inboundMessage.id}`);
      if (created.created && companyRunQueue) {
        await companyRunQueue.enqueue({ context: ctx, companyId, runId: created.run.id });
      }
      return created.run.id;
    },
    continueTask: async ({ ctx, companyId, thread, inboundMessage, awaitingRunId }: {
      ctx: AuthContext; companyId: string; thread: import("./email-inbox-types").CompanyEmailThread;
      inboundMessage: import("./email-inbox-types").CompanyEmailMessage; awaitingRunId: string;
    }) => {
      const verification = emailAgentTools.extractVerification(inboundMessage.bodyText);
      const created = await workspaceStore.createCompanyAgentRun(ctx, companyId, {
        task: [
          `Continue Agent Task ${awaitingRunId} after receiving its awaited email reply.`,
          typeof thread.metadata.awaitingBrowserJobId === "string"
            ? `Resume Browser Job ${thread.metadata.awaitingBrowserJobId} with profile ${String(thread.metadata.awaitingBrowserProfileId || "default")} using browser.resume.${typeof thread.metadata.awaitingBrowserCampaignTargetId === "string" ? ` Include campaignTargetId ${thread.metadata.awaitingBrowserCampaignTargetId} in the browser input.` : ""}`
            : "",
          `Thread: ${thread.id}. Sender: ${inboundMessage.fromAddress}. Subject: ${inboundMessage.subject}.`,
          verification.verificationCode ? `Verification code: ${verification.verificationCode}.` : "",
          verification.token ? `Verification token: ${verification.token}.` : "",
          verification.verificationLinks.length ? `Verification links: ${verification.verificationLinks.join(", ")}.` : "",
          `Email body:\n${inboundMessage.bodyText}`,
        ].filter(Boolean).join("\n"),
        requestedMode: "auto" as const,
      }, `email-continuation:${inboundMessage.id}:${awaitingRunId}`);
      if (created.created && companyRunQueue) {
        await companyRunQueue.enqueue({ context: ctx, companyId, runId: created.run.id });
      }
      return created.run.id;
    },
    startWorkflow: async ({ ctx, companyId, thread, inboundMessage, workflowId }: {
      ctx: AuthContext; companyId: string; thread: import("./email-inbox-types").CompanyEmailThread;
      inboundMessage: import("./email-inbox-types").CompanyEmailMessage; workflowId: string;
    }) => {
      const workflow = await getAutomationsRepo().get(ctx, companyId, workflowId);
      if (workflow.status !== "active") throw new Error(`Email workflow ${workflowId} is not active`);
      const created = await workspaceStore.createCompanyAgentRun(ctx, companyId, {
        task: [
          workflow.prompt,
          "\nEmail trigger context:",
          `Thread: ${thread.id}. Sender: ${inboundMessage.fromAddress}. Subject: ${inboundMessage.subject}.`,
          `Message:\n${inboundMessage.bodyText}`,
          workflow.agentId ? `Assigned workflow agent: ${workflow.agentId}.` : "",
        ].filter(Boolean).join("\n"),
        requestedMode: workflow.agentId ? "single" as const : "auto" as const,
      }, `email-workflow:${workflow.id}:${inboundMessage.id}`);
      if (created.created && companyRunQueue) {
        await companyRunQueue.enqueue({ context: ctx, companyId, runId: created.run.id });
      }
      return created.run.id;
    },
    persistAttachments: emailAttachmentStorage
      ? async ({ ctx, companyId, thread, attachments }: {
          ctx: AuthContext; companyId: string; thread: import("./email-inbox-types").CompanyEmailThread;
          attachments: import("./email-inbox-types").EmailAttachment[];
        }) => emailAttachmentStorage.persist(ctx, companyId, thread.id, attachments)
      : undefined,
  };

  return {
    projectOrchestrator,
    companyRunQueue,
    emailAutomationHooks,
  };
}
