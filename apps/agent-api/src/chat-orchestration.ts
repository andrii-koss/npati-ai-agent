import { readChatActiveContext, chatEntityReferencesPrompt } from "./project-chat-cards";

import { createChatTurn } from "./chat-turn";
import { createChatActions } from "./chat-actions";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./app";
import { createAuditServices } from "./audit-services";
import { AutomaticMemoryExtractor } from "./automatic-memory-extractor";
import { computeNextCronDate } from "./automation-scheduler";
import { CompanyAutomationsRepository } from "./automations-repository";
import { BrowserCredentialsRepository } from "./browser-credentials-repository";
import { BusinessActionHandler } from "./business-action-handler";
import { BUSINESS_PROFILE_TOOL, executeBusinessProfileTool, reconcilePlannedBusinessArgs } from "./business-profile-native";
import { summarizeBusinessProfileChat } from "./business-profile-response";
import { inferenceImagesForRequest } from "./chat-image-purpose";
import { ChatAttachmentInput, prepareChatAttachments } from "./chat-attachments";
import { conversationTitle, isCompositeBusinessCompanyCreation, isShortAffirmativeReply, normalizeNewBusinessDirective, requestsBusinessGoal, requestsBusinessMemory, requestsCompositeCompanyDeletionIntent, requestsNewBusinessIdea, resolveContextualCompanyFollowUp } from "./chat-intent-helpers";
import { attachResearchSources } from "./chat-public-errors";
import { StructuredChatPlan, businessPlanComplete, companyPlanComplete, planStructuredChatRequest } from "./chat-task-plan";
import { addColumnDirectiveFromMarkdown, forbidsNewWebResearch, explicitlyRequestsWebResearch, isSpreadsheetEditRequest, mapColumnDirectiveFromProposal, spreadsheetEditedMessage } from "./chat-text-directives";
import { CHAT_TOOL_SELECTION_INSTRUCTION, CORE_CHAT_TOOLS, ChatToolExecutionResult, runChatToolLoop } from "./chat-tool-orchestrator";
import { createCodeRunAdmission } from "./code-run-admission";
import { CompanyChatActions } from "./company-chat-actions";
import { CompanyChatLanguage, chatLanguageInstruction, companyChatCopy, detectCompanyChatLanguage, resolveConversationLanguage } from "./company-chat-i18n";
import { companyDeleteCompletedAll, companyDeleteConfirmAll, isCompanyDeleteConfirmed } from "./company-delete-i18n";
import { reconcilePlannedCompanyArgs } from "./company-plan-reconciliation";
import { verifyPlannedCompany } from "./company-plan-verification";
import { CompanyRunQueueProducer } from "./company-run-queue";
import { CompanyDelegationRuntime } from "./company-runtime";
import { compositeCreationCopy, compositeMemoryCopy } from "./composite-chat-i18n";
import { ContentLibraryStore } from "./content-library-store";
import { ContextCompactor } from "./context-compactor";
import { createCoreServices } from "./core-services";
import { createDataBackendServices } from "./data-backend-services";
import { extractDocumentText } from "./document-extractor";
import { EmailAttachmentStorage } from "./email-attachment-storage";
import { EmailChatActions } from "./email-chat-actions";
import { EmailInboxRepository } from "./email-inbox-repository";
import { EmailInboxWorker } from "./email-worker";
import { NoMemoryEvaluationResult, PerRequestNoMemoryGate } from "./ephemeral-no-memory-and-rtk";
import { memoryDocumentPrompt } from "./memory-documents";
import { pendingCompanyDelete } from "./pending-company-delete";
import { createProductionResilientAIEngine } from "./production-resilient-ai-engine";
import { SecurityPolicyEngine } from "./security-guardrails";
import { SpreadsheetModifier } from "./spreadsheet-modifier";
import { WorkspaceChatActions } from "./workspace-chat-actions";
import { ContextBuilder } from "@npati/agent";
import { AIEngine, ChatContentPart, ChatRequest, ChatToolCall, ChatToolDefinition, isChatCapableModel } from "@npati/omniroute-adapter";
import { defaultSkillRegistry } from "@npati/skills";
import { ResearchOutcome, ResearchProgressListener, extractTargetUrlOrDomain } from "@npati/web-research";
import { researchEvidenceContext, researchEvidenceInput } from "./chat-research-evidence";
import { resolveConfirmedVisionModel } from "./chat-inference-candidates";
import { visionUnavailableMessage } from "./company-chat-i18n";
import { AuthContext, Business } from "@npati/workspace";
import type { AgentAIContext } from "@npati/agent";
import { applyChatTelemetryHeaders } from "./chat-telemetry";

