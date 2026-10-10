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
// C13: the project lifecycle hooks. The service is built on the existing lifecycle manager and the existing
// sandbox/webhook transports; nothing here creates a second event bus or a second egress path.
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
// C6b: replay. Deterministic replay verifies the recorded bundle without any live port; live replay starts a
// new run and is labelled best-effort.
// C6b: the read-only "why did the agent act this way" surface (snapshot for a run, snapshot diff, Activity
// events of a run, replay metadata). Reads only, so it cannot widen what an agent may do.
import { buildCompanyMemoryBlock, buildProjectContextBlock } from "./code-context-memory";import { registerCodeRunStreamRoutes } from "./code-run-stream-routes";
// C10: durable session operations — resume, rewind, fork — and the reconciler's recovery notice.
// C14 (owner decision 3): the aggregated metrics of a tenant, computed from the run states and Activity rows the
// two readers below already return — no new table, no second record of what a run did.
import { createCodeInstructionsLoader } from "./code-instructions-loader";
// C9: goals, plan revisions and the session todo list. The tools update session metadata only; the routes are
// the read/decision surface the workspace renders.
import { proposePlan, updateSessionTodos } from "./code-plan-tool";
// C9: `code.ask_user`. The tool service persists the question (the runner owns the run state and the pause); the
// routes are the surface a person answers on, and the reaper port releases a run whose question timed out.
import { createCodeAskUserService } from "./code-ask-user-service";
import { createCodeUserQuestionReaperPort } from "./code-ask-user-reaper";
import { isRepositoryInstructionsTrusted } from "./code-project-trust";
// C15: the mounted-folder allowlist — its service (flag, owner/admin, path validation, audit before apply) and
// the route that exposes it.
import { createCodeCommandRegistry } from "./code-command-registry";
import { createCodeSkillsService } from "./code-skills-instructions";
import { SandboxImagePolicy, sandboxImagePolicyConfig } from "./sandbox-image-policy";
// C10 (ТЗ items 5, 6, 8): the run queue that bounds concurrency fairly, the registry that keeps a long run alive
// after its tab closes, the reconnect/polling surface over it, and the Markdown session export.
/**
 * R1 (section A, item 1): the **periodic** run limit is a separate limiter with its own configuration and its
 * own window. `route-guard-tiers.ts` stays exactly what it was — the Company/Chat HTTP limiter — and is not
 * imported here at all.
 */
/**
 * R1 (section A, items 1 and 5): the single admission door. Every code-run entry point in this file goes
 * through `codeRunAdmission`; `tests/coding-agent-r1a-limits-and-quotas.test.ts` fails if a **direct** queue
 * acquisition ever reappears here.
 */
import { connectionWantsNotification } from "./code-background-run-notifications";
import { CosignImageSignatureVerifier } from "./sandbox-image-signature";
import { CodeToolRuntime, CodeToolError, createProjectWorkspaceReadPort, createProjectWorkspaceWritePort, currentManifestVersion } from "./code-tool-runtime";
import { buildInstallPlan, registryFromConfig, runInstallPlan } from "./code-deps-policy";
import { runDependencyAudit, shouldBlockCommit } from "./code-deps-audit";
import { classifyDependencySource, findTyposquatTarget, isRegistryAllowed, resolveDepsGuardPolicy, sourceRequiresApproval } from "./code-deps-guard";
import { allCanonicalExecutors, runSandboxPostWriteHook, type CodeVerifyRunnerPort } from "./code-tool-executors";
// C12: the delegation adapter. It is the only thing that turns a `code.agent.spawn` call into a child run, and
// it does so through the **same** `CodingAgentRunner` instance the rest of the application uses.
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
// R1-C (items 11–13): retention really executed, and the right to be forgotten.
import { CodeDataRetention } from "./code-data-retention";
import { SecretLeaseProvider } from "./code-secret-lease";
import { isAgentPrincipal, isReviewSafeTool, matrixModeFor, PolicyEngine } from "./code-policy-engine";
import type { GitWriteIntent } from "./code-git-write-policy";
import { classifyShellCommand } from "./code-shell-classifier";
import { detectVerifyTool, parseVerifyOutput } from "./code-verify-parser";
// C15 (owner decisions 2 and 3): the run-start surface the CLI and, later, an IDE extension call.
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
// C13 (owner decision 5–8): the runtime MCP capability surface. `lookupCapability` is the one place the
// `static → runtime → unknown` order lives; the store/overlay and the SSRF-safe transport are the only
// runtime provider mechanism in the process (no second client, no second catalog).
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

