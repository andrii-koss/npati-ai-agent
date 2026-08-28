import cors from "@fastify/cors";
import { ContextBuilder, NpatiAgent } from "@npati/agent";
import { createHubClient } from "@npati/hub-connector";
import { InMemoryProvider } from "@npati/memory";
import { OmniRouteEngine, OmniRouteMarketplace, type AIEngine } from "@npati/omniroute-adapter";
import { createWebResearch, type ResearchProgressEvent, type ResearchProgressListener, type WebResearchService } from "@npati/web-research";
import type { AgentReply, HealthResponse } from "@npati/shared";
import { defaultSkillRegistry } from "@npati/skills";
import { InMemoryWorkspaceStore, PostgresWorkspaceStore, type AuthContext, type OnboardingScenario, type WorkspaceStore } from "@npati/workspace";
import { WorkspaceAccessError } from "@npati/workspace";
import Fastify from "fastify";
import { AIPreferencesStore } from "./ai-preferences";
import { registerAIRoutes } from "./ai-routes";
import { LocalDevAuthProvider, type AuthProvider } from "./auth";
import { registerWorkspaceRoutes } from "./workspace-routes";

export interface AppConfig {
  webOrigin?: string;
  omnirouteBaseUrl?: string;
  omnirouteApiKey?: string;
  omnirouteManagementPassword?: string;
  omnirouteTranscriptionModel?: string;
  dataDirectory?: string;
  hubBaseUrl?: string;
  hubApiKey?: string;
  databaseUrl?: string;
  workspaceStore?: WorkspaceStore;
  authProvider?: AuthProvider;
  aiEngine?: AIEngine;
  marketplace?: OmniRouteMarketplace;
  crawlerBaseUrl?: string;
  webResearch?: WebResearchService;
}

function inferOnboardingScenario(message: string): OnboardingScenario {
  if (/\b(sell|selling|sale)\b|продат|продаю|продавати|продаж|sprzed/i.test(message)) return "seller";
  if (/already have|existing business|my business|running business|маю бізнес|мій бізнес|вже є бізнес|існуюч/i.test(message)) return "existing";
  return "starting";
}

function conversationTitle(message: string) {
  const normalized = message
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1 $2")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[#*_\x60\s]+|[#*_\x60\s]+$/g, "")
    .trim();
  return Array.from(normalized).slice(0, 72).join("") || "New conversation";
}

type ChatAttachmentInput = {
  kind: "image" | "audio";
  name: string;
  mimeType: string;
  dataBase64: string;
};

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const allowedAudioTypes = new Set(["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac"]);

function safeAttachmentName(value: string) {
  return value.replace(/[^\p{L}\p{N}._ -]/gu, "_").trim().slice(0, 120) || "attachment";
}