export interface ChatOrchestrationDeps {
  log: FastifyBaseLogger;
  config: AppConfig;
  admissionFor: (auth: AuthContext) => { tier?: "free" | "pro" | "enterprise" | "critical-orchestration"; tenantId?: string; queueTimeoutMs?: number };
  agent: ReturnType<typeof createCoreServices>["agent"];
  aiEngine: ReturnType<typeof createProductionResilientAIEngine>;
  aiPreferences: ReturnType<typeof createCoreServices>["aiPreferences"];
  apiKeysRepo: ReturnType<typeof createCoreServices>["apiKeysRepo"];
  auditRepo: ReturnType<typeof createAuditServices>["auditRepo"];
  automationsRepo: CompanyAutomationsRepository;
  browserCredentials: BrowserCredentialsRepository | undefined;
  chatFiles: ReturnType<typeof createCoreServices>["chatFiles"];
  companyRunQueue: CompanyRunQueueProducer | undefined;
  companyRuntime: CompanyDelegationRuntime;
  contentLibrary: ContentLibraryStore;
  dataBackendService: ReturnType<typeof createDataBackendServices>["dataBackendService"];
  emailAttachmentStorage: EmailAttachmentStorage | undefined;
  emailInboxRepo: EmailInboxRepository;
  integrationsRepo?: import("./integrations-repository").IntegrationsRepository;
  emailInboxWorker: EmailInboxWorker;
  fileRepository: ReturnType<typeof createCoreServices>["fileRepository"];
  getAIContext: (auth: AuthContext) => Promise<AgentAIContext>;
  guardrailPolicies: ReturnType<typeof createCoreServices>["guardrailPolicies"];
  hub: ReturnType<typeof createCoreServices>["hub"];
  knowledgeRepo: ReturnType<typeof createCoreServices>["knowledgeRepo"];
  memoryDocuments: ReturnType<typeof createCoreServices>["memoryDocuments"];
  objectStorage: ReturnType<typeof createCoreServices>["objectStorage"];
  persistBusinessLogo: ReturnType<typeof createCoreServices>["persistBusinessLogo"];
  researchBundle: ReturnType<typeof createCoreServices>["researchBundle"];
  runAutomation: (automation: import("./automations-repository").CompanyAutomation, executionKey: string) => Promise<{ result: string }>;
  scopedMemory: ReturnType<typeof createCoreServices>["scopedMemory"];
  webResearch: ReturnType<typeof createCoreServices>["webResearch"];
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
  marketplace?: import("@npati/omniroute-adapter").OmniRouteMarketplace;
}

export interface ChatOrchestration {
  persistAutomaticCompanyMemory: (auth: AuthContext, companyId: string, runId: string, prompt: string, runStatus: string, noMemory: boolean) => Promise<unknown>;
  beforeDeleteCompany: (context: AuthContext, companyId: string) => Promise<void>;
  runBusinessMessage: (auth: AuthContext, businessId: string, message: string, conversationId: string | undefined, log: { warn(value: unknown, message?: string): void }, progress?: ResearchProgressListener, attachments?: ChatAttachmentInput[], memoryPolicy?: NoMemoryEvaluationResult, signal?: AbortSignal) => Promise<Parameters<typeof applyChatTelemetryHeaders>[1] & { message: string; companyAction?: { companyId: string; action: string } }>;
  runNeutralMessage: (auth: AuthContext, message: string, conversationId: string | undefined, attachments?: ChatAttachmentInput[], progress?: ResearchProgressListener, memoryPolicy?: NoMemoryEvaluationResult, onDelta?: (chunk: string) => void, signal?: AbortSignal, managementCompany?: { id: string; name: string }, projectContext?: Pick<import("@npati/workspace").Project, "id" | "name" | "description" | "framework"> & { capabilityIds?: string[] }) => Promise<Parameters<typeof applyChatTelemetryHeaders>[1] & { message: string; companyAction?: { companyId: string; action: string } }>;
}

