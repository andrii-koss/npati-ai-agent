
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { registerA2AControlPlaneRoutes } from "./a2a-control-plane-routes";
import { registerApiKeyRoutes } from "./api-keys-routes";
import { CompanyApprovalsRepository } from "./approvals-repository";
import { registerCompanyApprovalsRoutes } from "./approvals-routes";
import { registerAuditRoutes } from "./audit-routes";
import { createAuditServices } from "./audit-services";
import { AutomationScheduler } from "./automation-scheduler";
import { CompanyAutomationsRepository } from "./automations-repository";
import { registerCompanyAutomationsRoutes } from "./automations-routes";
import { registerBrowserAutomationRoutes } from "./browser-automation-routes";
import { BrowserCredentialsRepository } from "./browser-credentials-repository";
import { registerBrowserCredentialsRoutes } from "./browser-credentials-routes";
import { BrowserUseClient } from "./browser-tool";
import { isShortAffirmativeReply, requestsCompositeCompanyDeletionIntent } from "./chat-intent-helpers";
import { publicCompanyRunMessage } from "./chat-public-errors";
import { registerCodeApprovalRoutes } from "./code-approval-routes";
import { CodeApprovalScopeService } from "./code-approval-scope";
import { createCodeUserQuestionReaperPort } from "./code-ask-user-reaper";
import { registerCodeAskUserRoutes } from "./code-ask-user-routes";
import { CodeDataErasureService } from "./code-data-erasure";
import { registerCodeDataErasureRoutes } from "./code-data-erasure-routes";
import { registerCodeGoalRoutes } from "./code-goal-routes";
import { createCodeInstructionsLoader } from "./code-instructions-loader";
import { CodeMountedFolderService } from "./code-mounted-folder";
import { registerCodeExecutionModeRoutes } from "./code-execution-mode-routes";
import { registerCodeMountedFolderRoutes } from "./code-mounted-folder-routes";
import { registerCodeProjectInstructionsRoutes } from "./code-project-instructions-routes";
import { CodeProjectTrustService } from "./code-project-trust";
import { registerCodeProjectTrustRoutes } from "./code-project-trust-routes";
import { CodeRbac } from "./code-rbac";
import { activitySinkForKind, createCodeRunActivitySink } from "./code-run-activity-sink";
import { CodeRunStateLog } from "./code-run-state";
import { CodeService } from "./code-service";
import { CodeSessionModeService } from "./code-session-mode-routes";
import { CodePrivilegedAuditPort } from "./code-step-up";
import { CompanyChatActions } from "./company-chat-actions";
import { CompanyKnowledgeProcessor } from "./company-knowledge";
import { CompanyKnowledgeQueue } from "./company-knowledge-queue";
import { registerCompanyKnowledgeRoutes } from "./company-knowledge-routes";
import { CompanyRunQueueProducer } from "./company-run-queue";
import { CompanyDelegationRuntime } from "./company-runtime";
import { registerCompanyRuntimeRoutes } from "./company-runtime-routes";
import { CompanyToolRuntime } from "./company-tool-runtime";
import { registerContentLibraryRoutes } from "./content-library-routes";
import { ContentLibraryStore } from "./content-library-store";
import { createCoreServices } from "./core-services";
import { resolveEgressAllowlist } from "./egress-allowlist";
import { EmailAutomationHooks } from "./email-ai-processor";
import { EmailAttachmentStorage } from "./email-attachment-storage";
import { EmailChatActions } from "./email-chat-actions";
import { EmailInboxRepository } from "./email-inbox-repository";
import { emailEnvelopeToGatewayMessage } from "./email-messaging-adapter";
import { registerEmailInboxRoutes } from "./email-routes";
import { EmailInboxWorker } from "./email-worker";
import { PerRequestNoMemoryGate } from "./ephemeral-no-memory-and-rtk";
import { FeatureFlagService } from "./feature-flags";
import { registerGuardrailPolicyRoutes } from "./guardrail-policy-routes";
import { IntegrationsRepository } from "./integrations-repository";
import { registerIntegrationsRoutes } from "./integrations-routes";
import { serviceIdentityForAutomation } from "./code-service-identity";
import { McpApprovalReleaseReason, mcpApprovalRunIdOf, releaseMcpApprovalPause } from "./mcp-approval";
import { registerMcpPolicyRoutes } from "./mcp-policy-routes";
import { applyMcpRiskOverride } from "./mcp-risk-override";
import { McpRuntimeCapabilityStore } from "./mcp-runtime-capabilities";
import { McpToolPolicyStore } from "./mcp-tool-policy-repository";
import { registerMemoryDocumentRoutes } from "./memory-document-routes";
import { GatewayOutboundAttachment, MessagingGateway, formatTelegramCards } from "./messaging-gateway";
import { MessagingIntegrationsRepository } from "./messaging-integrations-repository";
import { registerMessagingIntegrationRoutes } from "./messaging-integrations-routes";
import { MessagingScopeRouter } from "./messaging-scope-router";
import { registerMultimodalRoutes } from "./multimodal-routes";
import { NetworkActivityRecorder } from "./network-activity";
import { registerNetworkRoutes } from "./network-routes";
import { createProductionResilientAIEngine } from "./production-resilient-ai-engine";
import { ProjectBrowserQaService } from "./project-browser-qa-service";
import { registerProjectDeployRoutes } from "./project-deploy-routes";
import { ProjectDeployService } from "./project-deploy-service";
import { mountedFolderRoots } from "./project-mount-policy";
import { registerProjectQaRoutes } from "./project-qa-routes";
import { registerReliabilityAndOperationsRoutes } from "./reliability-and-operations-routes";
import { resolveEgressEnforcement } from "./sandbox-egress-enforcement";
import { registerScopedMemoryRoutes } from "./scoped-memory-routes";
import { WorkspaceChatActions } from "./workspace-chat-actions";
import { AuthContext, Business } from "@npati/workspace";
import path from "node:path";
import { ChatAttachmentInput } from "./chat-attachments";
import { ResearchProgressListener } from "@npati/web-research";
import { NoMemoryEvaluationResult } from "./ephemeral-no-memory-and-rtk";