function decodeAttachment(input: ChatAttachmentInput) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw new Error("Attachment data is not valid base64.");
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) throw new Error("The attached file is empty.");
  const allowed = input.kind === "image" ? allowedImageTypes : allowedAudioTypes;
  if (!allowed.has(input.mimeType)) throw new Error("Unsupported " + input.kind + " format: " + input.mimeType);
  const limit = input.kind === "image" ? 5 * 1024 * 1024 : 15 * 1024 * 1024;
  if (data.length > limit) throw new Error(input.kind === "image" ? "Each image must be 5 MB or smaller." : "Each audio file must be 15 MB or smaller.");
  if (input.kind === "image") {
    const validSignature =
      (input.mimeType === "image/jpeg" && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
      || (input.mimeType === "image/png" && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (input.mimeType === "image/gif" && data.subarray(0, 3).toString("ascii") === "GIF")
      || (input.mimeType === "image/webp" && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP");
    if (!validSignature) throw new Error("The image content does not match its declared format.");
  }
  return { ...input, name: safeAttachmentName(input.name), data };
}

async function prepareChatAttachments(aiEngine: AIEngine, message: string, attachments: ChatAttachmentInput[] = []) {
  if (attachments.length > 3) throw new Error("You can attach up to 3 files per message.");
  const decoded = attachments.map(decodeAttachment);
  const images = decoded.filter((item) => item.kind === "image").map((item) => ({ mimeType: item.mimeType, dataBase64: item.data.toString("base64") }));
  const audio = decoded.filter((item) => item.kind === "audio");
  const transcripts: Array<{ name: string; text: string }> = [];
  for (const item of audio) {
    if (!aiEngine.transcribeAudio) throw new Error("The selected AI runtime does not support audio transcription.");
    const result = await aiEngine.transcribeAudio({ data: item.data, mimeType: item.mimeType, filename: item.name });
    transcripts.push({ name: item.name, text: result.text });
  }
  const cleanMessage = message.trim();
  const transcriptContext = transcripts.map((item) => "Voice message transcript (" + item.name + "):\n" + item.text).join("\n\n");
  const prompt = [cleanMessage || (images.length ? "Analyze the attached image and explain what is useful for my business." : "Respond to my voice message."), transcriptContext].filter(Boolean).join("\n\n");
  const display = [
    cleanMessage,
    ...decoded.filter((item) => item.kind === "image").map((item) => "📷 Image: " + item.name),
    ...transcripts.map((item) => "🎤 Voice message: " + item.name + "\nTranscript: " + item.text),
  ].filter(Boolean).join("\n\n");
  return { prompt, display, images };
}

export function buildApp(config: AppConfig = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: 30 * 1024 * 1024 });
  const aiEngine = config.aiEngine ?? new OmniRouteEngine({
    baseUrl: config.omnirouteBaseUrl,
    apiKey: config.omnirouteApiKey,
    transcriptionModel: config.omnirouteTranscriptionModel,
  });
  const researchBundle = aiEngine instanceof OmniRouteEngine && config.crawlerBaseUrl
    ? createWebResearch(aiEngine, config.crawlerBaseUrl)
    : undefined;
  const webResearch = config.webResearch ?? researchBundle?.service;
  const marketplace = config.marketplace ?? new OmniRouteMarketplace({
    baseUrl: config.omnirouteBaseUrl,
    apiKey: config.omnirouteApiKey,
    managementPassword: config.omnirouteManagementPassword,
  });
  const aiPreferences = new AIPreferencesStore(config.dataDirectory);
  const hub = createHubClient({ baseUrl: config.hubBaseUrl, apiKey: config.hubApiKey });
  const agent = new NpatiAgent({ aiEngine, hub, memory: new InMemoryProvider() });
  const workspaceStore = config.workspaceStore ?? (config.databaseUrl ? new PostgresWorkspaceStore(config.databaseUrl) : new InMemoryWorkspaceStore());
  const authProvider = config.authProvider ?? new LocalDevAuthProvider();
  const getAIContext = async () => {
    const preferences = await aiPreferences.get();
    const automaticModel = preferences.routing.automaticModel;
    const manualModel = preferences.routing.mode === "manual" && preferences.routing.defaultModelId
      ? preferences.routing.defaultModelId
      : undefined;
    return {
      mode: preferences.routing.mode,
      model: manualModel ?? automaticModel,
      fallbackModel: manualModel && preferences.routing.fallbackOnFailure ? automaticModel : undefined,
      compression: preferences.routing.compression,
    };
  };
  const contextBuilder = new ContextBuilder({
    store: workspaceStore,
    hub,
    skills: defaultSkillRegistry,
    getAIContext,
  });

  async function runBusinessMessage(
    auth: AuthContext,
    businessId: string,
    message: string,
    conversationId: string | undefined,
    log: { warn(value: unknown, message?: string): void },
    progress?: ResearchProgressListener,
    attachments: ChatAttachmentInput[] = [],
  ) {
    const media = await prepareChatAttachments(aiEngine, message, attachments);
    let conversation = conversationId
      ? (await workspaceStore.getConversation(auth, businessId, conversationId)).conversation
      : await workspaceStore.createConversation(auth, businessId, conversationTitle(media.prompt));
    const existing = await workspaceStore.getConversation(auth, businessId, conversation.id);
    if (existing.messages.length === 0 && conversation.title.trim().toLowerCase() === "new conversation") {
      conversation = await workspaceStore.updateConversation(auth, businessId, conversation.id, conversationTitle(media.prompt));
    }
    const context = await contextBuilder.build(auth, businessId, media.prompt);
    await workspaceStore.appendMessage(auth, businessId, conversation.id, "user", media.display);
    let research;
    let researchJob;
    if (webResearch?.shouldResearch(media.prompt)) {
      const scope = { workspaceId: auth.workspaceId, businessId, userId: auth.userId };
      try {
        researchJob = await researchBundle?.jobs.create({
          ...scope,
          type: /https?:\/\//i.test(message) ? "crawl" : "search",
          input: { message: media.prompt, conversationId: conversation.id },
        });
        if (researchJob) await researchBundle?.jobs.update(scope, researchJob.id, { status: "running" });
        research = await webResearch.run(
          media.prompt,
          context.business ?? {},
          /\b(refresh|analyze again)\b|\u043e\u043d\u043e\u0432\u0438|\u043f\u043e\u0432\u0442\u043e\u0440\u0438\s+\u0430\u043d\u0430\u043b\u0456\u0437/iu.test(message),
          progress,
        );
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
    progress?.({ type: "final_generation_started" });
    const result = await agent.handleBusinessMessage({ message: media.prompt, context, history: existing.messages, research: research ?? undefined, images: media.images });
    progress?.({ type: "final_generation_completed" });
    await workspaceStore.appendMessage(auth, businessId, conversation.id, "assistant", result.message);
    return { ...result, conversationId: conversation.id, researchJobId: researchJob?.id };
  }

  app.register(cors, { origin: config.webOrigin ?? true });
  registerAIRoutes(app, marketplace, aiPreferences);
  registerWorkspaceRoutes(app, workspaceStore, authProvider);
  app.addHook("onReady", async () => {
    await workspaceStore.initialize();
    const routing = (await aiPreferences.get()).routing;
    if (typeof marketplace.configureRuntimePolicy === "function") {
      await marketplace.configureRuntimePolicy({
        compression: routing.compression,
        monthlyBudgetUsd: routing.monthlyBudgetUsd,
        warningPercent: routing.warningPercent,
        stopPaidWhenLimitReached: routing.stopPaidWhenLimitReached,
      }).catch((error) => app.log.warn({ err: error }, "Could not synchronize OmniRoute runtime policy"));
    }
  });

  app.get("/health", async (): Promise<HealthResponse> => {
    const [omniroute, hubHealth, databaseStatus, crawlerStatus] = await Promise.all([
      aiEngine.healthCheck(),
      hub.healthCheck(),
      workspaceStore.health(),
      researchBundle?.crawler.healthCheck() ?? Promise.resolve("not_configured" as const),
    ]);
    return {
      status: omniroute.status === "unavailable" ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      services: { agent: "ok", database: databaseStatus, omniroute: omniroute.status, crawler: crawlerStatus, hub: hubHealth.status },
      details: { omniroute, crawler: { status: crawlerStatus }, database: { status: databaseStatus }, hub: hubHealth },
    };
  });

  app.get("/skills", async () => defaultSkillRegistry.list());

  app.get<{ Params: { businessId: string; jobId: string } }>("/businesses/:businessId/research-jobs/:jobId", async (request, reply) => {
    try {
      const auth = await authProvider.authenticate(request);
      await workspaceStore.getBusiness(auth, request.params.businessId);
      if (!researchBundle?.jobs) {
        return reply.code(503).send({ error: { code: "WEB_RESEARCH_UNAVAILABLE", message: "Web research jobs are not configured." } });
      }
      const job = await researchBundle.jobs.get({
        workspaceId: auth.workspaceId,
        businessId: request.params.businessId,
        userId: auth.userId,
      }, request.params.jobId);
      if (!job) return reply.code(404).send({ error: { code: "RESEARCH_JOB_NOT_FOUND", message: "Research job not found." } });
      return job;
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        return reply.code(403).send({ error: { code: error.code, message: error.message } });
      }
      request.log.error(error);
      return reply.code(500).send({ error: { code: "RESEARCH_JOB_ERROR", message: "Could not load research job." } });
    }
  });

  app.post<{ Body: { message?: string; conversationId?: string; attachments?: ChatAttachmentInput[]; onboardingAction?: "start" | "skip" | "pause" | "resume" | "confirm"; scenario?: OnboardingScenario } }>("/chat", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          message: { type: "string", minLength: 1, maxLength: 10_000 },
          conversationId: { type: "string", minLength: 1, maxLength: 100 },
          attachments: {
            type: "array", maxItems: 3,
            items: {
              type: "object", additionalProperties: false, required: ["kind", "name", "mimeType", "dataBase64"],
              properties: {
                kind: { type: "string", enum: ["image", "audio"] },
                name: { type: "string", minLength: 1, maxLength: 160 },
                mimeType: { type: "string", minLength: 1, maxLength: 80 },
                dataBase64: { type: "string", minLength: 1, maxLength: 21_000_000 },
              },
            },
          },
          onboardingAction: { type: "string", enum: ["start", "skip", "pause", "resume", "confirm"] },
          scenario: { type: "string", enum: ["existing", "starting", "seller"] },
        },
      },
    },
  }, async (request, reply): Promise<AgentReply | unknown> => {
    try {
      const auth = await authProvider.authenticate(request);
      const overview = await workspaceStore.overview(auth);
      const connected = await marketplace.marketplace({ tab: "connected", limit: 1 });
      if (connected.overview.connectedProviders === 0) {
        return reply.code(409).send({ error: { code: "AI_PROVIDER_REQUIRED", message: "Connect an AI provider to start using NPATI Agent." } });
      }
      if (!overview.currentBusiness) {
        const action = request.body.onboardingAction;
        let session = overview.onboarding;
        if (action === "start") {
          if (!request.body.scenario) return reply.code(400).send({ error: { code: "ONBOARDING_SCENARIO_REQUIRED", message: "Choose an onboarding path." } });
          session = await workspaceStore.startOnboarding(auth, request.body.scenario);
        } else if (!session && request.body.message?.trim()) {
          session = await workspaceStore.startOnboarding(auth, inferOnboardingScenario(request.body.message));
        }
        if (action === "pause") {
          if (!session) return reply.code(409).send({ error: { code: "ONBOARDING_REQUIRED", message: "Choose how you want to set up your business." } });
          session = await workspaceStore.setOnboardingStatus(auth, session.id, "paused");
          return { message: "Your progress is saved. We can continue whenever you're ready.", suggestedActions: [], conversationId: session.conversationId, onboarding: session };
        } else if (action === "resume") {
          if (!session) return reply.code(409).send({ error: { code: "ONBOARDING_REQUIRED", message: "Choose how you want to set up your business." } });
          session = await workspaceStore.setOnboardingStatus(auth, session.id, "active");
        } else if (action === "confirm") {
          if (!session || session.status !== "awaiting_confirmation") return reply.code(409).send({ error: { code: "ONBOARDING_NOT_READY", message: "Finish the remaining onboarding details first." } });
          session = await workspaceStore.completeOnboarding(auth, session.id);
          const message = "Great. I now understand your business. What would you like to work on?";
          await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", message);
          return { message, suggestedActions: [], conversationId: session.conversationId, onboarding: session };
        }
        if (!session) return reply.code(409).send({ error: { code: "ONBOARDING_REQUIRED", message: "Choose how you want to set up your business." } });
        if (session.status === "paused" && action !== "resume") return reply.code(409).send({ error: { code: "ONBOARDING_PAUSED", message: "Continue your saved business setup first." } });
        if (request.body.message?.trim()) {
          const answer = request.body.message.trim();
          await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "user", answer);
          const ai = await getAIContext();
          const validation = await agent.validateOnboardingAnswer({ session, answer, ai });
          if (!validation.valid) {
            if (session.currentField === "businessGoal") {
              await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", validation.feedback);
              session = await workspaceStore.advanceOnboarding(auth, session.id, { skip: true });
              const traffic = await agent.generateTrafficRecommendation({ session, ai, latestAnswer: answer });
              await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", traffic.message);
              session = await workspaceStore.completeOnboarding(auth, session.id);
              return { ...traffic, conversationId: session.conversationId, onboarding: session };
            }
            const recovery = await agent.generateOnboardingRecovery({ session, answer, validationFeedback: validation.feedback, ai });
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", recovery.message);
            return { ...recovery, conversationId: session.conversationId, onboarding: session };
          }
          if (session.currentField === "businessGoal") {
            await workspaceStore.createGoal(auth, session.businessId, { title: validation.goalTitle ?? answer.slice(0, 240), status: "active", priority: 1 });
            session = await workspaceStore.advanceOnboarding(auth, session.id, { value: answer });
            const confirmation = validation.feedback || `Goal saved: ${validation.goalTitle ?? answer}`;
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", confirmation);
            const traffic = await agent.generateTrafficRecommendation({ session, ai, latestAnswer: answer });
            await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", traffic.message);
            session = await workspaceStore.completeOnboarding(auth, session.id);
            return { ...traffic, conversationId: session.conversationId, onboarding: session };
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
            return { ...traffic, conversationId: session.conversationId, onboarding: session };
          }
        } else if (action === "skip") {
          session = await workspaceStore.advanceOnboarding(auth, session.id, { skip: true });
        }
        const result = await agent.generateOnboardingQuestion({ session, ai: await getAIContext(), acknowledgedAnswer: Boolean(request.body.message) || action === "skip", latestAnswer: request.body.message });
        await workspaceStore.appendMessage(auth, session.businessId, session.conversationId, "assistant", result.message);
        return { ...result, conversationId: session.conversationId, onboarding: session };
      }
      if (!request.body.message?.trim() && !request.body.attachments?.length) return reply.code(400).send({ error: { code: "MESSAGE_REQUIRED", message: "Enter a message or attach a photo or voice message." } });
      return await runBusinessMessage(
        auth,
        overview.currentBusiness.id,
        request.body.message?.trim() ?? ",
        request.body.conversationId,
        request.log,
        undefined,
        request.body.attachments,
      );
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        return reply.code(403).send({ error: { code: error.code, message: error.message } });
      }
      request.log.error(error);
      const message = error instanceof Error && /OmniRoute|fetch|timeout|HTTP/i.test(error.message)
        ? "The AI engine is unavailable right now. Check OmniRoute and the connected provider, then try again."
        : "NPATI Agent could not complete this message. Please try again.";
      return reply.code(502).send({ error: { code: "AGENT_UNAVAILABLE", message } });
    }
  });

  app.post<{ Body: { message?: string; conversationId?: string; attachments?: ChatAttachmentInput[] } }>("/chat/stream", async (request, reply) => {
    try {
      const auth = await authProvider.authenticate(request);
      const overview = await workspaceStore.overview(auth);
      const connected = await marketplace.marketplace({ tab: "connected", limit: 1 });
      if (connected.overview.connectedProviders === 0) {
        return reply.code(409).send({ error: { code: "AI_PROVIDER_REQUIRED", message: "Connect an AI provider to start using NPATI Agent." } });
      }
      const message = request.body.message?.trim() ?? "";
      if (!message && !request.body.attachments?.length) return reply.code(400).send({ error: { code: "MESSAGE_REQUIRED", message: "Enter a message or attach a photo or voice message." } });
      if (!overview.currentBusiness) {
        return reply.code(409).send({ error: { code: "BUSINESS_REQUIRED", message: "Complete business setup before starting a streamed research chat." } });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.flushHeaders();
      let sequence = 0;
      const send = (event: "progress" | "result" | "error", data: unknown) => {
        if (reply.raw.destroyed) return;
        sequence += 1;
        reply.raw.write(`id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
      }, 15_000);
      const progress = (event: ResearchProgressEvent) => send("progress", { ...event, timestamp: new Date().toISOString() });
      try {
        const result = await runBusinessMessage(
          auth,
          overview.currentBusiness.id,
          message,
          request.body.conversationId,
          request.log,
          progress,
          request.body.attachments,
        );
        send("result", result);
      } catch (error) {
        request.log.error(error);
        const detail = error instanceof WorkspaceAccessError
          ? error.message
          : error instanceof Error && /OmniRoute|fetch|timeout|HTTP/i.test(error.message)
            ? "The AI engine is unavailable right now. Check OmniRoute and the connected provider, then try again."
            : "NPATI Agent could not complete this message. Please try again.";
        progress({ type: "final_generation_failed", error: detail });
        send("error", { error: { code: error instanceof WorkspaceAccessError ? error.code : "AGENT_UNAVAILABLE", message: detail } });
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    } catch (error) {
      if (!reply.sent) {
        request.log.error(error);
        return reply.code(500).send({ error: { code: "STREAM_UNAVAILABLE", message: "Could not start the chat stream." } });
      }
    }
  });

  return app;
}
