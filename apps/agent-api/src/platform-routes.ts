/* Code, platform, email and integration route registration, extracted from app.ts
 * (step 2c-2 of docs/refactoring/PLAN.md).
 *
 * Twenty-two registrars plus the per-route wiring they own (contexts, the messaging routes,
 * the email gateway hook). The block is moved verbatim; the edits are the closure locals that
 * became deps (app.log -> log, AUDIT_SYSTEM_WORKSPACE -> systemWorkspaceId) and the two late-bound
 * ports that buildApp reads after this call, which are declared here and returned instead of
 * assigned into closure variables.
 */
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
  /**
   * C9: goals, plan revisions and the session todo list.
   *
   * Three details are deliberate. Reads and decisions go through the shared C5a gate with named actions, so a
   * permission can never be authorised by handing in a convenient label. Every mutation is journalled **before**
   * it is applied, so an audit outage refuses the change instead of applying it unrecorded. And approving a plan
   * applies the mode the **user** chose, through the existing session-mode service — the plan body is model
   * output and never selects a mode, which is the same boundary C8 draws for repository instructions.
   */
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
      // The revision comes from the session, so applying a mode after an approval is guarded by the same
      // lost-update check the mode route uses; a session that moved on refuses instead of being overwritten.
      const session = await codeService.getSession(ctx, companyId, sessionId);
      await codeSessionModes.setMode(ctx, companyId, sessionId, {
        mode: String(mode),
        expectedRevision: session.revision,
        reason: "plan_approved",
      });
    },
    logger: log,
  });
  /**
   * C8: project instructions (`NPATI.md` / `AGENTS.md` / the shared `PROJECT.md`) and project trust.
   *
   * Two facts decided this shape. First, `CodeProjectTrustService.trust()`/`.revoke()` were implemented but
   * **called from nowhere**, and the RBAC actions were already mapped, so trust was impossible to grant: a
   * trust-gated feature with no way to grant trust is a dead path, not a dark-launched one. Second, the
   * instructions read must ask that service on every request, so the route and the loader share one instance
   * created above.
   *
   * One path-scoped preHandler with its own context map — the same mechanism every other code surface uses, so
   * there is no second auth path.
   */
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
    // Read surfaces: `code.instructions.read` and `code.instructions.init` both carry `workspace:read`, because
    // drafting writes nothing — persisting the draft goes through `code.fs.write` and its own authorisation.
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeInstructionsContexts.get(request as object) ?? null,
    logger: log,
  });
  registerCodeProjectTrustRoutes(app, {
    trust: {
      get: async (ctx, companyId, projectId) => codeProjectTrust.get(ctx, companyId, projectId),
      // The service still performs the owner/admin check and writes the audit entry *before* the store write;
      // the route adds transport only, so the fail-closed ordering cannot be lost in a wrapper.
      trust: async (ctx, companyId, projectId, input) => codeProjectTrust.trust(ctx, companyId, projectId, input),
      revoke: async (ctx, companyId, projectId, input) => codeProjectTrust.revoke(ctx, companyId, projectId, input),
    },
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeInstructionsContexts.get(request as object) ?? null,
    logger: log,
  });
  /**
   * C15: the mounted-folder allowlist. It shares the path-scoped preHandler above because it is the same kind of
   * surface (an owner/admin decision about one project, read fresh on every request), and it shares the flag
   * service and the workspace resolver built earlier — the resolver is what makes a confirmed folder the
   * project's workspace, and the service is what makes confirming one possible at all.
   *
   * The service validates the path with the **same** function the sandbox runner uses
   * (`validateMountedFolder`), so "what the API accepted" and "what the runner will accept before docker create"
   * cannot drift into two policies.
   */
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
  // C5: scoped approval rules are visible and revocable; every change is audited before it applies.
  registerCodeApprovalRoutes(app, authProvider, { store: workspaceStore, scope: codeApprovalScope });
  /**
   * C9: the surface a person answers a paused run on, plus the reaper port that releases a run whose question
   * timed out.
   *
   * One path-scoped preHandler with its own context map — the same mechanism every other code surface uses, so
   * there is no second auth path. `code.question.read` maps to `workspace:read` and `code.question.answer` to
   * `workspace:write`; the service itself additionally refuses an agent or service principal before it reads
   * anything, because an agent that could answer its own question would have granted itself the permission it
   * asked for.
   *
   * This service carries the run state (unlike the tool-side instance), because a recorded answer resumes the
   * run as `interrupted`/`user_answered` and an expiry releases it as `ask_user_timeout`.
   */
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
    // The question **text** is deliberately not recorded: Activity is metadata, and the prompt is user-facing
    // content that already lives on the question row under the session's classification.
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
  /**
   * C13 (owner blocker 1): the **one** release path of a run paused on a runtime MCP approval, shared by the
   * approval decision route (a human approved or rejected) and the reaper's expiry sweep (nobody answered in
   * time). It chooses between the two transitions C9 already owns — `resumeAfterAnswer` for "the answer arrived"
   * and `markInterrupted` for "the wait ended without one" — so a paused run is released exactly like a run
   * paused on a question, and the C10 resume can then continue the **same** run.
   */
  const mcpApprovalPauseRelease = async (input: { companyId: string; runId: string; approvalId: string; reason: McpApprovalReleaseReason; answeredBy?: string }): Promise<unknown> => {
    const outcome = await releaseMcpApprovalPause(codeRunStateLog, input);
    if (outcome === "unsupported") {
      log.warn({ ...input, kind: "approval_release_unsupported" }, "mcp_approval_pause_release_unsupported");
    }
    return outcome;
  };
  // C4b: read-only sandbox network state (allowlist, decisions, enforcement) plus an audited re-probe.
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
    /**
     * C13 (owner blocker 1): a decision on a **runtime MCP** approval is the answer a paused run is waiting for,
     * so it releases that run through the same transition a question answer uses (`resumeAfterAnswer`). An
     * ordinary approval (a file write, a git push, a dependency install) carries no MCP payload and is left
     * exactly as it was: its own boundary consumes it.
     */
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
    /**
     * C13 (owner decision 5): the owner/admin flow that may lower a runtime MCP tool's risk. The authorization
     * (owner/admin only, agent principals refused), the audit-before-apply order and the durable policy row all
     * live in `applyMcpRiskOverride`; this adapter only supplies the runtime store, the migration-085 policy
     * store and the existing tamper-evident AuditLog — there is no second journal and no second authorization.
     */
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
  if (integrationsRepo) registerIntegrationsRoutes(app, { auth: authProvider, store: workspaceStore, repo: integrationsRepo });
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
      const message=publicCompanyRunMessage(result.run.result, result.run.errorMessage, text);return { message:messagingResultText(message),attachments:await messagingResultAttachments(context,message) };
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