export interface PlatformRouteDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  systemWorkspaceId: string;
  agent: ReturnType<typeof createCoreServices>["agent"];
  aiEngine: ReturnType<typeof createProductionResilientAIEngine>;
  apiKeysRepo: ReturnType<typeof createCoreServices>["apiKeysRepo"];
  approvalsRepo: CompanyApprovalsRepository | undefined;
  auditLogService: ReturnType<typeof createAuditServices>["auditLogService"];
  auditRepo: ReturnType<typeof createAuditServices>["auditRepo"];
  authProvider: ReturnType<typeof createCoreServices>["authProvider"];
  automationScheduler: AutomationScheduler;
  automationsRepo: CompanyAutomationsRepository;
  browserCredentials: BrowserCredentialsRepository | undefined;
  browserTool: BrowserUseClient | undefined;
  chatFiles: ReturnType<typeof createCoreServices>["chatFiles"];
  codeActivitySink: ReturnType<typeof createCodeRunActivitySink>;
  codeApprovalScope: CodeApprovalScopeService;
  codeDataErasure: CodeDataErasureService;
  codeErasureContexts: WeakMap<object, AuthContext>;
  codeInstructionsLoader: ReturnType<typeof createCodeInstructionsLoader>;
  codePrivilegedAudit: CodePrivilegedAuditPort | undefined;
  codeProjectTrust: CodeProjectTrustService;
  codeRbacForRun: CodeRbac;
  codeRunStateLog: CodeRunStateLog;
  codeService: CodeService;
  codeSessionModes: CodeSessionModeService;
  companyRunQueue: CompanyRunQueueProducer | undefined;
  companyRuntime: CompanyDelegationRuntime;
  companyToolRuntime: CompanyToolRuntime;
  contentLibrary: ContentLibraryStore;
  egressAllowlist: ReturnType<typeof resolveEgressAllowlist>;
  egressEnforcement: ReturnType<typeof resolveEgressEnforcement>;
  emailAttachmentStorage: EmailAttachmentStorage | undefined;
  emailAutomationHooks: EmailAutomationHooks;
  emailInboxRepo: EmailInboxRepository;
  emailInboxWorker: EmailInboxWorker;
  featureFlagService: FeatureFlagService;
  fileRepository: ReturnType<typeof createCoreServices>["fileRepository"];
  guardrailPolicies: ReturnType<typeof createCoreServices>["guardrailPolicies"];
  integrationsRepo: IntegrationsRepository;
  knowledgeProcessor: CompanyKnowledgeProcessor | undefined;
  knowledgeQueue: CompanyKnowledgeQueue | undefined;
  knowledgeRepo: ReturnType<typeof createCoreServices>["knowledgeRepo"];
  mcpRuntimeCapabilities: McpRuntimeCapabilityStore;
  mcpToolPolicyStore: McpToolPolicyStore;
  memoryDocuments: ReturnType<typeof createCoreServices>["memoryDocuments"];
  messagingGateway: MessagingGateway;
  messagingIntegrationsRepo: MessagingIntegrationsRepository;
  messagingScopeRouter: MessagingScopeRouter;
  networkActivity: NetworkActivityRecorder;
  objectStorage: ReturnType<typeof createCoreServices>["objectStorage"];
  persistAutomaticCompanyMemory: (auth: AuthContext, companyId: string, runId: string, prompt: string, runStatus: string, noMemory: boolean) => Promise<unknown>;
  persistBusinessLogo: ReturnType<typeof createCoreServices>["persistBusinessLogo"];
  projectBrowserQaService: ProjectBrowserQaService;
  projectDeployService: ProjectDeployService;
  projectWorkspaceRoot: string;
  runAutomation: (automation: import("./automations-repository").CompanyAutomation, executionKey: string) => Promise<{ result: string }>;
  runNeutralMessage: (auth: AuthContext, message: string, conversationId: string | undefined, attachments?: ChatAttachmentInput[], progress?: ResearchProgressListener, memoryPolicy?: NoMemoryEvaluationResult, onDelta?: (chunk: string) => void, signal?: AbortSignal, managementCompany?: { id: string; name: string }) => Promise<{ message: string; companyAction?: { companyId: string; action: string } }>;
  scopedMemory: ReturnType<typeof createCoreServices>["scopedMemory"];
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
}