// Re-exported so existing importers keep working: tests/chat-language-routing.test.ts
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
  /** C1: Coding Agent limits (configuration, not literals). */
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
  // The redis health client and check (step 2c-6h).
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
  // C5b: ProviderDataGuard sits between the engine and every caller that sends content to a model. It is
  // only active when the operator opts in (`NPATI_CODE_PROVIDER_DATA_ENFORCEMENT=true`) because the first
  // caller able to supply a policy context is the Coding Agent runner (C6); once enabled it is fail-closed.
  //
  // The resolver reads the configured policy from the same store the policy API writes to (`workspaceStore`),
  // so what the UI shows and what actually reaches a provider cannot diverge. `workspaceStore` is declared
  // further down with the policy service; the closure runs per request, long after startup, so the reference
  // is safely initialised by then.
  let engineDataPolicyResolver: ReturnType<typeof createEnginePolicyResolver> | undefined;
  /**
   * C5b: the outbound guard's policy snapshot. Initialised below next to the policy service (it needs the
   * same store), and referenced lazily from the guard closure that is registered at the same place.
   * `refreshOutboundPolicySnapshot` lets the policy routes invalidate the snapshot right after a change.
   */
  let outboundPolicySnapshot: OutboundPolicySnapshot | undefined;
  let refreshOutboundPolicySnapshot: (() => void) | undefined;
  const resolveEngineDataPolicy = (input: { model?: string; providerId?: string; policyContext?: { companyId: string } }) => {
    const resolver = engineDataPolicyResolver;
    if (!resolver) {
      // Fail closed: until the policy service exists nothing may be sent, and the guard turns this into
      // `provider_policy_unavailable` (503) instead of inventing a permissive default.
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
    // Routing eligibility is decided by the same resolver as the guard's per-request decision, so a model
    // the UI reports as eligible is exactly the model routing is allowed to try. A stale policy (review
    // older than 180 days) is never eligible, which forces a policy review instead of silent sending.
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
  // Core platform domain (step 2b): research, storage, files, auth, memory and guardrail repositories.
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
  // Audit and observability domain (step 2b): the journal, its config and its two background timers.
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
  // Data-backend domain (step 2b-3): provisioners, quotas, backups and project auth.
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
    // D7: deleting a Project only detaches it; the DataBackend keeps serving other Projects.
    await dataBackendService?.detachProjectArtifacts(context, project.companyId, project.id).catch(() => undefined);
  }, async (context, companyId, projectId) => {
    // Independent sites get independent data. Explicit attachments (including mobile apps)
    // are handled by ProjectService and never call this hook.
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
  /**
   * C15: the **one** resolver of a project's canonical workspace, and the one `WorkspaceProvider` that serves it.
   *
   * The owner decision for this step is that a mounted local folder becomes a real `WorkspaceProvider` rather
   * than a bypass: the provider below is the ordinary one, its base comes from this resolver, and the allowlist
   * read and the feature flag are wired into it. `ProjectGitService` receives the *same* resolver object further
   * down, so git, the file tools and the sandbox all act on the one directory this object names — there is no
   * second join of a workspace root anywhere in this file.
   *
   * `protectedRoots` carries the data directory (and the workspace root is added by the validator itself),
   * because a mount that contains either would expose it one level down.
   */
  const projectWorkspaceRoot = config.projectWorkspaceRoot ?? path.join(config.dataDirectory ?? ".data", "project-workspaces");
  /**
   * The flag reader is bound late, like the other late-bound ports in this file: the feature-flag service is
   * built further down (it depends on the audit log), and the resolver must not hold a second flag reader.
   * While it is unset the resolver answers "disabled", so an unwired build mounts nothing instead of mounting
   * without a gate — the fail-closed direction for a handle that does not exist yet.
   */
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
  // The gateway vendors the Project API client into the Project workspace, so it needs the workspace handle.
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
    // C10 (ТЗ item 7): the retention window the sweep destroys idle sandboxes after.
    retentionMs: Number(process.env.NPATI_SANDBOX_RETENTION_MS) || undefined,
  }, projectApiGatewayService ? async (ctx, companyId, projectId) => {
    const project = await projectService.get(ctx, companyId, projectId);
    return project.dataBackendId ? projectApiGatewayService.getSandboxEnvironment(ctx, companyId, projectId) : {};
  } : undefined);
  const sandboxIdleTimer = projectSandbox ? setInterval(() => { void projectSandbox?.stopInactive(); }, 60_000) : undefined;
  sandboxIdleTimer?.unref();
  /**
   * C10 (ТЗ item 7): the retention pass. It runs on the established idle cadence rather than a timer of its own —
   * `sweepRetention` re-checks the idle age itself, so the cadence only decides how quickly a long-idle sandbox is
   * noticed, never whether a live one is destroyed.
   *
   * Before sweeping it re-registers the projects that own code sessions, because the idle map is in-process: a
   * sandbox that exists on disk but is not in the map would never be stopped and never be destroyed, which is the
   * exact leak this policy exists to close. The store read is the existing tenant-enumerating one the reaper and
   * reconciler already use for cross-company scans — a system scope, so no user's permissions are borrowed.
   */
  const sandboxRetentionTimer = projectSandbox ? setInterval(() => {
    void (async () => {
      try {
        const refs = await workspaceStore.listCodeProjectRefs({ companyId: null, limit: 500 });
        for (const ref of refs.items) {
          // System-scope read on purpose: the sweep runs as the deployment, which owns no project, so the
          // tenant-scoped `getProject` would refuse every one of them.
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
  /**
   * C11 (owner decisions 2, 7, 8 and 10): the git workflow wiring.
   *
   * Four ports, and each one exists because the thing it does must have exactly one implementation:
   *
   *  - `codeWorkspaceRevisions` reads the **canonical** revision from the existing `ProjectWorkspace.info`
   *    (the content digest of the workspace's file set). The tool runtime captures it when it authorises a
   *    call and the git executors re-check it before a commit or a push, so "which bytes did this operation
   *    act on" is provable and a moved revision is `workspace_revision_mismatch` (owner decision 7);
   *  - `assertProtectedBranch` is `CodeProtectedBranchService.assertGitWriteAllowed` — the **same** decision
   *    phase 4b and the git boundary make. A git tool therefore cannot reach a branch decision that the other
   *    two checks would not have made;
   *  - `sessionBranch` is `sessionBranchName(sessionId)` (`npati/<session-short-id>`), so a commit or a push
   *    asserts it is on the branch the session was told to work on (owner decision 8);
   *  - `describeRun` reuses the run's own `CodingAgentRunSummary` for a pull-request body (owner decision 11).
   *    It reads the live summary the runner publishes, and a call outside a run answers `null` — the tool then
   *    says `descriptionSource: "unavailable"` rather than inventing a description.
   *
   * The guard is built **here**, above the git-policy boundary, because owner decision 13 gives the boundary
   * a third port: the revision must be read before the write's own initialization and re-checked after it. It
   * is one guard instance for the tool runtime and the boundary, so there is one answer to "what revision is
   * this workspace on".
   */
  const codeWorkspaceRevisions = new CodeWorkspaceRevisionGuard({
    read: async ({ ctx, companyId, projectId }) => {
      const info = await projectWorkspace.info(ctx, companyId, projectId);
      return { currentRevision: info.currentRevision, currentBranch: info.currentBranch ?? null };
    },
  });
  /**
   * C11: the git-policy boundary of `ProjectGitService`. The policy and credential ports are assigned further
   * down — the protected-branch service and the secret-lease provider are built after this line — and are read
   * **lazily** here, exactly like the other late-bound ports in this file. The closure resolves them at
   * call time (a git write happens long after startup); while a port is unset the write is refused, so the
   * lazy indirection cannot turn a missing check into a skipped one. The revision guard above is passed
   * directly: it is a read-only port whose instance exists already.
   */
  let codeGitPolicyBoundary: { assertGitWriteAllowed: (ctx: AuthContext, companyId: string, input: GitWriteIntent) => Promise<unknown> } | null = null;
  let hostGitCredentialLease: HostGitCredentialPort | null = null;
  const projectGitService = new ProjectGitService(
    workspaceStore,
    projectService,
    // C15: the **same** resolver the workspace provider reads, not a second join of the same root. This is what
    // makes "one canonical workspace" true for git as well: a mounted project's repository is the user's own.
    projectWorkspaceBases,
    undefined,
    async (ctx, companyId, credentialId) => { const fields = await browserCredentials?.resolve(ctx, companyId, credentialId); const token = fields?.token; if (!token) throw new Error("GitHub token is unavailable in the Company vault"); return token; },
    undefined,
    {
      // The second protected-branch check, performed immediately before the write (owner decision 3).
      assertGitWriteAllowed: (ctx, companyId, input) => {
        const boundary = codeGitPolicyBoundary;
        if (!boundary) throw new Error("The protected-branch policy is unavailable; the git write is refused");
        return boundary.assertGitWriteAllowed(ctx, companyId, input);
      },
      // C11 (owner decision 7 + 13): the canonical revision, read before the approval and re-checked after the
      // write's own initialization (`workspace_revision_mismatch`, no push).
      workspaceRevisions: codeWorkspaceRevisions,
      // The real approval record, consumed with the payload hash of the exact write (owner decision 5).
      ...(approvalsRepo
        ? {
            approvals: {
              consumeApproved: (ctx: AuthContext, companyId: string, id: string, params: { runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown> }) =>
                approvalsRepo!.consumeApproved(ctx, companyId, id, params as never),
            },
          }
        : {}),
      // One credential lease per git operation (owner decision 6).
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
  // C1: code projects and code sessions. No tools and no agent loop here; the runner is C6.
  // Self-hosted defaults are ready to use; hosted deployments retain dark launch and rollout gates.
  const featureFlagService = new FeatureFlagService(workspaceStore, auditLogService, { enabledByDefault: selfHosted, allowPreGateRollout: selfHosted }, async (ctx, companyId) => {
    // Best-effort kill-switch cleanup: stop the company's project sandboxes. Full teardown and
    // SecretLease revocation are C4/C6 work; failures here must not block the kill switch.
    let stopped = 0;
    try {
      const projects = await projectService.list(ctx, companyId, true);
      for (const project of projects) {
        if (!project.sandboxId || !projectSandbox) continue;
        await projectSandbox.destroy(ctx, project).then((destroyed) => { if (destroyed) stopped += 1; }).catch(() => undefined);
      }
    } catch { /* ignore */ }
    return stopped;
  });
  // C15: the late-bound flag reader of the workspace resolver is bound to the one feature-flag service, so a
  // `code.mounted_folder` kill switch is felt by the next resolution (the service caches for at most 30 s).
  mountedFolderFlags = featureFlagService;
  // C1b: sandbox image admission control. Created here so the routes and the runner-facing services
  // share one policy; without a configured signer identity it denies every image (see the policy).
  const sandboxImageConfig = sandboxImagePolicyConfig(process.env, config.dataDirectory);
  const sandboxImagePolicy = new SandboxImagePolicy(workspaceStore, {
    ...sandboxImageConfig,
    verifier: sandboxImageConfig.signer.identity && sandboxImageConfig.signer.issuer ? new CosignImageSignatureVerifier() : undefined,
    flags: featureFlagService,
    audit: auditLogService,
  });
  const codeService = new CodeService(workspaceStore, projectService, projectWorkspace, projectImportService, config.codeAgentLimits, auditLogService, featureFlagService);
  // C2: runtime for the read-only code.* tools. Reads go through the existing project workspace; text
  // search requires the sandbox, so without it the tool refuses with `sandbox_unavailable` instead of
  // touching the host. Activity is logged here; the run-event stream and ExecutionSnapshot links arrive
  // with the runner in C6 (the run event enum is lifecycle-only by design).
  const codeReadTracker = new ReadTracker(resolveReadTrackerOptions());
  // C3: the write runtime reuses the existing Website Builder checkpoint mechanism (`ProjectGitService`
  // already commits the dirty worktree and tags `refs/npati/checkpoints/<id>`) and the existing approval
  // system (`CompanyApprovalsRepository` verifies the payload hash on consumption). Nothing is stored in
  // a new format, and the per-turn log stays in-process until C6a decides persistence.
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
  // Single sandbox execution adapter for the code toolset: text search and the post-write hooks both use
  // it, so the terminal policy sees one consistent caller identity.
  // The code sandbox wiring (step 2c-6f).
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
  /**
   * C11 (owner decision 3): the git-policy boundary of `ProjectGitService` reads the same service the
   * engine's hard-deny phase reads. `assertGitWriteAllowed` is a **separate** call, made immediately before
   * the git side effect, because a direct service call (a route, a script, a future tool) never reaches the
   * engine — that is the path this assignment closes.
   */
  codeGitPolicyBoundary = {
    assertGitWriteAllowed: (ctx: AuthContext, companyId: string, input: GitWriteIntent) =>
      codeProtectedBranches.assertGitWriteAllowed(ctx, companyId, input),
  };
  /**
   * C13 (owner decision 5–8): the **runtime** MCP capability surface, constructed here because the policy
   * engine's capability port (below) consults it on every tool call.
   *
   * Three things are one instance each, deliberately:
   *   - `mcpRuntimeCapabilities` is the only runtime provider overlay in the process. A discovered MCP tool is
   *     published **into it** and never into `CODE_TOOL_SCHEMAS`/`CAPABILITY_CATALOG`/`CAPABILITY_MATRIX`, so
   *     the static manifest stays versioned and immutable while the Inspector still shows both sources.
   *   - `mcpRuntimeTransport` is the existing SSRF-safe client, not a second HTTP stack. The allowlist is read
   *     lazily (the C4b allowlist is learned at runtime), and a request to a host that is not on it is refused
   *     by the SSRF policy before a socket exists.
   *   - `mcpToolPolicyStore` is migration 085's table: the durable record of an owner/admin risk decision. The
   *     default for every discovered tool stays `high` + approval required until such a decision exists.
   */
  const mcpToolPolicyStore = new McpToolPolicyStore(config.databaseUrl);
  app.addHook("onClose", async () => { await mcpToolPolicyStore.close(); });
  const mcpRuntimeCapabilities = new McpRuntimeCapabilityStore({ policies: mcpToolPolicyStore });
  const mcpRuntimeTransport = new McpRuntimeTransport({
    // The **run** phase allowlist is the one an MCP dial belongs to: it is the phase for outbound calls made
    // while work is in flight, and it is read lazily because the C4b allowlist is learned at runtime.
    allowlist: () => resolveAllowlistForPhase("run", egressAllowlist),
  });
  /**
   * The configured integrations the transport may dial. Late-bound because `IntegrationsRepository` is
   * constructed further down (the same late-binding idiom the spawn executor uses): `null` means "not wired",
   * and discovery then reports `mcp_integration_source_unavailable` rather than dialling anything.
   */
  let mcpIntegrationSourceForRuntime: McpIntegrationSource | null = null;
  /**
   * The runtime MCP manifest, in the metadata-only shape the ExecutionSnapshot and the replay bundle pin.
   * One definition, three readers (the snapshot source, the replay recorder's context and the replay route's
   * "current manifest" side), so a pinned manifest and a compared manifest cannot be computed differently.
   */
  const readRuntimeMcpManifest = (tenant: { workspaceId: string; companyId: string }) =>
    readMcpRuntimeManifest(mcpRuntimeCapabilities, tenant);
  // The code policy engine (step 2c-6c).
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
  /**
   * C5: project trust. Repository content can never mark a project trusted — only an owner/admin can,
   * and the change is audited before it is applied (fail closed, same journal as the other C5 writes).
   */
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
                // C5a (D7): a refused trust change is journalled as a denied decision, not as an allow.
                decision: input.decision === "deny" ? "denied" : "allowed",
                payload: { action: input.action, target: input.resourceId },
                metadata: input.metadata ?? {},
              },
            );
          },
        }
      : undefined,
  });
  /** C5: session modes are a policy surface, so every change goes through the audited service. */
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
                // C5a (D7): a refused mode change is journalled as a denied decision.
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
  /**
   * The session-mode routes take a synchronous context accessor while authentication is async, so the
   * context is resolved once in a path-scoped preHandler and read back synchronously. Scoped to the
   * mode endpoints on purpose: no other route authenticates twice or changes behaviour.
   */
  const codeSessionModeContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/sessions\/[^/]+\/mode(\/suggest)?$/.test(request.url.split("?")[0] ?? "")) return;
    codeSessionModeContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeSessionModeRoutes(app, {
    // `SessionModeRouteDeps` requires the store for the route-level reads; the service holds its own.
    store: workspaceStore,
    service: codeSessionModes,
    getAuthContext: (request) => codeSessionModeContexts.get(request as object) ?? null,
  });
  /**
   * The membership and protected-branch routes take a synchronous context accessor while authentication is
   * async, so the context is resolved once in a path-scoped preHandler and read back synchronously (the
   * same mechanism as the session-mode and production routes — no second auth path). The services
   * themselves are constructed above, together with the policy engine that consults them.
   */
  const codeMembershipContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/(?:members(?:\/|$)|protected-branches(?:\/|$))/.test(request.url.split("?")[0] ?? "")) return;
    codeMembershipContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeMembershipRoutes(app, {
    service: codeMembership,
    protectedBranches: codeProtectedBranches,
    getAuthContext: (request) => codeMembershipContexts.get(request as object) ?? null,
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    // An invite token names its company: a token posted to another company's path is refused before use.
    findInviteCompanyId: async (tokenHash) =>
      (await workspaceStore.findCompanyInviteByTokenHash(tokenHash))?.companyId ?? null,
    logger: app.log,
  });
  /**
   * C5b: provider data policy administration.
   *
   * The store-level service owns validation, the audited "journal before write" order and the version
   * bump; `ProviderDataPolicyAdminService` on top of it owns *who may change what* (company-role anchored
   * RBAC through the C5a gate), the Activity event, and the eligibility read model the UI needs. Both are
   * built here so the routes and any later caller share one instance and therefore one policy view.
   *
   * Without the audit journal the reads answer but every change refuses (`audit_unavailable`, 503) — the
   * policy that decides what may leave NPATI is not something that gets edited unattributed.
   */
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
            // A platform default has no company; the journal needs a scope, so it is named explicitly.
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
  /**
   * C5b: a policy change must take effect immediately, not after the snapshot's next tick, so the mutating
   * methods of the policy service invalidate the outbound snapshot. The wrapper lives here (not in the policy
   * module) because the snapshot is created below; the closure resolves it lazily at request time.
   */
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
  // C5b: wire the provider data guard's resolver to the same store the policy API reads and writes, so a
  // configured policy actually decides what may leave NPATI (and what routing considers eligible).
  engineDataPolicyResolver = createEnginePolicyResolver(workspaceStore as unknown as ProviderDataPolicyLookupPort);
  /**
   * C5b: the outbound guard resolves its policy from a **snapshot** of the same store, so there is exactly
   * one policy source. The resolver is synchronous by contract (call sites decide synchronously), so the
   * snapshot is refreshed in the background: at startup, on an interval, and by `refreshOutboundPolicySnapshot()`
   * which the policy routes call after a change.
   */
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
      // Explicit refusal: the caller sees *why* nothing could be evaluated instead of a silent null.
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
    /**
     * C5b: the project record carries its own (C1) classification, which the project drawer edits, while
     * the policy row decides what may reach a provider. The two are combined by taking the **strictest**
     * one, so neither can lower the protection the other set; a project that cannot be read counts as
     * `confidential` rather than as "no constraint" (see `provider-data-policy-service.ts`).
     */
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
  /**
   * C5: the effective capability groups of an agent are derived from the code tools it was granted
   * (`CompanyAgent.tools`), which is the only capability grant that exists in the data model today.
   * When no agent record is resolvable the field stays absent, so the phase simply has no data (it is
   * an extra narrowing layer — RBAC, feature flags and the capability registry always apply).
   * TODO(C5a): store the granted capability groups on the agent record instead of deriving them.
   */
  const codeGroupsForAgent = (tools: readonly string[] | undefined): string[] => {
    const groups = new Set<string>();
    for (const tool of tools ?? []) {
      const group = groupForCapability(tool);
      if (group) groups.add(group);
    }
    return [...groups];
  };
  /**
   * C5: enriches a tool-call policy request with the facts the caller cannot know: the agent's
   * capability groups, whether the project is trusted, and (when the caller supplies them) the
   * repository-instruction review and the policy-change marker. Enrichment only *adds* restrictions —
   * the engine still decides, and an unresolvable agent or project leaves the field absent.
   */
  const enrichedPolicyEngine: PolicyEngine = Object.assign(Object.create(Object.getPrototypeOf(policyEngine)) as PolicyEngine, {
    evaluate: async (request: Parameters<PolicyEngine["evaluate"]>[0]) => {
      const enriched = { ...request } as typeof request;
      if (enriched.agentId) {
        const agent = await workspaceStore.getCompanyAgent(request.ctx, request.companyId, enriched.agentId).catch(() => null);
        const groups = codeGroupsForAgent((agent as { tools?: string[] } | null)?.tools);
        if (groups.length) {
          enriched.capabilityGroups = {
            agentCapabilityGroups: groups,
            userPermissions: request.ctx.permissions ?? [],
            projectRules: null,
          };
        }
      }
      if (enriched.requiresProjectTrust === true && enriched.projectTrusted === undefined && request.projectId) {
        enriched.projectTrusted = await codeProjectTrust
          .isTrusted(request.ctx, request.companyId, request.projectId)
          .catch(() => false);
      }
      return policyEngine.evaluate(enriched);
    },
  });
  /**
   * C13 (owner requirement: fresh-process MCP acceptance): **the** run-path entry point of runtime MCP
   * discovery, and the vendor of the discovery the Capability Inspector route asks for.
   *
   * It is one object with one `discover` implementation, so there is no second discovery system and no way for
   * the Inspector and a run to disagree about what a tenant's MCP server offers. Crucially the dependency runs
   * the other way from what it used to: the **run** discovers for itself (`prepareForRun`, which the runner
   * calls before the first model call and before the ExecutionSnapshot that pins the runtime manifest), and the
   * Inspector route simply calls the same function. No run depends on the Inspector having been opened, and
   * nothing here reads a route, a cache or a warm-up hook.
   *
   * It is constructed here — after the enriched engine, before the runner — because both are needed: the engine
   * is the port that decides whether a runtime MCP call may happen, and the runner is the consumer that must be
   * offered the tools the discovery published.
   */
  const mcpRunPath = createMcpRuntimeRunPath({
    store: mcpRuntimeCapabilities,
    transport: mcpRuntimeTransport,
    source: () => mcpIntegrationSourceForRuntime,
    // `code.mcp` is read before anything is dialled: a disabled sub-flag means no discovery pass at all.
    flags: featureFlagService,
    // The same engine the rest of the tool path consults, so `code.mcp`, the mode, the permission, the
    // capability lookup and the fail-closed approval requirement are enforced for a runtime MCP call too.
    policy: enrichedPolicyEngine,
    // Metadata-only Activity (counts, codes, the manifest hash): the sink itself rejects endpoints and tokens.
    activity: activitySinkForKind(codeActivitySink, "run_activity"),
    logger: { warn: (message, meta) => app.log.warn(meta ?? {}, message) },
  });
  const discoverRuntimeMcpCapabilities = (ctx: AuthContext, companyId: string) =>
    mcpRunPath.discover(ctx, companyId);
  const shellSandboxPort: CodeShellSandboxPort | undefined = projectSandbox ? {
    execute: async (input) => {
      const started = Date.now();
      const result = await projectSandbox!.execute(input.context, input.companyId, {
        projectId: input.projectId,
        command: input.command,
        // Code sessions are authorized by the canonical code runtime, not Company-agent IDs.
        // The sandbox's system path still checks the authenticated user's write permission.
        agentId: "system",
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.approved ? { approved: true } : {}),
        ...(input.environmentReferences ? { environmentReferences: input.environmentReferences } : {}),
      }) as { stdout?: string; stderr?: string; output?: string; exitCode?: number; durationMs?: number; status?: string; sandboxId?: string; riskLevel?: string };
      return {
        exitCode: typeof result?.exitCode === "number" ? result.exitCode : 1,
        stdout: result?.stdout ?? result?.output ?? "",
        stderr: result?.stderr ?? "",
        durationMs: typeof result?.durationMs === "number" ? result.durationMs : Date.now() - started,
        status: result?.status,
        sandboxId: result?.sandboxId,
        riskLevel: result?.riskLevel,
      };
    },
  } : undefined;
  const processSandboxPort: CodeProcessSandboxPort | undefined = projectSandbox ? {
    logsAreSnapshots: true,
    start: async (input) => {
      const result = await projectSandbox!.process(input.context, input.companyId, {
        projectId: input.projectId, command: input.command, action: "start", agentId: "system",
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.approved ? { approved: true } : {}),
      }) as { processId?: string; pid?: number; startedAt?: string | number };
      const parsed = typeof result?.startedAt === "number" ? result.startedAt : result?.startedAt ? Date.parse(result.startedAt) : Date.now();
      return { processId: String(result?.processId ?? ""), pid: result?.pid, startedAt: Number.isFinite(parsed) ? parsed : Date.now() };
    },
    logs: async (input) => {
      const result = await projectSandbox!.process(input.context, input.companyId, {
        projectId: input.projectId, processId: input.processId, action: "logs", agentId: "system",
      }) as { output?: string; stdout?: string; eof?: boolean };
      return { output: String(result?.output ?? result?.stdout ?? ""), eof: result?.eof };
    },
    status: async (input) => {
      const result = await projectSandbox!.process(input.context, input.companyId, {
        projectId: input.projectId, processId: input.processId, action: "status", agentId: "system",
      }) as { status?: string; exitCode?: number | null };
      const state = result.status;
      if (state !== "running" && state !== "completed" && state !== "failed" && state !== "stopped" && state !== "timed_out" && state !== "lost") {
        throw new Error("process_status_unknown");
      }
      return { state, exitCode: result.exitCode ?? null };
    },
    stop: async (input) => {
      const started = Date.now();
      const result = await projectSandbox!.process(input.context, input.companyId, {
        projectId: input.projectId, processId: input.processId, action: "stop", agentId: "system",
      }) as { status?: string; exitCode?: number | null };
      const state = result.status;
      if (state !== "stopped" && state !== "completed" && state !== "failed" && state !== "timed_out") throw new Error("process_stop_unconfirmed");
      return { state, exitCode: result.exitCode ?? null, durationMs: Date.now() - started };
    },
  } : undefined;
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
  /**
   * C6a: the reaper is an orchestrator over ports. Only the capabilities that exist today are wired; every
   * other step is reported as `skipped` with a reason, so a missing scan API stays visible in the metrics
   * instead of looking like "nothing to clean". Note that `SecretLeaseProvider.startReaper()` was never
   * started before this step, so expired leases were previously never revoked in a running server.
   */
  /**
   * C9: the question-expiry port the reaper drives. It is assigned once the run-state log exists — releasing a
   * timed-out question's run means writing run state — and the closures below **throw** while it is unset, so a
   * reaper pass that somehow ran too early reports a visible error instead of a false "nothing to expire".
   * `codeReaper.run()` is only reached near the end of this composition, well after the assignment.
   */
  let codeUserQuestionReaperPort: ReturnType<typeof createCodeUserQuestionReaperPort> | null = null;
  /**
   * C13 (owner blocker 1): the release of a run paused on a **runtime MCP approval**. Late bound for the same
   * reason as the question port above — it needs the run-state log, which is constructed further down — and a
   * `null` holder means the release is reported as unsupported rather than silently skipped.
   */
  let mcpApprovalPauseRelease:
    | ((input: { companyId: string; runId: string; approvalId: string; reason: McpApprovalReleaseReason; answeredBy?: string }) => Promise<unknown>)
    | null = null;
  /**
   * R1-C (item 11): the missing reader of two configuration values that had none.
   *
   * `toolResultRetentionDays` (30) and `transcriptRetentionDays` (90) were declared by C1, documented in
   * `.env.example` and asserted by a test — and read by **nothing**. The consequence was that no code data
   * ever expired. This object is their reader: it derives the four retention windows from those two limits and
   * hands them to the store, which compares each row's own `retention_class` against them. No number is
   * invented here, and the store's optional port means an in-memory deployment reports `port_unavailable`
   * rather than a false clean sweep.
   */
  const codeDataRetention = new CodeDataRetention({
    ...(workspaceStore.codeDataLifecycle ? { lifecycle: workspaceStore.codeDataLifecycle } : {}),
    limits: {
      toolResultRetentionDays: config.codeAgentLimits?.toolResultRetentionDays ?? DEFAULT_CODE_AGENT_LIMITS.toolResultRetentionDays,
      transcriptRetentionDays: config.codeAgentLimits?.transcriptRetentionDays ?? DEFAULT_CODE_AGENT_LIMITS.transcriptRetentionDays,
    },
  });
  // The code execution ports (step 2c-6e).
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
  /**
   * C13 (owner decisions 3 and 4): slash commands and lazily loaded Skills.
   *
   * Both are wired on machinery that already exists — no second template engine, no second settings system, no
   * second file reader:
   *
   *   - **Reading.** The command files go through `codeInstructionsLoader.collectCommands`, i.e. the *same* C8
   *     loader and therefore the same `readWorkspaceText` path guard, and the loader asks the project trust
   *     record **before** its first read. An untrusted repository is never read, which the suite proves with a
   *     spy that stayed at zero calls.
   *   - **Classification.** A command template and a Skill body both pass the existing C5 classifier
   *     (`classifyRepositoryInstruction`) and the existing C4a scanner (`scanTextForSecrets`) — the same two
   *     functions `NPATI.md` and the stored webhook prompt already pass.
   *   - **Provider policy.** A Skill body passes the existing C5b `ProviderDataGuard`
   *     (`guardProviderBoundText`), exactly as the C8 compaction summary does. A body the guard would have to
   *     redact is **refused**, never sanitised, because a redacted body would carry a `REDACTED:` placeholder
   *     into the prompt and into the recorded model-visible state.
   *   - **Skills.** The metadata and the body both come from the one `defaultSkillRegistry` the `/skills` route
   *     and `/settings/skills` already serve. `list()` (which strips `canHandle`/`run`) supplies the metadata,
   *     and nothing calls `run()` until a Skill is really selected — that is the lazy-load boundary, and it is
   *     observable as a spy on the body reader.
   */
  const codeCommandIds = ["review", "explain", "test", "fix"] as const;
  // The code-tool wiring (step 2c-6).
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
  /**
   * C12: the two late-bound ports the delegation executor needs.
   *
   * They are placeholders rather than values because the composition has a genuine ordering constraint: the
   * tool executors (and therefore the runtime) are built **before** the runner, and the runner is built over the
   * runtime. A value would have to be `undefined` forever; a getter lets the delegation see them once they
   * exist, which is the same late-binding idiom `createCodeRunEnvironmentHolder` already uses for the
   * per-run facts. Neither holder is a second engine: they are the **same** `CodeToolRuntime` and the **same**
   * `CodingAgentRunner` instances the rest of the application uses.
   */
  let codeToolRuntimeRef: CodeToolRuntime | undefined;
  let codingAgentRunnerRef: CodingAgentRunner | undefined;
  /**
   * Step 5: the detached delegation service, late-bound like the two refs above and for the same reason — the
   * child runner it drives is the `CodingAgentRunner` built hundreds of lines below, and the completion service it
   * reports through is built after that. A getter, so no caller can capture a service that does not exist yet.
   */
  let codeSubagentOperationsRef: (() => CodeSubagentOperationService) | undefined;
  /**
   * Step 5: the delegation adapter the tool runtime reaches — the same one C12 built inline. It is a named accessor
   * so the operations service can drive it and so the detached path and the blocking path are provably the same
   * runner: there is one `createCodeSubagentChildRunner` call in this file, and both paths read it.
   */
  let subagentChildRunnerWithAck: CodeSubagentDetachedRunner | undefined;
  // The code tool runtime (step 2c-6c).
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
  // C1a: record the published tool-schema manifest (and fail fast if the registry disagrees with the
  // published checksum), so a session can always be read with the exact tool versions it used.
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
  // The project orchestrator and email automation hooks (step 2c-6g).
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
  // The automation executor (step 2c-6c).
  const { executeAutomation } = createAutomationExecutor({
    config,
    log: app.log,
    agent,
    automationAllowedPermissions,
    browserCredentials,
    companyRuntime,
    emailInboxRepo,
  });
  /**
   * C10 (ТЗ item 5): the shared delivery path for every messaging notification NPATI sends on a background result.
   * `notifyAutomation` below was the only caller of this shape; making it a named function is what lets a
   * background code run use the **existing** Integrations channels instead of inventing a second notifier.
   *
   * The switch is read from the connection's own settings, so one connection can have automation notices on and
   * background-run notices off. `notifications.backgroundResults` existed in the schema, in the migration defaults
   * and in the UI in eight locales while **no server code read it** — this is the reader.
   */
  const notifyMessagingConnections = async (input: {
    workspaceId: string;
    userId: string;
    companyId: string;
    agentId?: string | null;
    kind: "automation" | "background_run" | "approval";
    title: string;
    detail: string;
  }) => {
    const connections = await messagingIntegrationsRepo.listConnectedForCompany(
      input.workspaceId, input.userId, input.companyId, input.agentId ?? undefined,
    );
    const wanted = (connection: (typeof connections)[number]): boolean =>
      connectionWantsNotification(input.kind, connection.settings);
    await Promise.allSettled(connections.filter(wanted).map(async (connection) => {
      const notificationTarget = connection.channel === "whatsapp"
        ? (connection.settings.access.allowedUserIds[0] || connection.externalChatId)
        : connection.externalChatId;
      if (!notificationTarget) return;
      try {
        await messagingGateway.adapter(connection.channel).sendText(
          messagingIntegrationsRepo.resolveToken(connection), notificationTarget,
          `${input.title}\n\n${input.detail}`, connection.externalThreadId || undefined,
        );
        await messagingIntegrationsRepo.record(connection.id, "outbound");
      } catch (error) {
        await messagingIntegrationsRepo.record(connection.id, "outbound", error instanceof Error ? error.message : String(error));
      }
    }));
  };
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
  // C13: the configured MCP integrations become the **only** endpoints the runtime MCP transport may dial.
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
  // The chat orchestration (step 2c-7c-c-1).
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
  // Platform base routes (step 2c-3): auth, AI, workspace, project and data-backend.
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
  // C6: the coding agent loop. Wired to the GUARDED engine (`aiEngine`), never to `baseAiEngine`: that is
  // what makes `policyContext` and the provider-data policy apply to every model call the loop makes.
  // Code route wiring and registration (step 2c-4).
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
  // Platform routes (step 2c-2): code, network, company, content, MCP, email and integrations.
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
  app.addHook("onClose", async () => { automationScheduler.stop(); codeReaper.stop(); if (sandboxIdleTimer) clearInterval(sandboxIdleTimer); if (sandboxRetentionTimer) clearInterval(sandboxRetentionTimer); if (backupTimer) clearInterval(backupTimer); if (auditVerifyTimer) clearInterval(auditVerifyTimer); if (auditAnchorTimer) clearInterval(auditAnchorTimer); if (runnerReadinessTimer) clearInterval(runnerReadinessTimer); storageReconciler?.stop(); await Promise.all([whatsappMessagingAdapter.shutdown(),discordMessagingAdapter.shutdown(),slackMessagingAdapter.shutdown()]); await emailInboxWorker.stop(); await emailInboxRepo.close(); await browserCredentials?.close(); await companyRunQueue?.close(); await knowledgeQueue?.close(); await knowledgeRepo?.close(); await automationsRepo?.close(); await approvalsRepo?.close(); await integrationsRepo?.close(); await messagingIntegrationsRepo.close(); await auditRepo?.close(); await chatFiles?.close(); await storageProtection.close(); /* G1 (item 2): the workspace store owns the main pool and was the one resource this hook never released. It is closed **last**, after every borrower has been stopped: `ApiKeysRepository`, `ScopedMemoryEngine` and `GuardrailPolicyRepository` (above) are all handed that same pool by the composition, so ending it first would fail their in-flight queries during shutdown. `close?.()` because `InMemoryWorkspaceStore` owns nothing. */ await workspaceStore.close?.(); });
  app.addHook("onReady", async () => {
    await workspaceStore.initialize();
    await whatsappMessagingAdapter.restore();
    await discordMessagingAdapter.restore();
    await slackMessagingAdapter.restore();
    await emailInboxRepo.encryptLegacyAccountCredentials();
    await objectStorage?.initialize();
    if (chatFiles) { const legacy = await chatFiles.migrateLegacy(); if (legacy.failed) app.log.warn(legacy,"Some legacy attachments could not be migrated"); await chatFiles.cleanupPending(); }
    storageReconciler?.start();
    // C6a: one pass at boot (catches leaks left by a previous process) and then periodically. The reaper
    // never throws and never blocks startup: a failing step is reported in its summary and its metrics.
    void codeReaper.run().catch(() => undefined);
    codeReaper.start((summary) => { app.log.warn({ skipped: summary.skipped, errors: summary.errors }, "code_reaper_attention"); });
    emailInboxWorker.start();
    automationScheduler.start();
  });

  // System routes (step 2c-1): liveness, readiness and the skills catalogue.
  registerHealthRoutes(app, {
    aiEngine,
    hub,
    store: workspaceStore,
    researchBundle,
    objectStorage,
    redisHealthCheck,
    coreBackendHealthCheck,
  });

  // The capability catalogue and its inspector (step 2c-7).
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

  // Router, attachment, research-job and stream-cancel routes (step 2c-7b).
  registerMiscRoutes(app, {
    config,
    log: app.log,
    activeContextResolver,
    authProvider,
    chatFiles,
    researchBundle,
    workspaceStore,
  });

  // The chat endpoints other than the stream (step 2c-7c-b).
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

  // The chat stream endpoint (step 2c-7c-a).
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

