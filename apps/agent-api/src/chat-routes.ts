import {rowTaskCapabilities} from "./chat-project-data-capabilities";
import { isOllamaChatPayload } from "./runtime-compat-routes";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { AuthenticationError } from "./auth";
import { ChatAttachmentInput } from "./chat-attachments";
import { conversationTitle, inferOnboardingScenario, isLikelyOnboardingAside, isShortAffirmativeReply, isSimpleGreeting, onboardingGoalQuestion, quickOnboardingReply, requestsCompositeCompanyDeletionIntent } from "./chat-intent-helpers";
import { publicChatError, publicCompanyRunMessage } from "./chat-public-errors";
import { applyChatTelemetryHeaders } from "./chat-telemetry";
import { CompanyChatActions, isReadOnlyCompanySwitch } from "./company-chat-actions";
import { CompanyDelegationRuntime, companyRunTelemetryHeaders } from "./company-runtime";
import { ContextCompactor } from "./context-compactor";
import { createCoreServices } from "./core-services";
import { EmailChatActions } from "./email-chat-actions";
import { NoMemoryEvaluationResult, PerRequestNoMemoryGate } from "./ephemeral-no-memory-and-rtk";
import { saveChatProjectCard } from "./project-chat-cards";
import { ProjectOrchestrationError, ProjectOrchestrator } from "./project-orchestrator";
import { AdmissionError } from "./resilience-admission-queue";
import { SecurityPolicyViolation } from "./security-guardrails";
import { StorageRateLimitError } from "./storage-protection";
import { WorkspaceChatActions } from "./workspace-chat-actions";
import { AgentReply, ContextValidationError, defaultHybridRouter } from "@npati/shared";
import { ResearchProgressListener } from "@npati/web-research";
import { AuthContext, OnboardingScenario, WorkspaceAccessError } from "@npati/workspace";
import type { AgentAIContext } from "@npati/agent";
import { readIntentHistory } from "./chat-project-intent";

export interface ChatRouteDeps {
  ollamaChat?: ReturnType<typeof import("./runtime-compat-routes").createOllamaChatHandler>;
  resolveProjectIntent?: import("./chat-project-intent").ChatProjectIntentResolver;
  config: AppConfig;
  log: FastifyBaseLogger;
  activeChatStreams: Map<string,{controller:AbortController;workspaceId:string;userId:string}>;
  activeContextResolver: ReturnType<typeof createCoreServices>["activeContextResolver"];
  agent: ReturnType<typeof createCoreServices>["agent"];
  authProvider: ReturnType<typeof createCoreServices>["authProvider"];
  companyRuntime: CompanyDelegationRuntime;
  getAIContext: (auth: AuthContext) => Promise<AgentAIContext>;
  marketplace: ReturnType<typeof createCoreServices>["marketplace"];
  persistAutomaticCompanyMemory: (auth: AuthContext, companyId: string, runId: string, prompt: string, runStatus: string, noMemory: boolean) => Promise<unknown>;
  projectOrchestrator: ProjectOrchestrator;
  runBusinessMessage: (auth: AuthContext, businessId: string, message: string, conversationId: string | undefined, log: { warn(value: unknown, message?: string): void }, progress?: ResearchProgressListener, attachments?: ChatAttachmentInput[], memoryPolicy?: NoMemoryEvaluationResult, signal?: AbortSignal) => Promise<Parameters<typeof applyChatTelemetryHeaders>[1] & { message: string; companyAction?: { companyId: string; action: string } }>;
  runNeutralMessage: (auth: AuthContext, message: string, conversationId: string | undefined, attachments?: ChatAttachmentInput[], progress?: ResearchProgressListener, memoryPolicy?: NoMemoryEvaluationResult, onDelta?: (chunk: string) => void, signal?: AbortSignal, managementCompany?: { id: string; name: string }, projectContext?: Pick<import("@npati/workspace").Project, "id" | "name" | "description" | "framework"> & { capabilityIds?: string[] }) => Promise<Parameters<typeof applyChatTelemetryHeaders>[1] & { message: string; companyAction?: { companyId: string; action: string } }>;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
  boundedResponseChunks: (value: string, maxCharacters?: number) => Iterable<string>;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const { activeChatStreams, activeContextResolver, agent, authProvider, companyRuntime, getAIContext, marketplace, persistAutomaticCompanyMemory, projectOrchestrator, runBusinessMessage, runNeutralMessage, workspaceStore, boundedResponseChunks } = deps;
  app.post<{Params:{streamId:string}}>("/chat/streams/:streamId/cancel",async(request,reply)=>{
    const auth=await authProvider.authenticate(request);
    const active=activeChatStreams.get(request.params.streamId);
    if(!active)return {cancelled:false};
    if(active.workspaceId!==auth.workspaceId||active.userId!==auth.userId)return reply.code(403).send({error:{code:"STREAM_FORBIDDEN",message:"This chat stream belongs to another user."}});
    active.controller.abort(new DOMException("Stopped by user","AbortError"));
    return {cancelled:true};
  });