export function createChatOrchestration(deps: ChatOrchestrationDeps): ChatOrchestration {
  const { log, admissionFor, agent, aiEngine, aiPreferences, apiKeysRepo, auditRepo, automationsRepo, browserCredentials, chatFiles, companyRunQueue, companyRuntime, config, contentLibrary, dataBackendService, emailAttachmentStorage, emailInboxRepo, emailInboxWorker, fileRepository, getAIContext, guardrailPolicies, hub, integrationsRepo, knowledgeRepo, memoryDocuments, objectStorage, persistBusinessLogo, researchBundle, runAutomation, scopedMemory, webResearch, workspaceStore } = deps;

  const chatActions = createChatActions({
    log,
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
    integrationsRepo,
    emailInboxWorker,
    fileRepository,
    getAIContext,
    guardrailPolicies,
    hub,
    knowledgeRepo,
    objectStorage,
    persistBusinessLogo,
    runAutomation,
    scopedMemory,
    webResearch,
    workspaceStore,
  });
  const { contextBuilder, persistAutomaticCompanyMemory, persistBusinessCompactionFlush, beforeDeleteCompany, executeCompositeBusinessCompanyCreation, executeCompositeCompanyDeletion, executeCompanyChatAction, availableCoreChatTools, coreChatRoutingDecision, logToolSelectionConfiguration, logToolModelStep, logToolSelectionTrace, executeCoreChatTool, executeWorkspaceChatAction, completeCreatedBusinessGoal, completeCreatedBusinessMemory, executeEmailChatAction } = chatActions;

  async function runBusinessMessage(
    auth: AuthContext,
    businessId: string,
    message: string,
    conversationId: string | undefined,
    log: { warn(value: unknown, message?: string): void },
    progress?: ResearchProgressListener,
    attachments: ChatAttachmentInput[] = [],
    memoryPolicy: NoMemoryEvaluationResult = PerRequestNoMemoryGate.evaluate(),
    signal?:AbortSignal,
  ) {
    if(signal?.aborted)throw signal.reason??new DOMException("Cancelled","AbortError");
    const media = await prepareChatAttachments(aiEngine, message, attachments, progress);
    const inferenceImages = inferenceImagesForRequest(message, media.images);
    const safePrompt=SecurityPolicyEngine.protectText(media.prompt).sanitized;
    let conversation = memoryPolicy.noMemoryActive
      ? undefined
      : conversationId
        ? (await workspaceStore.getConversation(auth, businessId, conversationId)).conversation
        : await workspaceStore.createConversation(auth, businessId, conversationTitle(media.prompt));
    if (!memoryPolicy.noMemoryActive && media.decoded.length && !chatFiles) throw new Error("Persistent object storage is not configured.");
    const savedAttachments = !memoryPolicy.noMemoryActive && chatFiles && conversation
      ? await chatFiles.persist(auth,businessId,conversation.id,media.decoded.map((item)=>({ ...item, transcript: item.kind === "audio" ? media.transcripts.find((entry)=>entry.name===item.name)?.text : undefined })))
      : [];
    const storedDisplay = savedAttachments.length
      ? [
          ...savedAttachments.flatMap((item) => [
            "[[npati-attachment:" + item.kind + ":" + item.id + ":" + encodeURIComponent(item.name) + "]]",
            item.transcript && (!message.trim() || !item.name.startsWith("speech-")) ? "Transcript: " + item.transcript : String(),
          ]),
          message.trim(),
        ].filter(Boolean).join(String.fromCharCode(10, 10))
      : media.display;
    const existing = conversation ? await workspaceStore.getConversation(auth, businessId, conversation.id) : { messages: [] };
    const confirmedEntity = conversation ? await readChatActiveContext(workspaceStore, auth, conversation.id, businessId) : null;
    const companyMemoryTarget = !memoryPolicy.noMemoryActive ? await WorkspaceChatActions.companyInstructionTarget(auth, workspaceStore, safePrompt) : undefined;
    const confirmedCompanyId = companyMemoryTarget?.id ?? (confirmedEntity?.lastConfirmedAction.companyId
      ? await workspaceStore.getCompany(auth, confirmedEntity.lastConfirmedAction.companyId).then(company => company.id).catch(() => undefined) : undefined);
    const languageSource = message.trim() ? SecurityPolicyEngine.protectText(message).sanitized : safePrompt;
    const activeConversationLanguage = resolveConversationLanguage(languageSource, existing.messages);
    if (!memoryPolicy.noMemoryActive && conversation && existing.messages.length === 0 && conversation.title.trim().toLowerCase() === "new conversation") {
      conversation = await workspaceStore.updateConversation(auth, businessId, conversation.id, conversationTitle(media.prompt));
    }
    let context = SecurityPolicyEngine.protectObject(await contextBuilder.build(auth, businessId, safePrompt, { includeMemory: memoryPolicy.readAllowed }));
    context = { ...context, ai: { ...context.ai, admission: admissionFor(auth) } };
    if (memoryPolicy.readAllowed) {
      const userDocument = await memoryDocuments.getUserDocument(auth);
      if (userDocument) context = { ...context, memory: [...context.memory, {
        id: "user-md", workspaceId: auth.workspaceId, businessId, userId: auth.userId, type: "preference",
        title: "USER.md", content: userDocument.markdown, source: "user_profile", confidence: 1,
        createdAt: userDocument.updatedAt, updatedAt: userDocument.updatedAt,
      }] };
    }
    if (inferenceImages.length > 0) {
      const preferences = await aiPreferences.get(auth);
      // Image bytes only go to a model the refreshed catalog of a connected provider confirms can see (A040).
      const visionModel = deps.marketplace
        ? await resolveConfirmedVisionModel([config.omnirouteVisionModel, preferences.routing.defaultModelId], preferences.addedModels, deps.marketplace)
        : undefined;
      if (!visionModel) {
        const reply = visionUnavailableMessage(safePrompt);
        if (memoryPolicy.writeAllowed && conversation) await workspaceStore.appendMessage(auth, businessId, conversation.id, "assistant", reply);
        return { message: reply, suggestedActions: [], conversationId: conversation?.id };
      }
      context = { ...context, ai: { ...context.ai, model: visionModel, fallbackModel: undefined } };
    }
    if (memoryPolicy.writeAllowed && conversation) {
      try {
        const userMessage = await workspaceStore.appendMessage(auth, businessId, conversation.id, "user", storedDisplay);
        await chatFiles?.linkMessage(auth,savedAttachments.map((item)=>item.id),userMessage.id);
      } catch (error) {
        if (chatFiles) for (const item of savedAttachments) await chatFiles.delete(auth,item.id).catch(()=>undefined);
        throw error;
      }
    }
    const nativeToolCalling = aiEngine.supportsNativeTools?.(context.ai.model) === true;
    let research: ResearchOutcome | undefined;
    let researchJob;
    // Every research result of this turn, recorded verbatim for later recall in this conversation (A098).
    const researchRecords: Array<{ tool: string; query: string; outcome: ResearchOutcome }> = [];
    const hasAttachedEvidence = media.images.length > 0 || media.extractedDocs.length > 0;
    const workspaceSettingsRequest = !companyMemoryTarget && (WorkspaceChatActions.isManagementRequest(safePrompt) || await WorkspaceChatActions.namesOwnedAutomation(auth, workspaceStore, safePrompt, automationsRepo));
    const emailSettingsRequest = EmailChatActions.isManagementRequest(safePrompt);
    const imageResearchRequested = !forbidsNewWebResearch(message) && !nativeToolCalling && (!hasAttachedEvidence || explicitlyRequestsWebResearch(message))
      && ((!workspaceSettingsRequest && !emailSettingsRequest) || explicitlyRequestsWebResearch(message, { requireOperation: true }));
    if (imageResearchRequested && webResearch?.shouldResearch(safePrompt)) {
      const scope = { workspaceId: auth.workspaceId, businessId, userId: auth.userId };
      try {
        researchJob = memoryPolicy.writeAllowed ? await researchBundle?.jobs.create({
          ...scope,
          type: extractTargetUrlOrDomain(message) ? "crawl" : "search",
          input: { message: safePrompt, conversationId: conversation?.id },
        }) : undefined;
        if (researchJob) await researchBundle?.jobs.update(scope, researchJob.id, { status: "running" });
        research = (await webResearch.run(
          safePrompt,
          context.business ?? {},
          /\b(refresh|analyze again)\b|\u043e\u043d\u043e\u0432\u0438|\u043f\u043e\u0432\u0442\u043e\u0440\u0438\s+\u0430\u043d\u0430\u043b\u0456\u0437/iu.test(message),
          progress,
        )) ?? undefined;
        if(signal?.aborted)throw signal.reason??new DOMException("Cancelled","AbortError");
        if (research) researchRecords.push({ tool: "web_research", query: safePrompt, outcome: research });
        if (researchJob) {
          await researchBundle?.jobs.update(scope, researchJob.id, {
            status: "completed",
            resultSummary: JSON.stringify({ kind: research?.kind, sourceCount: research?.sources.length ?? 0, degraded: research?.degraded }),
          });
        }
      } catch (researchError) {
        log.warn({ err: researchError }, "Web research could not be completed");
        const detail = researchError instanceof Error ? researchError.message : "Web research is unavailable.";
        if (researchJob) await researchBundle?.jobs.update(scope, researchJob.id, { status: "failed", error: detail }).catch(() => undefined);
        research = { kind: "web_search" as const, context: "Web research failed safely. Explain the limitation and do not fabricate findings. Error: " + detail, sources: [], degraded: detail };
      }
    }
    if(signal?.aborted)throw signal.reason??new DOMException("Cancelled","AbortError");
    const protectedHistory = memoryPolicy.readAllowed
      ? existing.messages.map((item) => ({ ...item, content: SecurityPolicyEngine.protectText(item.content).sanitized }))
      : [];
    const priorResearch = memoryPolicy.readAllowed && conversation
      ? researchEvidenceContext((await workspaceStore.listConversationResearch?.(auth, conversation.id, 100) ?? []).filter(entry => entry.companyId === null))
      : undefined;
    const compaction = await ContextCompactor.compactWithModel({
      ai: aiEngine,
      model: context.ai.model,
      fallbackModel: context.ai.fallbackModel,
      messages: protectedHistory,
      signal,
    });
    const automaticMemoryFlush=await persistBusinessCompactionFlush(auth,businessId,compaction.flushedMemories,memoryPolicy.writeAllowed);
    progress?.({ type: "final_generation_started" });
    const userBusinesses = await workspaceStore.listUserBusinesses(auth).catch(() => []);
    const goalsByBusiness = await Promise.all(
      userBusinesses.map(async (b) => {
        const goals = await workspaceStore.listGoals(auth, b.id).catch(() => []);
        return { businessId: b.id, businessName: b.name, goals };
      })
    );
    const businessActionInstruction = BusinessActionHandler.buildSystemPrompt(userBusinesses, goalsByBusiness) + await CompanyChatActions.buildSystemPrompt(auth, workspaceStore, safePrompt, confirmedCompanyId, /агент|agent|модел|model/iu.test(safePrompt) ? (await aiPreferences.get(auth)).addedModels : []) + await WorkspaceChatActions.buildSystemPrompt(auth, workspaceStore, safePrompt, undefined, businessId, { automations: automationsRepo, content: contentLibrary, browserTargets: browserCredentials, email: emailInboxRepo, webhooks: integrationsRepo, memoryReadAllowed: memoryPolicy.readAllowed }) + await EmailChatActions.buildSystemPrompt(auth, workspaceStore, emailInboxRepo, safePrompt, undefined, apiKeysRepo) + chatLanguageInstruction(safePrompt, existing.messages, activeConversationLanguage) + (nativeToolCalling ? CHAT_TOOL_SELECTION_INSTRUCTION : "") + chatEntityReferencesPrompt(conversation?.id, { contextType: "business", companyId: null, businessId }, confirmedEntity?.lastConfirmedAction);
    let nativeCompanyAction: { action: "create" | "update" | "delete"; companyId: string; companyName: string; agentCount: number } | undefined;
    let nativeCompanyCleanText = "";
    let nativeCompanyPrimary = false;
    let nativeWorkspaceResult: Awaited<ReturnType<typeof executeWorkspaceChatAction>> | undefined;
    let nativeEmailResult: Awaited<ReturnType<typeof executeEmailChatAction>> | undefined;
    let nativeBusinessMessage = "";
    let nativeBusinessAction: { action: "create" | "update"; business: import("@npati/workspace").Business; businessId: string } | undefined;
    const businessCreateRequestKey = crypto.randomUUID();
    const nativeChat = nativeToolCalling ? async (request: ChatRequest) => {
      try {
        const companyManagement = Boolean(companyMemoryTarget || confirmedCompanyId && !workspaceSettingsRequest && !EmailChatActions.isManagementRequest(safePrompt) && CompanyChatActions.isPotentialMutationRequest(safePrompt));
        const tools = await availableCoreChatTools(auth, safePrompt, undefined, companyManagement);
        const plan = await planStructuredChatRequest(aiEngine, request, safePrompt);
        const routing = coreChatRoutingDecision(safePrompt, tools, hasAttachedEvidence, companyManagement);
        const businessPrimary = plan?.primary_action === "create_business_profile";
        const companyPrimary = plan?.primary_action === "create_company";
        nativeCompanyPrimary = companyPrimary;
        const needsResearch = plan?.requires_external_research === true;
        const routedRequest = { ...request, messages: plan ? [...request.messages, { role: "system" as const, content: `Internal execution plan: ${JSON.stringify(plan)}. Preserve the original user request and verify the primary outcome before responding.` }] : request.messages, toolChoice: businessPrimary ? (needsResearch ? "auto" as const : { type: "function" as const, function: { name: "npati_business_profile" } }) : companyPrimary ? (needsResearch ? "auto" as const : { type: "function" as const, function: { name: "npati_company_action" } }) : routing.toolChoice };
        logToolSelectionConfiguration(routedRequest, tools, {
          conversationId: conversation?.id,
          contextType: "business",
          activeConversationLanguage,
          semanticFiltering: routing,
        });
        const loop = await runChatToolLoop({
          ai: aiEngine,
          request: routedRequest,
          tools: () => tools,
          recoveryCall: companyPrimary && !needsResearch && plan?.entity?.trim() && (plan.company_agent_count === undefined || plan.company_agents?.length === plan.company_agent_count)
            ? { id: "planned-company-recovery", type: "function", function: { name: "npati_company_action", arguments: JSON.stringify({ action: "create", fields: {}, agents: [] }) } } : undefined,
          primaryOutcomeComplete: businessPrimary ? (metadata) => businessPlanComplete(plan, metadata) : companyPrimary ? (metadata) => companyPlanComplete(plan, metadata) : undefined,
          execute: (call, args) => executeCoreChatTool({ auth, call, args, requestMessage: safePrompt,
            conversationId: conversation?.id, selectedCompanyId: confirmedCompanyId, selectedBusinessId: businessId, noMemory: memoryPolicy.noMemoryActive, model: context.ai.model, fallbackModel: context.ai.fallbackModel, signal, progress, responseLanguage: activeConversationLanguage, plannedBusinessFields: businessPrimary ? plan?.provided_fields : undefined, primaryBusinessCreation: businessPrimary, businessCreateKey: businessCreateRequestKey, companyPlan: companyPrimary ? plan : undefined, logoAttachments: media.decoded.filter((item) => item.kind === "image").map((item) => ({ name: item.name, mimeType: item.mimeType, data: item.data, kind: item.kind })) }),
          onTrace: ({ arguments: _arguments, ...trace }) => logToolSelectionTrace(trace, { model: context.ai.model, conversationId: conversation?.id }, "Business chat tool selection"),
          onModelStep: (event) => logToolModelStep(event, { model: context.ai.model, conversationId: conversation?.id, contextType: "business" }),
        });
        for (const item of loop.metadata) {
          if (item.kind === "workspace_action" && item.outcome) nativeWorkspaceResult = item.outcome as NonNullable<typeof nativeWorkspaceResult>;
          if (item.kind === "email_action" && item.outcome) nativeEmailResult = item.outcome as NonNullable<typeof nativeEmailResult>;
          if (item.kind === "research" && item.research) {
            research = item.research as ResearchOutcome;
            researchRecords.push({ tool: String(item.tool ?? "web_research"), query: String(item.query ?? safePrompt), outcome: research });
          }
          if (item.kind === "business_profile" && item.outcome) {
            const outcome = item.outcome as { action: "create" | "update"; businessId: string };
            nativeBusinessAction = { action: outcome.action, business: await workspaceStore.getUserBusiness(auth, outcome.businessId), businessId: outcome.businessId };
          }
          if (item.kind === "company" && item.companyAction) {
            nativeCompanyAction = item.companyAction as typeof nativeCompanyAction;
            nativeCompanyCleanText = typeof item.cleanText === "string" ? item.cleanText : "";
          }
        }
        const businessSummary = summarizeBusinessProfileChat(loop.metadata, activeConversationLanguage, plan);
        if (businessSummary) {
          nativeBusinessMessage = businessSummary.message;
          nativeBusinessAction = { action: businessSummary.createdThisTurn ? "create" : businessSummary.outcome.action, business: await workspaceStore.getUserBusiness(auth, businessSummary.outcome.businessId), businessId: businessSummary.outcome.businessId };
        }
        return loop.result;
      } catch (error) {
        if (nativeCompanyPrimary || (error as { code?: string }).code === "TOOL_PRIMARY_INCOMPLETE") throw error;
        log.warn({ err: error, model: context.ai.model }, "Business native tool loop failed; using prompt-compatible fallback");
        return aiEngine.chat(request);
      }
    } : undefined;
    const result = await agent.handleBusinessMessage({
      message: safePrompt,
      context,
      history: compaction.preservedMessages as typeof existing.messages,
      contextSummary: [compaction.compacted ? compaction.summary : undefined, priorResearch ? SecurityPolicyEngine.protectText(priorResearch).sanitized : undefined].filter(Boolean).join("\n\n") || undefined,
      research: research ? SecurityPolicyEngine.protectObject(research) : undefined,
      images: inferenceImages,
      businessActionInstruction,
      signal,
      chat: nativeChat,
    });
    if (nativeBusinessMessage) result.message = nativeBusinessMessage;
    else if (nativeCompanyPrimary && nativeCompanyAction && nativeCompanyCleanText) result.message = nativeCompanyCleanText;
    if (nativeToolCalling && research?.sources.length) result.message = attachResearchSources(result.message, research);
    if(signal?.aborted)throw signal.reason??new DOMException("Cancelled","AbortError");
    const executedAction = await BusinessActionHandler.extractAndExecute(auth, normalizeNewBusinessDirective(result.message, safePrompt), workspaceStore, log, async (ctx, bid) => { await chatFiles?.deleteBusiness(ctx, bid); }, {
      logoAttachments: media.decoded.filter((item) => item.kind === "image").map((item) => ({ name: item.name, mimeType: item.mimeType, data: item.data, kind: item.kind })),
      persistBusinessLogo,
    });
    const emailAction = nativeEmailResult ?? (workspaceSettingsRequest ? { cleanText: executedAction.cleanText, emailAction: undefined, emailActions: undefined } : await executeEmailChatAction(auth, executedAction.cleanText, safePrompt, {
      model: context.ai.model, fallbackModel: context.ai.fallbackModel, signal,
      attachments: media.decoded.map((item) => ({ filename: item.name, contentType: item.mimeType, sizeBytes: item.data.length, contentBase64: item.data.toString("base64") })),
    }));
    const companyAction = nativeCompanyAction
      ? { cleanText: result.message || nativeCompanyCleanText, companyAction: nativeCompanyAction }
      : nativeBusinessAction || EmailChatActions.isManagementRequest(safePrompt) || workspaceSettingsRequest
      ? { cleanText: emailAction.cleanText, companyAction: undefined }
      : await executeCompanyChatAction(auth, emailAction.cleanText, conversation?.id, safePrompt, { model: context.ai.model, fallbackModel: context.ai.fallbackModel, signal, responseLanguage: activeConversationLanguage });
    const createdBusinessAction = nativeBusinessAction ?? executedAction.businessAction;
    const createdBusiness = createdBusinessAction?.action === "create" ? createdBusinessAction.business : undefined;
    const goalCompletion = await completeCreatedBusinessGoal(auth, safePrompt, createdBusiness, executedAction.cleanText);
    const initialWorkspaceAction = nativeWorkspaceResult ?? (nativeBusinessAction || nativeCompanyAction ? { cleanText: companyAction.cleanText, workspaceAction: undefined, companyRunId: undefined } : await executeWorkspaceChatAction(auth, companyAction.cleanText, conversation?.id, safePrompt, { model: context.ai.model, fallbackModel: context.ai.fallbackModel, signal, selectedBusinessId: createdBusiness?.id ?? businessId }));
    const workspaceAction = await completeCreatedBusinessMemory(auth, safePrompt, conversation?.id, createdBusiness, goalCompletion.reply, initialWorkspaceAction);
    result.message = workspaceAction.cleanText;
    progress?.({ type: "final_generation_completed" });
    if (memoryPolicy.writeAllowed && conversation) await workspaceStore.appendMessage(auth, businessId, conversation.id, "assistant", result.message);
    if (memoryPolicy.writeAllowed && conversation) for (const record of researchRecords)
      await workspaceStore.appendConversationResearch?.(auth, conversation.id, researchEvidenceInput(record.tool, record.query, record.outcome, null));
    return { ...result, businessAction: nativeBusinessAction ?? executedAction.businessAction, goalAction: goalCompletion.goalAction ?? executedAction.goalAction, emailAction: emailAction.emailAction, emailActions: emailAction.emailActions, companyAction: companyAction.companyAction, workspaceAction: workspaceAction.workspaceAction, companyRunId: workspaceAction.companyRunId, memoryCandidate: memoryPolicy.writeAllowed ? result.memoryCandidate : undefined, conversationId: conversation?.id, researchJobId: researchJob?.id, noMemory: memoryPolicy.noMemoryActive, contextCompaction: { applied: compaction.compacted, originalCount: compaction.originalCount, preservedCount: compaction.preservedMessages.length, failureReason: compaction.failureReason, automaticMemoryFlush } };
  }

  const { runNeutralMessage } = createChatTurn({
    marketplace: deps.marketplace,
    admissionFor,
    agent,
    aiEngine,
    aiPreferences,
    apiKeysRepo,
    automationsRepo,
    availableCoreChatTools,
    browserCredentials,
    chatFiles,
    completeCreatedBusinessGoal,
    completeCreatedBusinessMemory,
    config,
    contentLibrary,
    coreChatRoutingDecision,
    emailInboxRepo,
    integrationsRepo,
    executeCompanyChatAction,
    executeCompositeBusinessCompanyCreation,
    executeCompositeCompanyDeletion,
    executeCoreChatTool,
    executeEmailChatAction,
    executeWorkspaceChatAction,
    getAIContext,
    log,
    logToolModelStep,
    logToolSelectionConfiguration,
    logToolSelectionTrace,
    memoryDocuments,
    persistBusinessLogo,
    researchBundle,
    webResearch,
    workspaceStore,
  });

  return {
    persistAutomaticCompanyMemory,
    beforeDeleteCompany,
    runBusinessMessage,
    runNeutralMessage,
  };
}
