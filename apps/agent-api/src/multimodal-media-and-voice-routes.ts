import type { FastifyInstance } from "fastify";
import { ContentModerationEngine } from "./multimodal-inference-engine";
import { BrowserSecurityGuard } from "./browser-security-guard";
import {
  globalVideoPipeline,
  globalMusicEngine,
  globalSpeechEngine,
  globalVoiceCallManager,
  globalMobileVoiceAdapter,
  globalAudioTranslationEngine,
  globalVideoUnderstandingEngine,
  SUPPORTED_PROVIDERS,
  ctx,
  err,
  type MultimodalRouteDeps,
} from "./multimodal-engines";

export function registerMultimodalMediaAndVoiceRoutes(
  app: FastifyInstance,
  deps: MultimodalRouteDeps,
) {
  const { auth } = deps;

  // =========================================================================
  // 6. #147 Audio translation
  // =========================================================================

  app.post<{
    Body: {
      audioBase64: string;
      sourceLanguage?: string;
      targetLanguage?: string;
    };
  }>("/media/audio/translate", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { audioBase64, sourceLanguage = "uk", targetLanguage = "en" } = r.body || {};

      if (!audioBase64 || typeof audioBase64 !== "string" || audioBase64.trim().length === 0) {
        throw Object.assign(new Error("audioBase64 is required for translation."), { status: 400, code: "MISSING_AUDIO" });
      }

      if (Buffer.byteLength(audioBase64, "utf8") > 25 * 1024 * 1024) {
        throw Object.assign(new Error("audioBase64 exceeds maximum allowed size of 25MB."), { status: 400, code: "PAYLOAD_TOO_LARGE" });
      }

      const langRegex = /^[a-z]{2}(-[A-Z]{2})?$/;
      if (sourceLanguage && !langRegex.test(sourceLanguage)) {
        throw Object.assign(
          new Error(`Invalid sourceLanguage code format '${sourceLanguage}'. Expected format: 'uk', 'en', 'en-US'.`),
          { status: 400, code: "INVALID_LANGUAGE_CODE" }
        );
      }
      if (targetLanguage && !langRegex.test(targetLanguage)) {
        throw Object.assign(
          new Error(`Invalid targetLanguage code format '${targetLanguage}'. Expected format: 'en', 'uk', 'es-ES'.`),
          { status: 400, code: "INVALID_LANGUAGE_CODE" }
        );
      }

      const audioBuffer = Buffer.from(audioBase64, "base64");
      const translation = globalAudioTranslationEngine.translate(audioBuffer, {
        sourceLanguage,
        targetLanguage,
      });

      return reply.code(200).send(translation);
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 7. #148 Video understanding
  // =========================================================================

  app.post<{
    Body: {
      videoUrl: string;
      durationSeconds?: number;
      fps?: number;
      query: string;
    };
  }>("/media/video/understand", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { videoUrl, durationSeconds = 10, fps = 2, query } = r.body || {};

      if (!videoUrl || typeof videoUrl !== "string" || videoUrl.trim().length === 0 || !query || typeof query !== "string" || query.trim().length === 0) {
        throw Object.assign(new Error("videoUrl and query are required parameters."), { status: 400, code: "MISSING_PARAMETERS" });
      }

      // SSRF guardrail on video URL
      const urlValidation = BrowserSecurityGuard.validateUrl(videoUrl);
      if (!urlValidation.allowed) {
        throw Object.assign(new Error(urlValidation.reason || "SSRF: Video URL is blocked."), {
          status: 403,
          code: "SSRF_BLOCKED",
        });
      }

      // Content moderation check on user query
      const mod = ContentModerationEngine.moderateText(query);
      if (mod.flagged) {
        throw Object.assign(new Error(`Video query flagged by content moderation: ${mod.detectedViolations.join(", ")}`), {
          status: 400,
          code: "CONTENT_MODERATION_FLAGGED",
        });
      }

      if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || durationSeconds <= 0 || durationSeconds > 3600)) {
        throw Object.assign(new Error("Invalid durationSeconds. Must be a positive number up to 3600."), {
          status: 400,
          code: "INVALID_DURATION",
        });
      }

      if (fps !== undefined && (typeof fps !== "number" || fps <= 0 || fps > 60)) {
        throw Object.assign(new Error("Invalid fps. Must be a positive number up to 60."), {
          status: 400,
          code: "INVALID_FPS",
        });
      }

      const analysis = globalVideoUnderstandingEngine.analyze(
        { url: videoUrl, durationSeconds, fps },
        query
      );

      return reply.code(200).send(analysis);
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 8. #235 & #246 Video generation (Unified Video Service)
  // =========================================================================

  app.post<{
    Body: {
      prompt: string;
      durationSeconds?: number;
      resolution?: "720p" | "1080p" | "4k";
      engine?: string;
    };
  }>("/media/video/generate", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { prompt, durationSeconds = 5, resolution = "1080p", engine = "runway-gen-3" } = r.body || {};

      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        throw Object.assign(new Error("prompt is required for video generation."), { status: 400, code: "MISSING_PROMPT" });
      }

      // Moderation
      const mod = ContentModerationEngine.moderateText(prompt);
      if (mod.flagged) {
        throw Object.assign(new Error(`Video prompt was flagged by Content Moderation: ${mod.detectedViolations.join(", ")}`), {
          status: 400,
          code: "CONTENT_MODERATION_FLAGGED",
        });
      }

      // Engine validation
      if (!(SUPPORTED_PROVIDERS.videoEngines as readonly string[]).includes(engine)) {
        throw Object.assign(
          new Error(`Unsupported video engine '${engine}'. Supported: ${SUPPORTED_PROVIDERS.videoEngines.join(", ")}`),
          { status: 400, code: "UNSUPPORTED_VIDEO_ENGINE" }
        );
      }

      // Duration validation
      if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || durationSeconds <= 0 || durationSeconds > 300)) {
        throw Object.assign(new Error("Invalid durationSeconds. Must be a positive number up to 300."), {
          status: 400,
          code: "INVALID_DURATION",
        });
      }

      // Resolution validation
      const VALID_RESOLUTIONS = new Set(["720p", "1080p", "4k"]);
      if (resolution && !VALID_RESOLUTIONS.has(resolution)) {
        throw Object.assign(
          new Error(`Invalid resolution '${resolution}'. Supported: 720p, 1080p, 4k`),
          { status: 400, code: "INVALID_RESOLUTION" }
        );
      }

      const job = globalVideoPipeline.createJob({
        prompt,
        durationSeconds,
        resolution,
        engine: engine as Parameters<typeof globalVideoPipeline.createJob>[0]["engine"],
      });

      // Complete job with deterministic CDN URL for verification
      const completed = globalVideoPipeline.completeJob(
        job.jobId,
        `https://cdn.npati.io/artifacts/videos/${job.jobId}.mp4`
      );

      return reply.code(201).send({ job: completed });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { jobId: string } }>("/media/video/jobs/:jobId", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const job = globalVideoPipeline.getJob(r.params.jobId);
      if (!job) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Video job not found." } });
      }
      return reply.code(200).send({ job });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{ Params: { jobId: string } }>("/media/video/jobs/:jobId/cancel", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const existing = globalVideoPipeline.getJob(r.params.jobId);
      if (!existing) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Video job not found." } });
      }
      const cancelled = globalVideoPipeline.cancelJob(r.params.jobId);
      return reply.code(200).send({ job: cancelled });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 9. #247 Music generation
  // =========================================================================

  app.post<{
    Body: {
      prompt: string;
      genre?: string;
      durationSeconds?: number;
      tempoBpm?: number;
    };
  }>("/media/music/generate", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { prompt, genre = "synthwave", durationSeconds = 60, tempoBpm = 120 } = r.body || {};

      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        throw Object.assign(new Error("prompt is required for music generation."), { status: 400, code: "MISSING_PROMPT" });
      }

      // Moderation
      const mod = ContentModerationEngine.moderateText(prompt);
      if (mod.flagged) {
        throw Object.assign(new Error(`Music prompt was flagged by Content Moderation: ${mod.detectedViolations.join(", ")}`), {
          status: 400,
          code: "CONTENT_MODERATION_FLAGGED",
        });
      }

      // Duration validation
      if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || durationSeconds <= 0 || durationSeconds > 600)) {
        throw Object.assign(new Error("Invalid durationSeconds. Must be a positive number up to 600."), {
          status: 400,
          code: "INVALID_DURATION",
        });
      }

      // Tempo validation
      if (tempoBpm !== undefined && (typeof tempoBpm !== "number" || tempoBpm < 30 || tempoBpm > 300)) {
        throw Object.assign(new Error("Invalid tempoBpm. Must be between 30 and 300 BPM."), {
          status: 400,
          code: "INVALID_TEMPO",
        });
      }

      const track = globalMusicEngine.generate({
        prompt,
        genre,
        durationSeconds,
        tempoBpm,
      });

      return reply.code(201).send({ track });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { trackId: string } }>("/media/music/tracks/:trackId", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const track = globalMusicEngine.getTrack(r.params.trackId);
      if (!track) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Music track not found." } });
      }
      return reply.code(200).send({ track });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 10. #248 Realtime speech (Talk / realtime speech)
  // =========================================================================

  app.post<{
    Body: {
      sessionId: string;
      voiceName?: string;
    };
  }>("/media/speech/session/start", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { sessionId, voiceName = "ukrainian_female" } = r.body || {};

      if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId.length > 128) {
        throw Object.assign(new Error("sessionId is required and must be a string up to 128 characters."), {
          status: 400,
          code: "MISSING_SESSION_ID",
        });
      }

      const session = globalSpeechEngine.startSession(sessionId.trim(), voiceName);
      return reply.code(201).send({ session });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Body: {
      sessionId: string;
      userIsSpeaking: boolean;
      transcriptionText?: string;
    };
  }>("/media/speech/session/chunk", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { sessionId, userIsSpeaking, transcriptionText } = r.body || {};

      if (!sessionId) {
        throw Object.assign(new Error("sessionId is required."), { status: 400, code: "MISSING_SESSION_ID" });
      }

      const existingSession = globalSpeechEngine.getSession(sessionId);
      if (!existingSession) {
        throw Object.assign(new Error(`Speech session '${sessionId}' not found.`), { status: 404, code: "NOT_FOUND" });
      }

      if (existingSession.status === "disconnected") {
        throw Object.assign(new Error(`Speech session '${sessionId}' is disconnected.`), {
          status: 400,
          code: "SESSION_DISCONNECTED",
        });
      }

      if (transcriptionText) {
        const mod = ContentModerationEngine.moderateText(transcriptionText);
        if (mod.flagged) {
          throw Object.assign(new Error(`Speech transcription was flagged by Content Moderation: ${mod.detectedViolations.join(", ")}`), {
            status: 400,
            code: "CONTENT_MODERATION_FLAGGED",
          });
        }
      }

      const chunk = globalSpeechEngine.processAudioChunk(sessionId, Boolean(userIsSpeaking), transcriptionText);
      const session = globalSpeechEngine.getSession(sessionId);

      return reply.code(200).send({ chunk, session });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Body: { sessionId: string };
  }>("/media/speech/session/end", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { sessionId } = r.body || {};
      if (!sessionId) {
        throw Object.assign(new Error("sessionId is required."), { status: 400, code: "MISSING_SESSION_ID" });
      }

      const existingSession = globalSpeechEngine.getSession(sessionId);
      if (!existingSession) {
        throw Object.assign(new Error(`Speech session '${sessionId}' not found.`), { status: 404, code: "NOT_FOUND" });
      }

      globalSpeechEngine.endSession(sessionId);
      const session = globalSpeechEngine.getSession(sessionId);
      return reply.code(200).send({ session });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { sessionId: string } }>("/media/speech/session/:sessionId", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const session = globalSpeechEngine.getSession(r.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Speech session not found." } });
      }
      return reply.code(200).send({ session });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get("/media/speech/sessions", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      return reply.code(200).send({ sessions: globalSpeechEngine.listSessions() });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 11. #249 Voice Call
  // =========================================================================

  app.post<{
    Body: {
      toPhoneNumber: string;
      callerId?: string;
      initialPrompt?: string;
    };
  }>("/media/calls/dial", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { toPhoneNumber, callerId = "+380440001122", initialPrompt = "Вітаю, це асистент NPATI." } = r.body || {};

      const cleanPhone = (toPhoneNumber || "").replace(/[\s-]/g, "");
      if (!toPhoneNumber || !/^\+[1-9]\d{6,14}$/.test(cleanPhone)) {
        throw Object.assign(new Error(`Invalid phone number '${toPhoneNumber}'. Must be in valid international format.`), {
          status: 400,
          code: "INVALID_PHONE_NUMBER",
        });
      }

      if (initialPrompt) {
        const mod = ContentModerationEngine.moderateText(initialPrompt);
        if (mod.flagged) {
          throw Object.assign(new Error(`Initial call prompt was flagged by Content Moderation: ${mod.detectedViolations.join(", ")}`), {
            status: 400,
            code: "CONTENT_MODERATION_FLAGGED",
          });
        }
      }

      const call = globalVoiceCallManager.makeCall({
        toPhoneNumber,
        callerId,
        initialPrompt,
      });

      return reply.code(201).send({ call });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Params: { callId: string };
    Body: {
      durationSeconds: number;
      transcriptSummary: string;
    };
  }>("/media/calls/:callId/complete", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { durationSeconds = 30, transcriptSummary } = r.body || {};

      const existingCall = globalVoiceCallManager.getCall(r.params.callId);
      if (!existingCall) {
        throw Object.assign(new Error(`Call '${r.params.callId}' not found.`), { status: 404, code: "NOT_FOUND" });
      }

      if (typeof durationSeconds !== "number" || durationSeconds < 0 || durationSeconds > 86400) {
        throw Object.assign(new Error("Invalid durationSeconds. Must be a non-negative number up to 86400 (24h)."), {
          status: 400,
          code: "INVALID_DURATION",
        });
      }

      if (transcriptSummary) {
        const mod = ContentModerationEngine.moderateText(transcriptSummary);
        if (mod.flagged) {
          throw Object.assign(new Error(`Transcript summary was flagged by Content Moderation: ${mod.detectedViolations.join(", ")}`), {
            status: 400,
            code: "CONTENT_MODERATION_FLAGGED",
          });
        }
      }

      const call = globalVoiceCallManager.completeCall(
        r.params.callId,
        durationSeconds,
        transcriptSummary || "Дзвінок завершено успішно."
      );

      return reply.code(200).send({ call });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { callId: string } }>("/media/calls/:callId", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const call = globalVoiceCallManager.getCall(r.params.callId);
      if (!call) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Call not found." } });
      }
      return reply.code(200).send({ call });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get("/media/calls", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      return reply.code(200).send({ calls: globalVoiceCallManager.listCalls() });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 12. #254 Mobile voice
  // =========================================================================

  app.post<{
    Body: {
      deviceId: string;
      codec?: "opus" | "aac";
      sampleRate?: number;
      channels?: number;
    };
  }>("/media/mobile-voice/session/start", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { deviceId, codec = "opus", sampleRate = 24000, channels = 1 } = r.body || {};

      if (!deviceId || typeof deviceId !== "string" || deviceId.trim().length === 0 || deviceId.length > 128) {
        throw Object.assign(new Error("deviceId is required and must be a string up to 128 characters."), {
          status: 400,
          code: "MISSING_DEVICE_ID",
        });
      }

      if (codec && !["opus", "aac"].includes(codec)) {
        throw Object.assign(new Error(`Invalid codec '${codec}'. Supported codecs are 'opus' and 'aac'.`), {
          status: 400,
          code: "INVALID_CODEC",
        });
      }

      if (typeof sampleRate !== "number" || sampleRate < 8000 || sampleRate > 48000) {
        throw Object.assign(new Error(`Invalid sampleRate '${sampleRate}'. Must be between 8000 and 48000 Hz.`), {
          status: 400,
          code: "INVALID_SAMPLE_RATE",
        });
      }

      if (typeof channels !== "number" || (channels !== 1 && channels !== 2)) {
        throw Object.assign(new Error(`Invalid channels '${channels}'. Must be 1 (mono) or 2 (stereo).`), {
          status: 400,
          code: "INVALID_CHANNELS",
        });
      }

      const session = globalMobileVoiceAdapter.startSession(deviceId.trim(), {
        codec,
        sampleRate,
        channels,
      });

      return reply.code(201).send({ session });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Body: {
      deviceId: string;
      audioFrameBase64: string;
    };
  }>("/media/mobile-voice/session/frame", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { deviceId, audioFrameBase64 } = r.body || {};

      if (!deviceId || !audioFrameBase64) {
        throw Object.assign(new Error("deviceId and audioFrameBase64 are required."), {
          status: 400,
          code: "MISSING_PARAMETERS",
        });
      }

      if (Buffer.byteLength(audioFrameBase64, "base64") > 1_048_576) {
        throw Object.assign(new Error("Audio frame payload exceeds 1MB limit."), {
          status: 400,
          code: "PAYLOAD_TOO_LARGE",
        });
      }

      const session = globalMobileVoiceAdapter.getSession(deviceId);
      if (!session || !session.active) {
        throw Object.assign(new Error(`Active mobile voice session not found for device '${deviceId}'.`), {
          status: 404,
          code: "SESSION_NOT_ACTIVE",
        });
      }

      const feedRes = globalMobileVoiceAdapter.feedFrame(deviceId, audioFrameBase64);
      return reply.code(200).send(feedRes);
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Body: { deviceId: string };
  }>("/media/mobile-voice/session/stop", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const { deviceId } = r.body || {};

      if (!deviceId) {
        throw Object.assign(new Error("deviceId is required."), { status: 400, code: "MISSING_DEVICE_ID" });
      }

      const existingSession = globalMobileVoiceAdapter.getSession(deviceId);
      if (!existingSession) {
        throw Object.assign(new Error(`Mobile voice session for device '${deviceId}' not found.`), {
          status: 404,
          code: "NOT_FOUND",
        });
      }

      const session = globalMobileVoiceAdapter.stopSession(deviceId);
      return reply.code(200).send({ session });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { deviceId: string } }>("/media/mobile-voice/session/:deviceId", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      const session = globalMobileVoiceAdapter.getSession(r.params.deviceId);
      if (!session) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Mobile voice session not found." } });
      }
      return reply.code(200).send({ session });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get("/media/mobile-voice/sessions", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      return reply.code(200).send({ sessions: globalMobileVoiceAdapter.listSessions() });
    } catch (e) {
      return err(reply, e);
    }
  });
}