  app.post<{
    Body: {
      messages?: Array<{ role: string; content: string }>;
      conversationId?: string;
      keepRecentTurns?: number;
      maxMessages?: number;
      maxEstimatedTokens?: number;
    };
  }>("/chat/compact", async (request, reply) => {
    try {
      const auth = await authProvider.authenticate(request);
      let messages = request.body?.messages;
      if ((!messages || !messages.length) && request.body?.conversationId) {
        try {
          const conv = await workspaceStore.getNeutralConversation(auth, request.body.conversationId);
          if (conv?.messages) {
            messages = conv.messages.map((m: any) => ({ role: m.role, content: m.content }));
          }
        } catch {

        }
      }
      if (!messages || !Array.isArray(messages)) {
        return reply.code(400).send({
          error: { code: "MESSAGES_REQUIRED", message: "messages array or valid conversationId is required" }
        });
      }

      const result = ContextCompactor.compact(
        messages,
        request.body.keepRecentTurns ?? 4
      );

      return reply.code(200).send({
        compacted: result.compacted,
        summary: result.summary,
        flushedMemories: result.flushedMemories,
        preservedMessages: result.preservedMessages,
        originalCount: result.originalCount,
        preservedCount: result.preservedMessages.length,
      });
    } catch (error) {
      return reply.code(400).send({
        error: { code: "COMPACT_ERROR", message: error instanceof Error ? error.message : String(error) }
      });
    }
  });