export interface PlatformRoutePorts {
  codeUserQuestionReaperPort: ReturnType<typeof createCodeUserQuestionReaperPort>;
  mcpApprovalPauseRelease: ((input: { companyId: string; runId: string; approvalId: string; reason: McpApprovalReleaseReason; answeredBy?: string }) => Promise<unknown>) | null;
}

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDeps): PlatformRoutePorts {
  const { log, systemWorkspaceId, agent, aiEngine, apiKeysRepo, approvalsRepo, auditLogService, auditRepo, authProvider, automationScheduler, automationsRepo, browserCredentials, browserTool, chatFiles, codeActivitySink, codeApprovalScope, codeDataErasure, codeErasureContexts, codeInstructionsLoader, codePrivilegedAudit, codeProjectTrust, codeRbacForRun, codeRunStateLog, codeService, codeSessionModes, companyRunQueue, companyRuntime, companyToolRuntime, config, contentLibrary, egressAllowlist, egressEnforcement, emailAttachmentStorage, emailAutomationHooks, emailInboxRepo, emailInboxWorker, featureFlagService, fileRepository, guardrailPolicies, integrationsRepo, knowledgeProcessor, knowledgeQueue, knowledgeRepo, mcpRuntimeCapabilities, mcpToolPolicyStore, memoryDocuments, messagingGateway, messagingIntegrationsRepo, messagingScopeRouter, networkActivity, objectStorage, persistAutomaticCompanyMemory, persistBusinessLogo, projectBrowserQaService, projectDeployService, projectWorkspaceRoot, runAutomation, runNeutralMessage, scopedMemory, workspaceStore } = deps;
  registerCodeDataErasureRoutes(app, {
    erasure: codeDataErasure,
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeErasureContexts.get(request as object) ?? null,
    logger: log,
  });

  const codeGoalContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/goals(\/|$)|\/code\/sessions\/[^/]+\/(plan|todos)(\/decide)?$/.test(path)) return;
    codeGoalContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeGoalRoutes(app, {
    store: workspaceStore,
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeGoalContexts.get(request as object) ?? null,
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    applyExecutionMode: async ({ ctx, companyId, sessionId, mode }) => {

      const session = await codeService.getSession(ctx, companyId, sessionId);
      await codeSessionModes.setMode(ctx, companyId, sessionId, {
        mode: String(mode),
        expectedRevision: session.revision,
        reason: "plan_approved",
      });
    },
    logger: log,
  });

  const codeInstructionsContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/(?:instructions(?:\/init)?|trust(?:\/revoke)?|mounted-folder(?:\/revoke)?)$/.test(path)) return;
    codeInstructionsContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeProjectInstructionsRoutes(app, {
    loadInstructions: async ({ ctx, companyId, projectId, targetPaths }) =>
      codeInstructionsLoader.load({
        ctx,
        companyId,
        projectId,
        ...(targetPaths === undefined ? {} : { targetPaths }),
      }),
    buildDraft: async ({ ctx, companyId, projectId }) =>
      codeInstructionsLoader.buildDraft({ ctx, companyId, projectId }),

    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeInstructionsContexts.get(request as object) ?? null,
    logger: log,
  });
  registerCodeProjectTrustRoutes(app, {
    trust: {
      get: async (ctx, companyId, projectId) => codeProjectTrust.get(ctx, companyId, projectId),

      trust: async (ctx, companyId, projectId, input) => codeProjectTrust.trust(ctx, companyId, projectId, input),
      revoke: async (ctx, companyId, projectId, input) => codeProjectTrust.revoke(ctx, companyId, projectId, input),
    },
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeInstructionsContexts.get(request as object) ?? null,
    logger: log,
  });

  const codeMountedFolder = new CodeMountedFolderService({
    store: workspaceStore,
    flags: featureFlagService,
    roots: mountedFolderRoots(),
    protectedRoots: config.dataDirectory ? [path.resolve(config.dataDirectory)] : [],
    projectWorkspacesRoot: projectWorkspaceRoot,
    audit: auditLogService
      ? {
          record: async (input) => {
            await auditLogService.record(
              { workspaceId: systemWorkspaceId, userId: input.actor, permissions: [] } as AuthContext,
              {
                companyId: input.companyId, actor: input.actor, actorRole: "owner", action: input.action,
                resourceType: input.resourceType, resourceId: input.resourceId,
                decision: input.decision === "deny" ? "denied" : "allowed",
                payload: { action: input.action, target: input.resourceId },
                metadata: input.metadata ?? {},
              },
            );
          },
        }
      : undefined,
  });
  registerCodeExecutionModeRoutes(app, { auth: authProvider, flags: featureFlagService, code: codeService, mounts: codeMountedFolder });
  registerCodeMountedFolderRoutes(app, {
    mountedFolder: {
      get: async (ctx, companyId, projectId) => codeMountedFolder.get(ctx, companyId, projectId),
      confirm: async (ctx, companyId, projectId, input) => codeMountedFolder.confirm(ctx, companyId, projectId, input),
      revoke: async (ctx, companyId, projectId, input) => codeMountedFolder.revoke(ctx, companyId, projectId, input),
    },
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeInstructionsContexts.get(request as object) ?? null,
    logger: log,
  });

  registerCodeApprovalRoutes(app, authProvider, { store: workspaceStore, scope: codeApprovalScope });

  const codeQuestionContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/(?:runs\/[^/]+\/question|sessions\/[^/]+\/questions\/[^/]+\/answer)$/.test(path)) return;
    codeQuestionContexts.set(request, await authProvider.authenticate(request));
  });
  const codeQuestionActivity = async (event: {
    kind: "question_asked" | "question_answered" | "question_expired" | "question_cancelled";
    companyId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    questionId: string;
    answeredBy?: string;
  }): Promise<void> => {

    await activitySinkForKind<Record<string, unknown>>(codeActivitySink, "run_activity").record({
      kind: event.kind,
      companyId: event.companyId,
      projectId: event.projectId,
      sessionId: event.sessionId,
      runId: event.runId,
      questionId: event.questionId,
      ...(event.answeredBy ? { answeredBy: event.answeredBy } : {}),
    });
  };
  const codeAskUserRunState = {
    markWaitingForUser: (input: { companyId: string; runId: string; questionId: string; toolCallId: string }) =>
      codeRunStateLog.markWaitingForUser(input),
    resumeAfterAnswer: (input: { companyId: string; runId: string; questionId: string; answeredBy: string }) =>
      codeRunStateLog.resumeAfterAnswer(input),
    markInterrupted: (input: { companyId: string; runId: string; reason: string }) =>
      codeRunStateLog.markInterrupted(input),
  };
  registerCodeAskUserRoutes(app, {
    store: workspaceStore,
    runStatus: async (companyId, runId) => (await workspaceStore.getCodeRunState(companyId, runId))?.status,
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeQuestionContexts.get(request as object) ?? null,
    runState: codeAskUserRunState,
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    onActivity: (event) => { void codeQuestionActivity(event).catch(() => undefined); },
  });
  const codeUserQuestionReaperPort = createCodeUserQuestionReaperPort({
    store: workspaceStore,
    runState: codeAskUserRunState,
    onActivity: (event) => { void codeQuestionActivity(event).catch(() => undefined); },
    now: () => Date.now(),
  });

  const mcpApprovalPauseRelease = async (input: { companyId: string; runId: string; approvalId: string; reason: McpApprovalReleaseReason; answeredBy?: string }): Promise<unknown> => {
    const outcome = await releaseMcpApprovalPause(codeRunStateLog, input);
    if (outcome === "unsupported") {
      log.warn({ ...input, kind: "approval_release_unsupported" }, "mcp_approval_pause_release_unsupported");
    }
    return outcome;
  };

  registerNetworkRoutes(app, {
    auth: authProvider,
    store: workspaceStore,
    recorder: networkActivity,
    enforcement: egressEnforcement,
    allowlist: egressAllowlist,
    audit: auditLogService,
  });
  registerProjectDeployRoutes(app, projectDeployService, authProvider);
  registerProjectQaRoutes(app, projectBrowserQaService, authProvider);
  registerCompanyRuntimeRoutes(app, companyRuntime, authProvider, companyRunQueue);
  if (knowledgeRepo && knowledgeProcessor && objectStorage) registerCompanyKnowledgeRoutes(app,{auth:authProvider,store:workspaceStore,repo:knowledgeRepo,files:fileRepository,storage:objectStorage,processor:knowledgeProcessor,queue:knowledgeQueue});
  if (automationsRepo) registerCompanyAutomationsRoutes(app, {
    auth: authProvider,
    store: workspaceStore,
    repo: automationsRepo,
    scheduler: automationScheduler,
    triggerRun: (automation) => runAutomation(automation, `automation:manual:${automation.id}:${Date.now()}`),
    // Stop on the Automations page (V6 step 12, owner decision): every company run started for this automation is
    // keyed "automation:…<automationId>…"; each active one is cancelled like a chat "stop" (runtime, then the queue).
    stopRuns: async (context, companyId, automationId) => {
      const active = (await workspaceStore.listCompanyAgentRuns(context, companyId, 100))
        .filter((run) => !["completed", "failed", "cancelled"].includes(run.status) && run.idempotencyKey.startsWith("automation:") && run.idempotencyKey.includes(automationId));
      for (const run of active) {
        await companyRuntime.cancel(context, companyId, run.id);
        if (companyRunQueue) await companyRunQueue.cancel({ context, companyId, runId: run.id });
      }
      return active.length;
    },
  });
  app.post<{ Params: { businessId: string }; Body: { filename: string; mimeType: string; data: string } }>(
    "/businesses/:businessId/logo",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      if (!chatFiles) return reply.code(503).send({ error: { code: "STORAGE_UNAVAILABLE", message: "File storage is not configured" } });
      const context = await authProvider.authenticate(request);
      if (!context.permissions.some((permission) => ["*", "owner", "business:manage", "workspace:write"].includes(permission))) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Business management permission is required" } });
      }
      await workspaceStore.getBusiness(context, request.params.businessId);
      const data = Buffer.from(request.body.data, "base64");
      try {
        const business = await persistBusinessLogo(context, request.params.businessId, {
          kind: "image", name: request.body.filename, mimeType: request.body.mimeType, data,
        });
        return reply.code(201).send({ logo: { id: business.logoFileId, kind: "image", name: request.body.filename }, business });
      } catch (error) {
        return reply.code(400).send({ error: { code: "INVALID_LOGO", message: error instanceof Error ? error.message : "Could not save logo" } });
      }
    },
  );
  registerContentLibraryRoutes(app, authProvider, workspaceStore, contentLibrary);
  if (approvalsRepo) registerCompanyApprovalsRoutes(app, {
    auth: authProvider,
    store: workspaceStore,
    repo: approvalsRepo,
    auditLog: auditLogService,

    onDecided: async ({ ctx: decisionCtx, companyId, approval, decision }) => {
      const runId = mcpApprovalRunIdOf(approval.inputPayload);
      if (!runId || !mcpApprovalPauseRelease) return;
      await mcpApprovalPauseRelease({
        companyId,
        runId,
        approvalId: approval.id,
        reason: decision === "approved" ? "approved" : "rejected",
        answeredBy: String(decisionCtx.userId ?? "unknown"),
      });
    },
    logger: log,
  });
  registerMcpPolicyRoutes(app,{
    apiKeys:apiKeysRepo,
    store:workspaceStore,
    tools:companyToolRuntime,

    runtimeRisk:{
      apply: (input) => applyMcpRiskOverride(
        {
          store: mcpRuntimeCapabilities,
          policies: mcpToolPolicyStore,
          ...(auditLogService
            ? {
                audit: {
                  record: async (entry) => {
                    await auditLogService.record(
                      { workspaceId: systemWorkspaceId, userId: entry.actor, permissions: [] } as AuthContext,
                      {
                        companyId: entry.companyId, actor: entry.actor, actorRole: entry.actorRole, action: entry.action,
                        resourceType: entry.resourceType, resourceId: entry.resourceId, decision: entry.decision,
                        payload: entry.payload, metadata: entry.metadata ?? {},
                        ...(entry.requestId ? { requestId: entry.requestId } : {}),
                        ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
                        ...(entry.snapshotId ? { snapshotId: entry.snapshotId } : {}),
                      },
                    );
                  },
                },
              }
            : {}),
        },
        {
          ctx: input.ctx,
          tenant: { workspaceId: input.ctx.workspaceId, companyId: input.companyId },
          toolId: input.toolId,
          risk: input.risk,
          ...(input.approvalRequired === undefined ? {} : { approvalRequired: input.approvalRequired }),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
        },
      ),
    },
  });
  // A webhook is an unattended trigger like a schedule: it runs under the same restricted service identity (V5-D70).
  if (integrationsRepo) registerIntegrationsRoutes(app, { auth: authProvider, store: workspaceStore, repo: integrationsRepo,
    triggerRun: (webhook, prompt, delivery) => companyRuntime.execute(serviceIdentityForAutomation({ companyId: webhook.companyId, automationId: webhook.id, workspaceId: webhook.workspaceId, ownerUserId: webhook.userId }).auth,
      webhook.companyId, { task: prompt, mode: webhook.agentId ? "single" : "auto", preferredAgentId: webhook.agentId ?? undefined }, `webhook:${webhook.id}:${delivery}`) });
  const messagingResultAttachments=async(auth:AuthContext,message:string):Promise<GatewayOutboundAttachment[]>=>{
    if(!chatFiles)return[];const output:GatewayOutboundAttachment[]=[],seen=new Set<string>();
    for(const match of message.matchAll(/\[\[npati-attachment:(image|document|file|audio):([0-9a-f-]{36}):([^\]]+)\]\]/gi)){
      const id=match[2]!;if(seen.has(id))continue;seen.add(id);const opened=await chatFiles.open(auth,id);if(!opened)continue;
      const chunks:Buffer[]=[];let size=0;for await(const chunk of opened.stream){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>49*1024*1024)throw new Error(`Messaging output file ${opened.file.originalFilename} exceeds 49 MB`);chunks.push(bytes);}
      output.push({kind:match[1]!.toLowerCase()==="image"?"image":match[1]!.toLowerCase()==="audio"?"audio":"document",name:decodeURIComponent(match[3]!),mimeType:opened.file.mimeType,dataBase64:Buffer.concat(chunks).toString("base64")});
    }
    return output;
  };
  const messagingResultText = (message: string) => {
    let text = message.replace(/\[\[npati-attachment:(?:image|document|file|audio):[0-9a-f-]{36}:([^\]]+)\]\]/gi, (_all, name) => `📎 Attached file: ${decodeURIComponent(String(name))}`).trim();
    text = formatTelegramCards(text, config.webOrigin);
    return text || "NPATI completed the request and attached the result.";
  };
  const messagingRoutes = registerMessagingIntegrationRoutes(app, {
    auth: authProvider, store: workspaceStore, repo: messagingIntegrationsRepo, gateway: messagingGateway,
    emailRepo: emailInboxRepo,
    webhookBaseUrl: config.messagingWebhookBaseUrl ?? (config.webOrigin?.startsWith("https://") ? config.webOrigin : undefined),
    resetConversation:async({context,conversationId})=>{await workspaceStore.deleteNeutralConversation(context,conversationId);},
    handleMessage: async ({ context, connection, session, text, attachments, conversationId, replyContext, signal, onDelta }) => {
      const scope = await messagingScopeRouter.resolve(context, connection, text, session);
      if (scope.handled) return { message: scope.message || "Messaging context updated." };
      const company = scope.company;
      if(/^\/(?:runs|tasks)$/iu.test(text)){
        if(!company)return{message:"Select a Company with /company Company name before listing runs and Automations."};
        const [runs,automations]=await Promise.all([companyRuntime.list(context,company.id,10),automationsRepo.list(context,company.id)]);
        const runLines=runs.map((run)=>`• ${run.status} — ${run.task.slice(0,100)} (${run.id})`),automationLines=automations.slice(0,10).map((item)=>`• ${item.status} — ${item.name}; next ${item.nextRunAt}`);
        return{message:[`Tasks and runs for ${company.name}:`,runLines.length?runLines.join("\n"):"No Company runs.","\nAutomations:",automationLines.length?automationLines.join("\n"):"No Automations."].join("\n")};
      }
      if(/^\/approvals$/iu.test(text)){
        if(!company)return{message:"Select a Company before listing approvals."};if(!approvalsRepo)return{message:"Persistent approvals are unavailable because the database is not configured."};
        const pending=await approvalsRepo.list(context,company.id,"pending");return{message:pending.length?`Pending approvals:\n${pending.map((item)=>`• ${item.id} — ${item.riskLevel}: ${item.actionSummary}`).join("\n")}\n\nUse /approve ID or /deny ID.`:"No pending approvals."};
      }
      if(/^\/(?:approve|deny)$/iu.test(text))return{message:"Usage: /approve APPROVAL_ID or /deny APPROVAL_ID. Use /approvals to list pending requests."};
      const decision=/^\/(approve|deny)\s+([0-9a-f-]{8,})$/iu.exec(text);if(decision){if(!company)return{message:"Select a Company before deciding an approval."};if(!approvalsRepo)return{message:"Persistent approvals are unavailable because the database is not configured."};const approval=await approvalsRepo.decide(context,company.id,decision[2]!,decision[1]!.toLowerCase()==="approve"?"approved":"rejected","Decision submitted through an authorized messaging connection");return{message:`Approval ${approval.id} is ${approval.status}.`};}
      if (!conversationId) {const created = await workspaceStore.createNeutralConversation(context, connection.channel+": "+connection.displayName);conversationId=created.id;await messagingIntegrationsRepo.setSessionConversation(session,created.id);}
      const runtimeText=replyContext?.text?text+"\n\n"+connection.channel+" reply context (message "+replyContext.messageId+"):\n"+replyContext.text:text;
      const managementRequest = Boolean(text && (isShortAffirmativeReply(text) || requestsCompositeCompanyDeletionIntent(text) || EmailChatActions.isManagementRequest(text) || CompanyChatActions.isManagementRequest(text) || CompanyChatActions.isPotentialMutationRequest(text) || WorkspaceChatActions.isManagementRequest(text) || WorkspaceChatActions.isPotentialMutationRequest(text)));
      if (!company) {
        const result = await runNeutralMessage(context, runtimeText, conversationId, attachments, undefined, PerRequestNoMemoryGate.evaluate(),onDelta,signal);
        if (connection.scope === "account" && result.companyAction?.companyId && result.companyAction.action !== "delete") {
          await messagingIntegrationsRepo.setActiveContext(connection, result.companyAction.companyId, null,session);
        }
        return {...result,message:messagingResultText(result.message),attachments:await messagingResultAttachments(context,result.message)};
      }
      const targetAgent = scope.agent;
      const runnableMainAgent = targetAgent?.isActive ?? (company.mainAgentId ? await workspaceStore.getCompanyAgent(context, company.id, company.mainAgentId).then((agent) => agent.isActive).catch(() => false) : false);
      if (managementRequest || !runnableMainAgent){const result=await runNeutralMessage(context, runtimeText, conversationId, attachments, undefined, PerRequestNoMemoryGate.evaluate(),onDelta,signal,{ id: company.id, name: company.name });return{...result,message:messagingResultText(result.message),attachments:await messagingResultAttachments(context,result.message)};}
      const task = targetAgent ? `Use the specifically bound Company Agent ${targetAgent.name} (id: ${targetAgent.id}) for this request.\n\n${runtimeText || "Analyze the attached files."}` : (runtimeText || "Analyze the attached files.");
      const result = await companyRuntime.execute(context, company.id, { task, mode: targetAgent ? "single" : "auto", preferredAgentId: targetAgent?.id, memoryScope: { sessionId: conversationId } }, connection.channel+":"+connection.id+":"+session.id+":"+Date.now(),signal);
      if (result.run.errorCode === "SECURITY_GUARDRAIL_BLOCKED") throw Object.assign(new Error(result.run.errorMessage || "Request blocked by security guardrails"), { status: 400, code: result.run.errorCode });
      await persistAutomaticCompanyMemory(context, company.id, result.run.id, text, result.run.status, false);
      const message=publicCompanyRunMessage(result.run.result, result.run.errorMessage, text, result.run.errorCode);return { message:messagingResultText(message),attachments:await messagingResultAttachments(context,message) };
    },
  });
  emailInboxWorker.setGatewayHook(async (input) => {
    if (!messagingRoutes.dispatchEmail) return false;
    const connection = await messagingIntegrationsRepo.ensureEmailConnection(input.account, input.ctx.permissions);
    const message = emailEnvelopeToGatewayMessage(input);
    const result = await messagingRoutes.dispatchEmail(connection, message);
    return result.status !== "ignored";
  });
  if (auditRepo) registerAuditRoutes(app, { auth: authProvider, store: workspaceStore, repo: auditRepo, auditLog: auditLogService });
  registerEmailInboxRoutes(app, { auth: authProvider, store: workspaceStore, repo: emailInboxRepo, auditRepo, aiEngine, automationHooks: emailAutomationHooks, attachmentStorage: emailAttachmentStorage, worker: emailInboxWorker });
  registerApiKeyRoutes(app, apiKeysRepo, authProvider, workspaceStore);
  registerScopedMemoryRoutes(app,{engine:scopedMemory,apiKeys:apiKeysRepo,store:workspaceStore,runtime:companyRuntime});
  registerMemoryDocumentRoutes(app,authProvider,memoryDocuments);
  registerGuardrailPolicyRoutes(app,{auth:authProvider,store:workspaceStore,repo:guardrailPolicies,auditLog:auditLogService});
  registerReliabilityAndOperationsRoutes(app, authProvider, workspaceStore);
  registerBrowserAutomationRoutes(app, authProvider);
  if (browserCredentials) registerBrowserCredentialsRoutes(app, { auth: authProvider, store: workspaceStore, repo: browserCredentials, browser: browserTool, email: emailInboxRepo, automations: automationsRepo });
  registerMultimodalRoutes(app, { auth: authProvider, store: workspaceStore, storage: objectStorage, aiEngine });
  registerA2AControlPlaneRoutes(app, { auth: authProvider, store: workspaceStore });

  return { codeUserQuestionReaperPort, mcpApprovalPauseRelease };
}