  app.post<{ Body: {
    model?: string;
    messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stream?: boolean;
    message?: string;
    conversationId?: string;
    attachments?: ChatAttachmentInput[];
    onboardingAction?: "start" | "skip" | "pause" | "resume" | "confirm";
    businessSetup?: boolean;
    scenario?: OnboardingScenario;
    contextType?: "none" | "business" | "company" | "project";
    businessId?: string;
    companyId?: string;
    projectId?: string;
    noMemory?: boolean;
    ephemeral?: boolean;
  } }>("/chat", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          model: { type: "string", minLength: 1, maxLength: 200 },
          messages: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false, required: ["role", "content"], properties: { role: { type: "string", enum: ["system", "user", "assistant"] }, content: { type: "string", maxLength: 100_000 } } } },
          stream: { type: "boolean" },
          message: { type: "string", minLength: 1, maxLength: 100_000 },
          conversationId: { type: "string", minLength: 1, maxLength: 100 },
          attachments: {
            type: "array", maxItems: 3,
            items: {
              type: "object", additionalProperties: false, required: ["kind", "name", "mimeType", "dataBase64"],
              properties: {
                kind: { type: "string", enum: ["image", "audio", "document", "file"] },
                clientId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
                name: { type: "string", minLength: 1, maxLength: 160 },
                mimeType: { type: "string", minLength: 1, maxLength: 80 },
                dataBase64: { type: "string", minLength: 1, maxLength: 21_000_000 },
              },
            },
          },
          onboardingAction: { type: "string", enum: ["start", "skip", "pause", "resume", "confirm"] },
          businessSetup: { type: "boolean" },
          scenario: { type: "string", enum: ["existing", "starting", "seller"] },
          contextType: { type: "string", enum: ["none", "business", "company", "project"] },
          businessId: { type: "string", minLength: 1, maxLength: 100 },
          companyId: { type: "string", minLength: 1, maxLength: 100 },
          projectId: { type: "string", minLength: 1, maxLength: 100 },
          noMemory: { type: "boolean" },
          ephemeral: { type: "boolean" },
        },
      },
    },
  }, async (request, reply): Promise<AgentReply | unknown> => {
    let authForError: AuthContext | undefined;
    try {
      if (deps.ollamaChat && isOllamaChatPayload(request.body)) return deps.ollamaChat(request as Parameters<NonNullable<typeof deps.ollamaChat>>[0], reply);
      const auth = await authProvider.authenticate(request);
      authForError = auth;
      const memoryPolicy = PerRequestNoMemoryGate.evaluate(request.headers, request.body);
      const connected = await marketplace.marketplace({ tab: "connected", limit: 1 });
      if (connected.overview.connectedProviders === 0) {
        return reply.code(409).send({ error: { code: "AI_PROVIDER_REQUIRED", message: "Connect an AI provider to start using NPATI Agent." } });
      }

      const overview = await workspaceStore.overview(auth);

      const chatBody = request.body as Record<string, any>;

      const requestedContext = {
        contextType: chatBody.contextType ?? (chatBody.projectId ? "project" : chatBody.companyId ? "company" : "business"),
        businessId: chatBody.businessSetup
          ? null
          : chatBody.businessId ?? ((chatBody.contextType === "none" || chatBody.contextType === "company" || chatBody.contextType === "project" || chatBody.companyId || chatBody.projectId) ? null : overview.currentBusiness?.id ?? null),
        companyId: chatBody.companyId ?? null,
        projectId: chatBody.projectId ?? null,
      };

      const prompt = chatBody.message?.trim();
      const history = !memoryPolicy.noMemoryActive
        ? await readIntentHistory(workspaceStore, auth, request.body.conversationId, requestedContext.businessId) : [];
      const semantic = await deps.resolveProjectIntent?.(auth, {
        message: prompt ?? "", activeCompanyId: requestedContext.companyId, activeProjectId: requestedContext.projectId,
        attachmentNames: request.body.attachments?.flatMap(item => typeof item?.name === "string" ? [item.name] : []),
        conversationHistory: history,
      });
      const resolved = await activeContextResolver.resolveChat(auth, requestedContext, prompt ?? "", semantic?.decision);
      const activeProjId = resolved.project?.id ?? null;
      const activeCompId = requestedContext.companyId ?? resolved.company?.id ?? resolved.project?.companyId ?? null;

      if(semantic?.rowCapability&&resolved.project&&resolved.company){
        const result=await runNeutralMessage(auth,prompt??"",request.body.conversationId,request.body.attachments,undefined,memoryPolicy,undefined,undefined,{id:resolved.company.id,name:resolved.company.name},{...resolved.project,capabilityIds:rowTaskCapabilities(semantic.rowCapability)});
        return reply.send({...result,activeContext:resolved.context});
      }
      const intentDecision = semantic?.decision ?? defaultHybridRouter.classifyProject({
        message: prompt || "",
        activeCompanyId: activeCompId,
        activeProjectId: activeProjId,
        hasWorkspace: Boolean(overview.currentBusiness || resolved.company || resolved.project),
      });

      if (intentDecision.unsupportedIntentMessage) {
        return {
          message: intentDecision.unsupportedIntentMessage,
          suggestedActions: [],
          activeContext: resolved.context,
        };
      }

      if (intentDecision.needsClarification && intentDecision.clarificationPrompt) {
        return {
          message: intentDecision.clarificationPrompt,
          suggestedActions: [],
          activeContext: resolved.context,
        };
      }

      if (intentDecision.isExecutableInStep5 && intentDecision.intent !== "CHAT") {
        if (!prompt && !chatBody.attachments?.length) {
          return reply.code(400).send({ error: { code: "MESSAGE_REQUIRED", message: "Enter a message or attach a photo or voice message." } });
        }

        let targetCompanyId: string | null = activeCompId;
        if (!targetCompanyId) {
          const companyPage = await workspaceStore.listCompanies(auth);
          const companies = companyPage.items;
          if (companies.length === 0) {
            return {
              message: "Для створення сайту потрібна активна Компанія. Будь ласка, створіть компанію у відповідному розділі.",
              suggestedActions: ["Створити компанію"],
              activeContext: resolved.context,
            };
          }
          if (companies.length === 1 && companies[0]) {
            targetCompanyId = companies[0].id;
          } else {
            return {
              message: `Для створення або редагування сайту виберіть активну Компанію. Доступні компанії: ${companies.map(c => c.name).join(", ")}.`,
              suggestedActions: companies.slice(0, 3).map(c => `Компанія: ${c.name}`),
              activeContext: resolved.context,
            };
          }
        }

        if (!targetCompanyId) {
          return {
            message: "Будь ласка, оберіть активну Компанію для продовження.",
            suggestedActions: [],
            activeContext: resolved.context,
          };
        }

        const projectExecResult = await projectOrchestrator.executeWebsiteTask(auth, {
          companyId: targetCompanyId,
          projectId: intentDecision.intent === "CREATE_PROJECT" || intentDecision.intent === "CREATE_WEBSITE" ? undefined : activeProjId ?? undefined,
          intentDecision,
          prompt: prompt || "",
          idempotencyKey: (request.headers["idempotency-key"] as string) || `website-${Date.now()}`,
        });

        const conversation = memoryPolicy.writeAllowed
          ? request.body.conversationId
            ? (await workspaceStore.getNeutralConversation(auth, request.body.conversationId)).conversation
            : await workspaceStore.createNeutralConversation(auth, conversationTitle(prompt || "Website Task"))
          : undefined;

        if (conversation) {
          await workspaceStore.appendNeutralMessage(auth, conversation.id, "user", prompt || "Website Task");
          const assistantMessage = await workspaceStore.appendNeutralMessage(auth, conversation.id, "assistant", projectExecResult.responseMessage);
          await saveChatProjectCard(workspaceStore, auth, conversation.id, assistantMessage.id, projectExecResult.projectCard);
        }

        return {
          message: projectExecResult.responseMessage,
          suggestedActions: [
            ...(projectExecResult.previewUrl ? [`Preview: ${projectExecResult.project.name}`] : []),
            `Open: ${projectExecResult.project.name}`,
          ],
          conversationId: conversation?.id,
          activeContext: {
            contextType: "project",
            companyId: projectExecResult.project.companyId,
            projectId: projectExecResult.project.id,
            workspaceId: auth.workspaceId,
            businessId: null,
          },
          companyRunId: projectExecResult.runDetails.run.id,
          projectCard: projectExecResult.projectCard,
          projectAction: projectExecResult.projectAction,
        };
      }

      if (resolved.context.contextType === "none") {
        const prompt = request.body.message?.trim();
        if (!prompt && !request.body.attachments?.length) {
          return reply.code(400).send({ error: { code: "MESSAGE_REQUIRED", message: "Enter a message or attach a photo or voice message." } });
        }
        const result = await runNeutralMessage(auth, prompt || "", request.body.conversationId, request.body.attachments, undefined, memoryPolicy, undefined, undefined);
        applyChatTelemetryHeaders(reply, result);
        return { ...result, activeContext: resolved.context };
      }

      if (resolved.context.contextType === "company") {
        const prompt = request.body.message?.trim();
        if (!prompt && !request.body.attachments?.length) {
          return reply.code(400).send({ error: { code: "MESSAGE_REQUIRED", message: "Enter a message or attach a photo or voice message." } });
        }
        const company = resolved.company!;
        const managementRequest = Boolean(prompt && (isShortAffirmativeReply(prompt) || requestsCompositeCompanyDeletionIntent(prompt) || EmailChatActions.isManagementRequest(prompt) || CompanyChatActions.isManagementRequest(prompt) || CompanyChatActions.isPotentialMutationRequest(prompt) || WorkspaceChatActions.isManagementRequest(prompt) || WorkspaceChatActions.isPotentialMutationRequest(prompt)));
        const runnableMainAgent = company.mainAgentId
          ? await workspaceStore.getCompanyAgent(auth, company.id, company.mainAgentId).then((agent) => agent.isActive).catch(() => false)
          : false;
        if (managementRequest || isReadOnlyCompanySwitch(prompt ?? "") || !runnableMainAgent) {
          const result = await runNeutralMessage(auth, prompt || "", request.body.conversationId, request.body.attachments, undefined, memoryPolicy, undefined, undefined, { id: company.id, name: company.name });
          applyChatTelemetryHeaders(reply, result);
          return { ...result, activeContext: resolved.context };
        }
        const conversation = memoryPolicy.writeAllowed
          ? request.body.conversationId
            ? (await workspaceStore.getNeutralConversation(auth, request.body.conversationId)).conversation
            : await workspaceStore.createNeutralConversation(auth, conversationTitle(prompt || "Analyze company state"))
          : undefined;
        if (conversation) await workspaceStore.appendNeutralMessage(auth, conversation.id, "user", prompt || "Analyze company state");
        const runResult = await companyRuntime.execute(
          auth,
          company.id,
          { task: prompt || "Analyze company state", noMemory: memoryPolicy.noMemoryActive, memoryScope:{sessionId:conversation?.id} },
          (request.headers["idempotency-key"] as string) || `chat-${Date.now()}`
        );
        for (const [name, value] of Object.entries(companyRunTelemetryHeaders(runResult))) reply.header(name, value);
        if(runResult.run.errorCode==="SECURITY_GUARDRAIL_BLOCKED")return reply.code(400).send({error:{code:runResult.run.errorCode,message:runResult.run.errorMessage}});

        const automaticMemory = await persistAutomaticCompanyMemory(
          auth,
          company.id,
          runResult.run.id,
          prompt || "",
          runResult.run.status,
          memoryPolicy.noMemoryActive,
        );

        const responseMessage = publicCompanyRunMessage(runResult.run.result, runResult.run.errorMessage, prompt || "", runResult.run.errorCode);
        if (conversation) await workspaceStore.appendNeutralMessage(auth, conversation.id, "assistant", responseMessage);
        return {
          message: responseMessage,
          suggestedActions: [],
          conversationId: conversation?.id,
          activeContext: resolved.context,
          companyRunId: runResult.run.id,
          automaticMemory,
        };
      }

      if (!resolved.business) {
        if (memoryPolicy.noMemoryActive) {
          return reply.code(409).send({ error: { code: "NO_MEMORY_ONBOARDING_UNSUPPORTED", message: "Finish business setup before using a private no-memory request." } });
        }
        const action = request.body.onboardingAction;
        let session = request.body.businessId ? await workspaceStore.getOnboarding(auth, request.body.businessId) : overview.onboarding;
        if (action === "start") {
          if (!request.body.scenario) return reply.code(400).send({ error: { code: "ONBOARDING_SCENARIO_REQUIRED", message: "Choose an onboarding path." } });
          session = await workspaceStore.startOnboarding(auth, request.body.scenario);
        } else if (!session && request.body.message?.trim()) {
          session = await workspaceStore.startOnboarding(auth, inferOnboardingScenario(request.body.message));
        }
        if (action === "pause") {
          if (!session) return reply.code(409).send({ error: { code: "ONBOARDING_REQUIRED", message: "Choose how you want to set up your business." } });
          session = await workspaceStore.setOnboardingStatus(auth, session.id, "paused");
          return { message: "Your progress is saved. We can continue whenever you're ready.", suggestedActions: [], conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
        } else if (action === "resume") {
          if (!session) return reply.code(409).send({ error: { code: "ONBOARDING_REQUIRED", message: "Choose how you want to set up your business." } });
          session = await workspaceStore.setOnboardingStatus(auth, session.id, "active");
        } else if (action === "confirm") {
          if (!session || session.status !== "awaiting_confirmation") return reply.code(409).send({ error: { code: "ONBOARDING_NOT_READY", message: "Finish the remaining onboarding details first." } });
          session = await workspaceStore.completeOnboarding(auth, session.id);
          const message = "Great. I now understand your business. What would you like to work on?";
          await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", message);
          return { message, suggestedActions: [], conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
        }
        if (!session) return reply.code(409).send({ error: { code: "ONBOARDING_REQUIRED", message: "Choose how you want to set up your business." } });
        if (session.status === "paused" && action !== "resume") return reply.code(409).send({ error: { code: "ONBOARDING_PAUSED", message: "Continue your saved business setup first." } });
        if (request.body.message?.trim()) {
          const answer = request.body.message.trim();
          await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "user", answer);
          const quickReply = session.currentField === "businessSnapshot" ? quickOnboardingReply(answer) : undefined;
          if (quickReply) {
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", quickReply);
            return { message: quickReply, suggestedActions: [], conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
          }
          if (session.currentField === "businessSnapshot" && isSimpleGreeting(answer)) {
            const greeting = /[іїєґ]/iu.test(answer)
              ? "Привіт! Розкажіть коротко, який бізнес, товар або послугу ви хочете створити."
              : "Hi! Tell me briefly what business, product, or service you want to create.";
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", greeting);
            return { message: greeting, suggestedActions: [], conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
          }
          const ai = await getAIContext(auth);
          if (session.currentField === "businessSnapshot" && isLikelyOnboardingAside(answer)) {
            const aside = await agent.generateOnboardingRecovery({ session, answer, validationFeedback: "The user asked a general question instead of providing business context.", ai });
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", aside.message);
            return { ...aside, conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
          }
          const validation = await agent.validateOnboardingAnswer({ session, answer, ai });
          if (!validation.valid) {
            if (session.currentField === "businessGoal") {
              await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", validation.feedback);
              session = await workspaceStore.advanceOnboarding(auth, session.id, { skip: true });
              const traffic = await agent.generateTrafficRecommendation({ session, ai, latestAnswer: answer });
              await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", traffic.message);
              session = await workspaceStore.completeOnboarding(auth, session.id);
              return { ...traffic, conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
            }
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", validation.feedback);
            return { message: validation.feedback, suggestedActions: [], model: validation.model, conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
          }
          if (session.currentField === "businessGoal") {
            await workspaceStore.createGoal(auth, session.businessId, { title: validation.goalTitle ?? answer.slice(0, 240), status: "active", priority: 1 });
            session = await workspaceStore.advanceOnboarding(auth, session.id, { value: answer });
            const confirmation = validation.feedback || `Goal saved: ${validation.goalTitle ?? answer}`;
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", confirmation);
            const traffic = await agent.generateTrafficRecommendation({ session, ai, latestAnswer: answer });
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", traffic.message);
            session = await workspaceStore.completeOnboarding(auth, session.id);
            return { ...traffic, conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
          }
          session = await workspaceStore.advanceOnboarding(auth, session.id, { value: answer, businessPatch: validation.businessPatch });
          try {
            await workspaceStore.createMemory(auth, session.businessId, {
              type: "business_fact",
              title: `${session.business.name} context`,
              content: answer,
              source: "chat_onboarding",
              confidence: 1,
            });
          } catch (memoryError) {
            request.log.warn({ err: memoryError }, "Could not save onboarding context to Memory");
          }
          if (validation.goalTitle) {
            await workspaceStore.createGoal(auth, session.businessId, { title: validation.goalTitle, status: "active", priority: 1 });
            session = await workspaceStore.advanceOnboarding(auth, session.id, { value: validation.goalTitle });
            const traffic = await agent.generateTrafficRecommendation({ session, ai, latestAnswer: answer });
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", traffic.message);
            session = await workspaceStore.completeOnboarding(auth, session.id);
            return { ...traffic, conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
          }
          const goalQuestion = onboardingGoalQuestion(answer);
          await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", goalQuestion);
          return { message: goalQuestion, suggestedActions: [], model: validation.model, conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
        } else if (action === "skip") {
          session = await workspaceStore.advanceOnboarding(auth, session.id, { skip: true });
        }
        const result = await agent.generateOnboardingQuestion({ session, ai: await getAIContext(auth), acknowledgedAnswer: Boolean(request.body.message) || action === "skip", latestAnswer: request.body.message });
        await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", result.message);
        return { ...result, conversationId: session.conversationId, onboarding: session, activeContext: resolved.context };
      }
      if (!request.body.message?.trim() && !request.body.attachments?.length) return reply.code(400).send({ error: { code: "MESSAGE_REQUIRED", message: "Enter a message or attach a photo or voice message." } });
      const businessResult = await runBusinessMessage(
        auth,
        resolved.business!.id,
        request.body.message?.trim() || String(),
        request.body.conversationId,
        request.log,
        undefined,
        request.body.attachments,
        memoryPolicy,
      );
      applyChatTelemetryHeaders(reply, businessResult);
      return { ...businessResult, activeContext: resolved.context };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof ContextValidationError) {
        return reply.code(400).send({ error: { code: "INVALID_CONTEXT", message: error.message } });
      }
      if(error instanceof SecurityPolicyViolation)return reply.code(error.status).send({error:{code:error.code,reasonCode:error.reasonCode,message:error.message}});
      if (error instanceof WorkspaceAccessError) {
        return reply.code(403).send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof ProjectOrchestrationError) {
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof StorageRateLimitError) return reply.header("retry-after",String(Math.ceil(error.retryAfterMs/1000))).code(429).send({error:{code:error.code,message:error.message}});
      if (error instanceof AdmissionError) return reply.header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))).code(429).send({ error: { code: error.code, message: error.message } });
      request.log.error(error);
      const route = authForError ? await getAIContext(authForError).then((ai) => ai.model).catch(() => undefined) : undefined;
      const message = publicChatError(error, route);
      return reply.code(502).send({ error: { code: "AGENT_UNAVAILABLE", message } });
    }
  });
}
